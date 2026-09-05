import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveArmSelectionState, selectWinner, deriveLowUnderpowered, WinnerSelectionError,
} from "../domain/agent-comparison/four-arm-ac/four-arm-winner-selection.mjs";

function state(arm, executionState, hardGateState, extra = {}) {
  return deriveArmSelectionState({ arm, executionState, hardGateState, ...extra });
}

test("a not-yet-executed arm is selection_eligible=null (pending, not false)", () => {
  const s = state("A", "NOT_EXECUTED_PENDING_DEVTUNE", "HARD_GATE_PENDING_EXECUTION");
  assert.equal(s.arm_selection_eligible, null);
  assert.equal(s.arm_execution_state, "NOT_EXECUTED_PENDING_DEVTUNE");
  assert.equal(s.arm_hard_gate_state, "HARD_GATE_PENDING_EXECUTION");
});

test("a reused-verified arm with a failed hard gate is selection_eligible=false with a failure reason", () => {
  const s = state("B", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" });
  assert.equal(s.arm_selection_eligible, false);
  assert.equal(s.failure_reason, "ARM_SPECIFIC_CRITICAL_2");
});

test("an executed arm that passed the hard gate is selection_eligible=true", () => {
  const s = state("A", "EXECUTED", "HARD_GATE_PASSED");
  assert.equal(s.arm_selection_eligible, true);
});

test("an EXECUTED arm can never be left with a pending hard gate (contract violation, throws)", () => {
  assert.throws(
    () => state("A", "EXECUTED", "HARD_GATE_PENDING_EXECUTION"),
    (e) => e instanceof WinnerSelectionError && e.code === "SELECTION_EXECUTED_WITHOUT_HARD_GATE",
  );
});

test("rejects invalid execution/hard-gate state enums", () => {
  assert.throws(() => state("A", "BOGUS", "HARD_GATE_PASSED"), (e) => e.code === "SELECTION_INVALID_EXECUTION_STATE");
  assert.throws(() => state("A", "EXECUTED", "BOGUS"), (e) => e.code === "SELECTION_INVALID_HARD_GATE_STATE");
});

// --- scenario tests mirroring Turn section D's numbered list ---

test("scenario: one arm's hard gate failure does not prevent other arms from having their own independent state (execution is per-arm)", () => {
  const b = state("B", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" });
  const a = state("A", "NOT_EXECUTED_PENDING_DEVTUNE", "HARD_GATE_PENDING_EXECUTION");
  assert.equal(b.arm_selection_eligible, false);
  assert.equal(a.arm_selection_eligible, null); // A is untouched by B's failure -- still independently pending
});

test("scenario: B/D with 2 critical packets are selection_eligible=false (via the owner-resolutions-derived hard gate)", () => {
  const b = state("B", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" });
  const d = state("D", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" });
  assert.equal(b.arm_selection_eligible, false);
  assert.equal(d.arm_selection_eligible, false);
});

test("scenario: A/C's own not-yet-executed pending state is unaffected by B/D's failure (checked at the selectWinner level too)", () => {
  const arms = [
    state("A", "NOT_EXECUTED_PENDING_DEVTUNE", "HARD_GATE_PENDING_EXECUTION"),
    state("C", "NOT_EXECUTED_PENDING_DEVTUNE", "HARD_GATE_PENDING_EXECUTION"),
    state("B", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" }),
    state("D", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" }),
  ];
  // The batch-execution-readiness question (can A/C run?) is a SEPARATE
  // concern from selectWinner (can we pick a winner?) -- this test only
  // asserts selectWinner reports EXECUTION_PENDING, not that A/C were
  // blocked from running; four-arm-preflight.test.mjs covers the
  // execution-readiness side of this same scenario.
  const result = selectWinner(arms);
  assert.equal(result.status, "EXECUTION_PENDING");
});

test("scenario: a hard-gate-failed arm can never become the winner even if it somehow carries quality_metrics", () => {
  const armsWithSneakyMetrics = [
    { arm: "B", arm_selection_eligible: false, quality_metrics: { primary_recall: 0.99 } },
    { arm: "D", arm_selection_eligible: false, quality_metrics: { primary_recall: 0.98 } },
    { arm: "A", arm_selection_eligible: true, quality_metrics: { primary_recall: 0.5 } },
    { arm: "C", arm_selection_eligible: true, quality_metrics: { primary_recall: 0.4 } },
  ];
  const result = selectWinner(armsWithSneakyMetrics);
  assert.equal(result.status, "PROVISIONAL_WINNER");
  assert.equal(result.winner, "A"); // higher recall among ELIGIBLE arms only, B/D's higher numbers are irrelevant
});

test("scenario: final_selection_ready implications -- EXECUTION_PENDING while any arm lacks a final hard-gate verdict", () => {
  const arms = [
    { arm: "A", arm_selection_eligible: null },
    { arm: "C", arm_selection_eligible: null },
    { arm: "B", arm_selection_eligible: false },
    { arm: "D", arm_selection_eligible: false },
  ];
  const result = selectWinner(arms);
  assert.equal(result.status, "EXECUTION_PENDING");
});

test("scenario: if every arm fails the hard gate, status is NO_SELECTION_BLOCKED, never a forced winner", () => {
  const arms = [
    { arm: "A", arm_selection_eligible: false },
    { arm: "C", arm_selection_eligible: false },
    { arm: "B", arm_selection_eligible: false },
    { arm: "D", arm_selection_eligible: false },
  ];
  const result = selectWinner(arms);
  assert.equal(result.status, "NO_SELECTION_BLOCKED");
  assert.equal(result.winner, null);
});

test("NO_SELECTION_BLOCKED is reported ONLY when all arms are known-ineligible, never merely because some are still pending", () => {
  const allFailed = [
    { arm: "A", arm_selection_eligible: false }, { arm: "C", arm_selection_eligible: false },
    { arm: "B", arm_selection_eligible: false }, { arm: "D", arm_selection_eligible: false },
  ];
  assert.equal(selectWinner(allFailed).status, "NO_SELECTION_BLOCKED");

  const mixedPending = [
    { arm: "A", arm_selection_eligible: null }, { arm: "C", arm_selection_eligible: false },
    { arm: "B", arm_selection_eligible: false }, { arm: "D", arm_selection_eligible: false },
  ];
  assert.equal(selectWinner(mixedPending).status, "EXECUTION_PENDING");
});

test("selectWinner throws if an eligible arm is missing usable quality_metrics -- never silently skips it", () => {
  const arms = [
    { arm: "A", arm_selection_eligible: true, quality_metrics: null },
    { arm: "C", arm_selection_eligible: false },
    { arm: "B", arm_selection_eligible: false },
    { arm: "D", arm_selection_eligible: false },
  ];
  assert.throws(() => selectWinner(arms), (e) => e.code === "SELECTION_MISSING_QUALITY_METRICS");
});

test("selectWinner rejects an empty arms array", () => {
  assert.throws(() => selectWinner([]), (e) => e.code === "SELECTION_ARMS_EMPTY");
});

test("deriveLowUnderpowered: below 10 is underpowered, 10+ is not", () => {
  assert.equal(deriveLowUnderpowered(9), true);
  assert.equal(deriveLowUnderpowered(10), false);
  assert.equal(deriveLowUnderpowered(20), false);
  assert.equal(deriveLowUnderpowered(0), true);
});

test("deriveLowUnderpowered rejects a negative or non-integer count", () => {
  assert.throws(() => deriveLowUnderpowered(-1), (e) => e.code === "LOW_UNDERPOWERED_INVALID_COUNT");
  assert.throws(() => deriveLowUnderpowered(1.5), (e) => e.code === "LOW_UNDERPOWERED_INVALID_COUNT");
});

// --- RETRIEVAL_EXECUTED_PENDING_SCORING: a real retrieval run completed
// but the frozen scorer (which needs Gold) has not been applied yet ---

test("a completed retrieval run with scoring still pending behaves like not-yet-executed for ELIGIBILITY (selection_eligible stays null, not true/false)", () => {
  const s = state("A", "RETRIEVAL_EXECUTED_PENDING_SCORING", "HARD_GATE_PENDING_EXECUTION");
  assert.equal(s.arm_execution_state, "RETRIEVAL_EXECUTED_PENDING_SCORING");
  assert.equal(s.arm_hard_gate_state, "HARD_GATE_PENDING_EXECUTION");
  assert.equal(s.arm_selection_eligible, null);
});

test("RETRIEVAL_EXECUTED_PENDING_SCORING never throws SELECTION_EXECUTED_WITHOUT_HARD_GATE -- unlike EXECUTED, it does not assert scoring is final", () => {
  // This is the whole point of the distinct state: EXECUTED with a
  // pending hard gate is a contract violation (scoring was supposed to
  // have happened), but a retrieval-only completion with scoring
  // deliberately deferred (Gold lives outside this environment) is not.
  const s = state("A", "RETRIEVAL_EXECUTED_PENDING_SCORING", "HARD_GATE_PENDING_EXECUTION");
  assert.equal(s.arm_selection_eligible, null);
});

test("selectWinner reports EXECUTION_PENDING when an arm's retrieval finished but scoring did not", () => {
  const arms = [
    state("A", "RETRIEVAL_EXECUTED_PENDING_SCORING", "HARD_GATE_PENDING_EXECUTION"),
    state("C", "RETRIEVAL_EXECUTED_PENDING_SCORING", "HARD_GATE_PENDING_EXECUTION"),
    state("B", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" }),
    state("D", "REUSED_VERIFIED", "HARD_GATE_FAILED", { failureReason: "ARM_SPECIFIC_CRITICAL_2" }),
  ];
  const result = selectWinner(arms);
  assert.equal(result.status, "EXECUTION_PENDING");
  assert.equal(result.winner, null);
});
