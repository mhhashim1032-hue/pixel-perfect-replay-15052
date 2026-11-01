import { z } from "zod";

export const MAX_TEAM_JOBS = 12;
// Reserve outbound slots for the coordinator's progress saves and Stop polling.
export const ACTIVE_TEAM_WORKERS = 4;
// Limits are generous on purpose: models write detailed briefs and large file assignments, and a
// rejected dispatch tends to be retried verbatim, stalling the whole run.
export const MAX_JOB_TASK_CHARS = 20000;
export const MAX_JOB_PATHS = 40;
// Specialist catalogue. Writers propose files only within exact assigned paths; checkers share the
// serialized sandbox; the rest are read-only. Only the master merges.
export const SPECIALIST_ROLES = ["explorer", "coder", "reviewer", "tester", "architect", "research", "frontend", "backend", "database", "integration", "qa", "security", "debugger"] as const;
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];
export const WRITER_ROLES: readonly SpecialistRole[] = ["coder", "frontend", "backend", "database", "integration"];
export const CHECKER_ROLES: readonly SpecialistRole[] = ["tester", "qa", "debugger"];
export const ROLE_BRIEF: Record<SpecialistRole, string> = {
  explorer: "Find and explain the relevant code. Prefer search_files and read_files (batch reads).",
  research: "Read docs, existing implementations and MCP resources; report verified APIs, versions and constraints with file references.",
  architect: "Analyze architecture, dependencies and data flow; return a concrete technical design with files to change and risks.",
  reviewer: "Review the requested code against requirements; report concrete bugs, incomplete work, duplication and risks with file:line evidence.",
  security: "Audit auth, authorization, secrets exposure, injection and destructive operations; report findings with severity and file:line.",
  coder: "Implement the assigned change by proposing complete file contents only for assigned paths.",
  frontend: "Build UI in assigned files: reuse existing components, responsive layout, accessibility, loading/empty/error states.",
  backend: "Implement server logic in assigned files: validate inputs, handle errors, keep secrets server-side, preserve auth checks.",
  database: "Write schema/migration/query changes in assigned files: new timestamped migrations, indexes, RLS, never edit applied files.",
  integration: "Wire external APIs/webhooks/MCP in assigned files with timeouts, failure handling and no credential leakage.",
  tester: "Run the project's tests/typecheck/build with run_command and report exact failures with file:line.",
  qa: "Write/execute tests for acceptance criteria with run_command; report pass/fail per criterion with exact output lines.",
  debugger: "Reproduce the failure with run_command, read logs/stack traces, identify root cause and propose the targeted fix.",
};

/**
 * Dependency waves: jobs run once every job they name in \`after\` finished. Unknown labels and
 * cycles are rejected up front so the master cannot deadlock the team.
 */
export function scheduleWaves(jobs: { label: string; after?: string[] }[]): number[][] | string {
  const index = new Map<string, number>();
  jobs.forEach((j, i) => {
    if (index.has(j.label)) throw new Error(`Duplicate job label "${j.label}". Labels must be unique after normalization.`);
    index.set(j.label, i);
  });
  for (const j of jobs) for (const d of j.after ?? []) {
    if (!index.has(d)) return `Job "${j.label}" waits for unknown job "${d}".`;
    if (d === j.label) return `Job "${j.label}" cannot wait for itself.`;
  }
  const done = new Set<number>();
  const waves: number[][] = [];
  while (done.size < jobs.length) {
    const wave = jobs.map((_, i) => i).filter((i) => !done.has(i) && (jobs[i]!.after ?? []).every((d) => done.has(index.get(d)!)));
    if (!wave.length) return "Job dependencies form a cycle.";
    wave.forEach((i) => done.add(i));
    waves.push(wave);
  }
  return waves;
}

export const teamJobSchema = z.object({
  label: z.string().min(1).transform((s) => s.slice(0, 60)),
  role: z.enum(SPECIALIST_ROLES).default("explorer"),
  task: z.string().min(5).max(MAX_JOB_TASK_CHARS),
  paths: z.array(z.string().min(1).max(300)).max(MAX_JOB_PATHS).default([]),
  after: z.array(z.string().min(1).max(60)).max(MAX_TEAM_JOBS).default([]),
});
// Some models send the array as a JSON string; accept both spellings so a whole wave cannot
// be lost to a formatting quirk.
const jobsField = z.preprocess(
  (v) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v),
  z.array(teamJobSchema).min(1).max(MAX_TEAM_JOBS),
);
export const teamSchema = z.object({ jobs: jobsField });
export type CodeProposal = { id: string; path: string; content: string; original: string | null; label: string };

export function ownsPath(paths: string[], path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === "..")) return false;
  return paths.includes(path);
}

/** Ordered results, bounded parallel execution, and no new work after Stop. */
export async function parallelMap<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (!failed && cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await run(item, index);
      } catch (error) {
        // Stop assigning queued work as soon as any worker fails. Other in-flight work
        // is allowed to settle; callers still receive the original failure.
        failed = true;
        throw error;
      }
    }
  }));
  return results;
}

/** Abortable wait used for provider rate-limit backoff between worker attempts. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    }, { once: true });
  });
}

export function proposalConflict(proposal: CodeProposal, current: string | null): string | null {
  return proposal.original === current ? null : `File ${proposal.path} changed after the helper read it. Review and reassign instead of overwriting newer work.`;
}
/** Steps the master may spend mapping the repo before Forge requires a team dispatch. */
export const DISPATCH_BY_STEP = 2;
/**
 * Parallel-first policy: every real implementation request is split into specialist groups.
 * Only plan mode, automatic recovery notes and one-line chit-chat may stay solo.
 */
export function mustDispatch(message: string, opts: { plan: boolean }): boolean {
  if (opts.plan) return false;
  const text = message.trim();
  if (text.length < 25) return false;
  return !/^(thanks|thank you|ok|okay|hi|hello|yes|no|stop)\b[.!]?$/i.test(text);
}
/** Forces the delegate tool once, after the first exploration steps, if the master stayed solo. */
export function dispatchToolChoice(stepNumber: number, delegated: boolean, required: boolean) {
  return required && !delegated && stepNumber === DISPATCH_BY_STEP ? ({ type: "tool", toolName: "delegate" } as const) : undefined;
}
