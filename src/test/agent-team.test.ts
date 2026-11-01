import { describe, expect, it } from "vitest";
import { ACTIVE_TEAM_WORKERS, MAX_TEAM_JOBS, ownsPath, parallelMap, proposalConflict, scheduleWaves, teamSchema } from "@/lib/agent-team";

describe("master-controlled agent team", () => {
  it("accepts twelve jobs including coders and rejects larger teams", () => {
    const job = { label: "UI", role: "coder", task: "Implement UI", paths: ["src/ui.tsx"] };
    expect(MAX_TEAM_JOBS).toBe(12);
    expect(teamSchema.safeParse({ jobs: Array(12).fill(job) }).success).toBe(true);
    expect(teamSchema.safeParse({ jobs: Array(13).fill(job) }).success).toBe(false);
  });
  it("executes four workers concurrently and preserves result order", async () => {
    let active = 0, peak = 0;
    const result = await parallelMap(Array.from({ length: 12 }, (_, i) => i), ACTIVE_TEAM_WORKERS, async (i) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--; return i;
    });
    expect(peak).toBe(4);
    expect(result).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
  it("stops queued jobs after explicit cancellation", async () => {
    const controller = new AbortController();
    let called = 0;
    await expect(parallelMap([1, 2, 3], 1, async () => { called++; controller.abort(); }, controller.signal)).rejects.toThrow();
    expect(called).toBe(1);
  });
  it("limits coder proposals to exactly assigned safe files", () => {
    expect(ownsPath(["src/ui.tsx"], "src/ui.tsx")).toBe(true);
    expect(ownsPath(["src/ui.tsx"], "src/auth.ts")).toBe(false);
    expect(ownsPath(["../secret"], "../secret")).toBe(false);
  });
  it("rejects stale code proposals without replacing newer work", () => {
    const proposal = { id: "p1", path: "src/ui.tsx", content: "new", original: "old", label: "UI" };
    expect(proposalConflict(proposal, "old")).toBeNull();
    expect(proposalConflict(proposal, "someone else's edit")).not.toBeNull();
  });

  it("rejects duplicate dependency labels instead of silently binding the wrong job", () => {
    expect(() => scheduleWaves([{ label: "build" }, { label: "build" }])).toThrow(/Duplicate job label/);
  });
  it("stops assigning queued work after a worker fails", async () => {
    let called = 0;
    await expect(parallelMap([1, 2, 3, 4], 1, async (value) => {
      called++;
      if (value === 1) throw new Error("worker failed");
      return value;
    })).rejects.toThrow("worker failed");
    expect(called).toBe(1);
  });
  it("accepts a whole team sent as a JSON string and still rejects malformed text", () => {
    const job = { label: "UI", role: "coder", task: "Implement UI", paths: ["src/ui.tsx"] };
    const packed = teamSchema.safeParse({ jobs: JSON.stringify([job]) });
    expect(packed.success).toBe(true);
    if (packed.success) expect(packed.data.jobs[0]?.label).toBe("UI");
    expect(teamSchema.safeParse({ jobs: "not json" }).success).toBe(false);
  });
});
describe("team dispatch limits", () => {
  it("accepts detailed briefs up to 20,000 characters and 40 assigned files", () => {
    const job = { label: "Public pages", role: "coder", task: "x".repeat(7622), paths: Array.from({ length: 24 }, (_, i) => `src/p${i}.tsx`) };
    expect(teamSchema.safeParse({ jobs: [job] }).success).toBe(true);
    expect(teamSchema.safeParse({ jobs: [{ ...job, task: "x".repeat(20001) }] }).success).toBe(false);
    expect(teamSchema.safeParse({ jobs: [{ ...job, paths: Array(41).fill("a.ts") }] }).success).toBe(false);
  });
  it("shortens long labels instead of rejecting the dispatch", () => {
    const r = teamSchema.safeParse({ jobs: [{ label: "L".repeat(90), task: "do the thing" }] });
    expect(r.success && r.data.jobs[0]?.label.length).toBe(60);
  });
});

import { DISPATCH_BY_STEP, dispatchToolChoice, mustDispatch } from "@/lib/agent-team";
describe("parallel-first dispatch", () => {
  it("requires a team for real tasks but not plan mode or short replies", () => {
    expect(mustDispatch("Build a pricing page with checkout and tests", { plan: false })).toBe(true);
    expect(mustDispatch("Build a pricing page with checkout and tests", { plan: true })).toBe(false);
    expect(mustDispatch("thanks", { plan: false })).toBe(false);
  });
  it("forces delegate once at the dispatch step only while solo", () => {
    expect(dispatchToolChoice(DISPATCH_BY_STEP, false, true)).toEqual({ type: "tool", toolName: "delegate" });
    expect(dispatchToolChoice(DISPATCH_BY_STEP, true, true)).toBeUndefined();
    expect(dispatchToolChoice(0, false, true)).toBeUndefined();
    expect(dispatchToolChoice(DISPATCH_BY_STEP, false, false)).toBeUndefined();
  });
});
