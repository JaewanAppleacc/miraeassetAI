// Turn P9: provider-neutral, Gold-blind Embedding Calibration contracts.
// Mirrors ../retrieval/contracts.mjs's own self-contained-Ajv-instance
// pattern exactly. This file validates CalibrationConfig ONLY -- it never
// validates or constructs an EmbeddingConfig itself (see
// toEmbeddingConfig() below, which is a pure, lossless field mapping onto
// the ALREADY-EXISTING, UNCHANGED ../retrieval/embedding-adapter.mjs
// contract -- this Turn adds a budget/safety/authorization layer on top of
// that contract, never a second competing one).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CALIBRATION_ADAPTER_KINDS = Object.freeze(["FAKE_DETERMINISTIC", "HTTP_EMBEDDINGS"]);
export const RETRYABLE_EMBEDDING_CALL_ERROR_CODES = Object.freeze([
  "EMBEDDING_CALL_TIMEOUT", "EMBEDDING_CALL_HTTP_ERROR", "EMBEDDING_CALL_UNKNOWN_ERROR",
]);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const calibrationConfigSchema = JSON.parse(readFileSync(path.join(HERE, "schemas/calibration-config.schema.json"), "utf8"));
const calibrationConfigValidator = ajv.compile(calibrationConfigSchema);

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateCalibrationConfig(value) {
  if (calibrationConfigValidator(value)) return [];
  return toErrorMessages(calibrationConfigValidator);
}

export function isValidCalibrationConfig(value) {
  return validateCalibrationConfig(value).length === 0;
}

export class InvalidCalibrationConfigError extends Error {
  constructor(errors) {
    super(`invalid CalibrationConfig: ${errors.join("; ")}`);
    this.name = "InvalidCalibrationConfigError";
    this.errors = errors;
  }
}

// Thrown BEFORE any embedding call is issued, whenever a hard budget
// (maximum_item_count/maximum_request_count/maximum_total_input_units)
// would be exceeded by the work about to be attempted. Never thrown
// retroactively after a call already happened.
export class CalibrationBudgetExceededError extends Error {
  constructor(budgetName, { limit, wouldBe } = {}) {
    super(`calibration budget exceeded: ${budgetName} (limit=${limit}, would be=${wouldBe})`);
    this.name = "CalibrationBudgetExceededError";
    this.code = "CALIBRATION_BUDGET_EXCEEDED";
    this.budgetName = budgetName;
  }
}

// Thrown whenever adapter_kind=HTTP_EMBEDDINGS and
// actual_external_call_authorized !== true -- the ONLY gate a real network
// call must pass. Never thrown for FAKE_DETERMINISTIC (which never makes a
// network call regardless of this flag).
export class CalibrationAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalibrationAuthorizationError";
    this.code = "CALIBRATION_EXTERNAL_CALL_NOT_AUTHORIZED";
  }
}

// Wraps any EmbeddingCallError/EmbeddingAdapterUnavailableError the
// underlying adapter throws, WITHOUT ever copying the wrapped error's own
// `.message` verbatim into this error's message when that message could
// contain response-derived content -- callers needing the original still
// get it via `.cause`, but nothing here re-logs `.cause.message` itself.
export class CalibrationAdapterError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = "CalibrationAdapterError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// Lossless projection of the fields createEmbeddingAdapter's own
// EmbeddingConfig schema requires -- calibration_id/budgets/policies never
// leak into it, and it never invents a provider/model/endpoint calibration
// itself did not receive as config.
export function toEmbeddingConfig(calibrationConfig) {
  const base = {
    schema_version: "0.1.0",
    kind: calibrationConfig.adapter_kind,
    provider: calibrationConfig.provider_id,
    model: calibrationConfig.model_id,
    revision: calibrationConfig.code_revision,
    dimension: calibrationConfig.expected_dimension,
    timeout_ms: calibrationConfig.request_timeout_ms,
  };
  if (calibrationConfig.adapter_kind === "HTTP_EMBEDDINGS") {
    const httpConfig = { ...base, endpoint_url: calibrationConfig.endpoint };
    // Turn P9.2: auth_mode/network_scope pass through only when present --
    // an OLD CalibrationConfig that never set them produces the EXACT same
    // EmbeddingConfig shape as before (api_key_env_var only, no auth_mode
    // key at all), so embedding-adapter.mjs's own "absent means BEARER_ENV"
    // default applies identically either way.
    if (calibrationConfig.auth_mode !== undefined) httpConfig.auth_mode = calibrationConfig.auth_mode;
    if (calibrationConfig.network_scope !== undefined) httpConfig.network_scope = calibrationConfig.network_scope;
    if (calibrationConfig.auth_mode !== "NONE") httpConfig.api_key_env_var = calibrationConfig.api_key_env_var;
    return httpConfig;
  }
  return base;
}
