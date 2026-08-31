// Turn P9.1: Frozen Embedding Candidate registry (CLAUDE.md "Frozen v1.1" --
// KURE-v1 / BGE-M3 / PIXIE-Rune). Purely DATA-DRIVEN: every function here
// reads fields off a registry entry generically -- nothing in this file (or
// in runner.mjs, which this module never modifies) branches on a specific
// frozen_candidate_id/model name. Adding a 4th future candidate never
// requires an if/switch here, only a new registry.json entry that passes
// the same schema + invariants.
//
// THIS TURN NEVER: downloads a model, calls a real embedding API, or
// selects a "winning" candidate. See toCalibrationConfig()'s own
// authorization gate for the one rule this whole module exists to enforce:
// a non-ELIGIBLE_FOR_BOUNDED_CALIBRATION candidate can NEVER have
// actual_external_call_authorized forced to true through this path,
// regardless of what a caller asks for.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

const candidateSchema = JSON.parse(readFileSync(path.join(HERE, "frozen-embedding-candidate.schema.json"), "utf8"));
const candidateValidator = ajv.compile(candidateSchema);

const REGISTRY_PATH = path.join(HERE, "frozen-embedding-candidates.v1.1.json");
const ELIGIBLE_STATUS = "ELIGIBLE_FOR_BOUNDED_CALIBRATION";

export class FrozenCandidateRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FrozenCandidateRegistryError";
    this.code = code ?? "FROZEN_CANDIDATE_REGISTRY_ERROR";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function assertRegistryInvariants(registry) {
  const candidates = registry?.candidates;
  if (!Array.isArray(candidates)) throw new FrozenCandidateRegistryError("registry.candidates must be an array", "MALFORMED_REGISTRY");
  if (candidates.length !== 3) {
    throw new FrozenCandidateRegistryError(`registry must contain exactly 3 frozen candidates, found ${candidates.length}`, "WRONG_CANDIDATE_COUNT");
  }
  for (const candidate of candidates) {
    if (!candidateValidator(candidate)) {
      const errors = (candidateValidator.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
      throw new FrozenCandidateRegistryError(`candidate "${candidate?.frozen_candidate_id}" failed schema validation: ${errors.join("; ")}`, "INVALID_CANDIDATE");
    }
  }
  for (const field of ["frozen_candidate_id", "repository_id", "immutable_revision"]) {
    const values = candidates.map((c) => c[field]).filter((v) => v !== null && v !== undefined && v !== "BLOCKED_MISSING_IMMUTABLE_REVISION");
    if (new Set(values).size !== values.length) {
      throw new FrozenCandidateRegistryError(`duplicate ${field} found among candidates -- every real (non-null, non-blocked) value must be unique`, "DUPLICATE_CANDIDATE_FIELD");
    }
  }
}

let cachedRegistry = null;

// Loads, schema-validates, and invariant-checks the registry. Cached after
// the first successful load (the file is static within a process).
export function loadFrozenCandidateRegistry({ forceReload = false } = {}) {
  if (cachedRegistry && !forceReload) return cachedRegistry;
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  assertRegistryInvariants(raw);
  cachedRegistry = Object.freeze(raw);
  return cachedRegistry;
}

export function listFrozenCandidates() {
  return loadFrozenCandidateRegistry().candidates;
}

export function getFrozenCandidateById(frozenCandidateId) {
  const candidate = listFrozenCandidates().find((c) => c.frozen_candidate_id === frozenCandidateId);
  if (!candidate) throw new FrozenCandidateRegistryError(`unknown frozen_candidate_id: ${frozenCandidateId}`, "UNKNOWN_CANDIDATE");
  return candidate;
}

// Sensitive to content changes in the registry JSON -- editing any field of
// any candidate (or adding/removing one) changes this hash. NOT sorted by
// candidate id before hashing is unnecessary here since candidates is
// already a fixed-order array in one file (unlike dataset.mjs's
// runtime-assembled item list) -- canonicalize() still sorts each object's
// own KEYS so unrelated key-ordering edits in the JSON file never spuriously
// change the hash.
export function computeFrozenCandidateRegistrySha256(registry = loadFrozenCandidateRegistry()) {
  return sha256Hex(registry);
}

// Applies the candidate's own query_prefix/document_prefix (verbatim,
// exactly as researched from the official source -- never inferred). A
// candidate whose query_prefix and document_prefix are IDENTICAL strings
// (including both empty) legitimately embeds the same text the same way
// regardless of mode; a candidate whose prefixes DIFFER must never be
// called with the wrong mode's prefix, which is exactly what this single
// chokepoint function exists to make impossible to get backwards.
export function prepareTextForMode(candidate, text, mode) {
  if (mode !== "query" && mode !== "document") throw new TypeError('mode must be "query" or "document"');
  if (typeof text !== "string" || text === "") throw new TypeError("text is required");
  const prefix = mode === "query" ? candidate.query_prefix : candidate.document_prefix;
  if (typeof prefix !== "string") {
    throw new FrozenCandidateRegistryError(
      `frozen candidate "${candidate.frozen_candidate_id}": ${mode}_prefix is not a verified string (competition_status=${candidate.competition_status}) -- refusing to guess a prefix for text preparation`,
      "PREFIX_NOT_VERIFIED",
    );
  }
  return `${prefix}${text}`;
}

// The ONLY place a frozen candidate's authorization may be decided.
// actual_external_call_authorized is NEVER settable to true by a caller
// argument when the candidate's own competition_status is not exactly
// ELIGIBLE_FOR_BOUNDED_CALIBRATION -- callerAuthorization is ANDed against
// this gate, never OR'd, so no argument combination can bypass it.
export function toCalibrationConfig(candidate, {
  datasetManifestSha256, sampleSalt, codeRevision, maximumItemCount, maximumRequestCount,
  maximumTotalInputUnits, batchSize = 20, requestTimeoutMs = 30000, apiKeyEnvVar, endpointOverride,
  inputPricePerMillionUnits = null, callerRequestsAuthorization = false,
} = {}) {
  if (typeof candidate.immutable_revision !== "string" || !/^[0-9a-f]{40}$/.test(candidate.immutable_revision)) {
    throw new FrozenCandidateRegistryError(
      `frozen candidate "${candidate.frozen_candidate_id}": no verified immutable_revision -- refusing to authorize a run against an unpinned/unresolved model identity`,
      "MISSING_REVISION",
    );
  }
  if (!Number.isInteger(candidate.embedding_dimension) || candidate.embedding_dimension < 1) {
    throw new FrozenCandidateRegistryError(
      `frozen candidate "${candidate.frozen_candidate_id}": no verified embedding_dimension -- refusing to authorize a run`,
      "MISSING_DIMENSION",
    );
  }
  if (typeof candidate.repository_id !== "string" || candidate.repository_id === "") {
    throw new FrozenCandidateRegistryError(
      `frozen candidate "${candidate.frozen_candidate_id}": repository_id is unresolved (competition_status=${candidate.competition_status}) -- refusing to build a runnable config for an unverified model identity`,
      "UNVERIFIED_MODEL_ID",
    );
  }

  const isEligible = candidate.competition_status === ELIGIBLE_STATUS;
  const authorized = isEligible && callerRequestsAuthorization === true;

  const httpEndpointResolvable = candidate.adapter_compatibility.classification === "EXISTING_HTTP_EMBEDDINGS_COMPATIBLE"
    || candidate.adapter_compatibility.classification === "COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER";
  const adapterKind = httpEndpointResolvable ? "HTTP_EMBEDDINGS" : "FAKE_DETERMINISTIC";

  const modelIdWithRevision = `${candidate.repository_id}@${candidate.immutable_revision}`; // model revision folded into model_id -- always present in any run manifest built from this config, per this Turn's own invariant.

  const config = {
    schema_version: "0.1.0",
    calibration_id: `calibration_${candidate.frozen_candidate_id}_v01`,
    adapter_kind: adapterKind,
    provider_id: candidate.provider_organization,
    model_id: modelIdWithRevision,
    endpoint: endpointOverride ?? (adapterKind === "HTTP_EMBEDDINGS" ? "http://localhost:8080/v1/embeddings" : "unused-for-fake-deterministic"),
    expected_dimension: candidate.embedding_dimension,
    batch_size: batchSize,
    request_timeout_ms: requestTimeoutMs,
    maximum_item_count: maximumItemCount,
    maximum_request_count: maximumRequestCount,
    maximum_total_input_units: maximumTotalInputUnits,
    sample_salt: sampleSalt,
    dataset_manifest_sha256: datasetManifestSha256,
    code_revision: codeRevision,
    cache_policy: { enabled: true },
    retry_policy: { max_attempts_per_request: 1, retryable_error_codes: [], backoff_ms: 0 },
    input_price_per_million_units: inputPricePerMillionUnits,
    actual_external_call_authorized: authorized,
  };
  if (adapterKind === "HTTP_EMBEDDINGS") config.api_key_env_var = apiKeyEnvVar ?? "FROZEN_CANDIDATE_UNUSED_KEY_ENV_VAR";
  return Object.freeze(config);
}
