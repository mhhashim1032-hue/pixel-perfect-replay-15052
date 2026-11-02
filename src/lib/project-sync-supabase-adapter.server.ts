import { createHash } from "node:crypto";
import { accountToken } from "./accounts.server";
import { SupabaseMgmt } from "./integrations.server";

export type SupabaseInspectSession = {
  user_id: string;
  supabase_ref: string | null;
  accounts?: unknown;
};

export type SupabaseInspectResult = {
  state: "succeeded";
  projectRef: string;
  projectStatus: string;
  outputFingerprint: string;
};

function assertProjectRef(value: string | null): string {
  if (!value || !/^[a-z0-9]{20}$/i.test(value)) {
    throw new Error("The project's pinned Supabase project reference is invalid.");
  }
  return value;
}

/** Read-only verification of the exact Supabase project pinned to an owned Forge session. */
export async function inspectPinnedSupabaseProject(input: {
  supabase: any;
  userId: string;
  session: SupabaseInspectSession;
  signal?: AbortSignal;
}): Promise<SupabaseInspectResult> {
  input.signal?.throwIfAborted();
  if (!input.userId || input.session.user_id !== input.userId) {
    throw new Error("The project session is not owned by the signed-in user.");
  }
  const projectRef = assertProjectRef(input.session.supabase_ref);
  const token = await accountToken(input.supabase, input.userId, "supabase", input.session.accounts);
  if (!token) throw new Error("Connect the Supabase account pinned to this project.");

  input.signal?.throwIfAborted();
  const management = new SupabaseMgmt(token, input.signal);
  const projectStatus = await management.status(projectRef);
  input.signal?.throwIfAborted();
  const outputFingerprint = createHash("sha256")
    .update(JSON.stringify({ projectRef, projectStatus }))
    .digest("hex");
  return { state: "succeeded", projectRef, projectStatus, outputFingerprint };
}
