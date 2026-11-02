// Pure helpers for cloud-kept background runs (no server-only imports; unit-tested).

/** Public HTTPS origin the cloud keeper can call back, or null when only reachable locally. */
export function agentOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const host = (request.headers.get("x-forwarded-host")?.split(",")[0] ?? url.host).trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null;
  const name = host.replace(/:\d+$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(name) || !name.includes(".")) return null;
  return `https://${host}`;
}

/**
 * Shell run inside a dedicated keeper sandbox: it holds the /api/agent stream open so the
 * run continues when the user's phone sleeps or switches apps. Writes headers, body and exit code.
 */
export const KEEPER_SCRIPT =
  'curl -sS -N --max-time 3500 -X POST "$FORGE_URL/api/agent" -H "authorization: Bearer $FORGE_TOKEN" -H "content-type: application/json" -H "x-forge-keeper: $FORGE_KEEPER" --data-binary @/tmp/req.json -D /tmp/headers -o /tmp/out.ndjson; echo $? > /tmp/done; rm -f /tmp/req.json';

export type KeeperProbe = { accepted: true } | { accepted: false; status: number; message: string } | null;

/** Interprets one keeper poll: "<exit code or empty>|<first header line>|<body excerpt>". */
export function readKeeperProbe(raw: string): KeeperProbe {
  const [done = "", statusLine = "", ...rest] = raw.split("|");
  const body = rest.join("|").trim();
  const status = Number(statusLine.match(/HTTP\/\S+\s+(\d{3})/)?.[1] ?? 0);
  if (status === 200) return { accepted: true };
  if (status >= 400) return { accepted: false, status, message: body.slice(0, 1000) || `The run was refused (${status}).` };
  if (done.trim()) return { accepted: false, status: 502, message: "Forge could not reach itself from the cloud keeper. Try again." };
  return null;
}

/** E2B is opt-in for deployments that want to avoid accidental paid keeper usage. */
export function isE2BKeeperEnabled(env: Record<string, string | undefined>): boolean {
  return env["FORGE_DISABLE_E2B_KEEPER"] !== "true";
}
