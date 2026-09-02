// Turn P11-B: the bounded real-connection runner. Connects the EXISTING,
// UNMODIFIED P11-A HCX_CHAT_COMPLETIONS adapter (domain/agent-comparison/model-adapter.mjs
// / hcx-model-adapter.mjs) to a real endpoint, strictly within hard-limits.mjs's
// ceilings. This module never modifies the P11-A adapter files themselves --
// it only calls createModelAdapter()/adapter.generate() exactly the way any
// other caller would.
//
// FAIL-CLOSED: if loadHcxRealSmokeConfig() (config.mjs) reports `ready:false`
// (missing API key / endpoint / model id), this module makes ZERO calls --
// it does not even attempt to construct a ModelAdapter. If the adapter
// itself refuses construction (e.g. a real endpoint that fails the
// https/hostname check inside hcx-model-adapter.mjs), that is also 0 calls,
// recorded honestly.
import { createModelAdapter } from "../model-adapter.mjs";
import { HARD_LIMITS } from "./hard-limits.mjs";
import { HCX_REAL_SMOKE_SCENARIOS } from "./scenarios.mjs";

// Turn P11-C: prefers the adapter's own structured error.diagnostics.http_status
// (set by hcx-model-adapter.mjs) over parsing it back out of the fixed error
// message -- the message-regex path is kept only as a fallback for an error
// shape that never carried diagnostics (e.g. a plain Error).
function extractHttpStatus(error) {
  if (Number.isFinite(error?.diagnostics?.http_status)) return error.diagnostics.http_status;
  if (typeof error?.message !== "string") return null;
  const match = error.message.match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

// Turn P11-C: the fixed, non-sensitive diagnostic bundle for one attempt
// (see CLAUDE.md Turn P11-C section B's allowed field list). `null` fields
// mean "not applicable/not reached this attempt", never omitted -- so every
// attempt entry has the exact same shape whether it succeeded or failed.
function attemptDiagnostics(source) {
  const d = source?.diagnostics ?? null;
  return {
    http_status: Number.isFinite(d?.http_status) ? d.http_status : null,
    content_type_mime: typeof d?.content_type_mime === "string" ? d.content_type_mime : null,
    outer_envelope_class: typeof d?.outer_envelope_class === "string" ? d.outer_envelope_class : null,
    assistant_content_class: typeof d?.assistant_content_class === "string" ? d.assistant_content_class : null,
    assistant_content_length: Number.isFinite(d?.assistant_content_length) ? d.assistant_content_length : null,
    finish_reason: typeof d?.finish_reason === "string" ? d.finish_reason : null,
  };
}

function isRetryableHttpError(errorCode, httpStatus) {
  if (errorCode !== "MODEL_CALL_HTTP_ERROR" || httpStatus === null) return false;
  return httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function computeLatencyStats(latencies) {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    max_ms: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

const EMPTY_RUN_RESULT = Object.freeze({
  requestsAttempted: 0,
  requestsSucceeded: 0,
  requestsFailed: 0,
  retriesPerformed: 0,
  scenarioResults: [],
  latencyStats: null,
  tokenUsageAggregate: null,
  estimatedCostTotal: null,
  durationMs: 0,
  constructionError: null,
});

// `loaded`: the object returned by loadHcxRealSmokeConfig() (config.mjs).
// `options.fetchImpl`: test-only injected fetch (never used for a real run;
// omitted entirely when actually connecting to the real endpoint).
// `options.maxRequestsOverride` (Turn P11-C, optional): allows ONE caller-
// supplied run to use a request ceiling LOWER than HARD_LIMITS.MAXIMUM_REQUESTS
// -- never higher, `Math.min` below makes raising it impossible even if a
// caller passes a larger number.
export async function runHcxRealSmoke(loaded, options = {}) {
  const startedAt = Date.now();
  const maxRequests = Number.isFinite(options.maxRequestsOverride)
    ? Math.max(0, Math.min(options.maxRequestsOverride, HARD_LIMITS.MAXIMUM_REQUESTS))
    : HARD_LIMITS.MAXIMUM_REQUESTS;

  if (!loaded.ready) {
    return { ...EMPTY_RUN_RESULT, stoppedEarlyReason: "MISSING_CREDENTIALS" };
  }

  let adapter;
  try {
    adapter = createModelAdapter(loaded.modelConfig, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  } catch (error) {
    return {
      ...EMPTY_RUN_RESULT,
      stoppedEarlyReason: "ADAPTER_CONSTRUCTION_REFUSED",
      constructionError: { code: typeof error?.code === "string" ? error.code : null, name: error?.name ?? "Error" },
    };
  }

  let requestsAttempted = 0;
  let requestsSucceeded = 0;
  let requestsFailed = 0;
  let retriesPerformed = 0;
  let consecutiveScenarioFailures = 0;
  let stoppedEarlyReason = null;
  const latencies = [];
  const scenarioResults = [];
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let tokensProvided = false;
  let estimatedCostTotal = 0;
  let costProvided = false;

  for (const scenario of HCX_REAL_SMOKE_SCENARIOS) {
    if (requestsAttempted >= maxRequests) { stoppedEarlyReason = "MAX_REQUESTS_REACHED"; break; }
    if (Date.now() - startedAt >= HARD_LIMITS.OVERALL_TIME_BUDGET_MS) { stoppedEarlyReason = "TIME_BUDGET_EXCEEDED"; break; }
    if (consecutiveScenarioFailures >= HARD_LIMITS.CONSECUTIVE_SCENARIO_FAILURES_TO_STOP) { stoppedEarlyReason = "REPEATED_ERRORS"; break; }

    const scenarioAttempts = [];
    let outcome = null;
    let attempt = 0;
    while (attempt < HARD_LIMITS.RETRY_MAX_ATTEMPTS && requestsAttempted < maxRequests) {
      attempt += 1;
      requestsAttempted += 1;
      const callStartedAt = Date.now();
      try {
         
        const result = await adapter.generate({ prompt: scenario.prompt });
        const latencyMs = Date.now() - callStartedAt;
        latencies.push(latencyMs);
        requestsSucceeded += 1;
        if (Number.isFinite(result?.input_tokens)) { inputTokensTotal += result.input_tokens; tokensProvided = true; }
        if (Number.isFinite(result?.output_tokens)) { outputTokensTotal += result.output_tokens; tokensProvided = true; }
        if (Number.isFinite(result?.estimated_cost) && result.estimated_cost > 0) { estimatedCostTotal += result.estimated_cost; costProvided = true; }
        scenarioAttempts.push({ attempt, ok: true, latency_ms: latencyMs, error_code: null, http_status: attemptDiagnostics(result).http_status, diagnostics: attemptDiagnostics(result) });
        outcome = "SUCCESS";
        break;
      } catch (error) {
        const latencyMs = Date.now() - callStartedAt;
        latencies.push(latencyMs);
        requestsFailed += 1;
        const errorCode = typeof error?.code === "string" ? error.code : "MODEL_CALL_UNKNOWN_ERROR";
        const httpStatus = extractHttpStatus(error);
        const looksEmptyResponse = errorCode === "MODEL_CALL_MALFORMED_RESPONSE" && /empty/i.test(error?.message ?? "");
        scenarioAttempts.push({ attempt, ok: false, latency_ms: latencyMs, error_code: errorCode, http_status: httpStatus, looks_empty_response: looksEmptyResponse, diagnostics: attemptDiagnostics(error) });
        const retryable = isRetryableHttpError(errorCode, httpStatus);
        if (!retryable || attempt >= HARD_LIMITS.RETRY_MAX_ATTEMPTS) {
          outcome = "FAILURE";
          break;
        }
        retriesPerformed += 1;
      }
    }
    scenarioResults.push({ scenario_type: scenario.scenario_type, outcome, attempts: scenarioAttempts });
    consecutiveScenarioFailures = outcome === "SUCCESS" ? 0 : consecutiveScenarioFailures + 1;
  }

  return {
    requestsAttempted,
    requestsSucceeded,
    requestsFailed,
    retriesPerformed,
    scenarioResults,
    latencyStats: computeLatencyStats(latencies),
    tokenUsageAggregate: tokensProvided ? { input_tokens_total: inputTokensTotal, output_tokens_total: outputTokensTotal } : null,
    estimatedCostTotal: costProvided ? estimatedCostTotal : null,
    durationMs: Date.now() - startedAt,
    stoppedEarlyReason,
    constructionError: null,
  };
}
