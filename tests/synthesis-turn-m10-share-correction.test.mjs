// Turn M10: renders a "N -> M 정정되었습니다" conclusion using ONLY
// explicit, closed structured attribute keys (attributes.
// initial_planned_shares / attributes.corrected_actual_shares -- both
// real VERIFIED Fact attribute conventions) and a real, already-loaded
// VERIFIED Event's own event_date -- never a regex-extraction from
// raw_value_text, never a question_id/fact_id literal branch. Fires only
// when BOTH attribute keys are present on same-corp_code Facts AND a
// correction-shaped Event (event_type ending in the real, closed
// "_CORRECTION" suffix convention already used across the Event
// ontology -- see natural-label.mjs's EVENT_TYPE_LABELS) for that same
// corp_code is already loaded; otherwise this renders nothing (never a
// guess).
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
function event(overrides) {
  return {
    event_id: "event_default", event_type: "SUPPLY_CONTRACT_DECISION", event_date: "2025-01-01",
    event_status: "DECIDED", anchor_document_id: "doc_default", attributes: {}, ...overrides,
  };
}
function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, slots = [], companyLabels = null }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, companyLabels, slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { composed, validation };
}

test("Turn M10: a same-corp_code initial/corrected share-count attribute pair, with a loaded correction Event, renders a dated N->M correction sentence", () => {
  const facts = [
    fact({ fact_id: "fact_initial", corp_code: "00000007", metric_code: "SYNTHETIC_DECISION_CONTENT", attributes: { initial_planned_shares: 1000 } }),
    fact({ fact_id: "fact_corrected", corp_code: "00000007", metric_code: "SYNTHETIC_COMPLETION_STATUS", normalized_value: "ISSUED", attributes: { corrected_actual_shares: 700 } }),
  ];
  const events = [event({ event_id: "event_correction", corp_code: "00000007", event_type: "SYNTHETIC_ISSUE_DECISION_CORRECTION", event_date: "2030-07-10" })];
  const { composed, validation } = pipeline({ facts, events });
  assert.match(composed.answer, /2030-07-10/);
  assert.match(composed.answer, /1,000주에서 700주로 정정/);
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

test("Turn M10 counterexample: no correction Event loaded -> no correction sentence rendered (never guessed without a real Event date)", () => {
  const facts = [
    fact({ fact_id: "fact_initial", corp_code: "00000007", metric_code: "SYNTHETIC_DECISION_CONTENT", attributes: { initial_planned_shares: 1000 } }),
    fact({ fact_id: "fact_corrected", corp_code: "00000007", metric_code: "SYNTHETIC_COMPLETION_STATUS", normalized_value: "ISSUED", attributes: { corrected_actual_shares: 700 } }),
  ];
  const { composed } = pipeline({ facts, events: [] });
  assert.equal(/정정되었습니다/.test(composed.answer), false);
});

test("Turn M10 counterexample: only ONE of the two attribute keys present -> no correction sentence (never a half-guessed pairing)", () => {
  const facts = [fact({ fact_id: "fact_initial_only", corp_code: "00000007", metric_code: "SYNTHETIC_DECISION_CONTENT", attributes: { initial_planned_shares: 1000 } })];
  const events = [event({ event_id: "event_correction", corp_code: "00000007", event_type: "SYNTHETIC_ISSUE_DECISION_CORRECTION", event_date: "2030-07-10" })];
  const { composed } = pipeline({ facts, events });
  assert.equal(/정정되었습니다/.test(composed.answer), false);
});

test("Turn M10 counterexample: initial/corrected Facts belong to DIFFERENT corp_code -> never paired across companies", () => {
  const facts = [
    fact({ fact_id: "fact_initial", corp_code: "00000007", metric_code: "SYNTHETIC_DECISION_CONTENT", attributes: { initial_planned_shares: 1000 } }),
    fact({ fact_id: "fact_corrected", corp_code: "00000008", metric_code: "SYNTHETIC_COMPLETION_STATUS", normalized_value: "ISSUED", attributes: { corrected_actual_shares: 700 } }),
  ];
  const events = [event({ event_id: "event_correction", corp_code: "00000007", event_type: "SYNTHETIC_ISSUE_DECISION_CORRECTION", event_date: "2030-07-10" })];
  const { composed } = pipeline({ facts, events });
  assert.equal(/정정되었습니다/.test(composed.answer), false);
});
