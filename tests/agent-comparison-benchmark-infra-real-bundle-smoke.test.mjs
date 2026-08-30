// Turn P6 clean-worktree requirement: runs the common Benchmark Runner +
// Gold-blind scorers over the REAL, already-approved v0.20-r3 bundle --
// materialized read-only via domain/agent-comparison/seed-bundle-harness.mjs
// (unmodified, Turn P1), the same pattern
// tests/agent-comparison-integration-real-bundle-smoke.test.mjs already
// uses for the four-variant integration harness. Queries broadly (no fixed
// question list), builds its OWN synthetic DatasetRecord from whatever
// real VERIFIED Fact the probe happens to find (values only, never a
// hardcoded corp_code/document_id/question_id) -- this is still a
// synthetic evaluation item (not Gold: expected_* here is derived FROM the
// real Fact's own already-VERIFIED values purely to exercise the scoring
// pipeline end-to-end, never read from or compared against a real
// expected-answer/Gold record, which does not exist for this Turn). No
// real network call, FAKE_DETERMINISTIC only.
import assert from "node:assert/strict";
import test from "node:test";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import { runBenchmark, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/benchmark/runner.mjs";
import { loadDatasetRecords } from "../domain/agent-comparison/benchmark/dataset.mjs";
import { buildComparisonReport } from "../domain/agent-comparison/benchmark/report.mjs";
import { validateBenchmarkItemResult, validateBenchmarkComparisonReport } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";

const BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 50, timeoutMs: 30000 });
const MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0", model_config_id: "model_fake-deterministic-v1", kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture", model: "deterministic-fake-v1",
});

let harness;
let sample;
let datasetManifest;
let datasetRecords;

test.before(async () => {
  harness = await createSeedBundleHarness({ root: process.cwd() });

  const probeQuery = {
    schema_version: "0.2.0", query_id: "query_benchmark_infra_real_bundle_smoke_probe", execution_scope: "OFFICIAL",
    corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
    targets: ["FACT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
  };
  const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
  assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
  sample = probeResult.records[0].payload;

  const datasetRecord = {
    schema_version: "0.1.0",
    evaluation_item_id: "evaluation_item_benchmark_infra_real_bundle_smoke_01",
    question: "benchmark infra real bundle smoke question",
    as_of_date: "2030-01-01",
    hints: { corp_codes: [sample.corp_code], metric_codes: [sample.metric_code], document_ids: [], event_types: [], period_filter: { start: null, end: null, period_types: [] }, scope_filter: [] },
    split: "DEV_TUNE",
    evaluation_group_id: null,
    chain_component_id: null,
    expected_answerability: "SUPPORTED",
    expected_facts: [{ fact_id: sample.fact_id, semantic_slot: null, corp_code: sample.corp_code, metric_code: sample.metric_code, required: true }],
    expected_events: [],
    expected_relations: [],
    expected_numeric_claims: [{ value: sample.normalized_value, unit: typeof sample.unit === "string" ? sample.unit : "KRW", unit_conversion_allowed: false, role: "real_bundle_smoke_value" }],
    expected_date_claims: [],
    allowed_evidence_ids: sample.evidence_ids ?? [],
    grading_policy_version: "grading_policy_real_bundle_smoke_v0.1",
  };
  ({ manifest: datasetManifest, records: datasetRecords } = loadDatasetRecords([datasetRecord], { datasetId: "dataset_benchmark_infra_real_bundle_smoke" }));
});

test.after(async () => {
  if (harness) await harness.dispose();
});

function runAgainstRealBundle(overrides = {}) {
  return runBenchmark({
    datasetManifest, datasetRecords,
    variantIds: REQUIRED_VARIANT_IDS,
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: `값은 ${sample.normalized_value}${sample.unit === "KRW" ? "원" : sample.unit === "PERCENT" ? "%" : ""}입니다.`, used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    }),
    modelConfig: MODEL_CONFIG,
    context: { ...harness.context, as_of_date: "2030-01-01" },
    budgetLimits: BUDGET_LIMITS,
    serviceAdapters: harness.serviceAdapters,
    benchmarkRunId: "benchmark_run_infra_real_bundle_smoke",
    ...overrides,
  });
}

test("real bundle smoke: all four variants produce a schema-valid BenchmarkItemResult over the same real VERIFIED Fact", async () => {
  const results = await runAgainstRealBundle();
  assert.equal(results.length, 4);
  for (const result of results) {
    assert.deepEqual(validateBenchmarkItemResult(result), [], result.variant_id);
    assert.equal(result.dataset_sha256, datasetManifest.dataset_sha256);
  }
  assert.equal(new Set(results.map((r) => r.model_config_sha256)).size, 1);
});

test("real bundle smoke: STRUCTURED_FIRST grounds and PASSes citation binding on the real Fact -- numeric_claim/citation/fact_coverage axes all PASS", async () => {
  const results = await runAgainstRealBundle({ variantIds: ["STRUCTURED_FIRST"] });
  const [result] = results;
  assert.equal(result.outcome_category, "NORMAL_ANSWER");
  assert.equal(result.citation_binding_status, "PASS");
  assert.equal(result.scoring_eligible, true);
  assert.equal(result.scoring.axes.numeric_claim.status, "PASS");
  assert.equal(result.scoring.axes.citation.status, "PASS");
  assert.equal(result.scoring.axes.fact_coverage.status, "PASS");
});

test("real bundle smoke: DOCUMENT_FIRST_RAG (no real Retriever adapter wired) reports an honest information limit rather than a disguised success -- and this is still a normal, scoring_eligible=true row, not a harness failure", async () => {
  const results = await runAgainstRealBundle({ variantIds: ["DOCUMENT_FIRST_RAG"] });
  const [result] = results;
  assert.equal(result.run_status, "OK");
  assert.equal(result.outcome_category, "NORMAL_INFORMATION_LIMIT");
  assert.equal(result.model_fallback_used, false);
  assert.equal(result.scoring_eligible, true);
});

test("real bundle smoke: a hallucinated number is rejected fail-closed for every variant that reaches a model call, scoring_eligible=false", async () => {
  const results = await runAgainstRealBundle({
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: "값은 999,999,999,999,999입니다.", used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    }),
  });
  for (const result of results) {
    if (result.model_call_attempt_count > 0) {
      assert.equal(result.citation_binding_status, "FAIL", result.variant_id);
      assert.equal(result.scoring_eligible, false, result.variant_id);
      for (const axis of Object.values(result.scoring.axes)) assert.equal(axis.status, "SKIPPED");
    }
  }
});

test("real bundle smoke: buildComparisonReport over the real-bundle run is schema-valid with ranking_performed=false/holdout_accessed=false/official_gold_accessed=false", async () => {
  const results = await runAgainstRealBundle();
  const report = buildComparisonReport({
    benchmarkRunId: "benchmark_run_infra_real_bundle_smoke", datasetId: datasetManifest.dataset_id, datasetSha256: datasetManifest.dataset_sha256,
    codeRevision: "unknown", allItemResults: results,
  });
  assert.deepEqual(validateBenchmarkComparisonReport(report), []);
  assert.equal(report.identical_item_set, true);
  assert.equal(report.ranking_performed, false);
  assert.equal(report.holdout_accessed, false);
  assert.equal(report.official_gold_accessed, false);
});
