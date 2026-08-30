// Turn P6 section E: aggregates BenchmarkItemResult rows (runner.mjs's own
// output) into a BenchmarkRunResult per variant, then a
// BenchmarkComparisonReport across variants. Never reads Gold/HOLDOUT
// content itself -- only the already-produced, already-hashed item
// results. ranking_performed/holdout_accessed/official_gold_accessed are
// hardcoded false here, matching this Turn's own schema-level `const`
// lock (benchmark-comparison-report.schema.json) -- this module does not
// (and, per that schema, cannot) compute or claim otherwise.
import { validateBenchmarkRunResult, validateBenchmarkComparisonReport, SCORING_AXES } from "./contracts.mjs";
import { OUTCOME_CATEGORIES } from "./failure-classification.mjs";

function emptyOutcomeCounts() {
  return Object.fromEntries(OUTCOME_CATEGORIES.map((category) => [category, 0]));
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function summarizeAxis(itemResults, axis) {
  let passCount = 0;
  let failCount = 0;
  let notApplicableCount = 0;
  let skippedCount = 0;
  const scores = [];
  for (const item of itemResults) {
    const axisResult = item.scoring.axes[axis];
    if (axisResult.status === "PASS") passCount += 1;
    else if (axisResult.status === "FAIL") failCount += 1;
    else if (axisResult.status === "NOT_APPLICABLE") notApplicableCount += 1;
    else if (axisResult.status === "SKIPPED") skippedCount += 1;
    if (typeof axisResult.raw_score === "number") scores.push(axisResult.raw_score);
  }
  return {
    n_scored: scores.length,
    mean: mean(scores),
    median: median(scores),
    pass_count: passCount,
    fail_count: failCount,
    not_applicable_count: notApplicableCount,
    skipped_count: skippedCount,
  };
}

// `itemResults`: every BenchmarkItemResult for exactly ONE variant_id (the
// caller filters -- this function does not itself group a mixed array).
export function summarizeRunResult({ benchmarkRunId, variantId, itemResults }) {
  if (itemResults.length === 0) throw new Error("summarizeRunResult requires at least one BenchmarkItemResult");
  const mismatched = itemResults.find((item) => item.variant_id !== variantId);
  if (mismatched) throw new Error(`summarizeRunResult received a BenchmarkItemResult for ${mismatched.variant_id}, expected only ${variantId}`);

  const outcomeCategoryCounts = emptyOutcomeCounts();
  for (const item of itemResults) outcomeCategoryCounts[item.outcome_category] += 1;

  const eligibleCount = itemResults.filter((item) => item.scoring_eligible === true).length;
  const ineligibleCount = itemResults.length - eligibleCount;

  const axisSummary = Object.fromEntries(SCORING_AXES.map((axis) => [axis, summarizeAxis(itemResults, axis)]));

  const first = itemResults[0];
  const result = {
    schema_version: "0.1.0",
    benchmark_run_id: benchmarkRunId,
    variant_id: variantId,
    agent_variant_revision: first.agent_variant_revision,
    model_config_id: first.model_config_id,
    model_config_sha256: first.model_config_sha256,
    dataset_id: first.dataset_id,
    dataset_sha256: first.dataset_sha256,
    item_count: itemResults.length,
    eligible_count: eligibleCount,
    ineligible_count: ineligibleCount,
    outcome_category_counts: outcomeCategoryCounts,
    axis_summary: axisSummary,
    item_ids: [...itemResults.map((item) => item.evaluation_item_id)].sort(),
  };
  const errors = validateBenchmarkRunResult(result);
  if (errors.length > 0) throw new Error(`summarizeRunResult produced an invalid BenchmarkRunResult: ${errors.join("; ")}`);
  return Object.freeze(result);
}

function setEquals(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

// `allItemResults`: every BenchmarkItemResult across every variant compared
// (runner.mjs's own flat output array) -- grouped by variant_id here.
export function buildComparisonReport({ benchmarkRunId, datasetId, datasetSha256, codeRevision, releaseId = null, releaseManifestSha256 = null, allItemResults }) {
  const byVariant = new Map();
  for (const item of allItemResults) {
    if (!byVariant.has(item.variant_id)) byVariant.set(item.variant_id, []);
    byVariant.get(item.variant_id).push(item);
  }

  const variantRunResults = [...byVariant.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variantId, itemResults]) => summarizeRunResult({ benchmarkRunId, variantId, itemResults }));

  const unionItemIds = new Set(variantRunResults.flatMap((run) => run.item_ids));
  const identicalItemSet = variantRunResults.every((run) => setEquals(run.item_ids, [...unionItemIds]));
  const missingItemsByVariant = {};
  if (!identicalItemSet) {
    for (const run of variantRunResults) {
      const missing = [...unionItemIds].filter((id) => !run.item_ids.includes(id)).sort();
      if (missing.length > 0) missingItemsByVariant[run.variant_id] = missing;
    }
  }

  const modelConfigDifferences = variantRunResults.map((run) => ({
    variant_id: run.variant_id, model_config_id: run.model_config_id, model_config_sha256: run.model_config_sha256,
  }));

  const report = {
    schema_version: "0.1.0",
    benchmark_run_id: benchmarkRunId,
    dataset_id: datasetId,
    dataset_sha256: datasetSha256,
    code_revision: codeRevision,
    release_id: releaseId,
    release_manifest_sha256: releaseManifestSha256,
    variant_run_results: variantRunResults,
    identical_item_set: identicalItemSet,
    missing_items_by_variant: missingItemsByVariant,
    model_config_differences: modelConfigDifferences,
    ranking_performed: false,
    holdout_accessed: false,
    official_gold_accessed: false,
  };
  const errors = validateBenchmarkComparisonReport(report);
  if (errors.length > 0) throw new Error(`buildComparisonReport produced an invalid BenchmarkComparisonReport: ${errors.join("; ")}`);
  return Object.freeze(report);
}
