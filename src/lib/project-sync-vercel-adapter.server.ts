import { createHash } from "node:crypto";
import { accountToken } from "./accounts.server";
import { Vercel } from "./integrations.server";

export type VercelInspectSession = {
  user_id: string;
  repo: string;
  vercel_project_id: string | null;
  accounts?: unknown;
};

export type VercelInspectResult = {
  state: "succeeded";
  projectId: string;
  linkedRepository: string | null;
  repositoryMatches: boolean;
  domains: string[];
  outputFingerprint: string;
};

function assertProjectId(value: string | null): string {
  if (!value || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) {
    throw new Error("The project's pinned Vercel project ID is invalid.");
  }
  return value;
}

function assertRepository(value: string): string {
  const repo = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.includes("..")) {
    throw new Error("The project's pinned GitHub repository is invalid.");
  }
  return repo;
}

/** Read-only verification of the exact Vercel project pinned to an owned Forge session. */
export async function inspectPinnedVercelProject(input: {
  supabase: any;
  userId: string;
  session: VercelInspectSession;
  signal?: AbortSignal;
}): Promise<VercelInspectResult> {
  input.signal?.throwIfAborted();
  if (!input.userId || input.session.user_id !== input.userId) {
    throw new Error("The project session is not owned by the signed-in user.");
  }
  const projectId = assertProjectId(input.session.vercel_project_id);
  const repository = assertRepository(input.session.repo);
  const token = await accountToken(input.supabase, input.userId, "vercel", input.session.accounts);
  if (!token) throw new Error("Connect the Vercel account pinned to this project.");

  input.signal?.throwIfAborted();
  const vercel = new Vercel(token, input.signal);
  const project = await vercel.project(projectId);
  input.signal?.throwIfAborted();
  const domains = (await vercel.domains(projectId)).sort();
  input.signal?.throwIfAborted();
  const linkedRepository = project.repo?.toLowerCase() ?? null;
  const repositoryMatches = linkedRepository === repository.toLowerCase();
  const outputFingerprint = createHash("sha256")
    .update(JSON.stringify({ projectId, repository, linkedRepository, domains }))
    .digest("hex");
  return { state: "succeeded", projectId, linkedRepository, repositoryMatches, domains, outputFingerprint };
}
