import { describe, expect, it } from "vitest";
import { canClaimJob, canRunStep, deriveJobStatus, validIdempotencyKey, type SyncStepRecord } from "@/lib/project-sync-state";

const steps: SyncStepRecord[] = [
  { operation: "inspect", status: "succeeded", dependsOn: [], requiresApproval: false, approved: false },
  { operation: "migrate", status: "pending", dependsOn: ["inspect"], requiresApproval: true, approved: false },
  { operation: "deploy", status: "pending", dependsOn: ["migrate"], requiresApproval: false, approved: false },
];

describe("durable project sync state rules", () => {
  it("claims queued jobs and only reclaims expired running leases", () => {
    expect(canClaimJob("queued", null, 100)).toBe(true);
    expect(canClaimJob("running", 99, 100)).toBe(true);
    expect(canClaimJob("running", 101, 100)).toBe(false);
    expect(canClaimJob("waiting_approval", null, 100)).toBe(false);
    expect(canClaimJob("succeeded", null, 100)).toBe(false);
  });

  it("requires explicit customer approval for gated steps", () => {
    expect(canRunStep(steps[1]!, steps)).toEqual({ allowed: false, reason: "Customer approval is required." });
    const approved = { ...steps[1]!, approved: true };
    expect(canRunStep(approved, [steps[0]!, approved, steps[2]!]).allowed).toBe(true);
  });

  it("blocks a step until every dependency has succeeded", () => {
    expect(canRunStep(steps[2]!, steps)).toEqual({ allowed: false, reason: "Prerequisites are incomplete: migrate." });
  });

  it("derives waiting approval, success, failure and queued states", () => {
    expect(deriveJobStatus(steps)).toBe("waiting_approval");
    expect(deriveJobStatus([{ ...steps[0]!, status: "succeeded" }])).toBe("succeeded");
    expect(deriveJobStatus([{ ...steps[0]!, status: "failed" }])).toBe("failed");
    expect(deriveJobStatus([{ ...steps[0]!, status: "pending" }])).toBe("queued");
  });

  it("validates bounded idempotency keys", () => {
    expect(validIdempotencyKey("sync:req-123")).toBe(true);
    expect(validIdempotencyKey("short")).toBe(false);
    expect(validIdempotencyKey("bad key 123")).toBe(false);
    expect(validIdempotencyKey("x".repeat(121))).toBe(false);
  });
});
