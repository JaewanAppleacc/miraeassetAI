// Turn P11-D: the bounded real-comparison runner. Drives BOTH candidates
// (candidate-a-function-calling.mjs, candidate-b-response-format.mjs)
// against the same 5 synthetic scenarios (scenarios.mjs), 3 repetitions
// each, strictly within hard-limits.mjs's ceilings -- mirrors
// hcx-real-smoke/runner.mjs's own fail-closed, code-enforced-ceiling
// pattern but compares two protocols instead of running one smoke.
//
// FAIL-CLOSED: if loadStructuredProtocolConfig() reports ready:false, this
// module makes ZERO calls to either candidate. An authentication error
// (401/403) from either candidate immediately stops the ENTIRE run (both
// candidates) -- CLAUDE.md Turn P11-D section F: "인증 오류 시 즉시 전체
// 중단". Never stores a raw prompt/response/content/tool-call-arguments
// value anywhere in the returned result -- only counts, classifications,
// and the short synthetic fact/evidence ids needed for the
// evidence-id-authorization check below.
import { P11D_HARD_LIMITS } from "./hard-limits.mjs";
import { P11D_STRUCTURED_PROTOCOL_SCENARIOS } from "./scenarios.mjs";
import { COMMON_STRUCTURED_ANSWER_SCHEMA } from "./common-schema.mjs";
import { toolParametersSchema } from "./envelope-native-v3.mjs";
import { callCandidateA, CANDIDATE_A_ID } from "./candidate-a-function-calling.mjs";
import { callCandidateB, CANDIDATE_B_ID } from "./candidate-b-response-format.mjs";

// A synthetic id the model used that is NOT in the scenario's own
// authorized set is a structural grounding failure, checkable without any
// real Fact/Evidence store (this smoke has none -- see scenarios.mjs's own
// header). Never a security/leak concern by itself (ids are short synthetic
// tokens, never free text), but treated as a hard FAIL outcome the same way
// a schema violation is.
function hasUnauthorizedId(usedIds, allowedIds) {
  const allowed = new Set(allowedIds);
  return usedIds.some((id) => !allowed.has(id));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function computeLatencyStats(latencies) {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  return { p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95), max_ms: sorted[sorted.length - 1], count: sorted.length };
}

const EMPTY_CANDIDATE_RESULT = Object.freeze({
  scenarioRuns: [],
  requestsSucceeded: 0,
  requestsFailed: 0,
  retriesPerformed: 0,
  latencyStats: null,
  tokenUsageAggregate: null,
  skippedReason: "NOT_ATTEMPTED",
});

// Runs one candidate's full 5-scenario x 3-repetition sweep. `state` is a
// small mutable object ({ totalRequests, authAborted }) SHARED across both
// candidates so the global hard cap and the auth-abort flag apply across
// the whole comparison, not per candidate.
async function runOneCandidate(candidateId, callFn, buildCallOptions, state) {
  if (state.authAborted) return { ...EMPTY_CANDIDATE_RESULT, skippedReason: "AUTH_ABORTED_BEFORE_START" };

  const scenarioRuns = [];
  const latencies = [];
  let requestsSucceeded = 0;
  let requestsFailed = 0;
  let retriesPerformed = 0;
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let tokensProvided = false;

  for (const scenario of P11D_STRUCTURED_PROTOCOL_SCENARIOS) {
    if (state.authAborted || state.totalRequests >= P11D_HARD_LIMITS.GLOBAL_HARD_CAP) break;

    for (let rep = 0; rep < P11D_HARD_LIMITS.REPETITIONS_PER_SCENARIO; rep += 1) {
      if (state.authAborted || state.totalRequests >= P11D_HARD_LIMITS.GLOBAL_HARD_CAP) break;

      const attempts = [];
      let finalOutcome = null;
      let attempt = 0;
      while (attempt < P11D_HARD_LIMITS.RETRY_MAX_ATTEMPTS && state.totalRequests < P11D_HARD_LIMITS.GLOBAL_HARD_CAP) {
        attempt += 1;
        state.totalRequests += 1;
        // eslint-disable-next-line no-await-in-loop
        const result = await callFn(buildCallOptions(scenario));
        latencies.push(result.latency_ms);
        attempts.push({ attempt, outcome_class: result.outcome_class, http_status: result.http_status, ok: result.ok });

        if (result.auth_error) {
          state.authAborted = true;
          finalOutcome = { ...result, outcome_class: "AUTH_ERROR_RUN_ABORTED" };
          requestsFailed += 1;
          break;
        }

        let outcome = result;
        if (result.ok) {
          const idViolation = hasUnauthorizedId(result.used_fact_ids, scenario.allowedFactIds)
            || hasUnauthorizedId(result.used_evidence_ids, scenario.allowedEvidenceIds);
          if (idViolation) outcome = { ...result, ok: false, outcome_class: "EVIDENCE_ID_MISMATCH" };
        }

        if (outcome.ok) {
          requestsSucceeded += 1;
          if (Number.isFinite(outcome.input_tokens)) { inputTokensTotal += outcome.input_tokens; tokensProvided = true; }
          if (Number.isFinite(outcome.output_tokens)) { outputTokensTotal += outcome.output_tokens; tokensProvided = true; }
          finalOutcome = outcome;
          break;
        }

        requestsFailed += 1;
        if (!outcome.retryable || attempt >= P11D_HARD_LIMITS.RETRY_MAX_ATTEMPTS) {
          finalOutcome = outcome;
          break;
        }
        retriesPerformed += 1;
      }

      scenarioRuns.push({
        scenario_type: scenario.scenario_type,
        repetition: rep + 1,
        outcome_class: finalOutcome?.outcome_class ?? "NOT_ATTEMPTED",
        ok: finalOutcome?.ok ?? false,
        attempt_count: attempts.length,
        http_status: finalOutcome?.http_status ?? null,
      });

      if (state.authAborted) break;
    }
  }

  return {
    scenarioRuns,
    requestsSucceeded,
    requestsFailed,
    retriesPerformed,
    latencyStats: computeLatencyStats(latencies),
    tokenUsageAggregate: tokensProvided ? { input_tokens_total: inputTokensTotal, output_tokens_total: outputTokensTotal } : null,
    skippedReason: null,
  };
}

// `loaded`: loadStructuredProtocolConfig()'s return value.
// `options.fetchImpl`: test-only injected fetch, shared by both candidates
// (never used for a real run -- omitted entirely when actually connecting).
export async function runStructuredProtocolComparison(loaded, options = {}) {
  const startedAt = Date.now();
  if (!loaded.ready) {
    return {
      stoppedEarlyReason: "MISSING_CREDENTIALS",
      totalRequests: 0,
      authAborted: false,
      candidateA: EMPTY_CANDIDATE_RESULT,
      candidateB: EMPTY_CANDIDATE_RESULT,
      durationMs: Date.now() - startedAt,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const parametersSchema = toolParametersSchema(COMMON_STRUCTURED_ANSWER_SCHEMA);
  const state = { totalRequests: 0, authAborted: false };

  const candidateA = await runOneCandidate(
    CANDIDATE_A_ID,
    callCandidateA,
    (scenario) => ({
      prompt: scenario.task,
      endpointUrl: loaded.candidateAEndpointUrl,
      apiKey: loaded.rawApiKey,
      maxOutputTokens: loaded.maxOutputTokens,
      parametersSchema,
      fetchImpl,
      timeoutMs: P11D_HARD_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS,
    }),
    state,
  );

  const candidateB = await runOneCandidate(
    CANDIDATE_B_ID,
    callCandidateB,
    (scenario) => ({
      prompt: scenario.task,
      model: loaded.model,
      apiKey: loaded.rawApiKey,
      maxOutputTokens: loaded.maxOutputTokens,
      commonSchema: COMMON_STRUCTURED_ANSWER_SCHEMA,
      fetchImpl,
      timeoutMs: P11D_HARD_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS,
    }),
    state,
  );

  return {
    stoppedEarlyReason: state.authAborted ? "AUTH_ERROR" : (state.totalRequests >= P11D_HARD_LIMITS.GLOBAL_HARD_CAP ? "GLOBAL_HARD_CAP_REACHED" : null),
    totalRequests: state.totalRequests,
    authAborted: state.authAborted,
    candidateA,
    candidateB,
    durationMs: Date.now() - startedAt,
  };
}
