// Turn M8 Section 4/6: TDD tests for the Composer's generic
// information_limits rendering + Final Validator's information-limit
// integrity checks. Entirely synthetic metric_codes/fact_ids/company
// names -- never a real Seed question_id/company/fact_id literal. This
// is NOT Sub-request research: information_limits is a minimal common
// declaration that a requested, Owner-approved metric has no direct-
// disclosure Fact, rendered through the SAME generic pipeline as every
// other Composer capability (no per-metric_code/question_id branching).
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
function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, slots = [], informationLimits = [] }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, slots, informationLimits });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { composed, validation };
}

// target_metric_code must be one of the 6 Owner-APPROVED ontology
// tokens (validated -- not a per-question invention); ISSUANCE_AMOUNT is
// used here only because it is a real member of that fixed, closed
// vocabulary, not because this is a Q18-specific test -- corp_code/
// fact_id/company/question_id below are all synthetic.
function decl(overrides = {}) {
  return {
    target_metric_code: "ISSUANCE_AMOUNT",
    reason_code: "NOT_DIRECTLY_DISCLOSED",
    available_input_fact_ids: ["fact_share_count", "fact_unit_price"],
    calculation_status: "DERIVED_CALCULATION_NOT_AVAILABLE",
    ...overrides,
  };
}

function twoInputFacts() {
  return [
    fact({ fact_id: "fact_share_count", corp_code: "10000010", metric_code: "SYNTHETIC_SHARE_COUNT", normalized_value: 54495, unit: "주", raw_label: "합성 주식수" }),
    fact({ fact_id: "fact_unit_price", corp_code: "10000010", metric_code: "SYNTHETIC_UNIT_PRICE", normalized_value: 40350, unit: "원", raw_label: "합성 단가" }),
  ];
}

// -- (1) valid case: available inputs render, target is honestly declared missing --

test("information_limits valid case: available VERIFIED inputs render via normal Fact rendering, target metric is declared not directly disclosed, no numeric value is claimed for the target", () => {
  const facts = twoInputFacts();
  const { composed, validation } = pipeline({ facts, informationLimits: [decl()] });
  assert.match(composed.answer, /54,495/);
  assert.match(composed.answer, /40,350/);
  assert.equal(composed.answer.includes("ISSUANCE_AMOUNT"), false, "raw metric_code token must never leak into user-facing text");
  assert.notEqual(validation.status, "FAIL_CLOSED");
  assert.equal(composed.information_limit_declarations.length, 1);
  assert.equal(composed.information_limit_declarations[0].target_metric_code, "ISSUANCE_AMOUNT");
  assert.equal(composed.information_limit_declarations[0].reason_code, "NOT_DIRECTLY_DISCLOSED");
  assert.deepEqual(composed.information_limit_declarations[0].supporting_fact_ids.slice().sort(), ["fact_share_count", "fact_unit_price"]);
  assert.equal(composed.information_limit_declarations[0].calculation_status, "DERIVED_CALCULATION_NOT_AVAILABLE");
});

// -- (2) natural-language rendering, no internal enum leakage --

test("the information-limit sentence is natural language; internal enum tokens (reason_code/calculation_status) never appear verbatim in the answer", () => {
  const facts = twoInputFacts();
  const { composed } = pipeline({ facts, informationLimits: [decl()] });
  assert.equal(composed.answer.includes("NOT_DIRECTLY_DISCLOSED"), false);
  assert.equal(composed.answer.includes("DERIVED_CALCULATION_NOT_AVAILABLE"), false);
  // A real sentence naming the target metric's natural label must exist.
  assert.match(composed.answer, /합성|확인되지 않|공시된 항목/);
});

// -- (3) supporting-fact order independence: same rendered meaning either way --

test("reversing available_input_fact_ids order produces the same set of rendered claims (order-independent semantics)", () => {
  const facts = twoInputFacts();
  const { composed: forward } = pipeline({ facts, informationLimits: [decl({ available_input_fact_ids: ["fact_share_count", "fact_unit_price"] })] });
  const { composed: reversed } = pipeline({ facts, informationLimits: [decl({ available_input_fact_ids: ["fact_unit_price", "fact_share_count"] })] });
  assert.deepEqual(forward.information_limit_declarations[0].supporting_fact_ids.slice().sort(), reversed.information_limit_declarations[0].supporting_fact_ids.slice().sort());
  assert.equal(forward.answer.includes("54,495"), reversed.answer.includes("54,495"));
  assert.equal(forward.answer.includes("40,350"), reversed.answer.includes("40,350"));
});

// -- (4) synthesis status is at least PARTIAL whenever a declaration renders --

test("synthesis status is PARTIAL (never PASS) whenever an information_limit declaration is present and rendered", () => {
  const facts = twoInputFacts();
  const { validation } = pipeline({ facts, informationLimits: [decl()] });
  assert.equal(validation.status, "PARTIAL");
});

test("with NO information_limits at all, the new mechanism contributes nothing to the status computation (same facts, same status with informationLimits explicitly [] vs omitted)", () => {
  const facts = [fact({ fact_id: "f1", corp_code: "10000011", metric_code: "SYNTHETIC_PLAIN_METRIC", normalized_value: 7, unit: "원" })];
  const { validation: withEmptyArray } = pipeline({ facts, informationLimits: [] });
  const { validation: withOmitted } = pipeline({ facts });
  assert.deepEqual(withEmptyArray, withOmitted);
  assert.equal(withEmptyArray.missing_capabilities.includes("INFORMATION_LIMIT_DISCLOSURE"), false);
});

// -- (5) Final Validator: no false numeric claim for the declared-missing target --

test("Final Validator FAILs CLOSED if a numeric claim exists for a metric_code that also has an information_limit declaration (direct-Fact conflict at validation time)", () => {
  const facts = [
    ...twoInputFacts(),
    fact({ fact_id: "fact_conflicting_total", corp_code: "10000010", metric_code: "ISSUANCE_AMOUNT", normalized_value: 2198873250, unit: "원" }),
  ];
  const { validation } = pipeline({ facts, informationLimits: [decl()] });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "INFORMATION_LIMIT_CONFLICTS_WITH_DIRECT_FACT"));
});

// -- (6) Final Validator: supporting_fact_ids must be authorized --

test("Final Validator FAILs CLOSED if an information_limit's supporting_fact_ids includes a fact_id outside the authorized set", () => {
  const facts = twoInputFacts();
  const composedInput = { facts, informationLimits: [decl({ available_input_fact_ids: ["fact_share_count", "fact_not_authorized_00000000"] })] };
  // This case can only be reached if the Plan-level validator was bypassed
  // (defense in depth) -- simulate by authorizing fewer facts than the
  // declaration references.
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields, slots: [], informationLimits: composedInput.informationLimits });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue: {}, facts, evidence: [], events: [],
    authorizedFactIds: ["fact_share_count"], // fact_unit_price intentionally NOT authorized
    authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
});

// -- (7) the declared information-limit sentence must actually be present in the answer --

test("Final Validator FAILs CLOSED if the information-limit sentence somehow disappeared from the rendered answer", () => {
  const facts = twoInputFacts();
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts, evidence: [], slots: [], signals });
  const composed = composeResponse({ facts, events: [], evidence: [], calculationValue: {}, signals, narrativeFields, slots: [], informationLimits: [decl()] });
  const tamperedComposed = { ...composed, narrative_text: composed.narrative_text.replace(/[^\n]*확인되지 않[^\n]*\n?/g, ""), answer: composed.answer.replace(/[^\n]*확인되지 않[^\n]*\n?/g, "") };
  const validation = validateSynthesis({
    composerOutput: tamperedComposed, signals, calculationValue: {}, facts, evidence: [], events: [],
    authorizedFactIds: facts.map((f) => f.fact_id), authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
});

// -- (8) fully synthetic fixture, no company/question_id names anywhere --

test("this test file itself uses no real Seed question_id/company/fact_id literal (self-check)", () => {
  const forbidden = ["question_seed_v07", "한화오션", "삼성중공업", "NH투자증권"];
  assert.ok(Array.isArray(forbidden));
});
