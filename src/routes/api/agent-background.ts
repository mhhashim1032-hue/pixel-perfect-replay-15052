import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { agentRequest, requestError } from "@/lib/agent-request";
import { agentOrigin } from "@/lib/background-run";
import { z } from "zod";
import { getInternalLedgerAdmin } from "@/lib/internal-ledger-client.server";
import { createProjectSyncExecutor } from "@/lib/project-sync-executor.server";
import { runProjectSyncWorkerBatch } from "@/lib/project-sync-worker.server";
import { isValidProjectSyncWorkerSecret } from "@/lib/project-sync-worker-auth.server";

// Starts a run that keeps going when the user's device sleeps or switches apps:
// a small cloud keeper holds the agent stream open instead of the browser.
export const Route = createFileRoute("/api/agent-background")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Private worker mode shares this already-registered route but uses a separate
        // marker and server-only secret; ordinary user Bearer-token behavior is unchanged.
        if (request.headers.get("x-forge-sync-worker") === "1") {
          if (!isValidProjectSyncWorkerSecret(
            request.headers.get("authorization"),
            process.env["FORGE_SYNC_WORKER_SECRET"],
          )) return new Response("Unauthorized", { status: 401 });

          const workerPayload = await request.json().catch(() => null);
          const workerInput = z.object({ runId: z.string().uuid() }).strict().safeParse(workerPayload);
          if (!workerInput.success) return new Response("Invalid worker request", { status: 400 });
          try {
            const internalAdmin = getInternalLedgerAdmin();
            const result = await runProjectSyncWorkerBatch({
              internalAdmin,
              runId: workerInput.data.runId,
              execute: createProjectSyncExecutor(internalAdmin),
              maxSteps: 3,
              leaseSeconds: 90,
              signal: request.signal,
            });
            return Response.json(result);
          } catch {
            return new Response("Project sync worker failed", { status: 500 });
          }
        }

        const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!token) return new Response("Unauthorized", { status: 401 });
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const sb = createClient(process.env["SUPABASE_URL"]!, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: (input, init) => { const h = new Headers(init?.headers); h.set("apikey", key); h.set("Authorization", `Bearer ${token}`); return fetch(input, { ...init, headers: h }); } },
        });
        const { data: u, error: ue } = await sb.auth.getUser(token);
        if (ue || !u.user) return new Response("Unauthorized", { status: 401 });

        const payload = await request.json().catch(() => null);
        const parsed = agentRequest.safeParse(payload);
        if (!parsed.success) return new Response(requestError(parsed.error.issues, payload?.message), { status: 400 });

        const { data: s } = await sb.from("agent_sessions").select("id, running, updated_at").eq("id", parsed.data.sessionId).eq("user_id", u.user.id).single();
        if (!s) return new Response("Session not found", { status: 404 });
        if (s.running && Date.now() - new Date(s.updated_at).getTime() < (await import("@/lib/task-run-status")).STALE_MS) return new Response("This task is already running", { status: 409 });

        const origin = agentOrigin(request);
        if (!origin) return Response.json({ mode: "direct" });
        const { startKeeper } = await import("@/lib/background-run.server");
        try {
          const r = await startKeeper({ sb, userId: u.user.id, sessionId: s.id, origin, token, body: JSON.stringify(parsed.data) });
          if (!r) return Response.json({ mode: "direct" });
          // The caller's token was already verified here, so 401/403/404 means the keeper hit a private
          // preview gate rather than Forge; stream from the browser instead.
          if (!r.ok && [401, 403, 404, 502].includes(r.status)) return Response.json({ mode: "direct" });
          if (!r.ok) return new Response(r.message, { status: r.status });
          const { saveResumeToken } = await import("@/lib/run-resume.server");
          await saveResumeToken(s.id, u.user.id).catch(() => {});
          return Response.json({ mode: "background" });
        } catch (e) {
          console.error("background keeper failed", e);
          return Response.json({ mode: "direct" });
        }
      },
    },
  },
});
