// "Connect & sync": one pass that wires GitHub + database + Vercel together and reports health.
import { accountToken } from "./accounts.server";
import { orderDomains, overall, type SyncStep } from "./connect";

type Session = {
  id: string; user_id: string; repo: string; work_branch: string; mode: string; accounts?: unknown;
  supabase_ref: string | null; vercel_project_id: string | null; applied_migrations: string[] | null;
};

const safe = (e: unknown) => {
  const m = (e as Error)?.message ?? "failed";
  // Provider errors are summarised; never echo credential-bearing bodies.
  if (/permission|403/i.test(m)) return "your saved token doesn't have permission for this";
  if (/401|unauthor/i.test(m)) return "the saved token was rejected; reconnect the account";
  return m.slice(0, 160);
};

export async function syncProject(sb: any, s: Session) {
  const steps: SyncStep[] = [];
  const buildErrors: string[] = [];
  const [gt, st, vt] = await Promise.all([
    accountToken(sb, s.user_id, "github", s.accounts),
    accountToken(sb, s.user_id, "supabase", s.accounts),
    accountToken(sb, s.user_id, "vercel", s.accounts),
  ]);
  const { Vercel } = await import("./integrations.server");

  steps.push(gt ? { key: "github", label: "GitHub", state: "ok", note: `Working on ${s.repo}` } : { key: "github", label: "GitHub", state: "fail", note: "Add a GitHub account in Settings" });

  // Vercel project + its link to this repo
  let domains: string[] = [];
  const v = vt ? new Vercel(vt) : null;
  if (!s.vercel_project_id) steps.push({ key: "vercel", label: "Website (Vercel)", state: "skip", note: vt ? "Choose a website in Deploy" : "Not connected" });
  else if (!v) steps.push({ key: "vercel", label: "Website (Vercel)", state: "fail", note: "Vercel account missing; reconnect it" });
  else {
    try {
      const p = await v.project(s.vercel_project_id);
      domains = orderDomains(await v.domains(s.vercel_project_id).catch(() => []));
      const linked = p.repo?.toLowerCase() === s.repo.toLowerCase();
      steps.push(linked
        ? { key: "vercel", label: "Website (Vercel)", state: "ok", note: domains[0] ? `Live address ${domains[0]}` : "Linked to the repo" }
        : { key: "vercel", label: "Website (Vercel)", state: "warn", note: p.repo ? `Vercel builds ${p.repo}, not ${s.repo}` : "Vercel project isn't linked to this GitHub repo" });
    } catch (e) { steps.push({ key: "vercel", label: "Website (Vercel)", state: "fail", note: safe(e) }); }
  }

  // Connect is deliberately read-only. Customer environment values require the separate Deploy approval flow.
  if (!s.supabase_ref) steps.push({ key: "database", label: "Database", state: "skip", note: st ? "Choose a database in Deploy" : "Not connected" });
  else if (!st) steps.push({ key: "database", label: "Database", state: "fail", note: "Database account missing; reconnect it" });
  else if (s.vercel_project_id && vt) {
    steps.push({ key: "database", label: "Database settings in Vercel", state: "warn", note: "No environment values were changed. Review and approve the exact settings in Deploy before syncing." });
  } else steps.push({ key: "database", label: "Database", state: "ok", note: "Linked" });

  // Authentication settings (including confirmation and redirect allow-lists) are never changed by Connect.
  if (s.supabase_ref && st) {
    steps.push({ key: "auth", label: "Signup and sign-in settings", state: "warn", note: "Authentication settings were not changed. Review any redirect allow-list changes in Deploy; email confirmation settings are preserved." });
  }

  // Migration inspection only. Applying migrations is available only through the separate approval flow.
  if (s.supabase_ref && st && gt) {
    try {
      const { GitHub } = await import("./github.server");
      const { pendingMigrations } = await import("./integrations.server");
      const gh = new GitHub(gt);
      const todo = pendingMigrations(await gh.tree(s.repo, s.work_branch), s.applied_migrations ?? []);
      if (!todo.length) steps.push({ key: "migrations", label: "Database changes", state: "ok", note: "All applied" });
      else steps.push({ key: "migrations", label: "Database changes", state: "warn", note: `${todo.length} pending migration(s); inspect and explicitly approve them in Deploy.` });
    } catch (e) { steps.push({ key: "migrations", label: "Database changes", state: "warn", note: safe(e) }); }
  }

  // Latest build + live page
  if (v && s.vercel_project_id) {
    try {
      const d = (await v.deployments(s.vercel_project_id, s.work_branch))[0] ?? (await v.deployments(s.vercel_project_id))[0];
      if (!d) steps.push({ key: "build", label: "Latest build", state: "skip", note: "No build yet" });
      else if (d.state === "ERROR") {
        const log = await v.buildLog(d.id).catch(() => "");
        const { firstErrorLines } = await import("./deployment-quality");
        buildErrors.push(...firstErrorLines(String(log ?? ""), 12));
        steps.push({ key: "build", label: "Latest build", state: "fail", note: buildErrors[0] ?? "Build failed" });
      } else if (d.state === "READY") {
        const log = await v.buildLog(d.id).catch(() => null);
        const { vercelBuildFindings } = await import("./vercel-build-review");
        const issues = log === null ? [] : vercelBuildFindings(log);
        buildErrors.push(...issues.map((issue) => issue.evidence));
        steps.push({ key: "build-review", label: "Vercel build issues", state: log === null || issues.length ? "warn" : "ok", note: log === null ? "Build log unavailable; issue review is unverified" : issues.length ? `${issues.length} issue(s) to review: ${issues[0]?.evidence}` : "No warnings found in available build logs" });
        const { checkDeploymentRuntime } = await import("./deployment-runtime.server");
        const r = await checkDeploymentRuntime(d.url);
        steps.push({ key: "build", label: "Live page", state: r.state === "PASSED" ? "ok" : r.state === "ERROR" ? "fail" : "warn", note: r.note });
      } else steps.push({ key: "build", label: "Latest build", state: "warn", note: `Build is ${String(d.state).toLowerCase()}` });
    } catch (e) { steps.push({ key: "build", label: "Latest build", state: "warn", note: safe(e) }); }
  }

  return { steps, overall: overall(steps), buildErrors };
}
