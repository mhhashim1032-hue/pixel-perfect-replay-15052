import { describe, expect, it } from "vitest";
import { buildProjectSyncPlan, type ProviderReadiness, type SyncPlanInput } from "@/lib/project-control-plane";

const connected: ProviderReadiness = {
  github: { connected: true, accountPinned: true, resourceSelected: true },
  supabase: { connected: true, accountPinned: true, resourceSelected: true },
  vercel: { connected: true, accountPinned: true, resourceSelected: true },
};

function input(overrides: Partial<SyncPlanInput> = {}): SyncPlanInput {
  return {
    providers: connected,
    hasDatabase: true,
    hasDeployment: true,
    hasCommit: true,
    pendingMigrations: 1,
    ...overrides,
  };
}

describe("customer project control-plane planning", () => {
  it("produces a deterministic plan for a fully connected project", () => {
    const plan = buildProjectSyncPlan(input());
    expect(plan.steps.map((step) => step.operation)).toEqual([
      "inspect_repository", "verify_database_binding", "verify_deployment_binding",
      "sync_environment", "sync_auth_redirects", "inspect_migrations",
      "apply_migrations", "deploy_exact_commit", "verify_runtime",
    ]);
    expect(plan.requiresApproval).toEqual(["apply_migrations"]);
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("blocked");
    expect(plan.steps.find((step) => step.operation === "apply_migrations")?.state).toBe("approval_required");
  });

  it("blocks operations when the customer has not pinned the required provider account", () => {
    const providers = { ...connected, github: { ...connected.github, accountPinned: false } };
    const plan = buildProjectSyncPlan(input({ providers }));
    expect(plan.steps[0]?.state).toBe("blocked");
    expect(plan.steps[0]?.reason).toContain("pin the customer's github account");
    expect(plan.canStart).toBe(false);
  });

  it("does not allow deployment to proceed when repository inspection is blocked", () => {
    const providers = { ...connected, github: { connected: false, accountPinned: false, resourceSelected: false } };
    const plan = buildProjectSyncPlan(input({ providers }));
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("blocked");
    expect(plan.steps.find((step) => step.operation === "verify_runtime")?.state).toBe("blocked");
  });

  it("does not request migration approval when no migrations are pending", () => {
    const plan = buildProjectSyncPlan(input({ pendingMigrations: 0 }));
    expect(plan.steps.find((step) => step.operation === "apply_migrations")?.state).toBe("not_applicable");
    expect(plan.requiresApproval).toEqual([]);
  });

  it("allows an explicitly approved migration only after inspection", () => {
    const plan = buildProjectSyncPlan(input({ approvedOperations: ["apply_migrations"], approvalBinding: "current", currentPlanBinding: "current" }));
    expect(plan.steps.find((step) => step.operation === "apply_migrations")?.state).toBe("ready");
    expect(plan.requiresApproval).toEqual([]);
  });

  it("marks absent optional resources as not applicable rather than failures", () => {
    const plan = buildProjectSyncPlan(input({ hasDatabase: false, pendingMigrations: 0 }));
    expect(plan.steps.find((step) => step.operation === "verify_database_binding")?.state).toBe("not_applicable");
    expect(plan.steps.find((step) => step.operation === "sync_environment")?.state).toBe("not_applicable");
  });

  it("requires an approval bound to the current plan before a migration can run", () => {
    const plan = buildProjectSyncPlan(input({ approvedOperations: ["apply_migrations"], approvalBinding: "old", currentPlanBinding: "new" }));
    expect(plan.steps.find((step) => step.operation === "apply_migrations")?.state).toBe("approval_required");
    expect(plan.canStart).toBe(false);
  });

  it("does not let migration approval implicitly authorize production deployment", () => {
    const plan = buildProjectSyncPlan(input({
      approvedOperations: ["apply_migrations"],
      approvalBinding: "current",
      currentPlanBinding: "current",
      allowProductionDeployment: false,
    }));
    expect(plan.steps.find((step) => step.operation === "apply_migrations")?.state).toBe("ready");
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("blocked");
    expect(plan.steps.find((step) => step.operation === "verify_runtime")?.state).toBe("blocked");
  });

  it("requires exact-plan approval before deploying and verifying runtime", () => {
    const plan = buildProjectSyncPlan(input({
      allowProductionDeployment: true,
      approvedOperations: ["apply_migrations", "deploy_exact_commit"],
      approvalBinding: "plan-123",
      currentPlanBinding: "plan-123",
    }));
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("ready");
    expect(plan.steps.find((step) => step.operation === "verify_runtime")?.state).toBe("ready");
  });

  it("allows a deployment without a database when optional database steps are omitted", () => {
    const plan = buildProjectSyncPlan(input({
      hasDatabase: false,
      pendingMigrations: 0,
      allowProductionDeployment: true,
      approvedOperations: ["deploy_exact_commit"],
      approvalBinding: "plan-no-db",
      currentPlanBinding: "plan-no-db",
    }));
    expect(plan.steps.find((step) => step.operation === "sync_environment")?.state).toBe("not_applicable");
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("ready");
    expect(plan.steps.find((step) => step.operation === "verify_runtime")?.state).toBe("ready");
  });

  it("omits runtime verification when no source commit is selected", () => {
    const plan = buildProjectSyncPlan(input({ hasCommit: false }));
    expect(plan.steps.find((step) => step.operation === "deploy_exact_commit")?.state).toBe("not_applicable");
    expect(plan.steps.find((step) => step.operation === "verify_runtime")?.state).toBe("not_applicable");
  });

  it("does not allow a missing provider resource to be treated as connected", () => {
    const providers = { ...connected, supabase: { ...connected.supabase, resourceSelected: false } };
    const plan = buildProjectSyncPlan(input({ providers }));
    expect(plan.steps.find((step) => step.operation === "verify_database_binding")?.state).toBe("blocked");
    expect(plan.canStart).toBe(false);
  });

});
