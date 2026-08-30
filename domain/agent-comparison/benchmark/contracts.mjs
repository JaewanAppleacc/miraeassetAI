// Turn P6: schema validators for the Benchmark Runner / Gold-blind Scoring
// Infrastructure's own new schemas. Self-contained the same way
// domain/agent-comparison/integration/contracts.mjs is (its own Ajv
// instance, Node-only, never imported from app/) -- deliberately does NOT
// modify or import from the root domain/contracts.mjs or
// domain/agent-comparison/contracts.mjs. This is a new, additive schema set
// scoped entirely to domain/agent-comparison/benchmark/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTERFACES_DIR = path.join(HERE, "interfaces");

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

function loadSchema(fileName) {
  return JSON.parse(readFileSync(path.join(INTERFACES_DIR, fileName), "utf8"));
}

// Compile order matters: benchmark-comparison-report.schema.json $refs
// benchmark-run-result.schema.json by its $id, so the run-result schema
// must be compiled (which registers its $id on this ajv instance) before
// the comparison-report schema is compiled.
const datasetRecordValidator = ajv.compile(loadSchema("dataset-record.schema.json"));
const datasetManifestValidator = ajv.compile(loadSchema("dataset-manifest.schema.json"));
const scoringPolicyValidator = ajv.compile(loadSchema("scoring-policy.schema.json"));
const benchmarkItemResultValidator = ajv.compile(loadSchema("benchmark-item-result.schema.json"));
const benchmarkRunResultValidator = ajv.compile(loadSchema("benchmark-run-result.schema.json"));
const benchmarkComparisonReportValidator = ajv.compile(loadSchema("benchmark-comparison-report.schema.json"));
// Turn P6.1: additive v0.2 schemas -- dataset-manifest.v0.2 has its own
// $id (distinct from v0.1's), and benchmark-comparison-report.v0.2 $refs
// benchmark-run-result's $id, already registered by the compile above.
const datasetManifestV0_2Validator = ajv.compile(loadSchema("dataset-manifest.v0.2.schema.json"));
const benchmarkComparisonReportV0_2Validator = ajv.compile(loadSchema("benchmark-comparison-report.v0.2.schema.json"));

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateDatasetRecord(value) {
  if (datasetRecordValidator(value)) return [];
  return toErrorMessages(datasetRecordValidator);
}

export function validateDatasetManifest(value) {
  if (datasetManifestValidator(value)) return [];
  return toErrorMessages(datasetManifestValidator);
}

export function validateScoringPolicy(value) {
  if (scoringPolicyValidator(value)) return [];
  return toErrorMessages(scoringPolicyValidator);
}

export function validateBenchmarkItemResult(value) {
  if (benchmarkItemResultValidator(value)) return [];
  return toErrorMessages(benchmarkItemResultValidator);
}

export function validateBenchmarkRunResult(value) {
  if (benchmarkRunResultValidator(value)) return [];
  return toErrorMessages(benchmarkRunResultValidator);
}

export function validateBenchmarkComparisonReport(value) {
  if (benchmarkComparisonReportValidator(value)) return [];
  return toErrorMessages(benchmarkComparisonReportValidator);
}

export function validateDatasetManifestV0_2(value) {
  if (datasetManifestV0_2Validator(value)) return [];
  return toErrorMessages(datasetManifestV0_2Validator);
}

export function validateBenchmarkComparisonReportV0_2(value) {
  if (benchmarkComparisonReportV0_2Validator(value)) return [];
  return toErrorMessages(benchmarkComparisonReportV0_2Validator);
}

export const OUTCOME_CATEGORIES = Object.freeze([
  "NORMAL_ANSWER",
  "NORMAL_INFORMATION_LIMIT",
  "MODEL_NOT_ATTEMPTED_INFORMATION_LIMIT",
  "MODEL_CALL_FAILURE_FALLBACK",
  "POST_HOC_CLAIM_VALIDATION_FAILURE_FALLBACK",
  "AGENT_VARIANT_EXECUTION_FAILURE",
  "TIMEOUT",
  "ABORTED",
  "BUDGET_EXCEEDED",
  "DATASET_CONTRACT_FAILURE",
]);

export const SCORING_AXES = Object.freeze([
  "answerability",
  "numeric_claim",
  "date_claim",
  "fact_coverage",
  "event_relation",
  "citation",
  "style",
  "operational",
]);
