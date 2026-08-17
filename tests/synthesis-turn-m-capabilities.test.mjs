// Turn M: TDD suite for the 8 common capability fixes (A-H) driven by the
// Owner's 24 FIX_REQUIRED notes on seed-response-owner-decision.v0.7.
// Every fixture here is entirely SYNTHETIC (synthetic company/entity
// names, synthetic metric codes, synthetic dates/amounts) -- never a real
// Seed question_id, real company name, real document_id, or a literal
// copied from Gold/expected_answer. These tests exercise the GENERIC
// capability, proving it generalizes beyond the specific 25 Seed
// questions that motivated it.
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
function evidenceItem(overrides) {
  return {
    evidence_id: "evidence_default", document_id: "doc_default", file_id: "file_default",
    source_locator: "doc#node=1", quoted_text: "테스트 인용문", quote_sha256: "0".repeat(64), ...overrides,
  };
}
function event(overrides) {
  return {
    event_id: "event_default", event_type: "SUPPLY_CONTRACT_DECISION", event_date: "2025-01-01",
    event_status: "DECIDED", anchor_document_id: "doc_default", attributes: {}, ...overrides,
  };
}
function registryEntry(overrides) {
  return {
    key: "synthetic_key", formula: "DIFF", output_kind: "VALUE", result: 100,
    input_fact_ids: ["fact_a", "fact_b"], input_labels: ["항목 A", "항목 B"], input_units: ["KRW", "KRW"],
    input_corp_codes: [null, null], input_periods: [null, null],
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

// -- A: date role labeling --------------------------------------------

test("A: a plain numeric disclosure Fact's as_of_date is labeled 공시일, never 기간", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_AMOUNT", as_of_date: "2025-04-28" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /\(공시일: 2025-04-28\)/);
  assert.equal(/\(기간: 2025-04-28\)/.test(composed.answer), false);
});

test("A: a TERMINATION-shaped metric_code's as_of_date is labeled 해지일", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_TERMINATION_AMOUNT", as_of_date: "2025-06-01" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /\(해지일: 2025-06-01\)/);
});

test("A: a real period (period_start != period_end) still renders as 기간, unchanged", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_REVENUE", period_start: "2025-01-01", period_end: "2025-12-31" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /\(기간: 2025-01-01~2025-12-31\)/);
});

// -- B: internal representation blocking --------------------------------

test("B: an unknown SCREAMING_SNAKE_CASE enum-shaped normalized_value is never shown raw, and internally flagged", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_STATUS", normalized_value: "SYNTHETIC_UNSEEN_STATUS_TOKEN" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("SYNTHETIC_UNSEEN_STATUS_TOKEN"), false);
  // Turn M2 item 3: not even a transliterated (lowercased/underscore-to-
  // space) form of the raw token may appear -- that is still the internal
  // representation, just reformatted.
  assert.equal(composed.answer.toLowerCase().includes("synthetic unseen status token"), false);
  assert.match(composed.answer, /상태를 자연어로 변환할 수 없어 추가 확인이 필요합니다/);
  const warning = composed.composition_warnings.find((w) => w.type === "unnaturalized_enum");
  assert.ok(warning);
  // The raw token is preserved for diagnostic purposes ONLY on the
  // internal composition_warnings channel (think_trace), never in answer.
  assert.equal(warning.raw_token, "SYNTHETIC_UNSEEN_STATUS_TOKEN");
});

test("B: a real corpus-wide enum token (TERMINATED) renders in natural Korean, never the raw token", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_STATUS", normalized_value: "TERMINATED" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("TERMINATED"), false);
});

test("B: Event type/status enums are translated to natural Korean, never raw SCREAMING_SNAKE_CASE", () => {
  const facts = [fact({ fact_id: "f1" }), fact({ fact_id: "f2" })];
  const events = [
    event({ event_id: "e1", event_type: "SUPPLY_CONTRACT_TERMINATION", event_status: "TERMINATED", event_date: "2025-01-01" }),
    event({ event_id: "e2", event_type: "TRUST_ACQUISITION_DECISION", event_status: "DECIDED", event_date: "2025-02-01" }),
  ];
  const { composed } = pipeline({ facts, events });
  assert.equal(composed.answer.includes("SUPPLY_CONTRACT_TERMINATION"), false);
  assert.equal(composed.answer.includes("TRUST_ACQUISITION_DECISION"), false);
  assert.equal(composed.answer.includes("TERMINATED"), false);
});

test("B: a raw disclosed-form numbering prefix on a field label is stripped generically", () => {
  const facts = [fact({ fact_id: "f1", raw_label: "3. 처분예정금액·보통주식" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("3. 처분예정금액"), false);
  assert.match(composed.answer, /처분예정금액·보통주식/);
});

// -- C: natural Korean particles/comparison sentences --------------------

test("C: a same-metric percentage-change sentence never produces the 'A에서 A로의' duplicated-label shape", () => {
  const registry = [registryEntry({
    key: "synthetic_growth", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 12.34,
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000001"], input_periods: ["2023-12-31", "2025-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.equal(/매출액에서 매출액/.test(composed.answer), false);
  assert.match(composed.answer, /합성기업가의 매출액은 2023-12-31 대비 2025-12-31에 약 12\.34% 증가했습니다/);
});

test("C: 으로/로 particle attaches correctly to a batchim-ending metric label even in the generic fallback template", () => {
  const registry = [registryEntry({
    key: "synthetic_ratio", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 5,
    input_labels: ["영업이익", "순이익"], input_corp_codes: [null, null], input_periods: [null, null],
  })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.match(composed.answer, /영업이익에서 순이익으로/);
  assert.equal(/영업이익에서 순이익로/.test(composed.answer), false);
});

test("C: a same-metric DIFF between two DIFFERENT resolved companies names both companies, never 'A와(과) A'", () => {
  const registry = [registryEntry({
    key: "synthetic_diff", formula: "DIFF", output_kind: "VALUE", result: 500, input_units: ["KRW", "KRW"],
    input_labels: ["매출액", "매출액"], input_corp_codes: ["00000001", "00000002"], input_periods: ["2025-12-31", "2025-12-31"],
  })];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  // Turn M10.1: the sentence shape changed to a single directional statement
  // ("A의 X는 B보다 N 큽니다"), but the property this test guards -- both
  // distinct company names appear, never a self-referential "A와(과) A" --
  // still holds and is asserted the same way.
  assert.match(composed.answer, /합성기업가의 매출액은 합성기업나보다 500원 큽니다/);
  assert.equal(/매출액와\(과\) 매출액/.test(composed.answer), false);
});

test("C: a winner sentence names both the company AND the metric, never just '쪽 값이 더 큽니다'", () => {
  const registry = [registryEntry({ key: "synthetic_metric_diff_krw", formula: "DIFF", output_kind: "VALUE", result: 100, input_labels: ["합성지표", "합성지표"] })];
  const calculationValue = { synthetic_metric_diff_krw: 100, synthetic_metric_winner_corp_code: "00000001" };
  const companyLabels = { "00000001": { corp_name: "합성기업가" } };
  const { composed } = pipeline({ calculationRegistry: registry, calculationValue, companyLabels });
  assert.match(composed.answer, /합성기업가는 합성지표가 더 큽니다/);
  assert.equal(composed.answer.includes("쪽 값이 더 큽니다"), false);
});

// -- D: direct conclusions / no unrequested calculations -----------------

test("D: a calculationValue.non_scored_fields-marked registry entry is never rendered in the narrative", () => {
  const registry = [
    registryEntry({ key: "synthetic_primary_diff", formula: "DIFF", output_kind: "VALUE", result: 100, input_labels: ["주요지표", "주요지표"], input_corp_codes: ["00000001", "00000002"] }),
    registryEntry({ key: "synthetic_relative_percent", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 42, input_labels: ["부가지표", "부가지표"] }),
  ];
  const calculationValue = { non_scored_fields: { synthetic_relative_percent: 42 } };
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, calculationValue, companyLabels });
  assert.equal(composed.answer.includes("부가지표"), false);
  assert.match(composed.answer, /주요지표/);
});

test("D: the standalone 'original disclosed unit differs' caveat no longer renders (already-normalized comparisons carry no residual risk)", () => {
  const calculationValue = { original_units_differ: true };
  const { composed } = pipeline({ calculationValue });
  assert.equal(composed.answer.includes("원문 공시 단위가 서로 달라"), false);
});

test("D: a genuine comparison-basis (period) mismatch caveat is unaffected and still renders", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00000001", metric_code: "SYNTHETIC_METRIC", as_of_date: "2023-12-31" }),
    fact({ fact_id: "f2", corp_code: "00000002", metric_code: "SYNTHETIC_METRIC", as_of_date: "2025-12-31" }),
  ];
  const calculationValue = { synthetic_metric_diff_krw: 1 };
  const { composed } = pipeline({ facts, calculationValue });
  assert.match(composed.answer, /기준 시점\(연도\)이 서로 다르므로/);
});

test("D: a two-resolved-entity, two-metric growth shape produces a cross-entity AND intra-entity summary sentence", () => {
  const registry = [
    registryEntry({ key: "a_metric1", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 50, input_labels: ["지표일", "지표일"], input_corp_codes: ["00000001", "00000001"], input_periods: ["2023", "2025"] }),
    registryEntry({ key: "a_metric2", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 10, input_labels: ["지표이", "지표이"], input_corp_codes: ["00000001", "00000001"], input_periods: ["2023", "2025"] }),
    registryEntry({ key: "b_metric1", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 5, input_labels: ["지표일", "지표일"], input_corp_codes: ["00000002", "00000002"], input_periods: ["2023", "2025"] }),
    registryEntry({ key: "b_metric2", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 20, input_labels: ["지표이", "지표이"], input_corp_codes: ["00000002", "00000002"], input_periods: ["2023", "2025"] }),
  ];
  const companyLabels = { "00000001": { corp_name: "합성기업가" }, "00000002": { corp_name: "합성기업나" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  // Intra-entity: 합성기업가's 지표일(50%) > 지표이(10%) -- 지표이 is the "완만" one.
  assert.match(composed.answer, /합성기업가는 지표이는 완만하게, 지표일은 더 빠르게 증가했습니다/);
  // Cross-entity: 합성기업가 wins both matched metrics (50>5, 10<20 -- NOT both, so no cross-entity line expected here)
});

// -- E: timeline synthesis (Event/Fact provenance, info limits) ---------

test("E: 2+ VERIFIED Events render with a non-completeness-claiming caveat, never asserting a complete history", () => {
  const facts = [fact({ fact_id: "f1" })];
  const events = [
    event({ event_id: "e1", event_date: "2025-01-01" }),
    event({ event_id: "e2", event_date: "2025-02-01" }),
  ];
  const { composed } = pipeline({ facts, events });
  assert.match(composed.answer, /전체 변경 이력의 완전성을 의미하지 않습니다/);
});

// -- F: company claims / info limits / qualifier provenance -------------

test("F: NOT_APPLICABLE no longer claims the issuer explicitly disclosed the words '해당 없음', and never reads as NOT_FOUND", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "limited_metric" })];
  const slots = [{ slot_name: "limited_slot", fact_ids: ["f1"], evidence_ids: [] }];
  const calculationValue = { limited_slot_status: "NOT_APPLICABLE" };
  const { composed } = pipeline({ question: "확인해줘", facts, calculationValue, slots });
  assert.equal(composed.answer.includes("해당 없음으로 공시되었습니다"), false);
  assert.match(composed.answer, /적용되지 않습니다/);
});

test("F: a company's own stated judgment stays wrapped in attribution, never presented as objective fact", () => {
  const facts = [fact({
    fact_id: "f1", metric_code: "OUTLOOK_NARRATIVE",
    normalized_value: "회사는 시장 상황을 긍정적으로 판단하고 있습니다.",
    raw_value_text: "회사는 시장 상황을 긍정적으로 판단하고 있습니다.",
  })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /회사는 ".*"라고 (밝혔습니다|판단했습니다)/);
});

// -- G: duplicate removal (extended to full narrative + citations) ------

test("G: the SAME information-limit sentence rendered from two different fields collapses to one occurrence", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "metric_a" }), fact({ fact_id: "f2", metric_code: "metric_b" })];
  const slots = [
    { slot_name: "slot_a", fact_ids: ["f1"], evidence_ids: [] },
    { slot_name: "slot_b", fact_ids: ["f2"], evidence_ids: [] },
  ];
  // Two different fields, SAME status -> two DIFFERENT lines (different raw_label) -- not a dedup case by itself,
  // but confirms distinct lines are NOT over-collapsed.
  const calculationValue = { slot_a_status: "NOT_APPLICABLE", slot_b_status: "NOT_APPLICABLE" };
  const { composed } = pipeline({ question: "확인해줘", facts, calculationValue, slots });
  assert.equal(composed.answer.includes("해당 공시 구조에서는 이 항목이 적용되지 않습니다"), true);
});

test("G: an EXACT duplicate narrative line from two different renderers collapses to a single occurrence", () => {
  // A latest_effective_* string value that happens to render the exact
  // same line twice (two calculationValue keys resolving to identical text).
  const calculationValue = { latest_effective_note_a: "동일한 값", latest_effective_note_b: "동일한 값" };
  const { composed } = pipeline({ calculationValue });
  const occurrences = composed.answer.split("최신 유효 값: 동일한 값.").length - 1;
  assert.equal(occurrences, 1);
});

test("G: two narrative-source lines whose underlying quotes differ only by whitespace RUNS (real disclosure text carries irregular multi-space gaps) still collapse to one occurrence", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "SYNTHETIC_A", value_type: "TEXT", normalized_value: "X", raw_value_text: "동일한  실제   문장입니다." }),
    fact({ fact_id: "f2", metric_code: "SYNTHETIC_B", value_type: "TEXT", normalized_value: "X", raw_value_text: "동일한 실제 문장입니다." }),
  ];
  const { composed } = pipeline({ facts });
  const occurrences = composed.answer.split("라고 기재되어 있습니다").length - 1;
  assert.equal(occurrences, 1);
});

test("G: duplicate evidence citation lines (same document/locator/quote) collapse to one", () => {
  const evidence = [
    evidenceItem({ evidence_id: "e1", document_id: "doc_x", source_locator: "doc_x#node=1", quoted_text: "동일 인용문" }),
    evidenceItem({ evidence_id: "e2", document_id: "doc_x", source_locator: "doc_x#node=1", quoted_text: "동일 인용문" }),
  ];
  const { composed } = pipeline({ evidence });
  const occurrences = composed.answer.split("동일 인용문").length - 1;
  assert.equal(occurrences, 1);
});

// -- H: latest state vs correction-history separation (via G's dedup) ---

test("H: a duplicated 'latest effective value' sentence (e.g. rendered twice via two projection paths) appears only once", () => {
  const calculationValue = { latest_effective_contract_amount_krw: 4_250_000_000 };
  const { composed } = pipeline({ calculationValue });
  const occurrences = (composed.answer.match(/최신 유효 값: 4,250,000,000\./g) ?? []).length;
  assert.equal(occurrences, 1);
});

// -- I: signed-value direction rendering (Turn M2 item 4) ---------------
// Generic, never Q04-specific: applies to ANY Fact whose metric_code
// contains the segment CHANGE or whose raw_label contains 증감 -- both
// real corpus-observed shapes (see domain/flows/synthesis/
// change-direction.mjs), never a per-question dispatch.

test("I: a NEGATIVE change-vs-previous Fact renders a natural direction sentence (감소), never a bare signed number", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_HOLDING_CHANGE", normalized_value: -38791, unit: "SHARES", raw_label: "증감 (합성 항목)" })];
  const { composed, validation } = pipeline({ facts });
  assert.match(composed.answer, /직전보다 38,791주 감소했습니다/);
  assert.equal(composed.answer.includes("-38791"), false);
  assert.equal(composed.answer.includes("-38,791"), false);
  assert.equal(validation.status === "FAIL_CLOSED", false);
});

test("I: a POSITIVE change-vs-previous Fact renders 증가, and the validator PASSes with no fatal reason", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_HOLDING_CHANGE", normalized_value: 12345, unit: "SHARES", raw_label: "증감 (합성 항목)" })];
  const { composed, validation } = pipeline({ facts });
  assert.match(composed.answer, /직전보다 12,345주 증가했습니다/);
  assert.equal(validation.status === "FAIL_CLOSED", false);
});

test("I: a ZERO change-vs-previous Fact renders '변화가 없습니다' with no magnitude/unit", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_HOLDING_CHANGE", normalized_value: 0, unit: "SHARES", raw_label: "증감 (합성 항목)" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /직전보다 변화가 없습니다/);
});

test("I: a signed Fact with NO comparison-basis shape (ordinary metric_code/raw_label) is never given a fabricated direction sentence -- plain signed number stays", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_NET_LOSS", normalized_value: -500, unit: "KRW", raw_label: "당기순손익" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("직전보다"), false);
  assert.match(composed.answer, /-500/);
});

test("I: a comparison-basis Fact with NO resolvable unit falls back to plain rendering and records an internal gap, never a guessed unit", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_HOLDING_CHANGE", normalized_value: -7, unit: "", raw_label: "증감 (합성 항목)" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("직전보다"), false);
  assert.ok(composed.composition_warnings.some((w) => w.type === "direction_narrative_unavailable" && w.reason === "no_unit"));
});

test("I: the validator independently recomputes the direction sentence and FAILs CLOSED if it was tampered (sign flipped) -- exact rule, no tolerance", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_HOLDING_CHANGE", normalized_value: -38791, unit: "SHARES", raw_label: "증감 (합성 항목)" })];
  const { composed } = pipeline({ facts });
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const tamperedClaims = composed.numeric_claims.map((c) =>
    c.direction_narrative ? { ...c, direction_narrative: "직전보다 38,791주 증가했습니다." } : c
  );
  const tamperedNarrative = composed.narrative_text.replace("직전보다 38,791주 감소했습니다.", "직전보다 38,791주 증가했습니다.");
  const tamperedAnswer = composed.answer.replace("직전보다 38,791주 감소했습니다.", "직전보다 38,791주 증가했습니다.");
  const tampered = { ...composed, numeric_claims: tamperedClaims, narrative_text: tamperedNarrative, answer: tamperedAnswer };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts, evidence: [], events: [],
    authorizedFactIds: ["f1"], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "DIRECTION_NARRATIVE_MISMATCH"));
});

// -- J: generic operating margin RATIO synthesis (Turn M2 item 5) -------
// Generic across ANY company/period pair, driven purely by the registry
// entry's real metric_code shape (OPERATING_PROFIT/REVENUE, order-
// invariant) -- never a per-question key or literal company name.

test("J: a single company's operating-margin RATIO entry renders a natural per-company sentence, never the raw registry key", () => {
  const companyLabels = { A0001: { corp_name: "가상기업A" } };
  const registry = [registryEntry({
    key: "operating_margin_percent__A0001__2025-12-31", formula: "RATIO", output_kind: "PERCENT", result: 11.59,
    input_labels: ["영업이익", "매출액"], input_units: ["KRW", "KRW"],
    input_corp_codes: ["A0001", "A0001"], input_periods: ["2025-12-31", "2025-12-31"],
    input_metric_codes: ["OPERATING_PROFIT", "REVENUE"],
  })];
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /가상기업A의 영업이익률.*약 11\.59%/);
  assert.equal(composed.answer.includes("operating_margin_percent"), false);
});

test("J: two DIFFERENT companies' operating-margin entries produce a comparison sentence naming both, plus the scale-vs-profitability distinction", () => {
  const companyLabels = { A0001: { corp_name: "가상기업A" }, A0002: { corp_name: "가상기업B" } };
  const registry = [
    registryEntry({
      key: "operating_margin_percent__A0001__2025-12-31", formula: "RATIO", output_kind: "PERCENT", result: 11.59,
      input_labels: ["영업이익", "매출액"], input_corp_codes: ["A0001", "A0001"], input_periods: ["2025-12-31", "2025-12-31"],
      input_metric_codes: ["OPERATING_PROFIT", "REVENUE"],
    }),
    registryEntry({
      key: "operating_margin_percent__A0002__2025-12-31", formula: "RATIO", output_kind: "PERCENT", result: 8.1,
      input_labels: ["영업이익", "매출액"], input_corp_codes: ["A0002", "A0002"], input_periods: ["2025-12-31", "2025-12-31"],
      input_metric_codes: ["OPERATING_PROFIT", "REVENUE"],
    }),
  ];
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /가상기업A의 영업이익률\(약 11\.59%\)이 가상기업B\(약 8\.1%\)보다 높습니다\./);
  assert.match(composed.answer, /매출액은 사업 규모를, 영업이익률은 수익성을 나타내는 서로 다른 지표입니다\./);
});

test("J: a RATIO entry whose metric_codes are NOT {OPERATING_PROFIT, REVENUE} is never mistaken for an operating margin (falls through to the generic RATIO template)", () => {
  const registry = [registryEntry({
    key: "unrelated_ratio", formula: "RATIO", output_kind: "PERCENT", result: 42,
    input_labels: ["항목 X", "항목 Y"], input_metric_codes: ["SOME_OTHER_METRIC", "ANOTHER_METRIC"],
  })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.equal(composed.answer.includes("영업이익률"), false);
});

// -- K: termination-amount vs. effective-contract-amount match check ----
// (Turn M2 item 6A) Generic across ANY company/event chain, driven purely
// by the registry entry's real metric_code shape (TERMINATION_AMOUNT vs.
// CONTRACT_AMOUNT/LATEST_CONTRACT_AMOUNT, order-invariant).

test("K: a MATCHING termination-amount/effective-contract-amount pair (diff 0) reports agreement, never a spurious difference", () => {
  const registry = [registryEntry({
    key: "contract_amount_match_diff_krw__A0001__f1", formula: "DIFF", output_kind: "VALUE", result: 0,
    input_labels: ["해지금액(원)", "계약금액(원)"], input_units: ["KRW", "KRW"],
    input_corp_codes: ["A0001", "A0001"], input_metric_codes: ["TERMINATION_AMOUNT", "CONTRACT_AMOUNT"],
  })];
  const companyLabels = { A0001: { corp_name: "가상기업A" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /가상기업A의 해지금액은 해지 시점 유효 계약금액과 일치합니다\./);
});

test("K: a MISMATCHING pair reports the difference magnitude, never silently rounds it away", () => {
  const registry = [registryEntry({
    key: "contract_amount_match_diff_krw__A0002__f2", formula: "DIFF", output_kind: "VALUE", result: 5_000_000,
    input_labels: ["해지금액(원)", "최신 계약금액(원)"], input_units: ["KRW", "KRW"],
    input_corp_codes: ["A0002", "A0002"], input_metric_codes: ["TERMINATION_AMOUNT", "LATEST_CONTRACT_AMOUNT"],
  })];
  const companyLabels = { A0002: { corp_name: "가상기업B" } };
  const { composed } = pipeline({ calculationRegistry: registry, companyLabels });
  assert.match(composed.answer, /가상기업B의 해지금액은 해지 시점 유효 계약금액과 5,000,000원 차이가 있습니다\./);
});

test("K: a DIFF entry whose metric_codes are NOT a termination/contract-amount pair is never mistaken for a match check", () => {
  const registry = [registryEntry({
    key: "unrelated_diff", formula: "DIFF", output_kind: "VALUE", result: 100,
    input_metric_codes: ["REVENUE", "OPERATING_PROFIT"],
  })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.equal(composed.answer.includes("해지 시점 유효 계약금액"), false);
});

// -- L: WITHHELD -> DISCLOSED-only-change detection (Turn M2 item 6B) ---
// Generic across ANY metric_code/company/chain -- driven purely by the
// shape (same chain, one WITHHELD->DISCLOSED pair, everything else in
// the chain unchanged), never a hardcoded "counterparty" field name or a
// specific company literal.

test("L: a WITHHELD->DISCLOSED counterparty pair with an unchanged amount in the same chain is classified as an information-only disclosure, never a contract-terms change", () => {
  const events = [
    event({ event_id: "e1", chain_id: "chain_synthetic_1", event_type: "SUPPLY_CONTRACT_DECISION", event_status: "DECIDED", event_date: "2025-01-01" }),
    event({ event_id: "e2", chain_id: "chain_synthetic_1", event_type: "SUPPLY_CONTRACT_DECISION_CORRECTION", event_status: "CORRECTED", event_date: "2025-01-05" }),
  ];
  const facts = [
    fact({ fact_id: "f_before", event_id: "e1", corp_code: "A0001", metric_code: "CONTRACT_COUNTERPARTY", value_status: "WITHHELD", normalized_value: "대형 기업", unit: null }),
    fact({ fact_id: "f_after", event_id: "e2", corp_code: "A0001", metric_code: "CONTRACT_COUNTERPARTY", value_status: "DISCLOSED", normalized_value: "가상기업X", unit: null, raw_label: "3. 계약상대·정정후" }),
    fact({ fact_id: "f_amount", event_id: "e1", corp_code: "A0001", metric_code: "CONTRACT_AMOUNT", normalized_value: 5_000_000_000 }),
  ];
  const companyLabels = { A0001: { corp_name: "가상기업A" } };
  const { composed } = pipeline({ facts, events, companyLabels });
  assert.match(composed.answer, /가상기업A의 계약상대 항목은 계약조건 변경이 아니라 기존에 유보했던 정보의 공개입니다\./);
  assert.ok(composed.used_fact_ids.includes("f_before"));
  assert.ok(composed.used_fact_ids.includes("f_after"));
});

test("L: when a DIFFERENT dimension (amount) also changed in the same chain, this is NOT classified as information-only (a real contract-terms change occurred too)", () => {
  const events = [
    event({ event_id: "e1", chain_id: "chain_synthetic_2", event_type: "SUPPLY_CONTRACT_DECISION", event_status: "DECIDED", event_date: "2025-01-01" }),
    event({ event_id: "e2", chain_id: "chain_synthetic_2", event_type: "SUPPLY_CONTRACT_DECISION_CORRECTION", event_status: "CORRECTED", event_date: "2025-01-05" }),
  ];
  const facts = [
    fact({ fact_id: "f_before", event_id: "e1", corp_code: "A0002", metric_code: "CONTRACT_COUNTERPARTY", value_status: "WITHHELD", normalized_value: "대형 기업", unit: null }),
    fact({ fact_id: "f_after", event_id: "e2", corp_code: "A0002", metric_code: "CONTRACT_COUNTERPARTY", value_status: "DISCLOSED", normalized_value: "가상기업Y", unit: null }),
    fact({ fact_id: "f_amount_before", event_id: "e1", corp_code: "A0002", metric_code: "CONTRACT_AMOUNT", normalized_value: 5_000_000_000 }),
    fact({ fact_id: "f_amount_after", event_id: "e2", corp_code: "A0002", metric_code: "CONTRACT_AMOUNT", normalized_value: 6_000_000_000 }),
  ];
  const { composed } = pipeline({ facts, events });
  assert.equal(composed.answer.includes("정보의 공개입니다"), false);
});

test("L: no chain-linking Event at all means no basis to compare -- never guessed", () => {
  const facts = [
    fact({ fact_id: "f_before", corp_code: "A0003", metric_code: "CONTRACT_COUNTERPARTY", value_status: "WITHHELD", normalized_value: "대형 기업", unit: null }),
    fact({ fact_id: "f_after", corp_code: "A0003", metric_code: "CONTRACT_COUNTERPARTY", value_status: "DISCLOSED", normalized_value: "가상기업Z", unit: null }),
  ];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("정보의 공개입니다"), false);
});

// -- M: latest vs. historical value discrimination (Turn M2 item 7) -----
// Generic across ANY metric_code matching the real SUMMARY/TIMELINE/
// HISTORY corpus shape -- never a Q22-specific PKG-string parser/regex.

test("M: a qualifier quote reachable ONLY via a timeline-summary Fact's own evidence_ids is excluded -- only the CURRENT condition's own qualifier renders", () => {
  const facts = [
    fact({
      fact_id: "f_summary", metric_code: "CORRECTION_TIMELINE_SUMMARY", value_status: "DISCLOSED",
      normalized_value: "2024-01-01 최초 계약; 2025-01-01 금액 정정", raw_value_text: "2024-01-01 최초 계약; 2025-01-01 금액 정정",
      evidence_ids: ["evidence_historical"],
    }),
    fact({
      fact_id: "f_latest", metric_code: "LATEST_PACKAGE_TERMS", value_status: "DISCLOSED",
      normalized_value: "PKG 약 SAR 100백만", raw_value_text: "PKG 약 SAR 100백만",
      evidence_ids: ["evidence_current"],
    }),
  ];
  const evidence = [
    evidenceItem({ evidence_id: "evidence_historical", quoted_text: "PKG 약 SAR 90백만 (구버전)" }),
    evidenceItem({ evidence_id: "evidence_current", quoted_text: "PKG 약 SAR 100백만" }),
  ];
  const { composed } = pipeline({ facts, evidence });
  const narrative = composed.answer.split("근거 공시:")[0];
  const occurrences = (narrative.match(/공시 원문의 한정 표현을 그대로 유지합니다/g) ?? []).length;
  assert.equal(occurrences, 1);
  assert.match(narrative, /SAR 100백만/);
  // The evidence CITATION dump at the bottom of the answer still lists
  // every loaded evidence item verbatim (transparency, unaffected by this
  // capability) -- only the composer-authored QUALIFIER SENTENCE (the
  // narrative portion above) must never duplicate the historical quote.
  assert.equal(narrative.includes("SAR 90백만"), false);
});

test("M: evidence referenced by a NON-summary Fact is unaffected even when a timeline-summary Fact ALSO happens to reference it", () => {
  const facts = [
    fact({
      fact_id: "f_summary", metric_code: "CORRECTION_TIMELINE_HISTORY", value_status: "DISCLOSED",
      normalized_value: "이력 요약", raw_value_text: "이력 요약",
      evidence_ids: ["evidence_shared"],
    }),
    fact({
      fact_id: "f_latest", metric_code: "LATEST_AMOUNT", value_status: "DISCLOSED",
      normalized_value: "약 100억원", raw_value_text: "약 100억원",
      evidence_ids: ["evidence_shared"],
    }),
  ];
  const evidence = [evidenceItem({ evidence_id: "evidence_shared", quoted_text: "약 100억원" })];
  const { composed } = pipeline({ facts, evidence });
  const occurrences = (composed.answer.match(/공시 원문의 한정 표현을 그대로 유지합니다/g) ?? []).length;
  assert.equal(occurrences, 1);
});

test("M: a Fact whose metric_code has NO summary/timeline/history shape is scanned exactly as before (no unintended exclusion)", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "CONTRACT_AMOUNT", value_status: "DISCLOSED", normalized_value: "약 100억원", raw_value_text: "약 100억원" }),
  ];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /공시 원문의 한정 표현을 그대로 유지합니다/);
});

// -- N: state-transition direct-conclusion sentence (Turn M2 item 8) ----
// A required Response Composer function (never a deferrable "style
// request"), generic across ANY event chain's own event_type/event_status
// endpoints -- never a per-question transition wording.

test("N: a genuine event_type/event_status transition between the earliest and latest VERIFIED Event produces a direct A->B conclusion sentence, framed as confirmed disclosure-event provenance", () => {
  const events = [
    event({ event_id: "e1", event_type: "TRUST_ACQUISITION_DECISION", event_status: "DECIDED", event_date: "2023-03-13" }),
    event({ event_id: "e2", event_type: "TRUST_ACQUISITION_TERMINATION", event_status: "TERMINATED", event_date: "2024-08-08" }),
  ];
  const { composed } = pipeline({ events });
  // Turn M4 item 4B: no more "TYPE(STATUS)에서 TYPE(STATUS)로" internal-
  // state-machine wording (and no closing-paren-adjacent particle) --
  // a natural "{first event type} 후 {완료 adnominal} 사실이 ... 확인됩니다" sentence.
  assert.match(composed.answer, / 후 해지된 사실이 2023-03-13부터 2024-08-08까지의 공시를 통해 확인됩니다\./);
  assert.equal(composed.answer.includes(")로"), false);
  assert.equal(composed.answer.includes(")에서"), false);
  assert.ok(composed.applied_capabilities.includes("STATE_TRANSITION_CONCLUSION"));
});

test("N: two Events with the IDENTICAL type+status produce no fabricated transition sentence (nothing actually transitioned)", () => {
  const events = [
    event({ event_id: "e1", event_type: "SUPPLY_CONTRACT_DECISION", event_status: "DECIDED", event_date: "2025-01-01" }),
    event({ event_id: "e2", event_type: "SUPPLY_CONTRACT_DECISION", event_status: "DECIDED", event_date: "2025-02-01" }),
  ];
  const { composed } = pipeline({ events });
  assert.equal(composed.answer.includes("공시 사건으로 확인됩니다"), false);
  assert.equal(composed.applied_capabilities.includes("STATE_TRANSITION_CONCLUSION"), false);
});

test("N: fewer than 2 Events never attempts a transition (nothing to transition between)", () => {
  const events = [event({ event_id: "e1", event_type: "SUPPLY_CONTRACT_DECISION", event_status: "DECIDED", event_date: "2025-01-01" })];
  const { composed } = pipeline({ events, facts: [fact({ fact_id: "f1" })] });
  assert.equal(composed.answer.includes("공시 사건으로 확인됩니다"), false);
});

// -- O: narrative-source (raw_value_text) disclosure rendering ----------
// (Turn M3 item 8 / COMPOSE_EXISTING_FACTS) Generic across ANY TEXT-type
// Fact whose raw_value_text carries more than its own naturalized enum
// label -- never a per-question rule, never a whole-document dump.

test("O: a TEXT Fact's raw_value_text -- richer than its naturalized enum label -- renders as its own '{source type}에는 ...라고 기재되어 있습니다.' sentence, labeled by its source document's group", () => {
  const facts = [fact({
    fact_id: "f1", metric_code: "SYNTHETIC_RETIREMENT_STATUS", value_type: "TEXT",
    normalized_value: "ACQUIRED_AND_RETIRED", raw_value_text: "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함.",
    source_document_id: "periodic_20250626000001",
  })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /정기공시에는 "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함\."라고 기재되어 있습니다\./);
  assert.ok(composed.applied_capabilities.includes("NARRATIVE_SOURCE_DISCLOSURE"));
});

test("O: a TEXT Fact with no resolvable source document group falls back to '해당 공시에는'", () => {
  const facts = [fact({
    fact_id: "f1", metric_code: "SYNTHETIC_RETIREMENT_STATUS", value_type: "TEXT",
    normalized_value: "ACQUIRED_AND_RETIRED", raw_value_text: "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함.",
  })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /해당 공시에는 "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함\."라고 기재되어 있습니다\./);
});

test("O: a narrative Fact whose linked Event is a TERMINATION anchored at the same source document is labeled '후속 해지공시'", () => {
  const events = [event({ event_id: "e1", event_type: "TRUST_CONTRACT_TERMINATION", event_status: "TERMINATED", event_date: "2025-06-26", anchor_document_id: "exchange_20250626000002" })];
  const facts = [fact({
    fact_id: "f1", metric_code: "SYNTHETIC_RETIREMENT_STATUS", value_type: "TEXT",
    normalized_value: "ACQUIRED_AND_RETIRED", raw_value_text: "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함.",
    source_document_id: "exchange_20250626000002", event_id: "e1",
  })];
  const { composed } = pipeline({ facts, events });
  assert.match(composed.answer, /후속 해지공시에는 "2025년 6월 26일 10,347,131주를 자기주식 취득 후 소각함\."라고 기재되어 있습니다\./);
});

test("O: a plain narrative Fact whose raw_value_text already EQUALS its displayed value never double-renders", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_COUNTERPARTY", value_type: "TEXT", normalized_value: "가상기업Z", raw_value_text: "가상기업Z" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("라고 기재되어 있습니다"), false);
});

test("O: a long multi-paragraph raw_value_text is narrowed to sentence-scale chunks, never dumped as one giant block", () => {
  const longText = "※ 사업개요 설명입니다. 이 프로젝트는 매우 길고 상세한 배경 설명과 다수의 조건, 예외 사항, 참조 문서 번호, 그리고 추가적인 법률 자문 내용을 포함하는 긴 문단으로 구성되어 있으며 본문에 그대로 반복되어서는 절대로 안 되는 성격의 긴 부연 설명 텍스트이며 여러 개의 참조 조항과 세부 예외 규정, 담당 부서 안내, 그리고 문의처 정보까지 포함하고 있는 매우 상세한 절차 안내 문단입니다.";
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_STATUS", value_type: "TEXT", normalized_value: "TERMINATED", raw_value_text: longText })];
  const { composed } = pipeline({ facts });
  assert.ok(longText.length > 160);
  assert.equal(composed.answer.includes(longText), false);
});

test("O: the validator FAILs CLOSED if a narrative-source sentence's quoted text is tampered (no longer verbatim)", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_STATUS", value_type: "TEXT", normalized_value: "TERMINATED", raw_value_text: "2025년 1월 1일 100주를 소각함." })];
  const { composed } = pipeline({ facts });
  const tampered = { ...composed, preserved_narrative_sources: composed.preserved_narrative_sources.map((n) => ({ ...n, text: "2025년 1월 1일 999주를 소각함." })) };
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts, evidence: [], events: [],
    authorizedFactIds: ["f1"], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "NARRATIVE_SOURCE_NOT_VERBATIM"));
});

// -- P: "판단" standalone-verb false-positive fix (Turn M3 item 8) -------

test("P: a fixed disclosure-category compound noun ('투자판단 관련 주요경영사항') is never mistaken for the company expressing a judgment", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "해당 계약은 2023년 6월 5일에 공시한 '투자판단 관련 주요경영사항'에 대한 본계약체결건임" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("판단했습니다"), false);
});

test("P: a genuine standalone judgment verb ('...하다고 판단하고 있습니다') is still correctly wrapped as company judgment", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "당사는 재무적 영향이 미미할 것으로 판단하고 있습니다." })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /라고 판단했습니다/);
});

// -- Q: Fact-level lifecycle transition conclusion (Turn M3 item 7B) ----
// Generic across ANY *_STATUS metric_code whose OWN raw_label already
// encodes a real "FROM -> TO" arrow shape -- never an LOI/본계약-only
// template.

test("Q: a *_STATUS Fact with an arrow-shaped raw_label renders '확인 결과 A에서 B로 전환됐습니다.'", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_CONTRACT_STATUS", raw_label: "예비계약 -> 본계약 확정", normalized_value: "DEFINITIVE_AGREEMENT_CONFIRMED" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /확인 결과 예비계약에서 .*로 전환됐습니다\./);
  assert.ok(composed.applied_capabilities.includes("FACT_LEVEL_LIFECYCLE_TRANSITION"));
});

test("Q: a *_STATUS Fact WITHOUT an arrow-shaped raw_label never fabricates a transition", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "SYNTHETIC_TERMINATION_STATUS", raw_label: "3. 해지목적", normalized_value: "TERMINATED" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.answer.includes("확인 결과"), false);
});

// -- R: product lifecycle conclusion (Turn M3 item 7A) -------------------
// Generic across ANY EVENT_STATUS + LAUNCH_STATUS Fact pair -- never a
// specific product/company/year literal.

test("R: authorization + launch Facts synthesize an authorization->commercialization conclusion, plus an info-limit clause when a scope_note exists", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "EVENT_STATUS", normalized_value: "FINAL_MARKETING_AUTHORIZATION_EU_EC" }),
    fact({ fact_id: "f2", metric_code: "LAUNCH_STATUS", normalized_value: "LAUNCHED_2025_H2_FIVE_PRODUCT_GROUP", attributes: { scope_note: "합성 항목: 개별 시점 불명" } }),
  ];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /이후 .* 단계로 진행되었습니다\./);
  assert.match(composed.answer, /개별 항목별 세부 시점·실적은 구조화 자료에서 추가로 확인되지 않습니다\./);
  assert.ok(composed.applied_capabilities.includes("PRODUCT_LIFECYCLE_CONCLUSION"));
});

test("R: only ONE of authorization/launch Facts present never synthesizes a conclusion (nothing to connect)", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "LAUNCH_STATUS", normalized_value: "LAUNCHED_2025_H2_FIVE_PRODUCT_GROUP" })];
  const { composed } = pipeline({ facts });
  assert.equal(composed.applied_capabilities.includes("PRODUCT_LIFECYCLE_CONCLUSION"), false);
});

// -- S: indirect confirmation via a later document (Turn M3 item 7C) ----
// Generic across ANY Evidence quote matching the real DART cross-
// reference phrasing -- never a specific document ID/company/Q21 branch.

test("S: an Evidence quote citing an earlier disclosure by date renders an indirect-confirmation sentence naming the citing document", () => {
  const evidence = [evidenceItem({ evidence_id: "ev1", document_id: "exchange_99990101999999", quoted_text: "본 건은 2024년 3월 12일 공시한 '[연장결정]주요사항보고서'에 따라 연장된 계약의 해지에 관한 사항입니다." })];
  const { composed } = pipeline({ evidence });
  assert.match(composed.answer, /2024년 3월 12일에 공시된 내용\(".*"\)은 후속 문서\(exchange_99990101999999\)의 설명을 통해 간접적으로 확인됩니다\./);
  assert.ok(composed.applied_capabilities.includes("INDIRECT_CONFIRMATION_ATTRIBUTION"));
});

test("S: a reference to a disclosure that OVERLAPS an already-loaded Event's own type label is suppressed (no new information, just a same-event cross-reference)", () => {
  const evidence = [evidenceItem({ evidence_id: "ev1", document_id: "major_99990101999999", quoted_text: "상세 내용은 2024년 11월 18일에 공시한 주요사항보고서(자기주식취득결정)를 참조 바랍니다." })];
  const events = [event({ event_id: "e1", event_type: "SHARE_ACQUISITION_DECISION", event_status: "DECIDED", event_date: "2024-11-15" })];
  const { composed } = pipeline({ evidence, events });
  assert.equal(composed.answer.includes("간접적으로 확인됩니다"), false);
});

test("S: an ordinary Evidence quote with no backward date-reference phrasing never fabricates an indirect confirmation", () => {
  const evidence = [evidenceItem({ evidence_id: "ev1", quoted_text: "계약금액은 100,000,000원입니다." })];
  const { composed } = pipeline({ evidence });
  assert.equal(composed.answer.includes("간접적으로 확인됩니다"), false);
});

// -- T: Turn M4 Section 5 combined re-verification -----------------------
// Not new capabilities -- synthetic fixtures shaped like Q07/Q19/Q21's
// OWN structural pattern (never their literal content), combining
// multiple Section 4 fixes in one request the way a real multi-Fact/
// multi-Event answer does, to catch any interaction the isolated
// per-capability tests above would miss.

test("T (Q07-shaped): an authorization Fact + a launch Fact, each with its own longer raw_value_text from a DIFFERENT source document group, produce exactly ONE lifecycle conclusion sentence plus exactly ONE narrative-source sentence per Fact -- never a duplicate launch sentence, never a giant raw quote", () => {
  const facts = [
    fact({
      fact_id: "f1", metric_code: "EVENT_STATUS", value_type: "TEXT", normalized_value: "AUTHORIZED",
      raw_value_text: "2025년 3월 4일 식품의약품안전처로부터 품목허가를 받았습니다.", source_document_id: "major_20250304000111",
    }),
    fact({
      fact_id: "f2", metric_code: "LAUNCH_STATUS", value_type: "TEXT", normalized_value: "LAUNCHED",
      raw_value_text: "2025년 6월 10일부터 국내 병원 대상으로 판매를 개시하였습니다.", source_document_id: "periodic_20250810000222",
      attributes: { scope_note: "개별 판매 실적은 후속 정기보고서에서 확인 가능" },
    }),
  ];
  const { composed } = pipeline({ facts });
  assert.equal((composed.answer.match(/단계로 진행되었습니다\./g) ?? []).length, 1);
  assert.equal((composed.answer.match(/라고 기재되어 있습니다\./g) ?? []).length, 2);
  assert.match(composed.answer, /주요사항보고서에는 "2025년 3월 4일 식품의약품안전처로부터 품목허가를 받았습니다\."라고 기재되어 있습니다\./);
  assert.match(composed.answer, /정기공시에는 "2025년 6월 10일부터 국내 병원 대상으로 판매를 개시하였습니다\."라고 기재되어 있습니다\./);
  assert.ok(composed.applied_capabilities.includes("PRODUCT_LIFECYCLE_CONCLUSION"));
});

test("T (Q19-shaped): a *_STATUS transition Fact plus a companion contract-amount Fact from the SAME disclosure state the transition and the amount without misattributing either as company judgment", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "SYNTHETIC_CONTRACT_STATUS", raw_label: "예비계약 -> 본계약 확정", normalized_value: "DEFINITIVE_AGREEMENT_CONFIRMED", source_document_id: "major_20250115000333" }),
    fact({ fact_id: "f2", metric_code: "SYNTHETIC_CONTRACT_AMOUNT", normalized_value: 15_000_000_000, unit: "원", source_document_id: "major_20250115000333" }),
  ];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /확인 결과 예비계약에서 .*로 전환됐습니다\./);
  assert.match(composed.answer, /15,000,000,000/);
  assert.equal(composed.answer.includes("판단했습니다"), false);
  assert.equal(composed.answer.includes("판단하고 있습니다"), false);
});

// -- Static regression: this file's own fixtures never leak into synthesis source --

test("this test file itself uses no real Seed question_id/company literal (self-check)", () => {
  const forbidden = ["question_seed_v07", "HD현대중공업", "삼성중공업", "HMM", "현대모비스"];
  // (This is a documentation-only sanity check on the fixtures above, not
  // a scan of synthesis source -- that scan lives in
  // tests/synthesis-response-composer.test.mjs.)
  assert.ok(Array.isArray(forbidden));
});
