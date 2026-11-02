import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE_SIZE = 20;
const EVENT_LIMIT = 100;

type SyncRunRow = {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type SyncStepRow = {
  id: string;
  run_id: string;
  step_key: string;
  operation: string;
  state: string;
  attempt: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  output_fingerprint: string | null;
  created_at: string;
  updated_at: string;
};

type SyncEventRow = {
  id: number;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
};

/** Expose only the small, non-secret event fields needed by the history UI. */
export function safeProjectSyncEventPayload(value: unknown): Record<string, string | number | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number | null> = {};
  for (const key of ["stepKey", "operation", "state", "error", "outputFingerprint"] as const) {
    const item = source[key];
    if (typeof item === "string") result[key] = item.slice(0, key === "error" ? 300 : 200);
  }
  if (typeof source.attempt === "number" && Number.isInteger(source.attempt)) {
    result.attempt = Math.max(0, Math.min(100, source.attempt));
  }
  return result;
}

export function normalizeProjectSyncHistoryPage(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000, Math.floor(value ?? 0)));
}

/**
 * Reads a user's own run history through Forge's internal ledger. The task is first
 * re-authorized through the signed-in user client; the internal service-role client
 * is never trusted with a browser-supplied owner ID alone.
 */
export async function readOwnedProjectSyncHistory(input: {
  userSupabase: SupabaseClient;
  internalAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
  page?: number;
}) {
  const { data: session, error: sessionError } = await input.userSupabase
    .from("agent_sessions")
    .select("id")
    .eq("id", input.sessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (sessionError || !session) throw new Error("Task not found or access denied.");

  const page = normalizeProjectSyncHistoryPage(input.page);
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data: runsData, error: runsError } = await input.internalAdmin
    .from("project_sync_runs")
    .select("id, status, created_at, updated_at, started_at, finished_at")
    .eq("user_id", input.userId)
    .eq("session_id", input.sessionId)
    .order("created_at", { ascending: false })
    .range(from, to);
  if (runsError) throw new Error("Unable to load project sync history.");
  const runs = (runsData ?? []) as SyncRunRow[];
  if (runs.length === 0) return { page, pageSize: PAGE_SIZE, hasMore: false, runs: [] };

  const runIds = runs.map((run) => run.id);
  const [stepsResult, eventsResult] = await Promise.all([
    input.internalAdmin.from("project_sync_steps")
      .select("id, run_id, step_key, operation, state, attempt, max_attempts, next_retry_at, last_error, output_fingerprint, created_at, updated_at")
      .in("run_id", runIds)
      .order("created_at", { ascending: true }),
    input.internalAdmin.from("project_sync_events")
      .select("id, run_id, event_type, payload, created_at")
      .in("run_id", runIds)
      .order("created_at", { ascending: false })
      .limit(EVENT_LIMIT),
  ]);
  if (stepsResult.error || eventsResult.error) throw new Error("Unable to load project sync details.");

  const steps = (stepsResult.data ?? []) as SyncStepRow[];
  const events = (eventsResult.data ?? []) as SyncEventRow[];
  const stepsByRun = new Map<string, SyncStepRow[]>();
  const eventsByRun = new Map<string, SyncEventRow[]>();
  for (const step of steps) stepsByRun.set(step.run_id, [...(stepsByRun.get(step.run_id) ?? []), step]);
  for (const event of events) eventsByRun.set(event.run_id, [...(eventsByRun.get(event.run_id) ?? []), event]);

  return {
    page,
    pageSize: PAGE_SIZE,
    hasMore: runs.length === PAGE_SIZE,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      steps: (stepsByRun.get(run.id) ?? []).map((step) => ({
        id: step.id,
        key: step.step_key,
        operation: step.operation,
        state: step.state,
        attempt: step.attempt,
        maxAttempts: step.max_attempts,
        nextRetryAt: step.next_retry_at,
        error: step.last_error?.slice(0, 300) ?? null,
        outputFingerprint: step.output_fingerprint,
        createdAt: step.created_at,
        updatedAt: step.updated_at,
      })),
      events: (eventsByRun.get(run.id) ?? []).map((event) => ({
        id: event.id,
        type: event.event_type,
        createdAt: event.created_at,
        payload: safeProjectSyncEventPayload(event.payload),
      })),
    })),
  };
}
