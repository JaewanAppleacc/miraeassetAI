// Turn P9: assembles the four calibration output documents (run manifest,
// dataset manifest, result, gate status). Every builder here is a PURE
// projection of already-computed, already-safe values (dataset.mjs's
// manifest items carry no raw text; runner.mjs's result carries no raw
// vectors/response/API key) -- this file never reaches back into a
// CalibrationConfig's api_key_env_var VALUE (only ever the env var NAME,
// which is itself config, not a secret) or into any dataset item's
// textContent field.
import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

// Hashes ONLY the two prefix strings -- never the raw dataset text they get
// applied to. Two candidates with the identical (query_prefix,
// document_prefix) pair share the same prefix_policy_sha256 by design (the
// POLICY is identical even if the models differ).
export function computePrefixPolicySha256({ queryPrefix, documentPrefix }) {
  return createHash("sha256").update(JSON.stringify(canonicalize({ query_prefix: queryPrefix, document_prefix: documentPrefix })), "utf8").digest("hex");
}

// `frozenCandidate` (Turn P9.2, optional -- omitting it reproduces the
// exact Turn P9.1 manifest shape byte-for-byte): when a run was built from
// registry.mjs's toCalibrationConfig, passing the SAME candidate object
// here folds in the identity/prefix/server-attestation pins this Turn's
// own invariant requires -- "동일 모델명이라도 revision이 다르면 다른 run으로
// 취급한다" holds structurally because immutable_revision is ALREADY part
// of calibrationConfig.model_id (see registry.mjs) and is repeated here
// verbatim for a human-readable manifest field too.
export function buildCalibrationRunManifest({ calibrationConfig, datasetManifest, codeRevision, frozenCandidate, registrySha256, serverIdentityAttestationSha256, runResult }) {
  const base = {
    schema_version: "0.1.0",
    calibration_run_manifest_version: "0.1",
    calibration_id: calibrationConfig.calibration_id,
    adapter_kind: calibrationConfig.adapter_kind,
    provider_id: calibrationConfig.provider_id,
    model_id: calibrationConfig.model_id,
    expected_dimension: calibrationConfig.expected_dimension,
    distance_metric_note: "cosine (self-supervised smoke ranking only; not a stored retrieval index)",
    batch_size: calibrationConfig.batch_size,
    request_timeout_ms: calibrationConfig.request_timeout_ms,
    maximum_item_count: calibrationConfig.maximum_item_count,
    maximum_request_count: calibrationConfig.maximum_request_count,
    maximum_total_input_units: calibrationConfig.maximum_total_input_units,
    sample_salt: calibrationConfig.sample_salt,
    dataset_manifest_sha256: calibrationConfig.dataset_manifest_sha256,
    code_revision: codeRevision ?? calibrationConfig.code_revision,
    cache_policy: calibrationConfig.cache_policy,
    retry_policy: calibrationConfig.retry_policy,
    input_price_per_million_units: calibrationConfig.input_price_per_million_units,
    actual_external_call_authorized: calibrationConfig.actual_external_call_authorized,
    // api_key_env_var (the NAME only, if present) is intentionally omitted
    // from the persisted manifest entirely -- not because it is secret
    // (it is a variable NAME, not a value), but so a manifest diff can
    // never be mistaken for evidence of what credential a run actually
    // used. Keep this comment in sync with the destructure above.
    dataset_item_count: datasetManifest.item_count,
    dataset_distinct_evidence_count: datasetManifest.distinct_evidence_count,
    created_at: new Date().toISOString(),
  };
  if (!frozenCandidate) return Object.freeze(base);

  return Object.freeze({
    ...base,
    frozen_candidate_id: frozenCandidate.frozen_candidate_id,
    repository_id: frozenCandidate.repository_id,
    immutable_revision: frozenCandidate.immutable_revision,
    registry_sha256: registrySha256 ?? null,
    prefix_policy_sha256: computePrefixPolicySha256({ queryPrefix: frozenCandidate.query_prefix, documentPrefix: frozenCandidate.document_prefix }),
    server_identity_attestation_sha256: serverIdentityAttestationSha256 ?? runResult?.server_identity_attestation_sha256 ?? null,
    embedding_dimension: frozenCandidate.embedding_dimension,
    max_input_length: frozenCandidate.max_input_length,
    normalization: frozenCandidate.normalization,
    pooling_method: frozenCandidate.pooling_method,
    query_document_modes: frozenCandidate.query_prefix === frozenCandidate.document_prefix ? ["SYMMETRIC"] : ["QUERY", "DOCUMENT"],
  });
}

export function buildCalibrationGateStatus({ runResult }) {
  return Object.freeze({
    schema_version: "0.1.0",
    gate: "REAL_EMBEDDING_CALIBRATION_READY_FOR_OWNER_CONFIGURATION",
    calibration_id: runResult.calibration_id,
    run_status: runResult.run_status,
    actual_external_embedding_call_performed: runResult.actual_external_embedding_call_performed,
    loopback_protocol_test_performed: runResult.loopback_protocol_test_performed ?? false,
    mock_embedding_call_performed: runResult.mock_embedding_call_performed ?? false,
    actual_model_embedding_call_performed: runResult.actual_model_embedding_call_performed ?? false,
    real_embedding_full_load_started: false,
    production_index_modified: false,
    ranking_performed: runResult.ranking_performed,
    dev_gold_accessed: runResult.dev_gold_accessed,
    holdout_accessed: runResult.holdout_accessed,
    final_model_selected: runResult.final_model_selected,
    evaluated_at: new Date().toISOString(),
  });
}

// Owner-facing inputs still needed before a REAL calibration run can be
// authorized -- values only, never resolved/read here (this function does
// not touch process.env at all).
export function buildRequiredOwnerInputsChecklist() {
  return Object.freeze([
    "provider_id", "model_id", "endpoint", "api_key_env_var (the NAME of an env var already set in the runtime -- never the key value itself)",
    "expected_dimension", "maximum_item_count", "maximum_request_count", "maximum_total_input_units",
    "request_timeout_ms", "input_price_per_million_units (optional)", "actual_external_call_authorized (must be explicitly set to true)",
  ]);
}
