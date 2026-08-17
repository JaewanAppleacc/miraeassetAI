import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSeedThinRunner } from "../domain/runtime/seed-thin-runner.mjs";
import { buildSeedThinFlowPlansV02 } from "../scripts/build-seed-thin-flow-plans-v02.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const GOLD = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.14.jsonl");
const records = async () => (await readFile(GOLD, "utf8")).trim().split("\n").map(JSON.parse);
// Test-only fixture pair: canonical manifest + JSON decision artifact bound
// specifically to the v0.2-with-chain structured manifest fixture's exact
// bytes (see tests/release-authorization-boundary.test.mjs for the binding
// contract). That fixture mirrors the real seed-structured-artifacts.v0.2
// manifest's Evidence/Fact/Coverage/OwnerDecision pins exactly, plus the
// now-mandatory CHAIN_MANIFEST role -- the real v0.2 manifest lacks that
// role, so it can no longer be used directly. A different structured
// manifest would fail the decision artifact's structured_manifest.sha256
// check, so this pair cannot be swapped for
// tests/fixtures/seed-release.v0.11.approved.manifest.json (bound to the
// v0.1 fixture instead).
const options = Object.freeze({
  root: ROOT,
  structuredManifestPath: path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v02-with-chain.test-fixture.manifest.json"),
  canonicalReleaseManifestPath: path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved-for-v02-structured.manifest.json"),
  planPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.2.jsonl"),
  planManifestPath: path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.2.manifest.json"),
});

test("v0.2 plans bind to the new Coverage Snapshot without answer material", async () => {
  const result = await buildSeedThinFlowPlansV02({ writeOutputs: false });
  assert.equal(result.plans.length, 23);
  assert.equal(result.manifest.fact_coverage_snapshot_id, "fact_coverage_snapshot_3b76f5bf79a87b196f7a31b4");
  for (const forbidden of ["expected_answer", "scoring_spec", "required_evidence_slots"]) assert.equal(result.planText.includes(forbidden), false);
});

test("v0.2 Runtime performs proof-bound cross-scale-normalized Q13 calculations", async () => {
  const runner = await createSeedThinRunner(options);
  const record = (await records()).find((item) => item.question_id === "question_seed_v07_13");
  const outcome = await runner(record.question, { question_id: record.question_id });
  const value = outcome.final_response.think_trace.calculation.value;
  assert.equal(value.hd_revenue_krw, 17_580_633_257_000);
  assert.equal(value.shi_revenue_krw, 10_650_010_702_818);
  assert.equal(value.revenue_diff_krw, 6_930_622_554_182);
  assert.equal(value.operating_profit_diff_krw, 1_175_299_222_971);
  assert.ok(Math.abs(value.revenue_diff_percent - 65.07620271544096) < 1e-10);
  assert.ok(Math.abs(value.operating_profit_diff_percent - 136.31227002510911) < 1e-10);
  // Turn I §5-A: the winner is now recorded as the real VERIFIED Fact's
  // own corp_code (never a Flow-authored company-name literal) --
  // Response Composer resolves the human-readable label at render time
  // via companyLabels/corp_code fallback. This corp_code (01390344) is
  // HD현대중공업's real corp_code in this fixture, confirmed empirically
  // against the same options/gold record this test already uses.
  assert.equal(value.revenue_winner_corp_code, "01390344");
  assert.equal(value.operating_profit_winner_corp_code, "01390344");
  assert.equal(value.revenue_winner, undefined);
  assert.equal(value.operating_profit_winner, undefined);
  assert.equal(value.original_unit_hd, "천원");
  assert.equal(value.original_unit_shi, "원");
  assert.equal(value.original_units_differ, true);
  assert.deepEqual(value.non_scored_fields, {
    revenue_diff_percent: value.revenue_diff_percent,
    operating_profit_diff_percent: value.operating_profit_diff_percent,
  });
  // Turn M2 item 5: +2 vs. the pre-existing 4 (revenue/operating_profit
  // DIFF + PERCENTAGE_CHANGE) -- the two NEW ops are each company's own
  // generic operating-margin RATIO (operating_profit/revenue), computed
  // independently for HD and SHI since each pairs its OWN same-scale
  // revenue/operating_profit Facts (unaffected by the cross-scale mismatch
  // between the two companies' own disclosed revenue scales).
  assert.equal(outcome.execution_trace.operations.filter((entry) => entry.service === "Calculator" && entry.ok).length, 6);
});

test("v0.2 keeps the exact disclosed thousand/million values alongside canonical KRW", async () => {
  const runner = await createSeedThinRunner(options);
  const gold = await records();
  for (const [questionId, suffix, expected] of [
    ["question_seed_v07_10", "thousand_krw", 1_671_253_049],
    ["question_seed_v07_11", "million_krw", 8_400_969],
    ["question_seed_v07_12", "million_krw", 59_254_361],
  ]) {
    const record = gold.find((item) => item.question_id === questionId);
    const outcome = await runner(record.question, { question_id: questionId });
    const value = outcome.final_response.think_trace.calculation.value;
    assert.equal(value[`revenue_2023_${suffix}`], expected);
    assert.equal(value.revenue_2023_krw, expected * (suffix === "thousand_krw" ? 1_000 : 1_000_000));
    assert.equal(value.unit, "%");
    // The answer's narrative wording is now produced by the common
    // Response Composer (domain/flows/synthesis/response-composer.mjs)
    // rather than a fixed "검증된 계산 결과:" bullet-dump header; this test's
    // actual contract -- that the calculated percentage change is
    // surfaced in the answer text, not just buried in calculation.value
    // -- is unchanged and checked against the composer's comparison
    // sentence wording instead. Turn M: the composer now names the
    // metric, the before/after period, and an explicit 증가/감소 direction
    // word rather than the old "A에서 B로의 변화율은 N%입니다" phrasing.
    assert.match(outcome.final_response.answer, /약\s[\d.]+%\s(증가|감소)했습니다/);
    assert.match(outcome.final_response.answer, /%/);
  }
});

test("v0.2 projects only Evidence-linked VERIFIED Events into temporal answers", async () => {
  const runner = await createSeedThinRunner(options);
  const gold = await records();
  for (const [questionId, expectedDates] of [
    ["question_seed_v07_08", ["2024-11-15", "2025-02-20"]],
    ["question_seed_v07_09", ["2025-02-06", "2025-06-23", "2025-06-26"]],
    ["question_seed_v07_21", ["2023-03-13", "2024-08-08"]],
  ]) {
    const record = gold.find((item) => item.question_id === questionId);
    const outcome = await runner(record.question, { question_id: questionId });
    assert.ok(outcome.final_response.think_trace.validation.events > 0, questionId);
    assert.ok(outcome.final_response.think_trace.operations.includes("query_verified_events"), questionId);
    for (const date of expectedDates) assert.ok(outcome.final_response.answer.includes(date), `${questionId}:${date}`);
  }
});

test("v0.2 projects verified status and comparison structures without reading Gold answers", async () => {
  const runner = await createSeedThinRunner(options);
  const gold = await records();
  const q14 = gold.find((item) => item.question_id === "question_seed_v07_14");
  const q14Value = (await runner(q14.question, { question_id: q14.question_id })).final_response.think_trace.calculation.value;
  assert.equal(q14Value.operating_profit_value_status, "DISCLOSED");
  assert.equal(q14Value.revenue_2023_status, "NOT_APPLICABLE");
  assert.equal(q14Value.revenue_2025_status, "NOT_APPLICABLE");
  assert.equal(q14Value.revenue_field_available, false);

  const q16 = gold.find((item) => item.question_id === "question_seed_v07_16");
  const q16Value = (await runner(q16.question, { question_id: q16.question_id })).final_response.think_trace.calculation.value;
  assert.ok(Math.abs(q16Value.hmm.revenue_change_percent - 29.645080228245096) < 1e-10);
  assert.ok(Math.abs(q16Value.hyundai_mobis.operating_profit_change_percent - 46.2762777939462) < 1e-10);
  assert.equal(q16Value.both_companies_operating_profit_growth_exceeds_revenue_growth, true);
  // Turn I §5-A: corp_code, not a "HMM" literal -- see the Q13 note above.
  assert.equal(q16Value.larger_change_magnitude_company_corp_code, "00164645");
  assert.equal(q16Value.larger_change_magnitude_company, undefined);
});

test("v0.2 Runtime keeps all 23 eligible questions grounded and Q3/Q22 excluded", async () => {
  const runner = await createSeedThinRunner(options);
  const gold = await records();
  for (const record of gold) {
    const outcome = await runner(record.question, { question_id: record.question_id });
    const expectedMode = ["question_seed_v07_03", "question_seed_v07_22"].includes(record.question_id) ? "EARLY_EXIT" : "STRUCTURED";
    assert.equal(outcome.final_response.think_trace.execution_mode, expectedMode, record.question_id);
    if (expectedMode === "STRUCTURED") assert.ok(outcome.execution_trace.selected_evidence.length > 0, record.question_id);
  }
});
