import type { SupabaseClient } from "@supabase/supabase-js";
import { createProjectSyncExecutor } from "./project-sync-executor.server";
import { runProjectSyncWorkerBatch } from "./project-sync-worker.server";

/**
 * Processes one queued durable inspection run per cron invocation.
 * The executor allowlist contains only read-only GitHub/Supabase/Vercel inspections.
 * Atomic SQL claims make overlapping cron invocations safe.
 */
export async function dispatchOnePendingProjectSyncRun(internalAdmin: SupabaseClient) {
  const { data, error } = await internalAdmin
    .from("project_sync_runs")
    .select("id")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error("Unable to load the project sync queue.");
  const run = data?.[0] as { id: string } | undefined;
  if (!run) return { enabled: true, processed: false, idle: true };

  const result = await runProjectSyncWorkerBatch({
    internalAdmin,
    runId: run.id,
    execute: createProjectSyncExecutor(internalAdmin),
    maxSteps: 3,
    leaseSeconds: 90,
  });
  return {
    enabled: true,
    processed: result.processed > 0,
    idle: result.idle,
    runId: run.id,
    processedSteps: result.processed,
    state: result.results.at(-1)?.runState ?? "unknown",
  };
}
