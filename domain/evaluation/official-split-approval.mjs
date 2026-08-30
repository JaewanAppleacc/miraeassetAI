// Turn N4.17: pure verification for the FINAL official-split approval
// decision over Turn N4.16's v0.3 candidate assignment. Unlike every prior
// Owner decision in this Component-Safe Reallocation chain (N4.12/N4.14/
// N4.15), THIS decision's whole purpose is to grant official_split_eligible
// -- so, unique among this family, official_split_eligible is not an
// always-false hard invariant here. It must instead be EXACTLY true when
// owner_disposition is the APPROVE disposition AND every checklist item is
// checked, and false in every other case. gold_authoring_authorized,
// relation_decisions_authorized, actual_official_promotion_applied, and
// anchor_membership_changed remain unconditional hard invariants: this
// decision alone never authorizes Gold authoring, never authorizes any of
// the 281 provisional relation decisions, never itself cuts a real
// Runtime/PostgreSQL/v0.20 release over to v0.3, and never changes Anchor
// membership.
export const REQUIRED_DECISION_FIELDS = [
  "schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note",
  "v03_manifest_path", "v03_manifest_sha256",
  "v03_pool_path", "v03_pool_sha256", "v03_anchor_path", "v03_anchor_sha256", "v03_author_path", "v03_author_sha256",
  "anchor_count", "candidate_pool_count", "author_count",
  "split_counts", "author_counts",
  "split_leakage_after", "author_leakage_after", "quarantine_intrusion_after",
  "critical_slice_floors_preserved", "anchor_membership_unchanged",
  "anchor_membership_changed", "relation_decisions_authorized",
  "official_split_eligible", "gold_authoring_authorized", "actual_official_promotion_applied",
  "remaining_281_provisional_untouched", "checklist",
];

const ALLOWED_DISPOSITIONS = new Set(["APPROVE_OFFICIAL_SPLIT_V0.3", "FIX_REQUIRED", "REJECT_PLAN"]);
const APPROVE_DISPOSITION = "APPROVE_OFFICIAL_SPLIT_V0.3";

export function verifyOfficialSplitApprovalDecision({ decision, expected }) {
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

  for (const key of ["v03_manifest_sha256", "v03_pool_sha256", "v03_anchor_sha256", "v03_author_sha256"]) {
    if (decision[key] !== expected[key]) violations.push({ type: "SHA_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }
  for (const key of ["anchor_count", "candidate_pool_count", "author_count", "split_leakage_after", "author_leakage_after", "quarantine_intrusion_after"]) {
    if (decision[key] !== expected[key]) violations.push({ type: "COUNT_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }
  for (const key of ["split_counts", "author_counts"]) {
    if (JSON.stringify(decision[key]) !== JSON.stringify(expected[key])) violations.push({ type: "STRUCTURAL_MISMATCH", field: key, expected: expected[key], actual: decision[key] });
  }
  if (decision.critical_slice_floors_preserved !== true) violations.push({ type: "CRITICAL_SLICE_FLOORS_NOT_PRESERVED" });
  if (decision.anchor_membership_unchanged !== true) violations.push({ type: "ANCHOR_MEMBERSHIP_NOT_UNCHANGED" });

  // Unconditional hard invariants -- never true regardless of disposition.
  if (decision.anchor_membership_changed !== false) violations.push({ type: "ANCHOR_MEMBERSHIP_CHANGED_NOT_FALSE" });
  if (decision.relation_decisions_authorized !== false) violations.push({ type: "RELATION_DECISIONS_AUTHORIZED_NOT_FALSE" });
  if (decision.gold_authoring_authorized !== false) violations.push({ type: "GOLD_AUTHORING_AUTHORIZED_NOT_FALSE" });
  if (decision.actual_official_promotion_applied !== false) violations.push({ type: "ACTUAL_OFFICIAL_PROMOTION_APPLIED_NOT_FALSE" });
  if (decision.remaining_281_provisional_untouched !== true) violations.push({ type: "REMAINING_281_PROVISIONAL_UNTOUCHED_NOT_TRUE" });

  // official_split_eligible is CONDITIONAL, not unconditionally false: it
  // must be true iff this is a genuine, fully-checklisted APPROVE decision,
  // and false in every other case (PENDING, FIX_REQUIRED, REJECT_PLAN, or an
  // APPROVE with an incomplete checklist).
  const checklist = Array.isArray(decision.checklist) ? decision.checklist : [];
  const checklistFullyChecked = checklist.length > 0 && checklist.every((c) => c && c.checked === true);
  const isGenuineApproval = decision.owner_disposition === APPROVE_DISPOSITION && checklistFullyChecked;
  const expectedOfficialSplitEligible = isGenuineApproval;
  if (decision.official_split_eligible !== expectedOfficialSplitEligible) {
    violations.push({
      type: "OFFICIAL_SPLIT_ELIGIBLE_INCONSISTENT",
      expected: expectedOfficialSplitEligible,
      actual: decision.official_split_eligible,
      reason: isGenuineApproval
        ? "owner_disposition is APPROVE_OFFICIAL_SPLIT_V0.3 with a fully-checked checklist -- official_split_eligible must be true"
        : "owner_disposition is not a fully-checklisted APPROVE_OFFICIAL_SPLIT_V0.3 -- official_split_eligible must be false",
    });
  }

  return Object.freeze({ ok: violations.length === 0, violations, is_genuine_approval: isGenuineApproval });
}
