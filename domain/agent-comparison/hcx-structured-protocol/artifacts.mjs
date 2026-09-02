// Turn P11-D: builds the SINGLE report artifact
// (interfaces/hcx-structured-protocol-comparison-report.schema.json) from a
// loaded config + a runStructuredProtocolComparison() result. Pure (no I/O)
// so tests can exercise it without ever touching the filesystem or network.
// Mirrors hcx-real-smoke/artifacts.mjs's own pattern: a security attestation
// that scans the OTHER (already-built) sections' serialized JSON for a
// secret/raw-content leak, computed before the selection decision is made.
import { P11D_HARD_LIMITS } from "./hard-limits.mjs";
import { P11D_STRUCTURED_PROTOCOL_SCENARIOS } from "./scenarios.mjs";
import { CANDIDATE_A_ID } from "./candidate-a-function-calling.mjs";
import { CANDIDATE_B_ID } from "./candidate-b-response-format.mjs";
import { selectStructuredProtocol, isCandidateGreen } from "./selection.mjs";

// The report schema's own candidate_id enum is intentionally short
// (FUNCTION_CALLING/RESPONSE_FORMAT) -- this module's own longer,
// self-documenting ids (candidate-a-function-calling.mjs's
// NATIVE_V3_FUNCTION_CALLING, candidate-b-response-format.mjs's
// OPENAI_COMPATIBLE_RESPONSE_FORMAT) are used everywhere else (runner.mjs,
// selection.mjs, tests); this is the ONLY place the mapping happens.
const REPORT_CANDIDATE_ID = Object.freeze({ [CANDIDATE_A_ID]: "FUNCTION_CALLING", [CANDIDATE_B_ID]: "RESPONSE_FORMAT" });

// Buckets every non-SUCCESS outcome_class the two candidate clients can
// return (candidate-a-function-calling.mjs / candidate-b-response-format.mjs)
// into exactly one of the report schema's five violation counters. Every
// class name below is a literal `outcome_class` string those two modules
// actually return -- see their own source for the full list.
function failureBucket(outcomeClass) {
  if (outcomeClass === "EVIDENCE_ID_MISMATCH") return "citation_violation_count";
  if (outcomeClass === "TOOL_CALL_ARGUMENTS_SCHEMA_INVALID" || outcomeClass === "CONTENT_SCHEMA_INVALID") return "schema_violation_count";
  if (outcomeClass === "HTTP_4XX_UNSUPPORTED_OR_REJECTED" || outcomeClass === "HTTP_ERROR") return "unsupported_count";
  if (outcomeClass === "TIMEOUT" || outcomeClass === "NETWORK_ERROR" || outcomeClass === "OUTER_ENVELOPE_NOT_JSON"
    || outcomeClass === "AUTH_ERROR_RUN_ABORTED" || outcomeClass === "NOT_ATTEMPTED") return "malformed_count";
  // Everything else is a structural tool-call or content-envelope shape
  // violation: TOOL_CALL_MISSING/DUPLICATE/NAME_MISMATCH/MALFORMED/
  // ARGUMENTS_NOT_OBJECT, NATURAL_LANGUAGE_CONTENT_PRESENT, ENVELOPE_*,
  // CONTENT_EMPTY/FENCED_OR_MIXED_REJECTED/TEXT_WITH_EMBEDDED_OR_TRUNCATED_JSON/
  // NOT_JSON_AT_ALL/JSON_PARSE_FAILED.
  return "tool_envelope_violation_count";
}

function perScenarioBreakdown(scenarioRuns) {
  return P11D_STRUCTURED_PROTOCOL_SCENARIOS.map((scenario) => {
    const runs = scenarioRuns.filter((run) => run.scenario_type === scenario.scenario_type);
    const successes = runs.filter((run) => run.ok === true).length;
    return {
      scenario_type: scenario.scenario_type,
      repetitions_observed: runs.length,
      successes,
      success_rate: runs.length > 0 ? successes / runs.length : null,
    };
  });
}

function candidateSummary(candidateResult, candidateId) {
  if (!candidateResult || candidateResult.skippedReason) {
    return {
      candidate_id: REPORT_CANDIDATE_ID[candidateId],
      construction_error: null,
      requests_attempted: 0,
      requests_succeeded: 0,
      requests_failed: 0,
      retries_performed: 0,
      per_scenario: perScenarioBreakdown([]),
      schema_violation_count: 0,
      tool_envelope_violation_count: 0,
      malformed_count: 0,
      unsupported_count: 0,
      citation_violation_count: 0,
      latency_ms: null,
      token_usage_aggregate: null,
      green: false,
    };
  }

  const counters = { schema_violation_count: 0, tool_envelope_violation_count: 0, malformed_count: 0, unsupported_count: 0, citation_violation_count: 0 };
  for (const run of candidateResult.scenarioRuns) {
    if (run.ok) continue;
    counters[failureBucket(run.outcome_class)] += 1;
  }

  return {
    candidate_id: REPORT_CANDIDATE_ID[candidateId],
    construction_error: null,
    requests_attempted: candidateResult.scenarioRuns.length,
    requests_succeeded: candidateResult.requestsSucceeded,
    requests_failed: candidateResult.requestsFailed,
    retries_performed: candidateResult.retriesPerformed,
    per_scenario: perScenarioBreakdown(candidateResult.scenarioRuns),
    ...counters,
    latency_ms: candidateResult.latencyStats,
    token_usage_aggregate: candidateResult.tokenUsageAggregate,
    green: isCandidateGreen(candidateResult),
  };
}

function containsCaseInsensitive(haystack, needle) {
  return typeof needle === "string" && needle.length > 0 && haystack.toLowerCase().includes(needle.toLowerCase());
}

// Scans the SERIALIZED JSON text of the report sections built so far (never
// the security_attestation section itself, which does not exist yet at this
// point) for the exact secret value and for header/raw-text shapes that
// should never appear.
function buildSecurityAttestation(loaded, sectionsToScan) {
  const serialized = JSON.stringify(sectionsToScan);
  const checks = [];

  const keyLeak = loaded.rawApiKey ? containsCaseInsensitive(serialized, loaded.rawApiKey) : false;
  checks.push({ check_name: "api_key_value_absent_from_report", passed: !keyLeak, detail: loaded.rawApiKey ? "scanned the report for the literal key value" : "no API key was present this run to check for" });

  const authHeaderLeak = /"authorization"\s*:/i.test(serialized) || /bearer\s+\S/i.test(serialized);
  checks.push({ check_name: "authorization_header_absent_from_report", passed: !authHeaderLeak, detail: "scanned for an \"authorization\" JSON key or a \"Bearer <token>\" pattern" });

  const endpointUrlLeak = loaded.candidateAEndpointUrl ? containsCaseInsensitive(serialized, loaded.candidateAEndpointUrl) : false;
  checks.push({ check_name: "full_endpoint_url_absent_from_report", passed: !endpointUrlLeak, detail: "the report records endpoint hostname classification only (config.redacted output), never the full endpoint_url" });

  const promptLeak = P11D_STRUCTURED_PROTOCOL_SCENARIOS.some((s) => containsCaseInsensitive(serialized, s.task));
  checks.push({ check_name: "raw_prompt_text_absent_from_report", passed: !promptLeak, detail: "scanned for the fixed scenario task texts (report records aggregate stats only)" });

  checks.push({ check_name: "raw_response_content_structurally_excluded", passed: true, detail: "the report is schema-validated against a fixed field list (additionalProperties:false) that has no room for a raw content/arguments/tool-call value -- see interfaces/hcx-structured-protocol-comparison-report.schema.json" });

  const overall_status = checks.every((c) => c.passed) ? "PASS" : "FAIL";
  return { checks, overall_status };
}

// Builds the single report artifact this Turn's schema requires. Pure --
// `runResult` is exactly runStructuredProtocolComparison()'s return value
// (or an equivalent reconstruction of it from already-captured data; this
// function never itself makes a network call).
export function buildComparisonReport(loaded, runResult, { runId, createdAt } = {}) {
  const resolvedRunId = runId ?? loaded.redacted?.run_id ?? "unknown_run";
  const resolvedCreatedAt = createdAt ?? new Date().toISOString();

  if (!loaded.ready) {
    const selection = { selected_candidate: null, status: "RED_NO_SELECTION", reason: `missing required configuration: ${loaded.missing.join(", ")}; 0 real external calls made` };
    const securityAttestation = buildSecurityAttestation(loaded, [selection]);
    return {
      schema_version: "0.1.0",
      run_id: resolvedRunId,
      created_at: resolvedCreatedAt,
      ready: false,
      stopped_early_reason: "MISSING_CREDENTIALS",
      total_requests_attempted: 0,
      candidates: null,
      selection,
      security_attestation: securityAttestation,
    };
  }

  const candidateA = candidateSummary(runResult.candidateA, CANDIDATE_A_ID);
  const candidateB = candidateSummary(runResult.candidateB, CANDIDATE_B_ID);
  const candidates = { FUNCTION_CALLING: candidateA, RESPONSE_FORMAT: candidateB };

  const decision = selectStructuredProtocol({
    candidateA: runResult.candidateA,
    candidateB: runResult.candidateB,
    // computed just below, after the security_attestation section itself
    // exists -- see the two-pass construction directly below.
    secretNonLeakPass: true,
  });
  const selectionBeforeLeakCheck = {
    selected_candidate: decision.selected ? REPORT_CANDIDATE_ID[decision.selected] : null,
    status: decision.status === "GREEN" ? "GREEN_SELECTED" : "RED_NO_SELECTION",
    reason: decision.reason,
  };

  const securityAttestation = buildSecurityAttestation(loaded, [candidates, selectionBeforeLeakCheck]);

  // If the leak scan itself failed, re-run the selection decision with
  // secretNonLeakPass:false so `selection` and `security_attestation` never
  // disagree (CLAUDE.md Turn P11-D section G: a GREEN protocol that leaked a
  // secret into an artifact is never selected).
  const finalDecision = securityAttestation.overall_status === "PASS"
    ? decision
    : selectStructuredProtocol({ candidateA: runResult.candidateA, candidateB: runResult.candidateB, secretNonLeakPass: false });
  const selection = {
    selected_candidate: finalDecision.selected ? REPORT_CANDIDATE_ID[finalDecision.selected] : null,
    status: finalDecision.status === "GREEN" ? "GREEN_SELECTED" : "RED_NO_SELECTION",
    reason: finalDecision.reason,
  };

  return {
    schema_version: "0.1.0",
    run_id: resolvedRunId,
    created_at: resolvedCreatedAt,
    ready: true,
    stopped_early_reason: runResult.stoppedEarlyReason,
    total_requests_attempted: runResult.totalRequests,
    candidates,
    selection,
    security_attestation: securityAttestation,
  };
}
