import { describe, expect, it } from "vitest";
import { resolveRemoteKeeperConfig } from "@/lib/remote-keeper.server";

describe("remote keeper configuration", () => {
  it("is disabled when no remote URL is configured", () => {
    expect(resolveRemoteKeeperConfig({})).toBeNull();
  });

  it("accepts an HTTPS origin and trims a trailing slash", () => {
    expect(resolveRemoteKeeperConfig({
      FORGE_KEEPER_URL: "https://keeper.example.com/",
      FORGE_KEEPER_SECRET: "a".repeat(64),
    })).toEqual({
      baseUrl: "https://keeper.example.com",
      secret: "a".repeat(64),
    });
  });

  it("rejects short or malformed shared secrets", () => {
    expect(() => resolveRemoteKeeperConfig({
      FORGE_KEEPER_URL: "https://keeper.example.com",
      FORGE_KEEPER_SECRET: "too-short",
    })).toThrow("at least 32");
    expect(() => resolveRemoteKeeperConfig({
      FORGE_KEEPER_URL: "https://keeper.example.com",
      FORGE_KEEPER_SECRET: "x".repeat(32) + "!",
    })).toThrow("at least 32");
  });

  it("rejects non-HTTPS remote hosts outside localhost", () => {
    expect(() => resolveRemoteKeeperConfig({
      FORGE_KEEPER_URL: "http://keeper.example.com",
      FORGE_KEEPER_SECRET: "a".repeat(64),
    })).toThrow("must use HTTPS");
  });

  it("rejects URL paths, credentials, queries and fragments", () => {
    for (const url of [
      "https://keeper.example.com/relay",
      "https://user:pass@keeper.example.com",
      "https://keeper.example.com?token=unsafe",
      "https://keeper.example.com#fragment",
    ]) {
      expect(() => resolveRemoteKeeperConfig({
        FORGE_KEEPER_URL: url,
        FORGE_KEEPER_SECRET: "a".repeat(64),
      })).toThrow("must be an origin");
    }
  });
});
