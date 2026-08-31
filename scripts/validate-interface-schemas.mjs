#!/usr/bin/env node

import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const pairs = [
  [
    "domain/interfaces/semantic-bundle.schema.json",
    "domain/interfaces/examples/semantic-bundle.example.json",
  ],
  [
    "domain/evaluation/evaluation-gold.v0.2.schema.json",
    "domain/evaluation/example.question.json",
  ],
  [
    "domain/evaluation/evaluation-gold.v0.2.schema.json",
    "domain/evaluation/fixtures/conflicting-evidence.question.json",
  ],
  [
    "domain/retrieval/retrieval-request.schema.json",
    "domain/retrieval/examples/retrieval-request.example.json",
  ],
  [
    "domain/retrieval/retrieval-result.schema.json",
    "domain/retrieval/examples/retrieval-result.example.json",
  ],
  [
    "domain/retrieval/index-snapshot-manifest.schema.json",
    "domain/retrieval/examples/index-snapshot-manifest.example.json",
  ],
  [
    "domain/relations/relation-review-recommendation.schema.json",
    "domain/relations/examples/relation-review-recommendation.example.json",
  ],
  [
    "domain/interfaces/structured-query.schema.json",
    "domain/interfaces/examples/structured-query.example.json",
  ],
  [
    "domain/interfaces/structured-result.schema.json",
    "domain/interfaces/examples/structured-result.example.json",
  ],
  [
    "domain/interfaces/evaluation-usage-event.schema.json",
    "domain/interfaces/examples/evaluation-usage-event.example.json",
  ],
  [
    "domain/interfaces/evaluation-split-lifecycle.schema.json",
    "domain/interfaces/examples/evaluation-split-lifecycle.example.json",
  ],
  [
    "domain/interfaces/final-response.schema.json",
    "domain/interfaces/examples/final-response.example.json",
  ],
  [
    "domain/interfaces/answer-wire-response.schema.json",
    "domain/interfaces/examples/answer-wire-response.example.json",
  ],
  [
    "domain/agent-comparison/interfaces/model-config.schema.json",
    "domain/agent-comparison/interfaces/examples/model-config.example.json",
  ],
  // Turn P11-A: additive HCX_CHAT_COMPLETIONS kind on the same schema.
  [
    "domain/agent-comparison/interfaces/model-config.schema.json",
    "domain/agent-comparison/interfaces/examples/model-config.hcx.example.json",
  ],
  [
    "domain/agent-comparison/interfaces/telemetry-event.schema.json",
    "domain/agent-comparison/interfaces/examples/telemetry-event.example.json",
  ],
  // Turn P11-A: HCX generation adapter manifest (config/security identity,
  // never a raw API key/prompt/response -- see the schema's own header).
  [
    "domain/agent-comparison/interfaces/hcx-generation-manifest.schema.json",
    "domain/agent-comparison/interfaces/examples/hcx-generation-manifest.example.json",
  ],
  [
    "domain/agent-comparison/interfaces/benchmark-run-manifest.schema.json",
    "domain/agent-comparison/interfaces/examples/benchmark-run-manifest.example.json",
  ],
  [
    "domain/agent-comparison/integration/interfaces/comparison-record.schema.json",
    "domain/agent-comparison/integration/interfaces/examples/comparison-record.example.json",
  ],
  [
    "domain/agent-comparison/retrieval/interfaces/embedding-config.schema.json",
    "domain/agent-comparison/retrieval/interfaces/examples/embedding-config.example.json",
  ],
  // Turn P9: provider-neutral Embedding Calibration harness config schema.
  [
    "domain/agent-comparison/embedding-calibration/schemas/calibration-config.schema.json",
    "domain/agent-comparison/embedding-calibration/examples/calibration-config.example.json",
  ],
  // Turn P9.1: Frozen Embedding Candidate (KURE-v1/BGE-M3/PIXIE-Rune) pin schema.
  [
    "domain/agent-comparison/embedding-calibration/frozen-candidates/frozen-embedding-candidate.schema.json",
    "domain/agent-comparison/embedding-calibration/frozen-candidates/frozen-embedding-candidate.example.json",
  ],
  // Turn P6: Benchmark Runner / Gold-blind Scoring Infrastructure schemas.
  [
    "domain/agent-comparison/benchmark/interfaces/dataset-record.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/dataset-record.example.json",
  ],
  [
    "domain/agent-comparison/benchmark/interfaces/dataset-manifest.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/dataset-manifest.example.json",
  ],
  [
    "domain/agent-comparison/benchmark/interfaces/scoring-policy.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/scoring-policy.example.json",
  ],
  [
    "domain/agent-comparison/benchmark/interfaces/benchmark-run-result.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/benchmark-run-result.example.json",
  ],
  [
    "domain/agent-comparison/benchmark/interfaces/benchmark-item-result.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/benchmark-item-result.example.json",
  ],
  // benchmark-comparison-report.schema.json $refs benchmark-run-result's
  // own $id -- must be validated AFTER the benchmark-run-result pair above
  // so this script's shared ajv instance already has that $id registered.
  [
    "domain/agent-comparison/benchmark/interfaces/benchmark-comparison-report.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/benchmark-comparison-report.example.json",
  ],
  // Turn P6.1: additive v0.2 schemas -- dataset provenance honesty fix.
  [
    "domain/agent-comparison/benchmark/interfaces/dataset-manifest.v0.2.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/dataset-manifest.v0.2.example.json",
  ],
  // benchmark-comparison-report.v0.2.schema.json also $refs benchmark-run-result's
  // own $id -- already registered by the pair above.
  [
    "domain/agent-comparison/benchmark/interfaces/benchmark-comparison-report.v0.2.schema.json",
    "domain/agent-comparison/benchmark/interfaces/examples/benchmark-comparison-report.v0.2.example.json",
  ],
];

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const failures = [];
const validators = new Map();

for (const [schemaPath, dataPath] of pairs) {
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  let validate = validators.get(schemaPath);
  if (!validate) {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    validate = ajv.compile(schema);
    validators.set(schemaPath, validate);
  }
  if (!validate(data)) {
    failures.push({ schema: schemaPath, data: dataPath, errors: validate.errors });
    continue;
  }
  const unexpected = structuredClone(data);
  unexpected.__unexpected_field = true;
  if (validate(unexpected)) {
    failures.push({
      schema: schemaPath,
      data: dataPath,
      errors: [{ message: "top-level additionalProperties gate did not reject an unknown field" }],
    });
  }
}

const structuredQuery = JSON.parse(
  readFileSync("domain/interfaces/examples/structured-query.example.json", "utf8"),
);
const structuredQueryValidator = validators.get("domain/interfaces/structured-query.schema.json");
const unverifiedOfficialQuery = structuredClone(structuredQuery);
unverifiedOfficialQuery.verification_statuses = ["CANDIDATE"];
if (structuredQueryValidator(unverifiedOfficialQuery)) {
  failures.push({
    schema: "domain/interfaces/structured-query.schema.json",
    data: "generated OFFICIAL query requesting CANDIDATE data",
    errors: [{ message: "OFFICIAL StructuredQuery accepted non-VERIFIED data" }],
  });
}

const structuredResult = JSON.parse(
  readFileSync("domain/interfaces/examples/structured-result.example.json", "utf8"),
);
const structuredResultValidator = validators.get("domain/interfaces/structured-result.schema.json");
const unverifiedOfficialResult = structuredClone(structuredResult);
unverifiedOfficialResult.records[0].verification_status = "CANDIDATE";
if (structuredResultValidator(unverifiedOfficialResult)) {
  failures.push({
    schema: "domain/interfaces/structured-result.schema.json",
    data: "generated OFFICIAL result containing CANDIDATE data",
    errors: [{ message: "OFFICIAL StructuredResult exposed non-VERIFIED data" }],
  });
}

const answerWireResponseExample = JSON.parse(
  readFileSync("domain/interfaces/examples/answer-wire-response.example.json", "utf8"),
);
const expectedAnswerWireResponseFields = ["question_id", "question", "retrieved_context", "think_trace", "answer"];
const answerWireResponseKeys = Object.keys(answerWireResponseExample).sort();
if (JSON.stringify(answerWireResponseKeys) !== JSON.stringify([...expectedAnswerWireResponseFields].sort())) {
  failures.push({
    schema: "domain/interfaces/answer-wire-response.schema.json",
    data: "domain/interfaces/examples/answer-wire-response.example.json",
    errors: [{ message: `expected exactly the 5 fields ${expectedAnswerWireResponseFields.join(", ")}, got: ${answerWireResponseKeys.join(", ")}` }],
  });
}
for (const field of expectedAnswerWireResponseFields) {
  if (typeof answerWireResponseExample[field] !== "string") {
    failures.push({
      schema: "domain/interfaces/answer-wire-response.schema.json",
      data: "domain/interfaces/examples/answer-wire-response.example.json",
      errors: [{ message: `field "${field}" must be a string, got ${typeof answerWireResponseExample[field]}` }],
    });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "PASS", validated_pairs: pairs.length }, null, 2));
