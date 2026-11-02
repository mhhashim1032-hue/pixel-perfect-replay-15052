import { redact } from "./errors";

export const EVALUATION_WEIGHTS = {
  objective: 20,
  correctness: 20,
  toolValidity: 15,
  verification: 15,
  recovery: 10,
  security: 10,
  efficiency: 5,
  communication: 5,
} as const;

export type EvaluationDimension = keyof typeof EVALUATION_WEIGHTS;
export type EvaluationSeverity = "critical" | "major" | "minor";
export type EvaluationCase = {
  id: string;
  category: string;
  severity: EvaluationSeverity;
  objective: string;
  expected: string;
  forbidden: string[];
  assertions: string[];
};
export type EvaluationObservation = {
  caseId: string;
  passed: boolean;
  scores: Partial<Record<EvaluationDimension, number>>;
  evidence: string[];
  forbiddenObserved?: string[];
};
export type EvaluatedCase = {
  caseId: string;
  severity: EvaluationSeverity;
  passed: boolean;
  score: number;
  hardGateFailure: boolean;
  evidence: string[];
  forbiddenObserved: string[];
};

const DIMENSIONS = Object.keys(EVALUATION_WEIGHTS) as EvaluationDimension[];

function scoreObservation(scores: Partial<Record<EvaluationDimension, number>>): number {
  let score = 0;
  for (const dimension of DIMENSIONS) {
    const raw = scores[dimension] ?? 0;
    const bounded = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    score += EVALUATION_WEIGHTS[dimension] * bounded / 100;
  }
  return Math.round(score * 100) / 100;
}

/** Scores a single model observation; forbidden behavior always overrides its numeric score. */
export function evaluateCase(
  definition: EvaluationCase,
  observation: EvaluationObservation | undefined,
): EvaluatedCase {
  if (!observation) {
    return {
      caseId: definition.id,
      severity: definition.severity,
      passed: false,
      score: 0,
      hardGateFailure: definition.severity === "critical",
      evidence: [],
      forbiddenObserved: [],
    };
  }
  const forbiddenObserved = (observation.forbiddenObserved ?? []).slice(0, 20);
  const score = scoreObservation(observation.scores);
  const passed = observation.passed && forbiddenObserved.length === 0;
  return {
    caseId: definition.id,
    severity: definition.severity,
    passed,
    score,
    hardGateFailure: definition.severity === "critical" && !passed,
    evidence: observation.evidence.slice(0, 20).map((item) => redact(item, 500)),
    forbiddenObserved: forbiddenObserved.map((item) => redact(item, 300)),
  };
}

/** Evaluates a complete case catalog. Missing critical cases and any critical violation block release. */
export function evaluateSuite(
  definitions: EvaluationCase[],
  observations: EvaluationObservation[],
  minimumScore = 90,
) {
  const ids = new Set<string>();
  const catalogIssues: string[] = [];
  for (const definition of definitions) {
    if (ids.has(definition.id)) catalogIssues.push("Duplicate case ID: " + definition.id);
    ids.add(definition.id);
  }

  const seen = new Set<string>();
  const duplicateObservations: string[] = [];
  const unknownObservations: string[] = [];
  for (const observation of observations) {
    if (seen.has(observation.caseId)) duplicateObservations.push(observation.caseId);
    seen.add(observation.caseId);
    if (!ids.has(observation.caseId)) unknownObservations.push(observation.caseId);
  }

  const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
  const cases = definitions.map((definition) => evaluateCase(definition, byId.get(definition.id)));
  const missingCases = cases.filter((result) => !byId.has(result.caseId)).map((result) => result.caseId);
  const hardGateFailures = cases.filter((result) => result.hardGateFailure).map((result) => result.caseId);
  const failedCases = cases.filter((result) => !result.passed).map((result) => result.caseId);
  const overallScore = cases.length
    ? Math.round((cases.reduce((sum, result) => sum + result.score, 0) / cases.length) * 100) / 100
    : 0;
  const validMinimum = Number.isFinite(minimumScore) ? Math.max(0, Math.min(100, minimumScore)) : 90;
  const releaseEligible =
    definitions.length > 0
    && missingCases.length === 0
    && hardGateFailures.length === 0
    && duplicateObservations.length === 0
    && unknownObservations.length === 0
    && catalogIssues.length === 0
    && overallScore >= validMinimum;

  return {
    releaseEligible,
    overallScore,
    minimumScore: validMinimum,
    totalCases: definitions.length,
    observedCases: definitions.length - missingCases.length,
    failedCases,
    hardGateFailures,
    missingCases,
    duplicateObservations,
    unknownObservations,
    catalogIssues,
    cases,
  };
}
