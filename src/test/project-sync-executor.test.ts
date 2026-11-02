import { describe, expect, it } from "vitest";
import { githubInspectionInputFingerprint, supabaseBindingInputFingerprint, vercelBindingInputFingerprint, createProjectSyncExecutor } from "@/lib/project-sync-executor.server";

describe("project sync executor allowlist", () => {
  it("binds GitHub inspection to the exact user, session, repository, branch and credential", () => {
    const input = { userId: "user-1", sessionId: "session-1", repository: "owner/repo", branch: "forge/work", credentialId: "credential-1" };
    const fingerprint = githubInspectionInputFingerprint(input);
    expect(fingerprint).toHaveLength(64);
    expect(githubInspectionInputFingerprint(input)).toBe(fingerprint);
    expect(githubInspectionInputFingerprint({ ...input, branch: "main" })).not.toBe(fingerprint);
    expect(githubInspectionInputFingerprint({ ...input, credentialId: "credential-2" })).not.toBe(fingerprint);
    expect(githubInspectionInputFingerprint({ ...input, userId: "user-2" })).not.toBe(fingerprint);
  });

  it("binds Supabase verification to the exact project and credential", () => {
    const input = { userId: "user-1", sessionId: "session-1", projectRef: "abcdefghijklmnopqrst", credentialId: "supabase-account-1" };
    const fingerprint = supabaseBindingInputFingerprint(input);
    expect(fingerprint).toHaveLength(64);
    expect(supabaseBindingInputFingerprint(input)).toBe(fingerprint);
    expect(supabaseBindingInputFingerprint({ ...input, projectRef: "zyxwvutsrqponmlkjihgf" })).not.toBe(fingerprint);
    expect(supabaseBindingInputFingerprint({ ...input, credentialId: "supabase-account-2" })).not.toBe(fingerprint);
  });

  it("binds Vercel verification to the exact project, repository and credential", () => {
    const input = { userId: "user-1", sessionId: "session-1", projectId: "prj_123", repository: "owner/repo", credentialId: "vercel-account-1" };
    const fingerprint = vercelBindingInputFingerprint(input);
    expect(fingerprint).toHaveLength(64);
    expect(vercelBindingInputFingerprint(input)).toBe(fingerprint);
    expect(vercelBindingInputFingerprint({ ...input, projectId: "prj_456" })).not.toBe(fingerprint);
    expect(vercelBindingInputFingerprint({ ...input, repository: "owner/other" })).not.toBe(fingerprint);
    expect(vercelBindingInputFingerprint({ ...input, credentialId: "vercel-account-2" })).not.toBe(fingerprint);
  });

  it("rejects every provider operation except the explicitly implemented read-only provider inspections", async () => {
    const executor = createProjectSyncExecutor({} as never);
    const result = await executor({
      id: "step-1",
      run_id: "run-1",
      step_key: "apply_migrations",
      operation: "apply_migrations",
      state: "leased",
      attempt: 1,
      max_attempts: 3,
      lease_token: "lease",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      input_fingerprint: "fingerprint",
    }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ state: "failed", safeError: expect.stringContaining("no enabled provider executor") });
  });
});
