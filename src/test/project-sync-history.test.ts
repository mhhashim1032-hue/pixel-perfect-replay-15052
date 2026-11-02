import { describe, expect, it } from "vitest";
import {
  normalizeProjectSyncHistoryPage,
  safeProjectSyncEventPayload,
  safeProjectSyncHistoryError,
} from "@/lib/project-sync-history.server";

describe("project sync history safety", () => {
  it("clamps invalid and excessive page indexes", () => {
    expect(normalizeProjectSyncHistoryPage(undefined)).toBe(0);
    expect(normalizeProjectSyncHistoryPage(Number.NaN)).toBe(0);
    expect(normalizeProjectSyncHistoryPage(-4)).toBe(0);
    expect(normalizeProjectSyncHistoryPage(1.8)).toBe(1);
    expect(normalizeProjectSyncHistoryPage(99_999)).toBe(10_000);
  });

  it("allows only bounded display fields from event payloads", () => {
    const payload = safeProjectSyncEventPayload({
      stepKey: "inspect_repository",
      operation: "inspect_repository",
      state: "succeeded",
      attempt: 2,
      error: "x".repeat(500),
      outputFingerprint: "abc123",
      access_token: "must-not-leak",
      authorization: "Bearer secret",
      providerResponse: { token: "secret" },
    });
    expect(payload).toMatchObject({
      stepKey: "inspect_repository",
      operation: "inspect_repository",
      state: "succeeded",
      attempt: 2,
      outputFingerprint: "abc123",
    });
    expect(payload["error"]).toHaveLength(300);
    expect(payload).not.toHaveProperty("access_token");
    expect(payload).not.toHaveProperty("authorization");
    expect(payload).not.toHaveProperty("providerResponse");
  });

  it("redacts credentials in stored history errors", () => {
    expect(safeProjectSyncHistoryError("Bearer abc.def sk_live_12345678 api_key=secret-value"))
      .toBe("Bearer [REDACTED] [REDACTED_KEY] api_key=[REDACTED]");
    expect(safeProjectSyncHistoryError(null)).toBeNull();
  });

  it("rejects arrays and primitives as event payloads", () => {
    expect(safeProjectSyncEventPayload(["secret"])).toEqual({});
    expect(safeProjectSyncEventPayload("secret")).toEqual({});
    expect(safeProjectSyncEventPayload(null)).toEqual({});
  });
});
