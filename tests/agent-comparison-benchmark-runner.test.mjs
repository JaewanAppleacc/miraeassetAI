import assert from "node:assert/strict";
import test from "node:test";
import { createBenchmarkRunManifest, runBenchmark } from "../domain/agent-comparison/benchmark-runner.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { validateBenchmarkRunManifest, validateTelemetryEvent } from "../domain/agent-comparison/contracts.mjs";
import "../domain/agent-comparison/register-default-variants.mjs";
import {
  CORPUS_SNAPSHOT_ID, FACT_COVERAGE_SNAPSHOT_ID, FIXTURE_FACT, syntheticContext, syntheticServiceAdapters,
} from "./lib/agent-comparison-fixture.mjs";

const FAKE_MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0", model_config_id: "model_fake-deterministic-v1", kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture", model: "deterministic-fake-v1",
});

function baseManifestArgs(questions) {
  return {
    agentVariantId: "STRUCTURED_FIRST",
    agentVariantRevision: "structured-first-agent-test-v1",
    modelConfig: FAKE_MODEL_CONFIG,
    promptTemplateId: "test-template-v1",
    promptTemplateSha256: "0".repeat(64),
    executionScope: "SANDBOX",
    datasetId: "synthetic-fixture-benchmark-runner-test",
    datasetRole: "SYNTHETIC_FIXTURE",
    questions,
    corpusSnapshotId: CORPUS_SNAPSHOT_ID,
    factCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
    codeRevision: "test-fixture-revision",
  };
}

test("runBenchmark produces one schema-valid TelemetryEvent per question and a schema-valid completed manifest, varying only what the caller asked to vary", async () => {
  const questions = [
    { question: "매출액이 얼마인가요?", question_id: "q_bench_01", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } },
    { question: "이 회사는 어떤가요?", question_id: "q_bench_02" },
  ];
  const manifest = createBenchmarkRunManifest(baseManifestArgs(questions));
  assert.deepEqual(validateBenchmarkRunManifest(manifest), []);
  assert.equal(manifest.dataset_ref.item_count, 2);
  assert.match(manifest.model_config_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.fallback_scoring_policy, "EXCLUDE_FALLBACK_FROM_MODEL_SCORING");

  const modelAdapter = createDeterministicFakeModelAdapter();
  const { manifest: completed, events } = await runBenchmark({
    manifest, modelAdapter, questions, context: syntheticContext(), serviceAdapters: syntheticServiceAdapters(),
  });

  assert.deepEqual(validateBenchmarkRunManifest(completed), []);
  assert.equal(completed.telemetry_event_count, 2);
  assert.ok(completed.completed_at);
  assert.equal(events.length, 2);
  for (const event of events) assert.deepEqual(validateTelemetryEvent(event), []);
  assert.equal(events[0].question_id, "q_bench_01");
  assert.equal(events[1].question_id, "q_bench_02");
  assert.equal(events[1].validation_status, "UNANSWERABLE");
  assert.equal(events[1].model_fallback_used, false);
  assert.equal(events[1].scoring_eligible, true);
});

test("createBenchmarkRunManifest: the same questions always produce the same dataset_sha256 (deterministic), and a different question set produces a different one", () => {
  const questionsA = [{ question: "q1", question_id: "id1" }, { question: "q2", question_id: "id2" }];
  const questionsB = [{ question: "q1", question_id: "id1" }, { question: "q2", question_id: "id2" }];
  const questionsC = [{ question: "q1-different", question_id: "id1" }];
  const manifestA = createBenchmarkRunManifest(baseManifestArgs(questionsA));
  const manifestB = createBenchmarkRunManifest(baseManifestArgs(questionsB));
  const manifestC = createBenchmarkRunManifest(baseManifestArgs(questionsC));
  assert.equal(manifestA.dataset_ref.dataset_sha256, manifestB.dataset_ref.dataset_sha256);
  assert.notEqual(manifestA.dataset_ref.dataset_sha256, manifestC.dataset_ref.dataset_sha256);
});

test("createBenchmarkRunManifest: the same ModelConfig always produces the same model_config_sha256, and a different config produces a different one", () => {
  const questions = [{ question: "q1" }];
  const manifestA = createBenchmarkRunManifest(baseManifestArgs(questions));
  const manifestB = createBenchmarkRunManifest(baseManifestArgs(questions));
  const differentConfig = { ...FAKE_MODEL_CONFIG, model: "a-different-model" };
  const manifestC = createBenchmarkRunManifest({ ...baseManifestArgs(questions), modelConfig: differentConfig });
  assert.equal(manifestA.model_config_sha256, manifestB.model_config_sha256);
  assert.notEqual(manifestA.model_config_sha256, manifestC.model_config_sha256);
});

test("createBenchmarkRunManifest rejects an invalid ModelConfig before producing a manifest", () => {
  const questions = [{ question: "q1" }];
  assert.throws(() => createBenchmarkRunManifest({ ...baseManifestArgs(questions), modelConfig: { ...FAKE_MODEL_CONFIG, model_config_id: "not valid" } }));
});

test("runBenchmark's per-question instrumented ModelAdapter usage never leaks across questions (variant/state isolation)", async () => {
  let callsMade = 0;
  const modelAdapter = { generate: async () => { callsMade += 1; return { text: `x ${callsMade}`, used_fact_ids: [], used_evidence_ids: [], input_tokens: 1, output_tokens: 1, estimated_cost: 0 }; } };
  const questions = [
    { question: "매출액이 얼마인가요?", question_id: "q_bench_03", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } },
    { question: "매출액이 얼마인가요?", question_id: "q_bench_04", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } },
  ];
  const manifest = createBenchmarkRunManifest(baseManifestArgs(questions));
  const { events } = await runBenchmark({ manifest, modelAdapter, questions, context: syntheticContext(), serviceAdapters: syntheticServiceAdapters() });
  assert.equal(events[0].model_call_attempt_count, 1);
  assert.equal(events[1].model_call_attempt_count, 1);
});

test("runBenchmark: a run where every question falls back (model always fails) still produces schema-valid telemetry, all marked scoring_eligible=false", async () => {
  const alwaysFailingAdapter = { generate: async () => { const err = new Error("simulated"); err.code = "MODEL_CALL_TIMEOUT"; throw err; } };
  const questions = [{ question: "매출액이 얼마인가요?", question_id: "q_bench_05", hints: { corp_codes: [FIXTURE_FACT.corp_code], metric_codes: [FIXTURE_FACT.metric_code] } }];
  const manifest = createBenchmarkRunManifest(baseManifestArgs(questions));
  const { events } = await runBenchmark({ manifest, modelAdapter: alwaysFailingAdapter, questions, context: syntheticContext(), serviceAdapters: syntheticServiceAdapters() });
  assert.equal(events[0].model_fallback_used, true);
  assert.equal(events[0].scoring_eligible, false);
  assert.equal(events[0].model_call_failure_count, 1);
  assert.deepEqual(validateTelemetryEvent(events[0]), []);
});
