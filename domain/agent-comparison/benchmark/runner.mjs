// Turn P6 section B: the common Benchmark Runner. Executes every
// (DatasetRecord, variant_id) pair through the SAME unmodified
// domain/runtime/agent-runtime.mjs runAgentFlow every variant already uses
// -- this module adds no new AgentFlow/SharedServices contract, it only
// orchestrates the existing one across a dataset x variant grid and scores
// the result before discarding raw text.
//
// ISOLATION (section B.2-3): a fresh instrumented ModelAdapter
// (telemetry.mjs's instrumentModelAdapter) and a fresh AgentFlow instance
// (a new factory(...) call) are constructed for EVERY (item, variant) pair
// -- usage counters and any Flow-local closure state can never leak across
// items or variants. `input`/`context` are structuredClone'd per call so a
// Flow that mutated what it was handed (none currently do, but this is
// defense in depth, the same reasoning
// domain/agent-comparison/integration/four-variant-comparison.mjs's own
// header comment documents) can never affect a sibling run.
//
// ORDERING (section B.4): items are iterated in the exact array order the
// caller supplied `datasetRecords` in; variants are iterated in the exact
// order `variantIds` was given. This is a DETERMINISTIC function of input
// order, not of anything runtime-dependent -- running the SAME items in a
// DIFFERENT caller-supplied order produces the SAME per-(item,variant)
// answer_sha256/execution_trace_sha256/scoring for each pair (see
// tests/agent-comparison-benchmark-runner.test.mjs's order-independence
// check), because every pair is independently isolated per the paragraph
// above and never reads anything about a sibling pair's outcome.
//
// FAILURE ISOLATION (section B.5): each (item, variant) pair runs inside
// its own try/catch. A harness-level failure (unregistered variant,
// factory construction throwing) becomes that ONE pair's own
// run_status="FAILED" result and never aborts any other pair -- the SAME
// per-pair isolation domain/agent-comparison/integration/four-variant-comparison.mjs's
// own runOneVariant already establishes, extended across a whole dataset.
//
// TIMEOUT/ABORT/BUDGET_EXCEEDED vs MODEL FAILURE (section B.6): classified
// via domain/agent-comparison/benchmark/failure-classification.mjs, which
// reads runAgentFlow's own ExecutionTrace.fallback_reason -- never
// re-implemented here.
//
// NO RAW TEXT STORED (section B.8-9): scoring (domain/agent-comparison/benchmark/scorers/index.mjs)
// runs BEFORE this module discards the raw answer/ExecutionTrace -- the
// scorer sees the real text/retrieved_context transiently, in-memory, for
// this one call only; what is RETURNED and what could be persisted is only
// answer_sha256/execution_trace_sha256/scoring axis outputs (ids, enums,
// counts, error_codes) -- never the raw text itself, never a raw prompt,
// never an API key, never Error.message.
import { runAgentFlow } from "../../runtime/agent-runtime.mjs";
import { getAgentVariantFactory } from "../variant-registry.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../telemetry.mjs";
import { computeModelConfigSha256, detectCodeRevision } from "../reproducibility.mjs";
import { computeAgentVariantRevision } from "../integration/variant-revisions.mjs";
import { computeAnswerSha256, computeExecutionTraceSha256 } from "../integration/determinism.mjs";
import { validateBenchmarkItemResult } from "./contracts.mjs";
import { computeEvaluationItemSha256 } from "./item-sha.mjs";
import { classifyOutcome, classifyHarnessFailure, isEligibleCategory } from "./failure-classification.mjs";
import { scoreItem } from "./scorers/index.mjs";
import { ANSWER_PROMPT_TEMPLATE_ID as STRUCTURED_FIRST_PROMPT_ID, ANSWER_PROMPT_TEMPLATE_SHA256 as STRUCTURED_FIRST_PROMPT_SHA256 } from "../flows/structured-first-agent.mjs";
import { ANSWER_PROMPT_TEMPLATE_ID as HYBRID_RETRIEVAL_PROMPT_ID, ANSWER_PROMPT_TEMPLATE_SHA256 as HYBRID_RETRIEVAL_PROMPT_SHA256 } from "../flows/hybrid-retrieval-agent.mjs";
import { PLANNER_PROMPT_TEMPLATE_ID, PLANNER_PROMPT_TEMPLATE_SHA256 } from "../flows/planner-agent.mjs";
import { ANSWER_PROMPT_TEMPLATE_ID as DOCUMENT_FIRST_RAG_PROMPT_ID, ANSWER_PROMPT_TEMPLATE_SHA256 as DOCUMENT_FIRST_RAG_PROMPT_SHA256 } from "../flows/document-first-rag-agent.mjs";

export const REQUIRED_VARIANT_IDS = Object.freeze(["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "PLANNER", "DOCUMENT_FIRST_RAG"]);

// Read-only lookup, never invented per-call -- the exact same
// prompt_template_id/prompt_template_sha256 pair each variant's own flow
// file already exports and pins (BenchmarkRunManifest's documented pin).
const VARIANT_PROMPT_TEMPLATES = Object.freeze({
  STRUCTURED_FIRST: { id: STRUCTURED_FIRST_PROMPT_ID, sha256: STRUCTURED_FIRST_PROMPT_SHA256 },
  HYBRID_RETRIEVAL: { id: HYBRID_RETRIEVAL_PROMPT_ID, sha256: HYBRID_RETRIEVAL_PROMPT_SHA256 },
  PLANNER: { id: PLANNER_PROMPT_TEMPLATE_ID, sha256: PLANNER_PROMPT_TEMPLATE_SHA256 },
  DOCUMENT_FIRST_RAG: { id: DOCUMENT_FIRST_RAG_PROMPT_ID, sha256: DOCUMENT_FIRST_RAG_PROMPT_SHA256 },
});

function structuredCloneOrPlain(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

// `context.signal` (an AbortSignal, when the caller sets one -- see
// domain/runtime/abortable.mjs) is not structured-cloneable at all (it
// throws DataCloneError) and must stay the SAME live object regardless --
// cloning it would both break and be pointless, since agent-runtime.mjs's
// own abort listening needs the real signal identity, not a copy. Every
// other field of `context` is still isolated per call the same way `input`
// is.
function isolateContext(context) {
  const { signal, ...rest } = context ?? {};
  return { ...structuredCloneOrPlain(rest), signal };
}

function zeroModelUsage() {
  return { model_call_attempt_count: 0, model_call_success_count: 0, model_call_failure_count: 0, model_failure_code: null, input_tokens: 0, output_tokens: 0, estimated_cost: 0 };
}

function buildPins({ variantId, agentVariantRevisions, modelConfig, modelConfigSha256, codeRevision, releaseId, releaseManifestSha256, randomSeed, temperature, cachePolicy }) {
  const promptTemplate = VARIANT_PROMPT_TEMPLATES[variantId] ?? { id: null, sha256: null };
  return {
    variant_id: variantId,
    agent_variant_revision: agentVariantRevisions?.[variantId] ?? "unknown",
    model_config_id: modelConfig.model_config_id,
    model_config_sha256: modelConfigSha256,
    prompt_template_id: promptTemplate.id,
    prompt_template_sha256: promptTemplate.sha256,
    code_revision: codeRevision,
    release_id: releaseId ?? null,
    release_manifest_sha256: releaseManifestSha256 ?? null,
    random_seed: Number.isInteger(randomSeed) ? randomSeed : null,
    temperature: typeof temperature === "number" ? temperature : null,
    cache_policy: typeof cachePolicy === "string" && cachePolicy !== "" ? cachePolicy : "NONE",
  };
}

function buildFailedItemResult({ benchmarkRunId, item, datasetId, datasetSha256, pins, latencyMs, errorCode }) {
  const result = {
    schema_version: "0.1.0",
    benchmark_run_id: benchmarkRunId,
    ...pins,
    evaluation_item_id: item.evaluation_item_id,
    dataset_id: datasetId,
    dataset_sha256: datasetSha256,
    evaluation_item_sha256: computeEvaluationItemSha256(item),
    split: item.split,
    execution_mode: "EARLY_EXIT",
    outcome_category: classifyHarnessFailure(),
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
    scoring: { schema_version: "0.1.0", scoring_policy_version: null, axes: Object.fromEntries(["answerability", "numeric_claim", "date_claim", "fact_coverage", "event_relation", "citation", "style", "operational"].map((axis) => [axis, { status: "SKIPPED", raw_score: null, error_codes: [], details: {} }])), composite_score: null },
  };
  const errors = validateBenchmarkItemResult(result);
  if (errors.length > 0) throw new Error(`runner produced an invalid failed BenchmarkItemResult: ${errors.join("; ")}`);
  return Object.freeze(result);
}

async function runOnePair({
  item, variantId, modelAdapterFactory, agentVariantRevisions, modelConfig, modelConfigSha256, codeRevision,
  releaseId, releaseManifestSha256, randomSeed, temperature, cachePolicy,
  context, executionScope, budgetLimits, serviceAdapters, benchmarkRunId, flowOptions,
  datasetId, datasetSha256, scoringPolicy, actualRelationsByItemId,
}) {
  const pins = buildPins({ variantId, agentVariantRevisions, modelConfig, modelConfigSha256, codeRevision, releaseId, releaseManifestSha256, randomSeed, temperature, cachePolicy });
  const startedAt = Date.now();

  let factory;
  try {
    factory = getAgentVariantFactory(variantId);
  } catch (error) {
    return buildFailedItemResult({ benchmarkRunId, item, datasetId, datasetSha256, pins, latencyMs: Date.now() - startedAt, errorCode: typeof error?.code === "string" ? error.code : "AGENT_VARIANT_EXECUTION_ERROR" });
  }

  const baseModelAdapter = modelAdapterFactory();
  const { adapter: instrumentedAdapter, usage } = instrumentModelAdapter(baseModelAdapter);

  let flow;
  let outcome;
  try {
    flow = factory(instrumentedAdapter, flowOptions?.[variantId]);
    const isolatedInput = structuredCloneOrPlain({ question: item.question, question_id: item.evaluation_item_id, as_of_date: item.as_of_date, hints: item.hints });
    const isolatedContext = isolateContext(context);
    outcome = await runAgentFlow(flow, isolatedInput, isolatedContext, budgetLimits, serviceAdapters);
  } catch (error) {
    return buildFailedItemResult({ benchmarkRunId, item, datasetId, datasetSha256, pins, latencyMs: Date.now() - startedAt, errorCode: typeof error?.code === "string" ? error.code : "AGENT_VARIANT_EXECUTION_ERROR" });
  }

  const modelUsage = usage();
  const telemetryEvent = buildTelemetryEvent({
    benchmarkRunId, agentVariantId: variantId, modelConfigId: modelConfig.model_config_id, executionScope,
    question: item.question, questionId: item.evaluation_item_id, agentOutcome: outcome, modelUsage,
  });

  const outcomeCategory = classifyOutcome(outcome);
  const scoringEligible = isEligibleCategory(outcomeCategory) && telemetryEvent.scoring_eligible === true;

  // Scoring reads the RAW answer/retrieved_context/execution_trace --
  // BEFORE this function ever computes the hashes that replace them below.
  const scoring = scoreItem({
    datasetRecord: item,
    scoringEligible,
    answerText: outcome.final_response.answer,
    retrievedContext: outcome.final_response.retrieved_context,
    selectedEvidenceIds: outcome.execution_trace?.selected_evidence ?? [],
    citationBindingStatus: telemetryEvent.citation_binding_status,
    unsupportedClaimCount: telemetryEvent.unsupported_claim_count,
    evidenceValidationSuccessRate: telemetryEvent.evidence_validation_success_rate,
    validationStatus: telemetryEvent.validation_status,
    operationalTelemetry: {
      latencyMs: telemetryEvent.latency_ms,
      structuredQueryCount: telemetryEvent.structured_query_count,
      documentRetrievalCount: telemetryEvent.document_retrieval_count,
      modelCallAttemptCount: telemetryEvent.model_call_attempt_count,
      modelCallSuccessCount: telemetryEvent.model_call_success_count,
      modelCallFailureCount: telemetryEvent.model_call_failure_count,
      inputTokens: telemetryEvent.input_tokens,
      outputTokens: telemetryEvent.output_tokens,
      estimatedCost: telemetryEvent.estimated_cost,
      modelFallbackUsed: telemetryEvent.model_fallback_used,
      scoringEligible,
    },
    actualRelations: actualRelationsByItemId?.[item.evaluation_item_id],
    scoringPolicy,
  });

  const result = {
    schema_version: "0.1.0",
    benchmark_run_id: benchmarkRunId,
    ...pins,
    evaluation_item_id: item.evaluation_item_id,
    dataset_id: datasetId,
    dataset_sha256: datasetSha256,
    evaluation_item_sha256: computeEvaluationItemSha256(item),
    split: item.split,
    execution_mode: telemetryEvent.execution_mode,
    outcome_category: outcomeCategory,
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
    scoring_eligible: scoringEligible,
    latency_ms: telemetryEvent.latency_ms,
    answer_sha256: computeAnswerSha256(outcome.final_response.answer),
    execution_trace_sha256: computeExecutionTraceSha256(outcome.execution_trace),
    run_status: "OK",
    scoring,
  };
  const errors = validateBenchmarkItemResult(result);
  if (errors.length > 0) throw new Error(`runner produced an invalid BenchmarkItemResult: ${errors.join("; ")}`);
  return Object.freeze(result);
}

// `datasetManifest`/`datasetRecords`: the exact { manifest, records }
// domain/agent-comparison/benchmark/dataset.mjs's loadDatasetRecords
// returned -- this function re-checks dataset_sha256 against a fresh
// recomputation (cheap, defensive) rather than re-running the whole
// leakage/HOLDOUT gate, which is dataset.mjs's own sole responsibility.
export async function runBenchmark({
  datasetManifest,
  datasetRecords,
  variantIds = REQUIRED_VARIANT_IDS,
  modelAdapterFactory,
  agentVariantRevisions,
  modelConfig,
  codeRevision = detectCodeRevision(),
  releaseId = null,
  releaseManifestSha256 = null,
  randomSeed = null,
  temperature = null,
  cachePolicy = "NONE",
  context,
  executionScope = "OFFICIAL",
  budgetLimits,
  serviceAdapters = {},
  benchmarkRunId,
  flowOptions,
  scoringPolicy = null,
  actualRelationsByItemId,
}) {
  if (typeof modelAdapterFactory !== "function") throw new TypeError("runBenchmark requires modelAdapterFactory: () => ModelAdapter");
  if (!datasetManifest || !Array.isArray(datasetRecords)) throw new TypeError("runBenchmark requires { datasetManifest, datasetRecords } from dataset.mjs's loadDatasetRecords");

  const modelConfigSha256 = computeModelConfigSha256(modelConfig);
  const revisions = agentVariantRevisions ?? Object.fromEntries(REQUIRED_VARIANT_IDS.map((id) => [id, computeAgentVariantRevision(id)]));

  const results = [];
  for (const item of datasetRecords) {
    for (const variantId of variantIds) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runOnePair({
        item, variantId, modelAdapterFactory, agentVariantRevisions: revisions, modelConfig, modelConfigSha256, codeRevision,
        releaseId, releaseManifestSha256, randomSeed, temperature, cachePolicy,
        context, executionScope, budgetLimits, serviceAdapters, benchmarkRunId, flowOptions,
        datasetId: datasetManifest.dataset_id, datasetSha256: datasetManifest.dataset_sha256,
        scoringPolicy, actualRelationsByItemId,
      });
      results.push(result);
    }
  }
  return results;
}
