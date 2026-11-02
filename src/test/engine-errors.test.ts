import { describe, expect, it } from "vitest";
import { redact } from "@/lib/engine/errors";

describe("engine error redaction", () => {
  it("redacts bearer tokens even when preceded by an authorization header", () => {
    const value = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(value).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(value).toContain("[redacted]");
  });

  it("redacts provider keys, JWTs, URL credentials and assignment secrets", () => {
    const value = redact(
      "sk_live_1234567890 eyJabcdefghijk.abcdefghijk.abcdefghijk " +
      "AKIAIOSFODNN7EXAMPLE AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA " +
      "https://admin:password@example.com api_key=private-value",
    );
    expect(value).not.toContain("sk_live_1234567890");
    expect(value).not.toContain("eyJabcdefghijk");
    expect(value).not.toContain("admin:password");
    expect(value).not.toContain("private-value");
    expect(value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(value).not.toContain("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("does not change ordinary diagnostics", () => {
    expect(redact("Build failed: missing module vite")).toBe("Build failed: missing module vite");
  });
});
