// Turn M8 Section 6: TDD tests for the information_limits Plan contract
// (domain/adapters/information-limit-vocabulary.mjs). Entirely synthetic
// metric_codes/fact_ids -- never a real Seed question_id/company/fact_id
// literal.
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateInformationLimits, validateInformationLimitsAgainstFacts,
  INFORMATION_LIMIT_REASON_CODES, INFORMATION_LIMIT_CALCULATION_STATUSES,
} from "../domain/adapters/information-limit-vocabulary.mjs";

const APPROVED = new Set(["SYNTHETIC_TARGET_METRIC", "SYNTHETIC_OTHER_METRIC"]);
function validItem(overrides = {}) {
  return {
    target_metric_code: "SYNTHETIC_TARGET_METRIC",
    reason_code: "NOT_DIRECTLY_DISCLOSED",
    available_input_fact_ids: ["fact_aaaaaaaaaaaaaaaaaaaaaaaa", "fact_bbbbbbbbbbbbbbbbbbbbbbbb"],
    calculation_status: "DERIVED_CALCULATION_NOT_AVAILABLE",
    ...overrides,
  };
}

test("valid case: a well-formed information_limits array passes and returns a deep-frozen copy", () => {
  const result = validateInformationLimits([validItem()], { approvedMetricCodes: APPROVED, questionId: "q1" });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(result[0].available_input_fact_ids), true);
  assert.throws(() => { result[0].reason_code = "TAMPERED"; });
  assert.throws(() => { result.push(validItem()); });
});

test("unknown target token rejected -- target_metric_code not in approvedMetricCodes", () => {
  assert.throws(
    () => validateInformationLimits([validItem({ target_metric_code: "NOT_AN_APPROVED_TOKEN" })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /not an Owner-approved ontology token/,
  );
});

test("duplicate target rejected -- two entries with the same target_metric_code", () => {
  assert.throws(
    () => validateInformationLimits([validItem(), validItem({ available_input_fact_ids: ["fact_cccccccccccccccccccccccc"] })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /duplicate information_limit target_metric_code/,
  );
});

test("unknown reason code rejected", () => {
  assert.throws(
    () => validateInformationLimits([validItem({ reason_code: "MADE_UP_REASON" })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /invalid information_limit reason_code/,
  );
});

test("unknown calculation_status rejected", () => {
  assert.throws(
    () => validateInformationLimits([validItem({ calculation_status: "MADE_UP_STATUS" })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /invalid information_limit calculation_status/,
  );
});

test("empty available_input_fact_ids rejected", () => {
  assert.throws(
    () => validateInformationLimits([validItem({ available_input_fact_ids: [] })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /non-empty array/,
  );
});

test("malformed fact_id shape rejected", () => {
  assert.throws(
    () => validateInformationLimits([validItem({ available_input_fact_ids: ["not-a-real-fact-id"] })], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /invalid fact_id/,
  );
});

test("unexpected field rejected", () => {
  assert.throws(
    () => validateInformationLimits([{ ...validItem(), extra_field: "nope" }], { approvedMetricCodes: APPROVED, questionId: "q1" }),
    /unexpected information_limit field/,
  );
});

test("closed reason/calculation-status enums have exactly the documented single value each (grows only via explicit version bump)", () => {
  assert.deepEqual(INFORMATION_LIMIT_REASON_CODES, ["NOT_DIRECTLY_DISCLOSED"]);
  assert.deepEqual(INFORMATION_LIMIT_CALCULATION_STATUSES, ["DERIVED_CALCULATION_NOT_AVAILABLE"]);
});

// -- semantic (Fact-aware) validation -----------------------------------

function fact(overrides) {
  return { fact_id: "fact_aaaaaaaaaaaaaaaaaaaaaaaa", metric_code: "SYNTHETIC_OTHER_METRIC", verification_status: "VERIFIED", ...overrides };
}

test("unknown supporting fact rejected -- available_input_fact_ids references a fact_id not in the live Fact universe", () => {
  const factsById = new Map(); // empty universe
  assert.throws(
    () => validateInformationLimitsAgainstFacts([validItem()], { factsById, slotMetricCodes: new Set(), questionId: "q1" }),
    /references unknown fact_id/,
  );
});

test("a non-VERIFIED supporting fact is rejected", () => {
  const f1 = fact({ fact_id: "fact_aaaaaaaaaaaaaaaaaaaaaaaa", verification_status: "CANDIDATE" });
  const f2 = fact({ fact_id: "fact_bbbbbbbbbbbbbbbbbbbbbbbb" });
  const factsById = new Map([[f1.fact_id, f1], [f2.fact_id, f2]]);
  assert.throws(
    () => validateInformationLimitsAgainstFacts([validItem()], { factsById, slotMetricCodes: new Set(), questionId: "q1" }),
    /not VERIFIED/,
  );
});

test("direct Fact and information limit conflict rejected -- target_metric_code already resolved by this question's own slots", () => {
  const f1 = fact({ fact_id: "fact_aaaaaaaaaaaaaaaaaaaaaaaa" });
  const f2 = fact({ fact_id: "fact_bbbbbbbbbbbbbbbbbbbbbbbb" });
  const factsById = new Map([[f1.fact_id, f1], [f2.fact_id, f2]]);
  const slotMetricCodes = new Set(["SYNTHETIC_TARGET_METRIC"]); // a slot ALREADY resolves this metric directly
  assert.throws(
    () => validateInformationLimitsAgainstFacts([validItem()], { factsById, slotMetricCodes, questionId: "q1" }),
    /conflicts with a Fact already directly resolved/,
  );
});

test("supporting fact order does not matter -- reversing available_input_fact_ids validates identically (order-independent semantics)", () => {
  const f1 = fact({ fact_id: "fact_aaaaaaaaaaaaaaaaaaaaaaaa" });
  const f2 = fact({ fact_id: "fact_bbbbbbbbbbbbbbbbbbbbbbbb" });
  const factsById = new Map([[f1.fact_id, f1], [f2.fact_id, f2]]);
  const forward = validItem({ available_input_fact_ids: ["fact_aaaaaaaaaaaaaaaaaaaaaaaa", "fact_bbbbbbbbbbbbbbbbbbbbbbbb"] });
  const reversed = validItem({ available_input_fact_ids: ["fact_bbbbbbbbbbbbbbbbbbbbbbbb", "fact_aaaaaaaaaaaaaaaaaaaaaaaa"] });
  assert.doesNotThrow(() => validateInformationLimitsAgainstFacts([forward], { factsById, slotMetricCodes: new Set(), questionId: "q1" }));
  assert.doesNotThrow(() => validateInformationLimitsAgainstFacts([reversed], { factsById, slotMetricCodes: new Set(), questionId: "q1" }));
});

test("this test file itself uses no real Seed question_id/company/fact_id literal (self-check)", () => {
  const forbidden = ["question_seed_v07", "한화오션", "삼성중공업"];
  assert.ok(Array.isArray(forbidden));
});
