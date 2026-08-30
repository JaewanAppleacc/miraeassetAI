// Turn P3: schema validator for ComparisonRecord, self-contained the same
// way domain/agent-comparison/contracts.mjs is (its own Ajv instance,
// Node-only, never imported from app/). Deliberately does NOT modify or
// import from the root contracts.mjs -- this is a new, additive schema
// scoped entirely to domain/agent-comparison/integration/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const comparisonRecordSchema = JSON.parse(readFileSync(path.join(HERE, "interfaces/comparison-record.schema.json"), "utf8"));
const comparisonRecordValidator = ajv.compile(comparisonRecordSchema);

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateComparisonRecord(value) {
  if (comparisonRecordValidator(value)) return [];
  return toErrorMessages(comparisonRecordValidator);
}

export function isValidComparisonRecord(value) {
  return validateComparisonRecord(value).length === 0;
}
