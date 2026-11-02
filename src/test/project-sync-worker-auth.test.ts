import { describe, expect, it } from "vitest";
import { isValidProjectSyncWorkerSecret } from "@/lib/project-sync-worker-auth.server";

const secret = "forge_worker_secret_0123456789_abcdef";

describe("project sync worker trigger authentication", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isValidProjectSyncWorkerSecret(`Bearer ${secret}`, secret)).toBe(true);
    expect(isValidProjectSyncWorkerSecret(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isValidProjectSyncWorkerSecret(secret, secret)).toBe(false);
    expect(isValidProjectSyncWorkerSecret(null, secret)).toBe(false);
  });

  it("fails closed when the configured secret is absent, weak or malformed", () => {
    expect(isValidProjectSyncWorkerSecret(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isValidProjectSyncWorkerSecret("Bearer short", "short")).toBe(false);
    expect(isValidProjectSyncWorkerSecret(`Bearer ${secret}`, "has spaces and is long enough")).toBe(false);
  });
});
