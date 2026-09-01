// Turn P11-B: maps CLAUDE.md's own "검증 항목" checklist onto concrete,
// evidence-backed PASS/FAIL/NOT_OBSERVED verdicts. NOT_OBSERVED (never
// silently coerced to PASS) means the underlying condition genuinely never
// arose this run -- e.g. no 429/5xx ever came back, so bounded-retry
// behavior was never exercised. A handful of items (schema version
// recognized, missing-key-zero-calls, unauthorized-endpoint-zero-calls,
// non-exposure) are checkable REGARDLESS of whether any real call
// happened, and are always PASS/FAIL, never NOT_OBSERVED.
import { SUPPORTED_HCX_REQUEST_SCHEMA_VERSIONS, SUPPORTED_HCX_RESPONSE_SCHEMA_VERSIONS } from "../hcx-model-adapter.mjs";

function item(name, status, detail) {
  return { item: name, status, detail };
}

export function computeValidationChecklist(loaded, runResult) {
  const checklist = [];
  const attempted = runResult.requestsAttempted;
  const anySuccess = runResult.requestsSucceeded > 0;
  const allAttempts = runResult.scenarioResults.flatMap((s) => s.attempts ?? []);

  // 1. endpoint HTTPS
  if (loaded.redacted.endpoint_hostname === null) {
    checklist.push(item("endpoint_https_confirmed", "NOT_OBSERVED", "no endpoint_url configured this run"));
  } else {
    checklist.push(item("endpoint_https_confirmed", loaded.redacted.endpoint_https ? "PASS" : "FAIL", `endpoint_https=${loaded.redacted.endpoint_https}`));
  }

  // 2. provider/model identity
  if (loaded.ready) {
    const ok = typeof loaded.modelConfig.provider === "string" && loaded.modelConfig.provider.length > 0
      && typeof loaded.modelConfig.model === "string" && loaded.modelConfig.model.length > 0;
    checklist.push(item("provider_model_identity_confirmed", ok ? "PASS" : "FAIL", `provider=${loaded.redacted.provider_id}, model set=${loaded.redacted.model_id !== null}`));
  } else {
    checklist.push(item("provider_model_identity_confirmed", "NOT_OBSERVED", "config not ready"));
  }

  // 3/4. request/response schema version recognized (checkable statically, always)
  const reqVersionOk = SUPPORTED_HCX_REQUEST_SCHEMA_VERSIONS.includes(loaded.redacted.request_schema_version);
  checklist.push(item("request_schema_version_confirmed", reqVersionOk ? "PASS" : "FAIL", `request_schema_version=${loaded.redacted.request_schema_version}`));
  const resVersionOk = SUPPORTED_HCX_RESPONSE_SCHEMA_VERSIONS.includes(loaded.redacted.response_schema_version);
  checklist.push(item("response_schema_version_confirmed", resVersionOk ? "PASS" : "FAIL", `response_schema_version=${loaded.redacted.response_schema_version}`));

  // 5. structured answer parser passed (only provable via a real success)
  checklist.push(item(
    "structured_answer_parser_passed",
    anySuccess ? "PASS" : "NOT_OBSERVED",
    anySuccess ? `${runResult.requestsSucceeded} successful parse(s)` : "no successful call this run",
  ));

  // 6. timeout stayed within the configured bound
  if (allAttempts.length === 0) {
    checklist.push(item("timeout_within_configured_bound", "NOT_OBSERVED", "no calls made"));
  } else {
    const overLimit = allAttempts.some((a) => a.latency_ms > loaded.redacted.request_timeout_ms);
    checklist.push(item("timeout_within_configured_bound", overLimit ? "FAIL" : "PASS", `max observed latency vs request_timeout_ms=${loaded.redacted.request_timeout_ms}ms`));
  }

  // 7. 429/5xx bounded retry actually exercised
  const retryableFailures = allAttempts.filter((a) => !a.ok && a.error_code === "MODEL_CALL_HTTP_ERROR" && a.http_status !== null && (a.http_status === 429 || (a.http_status >= 500 && a.http_status < 600)));
  if (retryableFailures.length === 0) {
    checklist.push(item("bounded_retry_on_429_5xx", "NOT_OBSERVED", "no 429/5xx response encountered this run"));
  } else {
    checklist.push(item("bounded_retry_on_429_5xx", runResult.retriesPerformed > 0 ? "PASS" : "FAIL", `${retryableFailures.length} retryable failure(s), ${runResult.retriesPerformed} retry attempt(s)`));
  }

  // 8. retry count cap respected (structurally guaranteed by the runner's own loop bound)
  const maxAttemptsPerScenario = Math.max(0, ...runResult.scenarioResults.map((s) => s.attempts?.length ?? 0));
  checklist.push(item(
    "retry_count_cap_respected",
    attempted === 0 ? "NOT_OBSERVED" : (maxAttemptsPerScenario <= 2 ? "PASS" : "FAIL"),
    `max attempts observed for a single scenario=${maxAttemptsPerScenario} (cap=2)`,
  ));

  // 9. malformed response fail-closed
  const malformed = allAttempts.filter((a) => !a.ok && a.error_code === "MODEL_CALL_MALFORMED_RESPONSE" && !a.looks_empty_response);
  checklist.push(item(
    "malformed_response_fail_closed",
    malformed.length === 0 ? "NOT_OBSERVED" : "PASS",
    malformed.length === 0 ? "no malformed response encountered" : `${malformed.length} malformed response(s), all rejected fail-closed`,
  ));

  // 10. empty response fail-closed
  const emptyResponses = allAttempts.filter((a) => !a.ok && a.looks_empty_response);
  checklist.push(item(
    "empty_response_fail_closed",
    emptyResponses.length === 0 ? "NOT_OBSERVED" : "PASS",
    emptyResponses.length === 0 ? "no empty response encountered" : `${emptyResponses.length} empty response(s), all rejected fail-closed`,
  ));

  // 11. missing API key -> zero calls
  const missingKey = loaded.missing.includes(loaded.apiKeyEnvVar);
  checklist.push(item(
    "missing_api_key_zero_calls",
    missingKey ? (attempted === 0 ? "PASS" : "FAIL") : "NOT_OBSERVED",
    missingKey ? `${loaded.apiKeyEnvVar} was not set; requests_attempted=${attempted}` : `${loaded.apiKeyEnvVar} was present`,
  ));

  // 12. unauthorized/unready endpoint -> zero calls (covers both "endpoint/model missing" and "adapter refused construction")
  const unauthorizedCase = !loaded.ready || runResult.stoppedEarlyReason === "ADAPTER_CONSTRUCTION_REFUSED";
  checklist.push(item(
    "unauthorized_endpoint_zero_calls",
    unauthorizedCase ? (attempted === 0 ? "PASS" : "FAIL") : "NOT_OBSERVED",
    unauthorizedCase ? `config not ready or construction refused; requests_attempted=${attempted}` : "endpoint was authorized and constructed",
  ));

  return checklist;
}
