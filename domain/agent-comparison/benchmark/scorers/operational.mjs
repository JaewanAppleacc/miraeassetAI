// Turn P6 section C.8: Operational Scorer. Reports (never judges pass/fail
// on its own -- an eligible row only reaches this scorer at all when it is
// NOT a failure/fallback, see scorers/index.mjs) the run's own operational
// telemetry: latency, structured_query_count, document_retrieval_count,
// model_call counts, token/cost, model_fallback_used, scoring_eligible.
// Always PASS for an eligible row -- the numbers themselves belong in
// axis_summary/details for a human or a later ScoringPolicy to threshold,
// not something this scorer silently fails a row over.
import { pass } from "./axis-result.mjs";

export function scoreOperational({
  latencyMs, structuredQueryCount, documentRetrievalCount,
  modelCallAttemptCount, modelCallSuccessCount, modelCallFailureCount,
  inputTokens, outputTokens, estimatedCost, modelFallbackUsed, scoringEligible,
}) {
  return pass({
    latency_ms: latencyMs ?? null,
    structured_query_count: structuredQueryCount ?? 0,
    document_retrieval_count: documentRetrievalCount ?? 0,
    model_call_attempt_count: modelCallAttemptCount ?? 0,
    model_call_success_count: modelCallSuccessCount ?? 0,
    model_call_failure_count: modelCallFailureCount ?? 0,
    input_tokens: inputTokens ?? null,
    output_tokens: outputTokens ?? null,
    estimated_cost: estimatedCost ?? null,
    model_fallback_used: modelFallbackUsed ?? false,
    scoring_eligible: scoringEligible ?? false,
  });
}
