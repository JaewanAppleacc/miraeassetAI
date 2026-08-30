// Turn P3: projects an existing, unmodified TelemetryEvent
// (domain/agent-comparison/telemetry.mjs's buildTelemetryEvent) plus the
// reproducibility/release pins into a ComparisonRecord -- it does not
// recompute anything TelemetryEvent already derived correctly (execution
// mode, the three model-call counts, citation_binding_status,
// unsupported_claim_count, evidence_validation_success_rate,
// scoring_eligible). It only (a) drops raw text fields
// (question/answer_text) in favor of a dataset_item_id/answer_sha256, and
// (b) adds the fields TelemetryEvent has no reason to know about
// (agent_variant_revision, model_config_sha256, release_id,
// release_manifest_sha256, execution_trace_sha256, run_status).
import { validateComparisonRecord } from "./contracts.mjs";
import { computeAnswerSha256, computeExecutionTraceSha256 } from "./determinism.mjs";

export function buildComparisonRecord({
  telemetryEvent,
  agentVariantRevision,
  modelConfigSha256,
  releaseId,
  releaseManifestSha256,
  answerText,
  executionTrace,
}) {
  const record = {
    schema_version: "0.1.0",
    benchmark_run_id: telemetryEvent.benchmark_run_id,
    agent_variant_id: telemetryEvent.agent_variant_id,
    agent_variant_revision: agentVariantRevision,
    model_config_sha256: modelConfigSha256,
    dataset_item_id: telemetryEvent.question_id ?? null,
    release_id: releaseId,
    release_manifest_sha256: releaseManifestSha256,
    execution_mode: telemetryEvent.execution_mode,
    structured_query_count: telemetryEvent.structured_query_count,
    document_retrieval_count: telemetryEvent.document_retrieval_count,
    model_call_attempt_count: telemetryEvent.model_call_attempt_count,
    model_call_success_count: telemetryEvent.model_call_success_count,
    model_call_failure_count: telemetryEvent.model_call_failure_count,
    model_fallback_used: telemetryEvent.model_fallback_used,
    model_failure_code: telemetryEvent.model_failure_code,
    citation_binding_status: telemetryEvent.citation_binding_status,
    unsupported_claim_count: telemetryEvent.unsupported_claim_count,
    evidence_validation_success_rate: telemetryEvent.evidence_validation_success_rate,
    scoring_eligible: telemetryEvent.scoring_eligible,
    latency_ms: telemetryEvent.latency_ms,
    answer_sha256: computeAnswerSha256(answerText),
    execution_trace_sha256: computeExecutionTraceSha256(executionTrace),
    run_status: "OK",
  };
  const errors = validateComparisonRecord(record);
  if (errors.length > 0) throw new Error(`buildComparisonRecord produced an invalid ComparisonRecord: ${errors.join("; ")}`);
  return Object.freeze(record);
}

// Used ONLY when the comparison harness itself could not obtain a
// FinalResponse/ExecutionTrace for this variant at all (unregistered
// variant_id, factory construction threw, or some other error outside
// runAgentFlow's own always-succeeds contract). `errorCode` must be a
// stable, non-leaking code -- never the raw Error.message (which could
// contain a stack frame, a file path, or arbitrary internal detail).
export function buildFailedComparisonRecord({
  benchmarkRunId,
  agentVariantId,
  agentVariantRevision,
  modelConfigSha256,
  datasetItemId,
  releaseId,
  releaseManifestSha256,
  latencyMs,
  errorCode,
}) {
  const record = {
    schema_version: "0.1.0",
    benchmark_run_id: benchmarkRunId,
    agent_variant_id: agentVariantId,
    agent_variant_revision: agentVariantRevision,
    model_config_sha256: modelConfigSha256,
    dataset_item_id: datasetItemId ?? null,
    release_id: releaseId,
    release_manifest_sha256: releaseManifestSha256,
    execution_mode: "EARLY_EXIT",
    structured_query_count: 0,
    document_retrieval_count: 0,
    model_call_attempt_count: 0,
    model_call_success_count: 0,
    model_call_failure_count: 0,
    model_fallback_used: false,
    model_failure_code: typeof errorCode === "string" ? errorCode : "AGENT_VARIANT_EXECUTION_ERROR",
    citation_binding_status: "NOT_CHECKED",
    unsupported_claim_count: 0,
    evidence_validation_success_rate: null,
    scoring_eligible: false,
    latency_ms: Number.isFinite(latencyMs) ? latencyMs : 0,
    answer_sha256: null,
    execution_trace_sha256: null,
    run_status: "FAILED",
  };
  const errors = validateComparisonRecord(record);
  if (errors.length > 0) throw new Error(`buildFailedComparisonRecord produced an invalid ComparisonRecord: ${errors.join("; ")}`);
  return Object.freeze(record);
}
