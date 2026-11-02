import type { SupabaseClient } from "@supabase/supabase-js";

type RemoteKeeperConfig = {
  baseUrl: string;
  secret: string;
};

type RemoteKeeperResult = { ok: true } | { ok: false; status: number; message: string };

type KeeperOptions = {
  sb: SupabaseClient;
  userId: string;
  sessionId: string;
  origin: string;
  token: string;
  body: string;
  recovery?: boolean;
};

const ACCEPT_WAIT_MS = 75_000;
const POLL_INTERVAL_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve the optional Oracle/remote keeper without ever falling back to customer credentials. */
export function resolveRemoteKeeperConfig(env: Record<string, string | undefined>): RemoteKeeperConfig | null {
  const endpoint = env["FORGE_KEEPER_URL"]?.trim();
  if (!endpoint) return null;
  const secret = env["FORGE_KEEPER_SECRET"]?.trim();
  if (!secret || secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error("FORGE_KEEPER_SECRET must contain at least 32 URL-safe characters.");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("FORGE_KEEPER_URL must be an absolute HTTPS URL.");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("FORGE_KEEPER_URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("FORGE_KEEPER_URL must be an origin without credentials, path, query or fragment.");
  }
  return { baseUrl: url.origin, secret };
}

async function remoteRequest<T>(
  config: RemoteKeeperConfig,
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(new URL(path, config.baseUrl), {
    method,
    headers: {
      authorization: "Bearer " + config.secret,
      ...(body ? { "content-type": "application/json" } : {}),
      "cache-control": "no-store",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : "Remote keeper request failed.";
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}

/**
 * Starts a background stream on the user's own Oracle/remote host.
 * The host only relays the authenticated request to Forge; it never receives repo files
 * or executes project code. The session token is sent over HTTPS to the configured host.
 */
export async function startRemoteKeeper(options: KeeperOptions): Promise<RemoteKeeperResult | null> {
  const config = resolveRemoteKeeperConfig(process.env);
  if (!config) return null;

  const { data: before } = await options.sb
    .from("agent_sessions")
    .select("execution_id, stop_requested")
    .eq("id", options.sessionId)
    .eq("user_id", options.userId)
    .single();
  if (!before || (options.recovery && before.stop_requested)) {
    return { ok: false, status: 409, message: "Task stopped or changed before startup." };
  }

  const prepared = await remoteRequest<{ keeperId?: string }>(config, "/prepare", "POST", {});
  if (!prepared.keeperId || !UUID.test(prepared.keeperId)) {
    throw new Error("Remote keeper returned an invalid keeper ID.");
  }
  const keeperId = prepared.keeperId;

  let pin = options.sb.from("agent_sessions")
    .update({ keeper_id: keeperId, ...(!options.recovery ? { stop_requested: false } : {}) })
    .eq("id", options.sessionId)
    .eq("user_id", options.userId);
  pin = before.execution_id ? pin.eq("execution_id", before.execution_id) : pin.is("execution_id", null);
  if (options.recovery) pin = pin.eq("stop_requested", false).eq("running", true);
  const { data: pinned, error: pinError } = await pin.select("id");
  if (pinError || !pinned?.length) {
    await stopRemoteKeeper(keeperId).catch(() => {});
    return { ok: false, status: 409, message: "Task stopped or changed before startup." };
  }

  try {
    await remoteRequest(config, "/start", "POST", {
      keeperId,
      origin: options.origin,
      token: options.token,
      body: options.body,
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < ACCEPT_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const { data: current } = await options.sb
        .from("agent_sessions")
        .select("stop_requested, keeper_id")
        .eq("id", options.sessionId)
        .eq("user_id", options.userId)
        .single();
      if (!current || current.stop_requested || current.keeper_id !== keeperId) {
        await stopRemoteKeeper(keeperId).catch(() => {});
        return { ok: false, status: 409, message: "Task stopped during startup." };
      }
      const status = await remoteRequest<{
        state: string;
        status: number | null;
        message: string | null;
      }>(config, "/status?id=" + encodeURIComponent(keeperId), "GET");
      if (status.state === "accepted" || status.state === "finished") return { ok: true };
      if (status.state === "failed" || status.state === "stopped") {
        await stopRemoteKeeper(keeperId).catch(() => {});
        return {
          ok: false,
          status: status.status && status.status >= 400 ? status.status : 502,
          message: status.message || "Remote keeper could not start the background run.",
        };
      }
    }
    // The remote keeper may still be preparing a long request; the workspace follows saved progress.
    return { ok: true };
  } catch (error) {
    await stopRemoteKeeper(keeperId).catch(() => {});
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
    return { ok: false, status, message: error instanceof Error ? error.message : "Remote keeper failed." };
  }
}

export async function stopRemoteKeeper(keeperId: string): Promise<void> {
  const config = resolveRemoteKeeperConfig(process.env);
  if (!config) return;
  await remoteRequest(config, "/stop", "POST", { keeperId });
}
