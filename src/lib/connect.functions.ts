import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { asAutonomy, deployAllowed } from "./engine/autonomy";

async function owned(ctx: { supabase: any; userId: string }, id: string) {
  const { data, error } = await ctx.supabase.from("agent_sessions").select("*").eq("id", id).eq("user_id", ctx.userId).single();
  if (error || !data) throw new Error("Task not found");
  return data;
}

/**
 * Read-only/safe Connect inspection and reconciliation. Pending migrations are always surfaced
 * for review; the separate Deploy approval flow is the only path that may apply them.
 */
export const syncProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const s = await owned(context, data.id);
    const { syncProject: run } = await import("./connect.server");
    const r = await run(context.supabase, s);
    return { steps: r.steps, overall: r.overall };
  });

/**
 * Auto-fix uses read-only provider diagnostics and returns a focused source-repair brief.
 * Customer settings, migrations, domains and production deployments remain separate approval flows.
 */
export const autoFix = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const s = await owned(context, data.id);
    if (s.running) throw new Error("The agent is already working on this task. Stop it first or wait.");
    const level = asAutonomy(s.mode);
    const { syncProject: run } = await import("./connect.server");
    const { autoFixPrompt } = await import("./connect");
    const r = await run(context.supabase, s);
    const prompt = autoFixPrompt(r.steps, r.buildErrors);
    return {
      steps: r.steps,
      overall: r.overall,
      prompt: prompt ? [
        prompt,
        "",
        "Forge operating contract: inspect the active task's pinned customer accounts and resource IDs before every provider operation. Never use another account or platform credentials. Do not run or approve migrations from Auto-fix; use the exact migration approval workflow. Do not write customer environment values, change Supabase Auth or redirect settings, change domains, apply migrations or deploy from Auto-fix; these require separate customer approval flows. Verify actual postconditions; report partial sync honestly."
      ].join("\n") : null,
      deploymentAllowed: deployAllowed(level)
    };
  });

/**
 * Creates a durable run containing only the currently enabled read-only provider
 * inspections. It does not start a worker or modify customer infrastructure.
 * requestId is generated once by the client and reused for network retries.
 */
export const startProjectSyncInspection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid(), requestId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const [{ getInternalLedgerAdmin }, { createOwnedProjectSyncInspectionRun }] = await Promise.all([
      import("./internal-ledger-client.server"),
      import("./project-sync-launch.server"),
    ]);
    return createOwnedProjectSyncInspectionRun({
      userSupabase: context.supabase,
      internalAdmin: getInternalLedgerAdmin(),
      userId: context.userId,
      sessionId: data.id,
      idempotencyKey: data.requestId,
    });
  });
