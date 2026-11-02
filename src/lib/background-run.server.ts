import type { SupabaseClient } from "@supabase/supabase-js";
import { isE2BKeeperEnabled, KEEPER_SCRIPT, readKeeperProbe } from "./background-run";
import { startRemoteKeeper, stopRemoteKeeper } from "./remote-keeper.server";

const KEEPER_TIMEOUT_MS = 60 * 60_000;
const ACCEPT_WAIT_MS = 75_000;

type Result = { ok: true } | { ok: false; status: number; message: string };

/**
 * Starts the configured remote keeper or optional E2B relay for a long-lived agent stream.
 * The keeper never receives repository files or customer provider credentials.
 */
export async function startKeeper(opts: { sb: SupabaseClient; userId: string; sessionId: string; origin: string; token: string; body: string; recovery?: boolean }): Promise<Result | null> {
  // Prefer the user's zero-cost Oracle/remote keeper when explicitly configured.
  // E2B remains an optional compatibility fallback for existing installations.
  if (process.env["FORGE_KEEPER_URL"]?.trim()) return startRemoteKeeper(opts);
  if (!isE2BKeeperEnabled(process.env)) return null;
  const apiKey = process.env["E2B_API_KEY"];
  if (!apiKey) return null;
  const { data: before } = await opts.sb.from("agent_sessions").select("execution_id, stop_requested").eq("id", opts.sessionId).eq("user_id", opts.userId).single();
  if (!before || (opts.recovery && before.stop_requested)) return { ok: false, status: 409, message: "Task stopped or changed before startup" };
  const { Sandbox } = await import("e2b");
  const box = await Sandbox.create({ apiKey, timeoutMs: KEEPER_TIMEOUT_MS, metadata: { keeper: opts.sessionId } });
  try {
    let pin = opts.sb.from("agent_sessions").update({ keeper_id: box.sandboxId, ...(!opts.recovery ? { stop_requested: false } : {}) }).eq("id", opts.sessionId).eq("user_id", opts.userId);
    pin = before.execution_id ? pin.eq("execution_id", before.execution_id) : pin.is("execution_id", null);
    if (opts.recovery) pin = pin.eq("stop_requested", false).eq("running", true);
    const { data: pinned, error } = await pin.select("id");
    if (error || !pinned?.length) { await box.kill(); return { ok: false, status: 409, message: "Task stopped or changed before recovery" }; }
    await box.files.write("/tmp/req.json", opts.body);
    await box.commands.run(KEEPER_SCRIPT, {
      background: true,
      timeoutMs: 0,
      envs: { FORGE_URL: opts.origin, FORGE_TOKEN: opts.token, FORGE_KEEPER: box.sandboxId },
    });
    const started = Date.now();
    while (Date.now() - started < ACCEPT_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data: current } = await opts.sb.from("agent_sessions").select("stop_requested, keeper_id").eq("id", opts.sessionId).eq("user_id", opts.userId).single();
      if (!current || current.stop_requested || current.keeper_id !== box.sandboxId) {
        await box.kill().catch(() => {});
        return { ok: false, status: 409, message: "Task stopped during startup" };
      }
      const probe = await box.commands
        .run(`printf '%s|%s|' "$(cat /tmp/done 2>/dev/null)" "$(head -1 /tmp/headers 2>/dev/null | tr -d '\\r')"; [ -f /tmp/done ] && head -c 1000 /tmp/out.ndjson`, { timeoutMs: 10_000 })
        .catch((error: unknown) => ({ stdout: error instanceof Error ? error.message : String(error) }));
      const res = readKeeperProbe(String(probe?.stdout ?? ""));
      if (!res) continue;
      if (res.accepted) return { ok: true };
      await box.kill().catch(() => {});
      return { ok: false, status: res.status, message: res.message };
    }
    // Still preparing (long history summary); the keeper keeps waiting, the page follows saved progress.
    return { ok: true };
  } catch (e) {
    await box.kill().catch(() => {});
    throw e;
  }
}

/** Ends a keeper sandbox once its run finished (best effort; it also expires on its own). */
export async function stopKeeper(id: string) {
  if (process.env["FORGE_KEEPER_URL"]?.trim()) {
    await stopRemoteKeeper(id).catch(() => {});
    return;
  }
  const apiKey = process.env["E2B_API_KEY"];
  if (!apiKey) return;
  const { Sandbox } = await import("e2b");
  await Sandbox.kill(id, { apiKey }).catch(() => {});
}
