// Common experiment contract for cross-Agent / cross-model comparison
// (Turn P1, hardened Turn P1.1). This module is Node-only (compiles Ajv at
// runtime) -- it is never imported from app/ (the Cloudflare Worker
// runtime), only from scripts/ and tests/, exactly like
// scripts/validate-interface-schemas.mjs already does. It does not
// replace, extend, or import from domain/generated/runtime-schema-validators.mjs,
// which stays pinned to the frozen v0.1/v0.2 schemas listed in CLAUDE.md
// section 4.
//
// Everything here is ADDITIVE to the existing frozen contracts (CLAUDE.md
// section 4-7): AgentInput, FinalResponse, StructuredQuery/StructuredResult,
// and the AgentFlow/SharedServices/runAgentFlow Runtime Host
// (domain/runtime/agent-runtime.mjs) are reused as-is, unmodified, by every
// Agent variant built under domain/agent-comparison/. This module only adds
// the two things that did not exist yet: (1) a variant identity registry so
// "which Agent design" and "which base LLM" can be pinned and varied
// independently, and (2) schema-validated shapes for the new
// model-config/telemetry-event/benchmark-run-manifest records.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INTERFACES_DIR = path.join(HERE, "interfaces");

// The four Turn P1-planned Agent designs (CLAUDE.md's "Agent 설계 차이"
// axis). Only STRUCTURED_FIRST has a real implementation this Turn --
// domain/agent-comparison/flows/structured-first-agent.mjs. The other
// three are reserved identifiers so future workers register against a
// name this contract already recognizes, instead of inventing their own
// spelling (see domain/agent-comparison/IMPLEMENTATION_GUIDE.md).
export const AGENT_VARIANT_IDS = Object.freeze([
  "STRUCTURED_FIRST",
  "HYBRID_RETRIEVAL",
  "PLANNER",
  "DOCUMENT_FIRST_RAG",
]);

// Turn P11-A: HCX_CHAT_COMPLETIONS added -- HyperCLOVA X's own distinct
// request/response envelope, never routed through the generic
// HTTP_CHAT_COMPLETIONS branch (see model-adapter.mjs / hcx-model-adapter.mjs).
// Turn P11-E: HCX_NATIVE_V3_FUNCTION_CALLING added -- the official,
// registered adapter for the protocol P11-D's real-API comparison selected
// (see model-adapter.mjs / hcx-native-function-calling-adapter.mjs). Never
// routed through HCX_CHAT_COMPLETIONS's own plain-content-JSON branch.
export const MODEL_ADAPTER_KINDS = Object.freeze([
  "FAKE_DETERMINISTIC", "HTTP_CHAT_COMPLETIONS", "HCX_CHAT_COMPLETIONS", "HCX_NATIVE_V3_FUNCTION_CALLING",
]);

// Turn P1.1: the closed set of citation_binding_status values a
// TelemetryEvent may carry -- PASS (a model-generated answer's citations
// and hard claims were checked and all grounded), FAIL (checked and at
// least one was not grounded -- the generated answer was discarded),
// NOT_CHECKED (no model-generated text existed to check at all, either
// because no model call was attempted or because the call itself failed
// before producing text).
export const CITATION_BINDING_STATUSES = Object.freeze(["PASS", "FAIL", "NOT_CHECKED"]);

// Turn P1.1: stable, non-leaking failure codes a ModelAdapter.generate()
// call can fail with (see model-adapter.mjs). Never derived from a raw
// provider error message or response body -- see that file's own header
// comment on why.
export const MODEL_CALL_ERROR_CODES = Object.freeze([
  "MODEL_ADAPTER_UNAVAILABLE",
  "MODEL_CALL_TIMEOUT",
  "MODEL_CALL_HTTP_ERROR",
  "MODEL_CALL_MALFORMED_RESPONSE",
  "MODEL_CALL_UNKNOWN_ERROR",
]);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

function loadSchema(fileName) {
  return JSON.parse(readFileSync(path.join(INTERFACES_DIR, fileName), "utf8"));
}

const modelConfigValidator = ajv.compile(loadSchema("model-config.schema.json"));
const telemetryEventValidator = ajv.compile(loadSchema("telemetry-event.schema.json"));
const benchmarkRunManifestValidator = ajv.compile(loadSchema("benchmark-run-manifest.schema.json"));
// Turn P11-A: see hcx-generation-manifest.schema.json's own header for why
// this is a separate artifact from TelemetryEvent/BenchmarkRunManifest.
const hcxGenerationManifestValidator = ajv.compile(loadSchema("hcx-generation-manifest.schema.json"));

function toErrorMessages(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

export function validateModelConfig(value) {
  if (modelConfigValidator(value)) return [];
  return toErrorMessages(modelConfigValidator);
}

export function validateTelemetryEvent(value) {
  if (telemetryEventValidator(value)) return [];
  return toErrorMessages(telemetryEventValidator);
}

export function validateBenchmarkRunManifest(value) {
  if (benchmarkRunManifestValidator(value)) return [];
  return toErrorMessages(benchmarkRunManifestValidator);
}

export function validateHcxGenerationManifest(value) {
  if (hcxGenerationManifestValidator(value)) return [];
  return toErrorMessages(hcxGenerationManifestValidator);
}

export function isValidModelConfig(value) {
  return validateModelConfig(value).length === 0;
}

export function isValidTelemetryEvent(value) {
  return validateTelemetryEvent(value).length === 0;
}

export function isValidBenchmarkRunManifest(value) {
  return validateBenchmarkRunManifest(value).length === 0;
}

export function isValidHcxGenerationManifest(value) {
  return validateHcxGenerationManifest(value).length === 0;
}

export class InvalidAgentVariantIdError extends Error {
  constructor(variantId) {
    super(`unknown agent_variant_id: ${JSON.stringify(variantId)} (expected one of ${AGENT_VARIANT_IDS.join(", ")})`);
    this.name = "InvalidAgentVariantIdError";
  }
}

export function assertKnownAgentVariantId(variantId) {
  if (!AGENT_VARIANT_IDS.includes(variantId)) throw new InvalidAgentVariantIdError(variantId);
  return variantId;
}
