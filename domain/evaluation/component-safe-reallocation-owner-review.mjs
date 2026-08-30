// Turn N4.14: pure aggregation functions for the Component-Safe Strategy A
// Owner review -- summarizing Turn N4.13's already-computed
// strategy-a-assignment-delta.v0.1.jsonl (70 operations) into the exact
// numbers an Owner needs to make an informed APPROVE/FIX_REQUIRED/
// REJECT_PLAN decision. This module never recomputes a NEW plan and never
// changes any move -- it only counts, groups, and cross-references what
// Turn N4.13 already produced.
//
// Explicitly does NOT assume operations == unique assignments: an
// assignment_id can appear in both the split-dimension and author-dimension
// delta (an "overlap"), and this module computes that overlap directly from
// the data rather than assuming 0 or 70.
export function computeMovementSummary({ deltaRows }) {
  const splitRows = deltaRows.filter((r) => r.dimension === "split");
  const authorRows = deltaRows.filter((r) => r.dimension === "author");
  const splitIds = new Set(splitRows.map((r) => r.assignment_id));
  const authorIds = new Set(authorRows.map((r) => r.assignment_id));
  const overlapIds = [...splitIds].filter((id) => authorIds.has(id));
  const uniqueTotalIds = new Set([...splitIds, ...authorIds]);

  function transitionCounts(rows) {
    const counts = new Map();
    for (const r of rows) {
      const key = `${r.from}->${r.to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort());
  }
  function reasonCounts(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    return Object.fromEntries([...counts.entries()].sort());
  }

  const componentMap = new Map();
  for (const r of deltaRows) {
    const entry = componentMap.get(r.component_id) ?? { component_id: r.component_id, split_count: 0, author_count: 0, reasons: new Set() };
    if (r.dimension === "split") entry.split_count += 1;
    else if (r.dimension === "author") entry.author_count += 1;
    entry.reasons.add(r.reason);
    componentMap.set(r.component_id, entry);
  }
  const componentMovementSummary = [...componentMap.values()]
    .map((e) => ({ component_id: e.component_id, split_count: e.split_count, author_count: e.author_count, total_count: e.split_count + e.author_count, reasons: [...e.reasons].sort() }))
    .sort((a, b) => a.component_id.localeCompare(b.component_id));

  return Object.freeze({
    split_operation_count: splitRows.length,
    author_operation_count: authorRows.length,
    unique_split_assignment_ids: [...splitIds].sort(),
    unique_author_assignment_ids: [...authorIds].sort(),
    overlapping_assignment_ids: overlapIds.sort(),
    overlap_count: overlapIds.length,
    unique_changed_assignment_count: uniqueTotalIds.size,
    split_transition_counts: transitionCounts(splitRows),
    author_transition_counts: transitionCounts(authorRows),
    split_reason_counts: reasonCounts(splitRows),
    author_reason_counts: reasonCounts(authorRows),
    component_movement_summary: componentMovementSummary,
    distinct_component_count: componentMap.size,
  });
}

const REQUIRED_DECISION_FIELDS = [
  "schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note",
  "plan_path", "plan_sha256", "delta_path", "delta_sha256", "verification_report_path", "verification_report_sha256",
  "anchor_count", "candidate_pool_count", "split_operation_count", "author_operation_count",
  "unique_changed_assignment_count", "overlapping_assignment_count",
  "before_split_counts", "after_split_counts", "before_author_counts", "after_author_counts",
  "before_split_leakage", "after_split_leakage", "before_author_leakage", "after_author_leakage",
  "quarantine_intrusion_count", "anchor_membership_changed", "relation_decisions_authorized",
  "official_split_eligible", "gold_authoring_authorized", "checklist",
];
const ALLOWED_DISPOSITIONS = new Set(["APPROVE_COMPONENT_SAFE_REALLOCATION", "FIX_REQUIRED", "REJECT_PLAN"]);

// Verifies an already-downloaded Owner decision record against the live
// (recomputed) numbers. Mirrors the verification discipline established in
// Turn N4.12's relation-closure-owner-ratification.mjs -- hard invariants
// (anchor_membership_changed/relation_decisions_authorized/
// official_split_eligible/gold_authoring_authorized) are checked
// unconditionally, never trusted from the decision itself.
export function verifyOwnerReviewDecision({ decision, expected }) {
  const violations = [];
  for (const field of REQUIRED_DECISION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(decision ?? {}, field)) violations.push({ type: "MISSING_FIELD", field });
  }
  if (violations.length > 0) return Object.freeze({ ok: false, violations });

  if (typeof decision.decision_id !== "string" || decision.decision_id.trim().length === 0) violations.push({ type: "EMPTY_DECISION_ID" });
  if (typeof decision.owner !== "string" || decision.owner.trim().length === 0) violations.push({ type: "EMPTY_OWNER" });
  if (Number.isNaN(Date.parse(decision.decided_at))) violations.push({ type: "INVALID_DECIDED_AT" });
  if (!ALLOWED_DISPOSITIONS.has(decision.owner_disposition)) violations.push({ type: "DISALLOWED_OWNER_DISPOSITION", value: decision.owner_disposition });
  const requiresNote = decision.owner_disposition === "FIX_REQUIRED" || decision.owner_disposition === "REJECT_PLAN";
  const hasNote = typeof decision.owner_note === "string" && decision.owner_note.trim().length > 0;
  if (requiresNote && !hasNote) violations.push({ type: "MISSING_REQUIRED_OWNER_NOTE" });

  for (const key of ["plan_sha256", "delta_sha256", "verification_report_sha256"]) {
    if (decision[key] !== expected[key]) violations.push({ type: "SHA_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }
  for (const key of ["anchor_count", "candidate_pool_count", "split_operation_count", "author_operation_count", "unique_changed_assignment_count", "overlapping_assignment_count", "quarantine_intrusion_count"]) {
    if (decision[key] !== expected[key]) violations.push({ type: "COUNT_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }
  if (decision.anchor_membership_changed !== false) violations.push({ type: "ANCHOR_MEMBERSHIP_CHANGED_NOT_FALSE" });
  if (decision.relation_decisions_authorized !== false) violations.push({ type: "RELATION_DECISIONS_AUTHORIZED_NOT_FALSE" });
  if (decision.official_split_eligible !== false) violations.push({ type: "OFFICIAL_SPLIT_ELIGIBLE_NOT_FALSE" });
  if (decision.gold_authoring_authorized !== false) violations.push({ type: "GOLD_AUTHORING_AUTHORIZED_NOT_FALSE" });

  return Object.freeze({ ok: violations.length === 0, violations });
}

export { REQUIRED_DECISION_FIELDS };
