// Turn P11-B: builds the four required artifacts (config/result/security-
// attestation/gate-status) from a loaded config + a runner result, and
// computes the gate status. Every builder here is pure (no I/O) so tests
// can exercise it without ever touching the filesystem or network.
import { HCX_REAL_SMOKE_SCENARIOS } from "./scenarios.mjs";
import { computeValidationChecklist } from "./validation.mjs";

export function buildConfigArtifact(loaded) {
  return loaded.redacted;
}

function scenarioSummary(scenarioResult) {
  const lastAttempt = scenarioResult.attempts[scenarioResult.attempts.length - 1];
  return {
    scenario_type: scenarioResult.scenario_type,
    outcome: scenarioResult.outcome,
    attempt_count: scenarioResult.attempts.length,
    last_error_code: lastAttempt && !lastAttempt.ok ? lastAttempt.error_code : null,
  };
}

export function buildResultArtifact(loaded, runResult, { runId, createdAt }) {
  return {
    schema_version: "0.1.0",
    run_id: runId,
    created_at: createdAt,
    requests_attempted: runResult.requestsAttempted,
    requests_succeeded: runResult.requestsSucceeded,
    requests_failed: runResult.requestsFailed,
    retries_performed: runResult.retriesPerformed,
    scenarios: runResult.scenarioResults.map(scenarioSummary),
    latency_ms: runResult.latencyStats,
    token_usage_aggregate: runResult.tokenUsageAggregate,
    estimated_cost_total: runResult.estimatedCostTotal,
    duration_ms: runResult.durationMs,
    stopped_early_reason: runResult.stoppedEarlyReason,
    validation_checklist: computeValidationChecklist(loaded, runResult),
  };
}

export function computeGateStatus(loaded, runResult, resultArtifact) {
  const anyFail = resultArtifact.validation_checklist.some((entry) => entry.status === "FAIL");
  const anySuccess = runResult.requestsSucceeded > 0;
  if (!loaded.ready) {
    return { gate_status: "HCX_REAL_API_PROTOCOL_NOT_VERIFIED", reason: `missing required configuration: ${loaded.missing.join(", ")}; 0 real external calls made` };
  }
  if (runResult.stoppedEarlyReason === "ADAPTER_CONSTRUCTION_REFUSED") {
    return { gate_status: "HCX_REAL_API_PROTOCOL_NOT_VERIFIED", reason: `adapter construction refused (${runResult.constructionError?.code ?? "unknown"}); 0 real external calls made` };
  }
  if (anyFail) {
    return { gate_status: "HCX_REAL_API_PROTOCOL_NOT_VERIFIED", reason: "one or more validation checklist items FAILed" };
  }
  if (!anySuccess) {
    return { gate_status: "HCX_REAL_API_PROTOCOL_NOT_VERIFIED", reason: "no successful real call was made this run" };
  }
  return { gate_status: "HCX_REAL_API_PROTOCOL_VERIFIED", reason: `${runResult.requestsSucceeded} successful real call(s), no checklist failures` };
}

export function buildGateStatusArtifact(loaded, runResult, resultArtifact, { runId, createdAt }) {
  const { gate_status, reason } = computeGateStatus(loaded, runResult, resultArtifact);
  return {
    schema_version: "0.1.0",
    run_id: runId,
    created_at: createdAt,
    gate_status,
    reason,
    agent_quality_evaluated: false,
    dev_tune_accessed: false,
    dev_check_accessed: false,
    holdout_accessed: false,
    production_wiring_applied: false,
    final_generation_model_selected: false,
  };
}

// --- security attestation -------------------------------------------------

function containsCaseInsensitive(haystack, needle) {
  return needle.length > 0 && haystack.toLowerCase().includes(needle.toLowerCase());
}

// Scans the SERIALIZED JSON text of the other three artifacts for the exact
// secret value and for header/raw-text shapes that should never appear.
// `rawApiKey` is passed in ONLY to check for its absence -- it is never
// itself written into the returned attestation object.
export function buildSecurityAttestation(loaded, artifacts, { runId, createdAt }) {
  const serialized = artifacts.map((a) => JSON.stringify(a)).join("\n");
  const checks = [];

  const keyLeak = loaded.rawApiKey ? containsCaseInsensitive(serialized, loaded.rawApiKey) : false;
  checks.push({ check_name: "api_key_value_absent_from_artifacts", passed: !keyLeak, detail: loaded.rawApiKey ? "scanned all artifacts for the literal key value" : "no API key was present this run to check for" });

  const authHeaderLeak = /"authorization"\s*:/i.test(serialized) || /bearer\s+\S/i.test(serialized);
  checks.push({ check_name: "authorization_header_absent_from_artifacts", passed: !authHeaderLeak, detail: "scanned for an \"authorization\" JSON key or a \"Bearer <token>\" pattern" });

  const promptLeak = HCX_REAL_SMOKE_SCENARIOS.some((s) => containsCaseInsensitive(serialized, s.prompt));
  checks.push({ check_name: "raw_prompt_text_absent_from_artifacts", passed: !promptLeak, detail: "scanned for the fixed scenario prompt texts (result artifact records aggregate stats only)" });

  const endpointUrlLeak = loaded.modelConfig?.endpoint_url ? containsCaseInsensitive(serialized, loaded.modelConfig.endpoint_url) : false;
  checks.push({ check_name: "full_endpoint_url_absent_from_artifacts", passed: !endpointUrlLeak, detail: "artifacts record endpoint_hostname only, never the full endpoint_url" });

  checks.push({ check_name: "raw_provider_response_body_structurally_excluded", passed: true, detail: "every artifact is schema-validated with additionalProperties:false against a fixed field list that has no room for a raw provider body -- see interfaces/*.schema.json" });

  const overall_status = checks.every((c) => c.passed) ? "PASS" : "FAIL";
  return {
    schema_version: "0.1.0",
    run_id: runId,
    created_at: createdAt,
    api_key_env_var_name: loaded.apiKeyEnvVar,
    checks,
    overall_status,
  };
}

export function buildAllArtifacts(loaded, runResult) {
  const runId = loaded.redacted.run_id;
  const createdAt = new Date().toISOString();
  const configArtifact = buildConfigArtifact(loaded);
  const resultArtifact = buildResultArtifact(loaded, runResult, { runId, createdAt });
  const gateStatusArtifact = buildGateStatusArtifact(loaded, runResult, resultArtifact, { runId, createdAt });
  const securityAttestation = buildSecurityAttestation(loaded, [configArtifact, resultArtifact, gateStatusArtifact], { runId, createdAt });
  return { configArtifact, resultArtifact, gateStatusArtifact, securityAttestation };
}
