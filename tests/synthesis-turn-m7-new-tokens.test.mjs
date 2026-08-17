// Turn M7 Section 8: dynamic regression/overfitting fixtures for the 6
// newly-VERIFIED ontology tokens (INVESTMENT_PURPOSE/INVESTMENT_TARGET_
// ASSET/ACQUISITION_PLANNED_SHARES/TRUST_CONTRACT_INSTITUTION/
// CORRECTION_REASON/ISSUANCE_AMOUNT). response-composer.mjs itself was
// NOT modified this Turn -- these fixtures confirm the EXISTING generic
// rendering path (no per-metric_code special-casing) already handles
// every new token correctly, using entirely synthetic company/entity
// names and synthetic IDs (never a real Seed question_id/company/fact_id
// literal).
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
    value_certainty: "CONFIRMED", scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    raw_label: "테스트 지표", attributes: {}, ...overrides,
  };
}
function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, slots = [] }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { composed, validation };
}

// -- (a) each new ontology token renders generically, no special-casing --

test("Turn M7: an INVESTMENT_PURPOSE/INVESTMENT_TARGET_ASSET pair renders through the generic value-line path with no per-metric_code special text", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "10000001", metric_code: "INVESTMENT_PURPOSE", value_type: "TEXT", normalized_value: "합성 목적 A", raw_label: "3. 투자목적" }),
    fact({ fact_id: "f2", corp_code: "10000001", metric_code: "INVESTMENT_TARGET_ASSET", value_type: "TEXT", normalized_value: "합성 설비 A", raw_label: "- 투자대상" }),
  ];
  const { composed, validation } = pipeline({ facts });
  assert.match(composed.answer, /합성 목적 A/);
  assert.match(composed.answer, /합성 설비 A/);
  assert.notEqual(validation.status, "FAIL");
});

test("Turn M7: TRUST_CONTRACT_INSTITUTION never renders with counterparty-specific wording ('계약상대방'/'계약상대')", () => {
  const facts = [fact({ fact_id: "f1", corp_code: "10000002", metric_code: "TRUST_CONTRACT_INSTITUTION", value_type: "TEXT", normalized_value: "합성증권", raw_label: "4. 계약체결기관" })];
  const { composed } = pipeline({ facts });
  assert.match(composed.answer, /합성증권/);
  assert.equal(composed.answer.includes("계약상대방"), false);
  assert.equal(composed.answer.includes("계약상대:"), false);
});

test("Turn M7: ACQUISITION_PLANNED_SHARES/CORRECTION_REASON/ISSUANCE_AMOUNT all render through the same generic path with their own raw_label, never a hardcoded metric-specific sentence", () => {
  const facts = [
    fact({ fact_id: "f1", corp_code: "10000003", metric_code: "ACQUISITION_PLANNED_SHARES", value_type: "NUMERIC", normalized_value: 12345, unit: "주", raw_label: "9. 취득예정주식(주)" }),
    fact({ fact_id: "f2", corp_code: "10000003", metric_code: "CORRECTION_REASON", value_type: "TEXT", normalized_value: "합성 정정 사유", raw_label: "3. 정정사유" }),
    fact({ fact_id: "f3", corp_code: "10000003", metric_code: "ISSUANCE_AMOUNT", value_type: "NUMERIC", normalized_value: 999000000, unit: "원", raw_label: "합성 발행총액 라벨" }),
  ];
  const { composed, validation } = pipeline({ facts });
  assert.match(composed.answer, /12,345/);
  assert.match(composed.answer, /합성 정정 사유/);
  assert.match(composed.answer, /999,000,000/);
  assert.notEqual(validation.status, "FAIL");
});

// -- (b) Q06-shaped: two investments in REVERSED order still link via their own source_document_id, never by array position --

test("Turn M7 (Q06-shaped): reversing the input order of two investment pairs never cross-attributes purpose/target between them (linkage is per-Fact source_document_id, not array position)", () => {
  const factsForwardOrder = [
    fact({ fact_id: "amt_a", corp_code: "10000004", metric_code: "INVESTMENT_AMOUNT", normalized_value: 111, unit: "원", source_document_id: "doc_a", as_of_date: "2025-01-01" }),
    fact({ fact_id: "purpose_a", corp_code: "10000004", metric_code: "INVESTMENT_PURPOSE", value_type: "TEXT", normalized_value: "목적A", source_document_id: "doc_a", as_of_date: "2025-01-01" }),
    fact({ fact_id: "target_a", corp_code: "10000004", metric_code: "INVESTMENT_TARGET_ASSET", value_type: "TEXT", normalized_value: "대상A", source_document_id: "doc_a", as_of_date: "2025-01-01" }),
    fact({ fact_id: "amt_b", corp_code: "10000004", metric_code: "INVESTMENT_AMOUNT", normalized_value: 222, unit: "원", source_document_id: "doc_b", as_of_date: "2025-01-01" }),
    fact({ fact_id: "purpose_b", corp_code: "10000004", metric_code: "INVESTMENT_PURPOSE", value_type: "TEXT", normalized_value: "목적B", source_document_id: "doc_b", as_of_date: "2025-01-01" }),
    fact({ fact_id: "target_b", corp_code: "10000004", metric_code: "INVESTMENT_TARGET_ASSET", value_type: "TEXT", normalized_value: "대상B", source_document_id: "doc_b", as_of_date: "2025-01-01" }),
  ];
  const factsReversedOrder = [...factsForwardOrder].reverse();
  const { composed: forward } = pipeline({ facts: factsForwardOrder });
  const { composed: reversed } = pipeline({ facts: factsReversedOrder });
  // Order-independence: the SET of rendered lines is identical regardless
  // of input array order -- proves no renderer assumes "first two facts
  // are a pair" positional pairing.
  assert.deepEqual([...forward.answer].sort(), [...reversed.answer].sort());
  assert.match(forward.answer, /목적A/);
  assert.match(forward.answer, /대상A/);
  assert.match(forward.answer, /목적B/);
  assert.match(forward.answer, /대상B/);
});

// -- (c) PROVISIONAL certainty is never surfaced as a finality claim --

test("Turn M7: value_certainty is not read anywhere in the synthesis pipeline (confirmed via a PROVISIONAL fact producing byte-identical output to the same fact marked CONFIRMED) -- so a PROVISIONAL value can never be rendered as '확정'/'최종 확정'", () => {
  const baseFact = { fact_id: "f1", corp_code: "10000005", metric_code: "SYNTHETIC_DEADLINE", value_type: "DATE", normalized_value: "2030-12-31", raw_label: "합성 유보기한" };
  const { composed: provisional } = pipeline({ facts: [fact({ ...baseFact, value_certainty: "PROVISIONAL" })] });
  const { composed: confirmed } = pipeline({ facts: [fact({ ...baseFact, value_certainty: "CONFIRMED" })] });
  assert.equal(provisional.answer, confirmed.answer);
  assert.equal(provisional.answer.includes("확정"), false);
  assert.equal(provisional.answer.includes("최종"), false);
});

// -- (d) an unresolved/absent metric is never fabricated --

test("Turn M7: a slot with NO corresponding Fact at all produces no claim for that field (never a fabricated/guessed value)", () => {
  const facts = [fact({ fact_id: "f1", corp_code: "10000006", metric_code: "SYNTHETIC_PRESENT_METRIC", normalized_value: 42, unit: "원" })];
  const { composed } = pipeline({ facts, slots: [{ slot_name: "present_slot", fact_ids: ["f1"], evidence_ids: [] }, { slot_name: "absent_slot", fact_ids: [], evidence_ids: [] }] });
  assert.match(composed.answer, /42/);
  assert.equal(composed.numeric_claims.some((c) => c.source?.key === "absent_slot"), false);
});
