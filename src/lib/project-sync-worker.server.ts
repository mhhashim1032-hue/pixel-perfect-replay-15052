import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendProjectSyncEvent,
  claimProjectSyncStep,
  finalizeProjectSyncRun,
  finishProjectSyncStep,
  renewProjectSyncLease,
  type LedgerStepLease,
} from "./project-sync-ledger.server";

export type ProjectSyncExecutionResult = {
  state: "succeeded" | "skipped" | "retryable" | "failed";
  outputFingerprint?: string | null;
  safeError?: string | null;
  retryAt?: string | null;
};

export type ProjectSyncExecutor = (
  step: LedgerStepLease,
  context: { signal: AbortSignal },
) => Promise<ProjectSyncExecutionResult>;

export type ProjectSyncWorkerResult = {
  claimed: boolean;
  leaseLost?: boolean;
  stepId?: string;
  stepState?: ProjectSyncExecutionResult["state"];
  runState: string;
};

const MAX_BACKOFF_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;

function retryAtForAttempt(attempt: number, now = Date.now()): string {
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return new Date(now + delay).toISOString();
}

/** Keep provider error summaries bounded and remove common credential formats. */
export function safeProjectSyncError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "Unknown provider error");
  return raw
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|pk|sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/g, "[REDACTED_KEY]")
    .replace(/(access_token|refresh_token|api_key|apikey|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

/**
 * Claims and executes at most one dependency-ready step.
 *
 * The executor must be a trusted server-side adapter, must honor AbortSignal,
 * and must make external writes idempotent. Lease fencing prevents stale workers
 * from committing ledger state; it cannot roll back a provider side effect already
 * accepted by GitHub, Supabase or Vercel.
 */
export async function runProjectSyncWorkerOnce(input: {
  internalAdmin: SupabaseClient;
  runId: string;
  execute: ProjectSyncExecutor;
  leaseSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<ProjectSyncWorkerResult> {
  const leaseSeconds = Math.max(15, Math.min(900, Math.floor(input.leaseSeconds ?? 90)));
  const lease = await claimProjectSyncStep(input.internalAdmin, input.runId, leaseSeconds);
  if (!lease) {
    const runState = await finalizeProjectSyncRun(input.internalAdmin, input.runId);
    return { claimed: false, runState };
  }

  const abort = new AbortController();
  let leaseLost = false;
  const abortFromCaller = () => {
    leaseLost = true;
    abort.abort(input.signal?.reason ?? new Error("Project sync worker was cancelled."));
  };
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let renewalInFlight: Promise<void> | undefined;
  const renewalMs = Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3));
  const timer = setInterval(() => {
    if (renewalInFlight || leaseLost) return;
    renewalInFlight = (async () => {
      try {
        const renewed = await renewProjectSyncLease(input.internalAdmin, lease.id, lease.lease_token, leaseSeconds);
        if (!renewed) {
          leaseLost = true;
          abort.abort(new Error("Project sync lease was lost."));
        }
      } catch (error) {
        leaseLost = true;
        abort.abort(error);
      } finally {
        renewalInFlight = undefined;
      }
    })();
  }, renewalMs);

  let outcome: ProjectSyncExecutionResult;
  try {
    if (abort.signal.aborted) throw abort.signal.reason ?? new Error("Project sync worker was cancelled.");
    outcome = await input.execute(lease, { signal: abort.signal });
    if (!outcome || !["succeeded", "skipped", "retryable", "failed"].includes(outcome.state)) {
      throw new Error("Project sync executor returned an invalid result.");
    }
  } catch (error) {
    outcome = {
      state: lease.attempt >= lease.max_attempts ? "failed" : "retryable",
      safeError: safeProjectSyncError(error),
      retryAt: lease.attempt >= lease.max_attempts ? null : retryAtForAttempt(lease.attempt),
    };
  } finally {
    clearInterval(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (renewalInFlight) await renewalInFlight;
  if (leaseLost || abort.signal.aborted) {
    const runState = await finalizeProjectSyncRun(input.internalAdmin, input.runId);
    return { claimed: true, leaseLost: true, stepId: lease.id, runState };
  }

  const state = outcome.state === "retryable" && lease.attempt >= lease.max_attempts
    ? "failed"
    : outcome.state;
  const finished = await finishProjectSyncStep(input.internalAdmin, {
    stepId: lease.id,
    leaseToken: lease.lease_token,
    state,
    outputFingerprint: outcome.outputFingerprint ?? null,
    safeError: outcome.safeError ? safeProjectSyncError(outcome.safeError) : null,
    retryAt: state === "retryable" ? outcome.retryAt ?? retryAtForAttempt(lease.attempt) : null,
  });

  if (!finished) {
    const runState = await finalizeProjectSyncRun(input.internalAdmin, input.runId);
    return { claimed: true, leaseLost: true, stepId: lease.id, runState };
  }

  await appendProjectSyncEvent(input.internalAdmin, {
    runId: input.runId,
    idempotencyKey: `step:${lease.id}:attempt:${lease.attempt}:finished`,
    eventType: "sync_step_finished",
    payload: {
      stepKey: lease.step_key,
      operation: lease.operation,
      attempt: lease.attempt,
      state,
      outputFingerprint: outcome.outputFingerprint ?? null,
      error: outcome.safeError ? safeProjectSyncError(outcome.safeError) : null,
    },
  });
  const runState = await finalizeProjectSyncRun(input.internalAdmin, input.runId);
  return { claimed: true, stepId: lease.id, stepState: state, runState };
}

export type ProjectSyncWorkerBatchResult = {
  processed: number;
  idle: boolean;
  results: ProjectSyncWorkerResult[];
};

/**
 * Bounded sequential worker loop suitable for a scheduled runner or a short-lived
 * server invocation. It stops on idle/approval/retry wait and never spins forever.
 */
export async function runProjectSyncWorkerBatch(input: {
  internalAdmin: SupabaseClient;
  runId: string;
  execute: ProjectSyncExecutor;
  maxSteps?: number;
  leaseSeconds?: number;
  signal?: AbortSignal;
}): Promise<ProjectSyncWorkerBatchResult> {
  const maxSteps = Math.max(1, Math.min(50, Math.floor(input.maxSteps ?? 10)));
  const results: ProjectSyncWorkerResult[] = [];
  let idle = false;

  while (results.length < maxSteps) {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Project sync worker batch was cancelled.");
    }
    const result = await runProjectSyncWorkerOnce({
      internalAdmin: input.internalAdmin,
      runId: input.runId,
      execute: input.execute,
      leaseSeconds: input.leaseSeconds,
      signal: input.signal,
    });
    results.push(result);
    if (!result.claimed || result.leaseLost) {
      idle = !result.leaseLost;
      break;
    }
  }

  return { processed: results.filter((result) => result.claimed).length, idle, results };
}
