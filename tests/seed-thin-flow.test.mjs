import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isValidFinalResponse } from "../domain/runtime/final-response-validator.mjs";
import { buildSeedThinFlowPlans } from "../scripts/build-seed-thin-flow-plans.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { createSeedThinRunner } from "../domain/runtime/seed-thin-runner.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const GOLD = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl");
const PLAN = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.jsonl");
const PLAN_MANIFEST = path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.1.manifest.json");
// Test-only fixtures: byte-for-byte copy of domain/releases/seed-release.v0.11.manifest.json
// plus one added release_authorization block, and a structured manifest
// fixture adding the now-mandatory CHAIN_MANIFEST role (real v0.1 Event/
// Relation/Chain data, unfiltered) -- so createSeedThinRunner's
// RELEASE_NOT_APPROVED gate (see tests/release-authorization-boundary.test.mjs)
// does not block these pre-existing Thin Flow behavior tests.
const APPROVED_CANONICAL_MANIFEST = path.join(ROOT, "tests/fixtures/seed-release.v0.11.approved.manifest.json");
const STRUCTURED_MANIFEST_WITH_CHAIN = path.join(ROOT, "tests/fixtures/seed-structured-artifacts.v01-with-chain.test-fixture.manifest.json");
const RUNNER_OPTIONS = Object.freeze({
  root: ROOT, structuredManifestPath: STRUCTURED_MANIFEST_WITH_CHAIN, canonicalReleaseManifestPath: APPROVED_CANONICAL_MANIFEST,
});
const parseJsonl = (text) => text.trim().split("\n").map(JSON.parse);

test("builds exactly 23 answer-free plans and keeps Q3/Q22 excluded", async () => {
  const { plans, planText } = await buildSeedThinFlowPlans({ root: ROOT, writeOutputs: false });
  assert.equal(plans.length, 23);
  assert.equal(plans.some((plan) => ["question_seed_v07_03", "question_seed_v07_22"].includes(plan.question_id)), false);
  for (const forbidden of ["expected_answer", "scoring_spec", "required_evidence_slots"]) assert.equal(planText.includes(forbidden), false);
});

test("plan resolution is bound to both question_id and exact question bytes", async () => {
  const store = await createSeedQuestionPlanStore({ planPath: PLAN, manifestPath: PLAN_MANIFEST });
  const firstGold = parseJsonl(await readFile(GOLD, "utf8"))[0];
  assert.ok(store.resolve(firstGold.question_id, firstGold.question));
  assert.equal(store.resolve(firstGold.question_id, `${firstGold.question} `), null);
  assert.equal(store.resolve("question_unknown", firstGold.question), null);
  assert.equal(store.count(), 23);
});

test("all 23 E2E-ready Seed questions run through real stores as grounded STRUCTURED outcomes", async () => {
  const runner = await createSeedThinRunner(RUNNER_OPTIONS);
  const gold = parseJsonl(await readFile(GOLD, "utf8")).filter((record) => record.extensions.e2e_usage_status === "E2E_READY");
  assert.equal(gold.length, 23);
  for (const record of gold) {
    const outcome = await runner(record.question, { question_id: record.question_id });
    assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED", record.question_id);
    assert.equal(isValidFinalResponse(outcome.final_response), true, record.question_id);
    assert.equal(outcome.execution_trace.fallback_reason, null, record.question_id);
    assert.ok(outcome.execution_trace.selected_evidence.length > 0, record.question_id);
    assert.ok(outcome.final_response.answer.includes("근거 공시:"), record.question_id);
    assert.ok(outcome.final_response.retrieved_context.every((item) => outcome.execution_trace.selected_evidence.includes(item.evidence_id)), record.question_id);
  }
});

test("a forged question paired with a known Seed ID does not receive that plan's facts", async () => {
  const runner = await createSeedThinRunner(RUNNER_OPTIONS);
  const outcome = await runner("전혀 다른 질문", { question_id: "question_seed_v07_01" });
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.deepEqual(outcome.final_response.retrieved_context, []);
  assert.equal(outcome.final_response.answer.includes("635,384,978,972"), false);
});

test("same-scale financial comparisons are derived only through the approved Calculator", async () => {
  const runner = await createSeedThinRunner(RUNNER_OPTIONS);
  const gold = parseJsonl(await readFile(GOLD, "utf8"));
  const record = gold.find((item) => item.question_id === "question_seed_v07_11");
  const outcome = await runner(record.question, { question_id: record.question_id });
  const value = outcome.final_response.think_trace.calculation.value;

  assert.equal(value.revenue_2023_million_krw, 8_400_969);
  assert.equal(value.revenue_2025_million_krw, 10_891_443);
  assert.ok(Math.abs(value.revenue_change_percent - 29.645080228245096) < 1e-12);
  assert.ok(Math.abs(value.operating_profit_change_percent - 149.8763616464593) < 1e-12);
  // Turn M2 item 5: +2 vs. the pre-existing 2 (revenue/operating_profit
  // PERCENTAGE_CHANGE) -- the two NEW ops are this company's own generic
  // operating-margin RATIO (operating_profit/revenue), computed once per
  // disclosed period (2023 and 2025 each have their own matching
  // revenue/operating_profit Fact pair).
  assert.equal(
    outcome.execution_trace.operations.filter((entry) => entry.service === "Calculator" && entry.ok).length,
    4,
  );
});

test("cross-scale company comparisons are not silently calculated", async () => {
  const runner = await createSeedThinRunner(RUNNER_OPTIONS);
  const gold = parseJsonl(await readFile(GOLD, "utf8"));
  const record = gold.find((item) => item.question_id === "question_seed_v07_13");
  const outcome = await runner(record.question, { question_id: record.question_id });
  const value = outcome.final_response.think_trace.calculation.value;

  assert.equal(value.revenue_hd_thousand_krw, 17_580_633_257);
  assert.equal(value.revenue_shi_krw, 10_650_010_702_818);
  assert.equal("revenue_diff_krw" in value, false);
  // Turn M2 item 5: the cross-company revenue DIFF itself is still never
  // silently calculated across the scale mismatch (the assertion this
  // test is actually about) -- but each company's OWN generic operating-
  // margin RATIO (its own revenue vs. its own operating_profit, always
  // same-scale by construction) is a separate, legitimate calculation
  // that now genuinely runs for both companies.
  assert.equal(
    outcome.execution_trace.operations.filter((entry) => entry.service === "Calculator" && entry.ok).length,
    2,
  );
  assert.equal(outcome.final_response.think_trace.calculation.value.revenue_diff_krw, undefined);
});

test("trusted Fact metadata is projected without inventing evidence-only values", async () => {
  const runner = await createSeedThinRunner(RUNNER_OPTIONS);
  const gold = parseJsonl(await readFile(GOLD, "utf8"));
  const run = async (questionId) => {
    const record = gold.find((item) => item.question_id === questionId);
    return (await runner(record.question, { question_id: questionId })).final_response.think_trace.calculation.value;
  };
  const q1 = await run("question_seed_v07_01");
  assert.equal(q1.contract_amount, 635_384_978_972);
  assert.equal(q1.contract_amount_unit, "원");
  assert.equal(q1.period_start, "2023-04-28");
  assert.equal(q1.period_end, "2032-10-31");

  const q4 = await run("question_seed_v07_04");
  assert.equal(q4.shares_after_correction, 1_198_080_226);
  assert.equal(q4.ratio_after_correction_percent, 20.07);
  assert.equal("change_vs_previous_shares" in q4, false);

  const q20 = await run("question_seed_v07_20");
  assert.equal(q20.amount_original_krw, 4_150_000_000);
  assert.equal(q20.amount_latest_krw, 4_250_000_000);
  assert.equal(q20.amount_change_krw, 100_000_000);
  assert.equal(q20.end_date_original, "2024-11-30");
  assert.equal(q20.end_date_latest, "2025-05-30");
});

test("the generated plan artifact bytes match their manifest hash", async () => {
  const [bytes, manifest] = await Promise.all([readFile(PLAN), readFile(PLAN_MANIFEST, "utf8").then(JSON.parse)]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.artifact_sha256);
});
