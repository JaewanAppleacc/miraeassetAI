// Turn P6 section E/F: BenchmarkRunResult / BenchmarkComparisonReport
// aggregation -- synthetic fixtures only.
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRunResult, buildComparisonReport } from "../domain/agent-comparison/benchmark/report.mjs";
import { validateBenchmarkRunResult, validateBenchmarkComparisonReport } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { runBenchmark, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/benchmark/runner.mjs";
import { loadDatasetRecords } from "../domain/agent-comparison/benchmark/dataset.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ModelCallError } from "../domain/agent-comparison/model-adapter.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";
import {
  makeFixtureDatasetRecord, groundedFixtureResponder, benchmarkFixtureContext, benchmarkFixtureServiceAdapters,
  FAKE_MODEL_CONFIG, BENCHMARK_LIMITS,
} from "./lib/agent-comparison-benchmark-infra-fixture.mjs";

function runArgs(extra = {}) {
  return {
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({ responder: groundedFixtureResponder }),
    modelConfig: FAKE_MODEL_CONFIG,
    context: benchmarkFixtureContext(),
    budgetLimits: BENCHMARK_LIMITS,
    serviceAdapters: benchmarkFixtureServiceAdapters(),
    benchmarkRunId: "benchmark_run_report_test",
    ...extra,
  };
}

test("summarizeRunResult: aggregates a single eligible NORMAL_ANSWER item into a valid BenchmarkRunResult with mean/median 1 on every scored axis", async () => {
  const { manifest, records } = loadDatasetRecords([makeFixtureDatasetRecord()], { datasetId: "dataset_report_test_0001" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const runResult = summarizeRunResult({ benchmarkRunId: "benchmark_run_report_test", variantId: "STRUCTURED_FIRST", itemResults: results });

  assert.deepEqual(validateBenchmarkRunResult(runResult), []);
  assert.equal(runResult.item_count, 1);
  assert.equal(runResult.eligible_count, 1);
  assert.equal(runResult.ineligible_count, 0);
  assert.equal(runResult.outcome_category_counts.NORMAL_ANSWER, 1);
  assert.equal(runResult.axis_summary.numeric_claim.mean, 1);
  assert.equal(runResult.axis_summary.numeric_claim.median, 1);
  assert.equal(runResult.axis_summary.date_claim.mean, null); // NOT_APPLICABLE-only axis has nothing to average
});

test("summarizeRunResult: a scoring_eligible=false row is counted in ineligible_count/outcome_category_counts but excluded from every axis mean/median", async () => {
  const { manifest, records } = loadDatasetRecords([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_ineligible" })], { datasetId: "dataset_report_test_ineligible" });
  const failingModelAdapter = { generate: async () => { throw new ModelCallError("MODEL_CALL_TIMEOUT", "simulated timeout"); } };
  const results = await runBenchmark({
    datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"],
    ...runArgs({ modelAdapterFactory: () => failingModelAdapter }),
  });
  const runResult = summarizeRunResult({ benchmarkRunId: "benchmark_run_report_test", variantId: "STRUCTURED_FIRST", itemResults: results });

  assert.equal(runResult.item_count, 1);
  assert.equal(runResult.eligible_count, 0);
  assert.equal(runResult.ineligible_count, 1); // never dropped from failure-rate accounting
  assert.equal(runResult.outcome_category_counts.MODEL_CALL_FAILURE_FALLBACK, 1);
  for (const axis of Object.values(runResult.axis_summary)) {
    assert.equal(axis.n_scored, 0);
    assert.equal(axis.mean, null);
    assert.equal(axis.median, null);
    assert.equal(axis.skipped_count, 1);
  }
});

test("buildComparisonReport: identical item sets across all 4 variants -> identical_item_set=true, missing_items_by_variant={}", async () => {
  const { manifest, records } = loadDatasetRecords([makeFixtureDatasetRecord()], { datasetId: "dataset_report_test_identical" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, ...runArgs() });
  const report = buildComparisonReport({
    benchmarkRunId: "benchmark_run_report_test", datasetId: manifest.dataset_id, datasetSha256: manifest.dataset_sha256,
    codeRevision: "unknown", allItemResults: results,
  });

  assert.deepEqual(validateBenchmarkComparisonReport(report), []);
  assert.equal(report.variant_run_results.length, 4);
  assert.equal(report.identical_item_set, true);
  assert.deepEqual(report.missing_items_by_variant, {});
  assert.equal(report.ranking_performed, false);
  assert.equal(report.holdout_accessed, false);
  assert.equal(report.official_gold_accessed, false);
  assert.equal(report.model_config_differences.length, 4);
  const sha256set = new Set(report.model_config_differences.map((d) => d.model_config_sha256));
  assert.equal(sha256set.size, 1); // same FAKE_MODEL_CONFIG across all 4 -- model config held fixed
});

test("buildComparisonReport: a variant missing an item (a real gap, e.g. that variant's own run never produced a result for it) is surfaced as identical_item_set=false + missing_items_by_variant", async () => {
  const itemA = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_missing_a" });
  const itemB = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_missing_b" });
  const { manifest: manifestA, records: recordsA } = loadDatasetRecords([itemA], { datasetId: "dataset_report_test_missing" });
  const { manifest: manifestB, records: recordsB } = loadDatasetRecords([itemB], { datasetId: "dataset_report_test_missing" });

  const resultsStructuredFirst = await runBenchmark({ datasetManifest: manifestA, datasetRecords: [...recordsA, ...recordsB], variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const resultsHybrid = await runBenchmark({ datasetManifest: manifestB, datasetRecords: recordsB, variantIds: ["HYBRID_RETRIEVAL"], ...runArgs() });

  const report = buildComparisonReport({
    benchmarkRunId: "benchmark_run_report_test", datasetId: manifestA.dataset_id, datasetSha256: manifestA.dataset_sha256,
    codeRevision: "unknown", allItemResults: [...resultsStructuredFirst, ...resultsHybrid],
  });

  assert.equal(report.identical_item_set, false);
  assert.deepEqual(report.missing_items_by_variant.HYBRID_RETRIEVAL, ["evaluation_item_report_missing_a"]);
  assert.ok(!("STRUCTURED_FIRST" in report.missing_items_by_variant)); // STRUCTURED_FIRST ran the full union, nothing missing for it
});

test("buildComparisonReport: this Turn's schema fixes ranking_performed/holdout_accessed/official_gold_accessed to false -- the schema itself rejects any attempt to set them true", async () => {
  const { manifest, records } = loadDatasetRecords([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_const_check" })], { datasetId: "dataset_report_test_const" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const report = buildComparisonReport({
    benchmarkRunId: "benchmark_run_report_test", datasetId: manifest.dataset_id, datasetSha256: manifest.dataset_sha256,
    codeRevision: "unknown", allItemResults: results,
  });
  const tampered = { ...report, ranking_performed: true };
  const errors = validateBenchmarkComparisonReport(tampered);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((message) => message.includes("ranking_performed")));
});
