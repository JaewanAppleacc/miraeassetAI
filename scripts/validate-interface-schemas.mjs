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

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "PASS", validated_pairs: pairs.length }, null, 2));
