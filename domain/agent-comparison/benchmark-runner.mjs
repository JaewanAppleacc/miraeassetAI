// Common benchmark driver (Turn P1; reproducibility pins added Turn P1.1).
// Runs ONE (agent_variant_id, model_config_id) combination over a list of
// questions through the existing, unmodified runAgentFlow
// (domain/runtime/agent-runtime.mjs), producing one schema-valid
// BenchmarkRunManifest and one schema-valid TelemetryEvent per question.
// This is the one place that varies the two comparison axes -- callers
// pick a variant AND a model config, but never change anything else about
// how a question is executed, so a difference in results is attributable
// to exactly the axis that was actually varied. The manifest pins enough
// (agent_variant_revision, model_config_sha256, prompt_template_sha256,
// dataset_sha256, temperature, determinism, cache_policy, code_revision,
// fallback_scoring_policy) that a later audit never needs the raw
// prompt/response text to know what produced a given telemetry set.
import { randomUUID } from "node:crypto";
import { runAgentFlow } from "../runtime/agent-runtime.mjs";
import { validateBenchmarkRunManifest, validateModelConfig } from "./contracts.mjs";
import { getAgentVariantFactory } from "./variant-registry.mjs";
import { instrumentModelAdapter, buildTelemetryEvent } from "./telemetry.mjs";
import { computeModelConfigSha256, computeDatasetSha256, detectCodeRevision } from "./reproducibility.mjs";

const DEFAULT_BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 });
export const DEFAULT_FALLBACK_SCORING_POLICY = "EXCLUDE_FALLBACK_FROM_MODEL_SCORING";

export function createBenchmarkRunManifest({
  agentVariantId,
  agentVariantRevision,
  modelConfig,
  promptTemplateId = null,
  promptTemplateSha256 = null,
  executionScope,
  datasetId,
  datasetRole,
  questions,
  corpusSnapshotId,
  factCoverageSnapshotId = null,
  temperature = null,
  maxOutputTokens = null,
  determinism = { seed: null, provider_deterministic_mode: null },
  cachePolicy = "NONE",
  codeRevision,
  fallbackScoringPolicy = DEFAULT_FALLBACK_SCORING_POLICY,
  budgetLimits = DEFAULT_BUDGET_LIMITS,
  benchmarkRunId = `benchmark_run_${randomUUID()}`,
  startedAt = new Date().toISOString(),
  notes = "",
}) {
  const modelConfigErrors = validateModelConfig(modelConfig);
  if (modelConfigErrors.length > 0) throw new Error(`createBenchmarkRunManifest received an invalid ModelConfig: ${modelConfigErrors.join("; ")}`);
  if (!Array.isArray(questions) || questions.length === 0) throw new TypeError("createBenchmarkRunManifest requires a non-empty questions array");

  const manifest = {
    schema_version: "0.2.0",
    benchmark_run_id: benchmarkRunId,
    created_at: startedAt,
    agent_variant_id: agentVariantId,
    agent_variant_revision: agentVariantRevision,
    model_config_id: modelConfig.model_config_id,
    model_config_sha256: computeModelConfigSha256(modelConfig),
    prompt_template_id: promptTemplateId,
    prompt_template_sha256: promptTemplateSha256,
    execution_scope: executionScope,
    dataset_ref: {
      dataset_id: datasetId,
      role: datasetRole,
      item_count: questions.length,
      dataset_sha256: computeDatasetSha256(questions),
    },
    corpus_snapshot_id: corpusSnapshotId,
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    temperature,
    max_output_tokens: maxOutputTokens,
    determinism,
    cache_policy: cachePolicy,
    code_revision: codeRevision ?? detectCodeRevision(),
    fallback_scoring_policy: fallbackScoringPolicy,
    budget_limits: budgetLimits,
    started_at: startedAt,
    completed_at: null,
    telemetry_event_count: null,
    notes,
  };
  const errors = validateBenchmarkRunManifest(manifest);
  if (errors.length > 0) throw new Error(`createBenchmarkRunManifest produced an invalid manifest: ${errors.join("; ")}`);
  return manifest;
}

// `questions`: [{ question, question_id? }, ...]. `modelAdapter` is the
// BASE (un-instrumented) adapter -- a fresh instrumented wrapper and a
// fresh Flow instance are created per question so usage counters and any
// Flow-local state never leak across questions.
export async function runBenchmark({
  manifest,
  modelAdapter,
  questions,
  context,
  serviceAdapters = {},
  budgetLimits = manifest.budget_limits,
  flowOptions,
}) {
  const factory = getAgentVariantFactory(manifest.agent_variant_id);
  const events = [];
  for (const item of questions) {
    const { adapter: instrumentedAdapter, usage } = instrumentModelAdapter(modelAdapter);
    const flow = factory(instrumentedAdapter, flowOptions);
    const input = { question: item.question, question_id: item.question_id, as_of_date: item.as_of_date, hints: item.hints };
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runAgentFlow(flow, input, context, budgetLimits, serviceAdapters);
    events.push(buildTelemetryEvent({
      benchmarkRunId: manifest.benchmark_run_id,
      agentVariantId: manifest.agent_variant_id,
      modelConfigId: manifest.model_config_id,
      executionScope: manifest.execution_scope,
      question: item.question,
      questionId: item.question_id ?? null,
      agentOutcome: outcome,
      modelUsage: usage(),
    }));
  }
  const completedManifest = {
    ...manifest,
    completed_at: new Date().toISOString(),
    telemetry_event_count: events.length,
  };
  const errors = validateBenchmarkRunManifest(completedManifest);
  if (errors.length > 0) throw new Error(`runBenchmark produced an invalid completed manifest: ${errors.join("; ")}`);
  return { manifest: completedManifest, events };
}
