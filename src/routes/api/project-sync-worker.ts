import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getInternalLedgerAdmin } from "@/lib/internal-ledger-client.server";
import { createProjectSyncExecutor } from "@/lib/project-sync-executor.server";
import { runProjectSyncWorkerBatch } from "@/lib/project-sync-worker.server";
import { isValidProjectSyncWorkerSecret } from "@/lib/project-sync-worker-auth.server";

const inputSchema = z.object({ runId: z.string().uuid() }).strict();

export const Route = createFileRoute("/api/project-sync-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isValidProjectSyncWorkerSecret(
          request.headers.get("authorization"),
          process.env["FORGE_SYNC_WORKER_SECRET"],
        )) {
          return new Response("Unauthorized", { status: 401 });
        }

        const payload = await request.json().catch(() => null);
        const parsed = inputSchema.safeParse(payload);
        if (!parsed.success) return new Response("Invalid worker request", { status: 400 });

        try {
          const internalAdmin = getInternalLedgerAdmin();
          const result = await runProjectSyncWorkerBatch({
            internalAdmin,
            runId: parsed.data.runId,
            execute: createProjectSyncExecutor(internalAdmin),
            maxSteps: 3,
            leaseSeconds: 90,
            signal: request.signal,
          });
          return Response.json(result);
        } catch {
          // Provider credentials, database errors and internal identifiers stay server-side.
          return new Response("Project sync worker failed", { status: 500 });
        }
      },
    },
  },
});
