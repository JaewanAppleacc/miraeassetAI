// Turn M capability A: generic date-role inference, tested against
// synthetic Fact fixtures only (no Seed metric_code exact copies where
// avoidable, but the metric_code NAMING CONVENTION tested here is a real
// generic Fact ontology pattern, not a per-question literal).
import assert from "node:assert/strict";
import test from "node:test";
import { inferDateRole, DATE_ROLE, resolveDateValue } from "../domain/flows/synthesis/date-role-labeling.mjs";

test("a real period (period_start != period_end) is labeled 기간, not any single-date role", () => {
  const result = inferDateRole({ metric_code: "SOME_METRIC", period_start: "2020-01-01", period_end: "2020-12-31" });
  assert.equal(result.roleLabel, DATE_ROLE.PERIOD);
  assert.equal(result.confident, true);
});

test("period_start === period_end (a degenerate single-day 'period') is NOT treated as a real period", () => {
  const result = inferDateRole({ metric_code: "SOME_METRIC", period_start: "2020-01-01", period_end: "2020-01-01", normalized_value: 100 });
  assert.notEqual(result.roleLabel, DATE_ROLE.PERIOD);
});

test("metric_code containing TERMINATION -> 해지일", () => {
  const result = inferDateRole({ metric_code: "CONTRACT_TERMINATION_STATUS", as_of_date: "2025-01-01", normalized_value: "X" });
  assert.equal(result.roleLabel, DATE_ROLE.TERMINATION_DATE);
  assert.equal(result.confident, true);
});

test("metric_code containing DECISION or PLANNED -> 결정일", () => {
  assert.equal(inferDateRole({ metric_code: "SOME_DECISION_CONTENT", normalized_value: "X" }).roleLabel, DATE_ROLE.DECISION_DATE);
  assert.equal(inferDateRole({ metric_code: "DISPOSAL_PLANNED_AMOUNT", normalized_value: 100 }).roleLabel, DATE_ROLE.DECISION_DATE);
});

test("metric_code starting with HOLDING_ -> 기준일 (report comparison basis)", () => {
  const result = inferDateRole({ metric_code: "HOLDING_SHARES_AFTER", normalized_value: 100 });
  assert.equal(result.roleLabel, DATE_ROLE.REPORT_DATE);
  assert.equal(result.confident, true);
});

// Turn M10: the OLD broad "metric_code contains CONTRACT -> 계약 체결일"
// substring rule was removed -- it was wide enough to also mislabel a
// decision-disclosure date, a later confirmation-basis date, and a
// reservation-disclosure date as if each were a contract EXECUTION date.
// A synthetic metric_code that merely CONTAINS "CONTRACT" but matches no
// exact SEMANTIC_ROLE_REGISTRY entry must now fall through to a safe,
// non-overclaiming default -- never 계약 체결일 by substring alone.
test("Turn M10: metric_code merely containing CONTRACT (no exact registry entry) never yields 계약 체결일 by substring alone", () => {
  const numericResult = inferDateRole({ metric_code: "SYNTHETIC_CONTRACT_COUNTERPARTY_AMOUNT", normalized_value: 100 });
  assert.notEqual(numericResult.roleLabel, DATE_ROLE.CONTRACT_EXECUTION_DATE);
  assert.equal(numericResult.roleLabel, DATE_ROLE.DISCLOSURE_DATE);
  const stringResult = inferDateRole({ metric_code: "SYNTHETIC_CONTRACT_COUNTERPARTY_NAME", normalized_value: "X" });
  assert.notEqual(stringResult.roleLabel, DATE_ROLE.CONTRACT_EXECUTION_DATE);
  assert.equal(stringResult.confident, false);
});

// Turn M10: a small, closed, EXACT metric_code registry (never substring)
// for tokens whose date role is not safely inferable from period_type/
// value_type shape alone. Every metric_code below is a real, corpus-wide
// VERIFIED Fact token, not a per-question literal.
test("Turn M10: the closed semantic-role registry maps each of its real metric_code tokens to its own specific role, by EXACT match", () => {
  assert.equal(inferDateRole({ metric_code: "CORRECTION_REASON", normalized_value: "X" }).roleLabel, "정정 공시일");
  assert.equal(inferDateRole({ metric_code: "CONTRACT_RESERVATION_DEADLINE", normalized_value: "2030-12-31" }).roleLabel, "유보기한 공시일");
  assert.equal(inferDateRole({ metric_code: "LATEST_CONTRACT_AMOUNT", normalized_value: 100 }).roleLabel, "유효 계약금액 확인 기준일");
  assert.equal(inferDateRole({ metric_code: "TRUST_CONTRACT_INSTITUTION", normalized_value: "X" }).roleLabel, DATE_ROLE.DECISION_DATE);
  assert.equal(inferDateRole({ metric_code: "ACQUISITION_PLANNED_SHARES", normalized_value: 100 }).roleLabel, DATE_ROLE.DECISION_DATE);
  assert.equal(inferDateRole({ metric_code: "CONTRACT_STATUS", normalized_value: "X -> Y" }).roleLabel, "본계약 공시일");
});

// Turn M10: a registry hit must win even when the SAME metric_code would
// also match an older substring rule (e.g. ACQUISITION_PLANNED_SHARES
// contains "ACQUISITION", which rule 6 would otherwise label 사건
// 발생일) -- the exact registry always takes precedence, proving rule
// ORDER is deliberate, not accidental.
test("Turn M10: a registry hit takes precedence over a substring rule that would otherwise also match", () => {
  const result = inferDateRole({ metric_code: "ACQUISITION_PLANNED_SHARES", normalized_value: 100 });
  assert.notEqual(result.roleLabel, DATE_ROLE.EVENT_OCCURRENCE_DATE);
  assert.equal(result.roleLabel, DATE_ROLE.DECISION_DATE);
});

test("metric_code containing RETIREMENT or ACQUISITION -> 사건 발생일", () => {
  assert.equal(inferDateRole({ metric_code: "SHARE_RETIREMENT_STATUS", normalized_value: "X" }).roleLabel, DATE_ROLE.EVENT_OCCURRENCE_DATE);
  assert.equal(inferDateRole({ metric_code: "TRUST_ACQUISITION_STATUS", normalized_value: "X" }).roleLabel, DATE_ROLE.EVENT_OCCURRENCE_DATE);
});

test("a STATUS/CONTENT-suffixed string Fact not matching any other rule -> 사건 발생일", () => {
  const result = inferDateRole({ metric_code: "GENERIC_OUTCOME_STATUS", normalized_value: "SOME_ENUM" });
  assert.equal(result.roleLabel, DATE_ROLE.EVENT_OCCURRENCE_DATE);
});

test("a plain numeric disclosure not matching any other rule -> 공시일", () => {
  const result = inferDateRole({ metric_code: "GENERIC_AMOUNT", normalized_value: 12345 });
  assert.equal(result.roleLabel, DATE_ROLE.DISCLOSURE_DATE);
  assert.equal(result.confident, true);
});

test("an unrecognizable shape falls back to 기준일 with confident:false (never silently guessed as confident)", () => {
  const result = inferDateRole({ metric_code: "TOTALLY_UNKNOWN_TAXONOMY_TOKEN", normalized_value: null });
  assert.equal(result.roleLabel, DATE_ROLE.REPORT_DATE);
  assert.equal(result.confident, false);
});

test("missing/malformed fact input never throws, degrades to the conservative fallback", () => {
  assert.doesNotThrow(() => inferDateRole(null));
  assert.doesNotThrow(() => inferDateRole({}));
  assert.equal(inferDateRole(null).confident, false);
});

// --- Turn M10: resolveDateValue's *_STATUS + linked-Event override -----

test("Turn M10: a *_STATUS Fact whose own as_of_date is a reporting-period boundary prefers its linked Event's real occurrence date", () => {
  const fact = { metric_code: "SYNTHETIC_LIFECYCLE_STATUS", as_of_date: "2030-06-30", event_id: "event_synthetic_1", normalized_value: "COMPLETED_SYNTHETIC" };
  const linkedEvent = { event_id: "event_synthetic_1", event_status: "COMPLETED", event_date: "2030-06-26" };
  assert.equal(resolveDateValue(fact, linkedEvent), "2030-06-26");
  assert.notEqual(resolveDateValue(fact, linkedEvent), fact.as_of_date);
});

test("Turn M10 counterexample: a NON-status Fact's own as_of_date is never overwritten by a nearby-but-different linked Event date", () => {
  // Same shape as the positive fixture above, EXCEPT the metric_code does
  // not end in STATUS -- a plain value-disclosure Fact keeps its own
  // as_of_date even when it shares an event_id with a temporally close
  // but distinct Event (e.g. that Event's own chain-initiating decision).
  const fact = { metric_code: "SYNTHETIC_RESERVATION_DEADLINE", as_of_date: "2030-06-05", event_id: "event_synthetic_2", normalized_value: "2035-12-31" };
  const linkedEvent = { event_id: "event_synthetic_2", event_status: "DECIDED", event_date: "2030-06-03" };
  assert.equal(resolveDateValue(fact, linkedEvent), "2030-06-05");
});

test("Turn M10 counterexample: a *_STATUS Fact whose as_of_date ALREADY equals its linked Event's date is unaffected (idempotent, no spurious change)", () => {
  const fact = { metric_code: "SYNTHETIC_LIFECYCLE_STATUS", as_of_date: "2030-01-15", event_id: "event_synthetic_3", normalized_value: "X" };
  const linkedEvent = { event_id: "event_synthetic_3", event_status: "DECIDED", event_date: "2030-01-15" };
  assert.equal(resolveDateValue(fact, linkedEvent), "2030-01-15");
});

test("Turn M10 counterexample: a *_STATUS Fact with NO linked Event at all keeps its own as_of_date", () => {
  const fact = { metric_code: "SYNTHETIC_LIFECYCLE_STATUS", as_of_date: "2030-06-30", event_id: null, normalized_value: "X" };
  assert.equal(resolveDateValue(fact, null), "2030-06-30");
});

// Turn M10: the *_STATUS role-label override -- when a linked Event's
// event_status resolves to a real, closed status->role label, the role
// itself is derived from the EVENT (never a guess), still framed as
// EVENT_OCCURRENCE_DATE (never masquerading as e.g. 계약 체결일).
test("Turn M10: a *_STATUS Fact's role label is derived from its linked Event's own event_status when resolvable", () => {
  const fact = { metric_code: "SYNTHETIC_LIFECYCLE_STATUS", as_of_date: "2030-06-30", normalized_value: "X" };
  const linkedEvent = { event_status: "CORRECTED", event_date: "2030-06-26" };
  const result = inferDateRole(fact, linkedEvent);
  assert.equal(result.roleLabel, "정정일");
  assert.equal(result.role, "EVENT_OCCURRENCE_DATE");
});
