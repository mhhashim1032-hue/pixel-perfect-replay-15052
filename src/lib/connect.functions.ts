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
 * Auto-fix may inspect and reconcile through the task's configured autonomy. Migrations remain
 * blocked here because approval must be bound to the exact reviewed migration set in Deploy.
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
    const r = await run(context.supabase, s, { applyMigrations: false });
    const prompt = autoFixPrompt(r.steps, r.buildErrors);
    return {
      steps: r.steps,
      overall: r.overall,
      prompt: prompt ? [
        prompt,
        "",
        "Forge operating contract: inspect the active task's pinned customer accounts and resource IDs before every provider operation. Never use another account or platform credentials. Do not run or approve migrations from Auto-fix; use the exact migration approval workflow. Do not write customer environment values, change domains or deploy unless permitted by the task's autonomy and explicit approval flow. Verify actual postconditions; report partial sync honestly."
      ].join("\n") : null,
      deploymentAllowed: deployAllowed(level)
    };
  });
