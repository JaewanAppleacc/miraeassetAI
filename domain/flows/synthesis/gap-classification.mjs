// Deterministically derives ONE top-level classification from a
// sub_request's `missing_reasons` (see sub-request-coverage-v2.mjs).
// This is the ONLY place that decides "is this a Runtime rendering gap,
// a real absence of VERIFIED data, a Plan authoring problem, or a policy
// question a human must answer" -- it is a pure function of reason codes,
// never of question_id/company/intent literals, and it fails CLOSED
// toward the human-review category whenever a reason code's true cause
// is ambiguous, rather than guessing STRUCTURED_DATA_GAP.
export const GAP_CLASSIFICATIONS = Object.freeze([
  "SATISFIABLE",
  "IMPLEMENTATION_GAP",
  "STRUCTURED_DATA_GAP",
  "PLAN_AUTHORING_REVIEW_REQUIRED",
  "OWNER_POLICY_DECISION_REQUIRED",
]);

// Unambiguous: the required VERIFIED source (a Fact or a minimum count of
// Events) genuinely does not exist -- no amount of Runtime rendering work
// can fix this without new corpus data.
//
// PLAN_REQUIREMENT_POLICY_CONFLICT joined this bucket after
// work/domain-seed/seed-timeline-fact-narrative-policy-decision.v0.1.json
// (Owner APPROVED, generic -- not scoped to any question_id): a
// VERIFIED Fact's timeline narrative may be used as synthesis material,
// but never counts toward minimum_event_count satisfaction and is never
// reclassified as a VERIFIED Event -- so a TRACE_TIMELINE sub_request
// that is genuinely Event-short is a real STRUCTURED_DATA_GAP regardless
// of whether a Fact-encoded narrative alternative also exists. This is a
// classification-only change: sub-request-coverage-v2.mjs's DETECTION of
// the signal is unchanged (still generic, still fires only on the
// INSUFFICIENT_VERIFIED_EVENTS + same-slot-NARRATIVE-claim pattern), and
// the render path (Fact narrative still shown, event-count caveat still
// shown) is unchanged too -- only what this ONE function returns for it
// has changed, per the now-settled policy.
const STRUCTURED_DATA_GAP_CODES = new Set(["REQUIRED_FACT_NOT_RESOLVED", "INSUFFICIENT_VERIFIED_EVENTS", "PLAN_REQUIREMENT_POLICY_CONFLICT"]);

// Unambiguous: the required VERIFIED source (or calculation result)
// DEMONSTRABLY exists, but nothing rendered/claimed it -- a pure Runtime
// fix, no new data or Owner decision needed.
const IMPLEMENTATION_GAP_CODES = new Set(["FACT_RESOLVED_BUT_NO_CLAIM", "OUTPUT_KIND_NOT_RENDERED", "CALCULATION_PRODUCED_BUT_NO_CLAIM", "VERIFIED_EVENT_NOT_RENDERED"]);

// Ambiguous by construction -- each of these codes can stem from a real
// data gap, a Runtime implementation gap, OR the Plan having required
// something that was never achievable/correct for this question. Never
// auto-resolved; always routed to human review.
const AMBIGUOUS_CODES = new Set(["CALCULATION_VALUE_NOT_PRODUCED", "REQUIRED_CAPABILITY_NOT_APPLIED", "REQUIRED_CAPABILITY_NOT_IMPLEMENTED"]);

export function classifyMissingReasons(missingReasons) {
  if (!Array.isArray(missingReasons) || missingReasons.length === 0) return "SATISFIABLE";
  const codes = new Set(missingReasons.map((r) => r.reason_code));
  const codeList = [...codes];
  const allStructured = codeList.every((c) => STRUCTURED_DATA_GAP_CODES.has(c));
  if (allStructured) return "STRUCTURED_DATA_GAP";

  const allImplementation = codeList.every((c) => IMPLEMENTATION_GAP_CODES.has(c));
  if (allImplementation) return "IMPLEMENTATION_GAP";

  // Any ambiguous code present, or a MIX of structured+implementation
  // codes (meaning some parts are data gaps and others are rendering
  // gaps, which itself needs a human to weigh) -- fail closed to review,
  // never guessed toward STRUCTURED_DATA_GAP.
  void AMBIGUOUS_CODES; // referenced for documentation; membership isn't special-cased further -- anything not cleanly ALL-structured or ALL-implementation lands here.
  return "PLAN_AUTHORING_REVIEW_REQUIRED";
}
