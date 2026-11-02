import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accountToken: vi.fn(), repoInfo: vi.fn(), headSha: vi.fn(), tree: vi.fn(), signal: undefined as AbortSignal | undefined }));
const accountToken = mocks.accountToken;
const repoInfo = mocks.repoInfo;
const headSha = mocks.headSha;

vi.mock("@/lib/accounts.server", () => ({ accountToken: (...args: unknown[]) => mocks.accountToken(...args) }));
vi.mock("@/lib/github.server", () => ({
  GitHub: class {
    repoInfo = mocks.repoInfo;
    headSha = mocks.headSha;
    tree = mocks.tree;
    constructor(_token: string, signal?: AbortSignal) { mocks.signal = signal; }
  },
}));

import { inspectPinnedGitHubRepository } from "@/lib/project-sync-github-adapter.server";

const session = { user_id: "user-1", repo: "owner/repo", work_branch: "forge/work", accounts: [{ id: "github-account" }] };

describe("pinned GitHub inspection adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountToken.mockResolvedValue("github-token");
    mocks.repoInfo.mockResolvedValue({ default_branch: "main" });
    mocks.headSha.mockResolvedValue("abc123");
    mocks.tree.mockResolvedValue(["README.md", "src/index.ts"]);
  });

  it("reads only the session-pinned repository and verifies the branch head twice", async () => {
    const result = await inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session });
    expect(accountToken).toHaveBeenCalledWith({}, "user-1", "github", session.accounts);
    expect(repoInfo).toHaveBeenCalledWith("owner/repo");
    expect(headSha).toHaveBeenNthCalledWith(1, "owner/repo", "forge/work");
    expect(headSha).toHaveBeenNthCalledWith(2, "owner/repo", "forge/work");
    expect(result).toMatchObject({ state: "succeeded", repository: "owner/repo", branch: "forge/work", headSha: "abc123", fileCount: 2 });
    expect(result.outputFingerprint).toHaveLength(64);
  });

  it("passes worker cancellation through to the GitHub API client", async () => {
    const controller = new AbortController();
    await inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session, signal: controller.signal });
    expect(mocks.signal).toBe(controller.signal);
  });

  it("rejects a session owned by another user before resolving credentials", async () => {
    await expect(inspectPinnedGitHubRepository({ supabase: {}, userId: "user-2", session }))
      .rejects.toThrow("not owned");
    expect(accountToken).not.toHaveBeenCalled();
  });

  it("rejects malformed repository and branch values before provider calls", async () => {
    await expect(inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session: { ...session, repo: "https://evil.example/owner/repo" } }))
      .rejects.toThrow("repository is invalid");
    await expect(inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session: { ...session, work_branch: "../main" } }))
      .rejects.toThrow("branch is invalid");
    expect(accountToken).not.toHaveBeenCalled();
  });

  it("does not claim success if the branch changes during inspection", async () => {
    headSha.mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");
    await expect(inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session }))
      .rejects.toThrow("changed during inspection");
  });

  it("does not call GitHub without the pinned account credential", async () => {
    accountToken.mockResolvedValue(null);
    await expect(inspectPinnedGitHubRepository({ supabase: {}, userId: "user-1", session }))
      .rejects.toThrow("Connect the GitHub account pinned");
    expect(repoInfo).not.toHaveBeenCalled();
  });
});
