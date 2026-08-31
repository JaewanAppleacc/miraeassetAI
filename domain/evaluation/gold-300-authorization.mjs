// Turn N4.20.1: separates "the Gold-300 plan (300 candidates, A/B 150/150
// assignment) is approved" from "a specific row may actually be written
// yet". N4.20's v0.1 decision conflated these into a single
// gold_authoring_authorized boolean; this module defines the corrected,
// disjoint authorization-state model and the row-level authoring status
// every one of the 300 rows gets, independent of whether the plan itself
// is approved.
//
// Every field here except gold_300_plan_authorized and
// eligible_authoring_authorized is an UNCONDITIONAL hard invariant: no
// code path in this module, or in any decision this module verifies, can
// ever produce true for blocked_authoring_authorized,
// holdout_agent_access_authorized, holdout_evaluation_authorized,
// production_wiring_authorized, agent_ranking_authorized,
// relation_decisions_authorized, or actual_official_promotion_applied.
export const ROW_AUTHORING_STATUS = Object.freeze({
  ELIGIBLE_DOCUMENT_LOCAL: "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL",
  ELIGIBLE_VERIFIED_RELATION: "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL",
  NEEDS_MANUAL_SOURCE_REVIEW: "MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING",
  BLOCKED_PROVISIONAL_RELATION: "AUTHORING_BLOCKED",
  BLOCKED_PARSE_FAILED: "AUTHORING_BLOCKED",
});

// Maps a row's authoring_eligibility (from gold-300-selection.mjs's
// classifyEligibility) to its authoring status GIVEN that the Owner has
// genuinely approved the plan. Before approval, every row's authoring
// status is simply "PLAN_NOT_YET_APPROVED" regardless of eligibility --
// this function is never called to produce a true authorization pre-
// approval; callers gate on planApproved themselves.
export function rowAuthoringStatus({ authoringEligibility, planApproved }) {
  if (!planApproved) return "PLAN_NOT_YET_APPROVED";
  const status = ROW_AUTHORING_STATUS[authoringEligibility];
  if (!status) throw new Error(`rowAuthoringStatus: unknown authoring_eligibility "${authoringEligibility}"`);
  return status;
}

const ELIGIBILITY_KEYS = Object.freeze([
  "ELIGIBLE_DOCUMENT_LOCAL", "ELIGIBLE_VERIFIED_RELATION", "NEEDS_MANUAL_SOURCE_REVIEW",
  "BLOCKED_PROVISIONAL_RELATION", "BLOCKED_PARSE_FAILED",
]);
const BLOCKED_KEYS = Object.freeze(["BLOCKED_PROVISIONAL_RELATION", "BLOCKED_PARSE_FAILED"]);

// classifiedRows: [{ assignment_id, author_allocation, planned_split, gold_pool_role, authoring_eligibility }]
// Splits into per-author (AUTHOR_A/AUTHOR_B) distributions across
// eligibility category, planned_split, and gold_pool_role, then verifies
// the two authors' counts sum to the exact combined totals -- callers
// must abort (never silently proceed) if this check ever fails.
export function summarizeEligibilityByAuthor(classifiedRows) {
  const perAuthor = { AUTHOR_A: emptyBucket(), AUTHOR_B: emptyBucket() };
  for (const row of classifiedRows) {
    const bucket = perAuthor[row.author_allocation];
    if (!bucket) throw new Error(`summarizeEligibilityByAuthor: unknown author_allocation "${row.author_allocation}" on ${row.assignment_id}`);
    bucket.total += 1;
    bucket.eligibility_distribution[row.authoring_eligibility] += 1;
    bucket.split_counts[row.planned_split] += 1;
    bucket.pool_role_counts[row.gold_pool_role] += 1;
    if (ELIGIBILITY_KEYS.includes(row.authoring_eligibility) && !BLOCKED_KEYS.includes(row.authoring_eligibility)) {
      if (row.authoring_eligibility === "NEEDS_MANUAL_SOURCE_REVIEW") bucket.manual_review_count += 1;
      else bucket.eligible_count += 1;
    } else {
      bucket.blocked_count += 1;
    }
  }

  const combined = emptyBucket();
  for (const bucket of Object.values(perAuthor)) {
    combined.total += bucket.total;
    combined.eligible_count += bucket.eligible_count;
    combined.manual_review_count += bucket.manual_review_count;
    combined.blocked_count += bucket.blocked_count;
    for (const key of ELIGIBILITY_KEYS) combined.eligibility_distribution[key] += bucket.eligibility_distribution[key];
    for (const key of ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"]) combined.split_counts[key] += bucket.split_counts[key];
    for (const key of ["EXISTING_ANCHOR", "EXPANSION"]) combined.pool_role_counts[key] += bucket.pool_role_counts[key];
  }

  return Object.freeze({ perAuthor: Object.freeze(perAuthor), combined: Object.freeze(combined) });
}

function emptyBucket() {
  return {
    total: 0, eligible_count: 0, manual_review_count: 0, blocked_count: 0,
    eligibility_distribution: Object.fromEntries(ELIGIBILITY_KEYS.map((k) => [k, 0])),
    split_counts: { DEV_TUNE: 0, DEV_CHECK: 0, HOLDOUT: 0 },
    pool_role_counts: { EXISTING_ANCHOR: 0, EXPANSION: 0 },
  };
}

// Verifies that a per-author summary's two authors sum exactly to the
// independently-recomputed combined total passed in as `expectedCombined`
// (e.g. the N4.20 gate-status/eligibility-report's own live-recomputed
// numbers) -- never trusts the summary's own internal combined figure
// alone, since a bug in the split (not the totals) could otherwise hide.
export function verifyAuthorSplitMatchesTotal({ summary, expectedCombined }) {
  const violations = [];
  if (summary.combined.total !== expectedCombined.total) violations.push({ type: "TOTAL_MISMATCH", field: "total", expected: expectedCombined.total, actual: summary.combined.total });
  if (summary.combined.eligible_count + summary.combined.manual_review_count !== expectedCombined.eligible_count) {
    violations.push({ type: "ELIGIBLE_COUNT_MISMATCH", expected: expectedCombined.eligible_count, actual: summary.combined.eligible_count + summary.combined.manual_review_count });
  }
  if (summary.combined.blocked_count !== expectedCombined.blocked_count) {
    violations.push({ type: "BLOCKED_COUNT_MISMATCH", expected: expectedCombined.blocked_count, actual: summary.combined.blocked_count });
  }
  return Object.freeze({ ok: violations.length === 0, violations });
}

export const REQUIRED_DECISION_FIELDS_V02 = Object.freeze([
  "schema_version", "decision_id", "decided_at", "owner", "owner_disposition", "owner_note", "checklist",
  "total_plan_count", "author_a_assigned_count", "author_b_assigned_count",
  "immediately_authorizable_count", "manual_review_required_count", "blocked_count",
  "author_a_immediately_authorizable_count", "author_b_immediately_authorizable_count",
  "author_a_blocked_count", "author_b_blocked_count",
  "gold_300_plan_authorized", "eligible_authoring_authorized", "blocked_authoring_authorized",
  "holdout_authoring_authorized", "holdout_agent_access_authorized", "holdout_evaluation_authorized",
  "production_wiring_authorized", "agent_ranking_authorized", "relation_decisions_authorized",
  "actual_official_promotion_applied",
]);

const APPROVE_DISPOSITION_V02 = "APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING";
const ALLOWED_DISPOSITIONS_V02 = new Set([APPROVE_DISPOSITION_V02, "FIX_REQUIRED", "REJECT_GOLD_300_PLAN"]);

// Independently re-verifies a v0.2 decision record against live-
// recomputed expected counts. Mirrors official-split-approval.mjs's
// verifyOfficialSplitApprovalDecision in spirit: gold_300_plan_authorized
// and eligible_authoring_authorized are CONDITIONAL (true iff a genuine,
// fully-checklisted APPROVE), every other field is an unconditional hard
// invariant checked to be exactly false regardless of disposition.
export function verifyGold300PlanDecisionV02({ decision, expected }) {
  const violations = [];
  for (const field of REQUIRED_DECISION_FIELDS_V02) {
    if (!Object.prototype.hasOwnProperty.call(decision ?? {}, field)) violations.push({ type: "MISSING_FIELD", field });
  }
  if (violations.length > 0) return Object.freeze({ ok: false, violations });

  if (typeof decision.decision_id !== "string" || decision.decision_id.trim().length === 0) violations.push({ type: "EMPTY_DECISION_ID" });
  if (typeof decision.owner !== "string" || decision.owner.trim().length === 0) violations.push({ type: "EMPTY_OWNER" });
  if (Number.isNaN(Date.parse(decision.decided_at))) violations.push({ type: "INVALID_DECIDED_AT" });
  if (!ALLOWED_DISPOSITIONS_V02.has(decision.owner_disposition)) violations.push({ type: "DISALLOWED_OWNER_DISPOSITION", value: decision.owner_disposition });
  const requiresNote = decision.owner_disposition === "FIX_REQUIRED" || decision.owner_disposition === "REJECT_GOLD_300_PLAN";
  const hasNote = typeof decision.owner_note === "string" && decision.owner_note.trim().length > 0;
  if (requiresNote && !hasNote) violations.push({ type: "MISSING_REQUIRED_OWNER_NOTE" });

  for (const key of [
    "total_plan_count", "author_a_assigned_count", "author_b_assigned_count",
    "immediately_authorizable_count", "manual_review_required_count", "blocked_count",
    "author_a_immediately_authorizable_count", "author_b_immediately_authorizable_count",
    "author_a_blocked_count", "author_b_blocked_count",
  ]) {
    if (decision[key] !== expected[key]) violations.push({ type: "COUNT_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }

  // Unconditional hard invariants -- never true regardless of disposition.
  if (decision.blocked_authoring_authorized !== false) violations.push({ type: "BLOCKED_AUTHORING_AUTHORIZED_NOT_FALSE" });
  if (decision.holdout_agent_access_authorized !== false) violations.push({ type: "HOLDOUT_AGENT_ACCESS_AUTHORIZED_NOT_FALSE" });
  if (decision.holdout_evaluation_authorized !== false) violations.push({ type: "HOLDOUT_EVALUATION_AUTHORIZED_NOT_FALSE" });
  if (decision.production_wiring_authorized !== false) violations.push({ type: "PRODUCTION_WIRING_AUTHORIZED_NOT_FALSE" });
  if (decision.agent_ranking_authorized !== false) violations.push({ type: "AGENT_RANKING_AUTHORIZED_NOT_FALSE" });
  if (decision.relation_decisions_authorized !== false) violations.push({ type: "RELATION_DECISIONS_AUTHORIZED_NOT_FALSE" });
  if (decision.actual_official_promotion_applied !== false) violations.push({ type: "ACTUAL_OFFICIAL_PROMOTION_APPLIED_NOT_FALSE" });

  // gold_300_plan_authorized / eligible_authoring_authorized /
  // holdout_authoring_authorized are CONDITIONAL: true iff this is a
  // genuine, fully-checklisted APPROVE, false otherwise.
  const checklist = Array.isArray(decision.checklist) ? decision.checklist : [];
  const checklistFullyChecked = checklist.length > 0 && checklist.every((c) => c && c.checked === true);
  const isGenuineApproval = decision.owner_disposition === APPROVE_DISPOSITION_V02 && checklistFullyChecked;
  for (const field of ["gold_300_plan_authorized", "eligible_authoring_authorized", "holdout_authoring_authorized"]) {
    if (decision[field] !== isGenuineApproval) {
      violations.push({ type: "CONDITIONAL_FIELD_INCONSISTENT", field, expected: isGenuineApproval, actual: decision[field] });
    }
  }

  return Object.freeze({ ok: violations.length === 0, violations, is_genuine_approval: isGenuineApproval });
}
