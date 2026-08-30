// Turn P3: runs the same input through every registered Agent variant
// (by default all four: STRUCTURED_FIRST, HYBRID_RETRIEVAL, PLANNER,
// DOCUMENT_FIRST_RAG) and returns one independent ComparisonRecord per
// variant. This module never picks a winner, never reads Gold/HOLDOUT/
// Owner-decision data, and never computes a quality score -- it only
// proves the common contract (AgentFlow x ModelAdapter x telemetry)
// executes safely, in isolation, across all four variants given identical
// input.
//
// ISOLATION: each variant gets (a) its own instrumented ModelAdapter
// (domain/agent-comparison/telemetry.mjs's instrumentModelAdapter, fresh
// per variant -- usage counters can never mix), (b) its own AgentFlow
// instance (a fresh factory(...) call), and (c) a structuredClone of
// `input`/`context` (defense in depth -- no variant flow is observed to
// mutate these in place, but a comparison harness that shares mutable
// objects across independent runs is the wrong default regardless). The
// SAME `serviceAdapters` object is reused across all four calls, exactly
// like domain/agent-comparison/benchmark-runner.mjs already does across
// questions -- runAgentFlow's own createSharedServices constructs a fresh
// ValidationAuthority/budget/trace-recorder from it on every call, so
// reusing the raw adapters (stateless query functions over static
// bundle/fixture data) introduces no cross-variant state.
//
// ORDER INDEPENDENCE: `variantIds` is caller-controlled specifically so a
// test can run the same four in different orders and assert each
// variant's own answer_sha256/execution_trace_sha256 is unaffected by
// where it fell in the sequence (see
// tests/agent-comparison-integration-comparison.test.mjs).
//
// FAILURE ISOLATION: one variant's factory/registry lookup throwing is
// caught PER VARIANT -- it becomes that variant's own
// run_status="FAILED" ComparisonRecord (comparison-record.mjs's
// buildFailedComparisonRecord) and never aborts the remaining variants'
// runs, never leaks a raw exception message, and is never recorded as a
// success.
import { runAgentFlow } from "../../runtime/agent-runtime.mjs";
import { getAgentVariantFactory } from "../variant-registry.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "../telemetry.mjs";
import { computeModelConfigSha256 } from "../reproducibility.mjs";
import { buildComparisonRecord, buildFailedComparisonRecord } from "./comparison-record.mjs";

export const REQUIRED_VARIANT_IDS = Object.freeze(["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "PLANNER", "DOCUMENT_FIRST_RAG"]);

export class MissingAgentVariantRegistrationError extends Error {
  constructor(missing) {
    super(`missing agent variant registration(s): ${missing.join(", ")}`);
    this.name = "MissingAgentVariantRegistrationError";
    this.missing = missing;
  }
}

// Import domain/agent-comparison/integration/register-all-variants.mjs (for
// its side effects) before calling this -- it is intentionally NOT
// imported by this module itself, so a caller that only wants a SUBSET of
// variants registered (e.g. a future variant's own isolated test) is never
// forced to register all four just by importing this orchestrator.
export function assertAllFourVariantsRegistered(registeredVariantIds) {
  const registered = new Set(registeredVariantIds);
  const missing = REQUIRED_VARIANT_IDS.filter((id) => !registered.has(id));
  if (missing.length > 0) throw new MissingAgentVariantRegistrationError(missing);
}

function structuredCloneOrPlain(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

async function runOneVariant({
  variantId, modelAdapterFactory, agentVariantRevisions, modelConfigSha256, modelConfig,
  releaseId, releaseManifestSha256, input, context, executionScope, budgetLimits, serviceAdapters,
  benchmarkRunId, flowOptions,
}) {
  const agentVariantRevision = agentVariantRevisions?.[variantId] ?? "unknown";
  const datasetItemId = input?.question_id ?? null;
  const startedAt = Date.now();
  try {
    const factory = getAgentVariantFactory(variantId); // throws if not registered
    const baseModelAdapter = modelAdapterFactory();
    const { adapter: instrumentedAdapter, usage } = instrumentModelAdapter(baseModelAdapter);
    const flow = factory(instrumentedAdapter, flowOptions?.[variantId]);
    const isolatedInput = structuredCloneOrPlain(input);
    const isolatedContext = structuredCloneOrPlain(context);
    const outcome = await runAgentFlow(flow, isolatedInput, isolatedContext, budgetLimits, serviceAdapters);
    const telemetryEvent = buildTelemetryEvent({
      benchmarkRunId,
      agentVariantId: variantId,
      modelConfigId: modelConfig.model_config_id,
      executionScope,
      question: isolatedInput.question,
      questionId: datasetItemId,
      agentOutcome: outcome,
      modelUsage: usage(),
    });
    return buildComparisonRecord({
      telemetryEvent, agentVariantRevision, modelConfigSha256, releaseId, releaseManifestSha256,
      answerText: outcome.final_response.answer, executionTrace: outcome.execution_trace,
    });
  } catch (error) {
    const errorCode = typeof error?.code === "string" ? error.code : "AGENT_VARIANT_EXECUTION_ERROR";
    return buildFailedComparisonRecord({
      benchmarkRunId, agentVariantId: variantId, agentVariantRevision, modelConfigSha256,
      datasetItemId, releaseId, releaseManifestSha256, latencyMs: Date.now() - startedAt, errorCode,
    });
  }
}

// Runs `variantIds` (default: all four, in that fixed order) SEQUENTIALLY
// -- not Promise.all -- so that a caller who deliberately reverses/shuffles
// `variantIds` for an order-independence test observes a real, distinct
// execution order, not just an array literal reorder racing concurrently.
// Sequential execution also means one variant's failure can never affect
// another's even at the Node event-loop-scheduling level.
export async function runFourVariantComparison({
  variantIds = REQUIRED_VARIANT_IDS,
  modelAdapterFactory,
  agentVariantRevisions = {},
  modelConfig,
  releaseId,
  releaseManifestSha256,
  input,
  context,
  executionScope = "OFFICIAL",
  budgetLimits,
  serviceAdapters,
  benchmarkRunId,
  flowOptions,
}) {
  if (typeof modelAdapterFactory !== "function") throw new TypeError("runFourVariantComparison requires modelAdapterFactory: () => ModelAdapter");
  const modelConfigSha256 = computeModelConfigSha256(modelConfig);
  const records = [];
  for (const variantId of variantIds) {
    // eslint-disable-next-line no-await-in-loop
    const record = await runOneVariant({
      variantId, modelAdapterFactory, agentVariantRevisions, modelConfigSha256, modelConfig,
      releaseId, releaseManifestSha256, input, context, executionScope, budgetLimits, serviceAdapters,
      benchmarkRunId, flowOptions,
    });
    records.push(record);
  }
  return records;
}
