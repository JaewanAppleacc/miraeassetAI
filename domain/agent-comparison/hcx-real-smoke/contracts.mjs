// Turn P11-B: schema validators for this module's own four artifact types.
// Mirrors domain/agent-comparison/contracts.mjs's own pattern exactly
// (compile-once Ajv validators, throw-free validate*() functions returning
// an error-message array). Node-only (compiles Ajv at runtime) -- never
// imported from app/.
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

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

const configValidator = ajv.compile(loadSchema("hcx-real-smoke-config.redacted.schema.json"));
const resultValidator = ajv.compile(loadSchema("hcx-real-smoke-result.schema.json"));
const securityAttestationValidator = ajv.compile(loadSchema("hcx-real-smoke-security-attestation.schema.json"));
const gateStatusValidator = ajv.compile(loadSchema("hcx-real-smoke-gate-status.schema.json"));

export function validateHcxRealSmokeConfig(value) {
  return configValidator(value) ? [] : toErrorMessages(configValidator);
}
export function validateHcxRealSmokeResult(value) {
  return resultValidator(value) ? [] : toErrorMessages(resultValidator);
}
export function validateHcxRealSmokeSecurityAttestation(value) {
  return securityAttestationValidator(value) ? [] : toErrorMessages(securityAttestationValidator);
}
export function validateHcxRealSmokeGateStatus(value) {
  return gateStatusValidator(value) ? [] : toErrorMessages(gateStatusValidator);
}
