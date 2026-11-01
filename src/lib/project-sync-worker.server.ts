import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { accountToken } from "./accounts.server";
import { cleanAccounts } from "./accounts";

const db: any = supabaseAdmin;
const WORKER_ID = `forge-sync-${crypto.randomUUID()}`;
const LEASE_SECONDS = 90;

type ClaimedJob = {
  id: string; task_id: string; user_id: string; account_bindings: unknown;
  source_commit_sha: string | null; status: string;
};

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Provider operation failed.";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

async function finish(job: ClaimedJob, status: "failed" | "waiting_approval" | "succeeded", summary: Record<string, unknown>) {
  const { data, error } = await db.rpc("finish_project_sync_job", {
    p_job_id: job.id, p_worker_id: WORKER_ID, p_status: status, p_summary: summary,
  });
  if (error || data !== true) throw new Error("Sync worker lost its lease before completion.");
}

async function stepStatus(userId: string, id: string, status: string, patch: Record<string, unknown> = {}) {
  const { error } = await db.from("project_sync_steps").update({
    status, updated_at: new Date().toISOString(), ...patch,
  }).eq("id", id).eq("user_id", userId);
  if (error) throw new Error("Could not persist sync step state.");
}

let currentUserId = "";

async function runReadOnlyOperation(operation: string, task: any, tokens: Partial<Record<"github" | "supabase" | "vercel", string>>) {
  if (operation === "inspect_repository") {
    const { GitHub } = await import("./github.server");
    const gh = new GitHub(tokens.github!);
    const repo = String(task.repo ?? "");
    const branch = String(task.work_branch ?? "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !branch || branch.length > 255) throw new Error("Repository or branch binding is invalid.");
    const [info, branches, sha] = await Promise.all([gh.repoInfo(repo), gh.branches(repo), gh.headSha(repo, branch)]);
    if (!branches.includes(branch)) throw new Error("The pinned work branch no longer exists.");
    return { repository: repo, defaultBranch: info.default_branch, workBranch: branch, commitSha: sha };
  }
  if (operation === "verify_database_binding") {
    const { SupabaseMgmt } = await import("./integrations.server");
    const projects = await new SupabaseMgmt(tokens.supabase!).projects();
    const project = projects.find((p) => p.ref === task.supabase_ref);
    if (!project) throw new Error("The linked Supabase project is not visible in the pinned customer account.");
    return { projectRef: project.ref, projectName: project.name, region: project.region, status: project.status };
  }
  if (operation === "verify_deployment_binding") {
    const { Vercel } = await import("./integrations.server");
    const projects = await new Vercel(tokens.vercel!).projects();
    const project = projects.find((p) => p.id === task.vercel_project_id);
    if (!project) throw new Error("The linked Vercel project is not visible in the pinned customer account.");
    if (project.repo && project.repo.toLowerCase() !== String(task.repo).toLowerCase()) throw new Error("Vercel project is linked to a different GitHub repository.");
    return { projectId: project.id, projectName: project.name, linkedRepository: project.repo };
  }
  throw new Error("This operation is not enabled in the read-only worker yet.");
}

/** Processes at most one claimed job. This first worker release intentionally performs read-only checks only. */
export async function runProjectSyncWorker() {
  const { data: claimed, error: claimError } = await db.rpc("claim_project_sync_job", {
    p_worker_id: WORKER_ID, p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) throw new Error("Sync job claim failed.");
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as ClaimedJob | null;
  if (!job) return { claimed: false, processed: 0 };

  const outcomes: Array<{ operation: string; status: string; result?: unknown; error?: string }> = [];
  try {
    const { data: task, error: taskError } = await db.from("agent_sessions")
      .select("id,user_id,repo,work_branch,supabase_ref,vercel_project_id")
      .eq("id", job.task_id).eq("user_id", job.user_id).single();
    if (taskError || !task) throw new Error("Project ownership could not be verified.");

    const pins = cleanAccounts(job.account_bindings);
    if (!pins.github) throw new Error("The job is missing its pinned GitHub account. Recreate the sync job after selecting accounts.");
    if (task.supabase_ref && !pins.supabase) throw new Error("The job is missing its pinned Supabase account.");
    if (task.vercel_project_id && !pins.vercel) throw new Error("The job is missing its pinned Vercel account.");
    const [github, supabase, vercel] = await Promise.all([
      accountToken(db, job.user_id, "github", pins),
      task.supabase_ref ? accountToken(db, job.user_id, "supabase", pins) : Promise.resolve(null),
      task.vercel_project_id ? accountToken(db, job.user_id, "vercel", pins) : Promise.resolve(null),
    ]);
    if (!github || task.supabase_ref && !supabase || task.vercel_project_id && !vercel) {
      throw new Error("A pinned customer account is no longer connected. No alternate account was selected.");
    }
    const tokens = { github, supabase: supabase ?? undefined, vercel: vercel ?? undefined };

    const { data: steps, error: stepsError } = await db.from("project_sync_steps")
      .select("id,operation,status,depends_on,requires_approval,approved_at")
      .eq("job_id", job.id).eq("task_id", job.task_id).eq("user_id", job.user_id).order("created_at");
    if (stepsError) throw new Error("Sync steps could not be loaded.");

    for (const step of steps ?? []) {
      const dependencies = (step.depends_on ?? []) as string[];
      const completed = outcomes.some((o) => dependencies.includes(o.operation) && o.status === "succeeded");
      if (dependencies.length && !completed) {
        outcomes.push({ operation: step.operation, status: "blocked", error: "Prerequisite was not completed in this worker pass." });
        continue;
      }
      if (step.requires_approval && !step.approved_at) {
        outcomes.push({ operation: step.operation, status: "waiting_approval" });
        continue;
      }
      if (step.status === "succeeded" || step.status === "skipped") {
        outcomes.push({ operation: step.operation, status: step.status });
        continue;
      }
      await stepStatus(job.user_id, step.id, "running", { started_at: new Date().toISOString(), attempt: (step.attempt ?? 0) + 1 });
      try {
        const result = await runReadOnlyOperation(step.operation, task, tokens);
        await stepStatus(job.user_id, step.id, "succeeded", { safe_result: result, finished_at: new Date().toISOString(), error_code: null, error_summary: null });
        outcomes.push({ operation: step.operation, status: "succeeded", result });
        if (step.operation === "inspect_repository" && result && typeof result === "object" && "commitSha" in result) {
          const sha = (result as { commitSha: string }).commitSha;
          await db.from("project_sync_jobs").update({ source_commit_sha: sha, updated_at: new Date().toISOString() }).eq("id", job.id).eq("user_id", job.user_id).eq("lease_owner", WORKER_ID);
        }
      } catch (error) {
        const message = safeMessage(error);
        const code = message.includes("not enabled") ? "executor_not_enabled" : "provider_check_failed";
        await stepStatus(step.id, "failed", { error_code: code, error_summary: message, finished_at: new Date().toISOString() });
        outcomes.push({ operation: step.operation, status: "failed", error: message });
        break;
      }
      const { data: renewed, error: renewError } = await db.rpc("renew_project_sync_job_lease", {
        p_job_id: job.id, p_worker_id: WORKER_ID, p_lease_seconds: LEASE_SECONDS,
      });
      if (renewError || renewed !== true) throw new Error("Sync worker lease expired; stopping safely.");
    }

    const waiting = outcomes.some((o) => o.status === "waiting_approval");
    const failed = outcomes.some((o) => o.status === "failed" || o.status === "blocked");
    const status = waiting && !failed ? "waiting_approval" : failed ? "failed" : "succeeded";
    await finish(job, status, { outcomes, workerVersion: 1, readOnly: true });
    return { claimed: true, processed: 1, jobId: job.id, status, outcomes };
  } catch (error) {
    const message = safeMessage(error);
    try { await finish(job, "failed", { error: message, workerVersion: 1, readOnly: true }); } catch {}
    return { claimed: true, processed: 1, jobId: job.id, status: "failed", error: message };
  } finally {
  }
}
