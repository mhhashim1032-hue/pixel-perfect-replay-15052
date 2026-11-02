import { describe, expect, it } from "vitest";
import { agentOrigin, isE2BKeeperEnabled, readKeeperProbe } from "@/lib/background-run";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers });

describe("E2B keeper cost control", () => {
  it("keeps the compatibility fallback enabled by default", () => {
    expect(isE2BKeeperEnabled({})).toBe(true);
  });
  it("can disable E2B to avoid paid sandbox usage", () => {
    expect(isE2BKeeperEnabled({ FORGE_DISABLE_E2B_KEEPER: "true" })).toBe(false);
  });
});

describe("agentOrigin", () => {
  it("uses the public forwarded host over https", () => {
    expect(agentOrigin(req("http://localhost:8080/api/agent-background", { "x-forwarded-host": "pixel-perfect-replay-15052.lovable.app" }))).toBe("https://pixel-perfect-replay-15052.lovable.app");
  });
  it("refuses local-only hosts so the run streams directly", () => {
    expect(agentOrigin(req("http://localhost:8080/api/agent-background"))).toBeNull();
    expect(agentOrigin(req("http://127.0.0.1:8080/x"))).toBeNull();
  });
  it("rejects malformed forwarded hosts", () => {
    expect(agentOrigin(req("http://localhost/x", { "x-forwarded-host": "evil.com/path?" }))).toBeNull();
  });
});

describe("readKeeperProbe", () => {
  it("treats a 200 response as accepted", () => {
    expect(readKeeperProbe("|HTTP/2 200|")).toEqual({ accepted: true });
  });
  it("passes the refusal reason through", () => {
    expect(readKeeperProbe("0|HTTP/2 409|This task is already running")).toEqual({ accepted: false, status: 409, message: "This task is already running" });
  });
  it("keeps waiting while there is no response yet", () => {
    expect(readKeeperProbe("||")).toBeNull();
  });
  it("reports an unreachable callback", () => {
    expect(readKeeperProbe("6||")).toMatchObject({ accepted: false, status: 502 });
  });
});
