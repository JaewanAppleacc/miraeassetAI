// Turn M10: Owner review found two related common-rule gaps in the
// calculationRegistry sentence renderer (response-composer.mjs's
// buildRichRegistrySentence): (1) a cross-entity same-metric
// ABSOLUTE_DIFFERENCE stated only the bare magnitude ("A와(과) B의 차이는
// X입니다"), never which side was larger; (2) a same-entity, different-
// period ABSOLUTE_DIFFERENCE whose two Facts' raw_labels differ only by
// the existing "·정정전"/"·정정후" correction-side suffix convention
// (stripCorrectionSideSuffix) was never recognized as "the same metric",
// so it fell through to the label-mismatch generic template and never
// got direction (증가/감소) wording at all.
//
// Turn M10.1: Owner review found that Turn M10's own fix for (1) had
// introduced a NEW defect -- it kept the pre-existing magnitude sentence
// AND appended a second, additive direction sentence, so the same number
// appeared twice in the answer (e.g. Q13/Q15: "...차이는 500원입니다.
// ...보다 500원 큽니다."). This replaces that pair with a SINGLE directional
// sentence: positive -> "{bigger}의 {metric}는 {smaller}보다 N 큽니다.",
// zero -> "{A}와 {B}의 {metric}는 동일합니다." (unchanged from Turn M10).
// Both fixes are keyed purely on registry-entry SHAPE (labels/corp_codes/
// periods), never a question_id or company literal.
import assert from "node:assert/strict";
import test from "node:test";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "TEST_METRIC",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    raw_label: "테스트 지표", attributes: {}, ...overrides,
  };
}
function registryEntry(overrides) {
  return {
    key: "synthetic_key", formula: "DIFF", output_kind: "VALUE", result: 100,
    input_fact_ids: ["fact_a", "fact_b"], input_labels: ["항목 A", "항목 B"], input_units: ["KRW", "KRW"],
    input_corp_codes: [null, null], input_periods: [null, null], input_metric_codes: [null, null],
    ...overrides,
  };
}
function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, calculationRegistry = [], slots = [], companyLabels = null }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, calculationRegistry, companyLabels, slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { composed, validation };
}

// -- cross-entity direction ------------------------------------------------

test("Turn M10.1: a cross-entity same-metric DIFF (positive result) states a SINGLE directional sentence, never a magnitude sentence plus a separate direction sentence", () => {
  const registry = [registryEntry({
    key: "synthetic_diff", result: 500, input_units: ["KRW", "KRW"],
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000002"], input_periods: ["2025-12-31", "2025-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed, validation } = pipeline({ calculationRegistry: registry, companyLabels, calculationValue: { synthetic_diff: 500 } });
  // result>0 means input_corp_codes[0] (합성기업가) is larger -> 합성기업가 is the subject
  assert.match(composed.answer, /합성기업가의 매출액은 합성기업나보다 500원 큽니다/);
  // the pre-Turn-M10.1 duplicate-magnitude sentence must be GONE
  assert.equal(/차이는 500원입니다/.test(composed.answer), false);
  // "500원" must appear exactly once in the whole answer -- never repeated
  assert.equal((composed.answer.match(/500원/g) ?? []).length, 1);
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

test("Turn M10.1 counterexample: the direction is REVERSED when the DIFF result is negative (never a hardcoded 'first company wins'), still a single sentence", () => {
  const registry = [registryEntry({
    key: "synthetic_diff_neg", result: -500, input_units: ["KRW", "KRW"],
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000002"], input_periods: ["2025-12-31", "2025-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /합성기업나의 매출액은 합성기업가보다 500원 큽니다/);
  assert.equal(/합성기업가의 매출액은 합성기업나보다 500원 큽니다/.test(composed.answer), false);
  assert.equal((composed.answer.match(/500원/g) ?? []).length, 1);
});

test("Turn M10.1: a cross-entity same-metric DIFF of exactly ZERO states equality, never a directionless '0원 큽니다'", () => {
  const registry = [registryEntry({
    key: "synthetic_diff_zero", result: 0, input_units: ["KRW", "KRW"],
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000002"], input_periods: ["2025-12-31", "2025-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.equal(/0원 큽니다/.test(composed.answer), false);
  assert.match(composed.answer, /동일합니다/);
});

test("Turn M10.1: a cross-entity same-metric DIFF whose output_kind is PERCENT uses the %p unit suffix, single sentence, no duplicate number", () => {
  const registry = [registryEntry({
    key: "synthetic_diff_percent", result: 4.87, output_kind: "PERCENT", input_units: [null, null],
    input_labels: ["매출액대비", "매출액대비"], input_corp_codes: ["00000001", "00000002"], input_periods: ["2025-12-31", "2024-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /합성기업가의 매출액대비는 합성기업나보다 4\.87%p 큽니다/);
  assert.equal((composed.answer.match(/4\.87/g) ?? []).length, 1);
});

test("Turn M10.1 counterexample: when a company label cannot be resolved, the cross-entity direction sentence never fires and no fabricated company name appears", () => {
  const registry = [registryEntry({
    key: "synthetic_diff_unresolved", result: 500, input_units: ["KRW", "KRW"],
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000009"], input_periods: ["2025-12-31", "2025-12-31"],
  })];
  // only 00000001 resolves; 00000009 has no entry at all -- buildRichRegistrySentence's
  // `entityA && entityB` guard means the cross-entity branch never fires, and the
  // same-entity/different-period branch also never fires here (periodA === periodB),
  // so this degrades to the pre-existing generic metric-label template (no entity
  // name, no directional wording) -- never a fabricated company name.
  const companyLabels = { "00000001": { corp_name: "합성기업가" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.equal(/합성기업가/.test(composed.answer), false);
  assert.equal(/보다.*큽니다/.test(composed.answer), false);
  assert.match(composed.answer, /차이는 500원입니다/);
});

// -- same-entity, different-period direction (correction-side suffix) -----

test("Turn M10: a same-entity DIFF whose two labels differ ONLY by the existing '·정정전/·정정후' suffix convention is recognized as the same metric and gets 증가/감소 direction wording", () => {
  const registry = [registryEntry({
    key: "synthetic_amount_change", result: 100, input_units: ["KRW", "KRW"],
    input_labels: ["합성금액(원)·정정후", "합성금액(원)"], input_corp_codes: ["00000009", "00000009"], input_periods: ["2030-12-05", "2030-03-15"],
  })];
  const companyLabels = { "00000009": { corp_name: "합성기업다" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /증가/);
  assert.equal(composed.answer.includes("·정정후와"), false, "the correction-side suffix must not leak into the rendered sentence");
  // input_periods here is [later, earlier] (2030-12-05, 2030-03-15) --
  // the SAME "latest-then-original" call-site order Q20's real
  // calculatePair("DIFF", "latest_amount", "original_amount", ...) uses.
  // The sentence's "A 대비 B에" ordering must still read chronologically
  // (earlier 대비 later), never literally echo input_periods[0] first.
  assert.match(composed.answer, /2030-03-15 대비 2030-12-05에/);
  assert.equal(composed.answer.includes("2030-12-05 대비 2030-03-15에"), false, "period order must never read backwards (later date first)");
});

test("Turn M10 counterexample: a NEGATIVE same-entity DIFF renders 감소, never 증가", () => {
  const registry = [registryEntry({
    key: "synthetic_amount_change_neg", result: -100, input_units: ["KRW", "KRW"],
    input_labels: ["합성금액(원)·정정후", "합성금액(원)"], input_corp_codes: ["00000009", "00000009"], input_periods: ["2030-12-05", "2030-03-15"],
  })];
  const companyLabels = { "00000009": { corp_name: "합성기업다" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /감소/);
  assert.equal(composed.answer.includes("증가"), false);
});

test("Turn M10 counterexample: two labels that are genuinely DIFFERENT metrics (no correction-side suffix relationship) never get the same-metric direction treatment", () => {
  const registry = [registryEntry({
    key: "synthetic_unrelated_diff", result: 100, input_units: ["KRW", "KRW"],
    input_labels: ["합성금액(원)", "합성별개지표(원)"], input_corp_codes: ["00000009", "00000009"], input_periods: ["2030-12-05", "2030-03-15"],
  })];
  const { composed } = pipeline({ calculationRegistry: registry });
  // falls through to the generic template -- bare "차이는 X입니다", no 증가/감소 claim about an unrelated pairing
  assert.match(composed.answer, /차이는 100원입니다/);
});

// -- unit-normalized match-check (company-vs-company amount equality) -----

test("Turn M10: a termination-vs-effective-contract-amount pair with MATCHING values but differently-SPELLED units (KRW vs 원) still produces the 일치 conclusion", () => {
  const registry = [registryEntry({
    key: "synthetic_match", formula: "DIFF", output_kind: "VALUE", result: 0,
    input_labels: ["해지금액(원)", "해지 시점 유효 계약금액"], input_units: ["KRW", "원"],
    input_corp_codes: ["00000005", "00000005"], input_periods: ["2030-01-01", "2030-01-01"],
    input_metric_codes: ["TERMINATION_AMOUNT", "LATEST_CONTRACT_AMOUNT"],
  })];
  const companyLabels = { "00000005": { corp_name: "합성기업라" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /일치합니다/);
});
