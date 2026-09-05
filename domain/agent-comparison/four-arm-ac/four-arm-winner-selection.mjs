// Turn FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE: separates
// "can this batch run" (execution readiness) from "did this arm earn a
// seat in the final comparison" (selection eligibility), and implements
// winner selection as a pure function over already-computed per-arm state.
// A hard-gate-failed arm can never be selected, structurally -- not by a
// convention selectWinner happens to follow, but because ineligible arms
// are filtered out before any metric comparison ever runs.
// RETRIEVAL_EXECUTED_PENDING_SCORING: the real DEV_TUNE-101 retrieval run
// completed (checkpoint-complete, 0 errors) but the frozen scorer has not
// been applied yet -- distinct from EXECUTED, which this module treats as
// "retrieval AND scoring both done, a hard-gate verdict must exist" (see
// the throw below). This state exists because scoring requires Gold
// access this integration environment intentionally does not have (same
// non-leak boundary as DEV_CHECK/HOLDOUT) -- the actual scoring pass runs
// wherever Gold legitimately lives, against these same results files.
export const EXECUTION_STATES = Object.freeze([
  "NOT_EXECUTED_PENDING_DEVTUNE", "RETRIEVAL_EXECUTED_PENDING_SCORING", "EXECUTED", "REUSED_VERIFIED",
]);
export const HARD_GATE_STATES = Object.freeze(["HARD_GATE_PENDING_EXECUTION", "HARD_GATE_PASSED", "HARD_GATE_FAILED"]);
export const SELECTION_STATUSES = Object.freeze(["EXECUTION_PENDING", "NO_SELECTION_BLOCKED", "PROVISIONAL_WINNER"]);

export class WinnerSelectionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WinnerSelectionError";
    this.code = code;
    Object.assign(this, details);
  }
}

// executionState: EXECUTION_STATES. hardGateState: HARD_GATE_STATES.
// selection_eligible is null (unknown, not yet decidable) while the arm
// has not finished executing OR its hard gate has not been evaluated --
// it is only ever true/false once both are final. This keeps "not yet
// known" structurally distinct from "known ineligible".
export function deriveArmSelectionState({ arm, executionState, hardGateState, failureReason = null }) {
  if (!EXECUTION_STATES.includes(executionState)) {
    throw new WinnerSelectionError(`invalid executionState ${JSON.stringify(executionState)} for arm ${arm}`, "SELECTION_INVALID_EXECUTION_STATE");
  }
  if (!HARD_GATE_STATES.includes(hardGateState)) {
    throw new WinnerSelectionError(`invalid hardGateState ${JSON.stringify(hardGateState)} for arm ${arm}`, "SELECTION_INVALID_HARD_GATE_STATE");
  }
  // "executed" here means "scoring is expected to be final" -- a retrieval
  // run alone (RETRIEVAL_EXECUTED_PENDING_SCORING) is deliberately NOT in
  // this set, so it behaves like NOT_EXECUTED_PENDING_DEVTUNE for
  // eligibility purposes (selection_eligible stays null/pending) even
  // though the retrieval itself already succeeded.
  const executed = executionState === "EXECUTED" || executionState === "REUSED_VERIFIED";
  let selectionEligible = null;
  if (executed && hardGateState === "HARD_GATE_PASSED") selectionEligible = true;
  else if (hardGateState === "HARD_GATE_FAILED") selectionEligible = false; // known-ineligible even before/without execution (B/D: judged from frozen results, not pending)
  else if (executed && hardGateState === "HARD_GATE_PENDING_EXECUTION") {
    throw new WinnerSelectionError(`arm ${arm} is EXECUTED/REUSED_VERIFIED but hard gate was never evaluated`, "SELECTION_EXECUTED_WITHOUT_HARD_GATE");
  }
  return Object.freeze({
    arm,
    arm_execution_state: executionState,
    arm_hard_gate_state: hardGateState,
    arm_selection_eligible: selectionEligible,
    failure_reason: hardGateState === "HARD_GATE_FAILED" ? failureReason : null,
  });
}

// arms: array of deriveArmSelectionState(...) outputs, each optionally
// carrying `quality_metrics: { primary_recall } | null` (present only once
// hard_gate_state is PASSED and real metrics exist -- REUSED_VERIFIED/
// EXECUTED arms that failed the hard gate never need metrics to be
// excluded, matching "hard-gate 탈락 arm은 최종 winner가 될 수 없음").
export function selectWinner(arms) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new WinnerSelectionError("arms must be a non-empty array", "SELECTION_ARMS_EMPTY");
  }
  const pending = arms.filter((a) => a.arm_selection_eligible === null);
  if (pending.length > 0) {
    return Object.freeze({
      status: "EXECUTION_PENDING",
      winner: null,
      reason: `${pending.map((a) => a.arm).join(", ")} not yet executed / hard gate not yet evaluated`,
      eligible_arms: Object.freeze([]),
    });
  }

  const eligible = arms.filter((a) => a.arm_selection_eligible === true);
  if (eligible.length === 0) {
    return Object.freeze({
      status: "NO_SELECTION_BLOCKED",
      winner: null,
      reason: "every arm failed the hard safety gate",
      eligible_arms: Object.freeze([]),
    });
  }

  for (const arm of eligible) {
    if (!arm.quality_metrics || typeof arm.quality_metrics.primary_recall !== "number") {
      throw new WinnerSelectionError(`arm ${arm.arm} is selection-eligible but has no usable quality_metrics.primary_recall`, "SELECTION_MISSING_QUALITY_METRICS", { arm: arm.arm });
    }
  }

  const ranked = [...eligible].sort((a, b) => {
    if (b.quality_metrics.primary_recall !== a.quality_metrics.primary_recall) {
      return b.quality_metrics.primary_recall - a.quality_metrics.primary_recall;
    }
    return a.arm.localeCompare(b.arm); // deterministic tie-break only; not a substitute for a real tie-breaker policy decision
  });

  return Object.freeze({
    status: "PROVISIONAL_WINNER",
    winner: ranked[0].arm,
    reason: `highest primary_recall among hard-safe arms (${ranked.map((a) => `${a.arm}=${a.quality_metrics.primary_recall}`).join(", ")})`,
    eligible_arms: Object.freeze(ranked.map((a) => a.arm)),
  });
}

// LOW-segment sample-size floor (vFINAL / common scorer contract: "제외 후
// LOW 표본 수 재계산; LOW <10이면 LOW_UNDERPOWERED"). Pure and
// generically testable -- does not read Gold or any scoring internals,
// only the already-computed post-exclusion LOW sample count.
export function deriveLowUnderpowered(lowSampleCountAfterExclusion) {
  if (!Number.isInteger(lowSampleCountAfterExclusion) || lowSampleCountAfterExclusion < 0) {
    throw new WinnerSelectionError("lowSampleCountAfterExclusion must be a non-negative integer", "LOW_UNDERPOWERED_INVALID_COUNT");
  }
  return lowSampleCountAfterExclusion < 10;
}
