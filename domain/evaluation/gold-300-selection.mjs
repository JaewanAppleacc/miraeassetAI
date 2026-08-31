// Turn N4.20 (corrected): pure, dependency-injected functions for
// selecting the additional 150 "Expansion" Gold-300 candidates (on top of
// the existing, already-approved Anchor 150) and classifying every one of
// the 300 final Gold candidates by real-data authoring eligibility.
//
// This module never touches the filesystem and never writes a Gold
// question, answer, or evidence locator -- it only selects WHICH already-
// existing Candidate Pool rows become part of the 300, assigns them to
// AUTHOR_A/AUTHOR_B, and classifies whether each one is safe to start
// writing yet. Like anchor-allocation-builder.mjs, every group
// (evaluation_group_id === chain_component_id) is treated as an atomic
// unit -- never split across the two authors.
import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function stableSort(items, keyOf, salt) {
  return [...items].sort((a, b) => sha256(`${salt} ${keyOf(a)}`).localeCompare(sha256(`${salt} ${keyOf(b)}`)));
}

// Mirrors anchor-allocation-builder.mjs's selectAnchorPool algorithm
// (group-atomic, stable-hash order, prefix-sum closest to targetIdeal
// inside [targetMin, targetMax]) but generalized to any planned_split
// value and to excluding an already-selected set of assignment_ids (the
// existing Anchor 150), rather than being hardcoded to DEV_TUNE. Never
// modifies anchor-allocation-builder.mjs itself -- that file is
// already-approved, already-tested code for a different, frozen purpose
// (the original Anchor 150 selection).
export function selectExpansionPool({ poolRecords, excludeAssignmentIds, plannedSplit, targetIdeal, targetMin, targetMax, salt }) {
  const excludeSet = new Set(excludeAssignmentIds);
  const eligiblePool = poolRecords.filter((item) => item.planned_split === plannedSplit && !excludeSet.has(item.assignment_id));
  const byGroup = new Map();
  for (const item of eligiblePool) {
    const list = byGroup.get(item.evaluation_group_id) ?? [];
    list.push(item);
    byGroup.set(item.evaluation_group_id, list);
  }
  const groupIds = stableSort([...byGroup.keys()], (id) => id, salt);

  let bestSelected = [];
  let bestGroupIds = [];
  let bestDistance = Infinity;
  let running = [];
  let runningGroupIds = [];
  for (const groupId of groupIds) {
    const members = byGroup.get(groupId);
    running = [...running, ...members];
    runningGroupIds = [...runningGroupIds, groupId];
    const distance = Math.abs(running.length - targetIdeal);
    const inRange = running.length >= targetMin && running.length <= targetMax;
    if (inRange && distance < bestDistance) {
      bestDistance = distance;
      bestSelected = running;
      bestGroupIds = runningGroupIds;
    }
    if (running.length >= targetMax) break;
  }
  let exactTargetReachable = bestSelected.length > 0;
  if (!exactTargetReachable) {
    running = [];
    runningGroupIds = [];
    let closestDistance = Infinity;
    for (const groupId of groupIds) {
      const members = byGroup.get(groupId);
      running = [...running, ...members];
      runningGroupIds = [...runningGroupIds, groupId];
      const distance = Math.abs(running.length - targetIdeal);
      if (distance < closestDistance) {
        closestDistance = distance;
        bestSelected = running;
        bestGroupIds = runningGroupIds;
      }
    }
  }

  return Object.freeze({
    selected: bestSelected,
    includedGroupIds: bestGroupIds,
    plannedSplit,
    totalGroupsAvailable: groupIds.length,
    totalRecordsAvailable: eligiblePool.length,
    targetIdeal, targetMin, targetMax,
    exactTargetReachable,
    actualCount: bestSelected.length,
  });
}

// Document-level parse coverage lookup, keyed by document_id -> the real
// parse-audit `coverage_state` value (PRESENT / PARTIAL_PARSE_FAILURE /
// PARSE_FAILED). Returns "UNKNOWN" for a document this repo's parse audit
// never declared -- treated as needing manual review, never silently
// assumed clean.
export function buildParseCoverageIndex(parseAuditRows) {
  const index = new Map();
  for (const row of parseAuditRows) index.set(row.document_id, row.coverage_state);
  return index;
}

// Chain-component relation status, keyed by chain_component_id -> whether
// every real relation-candidate ledger row touching that component has
// already been reviewed (final_disposition CONFIRM/REJECT/NEEDS_MORE_REVIEW,
// review_status REVIEWED), is still provisional (ANY row
// review_status===PROVISIONAL_NOT_ESCALATED), or has NO tracked candidate
// relation row at all (the component was never flagged as ambiguous by
// the relation-candidate scan, regardless of a blanket
// RELATION_CHAIN_CLOSURE dependency tag on the assignment).
export function buildRelationComponentStatusIndex(ledgerRows) {
  const byComponent = new Map();
  for (const row of ledgerRows) {
    const list = byComponent.get(row.affected_component) ?? [];
    list.push(row);
    byComponent.set(row.affected_component, list);
  }
  const index = new Map();
  for (const [componentId, rows] of byComponent) {
    const anyProvisional = rows.some((r) => r.review_status === "PROVISIONAL_NOT_ESCALATED");
    index.set(componentId, anyProvisional ? "PROVISIONAL" : "SETTLED");
  }
  return index;
}

export const ELIGIBILITY = Object.freeze({
  ELIGIBLE_DOCUMENT_LOCAL: "ELIGIBLE_DOCUMENT_LOCAL",
  ELIGIBLE_VERIFIED_RELATION: "ELIGIBLE_VERIFIED_RELATION",
  BLOCKED_PROVISIONAL_RELATION: "BLOCKED_PROVISIONAL_RELATION",
  BLOCKED_PARSE_FAILED: "BLOCKED_PARSE_FAILED",
  NEEDS_MANUAL_SOURCE_REVIEW: "NEEDS_MANUAL_SOURCE_REVIEW",
});

// Classifies ONE assignment record. Precedence (worst-first, never
// silently overridden by a better-looking signal elsewhere on the same
// record): a genuinely unparseable required document always blocks,
// ahead of relation status; a still-provisional relation the record
// actually depends on blocks next; a merely-partial (fallback-tier) parse
// needs a human to look at the real source before anyone starts; only
// then does an item become eligible, either because it never depended on
// a tracked candidate relation at all, or because the relation it did
// depend on is already fully settled (confirmed OR rejected -- a
// rejection is itself a real, evidence-backed fact, not an unresolved
// state).
export function classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex }) {
  const docStates = record.anchor_document_ids.map((docId) => parseCoverageIndex.get(docId) ?? "UNKNOWN");
  if (docStates.includes("PARSE_FAILED")) {
    return { status: ELIGIBILITY.BLOCKED_PARSE_FAILED, blocked_reason: `required document has coverage_state PARSE_FAILED: ${record.anchor_document_ids.filter((d) => parseCoverageIndex.get(d) === "PARSE_FAILED").join(", ")}` };
  }

  const relationStatus = relationComponentStatusIndex.get(record.chain_component_id) ?? null;
  if (relationStatus === "PROVISIONAL") {
    return { status: ELIGIBILITY.BLOCKED_PROVISIONAL_RELATION, blocked_reason: `chain_component_id ${record.chain_component_id} still has an unreviewed relation candidate in the 326-row ledger (review_status=PROVISIONAL_NOT_ESCALATED)` };
  }

  if (docStates.includes("PARTIAL_PARSE_FAILURE") || docStates.includes("UNKNOWN")) {
    const flagged = record.anchor_document_ids.filter((d) => {
      const s = parseCoverageIndex.get(d);
      return s === "PARTIAL_PARSE_FAILURE" || s === undefined;
    });
    return { status: ELIGIBILITY.NEEDS_MANUAL_SOURCE_REVIEW, blocked_reason: `required document has limited/uncertain parse coverage, needs manual source check: ${flagged.join(", ")}` };
  }

  if (relationStatus === "SETTLED") {
    return { status: ELIGIBILITY.ELIGIBLE_VERIFIED_RELATION, blocked_reason: null };
  }
  return { status: ELIGIBILITY.ELIGIBLE_DOCUMENT_LOCAL, blocked_reason: null };
}

export function summarizeEligibility(classified) {
  const counts = {};
  for (const value of Object.values(ELIGIBILITY)) counts[value] = 0;
  for (const item of classified) counts[item.authoring_eligibility] += 1;
  return counts;
}
