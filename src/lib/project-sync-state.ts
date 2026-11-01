/** Pure durable sync-job state rules. Provider I/O and persistence belong in server workers. */
export type SyncJobStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
export type SyncStepStatus = "pending" | "running" | "waiting_approval" | "succeeded" | "failed" | "skipped" | "cancelled";
export type SyncStepRecord = { operation: string; status: SyncStepStatus; dependsOn: string[]; requiresApproval: boolean; approved: boolean };

export function canClaimJob(status: SyncJobStatus, leaseExpiresAt: number | null, now: number): boolean {
  return status === "queued" || status === "running" && leaseExpiresAt !== null && leaseExpiresAt <= now;
}

export function canRunStep(step: SyncStepRecord, all: SyncStepRecord[]): { allowed: boolean; reason: string | null } {
  if (step.status !== "pending" && step.status !== "failed") return { allowed: false, reason: "Step is not pending or retryable." };
  if (step.requiresApproval && !step.approved) return { allowed: false, reason: "Customer approval is required." };
  const missing = step.dependsOn.filter((name) => !all.some((candidate) => candidate.operation === name && candidate.status === "succeeded"));
  if (missing.length) return { allowed: false, reason: `Prerequisites are incomplete: ${missing.join(", ")}.` };
  return { allowed: true, reason: null };
}

export function deriveJobStatus(steps: SyncStepRecord[]): SyncJobStatus {
  if (!steps.length) return "queued";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "cancelled")) return "cancelled";
  if (steps.some((s) => s.status === "waiting_approval" || s.requiresApproval && !s.approved && s.status === "pending")) return "waiting_approval";
  if (steps.every((s) => ["succeeded", "skipped"].includes(s.status))) return "succeeded";
  if (steps.some((s) => s.status === "running")) return "running";
  return "queued";
}

/** Stable key prevents duplicate job creation for the same task/request intent. */
export function validIdempotencyKey(key: string): boolean {
  return key.length >= 8 && key.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(key);
}
