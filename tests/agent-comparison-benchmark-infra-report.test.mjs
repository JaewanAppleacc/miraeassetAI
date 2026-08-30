// Turn P6 section E/F: BenchmarkRunResult / BenchmarkComparisonReport
// aggregation -- synthetic fixtures only.
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRunResult, buildComparisonReport, buildComparisonReportV0_2 } from "../domain/agent-comparison/benchmark/report.mjs";
import { validateBenchmarkRunResult, validateBenchmarkComparisonReport, validateBenchmarkComparisonReportV0_2 } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { runBenchmark, REQUIRED_VARIANT_IDS, redactAxisDetailsForHoldout } from "../domain/agent-comparison/benchmark/runner.mjs";
import { loadDatasetRecords, loadDatasetRecordsV0_2 } from "../domain/agent-comparison/benchmark/dataset.mjs";
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
    // Pinned to the SAME "unknown" value every buildComparisonReport/
    // buildComparisonReportV0_2 call below passes as its own codeRevision --
    // buildComparisonReportV0_2's pin-consistency check requires every
    // item's own code_revision to match the report's codeRevision exactly.
    codeRevision: "unknown",
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

// Turn P6.1: redactAxisDetailsForHoldout -- direct unit coverage of the
// redaction rule itself (status/raw_score/error_codes untouched, `details`
// stripped to at most matched_count/expected_count plus a redacted marker).
test("redactAxisDetailsForHoldout: strips every axis's details down to at most matched_count/expected_count plus a redacted marker, leaving status/raw_score/error_codes untouched", () => {
  const scoring = {
    schema_version: "0.1.0",
    scoring_policy_version: null,
    composite_score: null,
    axes: {
      numeric_claim: {
        status: "FAIL", raw_score: 0.5, error_codes: ["UNIT_MISMATCH"],
        details: { matched_count: 1, expected_count: 2, mismatches: [{ role: "revenue_amount", expected_value: 123, expected_unit: "KRW" }] },
      },
      answerability: { status: "PASS", raw_score: 1, error_codes: [], details: { expected: "SUPPORTED", actual: "SUPPORTED" } },
    },
  };
  const redacted = redactAxisDetailsForHoldout(scoring);
  assert.deepEqual(redacted.axes.numeric_claim.details, { redacted: true, matched_count: 1, expected_count: 2 });
  assert.deepEqual(redacted.axes.answerability.details, { redacted: true });
  assert.equal(redacted.axes.numeric_claim.status, "FAIL");
  assert.equal(redacted.axes.numeric_claim.raw_score, 0.5);
  assert.deepEqual(redacted.axes.numeric_claim.error_codes, ["UNIT_MISMATCH"]);
});

// Turn P6.1: buildComparisonReportV0_2 -- reads dataset_id/dataset_sha256/
// dataset_role/holdout_accessed/official_gold_accessed off datasetManifest,
// never as separate arguments.
test("buildComparisonReportV0_2: SYNTHETIC dataset_role -> dataset_role/holdout_accessed/official_gold_accessed are all copied verbatim off the datasetManifest, schema-valid v0.2", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_synthetic" })], { datasetId: "dataset_report_v02_synthetic", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const report = buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "unknown", allItemResults: results,
  });
  assert.deepEqual(validateBenchmarkComparisonReportV0_2(report), []);
  assert.equal(report.schema_version, "0.2.0");
  assert.equal(report.dataset_role, "SYNTHETIC");
  assert.equal(report.holdout_accessed, false);
  assert.equal(report.official_gold_accessed, false);
  assert.equal(report.ranking_performed, false);
});

test("buildComparisonReportV0_2: refuses to assemble a report when an item's dataset_id/dataset_sha256 pin does not match the supplied datasetManifest (pin-consistency validation)", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_pin_mismatch" })], { datasetId: "dataset_report_v02_pin_a", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const tamperedManifest = { ...manifest, dataset_id: "dataset_report_v02_pin_DIFFERENT" };
  assert.throws(() => buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: tamperedManifest, codeRevision: "unknown", allItemResults: results,
  }), /pin|mismatched/i);
});

// Turn P6.1 (condition 7): every row's code_revision/release_id/
// release_manifest_sha256 must fully agree with the report's own values --
// a report can never silently claim a code/release pin a row does not
// actually carry.
test("buildComparisonReportV0_2: refuses to assemble a report when an item's code_revision pin does not match the report's own codeRevision", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_code_pin" })], { datasetId: "dataset_report_v02_code_pin", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  assert.throws(() => buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "some_other_revision", allItemResults: results,
  }), /code_revision/);
});

test("buildComparisonReportV0_2: refuses to assemble a report when an item's release_id/release_manifest_sha256 pin does not match the report's own values", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_release_pin" })], { datasetId: "dataset_report_v02_release_pin", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  assert.throws(() => buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "unknown", releaseId: "release_that_never_ran", allItemResults: results,
  }), /release_id/);
});

test("buildComparisonReportV0_2: refuses to assemble a report when the SAME evaluation_item_id has a different evaluation_item_sha256 across variants (tampered/divergent item content)", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_item_sha_pin" })], { datasetId: "dataset_report_v02_item_sha_pin", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL"], ...runArgs() });
  const tamperedResults = results.map((item, index) => (index === 0 ? { ...item, evaluation_item_sha256: "f".repeat(64) } : item));
  assert.throws(() => buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "unknown", allItemResults: tamperedResults,
  }), /evaluation_item_sha256/);
});

test("buildComparisonReportV0_2: a normal 4-variant run with matching pins throughout assembles without error", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_all_variants" })], { datasetId: "dataset_report_v02_all_variants", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, ...runArgs() });
  const report = buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "unknown", allItemResults: results,
  });
  assert.deepEqual(validateBenchmarkComparisonReportV0_2(report), []);
  assert.equal(report.variant_run_results.length, 4);
});

// Turn P6.1: the whole point of this Turn -- a REAL, canUseSplit-verified
// HOLDOUT unlock now flows through as holdout_accessed=true (never the
// v0.1 unconditional false), AND every scoring axis's details are
// mechanically redacted (grading_detail_visibility=REDACTED) so no
// expected_* Gold content (fact semantic_slot, expected_answerability,
// numeric mismatch payloads, ...) ever leaks into a HOLDOUT
// BenchmarkItemResult.
test("runBenchmark + buildComparisonReportV0_2: a HOLDOUT_GOLD run with a real unlock redacts every axis's scoring details and honestly reports holdout_accessed=true/official_gold_accessed=true", async () => {
  const holdoutItem = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_holdout", split: "HOLDOUT" });
  const holdoutUnlock = {
    log: [],
    runId: "run_test_report_v02_holdout",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: "d".repeat(64),
    lifecycleStateByItemId: {
      evaluation_item_report_v02_holdout: {
        assignment_id: "evaluation_item_report_v02_holdout",
        assigned_split: "HOLDOUT",
        split_lock_status: "LOCKED_BY_CHAIN",
        holdout_lifecycle_status: "OPENED",
      },
    },
  };
  const { manifest, records } = loadDatasetRecordsV0_2([holdoutItem], { datasetId: "dataset_report_v02_holdout", holdoutUnlock, datasetRole: "HOLDOUT_GOLD" });
  assert.equal(manifest.holdout_accessed, true);
  assert.equal(manifest.grading_detail_visibility, "REDACTED");

  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const [result] = results;
  assert.equal(result.outcome_category, "NORMAL_ANSWER");
  assert.equal(result.scoring.axes.numeric_claim.status, "PASS");
  for (const [axisName, axisResult] of Object.entries(result.scoring.axes)) {
    for (const key of Object.keys(axisResult.details)) {
      assert.ok(["redacted", "matched_count", "expected_count"].includes(key), `${axisName}.details leaked forbidden key: ${key}`);
    }
  }
  const serializedScoring = JSON.stringify(result.scoring);
  assert.doesNotMatch(serializedScoring, /revenue_fy_synthetic|SUPPORTED/); // no expected_* Gold content leaks

  const report = buildComparisonReportV0_2({
    benchmarkRunId: "benchmark_run_report_test", datasetManifest: manifest, codeRevision: "unknown", allItemResults: results,
  });
  assert.deepEqual(validateBenchmarkComparisonReportV0_2(report), []);
  assert.equal(report.dataset_role, "HOLDOUT_GOLD");
  assert.equal(report.holdout_accessed, true);
  assert.equal(report.official_gold_accessed, true);
});

test("runBenchmark: SYNTHETIC dataset_role (grading_detail_visibility=FULL) leaves scoring axis details un-redacted", async () => {
  const { manifest, records } = loadDatasetRecordsV0_2([makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_report_v02_full" })], { datasetId: "dataset_report_v02_full", datasetRole: "SYNTHETIC" });
  const results = await runBenchmark({ datasetManifest: manifest, datasetRecords: records, variantIds: ["STRUCTURED_FIRST"], ...runArgs() });
  const [result] = results;
  assert.equal(result.scoring.axes.numeric_claim.details.matched_count, 1);
  assert.ok(!("redacted" in result.scoring.axes.numeric_claim.details));
});
