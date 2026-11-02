import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountToken } from "./accounts.server";
import { GitHub } from "./github.server";

export type GitHubInspectSession = {
  user_id: string;
  repo: string;
  work_branch: string;
  accounts?: unknown;
};

export type GitHubInspectResult = {
  state: "succeeded";
  repository: string;
  branch: string;
  headSha: string;
  fileCount: number;
  outputFingerprint: string;
};

function assertRepository(value: string): string {
  const repo = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.includes("..")) {
    throw new Error("The project's pinned GitHub repository is invalid.");
  }
  return repo;
}

function assertBranch(value: string): string {
  const branch = value.trim();
  if (!branch || branch.length > 240 || branch.startsWith("-") || branch.includes("..") ||
      branch.includes("@{") || branch.split("").some((character) => " ~^:?*[]\\\\".includes(character)) || branch.endsWith("/") || branch.endsWith(".") ||
      branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("The project's pinned GitHub branch is invalid.");
  }
  return branch;
}

/**
 * First allowlisted provider executor: read-only repository inspection.
 * It uses only the account and repository already pinned to an owned Forge session.
 * No arbitrary URL, repository, branch, shell command or customer write is accepted.
 */
export async function inspectPinnedGitHubRepository(input: {
  supabase: SupabaseClient;
  userId: string;
  session: GitHubInspectSession;
  signal?: AbortSignal;
}): Promise<GitHubInspectResult> {
  input.signal?.throwIfAborted();
  if (!input.userId || input.session.user_id !== input.userId) {
    throw new Error("The project session is not owned by the signed-in user.");
  }
  const repository = assertRepository(input.session.repo);
  const branch = assertBranch(input.session.work_branch);
  const token = await accountToken(input.supabase, input.userId, "github", input.session.accounts);
  if (!token) throw new Error("Connect the GitHub account pinned to this project.");

  input.signal?.throwIfAborted();
  const github = new GitHub(token, input.signal);
  try {
    const info = await github.repoInfo(repository);
    input.signal?.throwIfAborted();
    const firstHead = await github.headSha(repository, branch);
    const files = await github.tree(repository, branch);
    input.signal?.throwIfAborted();
    const verifiedHead = await github.headSha(repository, branch);
    if (firstHead !== verifiedHead) {
      throw new Error("The work branch changed during inspection; retry against the latest commit.");
    }
    if (!info.default_branch) throw new Error("GitHub did not return the repository's default branch.");
    const outputFingerprint = createHash("sha256")
      .update(JSON.stringify({ repository, branch, headSha: verifiedHead, fileCount: files.length }))
      .digest("hex");
    return { state: "succeeded", repository, branch, headSha: verifiedHead, fileCount: files.length, outputFingerprint };
  } catch (error) {
    if (error instanceof Error && /changed during inspection|default branch/.test(error.message)) throw error;
    throw new Error("GitHub repository inspection failed. Check the pinned account, repository access and branch.");
  }
}
