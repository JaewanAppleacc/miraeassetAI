// Turn P9: assembles the four calibration output documents (run manifest,
// dataset manifest, result, gate status). Every builder here is a PURE
// projection of already-computed, already-safe values (dataset.mjs's
// manifest items carry no raw text; runner.mjs's result carries no raw
// vectors/response/API key) -- this file never reaches back into a
// CalibrationConfig's api_key_env_var VALUE (only ever the env var NAME,
// which is itself config, not a secret) or into any dataset item's
// textContent field.
export function buildCalibrationRunManifest({ calibrationConfig, datasetManifest, codeRevision }) {
  return Object.freeze({
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
  });
}

export function buildCalibrationGateStatus({ runResult }) {
  return Object.freeze({
    schema_version: "0.1.0",
    gate: "REAL_EMBEDDING_CALIBRATION_READY_FOR_OWNER_CONFIGURATION",
    calibration_id: runResult.calibration_id,
    run_status: runResult.run_status,
    actual_external_embedding_call_performed: runResult.actual_external_embedding_call_performed,
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
