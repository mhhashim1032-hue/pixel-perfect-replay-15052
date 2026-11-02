import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("drizzle/migrations/0029_project_sync_ledger.sql", "utf8");

describe("project sync ledger migration contract", () => {
  it("has balanced PostgreSQL dollar-quoted function bodies", () => {
    expect((migration.match(/\$\$/g) ?? []).length % 2).toBe(0);
  });

  it("keeps the ledger scoped to Forge's internal database and owner-readable rows", () => {
    expect(migration).toContain("REFERENCES auth.users(id)");
    expect(migration).toContain("auth.uid() = user_id");
    expect(migration).toContain("GRANT ALL ON public.project_sync_runs, public.project_sync_steps, public.project_sync_events TO service_role");
  });

  it("requires service role for every worker or lifecycle RPC", () => {
    for (const fn of [
      "project_sync_create_run",
      "project_sync_claim_step",
      "project_sync_renew_step",
      "project_sync_finish_step",
      "project_sync_append_event",
      "project_sync_finalize_run",
      "project_sync_approve_step",
    ]) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(start, `${fn} must exist`).toBeGreaterThanOrEqual(0);
      const end = migration.indexOf("$$;", start);
      expect(end, `${fn} must close its function body`).toBeGreaterThan(start);
      expect(migration.slice(start, end)).toContain("auth.role()");
      expect(migration.slice(start, end)).toContain("'service_role'");
    }
  });

  it("claims only dependency-ready steps and fences stale workers", () => {
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("prerequisite.state IN ('succeeded','skipped')");
    expect(migration).toContain("lease_token = _lease_token");
    expect(migration).toContain("lease_expires_at > now()");
  });

  it("binds approval release to the exact stored approval value", () => {
    expect(migration).toContain("state = 'approval_required' AND approval_binding = _approval_binding");
  });
});
