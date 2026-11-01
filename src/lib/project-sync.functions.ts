import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildProjectSyncPlan, type SyncOperation } from "./project-control-plane";
import { validIdempotencyKey } from "./project-sync-state";

async function ownedTask(sb: any, userId: string, taskId: string) {
  const { data, error } = await sb.from("agent_sessions").select("id,user_id,repo,work_branch,accounts,supabase_ref,vercel_project_id").eq("id", taskId).eq("user_id", userId).single();
  if (error || !data) throw new Error("Project not found or access denied.");
  return data;
}

async function readiness(sb: any, userId: string, accounts: unknown, task: any) {
  const { cleanAccounts } = await import("./accounts");
  const pinned = cleanAccounts(accounts);
  const { data, error } = await sb.from("provider_credentials").select("id,provider").eq("user_id", userId).in("provider", ["github","supabase","vercel"]);
  if (error) throw new Error("Connected provider accounts could not be checked.");
  const rows = data ?? [];
  const connected = (provider: "github" | "supabase" | "vercel") => rows.some((r: any) => r.provider === provider);
  const hasPin = (provider: "github" | "supabase" | "vercel") => !!pinned[provider] && rows.some((r: any) => r.provider === provider && r.id === pinned[provider]);
  return {
    github: { connected: connected("github"), accountPinned: hasPin("github"), resourceSelected: !!task.repo && !!task.work_branch },
    supabase: { connected: connected("supabase"), accountPinned: hasPin("supabase"), resourceSelected: !!task.supabase_ref },
    vercel: { connected: connected("vercel"), accountPinned: hasPin("vercel"), resourceSelected: !!task.vercel_project_id },
  };
}

const operationSchema = z.enum(["apply_migrations"]);

export const createProjectSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    taskId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/),
    mode: z.enum(["connect_existing","create_new"]).default("connect_existing"),
  }))
  .handler(async ({ data, context }) => {
    if (!validIdempotencyKey(data.idempotencyKey)) throw new Error("Invalid sync request key.");
    const task = await ownedTask(context.supabase, context.userId, data.taskId);
    const providers = await readiness(context.supabase, context.userId, task.accounts, task);
    const plan = buildProjectSyncPlan({
      mode: data.mode,
      providers,
      hasDatabase: !!task.supabase_ref,
      hasDeployment: !!task.vercel_project_id,
      hasCommit: !!task.repo && !!task.work_branch,
      pendingMigrations: 0,
    });
    if (!plan.canStart) throw new Error("Project is not ready to sync. Connect and pin the required customer accounts and resources first.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: findError } = await supabaseAdmin.from("project_sync_jobs").select("id,status,summary").eq("task_id", task.id).eq("user_id", context.userId).eq("idempotency_key", data.idempotencyKey).maybeSingle();
    if (findError) throw new Error("Could not check existing sync request.");
    if (existing) return { jobId: existing.id, status: existing.status, plan: existing.summary?.plan ?? plan, reused: true };
    const steps = plan.steps.filter((s) => s.state !== "not_applicable").map((s) => ({
      operation: s.operation,
      status: s.state === "approval_required" ? "waiting_approval" : "pending",
      depends_on: s.dependsOn,
      requires_approval: s.requiresApproval,
      user_id: context.userId,
      task_id: task.id,
    }));
    const jobStatus = steps.some((s) => s.status === "waiting_approval") ? "waiting_approval" : "queued";
    const { data: job, error: insertError } = await supabaseAdmin.from("project_sync_jobs").insert({
      task_id: task.id,
      user_id: context.userId,
      idempotency_key: data.idempotencyKey,
      status: jobStatus,
      mode: data.mode,
      account_bindings: task.accounts ?? {},
      summary: { plan },
    }).select("id,status").single();
    if (insertError || !job) {
      // A concurrent identical request may have won the unique constraint.
      const { data: raced } = await supabaseAdmin.from("project_sync_jobs").select("id,status,summary").eq("task_id", task.id).eq("user_id", context.userId).eq("idempotency_key", data.idempotencyKey).maybeSingle();
      if (raced) return { jobId: raced.id, status: raced.status, plan: raced.summary?.plan ?? plan, reused: true };
      throw new Error("Could not create project sync job.");
    }
    const rows = steps.map((s) => ({ ...s, job_id: job.id }));
    const { error: stepError } = await supabaseAdmin.from("project_sync_steps").insert(rows);
    if (stepError) {
      await supabaseAdmin.from("project_sync_jobs").update({ status: "failed", finished_at: new Date().toISOString(), summary: { plan, error: "step_initialization_failed" } }).eq("id", job.id).eq("user_id", context.userId);
      throw new Error("Sync job was recorded but its steps could not be initialized. It has been marked failed.");
    }
    return { jobId: job.id, status: job.status, plan, reused: false };
  });

export const getProjectSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ taskId: z.string().uuid(), jobId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await ownedTask(context.supabase, context.userId, data.taskId);
    const { data: job, error } = await context.supabase.from("project_sync_jobs").select("id,task_id,status,mode,source_commit_sha,summary,attempt,created_at,updated_at,finished_at").eq("id", data.jobId).eq("task_id", data.taskId).eq("user_id", context.userId).single();
    if (error || !job) throw new Error("Sync job not found.");
    const { data: steps, error: stepError } = await context.supabase.from("project_sync_steps").select("id,operation,status,depends_on,requires_approval,approved_at,attempt,error_code,error_summary,started_at,finished_at").eq("job_id", data.jobId).eq("task_id", data.taskId).eq("user_id", context.userId).order("created_at");
    if (stepError) throw new Error("Sync steps could not be loaded.");
    return { job, steps: steps ?? [] };
  });

export const approveProjectSyncStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ taskId: z.string().uuid(), jobId: z.string().uuid(), operation: operationSchema }))
  .handler(async ({ data, context }) => {
    await ownedTask(context.supabase, context.userId, data.taskId);
    const { data: step, error } = await context.supabase.from("project_sync_steps").select("id,status,requires_approval,approved_at").eq("job_id", data.jobId).eq("task_id", data.taskId).eq("user_id", context.userId).eq("operation", data.operation).single();
    if (error || !step) throw new Error("Approval request not found.");
    if (!step.requires_approval) throw new Error("This operation does not require approval.");
    if (step.status !== "waiting_approval" && step.status !== "pending") throw new Error("This operation is no longer awaiting approval.");
    const now = new Date().toISOString();
    const { data: changed, error: updateError } = await supabaseAdmin.from("project_sync_steps").update({ approved_at: now, status: "pending", updated_at: now }).eq("id", step.id).eq("user_id", context.userId).is("approved_at", null).select("id");
    if (updateError) throw new Error("Approval could not be recorded.");
    if (!changed?.length && !step.approved_at) throw new Error("Approval state changed; refresh the project sync.");
    const { error: jobError } = await supabaseAdmin.from("project_sync_jobs").update({ status: "queued", updated_at: now }).eq("id", data.jobId).eq("task_id", data.taskId).eq("user_id", context.userId).eq("status", "waiting_approval");
    if (jobError) throw new Error("Approval was recorded, but the sync job could not be queued.");
    return { approved: true, queued: true };
  });
