import { describe, expect, it } from "vitest";
import { buildProjectSyncPlan } from "@/lib/project-control-plane";
import {
  fingerprintProjectSyncPlan,
  projectSyncPlanToLedgerSteps,
  validateLedgerSteps,
  type LedgerStepInput,
} from "@/lib/project-sync-ledger.server";

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


  it("converts approval-gated dry-run plans into a dependency-safe ledger DAG", () => {
    const plan = buildProjectSyncPlan({
      providers: {
        github: { connected: true, accountPinned: true, resourceSelected: true },
        supabase: { connected: true, accountPinned: true, resourceSelected: true },
        vercel: { connected: true, accountPinned: true, resourceSelected: true },
      },
      hasDatabase: true,
      hasDeployment: true,
      hasCommit: true,
      pendingMigrations: 1,
      allowProductionDeployment: true,
    });
    const fingerprints = Object.fromEntries(plan.steps.map((step) => [step.operation, `input:${step.operation}`]));
    const approvals = {
      apply_migrations: "approval:migrations:plan-a",
      deploy_exact_commit: "approval:deploy:plan-a",
    };
    const ledger = projectSyncPlanToLedgerSteps(plan, fingerprints, approvals);
    expect(ledger.find((step) => step.operation === "apply_migrations")?.state).toBe("approval_required");
    expect(ledger.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("approval_required");
    expect(ledger.find((step) => step.operation === "verify_runtime")?.dependsOn).toContain("deploy_exact_commit");
    expect(validateLedgerSteps(ledger)).toBeNull();
  });

  it("refuses blocked plans and missing approval bindings", () => {
    const blocked = buildProjectSyncPlan({
      providers: {
        github: { connected: false, accountPinned: false, resourceSelected: false },
        supabase: { connected: true, accountPinned: true, resourceSelected: true },
        vercel: { connected: true, accountPinned: true, resourceSelected: true },
      },
      hasDatabase: true,
      hasDeployment: true,
      hasCommit: false,
      pendingMigrations: 0,
    });
    expect(() => projectSyncPlanToLedgerSteps(blocked, {})).toThrow("blocked project sync plan");

    const approvalPlan = buildProjectSyncPlan({
      providers: {
        github: { connected: true, accountPinned: true, resourceSelected: true },
        supabase: { connected: true, accountPinned: true, resourceSelected: true },
        vercel: { connected: true, accountPinned: true, resourceSelected: true },
      },
      hasDatabase: true,
      hasDeployment: true,
      hasCommit: true,
      pendingMigrations: 0,
      allowProductionDeployment: true,
    });
    const fingerprints = Object.fromEntries(approvalPlan.steps.map((step) => [step.operation, "fingerprint"]));
    expect(() => projectSyncPlanToLedgerSteps(approvalPlan, fingerprints)).toThrow("Missing exact approval binding");
  });

  it("creates stable cryptographic plan fingerprints", () => {
    expect(fingerprintProjectSyncPlan({ b: 2, a: 1 })).toBe(fingerprintProjectSyncPlan({ a: 1, b: 2 }));
    expect(fingerprintProjectSyncPlan({ a: 1 })).toHaveLength(64);
  });

  it("requires a bounded input fingerprint", () => {
    expect(validateLedgerSteps([{ ...steps[0]!, inputFingerprint: "" }])).toContain("fingerprint");
    expect(validateLedgerSteps([{ ...steps[0]!, inputFingerprint: "x".repeat(513) }])).toContain("fingerprint");
  });
});
