import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerStepLease } from "./project-sync-ledger.server";
import { accountRow } from "./accounts.server";
import { fingerprintProjectSyncPlan } from "./project-sync-ledger.server";
import { inspectPinnedGitHubRepository } from "./project-sync-github-adapter.server";
import type { ProjectSyncExecutor } from "./project-sync-worker.server";

type SyncRunOwner = { user_id: string; session_id: string };
type PinnedSession = {
  id: string;
  user_id: string;
  repo: string;
  work_branch: string;
  accounts?: unknown;
};

/**
 * Fingerprint the exact GitHub inspection target and selected credential row.
 * The run creator must persist this value as the step's input_fingerprint.
 * Tokens and other secrets are deliberately excluded.
 */
export function githubInspectionInputFingerprint(input: {
  userId: string;
  sessionId: string;
  repository: string;
  branch: string;
  credentialId: string;
}): string {
  return fingerprintProjectSyncPlan({
    operation: "inspect_repository",
    userId: input.userId,
    sessionId: input.sessionId,
    repository: input.repository,
    branch: input.branch,
    githubCredentialId: input.credentialId,
  });
}

async function loadOwnedRunContext(
  internalAdmin: SupabaseClient,
  runId: string,
): Promise<{ owner: SyncRunOwner; session: PinnedSession }> {
  const { data: run, error: runError } = await internalAdmin
    .from("project_sync_runs")
    .select("user_id, session_id")
    .eq("id", runId)
    .maybeSingle();
  if (runError || !run) throw new Error("Project sync run was not found.");
  const owner = run as SyncRunOwner;
  const { data: session, error: sessionError } = await internalAdmin
    .from("agent_sessions")
    .select("id, user_id, repo, work_branch, accounts")
    .eq("id", owner.session_id)
    .eq("user_id", owner.user_id)
    .maybeSingle();
  if (sessionError || !session) throw new Error("The project session is no longer available to its owner.");
  return { owner, session: session as PinnedSession };
}

/**
 * Creates the first allowlisted ledger executor. Unknown operations fail closed.
 * The run's owning session, provider account, repository and branch are reloaded
 * from Forge's internal database; nothing is accepted from a browser-supplied URL.
 */
export function createProjectSyncExecutor(internalAdmin: SupabaseClient): ProjectSyncExecutor {
  return async (step: LedgerStepLease, { signal }) => {
    signal.throwIfAborted();
    if (step.operation !== "inspect_repository") {
      throw new Error("This project sync operation has no enabled provider executor yet.");
    }

    const { owner, session } = await loadOwnedRunContext(internalAdmin, step.run_id);
    if (session.user_id !== owner.user_id) throw new Error("Project session ownership verification failed.");

    const githubAccount = await accountRow(internalAdmin, owner.user_id, "github", session.accounts);
    if (!githubAccount) throw new Error("Connect the GitHub account pinned to this project.");

    const expectedFingerprint = githubInspectionInputFingerprint({
      userId: owner.user_id,
      sessionId: session.id,
      repository: session.repo,
      branch: session.work_branch,
      credentialId: githubAccount.id,
    });
    if (expectedFingerprint !== step.input_fingerprint) {
      throw new Error("The GitHub account, repository or branch changed after this sync plan was created. Review the plan again.");
    }

    const result = await inspectPinnedGitHubRepository({
      supabase: internalAdmin,
      userId: owner.user_id,
      session,
      signal,
    });
    return { state: "succeeded", outputFingerprint: result.outputFingerprint };
  };
}
