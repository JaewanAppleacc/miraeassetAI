// Turn M10: the pre-existing INDIRECT_CONFIRMATION_ATTRIBUTION relevance
// gate (referencesAlreadyKnownEvent) suppresses the sentence only when
// the referenced disclosure's own free-text label lexically OVERLAPS an
// already-loaded Event's translated type label. Real DART cross-reference
// phrasing frequently paraphrases the referenced filing's own title (word
// order/vocabulary differs from the Event ontology's own naturalized
// label), so this keyword check can miss a case where the referenced
// disclosure genuinely IS already directly available. Owner review named
// this exact failure mode: "필요한 원문 문서가 현재 authorized corpus/
// retrieved context에 없고, 후속 문서가 그 사실을 직접 설명할 때"만
// INDIRECT_CONFIRMATION_ATTRIBUTION이 적용되어야 한다 -- when the
// referenced document IS directly present, cite it directly instead.
// Turn M10 adds a STRONGER, precise signal alongside the existing one:
// the referenced date (already captured by the SAME regex) is parsed and
// compared against every already-loaded Fact's as_of_date / Event's
// event_date -- exact date equality, unlike keyword overlap, cannot
// misfire on paraphrased wording. Both checks are OR'd (either suffices
// to suppress); this widens suppression, it never narrows the existing
// keyword-based one.
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
    source_document_id: "doc_default", raw_label: "테스트 지표", attributes: {}, ...overrides,
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

test("Turn M10: an indirect-confirmation cross-reference is suppressed when the referenced date matches an already-loaded Fact's as_of_date, even if the referenced label text does NOT lexically overlap any loaded Event's own label", () => {
  const facts = [fact({ fact_id: "fact_referenced", as_of_date: "2030-06-05", metric_code: "SYNTHETIC_PLAN_DECISION", normalized_value: "합성 계획", raw_label: "합성 계획 라벨" })];
  const evidence = [evidenceItem({
    evidence_id: "evidence_citing", document_id: "doc_citing",
    quoted_text: "해당 계약은 2030년 6월 5일에 공시한 '전혀 다른 표현의 서로 다른 제목'에 대한 후속 계약체결건임",
  })];
  const { composed } = pipeline({ facts, evidence });
  assert.equal(composed.answer.includes("간접적으로 확인됩니다"), false);
  assert.equal(composed.applied_capabilities.includes("INDIRECT_CONFIRMATION_ATTRIBUTION"), false);
});

test("Turn M10: an indirect-confirmation cross-reference is ALSO suppressed when the referenced date matches an already-loaded Event's event_date", () => {
  const events = [event({ event_id: "event_referenced", event_date: "2030-06-05", event_type: "SUPPLY_CONTRACT_DECISION" })];
  const evidence = [evidenceItem({
    evidence_id: "evidence_citing", document_id: "doc_citing",
    quoted_text: "해당 계약은 2030년 6월 5일에 공시한 '전혀 다른 표현의 제목'에 대한 후속 계약체결건임",
  })];
  const { composed } = pipeline({ events, evidence });
  assert.equal(composed.answer.includes("간접적으로 확인됩니다"), false);
});

test("Turn M10 counterexample: a cross-reference whose date does NOT match any already-loaded Fact/Event, and whose label does not overlap either, still fires the indirect-confirmation sentence (genuinely not directly available)", () => {
  const facts = [fact({ fact_id: "fact_unrelated", as_of_date: "2030-01-01", metric_code: "SYNTHETIC_OTHER", normalized_value: "합성 무관" })];
  const evidence = [evidenceItem({
    evidence_id: "evidence_citing", document_id: "doc_citing",
    quoted_text: "해당 계약은 2030년 9월 9일에 공시한 '완전히 별개인 사전 공시'에 대한 후속 계약체결건임",
  })];
  const { composed } = pipeline({ facts, evidence });
  assert.match(composed.answer, /간접적으로 확인됩니다/);
  assert.ok(composed.applied_capabilities.includes("INDIRECT_CONFIRMATION_ATTRIBUTION"));
});

test("Turn M10: date-matching is exact -- a referenced date one day off from a loaded Fact's as_of_date is never treated as already-available", () => {
  const facts = [fact({ fact_id: "fact_close", as_of_date: "2030-06-06", metric_code: "SYNTHETIC_PLAN", normalized_value: "합성" })];
  const evidence = [evidenceItem({
    evidence_id: "evidence_citing", document_id: "doc_citing",
    quoted_text: "해당 계약은 2030년 6월 5일에 공시한 '별개 표현의 제목'에 대한 후속 계약체결건임",
  })];
  const { composed } = pipeline({ facts, evidence });
  assert.match(composed.answer, /간접적으로 확인됩니다/);
});
