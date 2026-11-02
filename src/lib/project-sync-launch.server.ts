import type { SupabaseClient } from "@supabase/supabase-js";
import { accountRow } from "./accounts.server";
import { cleanAccounts } from "./accounts";
import {
  createProjectSyncRun,
  fingerprintProjectSyncPlan,
  type LedgerStepInput,
} from "./project-sync-ledger.server";
import {
  githubInspectionInputFingerprint,
  supabaseBindingInputFingerprint,
  vercelBindingInputFingerprint,
} from "./project-sync-executor.server";

type InspectionSession = {
  id: string;
  user_id: string;
  repo: string;
  work_branch: string;
  supabase_ref: string | null;
  vercel_project_id: string | null;
  accounts?: unknown;
  updated_at?: string | null;
};

export type ReadOnlyInspectionPlan = {
  planBinding: string;
  steps: LedgerStepInput[];
  operations: string[];
};

/**
 * Builds a narrowly scoped DAG containing only the provider inspections currently
 * implemented by the worker. No write, migration, Auth, environment or deployment
 * operation can enter this plan.
 */
export function buildReadOnlyInspectionPlan(input: {
  userId: string;
  session: InspectionSession;
  githubCredentialId: string;
  supabaseCredentialId?: string | null;
  vercelCredentialId?: string | null;
}): ReadOnlyInspectionPlan {
  const { userId, session } = input;
  if (!userId || session.user_id !== userId) throw new Error("Project session is not owned by the signed-in user.");
  if (!session.id || !session.repo || !session.work_branch || !input.githubCredentialId) {
    throw new Error("The task must have a repository, work branch and pinned GitHub account.");
  }

  const identity = {
    version: 1,
    userId,
    sessionId: session.id,
    repository: session.repo,
    branch: session.work_branch,
    supabaseRef: session.supabase_ref,
    vercelProjectId: session.vercel_project_id,
    githubCredentialId: input.githubCredentialId,
    supabaseCredentialId: input.supabaseCredentialId ?? null,
    vercelCredentialId: input.vercelCredentialId ?? null,
    sessionUpdatedAt: session.updated_at ?? null,
  };
  const planBinding = fingerprintProjectSyncPlan(identity);
  const steps: LedgerStepInput[] = [{
    stepKey: "inspect_repository",
    operation: "inspect_repository",
    inputFingerprint: githubInspectionInputFingerprint({
      userId, sessionId: session.id, repository: session.repo,
      branch: session.work_branch, credentialId: input.githubCredentialId,
    }),
  }];

  if (session.supabase_ref && input.supabaseCredentialId) {
    steps.push({
      stepKey: "verify_database_binding",
      operation: "verify_database_binding",
      inputFingerprint: supabaseBindingInputFingerprint({
        userId, sessionId: session.id, projectRef: session.supabase_ref,
        credentialId: input.supabaseCredentialId,
      }),
    });
  }

  if (session.vercel_project_id && input.vercelCredentialId) {
    steps.push({
      stepKey: "verify_deployment_binding",
      operation: "verify_deployment_binding",
      inputFingerprint: vercelBindingInputFingerprint({
        userId, sessionId: session.id, projectId: session.vercel_project_id,
        repository: session.repo, credentialId: input.vercelCredentialId,
      }),
      dependsOn: ["inspect_repository"],
    });
  }

  return { planBinding, steps, operations: steps.map((step) => step.operation) };
}

/**
 * Creates an idempotent durable read-only inspection run after reloading the task
 * through the caller's authenticated Supabase client. Provider credentials are
 * selected from the task's explicit account pins; no tokens enter the ledger.
 */
export async function createOwnedProjectSyncInspectionRun(input: {
  userSupabase: SupabaseClient;
  internalAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
  idempotencyKey: string;
}): Promise<{ runId: string; planBinding: string; operations: string[] }> {
  if (!/^[0-9a-f-]{36}$/i.test(input.sessionId)) throw new Error("Invalid task ID.");
  if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) throw new Error("Invalid request ID.");

  const { data: session, error } = await input.userSupabase
    .from("agent_sessions")
    .select("id, user_id, repo, work_branch, supabase_ref, vercel_project_id, accounts, updated_at")
    .eq("id", input.sessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error || !session) throw new Error("Task not found or access denied.");

  const pins = cleanAccounts(session.accounts);
  if (!Object.prototype.hasOwnProperty.call(pins, "github") || !pins.github) {
    throw new Error("Select and pin a GitHub account to this task before starting sync inspection.");
  }
  const github = await accountRow(input.userSupabase, input.userId, "github", pins);
  if (!github || github.id !== pins.github) throw new Error("The GitHub account pinned to this task is unavailable.");
  const supabase = session.supabase_ref && pins.supabase
    ? await accountRow(input.userSupabase, input.userId, "supabase", pins)
    : null;
  const vercel = session.vercel_project_id && pins.vercel
    ? await accountRow(input.userSupabase, input.userId, "vercel", pins)
    : null;

  const plan = buildReadOnlyInspectionPlan({
    userId: input.userId,
    session: session as InspectionSession,
    githubCredentialId: github.id,
    supabaseCredentialId: supabase?.id ?? null,
    vercelCredentialId: vercel?.id ?? null,
  });
  const runId = await createProjectSyncRun(input.internalAdmin, {
    userId: input.userId,
    sessionId: input.sessionId,
    idempotencyKey: `inspection:${input.idempotencyKey}`,
    planBinding: plan.planBinding,
    steps: plan.steps,
  });
  return { runId, planBinding: plan.planBinding, operations: plan.operations };
}
