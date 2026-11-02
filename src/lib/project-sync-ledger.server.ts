import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncOperation } from "./project-control-plane";

export type LedgerStepInput = {
  stepKey: string;
  operation: SyncOperation;
  inputFingerprint: string;
  dependsOn?: string[];
  state?: "queued" | "approval_required";
  approvalBinding?: string | null;
};

export type LedgerStepLease = {
  id: string;
  run_id: string;
  step_key: string;
  operation: string;
  state: "leased";
  attempt: number;
  max_attempts: number;
  lease_token: string;
  lease_expires_at: string;
  input_fingerprint: string;
};

/** Validates a complete DAG before asking the internal ledger to persist it. */
export function validateLedgerSteps(steps: LedgerStepInput[]): string | null {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) return "A sync run must contain between 1 and 50 steps.";
  const byKey = new Map<string, LedgerStepInput>();
  for (const step of steps) {
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(step.stepKey)) return "Every step needs a stable, valid key.";
    if (!step.inputFingerprint || step.inputFingerprint.length > 512) return `Step ${step.stepKey} needs a bounded input fingerprint.`;
    if (byKey.has(step.stepKey)) return `Duplicate sync step key: ${step.stepKey}.`;
    byKey.set(step.stepKey, step);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.stepKey || !byKey.has(dependency)) return `Step ${step.stepKey} has an invalid prerequisite: ${dependency}.`;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) if (!visit(dependency)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  for (const key of byKey.keys()) if (!visit(key)) return "The sync step graph contains a dependency cycle.";
  return null;
}

function assertRpc<T>(data: T, error: { message: string } | null): T {
  if (error) throw new Error(`Project sync ledger: ${error.message}`);
  return data;
}

/**
 * Server-only adapter for Forge's INTERNAL application Supabase service-role client.
 * Never pass a customer's Supabase client here. Customer resources are operated by
 * separately approved provider adapters, not by this ledger.
 */
export async function createProjectSyncRun(
  internalAdmin: SupabaseClient,
  input: { userId: string; sessionId: string; idempotencyKey: string; planBinding: string; steps: LedgerStepInput[] },
): Promise<string> {
  const invalid = validateLedgerSteps(input.steps);
  if (invalid) throw new Error(invalid);
  const { data, error } = await internalAdmin.rpc("project_sync_create_run", {
    _user: input.userId,
    _session: input.sessionId,
    _idempotency_key: input.idempotencyKey,
    _plan_binding: input.planBinding,
    _steps: input.steps.map((step) => ({
      step_key: step.stepKey,
      operation: step.operation,
      input_fingerprint: step.inputFingerprint,
      depends_on: step.dependsOn ?? [],
      state: step.state ?? "queued",
      approval_binding: step.approvalBinding ?? null,
    })),
  });
  return assertRpc(data as string, error);
}

export async function claimProjectSyncStep(internalAdmin: SupabaseClient, runId: string, leaseSeconds = 90): Promise<LedgerStepLease | null> {
  const { data, error } = await internalAdmin.rpc("project_sync_claim_step", { _run: runId, _lease_seconds: leaseSeconds });
  const rows = assertRpc((data ?? []) as LedgerStepLease[], error);
  return rows[0] ?? null;
}

export async function renewProjectSyncLease(internalAdmin: SupabaseClient, stepId: string, leaseToken: string, leaseSeconds = 90): Promise<boolean> {
  const { data, error } = await internalAdmin.rpc("project_sync_renew_step", { _step: stepId, _lease_token: leaseToken, _lease_seconds: leaseSeconds });
  return assertRpc(Boolean(data), error);
}

export async function finishProjectSyncStep(
  internalAdmin: SupabaseClient,
  input: { stepId: string; leaseToken: string; state: "succeeded" | "skipped" | "retryable" | "failed" | "cancelled"; outputFingerprint?: string | null; safeError?: string | null; retryAt?: string | null },
): Promise<boolean> {
  const { data, error } = await internalAdmin.rpc("project_sync_finish_step", {
    _step: input.stepId,
    _lease_token: input.leaseToken,
    _state: input.state,
    _output_fingerprint: input.outputFingerprint ?? null,
    _safe_error: input.safeError?.slice(0, 500) ?? null,
    _retry_at: input.retryAt ?? null,
  });
  return assertRpc(Boolean(data), error);
}

export async function appendProjectSyncEvent(
  internalAdmin: SupabaseClient,
  input: { runId: string; idempotencyKey: string; eventType: string; payload?: Record<string, unknown> },
): Promise<boolean> {
  const { data, error } = await internalAdmin.rpc("project_sync_append_event", {
    _run: input.runId,
    _idempotency_key: input.idempotencyKey,
    _event_type: input.eventType,
    _payload: input.payload ?? {},
  });
  return assertRpc(Boolean(data), error);
}

export async function finalizeProjectSyncRun(internalAdmin: SupabaseClient, runId: string): Promise<string> {
  const { data, error } = await internalAdmin.rpc("project_sync_finalize_run", { _run: runId });
  return assertRpc(data as string, error);
}

/** Releases exactly one approval-gated step; stale or mismatched bindings return false. */
export async function approveProjectSyncStep(internalAdmin: SupabaseClient, stepId: string, approvalBinding: string): Promise<boolean> {
  const { data, error } = await internalAdmin.rpc("project_sync_approve_step", {
    _step: stepId,
    _approval_binding: approvalBinding,
  });
  return assertRpc(Boolean(data), error);
}
