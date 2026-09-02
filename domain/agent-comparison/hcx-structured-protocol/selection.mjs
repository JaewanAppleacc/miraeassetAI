// Turn P11-D section G: the selection rule, applied to a completed
// runStructuredProtocolComparison() result. Pure (no I/O) -- takes the
// runner's candidateA/candidateB result objects and returns which protocol
// (if any) is selected, plus the reason. Never re-executes a call itself.
import { P11D_HARD_LIMITS } from "./hard-limits.mjs";
import { CANDIDATE_A_ID } from "./candidate-a-function-calling.mjs";
import { CANDIDATE_B_ID } from "./candidate-b-response-format.mjs";

// GREEN (CLAUDE.md Turn P11-D section G): exactly PER_CANDIDATE_REQUESTS
// (15) scenario x repetition units were attempted AND every one of them
// succeeded -- a candidate that was skipped (auth-abort before start) or
// stopped early (global cap reached mid-sweep) can never be GREEN, matching
// section G rule 4's "둘 다 15/15 미만이면 RED".
export function isCandidateGreen(candidateResult) {
  if (!candidateResult || candidateResult.skippedReason) return false;
  const runs = candidateResult.scenarioRuns;
  if (runs.length !== P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS) return false;
  return runs.every((run) => run.ok === true);
}

export function successCount(candidateResult) {
  if (!candidateResult) return 0;
  return candidateResult.scenarioRuns.filter((run) => run.ok === true).length;
}

// Rule 3: response_format (candidate B) is de-selected in favor of Function
// Calling (candidate A) only when BOTH candidates are GREEN and B's p95
// latency OR total token usage is >=25% greater than A's.
function candidateBTooExpensive(candidateA, candidateB) {
  const latencyA = candidateA.latencyStats?.p95_ms;
  const latencyB = candidateB.latencyStats?.p95_ms;
  if (Number.isFinite(latencyA) && Number.isFinite(latencyB) && latencyA > 0 && latencyB >= latencyA * 1.25) return true;

  const tokensA = candidateA.tokenUsageAggregate
    ? candidateA.tokenUsageAggregate.input_tokens_total + candidateA.tokenUsageAggregate.output_tokens_total
    : null;
  const tokensB = candidateB.tokenUsageAggregate
    ? candidateB.tokenUsageAggregate.input_tokens_total + candidateB.tokenUsageAggregate.output_tokens_total
    : null;
  if (Number.isFinite(tokensA) && Number.isFinite(tokensB) && tokensA > 0 && tokensB >= tokensA * 1.25) return true;

  return false;
}

// Returns { selected: CANDIDATE_A_ID | CANDIDATE_B_ID | null, status: "GREEN" | "RED", reason }.
// `secretNonLeakPass` (boolean): the security-attestation result computed
// separately by artifacts.mjs -- a GREEN protocol whose run nonetheless
// leaked a secret into an artifact is never selected (section G's own
// "secret non-leak PASS" GREEN condition).
export function selectStructuredProtocol({ candidateA, candidateB, secretNonLeakPass }) {
  if (secretNonLeakPass !== true) {
    return { selected: null, status: "RED", reason: "secret non-leak check did not PASS; no candidate may be selected regardless of success rate" };
  }

  const aGreen = isCandidateGreen(candidateA);
  const bGreen = isCandidateGreen(candidateB);

  if (aGreen && !bGreen) {
    return { selected: CANDIDATE_A_ID, status: "GREEN", reason: `only ${CANDIDATE_A_ID} reached 15/15 with zero malformed/schema/tool/envelope violations` };
  }
  if (bGreen && !aGreen) {
    return { selected: CANDIDATE_B_ID, status: "GREEN", reason: `only ${CANDIDATE_B_ID} reached 15/15 with zero malformed/schema/tool/envelope violations` };
  }
  if (aGreen && bGreen) {
    if (candidateBTooExpensive(candidateA, candidateB)) {
      return { selected: CANDIDATE_A_ID, status: "GREEN", reason: `both candidates GREEN; ${CANDIDATE_B_ID} p95 latency or token usage was >=25% higher than ${CANDIDATE_A_ID}, so Function Calling is preferred per section G rule 3` };
    }
    return { selected: CANDIDATE_B_ID, status: "GREEN", reason: `both candidates GREEN; response_format is preferred per section G rule 2 (no >=25% latency/token cost penalty observed)` };
  }
  return {
    selected: null,
    status: "RED",
    reason: `neither candidate reached 15/15 (${CANDIDATE_A_ID}=${successCount(candidateA)}/${P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS}, ${CANDIDATE_B_ID}=${successCount(candidateB)}/${P11D_HARD_LIMITS.PER_CANDIDATE_REQUESTS})`,
  };
}
