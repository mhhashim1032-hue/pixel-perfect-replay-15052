import { describe, expect, it } from "vitest";
import { validateLedgerSteps, type LedgerStepInput } from "@/lib/project-sync-ledger.server";

const steps: LedgerStepInput[] = [
  { stepKey: "inspect_repo", operation: "inspect_repository", inputFingerprint: "repo@commit" },
  { stepKey: "verify_vercel", operation: "verify_deployment_binding", inputFingerprint: "vercel@project", dependsOn: ["inspect_repo"] },
  { stepKey: "deploy_commit", operation: "deploy_exact_commit", inputFingerprint: "commit@sha", dependsOn: ["verify_vercel"] },
];

describe("durable project sync ledger graph validation", () => {
  it("accepts a valid dependency graph", () => {
    expect(validateLedgerSteps(steps)).toBeNull();
  });

  it("rejects empty or oversized plans", () => {
    expect(validateLedgerSteps([])).toContain("between 1 and 50");
    expect(validateLedgerSteps(Array.from({ length: 51 }, (_, i) => ({
      stepKey: `step_${i}`, operation: "inspect_repository" as const, inputFingerprint: "x",
    })))).toContain("between 1 and 50");
  });

  it("rejects duplicate step keys", () => {
    expect(validateLedgerSteps([steps[0]!, { ...steps[0]! }])).toContain("Duplicate");
  });

  it("rejects missing and self dependencies", () => {
    expect(validateLedgerSteps([{ ...steps[0]!, dependsOn: ["not_here"] }])).toContain("invalid prerequisite");
    expect(validateLedgerSteps([{ ...steps[0]!, dependsOn: ["inspect_repo"] }])).toContain("invalid prerequisite");
  });

  it("rejects dependency cycles", () => {
    expect(validateLedgerSteps([
      { stepKey: "step_alpha", operation: "inspect_repository", inputFingerprint: "a", dependsOn: ["step_beta"] },
      { stepKey: "step_beta", operation: "verify_database_binding", inputFingerprint: "b", dependsOn: ["step_alpha"] },
    ])).toContain("dependency cycle");
  });

  it("requires a bounded input fingerprint", () => {
    expect(validateLedgerSteps([{ ...steps[0]!, inputFingerprint: "" }])).toContain("fingerprint");
    expect(validateLedgerSteps([{ ...steps[0]!, inputFingerprint: "x".repeat(513) }])).toContain("fingerprint");
  });
});
