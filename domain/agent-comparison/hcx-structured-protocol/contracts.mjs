// Turn P11-D: schema validator for this module's own single report artifact.
// Mirrors hcx-real-smoke/contracts.mjs's pattern exactly (compile-once Ajv
// validator, throw-free validate*() function returning an error-message
// array). Node-only (compiles Ajv at runtime) -- never imported from app/.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTERFACES_DIR = path.join(HERE, "interfaces");

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const reportValidator = ajv.compile(JSON.parse(readFileSync(path.join(INTERFACES_DIR, "hcx-structured-protocol-comparison-report.schema.json"), "utf8")));

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateComparisonReport(value) {
  return reportValidator(value) ? [] : toErrorMessages(reportValidator);
}
