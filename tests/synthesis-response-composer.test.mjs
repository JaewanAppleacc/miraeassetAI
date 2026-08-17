// TDD suite for the common Thin Agent Response Composer
// (domain/flows/synthesis/*.mjs). Covers generalization behavior over
// entirely synthetic fixture data (never real Seed corpus records), the
// P0/P1/P2 trust-boundary fixes from the Codex-reproduced defect list
// (typed numeric/date claim grounding, qualifier/attribution span
// narrowing, latest-state object rendering, capability-honesty, and
// no internal-error/capability-ID leakage into the external answer), and
// overfitting regression checks on the new module source files.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";
import { limitationLabelKo } from "../domain/flows/synthesis/capability-labels.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SYNTHESIS_DIR = path.join(ROOT, "domain/flows/synthesis");

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "test_metric",
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
    event_id: "event_default", event_type: "AMENDS", event_date: "2025-01-01",
    event_status: "EFFECTIVE", anchor_document_id: "doc_default", attributes: {}, ...overrides,
  };
}

function pipeline({ question, facts = [], events = [], evidence = [], calculationValue = {}, slots = [], calculationRegistry = [], companyLabels = null }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, calculationRegistry, companyLabels });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { signals, narrativeFields, composed, validation };
}

// -- Generalization behavior --------------------------------------------

test("two entities never mix without company labels", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "A0001", company_name: "가상기업A", metric_code: "revenue", normalized_value: 1000, period_start: "2023-01-01", period_end: "2023-12-31" }),
    fact({ fact_id: "f2", corp_code: "A0002", company_name: "가상기업B", metric_code: "revenue", normalized_value: 2000, period_start: "2023-01-01", period_end: "2023-12-31" }),
  ];
  const { composed } = pipeline({ question: "두 회사의 매출을 비교해줘", facts });
  assert.ok(composed.answer.includes("가상기업A"));
  assert.ok(composed.answer.includes("가상기업B"));
  assert.ok(composed.applied_capabilities.includes("ENTITY_AND_PERIOD_LABELING"));
});

test("computed diff/change values are explained as direction sentences, not just numbers (Turn I: via calculationRegistry, never a snake_case base-name label); winner resolves via companyLabels/corp_code, never a Flow literal (§5-A)", () => {
  const facts = [fact({ fact_id: "f1", corp_code: "A0001" }), fact({ fact_id: "f2", corp_code: "A0002" })];
  const calculationValue = { revenue_diff_krw: 500, revenue_winner_corp_code: "A0002" };
  const calculationRegistry = [{
    key: "revenue_diff_krw", formula: "DIFF", output_kind: "VALUE", result: 500,
    input_fact_ids: ["f1", "f2"], input_labels: ["A사 매출", "B사 매출"], input_units: ["KRW", "KRW"],
  }];
  const companyLabels = { A0002: { corp_name: "가상기업B" } };
  const { composed, signals } = pipeline({ question: "매출 차이를 계산해줘", facts, calculationValue, calculationRegistry, companyLabels });
  assert.ok(signals.comparison_dimensions.includes("revenue_diff_krw"));
  assert.ok(composed.applied_capabilities.includes("COMPARATIVE_CONCLUSION"));
  assert.match(composed.answer, /차이는 500원입니다/);
  assert.match(composed.answer, /가상기업B/);
  assert.equal(composed.answer.includes("revenue_diff_krw"), false);
});

test(">=3 events are synthesized in chronological order with changed fields linked", () => {
  const events = [
    event({ event_id: "e3", event_type: "TERMINATES", event_date: "2025-03-01", attributes: { changed_fields: ["status"] } }),
    event({ event_id: "e1", event_type: "DISCLOSES", event_date: "2025-01-01", attributes: { changed_fields: ["amount"] } }),
    event({ event_id: "e2", event_type: "AMENDS", event_date: "2025-02-01", attributes: { changed_fields: ["amount", "end_date"] } }),
  ];
  const { composed } = pipeline({ question: "사건을 시간순으로 정리해줘", events });
  const idx1 = composed.answer.indexOf("2025-01-01");
  const idx2 = composed.answer.indexOf("2025-02-01");
  const idx3 = composed.answer.indexOf("2025-03-01");
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2);
  assert.match(composed.answer, /변경 필드: amount/);
  assert.ok(composed.applied_capabilities.includes("TEMPORAL_EVENT_SYNTHESIS"));
});

for (const status of ["NOT_FOUND", "NOT_APPLICABLE", "OUTSIDE_CORPUS", "WITHHELD"]) {
  test(`information limit status ${status} is preserved in the answer, not silently dropped`, () => {
    const facts = [fact({ fact_id: "f1", metric_code: "limited_metric" })];
    const slots = [{ slot_name: "limited_slot", fact_ids: ["f1"], evidence_ids: [] }];
    const calculationValue = { limited_slot_status: status };
    const { composed, validation } = pipeline({ question: "확인해줘", facts, calculationValue, slots });
    assert.ok(composed.applied_capabilities.includes("INFORMATION_LIMIT_DISCLOSURE"));
    assert.equal(validation.reasons.some((r) => r.code === "INFORMATION_LIMIT_DISAPPEARED"), false);
  });
}

test("issuer-stated forecasts/judgments are wrapped in attribution, never presented as objective fact", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "당사는 향후 실적을 판단하여 개선될 것으로 전망합니다." })];
  const { composed, validation } = pipeline({ question: "회사의 전망을 알려줘", facts });
  assert.ok(composed.applied_capabilities.includes("ATTRIBUTION_PRESERVATION"));
  assert.match(composed.answer, /회사는 ".*"라고 (밝혔습니다|판단했습니다)/);
  assert.equal(validation.reasons.some((r) => r.code === "ATTRIBUTION_FLATTENED"), false);
});

test("hedge qualifiers (약/예정/유보) are preserved verbatim, not sharpened into a precise value", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "계약금액은 약 100억원이며 정정 예정입니다." })];
  const { composed, validation } = pipeline({ question: "계약금액을 알려줘", facts });
  assert.ok(composed.applied_capabilities.includes("QUALIFIER_PRESERVATION"));
  assert.ok(composed.answer.includes("계약금액은 약 100억원이며 정정 예정입니다"));
  assert.equal(validation.reasons.some((r) => r.code === "QUALIFIER_DISAPPEARED"), false);
});

test("validator fails closed when a required NEUTRAL_COMPARABILITY_CAVEAT is missing on mismatched comparison bases", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "A0001", metric_code: "revenue", as_of_date: "2023-01-01" }),
    fact({ fact_id: "f2", corp_code: "A0002", metric_code: "revenue", as_of_date: "2024-01-01" }),
  ];
  const calculationValue = { revenue_diff_krw: 100, revenue_winner_corp_code: "A0002" };
  const signals = planSynthesisSignals({ question: "비교해줘", facts, events: [], evidence: [], calculationValue });
  assert.equal(signals.comparison_basis_mismatch, true);
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields });
  const tampered = { ...composed, applied_capabilities: composed.applied_capabilities.filter((c) => c !== "NEUTRAL_COMPARABILITY_CAVEAT") };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "MISSING_COMPARABILITY_CAVEAT"));
});

test("validator fails closed if narrative text contains a prohibited economic-superiority phrase", () => {
  const facts = [fact({ fact_id: "f1" })];
  const signals = planSynthesisSignals({ question: "비교해줘", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  const tampered = { ...composed, narrative_text: `${composed.narrative_text} 가상기업A가 더 우수합니다.` };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "PROHIBITED_SUPERIORITY_CLAIM"));
});

test("validator reports PARTIAL (not silent success) when one of several required capabilities is missing", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "limited_metric" })];
  const slots = [{ slot_name: "limited_slot", fact_ids: ["f1"], evidence_ids: [] }];
  const calculationValue = { limited_slot_status: "WITHHELD" };
  const signals = planSynthesisSignals({ question: "확인해줘", facts, events: [], evidence: [], calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots, signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue, signals, narrativeFields });
  const tampered = { ...composed, applied_capabilities: composed.applied_capabilities.filter((c) => c !== "INFORMATION_LIMIT_DISCLOSURE") };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "PARTIAL");
  assert.ok(validation.missing_capabilities.includes("INFORMATION_LIMIT_DISCLOSURE"));
});

test("validator fails closed if an unauthorized fact ID is used", () => {
  const facts = [fact({ fact_id: "f1" })];
  const signals = planSynthesisSignals({ question: "확인해줘", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  const tampered = { ...composed, used_fact_ids: [...composed.used_fact_ids, "fact_not_authorized"] };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "UNAUTHORIZED_FACT_ID"));
});

test("the synthesis pipeline is fully synchronous -- no new async/Abort surface is introduced", () => {
  const facts = [fact({ fact_id: "f1" })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.equal(signals instanceof Promise, false);
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  assert.equal(narrativeFields instanceof Promise, false);
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  assert.equal(composed instanceof Promise, false);
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue: {}, facts,
    authorizedFactIds: ["f1"], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation instanceof Promise, false);
});

test("a legitimately-grounded NEGATIVE value (e.g. a decrease of -38,791) is not falsely flagged as ungrounded (found in v07 real-data run); Turn M2 item 4: this real change-vs-previous shape now renders as a direction sentence, not a bare signed number", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "change_vs_previous_shares", normalized_value: -38791, unit: "SHARES", raw_label: "증감" })];
  const { validation, composed } = pipeline({ question: "q", facts });
  assert.match(composed.answer, /직전보다 38,791주 감소했습니다/);
  assert.equal(composed.answer.includes("-38,791"), false);
  assert.ok(composed.scan_text.includes("38,791"));
  assert.equal(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"), false);
  assert.equal(validation.reasons.some((r) => r.code === "DIRECTION_NARRATIVE_MISMATCH"), false);
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

test("planner output is deep-frozen with no shared mutable state across calls", () => {
  const facts = [fact({ fact_id: "f1" })];
  const s1 = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.ok(Object.isFrozen(s1));
  assert.throws(() => { s1.entity_count = 999; });
  const s2 = planSynthesisSignals({ question: "q2", facts, events: [], evidence: [], calculationValue: {} });
  assert.deepEqual(s1.entities, s2.entities);
  assert.notEqual(s1, s2);
});

test("the same generic pipeline produces a valid comparative narrative for entirely synthetic company names; winner label resolves via companyLabels/corp_code (§5-A), never a literal in calculationValue", () => {
  const facts = [
    fact({ fact_id: "syn1", corp_code: "SYN0001", company_name: "가상전자", metric_code: "revenue_syn", normalized_value: 5000, period_start: "2024-01-01", period_end: "2024-12-31" }),
    fact({ fact_id: "syn2", corp_code: "SYN0002", company_name: "가상중공업", metric_code: "revenue_syn", normalized_value: 7000, period_start: "2024-01-01", period_end: "2024-12-31" }),
  ];
  const calculationValue = { revenue_syn_diff_krw: 2000, revenue_syn_winner_corp_code: "SYN0002" };
  const calculationRegistry = [{
    key: "revenue_syn_diff_krw", formula: "DIFF", output_kind: "VALUE", result: 2000,
    input_fact_ids: ["syn1", "syn2"], input_labels: ["가상전자 매출", "가상중공업 매출"], input_units: ["KRW", "KRW"],
  }];
  const companyLabels = { SYN0002: { corp_name: "가상중공업" } };
  const evidence = [evidenceItem({ evidence_id: "ev_syn1", document_id: "doc_syn1", quoted_text: "가상전자 매출 5,000원" })];
  const { composed, validation } = pipeline({ question: "가상전자와 가상중공업의 매출을 비교해줘", facts, calculationValue, calculationRegistry, companyLabels, evidence });
  assert.equal(validation.status, "PASS");
  assert.ok(composed.answer.includes("가상중공업"));
  assert.ok(composed.applied_capabilities.includes("COMPARATIVE_CONCLUSION"));
});

// -- P0: typed numeric/date claim grounding (Codex-reproduced defects) --

test("P0: comma-grouped display (1,000) and its canonical value (1000) are treated as identical -- no false grounding failure", () => {
  const facts = [fact({ fact_id: "f1", normalized_value: 1000 })];
  const { validation, composed } = pipeline({ question: "q", facts });
  assert.ok(composed.scan_text.includes("1,000"));
  assert.equal(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"), false);
});

test("P0: exact decimal grounding has no rounding tolerance -- a nearby rounded value is rejected, not accepted", () => {
  const facts = [fact({ fact_id: "f1", normalized_value: 100.49 })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  for (const fabricated of ["100원", "100.4원"]) {
    const tampered = { ...composed, scan_text: `${composed.scan_text}\n실제로는 ${fabricated}입니다.` };
    const validation = validateSynthesis({
      composerOutput: tampered, signals, calculationValue: {}, facts,
      authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
    });
    assert.equal(validation.status, "FAIL_CLOSED", `expected FAIL_CLOSED for fabricated "${fabricated}"`);
    assert.ok(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"));
  }
});

test("P0: a fabricated date with no basis in any Fact/Event/quote fails closed (dates are not merely stripped and ignored)", () => {
  const facts = [fact({ fact_id: "f1" })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  const tampered = { ...composed, scan_text: `${composed.scan_text}\n계약 종료일은 2099-12-31입니다.` };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "UNGROUNDED_DATE"));
});

test("P0: corp_code digits are masked as an identifier and can never ground a fabricated VALUE claim", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "00123456", metric_code: "m", normalized_value: 42 }),
    fact({ fact_id: "f2", corp_code: "00999999", metric_code: "m", normalized_value: 43 }),
  ];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  assert.ok(composed.scan_text.includes("[ID]"));
  assert.equal(composed.scan_text.includes("00123456"), false);
  const tampered = { ...composed, scan_text: `${composed.scan_text}\n실제로는 123456원입니다.` };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"));
});

test("P0: a claim explicitly sourced from an identifier field (corp_code) is rejected outright by the typed guard", () => {
  const facts = [fact({ fact_id: "f1", corp_code: "00123456" })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields });
  const forgedClaim = { type: "VALUE", value: 123456, source: { kind: "fact", id: "f1", field: "corp_code" } };
  const tampered = { ...composed, numeric_claims: [...composed.numeric_claims, forgedClaim] };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts,
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "IDENTIFIER_USED_AS_VALUE"));
});

test("P0: anchor_document_id digits are masked and can never ground a fabricated amount even when the exact digits are reused verbatim", () => {
  const events = [
    event({ event_id: "e1", event_date: "2026-01-20", anchor_document_id: "exchange_20260120800597" }),
    event({ event_id: "e2", event_date: "2026-02-20", anchor_document_id: "exchange_20260220800001" }),
  ];
  const signals = planSynthesisSignals({ question: "q", facts: [], events, evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts: [], evidence: [], slots: [], signals });
  const composed = composeResponse({ facts: [], events, evidence: [], calculationValue: {}, signals, narrativeFields });
  assert.ok(composed.scan_text.includes("[ID]"));
  assert.equal(composed.scan_text.includes("20260120800597"), false);
  const tampered = { ...composed, scan_text: `${composed.scan_text}\n계약금액은 20260120800597원 입니다.` };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts: [], events,
    authorizedFactIds: [], authorizedEventIds: events.map((e) => e.event_id), authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"));
});

// -- P1: qualifier span detection (no "계약"/"해약" substring collision) -

test('qualifier detection: "계약금액은 100원이다" has no qualifier (no false positive from 계약)', () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "계약금액은 100원이다." })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.equal(signals.qualifier_candidates.length, 0);
});

test('qualifier detection: standalone "약 100억원" is a qualifier', () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "약 100억원 규모입니다." })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.ok(signals.qualifier_candidates.some((c) => c.markers.includes("약")));
});

test('qualifier detection: "계약 해약 조건" never trips the 약 heuristic', () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "계약 해약 조건에 대한 안내입니다." })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.equal(signals.qualifier_candidates.some((c) => c.markers.includes("약")), false);
});

test('qualifier detection: "내외"/"예정"/"유보" are each detected as standalone markers', () => {
  const cases = [["회사는 100억원 내외로 예상합니다.", "내외"], ["본 건은 정정 예정입니다.", "예정"], ["상대방 유보 조건이 있습니다.", "유보"]];
  for (const [text, marker] of cases) {
    const facts = [fact({ fact_id: "f1", raw_value_text: text })];
    const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
    assert.ok(signals.qualifier_candidates.some((c) => c.markers.includes(marker)), `expected marker "${marker}" for text: ${text}`);
  }
});

test("attribution/qualifier extraction narrows to the matching SENTENCE, not the whole multi-sentence quote", () => {
  const longText = "1. 이것은 사실 문장입니다.2. 당사는 향후 실적이 개선될 것으로 판단합니다.3. 이것도 무관한 사실 문장입니다.";
  const facts = [fact({ fact_id: "f1", raw_value_text: longText })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.equal(signals.attribution_candidates.length, 1);
  assert.match(signals.attribution_candidates[0].text, /당사는 향후 실적이 개선될 것으로 판단합니다/);
  assert.equal(signals.attribution_candidates[0].text.includes("무관한 사실 문장"), false);
  assert.equal(signals.attribution_candidates[0].text.includes("이것은 사실 문장"), false);
});

// -- P1: latest-state rendering ------------------------------------------

test("latest-state renders every leaf of an object value (never [object Object]), using ordinal labels rather than the leaf's own internal key (Turn I)", () => {
  const calculationValue = { latest_effective_synthetic_multi_leaf: { arbitrary_leaf_a_percent: 13.7, arbitrary_leaf_b_percent: 100 } };
  const { composed } = pipeline({ question: "q", calculationValue });
  assert.ok(composed.answer.includes("항목 1 13.7%"));
  assert.ok(composed.answer.includes("항목 2 100%"));
  assert.equal(composed.answer.includes("[object Object]"), false);
  assert.equal(composed.answer.includes("arbitrary_leaf_a_percent"), false);
  assert.equal(composed.answer.includes("synthetic_multi_leaf"), false);
  assert.ok(composed.applied_capabilities.includes("LATEST_EFFECTIVE_STATE"));
});

test("latest-state keeps contract period_start/period_end as their own distinct lines, never reused as a generic as-of date for other fields; scalar values use a conservative generic label, never the internal key (Turn I)", () => {
  const calculationValue = { latest_effective_synthetic_amount: 999, latest_effective_period_start: "2025-06-01", latest_effective_period_end: "2026-06-01" };
  const { composed } = pipeline({ question: "q", calculationValue });
  assert.match(composed.answer, /최신 유효 값: 999\./);
  assert.equal(composed.answer.includes("synthetic_amount"), false);
  assert.match(composed.answer, /계약\(기간\) 시작일: 2025-06-01\./);
  assert.match(composed.answer, /계약\(기간\) 종료일: 2026-06-01\./);
});

test("qualifiers embedded in an opaque calculation-produced string (e.g. package terms) are preserved and remain grounded", () => {
  const calculationValue = { latest_effective_pkg1: "약 USD 167백만 + SAR 863백만" };
  const { composed, validation } = pipeline({ question: "q", calculationValue });
  assert.ok(composed.answer.includes("약 USD 167백만 + SAR 863백만"));
  assert.equal(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"), false);
});

// -- Turn H2 §4: qualifier provenance (currency-code-prefixed "약", and
// fail-closed rejection of an unbacked/fabricated qualifier) -------------

test('qualifier detection: "약 USD 167백만" (a currency code between 약 and the digit, as real Q22 Evidence quotes it) is detected as a qualifier', () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "PKG#1 : 약 USD 167백만 + 약 SAR 863백만 규모로 알려져 있습니다." })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.ok(signals.qualifier_candidates.some((c) => c.markers.includes("약")));
});

test('qualifier detection: "계약금액은 100원이다" still has no qualifier after the currency-code widening (계약 boundary still rejected)', () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "계약금액은 USD 100원이다." })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.equal(signals.qualifier_candidates.length, 0);
});

test("a genuine 약-qualified source (real Fact raw_value_text) renders and QUALIFIER_PRESERVATION applies with no validator complaint", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "PKG#1 : 약 USD 167백만 규모입니다.", normalized_value: null })];
  const { composed, validation } = pipeline({ question: "q", facts });
  assert.ok(composed.applied_capabilities.includes("QUALIFIER_PRESERVATION"));
  assert.ok(composed.answer.includes("약 USD 167백만"));
  assert.equal(validation.reasons.some((r) => r.code === "QUALIFIER_NOT_VERBATIM"), false);
});

test("a Composer-reported qualifier with no matching source substring is FAIL_CLOSED by the validator (QUALIFIER_NOT_VERBATIM), never trusted at face value", () => {
  const facts = [fact({ fact_id: "f1", raw_value_text: "정확히 100원입니다.", normalized_value: 100 })];
  const { composed } = pipeline({ question: "q", facts });
  // Simulate a fabricated qualifier the composer did NOT actually derive
  // from any real source -- the validator must independently catch this,
  // not merely trust composerOutput.preserved_qualifiers.
  const fabricated = {
    ...composed,
    preserved_qualifiers: [{ text: "약 100원", fact_id: "f1", source: "fact" }],
    narrative_text: `${composed.narrative_text} 약 100원`,
    answer: `${composed.answer} 약 100원`,
  };
  const validation = validateSynthesis({
    composerOutput: fabricated, signals: planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} }),
    calculationValue: {}, facts, evidence: [], events: [],
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "QUALIFIER_NOT_VERBATIM"));
});

// -- P1: capability honesty + accurate used-ID tracking ------------------

test("all-empty input never yields PASS: EVIDENCE_REFERENCED_NARRATIVE cannot apply with zero evidence", () => {
  const { validation, composed } = pipeline({ question: "q" });
  assert.equal(composed.applied_capabilities.includes("EVIDENCE_REFERENCED_NARRATIVE"), false);
  assert.notEqual(validation.status, "PASS");
});

test("an unused (non-numeric, unreferenced) Fact is never included in used_fact_ids", () => {
  const facts = [
    fact({ fact_id: "used", normalized_value: 10 }),
    fact({ fact_id: "unused", normalized_value: null }),
  ];
  const { composed } = pipeline({ question: "q", facts });
  assert.ok(composed.used_fact_ids.includes("used"));
  assert.equal(composed.used_fact_ids.includes("unused"), false);
});

test("covered_sub_requests never contains a capability ID -- no fabricated sub-request structure", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "A0001", metric_code: "revenue" }),
    fact({ fact_id: "f2", corp_code: "A0002", metric_code: "revenue" }),
  ];
  const calculationValue = { revenue_diff_krw: 10 };
  const { composed } = pipeline({ question: "q", facts, calculationValue });
  assert.deepEqual(composed.covered_sub_requests, []);
});

test("REQUEST_COMPLETENESS is reported as a permanent NOT_IMPLEMENTED gap, never silently marked applied", () => {
  const { composed, validation } = pipeline({ question: "A와 B를 비교해줘 그리고 정리해줘" });
  assert.ok(composed.not_implemented_capabilities.includes("REQUEST_COMPLETENESS"));
  assert.equal(composed.applied_capabilities.includes("REQUEST_COMPLETENESS"), false);
  assert.notEqual(validation.status, "PASS");
  if (validation.status === "PARTIAL") assert.ok(validation.not_implemented_capabilities.includes("REQUEST_COMPLETENESS"));
});

// -- P2: comparison-basis-mismatch scoping --------------------------------

test("an unrelated Fact of a different metric/period never flips the comparison_basis_mismatch signal for an unrelated comparison", () => {
  const relevantFacts = [
    fact({ fact_id: "f1", corp_code: "A0001", metric_code: "revenue", as_of_date: "2025-01-01" }),
    fact({ fact_id: "f2", corp_code: "A0002", metric_code: "revenue", as_of_date: "2025-01-01" }),
  ];
  const calculationValue = { revenue_diff_krw: 10 };
  const withoutExtra = planSynthesisSignals({ question: "q", facts: relevantFacts, events: [], evidence: [], calculationValue });
  const unrelatedFact = fact({ fact_id: "f3", corp_code: "B0001", metric_code: "unrelated_metric", as_of_date: "1999-01-01" });
  const withExtra = planSynthesisSignals({ question: "q", facts: [...relevantFacts, unrelatedFact], events: [], evidence: [], calculationValue });
  assert.equal(withoutExtra.comparison_basis_mismatch, withExtra.comparison_basis_mismatch);
});

// -- P0/P1: no internal-error or capability-ID leakage into the Wire -----

test("capability limitation labels are natural language, never the raw capability ID", async () => {
  const requirements = JSON.parse(await readFile(path.join(ROOT, "work/domain-seed/seed-response-synthesis-requirements.v0.1.json"), "utf8"));
  for (const cap of requirements.capabilities) {
    const label = limitationLabelKo(cap.capability_id);
    assert.notEqual(label, cap.capability_id);
    assert.equal(/^[A-Z_]+$/.test(label), false);
  }
});

test("the synthesis catch block elides the error binding entirely, so no exception message/stack/path can leak into the Wire", async () => {
  const code = await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8");
  assert.match(code, /catch\s*\{\s*\n[\s\S]*?SYNTHESIS_EXCEPTION/);
  assert.equal(code.includes("error.message"), false);
  assert.equal(code.includes("error.stack"), false);
});

test("thin-structured-flow's PARTIAL gap text is built from limitationLabelKo, never a raw capability ID interpolation", async () => {
  const code = await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8");
  assert.match(code, /limitationLabelKo\(capabilityId\)/);
  assert.equal(/미충족 항목: \$\{capabilityId\}/.test(code), false);
});

// -- Overfitting regression -----------------------------------------------

test("synthesis module source contains no Seed question_id / real-company-name dispatch branching", async () => {
  const files = (await readdir(SYNTHESIS_DIR)).filter((f) => f.endsWith(".mjs"));
  const forbidden = [
    "question_seed_v07", "Q07", "Q17", "Q22",
    "삼성중공업", "효성중공업", "현대건설", "SATORP", "한화오션", "셀트리온",
    "삼성전자", "신한지주", "HD현대중공업", "HMM", "현대모비스", "삼성E&A", "삼성바이오로직스", "에스엠",
  ];
  for (const file of files) {
    const text = await readFile(path.join(SYNTHESIS_DIR, file), "utf8");
    for (const token of forbidden) assert.equal(text.includes(token), false, `${file} contains overfit token "${token}"`);
  }
});

// Strips full-line `//` comments before scanning so the invariant's own
// documentation ("this module never reads Gold") doesn't trip the check
// against the invariant it's declaring.
function stripLineComments(text) {
  return text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

test("synthesis module source never stores a complete finished answer string or reads Gold/expected_answer", async () => {
  const files = (await readdir(SYNTHESIS_DIR)).filter((f) => f.endsWith(".mjs"));
  for (const file of files) {
    const code = stripLineComments(await readFile(path.join(SYNTHESIS_DIR, file), "utf8"));
    assert.equal(/gold/i.test(code), false, `${file} references Gold outside comments`);
    assert.equal(code.includes("expected_answer"), false, `${file} references expected_answer`);
    assert.equal(code.includes("scoring_spec"), false, `${file} references scoring_spec`);
    assert.equal(code.includes("question.includes("), false, `${file} uses Seed-phrase substring dispatch`);
    // Turn M2 item 10: never a specific-slot-name-prefix branch (e.g.
    // `slot_name === "hyosung_..."` or `.startsWith("latest_")` gated on a
    // literal Seed slot family) -- the generic `startsWith("latest_")`/
    // `_status`/`_value_status` SUFFIX conventions already used project-
    // wide are shape-based, not per-question, so only a literal quoted
    // Seed slot-name STRING is checked here, never the suffix convention
    // itself.
    for (const literalSlotName of ["hyosung_", "samsung_heavy_", "hmm_revenue", "mobis_revenue", "crane_investment", "dock_investment"]) {
      assert.equal(code.includes(`"${literalSlotName}`), false, `${file} contains a literal Seed slot-name-prefix branch "${literalSlotName}"`);
    }
  }
});

test("thin-structured-flow's synthesis integration still never reads Gold/expected_answer", async () => {
  const code = stripLineComments(await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8"));
  assert.equal(/\bgold\b/i.test(code), false, "thin-structured-flow.mjs references Gold outside comments");
  assert.equal(code.includes("expected_answer"), false, "thin-structured-flow.mjs references expected_answer");
});

// -- Turn M item 4: extended overfitting static checks ---------------------

test("Turn M: thin-structured-flow.mjs's EXECUTABLE code (comments stripped) contains no real Seed company-name literal either", async () => {
  const code = stripLineComments(await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8"));
  const forbidden = ["삼성중공업", "효성중공업", "현대건설", "SATORP", "한화오션", "셀트리온", "삼성전자", "신한지주", "HD현대중공업", "HMM", "현대모비스", "삼성E&A", "삼성바이오로직스", "에스엠"];
  for (const token of forbidden) assert.equal(code.includes(token), false, `thin-structured-flow.mjs contains overfit token "${token}" in executable code`);
});

test("Turn M: synthesis module source never matches the question_seed_v07_NN question_id pattern anywhere (not just the bare prefix substring)", async () => {
  const files = (await readdir(SYNTHESIS_DIR)).filter((f) => f.endsWith(".mjs"));
  for (const file of files) {
    const text = await readFile(path.join(SYNTHESIS_DIR, file), "utf8");
    assert.equal(/question_seed_v07_\d+/.test(text), false, `${file} matches a full question_seed_v07_NN pattern`);
  }
});

test("Turn M: synthesis module source contains no real Seed document_id literal (doc-type-prefixed 8-digit-date-shaped id)", async () => {
  const files = (await readdir(SYNTHESIS_DIR)).filter((f) => f.endsWith(".mjs"));
  // Real Seed document_id shape: {doc_type}_{14-digit receipt number}, e.g.
  // "exchange_20230428800439" / "periodic_20260320000859" -- doc_type is
  // one of the four corpus categories this project's universe manifest
  // declares (periodic/major/exchange/holding).
  const DOCUMENT_ID_SHAPE = /\b(?:periodic|major|exchange|holding)_\d{14}\b/;
  for (const file of files) {
    const text = await readFile(path.join(SYNTHESIS_DIR, file), "utf8");
    assert.equal(DOCUMENT_ID_SHAPE.test(text), false, `${file} contains a real-shaped Seed document_id literal`);
  }
  const flowCode = await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8");
  assert.equal(DOCUMENT_ID_SHAPE.test(flowCode), false, "thin-structured-flow.mjs contains a real-shaped Seed document_id literal");
});

test("Turn M: synthesis module source contains no hardcoded finished-answer-shaped multi-sentence Korean string literal", async () => {
  // A crude but effective proxy for "a complete finished answer string":
  // a single string literal containing 2+ Korean sentence-final periods
  // ("...다." occurring twice) would mean a multi-sentence Korean prose
  // block is embedded as data, not assembled from template fragments.
  // Every legitimate multi-sentence string in this codebase lives in a
  // `//` comment (already excluded) or a test fixture (outside
  // SYNTHESIS_DIR), never inside a source string literal here.
  const files = (await readdir(SYNTHESIS_DIR)).filter((f) => f.endsWith(".mjs"));
  const MULTI_SENTENCE_STRING_LITERAL = /["'`][^"'`\n]*다\.[^"'`\n]*다\.[^"'`\n]*["'`]/;
  for (const file of files) {
    const code = stripLineComments(await readFile(path.join(SYNTHESIS_DIR, file), "utf8"));
    assert.equal(MULTI_SENTENCE_STRING_LITERAL.test(code), false, `${file} contains a multi-sentence Korean string literal (possible hardcoded finished answer)`);
  }
});
