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

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "PASS", validated_pairs: pairs.length }, null, 2));
