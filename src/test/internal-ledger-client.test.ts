import { describe, expect, it } from "vitest";
import { resolveInternalLedgerConfig } from "@/lib/internal-ledger-client.server";

describe("Forge internal ledger credentials", () => {
  it("requires dedicated internal credentials and never falls back to customer Supabase env", () => {
    expect(() => resolveInternalLedgerConfig({
      SUPABASE_URL: "https://customer.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "customer-secret",
    })).toThrow("worker is disabled");
  });

  it("accepts a dedicated HTTPS service-role configuration", () => {
    expect(resolveInternalLedgerConfig({
      FORGE_INTERNAL_SUPABASE_URL: "https://forge-internal.supabase.co/",
      FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY: "eyJ-service-role-jwt",
    })).toEqual({
      url: "https://forge-internal.supabase.co",
      serviceRoleKey: "eyJ-service-role-jwt",
    });
  });

  it("rejects publishable keys and insecure remote URLs", () => {
    expect(() => resolveInternalLedgerConfig({
      FORGE_INTERNAL_SUPABASE_URL: "https://forge-internal.supabase.co",
      FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_public",
    })).toThrow("server-only service-role");
    expect(() => resolveInternalLedgerConfig({
      FORGE_INTERNAL_SUPABASE_URL: "http://forge-internal.example.com",
      FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY: "sb_secret_internal",
    })).toThrow("HTTPS");
  });

  it("allows local HTTP for isolated development databases", () => {
    expect(resolveInternalLedgerConfig({
      FORGE_INTERNAL_SUPABASE_URL: "http://127.0.0.1:54321",
      FORGE_INTERNAL_SUPABASE_SERVICE_ROLE_KEY: "sb_secret_local",
    }).url).toBe("http://127.0.0.1:54321");
  });
});
