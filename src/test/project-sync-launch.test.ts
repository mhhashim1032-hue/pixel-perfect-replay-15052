import { describe, expect, it } from "vitest";
import { buildReadOnlyInspectionPlan } from "@/lib/project-sync-launch.server";

const base = {
  id: "session-1",
  user_id: "user-1",
  repo: "owner/repo",
  work_branch: "forge/work",
  supabase_ref: "abcdefghijklmnopqrst",
  vercel_project_id: "prj_123456789",
  accounts: { github: "gh-1", supabase: "sb-1", vercel: "vc-1" },
  updated_at: "2026-11-03T10:00:00.000Z",
};

describe("read-only project sync launch plan", () => {
  it("includes only the three implemented inspections and pins each credential", () => {
    const plan = buildReadOnlyInspectionPlan({
      userId: "user-1",
      session: base,
      githubCredentialId: "gh-1",
      supabaseCredentialId: "sb-1",
      vercelCredentialId: "vc-1",
    });
    expect(plan.operations).toEqual([
      "inspect_repository",
      "verify_database_binding",
      "verify_deployment_binding",
    ]);
    expect(plan.steps[2]?.dependsOn).toEqual(["inspect_repository"]);
    expect(plan.steps.every((step) => step.state === undefined)).toBe(true);
    expect(plan.planBinding).toHaveLength(64);
  });

  it("allows GitHub and Vercel inspection without a Supabase account", () => {
    const plan = buildReadOnlyInspectionPlan({
      userId: "user-1",
      session: base,
      githubCredentialId: "gh-1",
      vercelCredentialId: "vc-1",
    });
    expect(plan.operations).toEqual(["inspect_repository", "verify_deployment_binding"]);
  });

  it("omits optional provider steps when their resources are not selected", () => {
    const plan = buildReadOnlyInspectionPlan({
      userId: "user-1",
      session: { ...base, supabase_ref: null, vercel_project_id: null },
      githubCredentialId: "gh-1",
    });
    expect(plan.operations).toEqual(["inspect_repository"]);
  });

  it("binds the plan to session resources, account IDs and session revision", () => {
    const input = { userId: "user-1", session: base, githubCredentialId: "gh-1", supabaseCredentialId: "sb-1", vercelCredentialId: "vc-1" };
    const original = buildReadOnlyInspectionPlan(input);
    expect(buildReadOnlyInspectionPlan(input).planBinding).toBe(original.planBinding);
    expect(buildReadOnlyInspectionPlan({ ...input, session: { ...base, repo: "owner/other" } }).planBinding).not.toBe(original.planBinding);
    expect(buildReadOnlyInspectionPlan({ ...input, githubCredentialId: "gh-2" }).planBinding).not.toBe(original.planBinding);
    expect(buildReadOnlyInspectionPlan({ ...input, session: { ...base, updated_at: "2026-11-03T10:01:00.000Z" } }).planBinding).not.toBe(original.planBinding);
  });

  it("rejects a session owned by another user or missing GitHub pin", () => {
    expect(() => buildReadOnlyInspectionPlan({ userId: "user-2", session: base, githubCredentialId: "gh-1" })).toThrow("not owned");
    expect(() => buildReadOnlyInspectionPlan({ userId: "user-1", session: base, githubCredentialId: "" })).toThrow("pinned GitHub");
  });
});
