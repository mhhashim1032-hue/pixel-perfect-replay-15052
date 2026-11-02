import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accountToken: vi.fn(), status: vi.fn(), signal: undefined as AbortSignal | undefined }));
vi.mock("@/lib/accounts.server", () => ({ accountToken: (...args: unknown[]) => mocks.accountToken(...args) }));
vi.mock("@/lib/integrations.server", () => ({
  SupabaseMgmt: class {
    status = mocks.status;
    constructor(_token: string, signal?: AbortSignal) { mocks.signal = signal; }
  },
}));

import { inspectPinnedSupabaseProject } from "@/lib/project-sync-supabase-adapter.server";

const session = { user_id: "user-1", supabase_ref: "abcdefghijklmnopqrst", accounts: [{ id: "supabase-account" }] };

describe("pinned Supabase project inspection adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountToken.mockResolvedValue("supabase-token");
    mocks.status.mockResolvedValue("ACTIVE_HEALTHY");
  });

  it("checks only the selected Supabase project with the session-pinned account", async () => {
    const result = await inspectPinnedSupabaseProject({ supabase: {}, userId: "user-1", session });
    expect(mocks.accountToken).toHaveBeenCalledWith({}, "user-1", "supabase", session.accounts);
    expect(mocks.status).toHaveBeenCalledWith(session.supabase_ref);
    expect(result).toMatchObject({ state: "succeeded", projectRef: session.supabase_ref, projectStatus: "ACTIVE_HEALTHY" });
    expect(result.outputFingerprint).toHaveLength(64);
  });

  it("rejects a project session owned by another user before resolving credentials", async () => {
    await expect(inspectPinnedSupabaseProject({ supabase: {}, userId: "user-2", session })).rejects.toThrow("not owned");
    expect(mocks.accountToken).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed project references before provider calls", async () => {
    await expect(inspectPinnedSupabaseProject({ supabase: {}, userId: "user-1", session: { ...session, supabase_ref: null } })).rejects.toThrow("reference is invalid");
    await expect(inspectPinnedSupabaseProject({ supabase: {}, userId: "user-1", session: { ...session, supabase_ref: "https://example.com" } })).rejects.toThrow("reference is invalid");
    expect(mocks.accountToken).not.toHaveBeenCalled();
  });

  it("passes worker cancellation into Supabase Management API calls", async () => {
    const controller = new AbortController();
    await inspectPinnedSupabaseProject({ supabase: {}, userId: "user-1", session, signal: controller.signal });
    expect(mocks.signal).toBe(controller.signal);
  });

  it("does not call Supabase when the pinned account has no credential", async () => {
    mocks.accountToken.mockResolvedValue(null);
    await expect(inspectPinnedSupabaseProject({ supabase: {}, userId: "user-1", session })).rejects.toThrow("Connect the Supabase account pinned");
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
