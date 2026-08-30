// Common observation/measurement contract (Turn P1; semantics hardened
// Turn P1.1). Every Agent variant produces the SAME telemetry fields
// regardless of its internal design, so runs can be compared apples-to-
// apples across the two axes (Agent design, base LLM) one at a time.
// Values are derived from three sources, never re-invented per variant:
//   - domain/runtime/agent-runtime.mjs's ExecutionTrace (already returned
//     by runAgentFlow: latency_ms, tool_calls, execution_mode,
//     fallback_reason) for everything the frozen Runtime Host already
//     measures.
//   - instrumentModelAdapter's own counters for the model-call-specific
//     fields ExecutionTrace does not cover (attempt/success/failure counts,
//     the last failure code, tokens, cost) -- ModelAdapter is not part of
//     SharedServices (see model-adapter.mjs), so it needs its own,
//     separate, per-invocation instrumentation.
//   - the AgentFlow's own think_trace.validation object (a free-form
//     field final-response.schema.json already allows) for the three
//     things only the Flow itself knows: whether a fallback answer was
//     substituted, what post-generation citation-binding verdict applied,
//     and how many unsupported hard claims were found. See
//     flows/structured-first-agent.mjs and flows/hard-claim-grounding.mjs.
import { randomUUID } from "node:crypto";
import { validateTelemetryEvent } from "./contracts.mjs";

// A fresh wrapper per AgentFlow invocation -- never share one instrumented
// adapter across two questions/runs, or their usage counters would mix.
//
// Turn P1.1: attempt is incremented the INSTANT generate() is called,
// before success/failure is known, so `attempt = success + failure`
// (asserted by tests/agent-comparison-model-adapter.test.mjs) holds even
// if the underlying call never settles cleanly. On failure, the error is
// counted and its `.code` recorded, then RETHROWN unchanged -- this
// wrapper never decides whether to fall back; only the calling AgentFlow
// does (see structured-first-agent.mjs's own try/catch around
// modelAdapter.generate()).
export function instrumentModelAdapter(modelAdapter) {
  let attempt = 0;
  let success = 0;
  let failure = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCost = 0;
  let lastFailureCode = null;
  const adapter = Object.freeze({
    modelConfigId: modelAdapter.modelConfigId,
    provider: modelAdapter.provider,
    model: modelAdapter.model,
    async generate(request) {
      attempt += 1;
      try {
        const result = await modelAdapter.generate(request);
        success += 1;
        inputTokens += Number.isFinite(result?.input_tokens) ? result.input_tokens : 0;
        outputTokens += Number.isFinite(result?.output_tokens) ? result.output_tokens : 0;
        estimatedCost += Number.isFinite(result?.estimated_cost) ? result.estimated_cost : 0;
        return result;
      } catch (error) {
        failure += 1;
        lastFailureCode = typeof error?.code === "string" ? error.code : "MODEL_CALL_UNKNOWN_ERROR";
        throw error;
      }
    },
  });
  return {
    adapter,
    usage() {
      return Object.freeze({
        model_call_attempt_count: attempt,
        model_call_success_count: success,
        model_call_failure_count: failure,
        model_failure_code: lastFailureCode,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        estimated_cost: estimatedCost,
      });
    },
  };
}

const ANSWERABILITY_TO_VALIDATION_STATUS = Object.freeze({
  SUPPORTED: "SUPPORTED",
  WITHHELD: "WITHHELD",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  UNANSWERABLE: "UNANSWERABLE",
});

function deriveValidationStatus(finalResponse) {
  const answerability = finalResponse?.think_trace?.validation?.answerability;
  return ANSWERABILITY_TO_VALIDATION_STATUS[answerability] ?? "NO_CLAIM_MADE";
}

// evidence_validation_success_rate (Turn P1.1 rename of v0.1's
// citation_accuracy): fraction of this request's validateEvidence attempts
// that actually succeeded (proof issued) -- a Runtime proof-issuance rate,
// NOT a citation-accuracy score against Gold, and NOT the same thing as
// citation_binding_status below (which checks the model's own answer TEXT,
// not the Validator's proof rate). null (not 0) when zero attempts were
// made: "no evidence was checked" is a different fact from "all checked
// evidence failed" and must not collapse to the same score.
function deriveEvidenceValidationSuccessRate(executionTrace) {
  const attempts = (executionTrace?.tool_calls ?? []).filter(
    (entry) => entry.service === "Validator" && entry.method === "validateEvidence",
  );
  if (attempts.length === 0) return null;
  const succeeded = attempts.filter((entry) => entry.ok === true).length;
  return succeeded / attempts.length;
}

function structuredQueryCount(executionTrace) {
  return (executionTrace?.tool_calls ?? []).filter((entry) => entry.service === "StructuredStore" && entry.method === "query").length;
}

function documentRetrievalCount(executionTrace) {
  return (executionTrace?.tool_calls ?? []).filter((entry) => entry.service === "Retriever" && entry.method === "retrieve").length;
}

// Builds and schema-validates ONE TelemetryEvent from the outputs of a
// single runAgentFlow call plus the matching instrumentModelAdapter usage
// snapshot. Throws (does not silently coerce) if the assembled record is
// not schema-valid -- a bug in this module must fail loudly here, not
// produce a telemetry record downstream tooling silently mis-parses.
export function buildTelemetryEvent({
  benchmarkRunId,
  agentVariantId,
  modelConfigId,
  executionScope,
  question,
  questionId = null,
  agentOutcome,
  modelUsage,
  createdAt = new Date().toISOString(),
  telemetryEventId = `telemetry_${randomUUID().replaceAll("-", "")}`,
}) {
  const finalResponse = agentOutcome.final_response;
  const executionTrace = agentOutcome.execution_trace ?? {};
  const validation = finalResponse?.think_trace?.validation ?? {};
  const usage = modelUsage ?? {
    model_call_attempt_count: 0, model_call_success_count: 0, model_call_failure_count: 0,
    model_failure_code: null, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
  };
  const fallbackReason = executionTrace.fallback_reason ?? null;
  const modelFallbackUsed = validation.model_fallback_used === true;
  const event = {
    schema_version: "0.2.0",
    telemetry_event_id: telemetryEventId,
    benchmark_run_id: benchmarkRunId,
    created_at: createdAt,
    question_id: questionId,
    agent_variant_id: agentVariantId,
    model_config_id: modelConfigId,
    execution_scope: executionScope,
    question,
    answer_text: finalResponse?.answer ?? "",
    execution_mode: finalResponse?.think_trace?.execution_mode ?? "EARLY_EXIT",
    validation_status: deriveValidationStatus(finalResponse),
    evidence_validation_success_rate: deriveEvidenceValidationSuccessRate(executionTrace),
    citation_binding_status: ["PASS", "FAIL", "NOT_CHECKED"].includes(validation.citation_binding_status)
      ? validation.citation_binding_status
      : "NOT_CHECKED",
    unsupported_claim_count: Number.isInteger(validation.unsupported_claim_count) ? validation.unsupported_claim_count : 0,
    structured_query_count: structuredQueryCount(executionTrace),
    document_retrieval_count: documentRetrievalCount(executionTrace),
    model_call_attempt_count: usage.model_call_attempt_count,
    model_call_success_count: usage.model_call_success_count,
    model_call_failure_count: usage.model_call_failure_count,
    model_fallback_used: modelFallbackUsed,
    model_failure_code: usage.model_failure_code,
    // A Flow may explicitly set scoring_eligible itself; otherwise it is
    // derived as the direct negation of model_fallback_used -- a fallback
    // row is never scoring_eligible by default, and a Flow cannot flip
    // that off without also explaining why via its own validation object.
    scoring_eligible: typeof validation.scoring_eligible === "boolean" ? validation.scoring_eligible : !modelFallbackUsed,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    estimated_cost: usage.estimated_cost,
    latency_ms: typeof executionTrace.latency_ms === "number" ? executionTrace.latency_ms : 0,
    timed_out: typeof fallbackReason === "string" && fallbackReason.startsWith("ABORTED:TIMEOUT"),
    error_code: typeof fallbackReason === "string" ? fallbackReason : null,
    fallback_reason: fallbackReason,
  };
  const errors = validateTelemetryEvent(event);
  if (errors.length > 0) throw new Error(`buildTelemetryEvent produced an invalid TelemetryEvent: ${errors.join("; ")}`);
  return Object.freeze(event);
}
