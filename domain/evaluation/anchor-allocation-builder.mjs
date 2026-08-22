// Turn N4.1: pure, dependency-injected builder for the DEV_TUNE Anchor 150
// selection, AUTHOR_A/AUTHOR_B provisional allocation, and the relation
// closure review packet. Like domain/evaluation/candidate-pool-builder.mjs,
// this module never touches the filesystem -- it takes plain records
// (already-read Candidate Pool rows, relation candidate rows, manifest
// rows) and returns plain data, so tests/anchor-allocation-builder.test.mjs
// can exercise it with small synthetic fixtures.
//
// STATUS (same discipline as candidate-pool-builder.mjs): every Anchor here
// is drawn ONLY from Candidate Pool records whose `planned_split` is
// already "DEV_TUNE" (assigned upstream, PROVISIONAL). Nothing in this
// module writes Gold answers, Evidence locators, or relation dispositions
// -- `owner_disposition` on every closure-packet row starts at "PENDING"
// and this module has no code path that ever writes anything else.
// Author allocation is PROVISIONAL_AUTHOR_ALLOCATION and may be revisited
// once chain closure (real relation review) changes which documents share
// a component.
import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function stableSort(items, keyOf, salt) {
  return [...items].sort((a, b) => sha256(`${salt} ${keyOf(a)}`).localeCompare(sha256(`${salt} ${keyOf(b)}`)));
}

// Groups DEV_TUNE-only Candidate Pool records by evaluation_group_id, then
// walks GROUPS (never individual assignments) in stable-hash order,
// including a whole group at a time, stopping as soon as the running total
// enters [targetMin, targetMax] closest to targetIdeal. A single group
// larger than the remaining budget is still included whole (chain-safety
// outranks the numeric target, exactly like selectCandidatePool) -- this is
// reported via `exact target unreachable`, never silently forced.
export function selectAnchorPool({ poolRecords, targetIdeal = 150, targetMin = 145, targetMax = 155, criticalTagFloors = {}, salt = "n4.1-anchor-selection" }) {
  const devTuneOnly = poolRecords.filter((item) => item.planned_split === "DEV_TUNE");
  const byGroup = new Map();
  for (const item of devTuneOnly) {
    const list = byGroup.get(item.evaluation_group_id) ?? [];
    list.push(item);
    byGroup.set(item.evaluation_group_id, list);
  }
  const groupIds = stableSort([...byGroup.keys()], (id) => id, salt);

  // Critical-tag floor pass FIRST (same rationale and smallest-group-first
  // tie-break as candidate-pool-builder.mjs's own selectCandidatePool): at
  // Anchor scale (~150 out of 242 DEV_TUNE candidates) a rare slice like
  // facility_investment can be sampled away entirely by a plain stable-hash
  // walk purely by chance. Tag-keyed only, never company/document-keyed.
  const includedGroupIdSet = new Set();
  const preIncluded = [];
  const preIncludedGroupIds = [];
  const criticalTagShortfalls = {};
  for (const [tag, floor] of Object.entries(criticalTagFloors)) {
    if (floor <= 0) continue;
    const candidateGroupIds = [...groupIds]
      .filter((groupId) => byGroup.get(groupId).some((item) => item.tags.includes(tag)))
      .sort((a, b) => byGroup.get(a).length - byGroup.get(b).length || a.localeCompare(b));
    const toInclude = candidateGroupIds.slice(0, floor);
    for (const groupId of toInclude) {
      if (includedGroupIdSet.has(groupId)) continue;
      includedGroupIdSet.add(groupId);
      preIncluded.push(...byGroup.get(groupId));
      preIncludedGroupIds.push(groupId);
    }
    if (candidateGroupIds.length < floor) criticalTagShortfalls[tag] = { floor, real_groups_available: candidateGroupIds.length };
  }
  const remainingGroupIds = groupIds.filter((id) => !includedGroupIdSet.has(id));

  // Try every prefix-sum stopping point (starting from the floor-guaranteed
  // base) and keep whichever total lands closest to targetIdeal while
  // staying inside [targetMin, targetMax] if any such point exists;
  // otherwise report the closest attainable total honestly instead of
  // forcing an exact 150 by cutting a group.
  let bestSelected = [];
  let bestGroupIds = [];
  let bestDistance = Infinity;
  let running = preIncluded;
  let runningGroupIds = preIncludedGroupIds;
  for (const groupId of remainingGroupIds) {
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
  // No prefix ever landed inside [targetMin, targetMax] (e.g. one group is
  // itself larger than the whole range) -- fall back to whichever single
  // prefix stopping point is numerically closest to targetIdeal, and mark
  // the shortfall explicitly rather than pretending the target was met.
  let exactTargetReachable = bestSelected.length > 0;
  if (!exactTargetReachable) {
    running = preIncluded;
    runningGroupIds = preIncludedGroupIds;
    let closestDistance = Math.abs(running.length - targetIdeal);
    bestSelected = running;
    bestGroupIds = runningGroupIds;
    for (const groupId of remainingGroupIds) {
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
    totalDevTuneGroupsAvailable: groupIds.length,
    totalDevTuneRecordsAvailable: devTuneOnly.length,
    targetIdeal, targetMin, targetMax,
    exactTargetReachable,
    actualCount: bestSelected.length,
    criticalTagShortfalls,
  });
}

// Deterministic 2-way greedy bin-balancing over WHOLE groups (component or
// synthetic coverage group), exactly mirroring assignProvisionalSplits's
// own algorithm (see candidate-pool-builder.mjs) but for AUTHOR_A/AUTHOR_B
// instead of DEV_TUNE/DEV_CHECK/HOLDOUT. Never splits one
// evaluation_group_id across two authors.
export function allocateAuthors({ selected, salt = "n4.1-author-allocation" }) {
  const byGroup = new Map();
  for (const item of selected) {
    const list = byGroup.get(item.evaluation_group_id) ?? [];
    list.push(item);
    byGroup.set(item.evaluation_group_id, list);
  }
  const groupIds = stableSort([...byGroup.keys()], (id) => id, salt);
  const half = selected.length / 2;
  const targets = { AUTHOR_A: half, AUTHOR_B: half };
  const remaining = { ...targets };
  const used = { AUTHOR_A: 0, AUTHOR_B: 0 };
  const allocated = [];
  for (const groupId of groupIds) {
    const members = byGroup.get(groupId);
    const authors = Object.keys(targets);
    const bestAuthor = authors.reduce((best, author) => {
      const ratio = targets[author] > 0 ? remaining[author] / targets[author] : -Infinity;
      const bestRatio = targets[best] > 0 ? remaining[best] / targets[best] : -Infinity;
      return ratio > bestRatio ? author : best;
    }, authors[0]);
    for (const item of members) {
      allocated.push({
        ...item,
        author_allocation: bestAuthor,
        assignment_status: "PROVISIONAL_AUTHOR_ALLOCATION",
        official_gold_status: "NOT_STARTED",
      });
    }
    used[bestAuthor] += members.length;
    remaining[bestAuthor] -= members.length;
  }
  return Object.freeze({ allocated, used, difference: Math.abs(used.AUTHOR_A - used.AUTHOR_B) });
}

// No evaluation_group_id may ever appear under more than one author_allocation.
export function computeAuthorLeakageReport({ allocated }) {
  const violations = [];
  const groupToAuthor = new Map();
  const docToAuthor = new Map();
  for (const item of allocated) {
    const priorAuthor = groupToAuthor.get(item.evaluation_group_id);
    if (priorAuthor !== undefined && priorAuthor !== item.author_allocation) {
      violations.push({ type: "EVALUATION_GROUP_AUTHOR_SPLIT", evaluation_group_id: item.evaluation_group_id, authors: [priorAuthor, item.author_allocation] });
    }
    groupToAuthor.set(item.evaluation_group_id, item.author_allocation);
    for (const doc of item.anchor_document_ids) {
      const priorDocAuthor = docToAuthor.get(doc);
      if (priorDocAuthor !== undefined && priorDocAuthor !== item.author_allocation) {
        violations.push({ type: "DOCUMENT_AUTHOR_SPLIT", document_id: doc, authors: [priorDocAuthor, item.author_allocation] });
      }
      docToAuthor.set(doc, item.author_allocation);
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations, scope: "CURRENT_PROVISIONAL_GRAPH_ONLY" });
}

const BALANCE_TAGS = Object.freeze([
  "same_company_different_period", "cross_company", "correction_chain", "termination",
  "holding_within_report_change", "facility_investment", "investment_judgement",
  "zero_document", "withheld_candidate", "parse_blocked",
]);

export function computeAllocationBalanceReport({ allocated }) {
  const perAuthor = { AUTHOR_A: {}, AUTHOR_B: {} };
  for (const author of ["AUTHOR_A", "AUTHOR_B"]) {
    const items = allocated.filter((item) => item.author_allocation === author);
    perAuthor[author] = {
      total: items.length,
      by_bucket: countBy(items, (item) => item.bucket),
      by_question_type: countBy(items, (item) => item.question_type),
      by_difficulty: countBy(items, (item) => item.difficulty),
      by_slice_tag: Object.fromEntries(BALANCE_TAGS.map((tag) => [tag, items.filter((item) => item.tags.includes(tag)).length])),
    };
  }
  return Object.freeze(perAuthor);
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}

// Every Anchor record (any question_type -- manifest data alone cannot
// confirm 연결/별도, 분기/누계, sign, WITHHELD/NOT_APPLICABLE, or
// planned/confirmed status for ANY record, not just NUMERIC_LOOKUP ones)
// gets an explicit, uniform "not yet confirmed" marker -- never silently
// treated as verified. See candidate-pool-builder.mjs's own
// UNCONFIRMED_SLICE_NAMES (imported by the caller, not duplicated here).
export function markGoldAuthoringReviewNeeded({ allocated, unconfirmedSliceNames }) {
  return allocated.map((item) => ({
    ...item,
    manifest_stage_dimension_status: "NEEDS_GOLD_AUTHORING_REVIEW",
    unconfirmed_dimension_names: [...unconfirmedSliceNames],
  }));
}

// -- Relation closure review packet -----------------------------------
//
// hop0: every relation-candidate ROW (ALL its target candidates, not just
// the top-scored one used for grouping) whose source_document_id is an
// Anchor document, OR whose candidates[].target_document_id is an Anchor
// document (source amends/terminates INTO an Anchor from outside).
// hop1: every relation-candidate row whose source_document_id is a
// document first SEEN in hop0 (as a source or as any candidate target) but
// that was not itself an Anchor document -- "한 단계 인접 후보의 연결
// 후보". This surfaces a document that could pull a currently-unrelated
// chain into an Anchor's component if a reviewer confirms it.
export function buildRelationClosurePacket({ anchorDocumentIds, relationCandidates, docToComponentId, authorByDocumentId, manifestByDocumentId, assignmentIdsByDocumentId }) {
  const anchorSet = new Set(anchorDocumentIds);
  const bySource = new Map();
  for (const row of relationCandidates) {
    const list = bySource.get(row.source_document_id) ?? [];
    list.push(row);
    bySource.set(row.source_document_id, list);
  }
  const byTargetToSources = new Map();
  for (const row of relationCandidates) {
    for (const candidate of row.candidates ?? []) {
      const list = byTargetToSources.get(candidate.target_document_id) ?? [];
      list.push(row);
      byTargetToSources.set(candidate.target_document_id, list);
    }
  }

  const hop0Rows = new Set();
  const hop0TouchedDocs = new Set();
  for (const doc of anchorSet) {
    for (const row of bySource.get(doc) ?? []) { hop0Rows.add(row); }
    for (const row of byTargetToSources.get(doc) ?? []) { hop0Rows.add(row); }
  }
  for (const row of hop0Rows) {
    hop0TouchedDocs.add(row.source_document_id);
    for (const candidate of row.candidates ?? []) hop0TouchedDocs.add(candidate.target_document_id);
  }

  const hop1Rows = new Set();
  for (const doc of hop0TouchedDocs) {
    if (anchorSet.has(doc)) continue; // already covered by hop0's own source scan
    for (const row of bySource.get(doc) ?? []) hop1Rows.add(row);
  }

  const allRows = new Set([...hop0Rows, ...hop1Rows]);
  const docInfo = (docId) => {
    const row = manifestByDocumentId.get(docId);
    return row ? { corp_code: row.corp_code, listed_name: row.listed_name, doc_group: row.doc_group, doc_subtype: row.doc_subtype, report_nm: row.report_nm, rcept_dt: row.rcept_dt, is_correction: row.is_correction } : null;
  };

  const packet = [...allRows].map((row) => {
    const sourceComponentId = docToComponentId.get(row.source_document_id) ?? null;
    const sourceAuthor = authorByDocumentId.get(row.source_document_id) ?? null;
    const candidatesOut = (row.candidates ?? []).map((candidate) => {
      const targetComponentId = docToComponentId.get(candidate.target_document_id) ?? null;
      const targetAuthor = authorByDocumentId.get(candidate.target_document_id) ?? null;
      const isCurrentlyUsedEdge = targetComponentId !== null && targetComponentId === sourceComponentId;
      const wouldMergeComponents = !isCurrentlyUsedEdge && sourceComponentId !== null && targetComponentId !== null && sourceComponentId !== targetComponentId;
      const wouldCrossAuthorBoundary = wouldMergeComponents && sourceAuthor !== null && targetAuthor !== null && sourceAuthor !== targetAuthor;
      return {
        target_document_id: candidate.target_document_id,
        score: candidate.score,
        reasons: candidate.reasons ?? [],
        target_report_name: candidate.target_report_name ?? null,
        target_receipt_date: candidate.target_receipt_date ?? null,
        target_info: docInfo(candidate.target_document_id),
        target_component_id: targetComponentId,
        target_author_allocation: targetAuthor,
        is_currently_used_edge: isCurrentlyUsedEdge,
        would_merge_components: wouldMergeComponents,
        would_cross_author_boundary: wouldCrossAuthorBoundary,
      };
    });
    return Object.freeze({
      relation_candidate_id: row.relation_candidate_id,
      source_document_id: row.source_document_id,
      relation_type: row.relation_type,
      source_report_name: row.source_report_name ?? null,
      source_receipt_date: row.source_receipt_date ?? null,
      source_info: docInfo(row.source_document_id),
      source_component_id: sourceComponentId,
      source_author_allocation: sourceAuthor,
      candidates: candidatesOut,
      affected_anchor_assignment_ids: [
        ...(assignmentIdsByDocumentId.get(row.source_document_id) ?? []),
        ...candidatesOut.flatMap((c) => assignmentIdsByDocumentId.get(c.target_document_id) ?? []),
      ].filter((v, i, arr) => arr.indexOf(v) === i),
      hop: hop0Rows.has(row) ? 0 : 1,
      owner_disposition: "PENDING",
      confirmed_target_document_id: null,
      notes: "",
      reviewer: null,
      reviewed_at: null,
    });
  });
  return Object.freeze({
    packet: stableSort(packet, (row) => row.relation_candidate_id, "n4.1-closure-order"),
    hop0Count: hop0Rows.size,
    hop1Count: hop1Rows.size,
    totalCount: allRows.size,
  });
}
