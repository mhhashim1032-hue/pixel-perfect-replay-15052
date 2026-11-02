import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { evaluateSuite, type EvaluationCase, type EvaluationObservation } from "../src/lib/engine/evaluation";

const caseSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(["critical", "major", "minor"]),
  objective: z.string().min(1),
  expected: z.string().min(1),
  forbidden: z.array(z.string()),
  assertions: z.array(z.string()).min(1),
});
const observationSchema = z.object({
  caseId: z.string().min(1),
  passed: z.boolean(),
  scores: z.object({
    objective: z.number().min(0).max(100).optional(),
    correctness: z.number().min(0).max(100).optional(),
    toolValidity: z.number().min(0).max(100).optional(),
    verification: z.number().min(0).max(100).optional(),
    recovery: z.number().min(0).max(100).optional(),
    security: z.number().min(0).max(100).optional(),
    efficiency: z.number().min(0).max(100).optional(),
    communication: z.number().min(0).max(100).optional(),
  }),
  evidence: z.array(z.string().max(500)).max(20),
  forbiddenObserved: z.array(z.string().max(300)).max(20).optional(),
});
const observationFileSchema = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  modelRevision: z.string().min(1).max(160),
  datasetRevision: z.string().min(1).max(160),
  observations: z.array(observationSchema),
});
const args = process.argv.slice(2);

async function main() {
  const casePath = new URL("../UAF/evaluations/cases.json", import.meta.url);
  const rawCases: unknown = JSON.parse(await readFile(casePath, "utf8"));
  const definitions = z.array(caseSchema).min(10).parse(rawCases) as EvaluationCase[];
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error("Duplicate evaluation case ID: " + definition.id);
    ids.add(definition.id);
  }

  const observationIndex = args.indexOf("--observations");
  if (observationIndex < 0) {
    console.log(JSON.stringify({
      catalog: "valid",
      cases: definitions.length,
      criticalCases: definitions.filter((item) => item.severity === "critical").length,
      modelCalls: 0,
      message: "Catalog validation only. No model evaluation was executed; pass --observations <file> to score a real run.",
    }, null, 2));
    return;
  }

  const observationsPath = args[observationIndex + 1];
  if (!observationsPath) throw new Error("--observations requires a JSON file path.");
  const minimumIndex = args.indexOf("--minimum-score");
  const minimumScore = minimumIndex >= 0 ? Number(args[minimumIndex + 1]) : 90;
  const rawObservations: unknown = JSON.parse(await readFile(resolve(observationsPath), "utf8"));
  const evaluationFile = observationFileSchema.parse(rawObservations);
  const observations = evaluationFile.observations as EvaluationObservation[];
  const report = evaluateSuite(definitions, observations, minimumScore);
  console.log(JSON.stringify({
    provider: evaluationFile.provider,
    model: evaluationFile.model,
    modelRevision: evaluationFile.modelRevision,
    datasetRevision: evaluationFile.datasetRevision,
    ...report,
  }, null, 2));
  if (!report.releaseEligible) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 2;
});
