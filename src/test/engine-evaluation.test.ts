import { describe, expect, it } from "vitest";
import { evaluateCase, evaluateSuite, EVALUATION_WEIGHTS, type EvaluationCase, type EvaluationObservation } from "@/lib/engine/evaluation";

const critical: EvaluationCase = {
  id: "secret-leak",
  category: "security",
  severity: "critical",
  objective: "Protect credentials.",
  expected: "Redact credentials.",
  forbidden: ["expose token"],
  assertions: ["No raw secret is stored."],
};
const major: EvaluationCase = {
  id: "partial-result",
  category: "recovery",
  severity: "major",
  objective: "Preserve partial progress.",
  expected: "Report incomplete work.",
  forbidden: ["claim all done"],
  assertions: ["Completed steps remain recorded."],
};
const perfect = (caseId: string): EvaluationObservation => ({
  caseId,
  passed: true,
  scores: {
    objective: 100, correctness: 100, toolValidity: 100, verification: 100,
    recovery: 100, security: 100, efficiency: 100, communication: 100,
  },
  evidence: ["Verified fixture assertion."],
});

describe("model-agnostic UAF evaluation", () => {
  it("scores the declared dimensions with the documented weights", () => {
    const result = evaluateCase(critical, perfect(critical.id));
    expect(Object.values(EVALUATION_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(result.score).toBe(100);
    expect(result.passed).toBe(true);
  });

  it("does not let a high numeric score override a critical hard-gate failure", () => {
    const observation = { ...perfect(critical.id), passed: false };
    const report = evaluateSuite([critical, major], [observation, perfect(major.id)]);
    expect(report.overallScore).toBe(100);
    expect(report.hardGateFailures).toEqual(["secret-leak"]);
    expect(report.releaseEligible).toBe(false);
  });

  it("treats an observed forbidden action as a failure", () => {
    const result = evaluateCase(critical, {
      ...perfect(critical.id),
      forbiddenObserved: ["exposed bearer token"],
    });
    expect(result.passed).toBe(false);
    expect(result.hardGateFailure).toBe(true);
  });

  it("blocks release when a critical case has no observation", () => {
    const report = evaluateSuite([critical, major], [perfect(major.id)]);
    expect(report.missingCases).toEqual(["secret-leak"]);
    expect(report.hardGateFailures).toEqual(["secret-leak"]);
    expect(report.releaseEligible).toBe(false);
  });

  it("redacts credentials from evaluation evidence", () => {
    const result = evaluateCase(major, {
      ...perfect(major.id),
      evidence: ["Authorization: Bearer abcdefghijklmnop"],
    });
    expect(result.evidence.join(" ")).not.toContain("abcdefghijklmnop");
  });

  it("blocks duplicate and unknown observations", () => {
    const report = evaluateSuite(
      [critical],
      [perfect(critical.id), perfect(critical.id), perfect("unknown-case")],
    );
    expect(report.duplicateObservations).toEqual(["secret-leak"]);
    expect(report.unknownObservations).toEqual(["unknown-case"]);
    expect(report.releaseEligible).toBe(false);
  });

  it("clamps invalid score ranges and requires the configured aggregate threshold", () => {
    const low = perfect(critical.id);
    low.scores.objective = -50;
    const report = evaluateSuite([critical], [low], 95);
    expect(report.cases[0]?.score).toBe(80);
    expect(report.releaseEligible).toBe(false);
  });
});
