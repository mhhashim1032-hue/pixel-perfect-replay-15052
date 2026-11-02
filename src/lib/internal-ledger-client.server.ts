import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type InternalLedgerConfig = {
  url: string;
  serviceRoleKey: string;
};

/**
 * Resolve only explicitly dedicated Forge-internal credentials.
 * Deliberately does not fall back to SUPABASE_URL or customer/provider credentials.
 */
export function resolveInternalLedgerConfig(
  env: Record<string, string | undefined>,
): InternalLedgerConfig {
  const url = env["FORGE_INTERNAL_SUPABASE_URL"]?.trim();
  const serviceRoleKey = env["FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY"]?.trim();

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Project sync worker is disabled: configure FORGE_INTERNAL_SUPABASE_URL and FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY for Forge's own ledger database.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("FORGE_INTERNAL_SUPABASE_URL must be a valid absolute URL.");
  }

  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("Forge internal Supabase URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  const isSupabaseSecret = serviceRoleKey.startsWith("sb_secret_");
  const isLegacyServiceRoleJwt = (() => {
    const parts = serviceRoleKey.split(".");
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: unknown };
      return payload.role === "service_role";
    } catch {
      return false;
    }
  })();
  if (!isSupabaseSecret && !isLegacyServiceRoleJwt) {
    throw new Error("Forge internal ledger requires a server-only service-role or Supabase secret key; publishable/anon keys are not accepted.");
  }

  return { url: parsed.toString().replace(/\/$/, ""), serviceRoleKey };
}

let singleton: SupabaseClient | undefined;

/**
 * Server-only client for Forge's own application database ledger.
 * Never use this client for a customer's Supabase project.
 */
export function getInternalLedgerAdmin(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("The Forge internal ledger admin client is server-only.");
  }
  if (!singleton) {
    const config = resolveInternalLedgerConfig(process.env);
    singleton = createClient(config.url, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "X-Forge-Internal-Ledger": "true" } },
    });
  }
  return singleton;
}
