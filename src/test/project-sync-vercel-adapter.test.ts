import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accountToken: vi.fn(), project: vi.fn(), domains: vi.fn(), signal: undefined as AbortSignal | undefined }));
vi.mock("@/lib/accounts.server", () => ({ accountToken: (...args: unknown[]) => mocks.accountToken(...args) }));
vi.mock("@/lib/integrations.server", () => ({
  Vercel: class {
    project = mocks.project;
    domains = mocks.domains;
    constructor(_token: string, signal?: AbortSignal) { mocks.signal = signal; }
  },
}));

import { inspectPinnedVercelProject } from "@/lib/project-sync-vercel-adapter.server";

const session = { user_id: "user-1", repo: "owner/repo", vercel_project_id: "prj_123456789", accounts: [{ id: "vercel-account" }] };

describe("pinned Vercel project inspection adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountToken.mockResolvedValue("vercel-token");
    mocks.project.mockResolvedValue({ id: session.vercel_project_id, repo: "owner/repo" });
    mocks.domains.mockResolvedValue(["example.vercel.app", "www.example.com"]);
  });

  it("checks only the session-pinned Vercel project and records its repository link", async () => {
    const result = await inspectPinnedVercelProject({ supabase: {}, userId: "user-1", session });
    expect(mocks.accountToken).toHaveBeenCalledWith({}, "user-1", "vercel", session.accounts);
    expect(mocks.project).toHaveBeenCalledWith(session.vercel_project_id);
    expect(mocks.domains).toHaveBeenCalledWith(session.vercel_project_id);
    expect(result).toMatchObject({ state: "succeeded", projectId: session.vercel_project_id, linkedRepository: "owner/repo", repositoryMatches: true });
    expect(result.outputFingerprint).toHaveLength(64);
  });

  it("rejects a session owned by another user before resolving credentials", async () => {
    await expect(inspectPinnedVercelProject({ supabase: {}, userId: "user-2", session })).rejects.toThrow("not owned");
    expect(mocks.accountToken).not.toHaveBeenCalled();
  });

  it("rejects malformed project and repository identifiers before provider calls", async () => {
    await expect(inspectPinnedVercelProject({ supabase: {}, userId: "user-1", session: { ...session, vercel_project_id: "https://evil.example" } })).rejects.toThrow("project ID is invalid");
    await expect(inspectPinnedVercelProject({ supabase: {}, userId: "user-1", session: { ...session, repo: "https://evil.example/repo" } })).rejects.toThrow("repository is invalid");
    expect(mocks.accountToken).not.toHaveBeenCalled();
  });

  it("passes worker cancellation into Vercel API calls", async () => {
    const controller = new AbortController();
    await inspectPinnedVercelProject({ supabase: {}, userId: "user-1", session, signal: controller.signal });
    expect(mocks.signal).toBe(controller.signal);
  });

  it("does not call Vercel when the pinned account has no credential", async () => {
    mocks.accountToken.mockResolvedValue(null);
    await expect(inspectPinnedVercelProject({ supabase: {}, userId: "user-1", session })).rejects.toThrow("Connect the Vercel account pinned");
    expect(mocks.project).not.toHaveBeenCalled();
  });
});
