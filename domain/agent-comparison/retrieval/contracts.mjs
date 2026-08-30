// Turn P4: schema validator for EmbeddingConfig, self-contained the same
// way domain/agent-comparison/contracts.mjs is (its own Ajv instance,
// Node-only, never imported from app/). Additive and scoped entirely to
// domain/agent-comparison/retrieval/ -- does not modify or import from the
// root contracts.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const EMBEDDING_ADAPTER_KINDS = Object.freeze(["FAKE_DETERMINISTIC", "HTTP_EMBEDDINGS"]);
export const EMBEDDING_CALL_ERROR_CODES = Object.freeze([
  "EMBEDDING_ADAPTER_UNAVAILABLE",
  "EMBEDDING_CALL_TIMEOUT",
  "EMBEDDING_CALL_HTTP_ERROR",
  "EMBEDDING_CALL_MALFORMED_RESPONSE",
  "EMBEDDING_CALL_UNKNOWN_ERROR",
]);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const embeddingConfigSchema = JSON.parse(readFileSync(path.join(HERE, "interfaces/embedding-config.schema.json"), "utf8"));
const embeddingConfigValidator = ajv.compile(embeddingConfigSchema);

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateEmbeddingConfig(value) {
  if (embeddingConfigValidator(value)) return [];
  return toErrorMessages(embeddingConfigValidator);
}

export function isValidEmbeddingConfig(value) {
  return validateEmbeddingConfig(value).length === 0;
}
