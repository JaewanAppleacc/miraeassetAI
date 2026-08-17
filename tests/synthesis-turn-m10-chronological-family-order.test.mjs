// Turn M10: the shared structured-query layer returns FACT records
// sorted by known_at DESCENDING (most recently known first) -- a
// deliberate, shared convention this Turn does not change. For a
// question whose Facts include a MULTI-STEP correction/lifecycle
// sequence sharing the SAME metric_code (e.g. several successive
// deadline-correction disclosures), that descending-known_at order
// scrambles the sequence into reverse-chronological reading order. Owner
// review named this exact defect: values were individually correct but
// printed in reverse order.
//
// Fix: a stable, GROUP-SCOPED re-sort -- facts sharing the SAME
// metric_code are reordered ascending by as_of_date; facts with
// different metric_codes keep their original relative order untouched.
// This was verified against the REAL structured-query result order for
// every other in-corpus question with 2+ same-metric_code facts before
// being written (9 real questions checked; none had their order changed
// by this rule -- their existing same-metric_code pairs already happened
// to already be in ascending-date order).
import assert from "node:assert/strict";
import test from "node:test";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse, sortFactFamiliesChronologically } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "TEST_METRIC",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    source_document_id: "doc_default", raw_label: "테스트 지표", attributes: {}, ...overrides,
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

test("Turn M10: 4+ same-metric_code facts arriving in REVERSE-chronological (descending known_at-simulated) input order are rendered in ASCENDING as_of_date order", () => {
  // Deliberately fed in descending order (as the real query layer would
  // hand them over), each with a distinct, uniquely-identifiable value.
  const facts = [
    fact({ fact_id: "fact_4", metric_code: "SYNTHETIC_DEADLINE", as_of_date: "2030-07-02", normalized_value: "합성값4" }),
    fact({ fact_id: "fact_3", metric_code: "SYNTHETIC_DEADLINE", as_of_date: "2030-06-25", normalized_value: "합성값3" }),
    fact({ fact_id: "fact_2", metric_code: "SYNTHETIC_DEADLINE", as_of_date: "2030-03-20", normalized_value: "합성값2" }),
    fact({ fact_id: "fact_1", metric_code: "SYNTHETIC_DEADLINE", as_of_date: "2023-06-05", normalized_value: "합성값1" }),
  ];
  const { composed } = pipeline({ facts, slots: [{ slot_name: "s", fact_ids: facts.map((f) => f.fact_id), evidence_ids: [] }] });
  const positions = ["합성값1", "합성값2", "합성값3", "합성값4"].map((v) => composed.answer.indexOf(v));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "values must appear in ascending chronological order in the rendered text");
});

test("Turn M10 counterexample: facts with DIFFERENT metric_codes keep their original relative order (only same-metric_code families are re-sorted)", () => {
  const facts = [
    fact({ fact_id: "fact_b_first", metric_code: "SYNTHETIC_METRIC_B", as_of_date: "2030-01-01", normalized_value: "값비" }),
    fact({ fact_id: "fact_a_second", metric_code: "SYNTHETIC_METRIC_A", as_of_date: "2020-01-01", normalized_value: "값에이" }),
  ];
  const { composed } = pipeline({ facts, slots: [{ slot_name: "s", fact_ids: facts.map((f) => f.fact_id), evidence_ids: [] }] });
  // fact_b_first (metric B, later real position given first) must still
  // render BEFORE fact_a_second (metric A) even though A's date is
  // earlier -- they are unrelated metrics, never cross-family reordered.
  assert.ok(composed.answer.indexOf("값비") < composed.answer.indexOf("값에이"));
});

test("Turn M10: a single fact per metric_code (no family to reorder) is unaffected", () => {
  const facts = [
    fact({ fact_id: "fact_x", metric_code: "SYNTHETIC_ONLY_ONE", as_of_date: "2030-01-01", normalized_value: "값엑스" }),
  ];
  const { composed, validation } = pipeline({ facts, slots: [{ slot_name: "s", fact_ids: ["fact_x"], evidence_ids: [] }] });
  assert.match(composed.answer, /값엑스/);
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

// -- Turn M10.1: position-preserving per-group re-sort (replaces the
// earlier mixed-comparator implementation, which was not guaranteed
// transitive across 3+ interleaved metric_code families) ------------------
// Reached directly (not just through composeResponse's rendered text) so
// positional claims like "B keeps its own slot" are exact, not inferred
// from where a value string happens to appear in a paragraph.

function syntheticFact(fact_id, metric_code, as_of_date) {
  return { fact_id, metric_code, as_of_date, normalized_value: fact_id };
}

test("Turn M10.1: A(metric X, late), B(metric Y), C(metric X, early) -> only X's two positions swap (C, B, A); B's own slot is untouched", () => {
  const A = syntheticFact("A", "METRIC_X", "2030-01-01");
  const B = syntheticFact("B", "METRIC_Y", "2025-06-01");
  const C = syntheticFact("C", "METRIC_X", "2020-01-01");
  const result = sortFactFamiliesChronologically([A, B, C]);
  assert.deepEqual(result.map((f) => f.fact_id), ["C", "B", "A"]);
});

test("Turn M10.1: 3+ metric_code families interleaved -- each family is independently re-sorted into its own original positions, never mixed across families", () => {
  // positions: 0=X(late) 1=Y(mid) 2=X(early) 3=Z(late) 4=Y(early) 5=Z(early)
  const facts = [
    syntheticFact("x_late", "METRIC_X", "2028-01-01"),
    syntheticFact("y_mid", "METRIC_Y", "2024-01-01"),
    syntheticFact("x_early", "METRIC_X", "2021-01-01"),
    syntheticFact("z_late", "METRIC_Z", "2029-01-01"),
    syntheticFact("y_early", "METRIC_Y", "2019-01-01"),
    syntheticFact("z_early", "METRIC_Z", "2018-01-01"),
  ];
  const result = sortFactFamiliesChronologically(facts);
  // X's slots (0, 2) get X's two facts in ascending-date order
  assert.equal(result[0].fact_id, "x_early");
  assert.equal(result[2].fact_id, "x_late");
  // Y's slots (1, 4) get Y's two facts in ascending-date order
  assert.equal(result[1].fact_id, "y_early");
  assert.equal(result[4].fact_id, "y_mid");
  // Z's slots (3, 5) get Z's two facts in ascending-date order
  assert.equal(result[3].fact_id, "z_early");
  assert.equal(result[5].fact_id, "z_late");
});

test("Turn M10.1 counterexample: within one family, EQUAL as_of_date keeps the group's own original relative order (stable sort, not re-shuffled)", () => {
  const facts = [
    syntheticFact("second", "METRIC_X", "2025-01-01"),
    syntheticFact("first", "METRIC_X", "2025-01-01"),
  ];
  const result = sortFactFamiliesChronologically(facts);
  assert.deepEqual(result.map((f) => f.fact_id), ["second", "first"]);
});

test("Turn M10.1 counterexample: within one family, NULL/missing as_of_date stays in its exact original slot while dated Facts sort only among dated slots", () => {
  const facts = [
    syntheticFact("no_date_first", "METRIC_X", null),
    syntheticFact("dated_late", "METRIC_X", "2030-01-01"),
    syntheticFact("no_date_second", "METRIC_X", undefined),
    syntheticFact("dated_early", "METRIC_X", "2020-01-01"),
  ];
  const result = sortFactFamiliesChronologically(facts);
  assert.deepEqual(result.map((f) => f.fact_id), ["no_date_first", "dated_early", "no_date_second", "dated_late"]);
});
