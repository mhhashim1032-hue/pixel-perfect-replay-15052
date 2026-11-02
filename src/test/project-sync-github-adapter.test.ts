import { beforeEach, describe, expect, it, vi } from "vitest";

const accountToken = vi.fn();
const repoInfo = vi.fn();
const headSha = vi.fn();
const tree = vi.fn();

vi.mock("@/lib/accounts.server", () => ({ accountToken: (...args: unknown[]) => accountToken(...args) }));
vi.mock("@/lib/github.server", () => ({
  GitHub: class {
    repoInfo = repoInfo;
    headSha = headSha;
    tree = tree;
    constructor(_token: string) {}
  },
}));

import { inspectPinnedGitHubRepository } from "@/lib/project-sync-github-adapter.server";

const session = { user_id: "user-1", repo: "owner/repo", work_branch: "forge/work", accounts: [{ id: "github-account" }] };

describe("pinned GitHub inspection adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountToken.mockResolvedValue("github-token");
    repoInfo.mockResolvedValue({ default_branch: "main" });
    headSha.mockResolvedValue("abc123");
    tree.mockResolvedValue(["README.md", "src/index.ts"]);
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
