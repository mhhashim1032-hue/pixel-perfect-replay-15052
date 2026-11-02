import { describe, expect, it, vi } from "vitest";
import { runProjectSyncWorkerOnce, safeProjectSyncError } from "@/lib/project-sync-worker.server";

const lease = {
  id: "step-1",
  run_id: "run-1",
  step_key: "inspect_repository",
  operation: "inspect_repository",
  state: "leased" as const,
  attempt: 1,
  max_attempts: 3,
  lease_token: "lease-token",
  lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
  input_fingerprint: "fingerprint",
};

function admin(claimed = true) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    calls.push(name);
    if (name === "project_sync_claim_step") return { data: claimed ? [lease] : [], error: null };
    if (name === "project_sync_finalize_run") return { data: "succeeded", error: null };
    return { data: true, error: null };
  });
  return { client: { rpc } as any, calls, rpc };
}

describe("durable project sync worker", () => {
  it("does not execute when no dependency-ready step can be claimed", async () => {
    const db = admin(false);
    const execute = vi.fn();
    const result = await runProjectSyncWorkerOnce({ internalAdmin: db.client, runId: "run-1", execute });
    expect(result).toEqual({ claimed: false, runState: "succeeded" });
    expect(execute).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["project_sync_claim_step", "project_sync_finalize_run"]);
  });

  it("executes one claimed step and records a fenced completion", async () => {
    const db = admin();
    const execute = vi.fn(async () => ({ state: "succeeded" as const, outputFingerprint: "output-1" }));
    const result = await runProjectSyncWorkerOnce({ internalAdmin: db.client, runId: "run-1", execute });
    expect(result).toMatchObject({ claimed: true, stepId: "step-1", stepState: "succeeded", runState: "succeeded" });
    expect(execute).toHaveBeenCalledWith(lease, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(db.calls).toEqual([
      "project_sync_claim_step",
      "project_sync_finish_step",
      "project_sync_append_event",
      "project_sync_finalize_run",
    ]);
  });

  it("schedules a retry for transient executor errors", async () => {
    const db = admin();
    const execute = vi.fn(async () => { throw new Error("temporary provider timeout"); });
    const result = await runProjectSyncWorkerOnce({ internalAdmin: db.client, runId: "run-1", execute });
    expect(result.stepState).toBe("retryable");
    const finish = db.rpc.mock.calls.find(([name]) => name === "project_sync_finish_step");
    expect(finish?.[1]).toMatchObject({ _state: "retryable", _safe_error: "temporary provider timeout" });
    expect(finish?.[1]?.["_retry_at"]).toBeTruthy();
  });

  it("does not retry after the attempt budget is exhausted", async () => {
    const db = admin();
    const exhausted = { ...lease, attempt: 3, max_attempts: 3 };
    db.rpc.mockImplementation(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "project_sync_claim_step") return { data: [exhausted], error: null };
      if (name === "project_sync_finalize_run") return { data: "failed", error: null };
      return { data: true, error: null };
    });
    const result = await runProjectSyncWorkerOnce({
      internalAdmin: db.client,
      runId: "run-1",
      execute: async () => { throw new Error("permanent failure"); },
    });
    expect(result.stepState).toBe("failed");
    const finish = db.rpc.mock.calls.find(([name]) => name === "project_sync_finish_step");
    expect(finish?.[1]).toMatchObject({ _state: "failed", _retry_at: null });
  });

  it("redacts common credentials from provider errors", () => {
    expect(safeProjectSyncError(new Error("Bearer abc.def sk_live_12345678 api_key=secret-value")))
      .toBe("Bearer [REDACTED] [REDACTED_KEY] api_key=[REDACTED]");
  });
});
