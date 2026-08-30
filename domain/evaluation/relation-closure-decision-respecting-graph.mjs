// Turn N4.9: DECISION-RESPECTING conservative graph -- unlike Turn N4.8's
// EXTREME maximal graph (domain/evaluation/relation-closure-maximal-graph.mjs
// -- every one of the 326-row packet's candidates, including the 8 Owner
// REJECT rows and the 1 QUARANTINED_UNRESOLVED row, unioned as worst-case),
// this module respects every decision already made:
//
//   OWNER_V03 + CONFIRM        -> exactly ONE edge (the confirmed target only)
//   OWNER_V03 + REJECT         -> ZERO edges (never re-included as plausible)
//   DUAL_REVIEW_C_D + CONFIRM  -> exactly ONE edge (the agreed target only)
//   QUARANTINED_UNRESOLVED     -> ZERO edges (the existing 50-doc quarantine
//                                  boundary from Turn N4.7 already covers this
//                                  row's own candidates -- see
//                                  quarantine-manifest.v0.2.json's
//                                  all_plausible_candidate_target_documents,
//                                  which is a strict subset of
//                                  quarantine_document_ids)
//   REVIEWER_CONSENSUS_PROVISIONAL (294 rows) -> EVERY listed candidate
//                                  target, still worst-case-plausible, still
//                                  NEVER a confirmed fact
//
// This module never writes a confirmed_target_document_id or a final
// disposition for any REVIEWER_CONSENSUS_PROVISIONAL row, never re-activates
// an Owner REJECT candidate, and never promotes anything to the official
// Relation/Fact/Evidence store. It is pure and filesystem-free, exactly like
// its N4.8 sibling, so it can be exercised with synthetic fixtures.
import { createHash } from "node:crypto";

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = x;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

// Which candidates (if any) a single packet row contributes as edges, given
// its ledger disposition. Returns [] for OWNER_V03+REJECT, for
// QUARANTINED_UNRESOLVED, and for any NEEDS_MORE_REVIEW/unexpected shape --
// fail-safe-empty, never a guessed edge.
export function selectDecisionRespectingCandidates({ packetRow, ledgerRow }) {
  if (!ledgerRow) return [];
  const { decision_authority: authority, final_disposition: disposition, confirmed_target_document_id: confirmedTarget } = ledgerRow;
  if ((authority === "OWNER_V03" || authority === "DUAL_REVIEW_C_D") && disposition === "CONFIRM") {
    const match = (packetRow.candidates ?? []).find((c) => c.target_document_id === confirmedTarget);
    return match ? [match] : [];
  }
  if (authority === "REVIEWER_CONSENSUS_PROVISIONAL") {
    return packetRow.candidates ?? [];
  }
  // OWNER_V03+REJECT, QUARANTINED_UNRESOLVED, OWNER_V03+NEEDS_MORE_REVIEW
  // (should not occur separately from QUARANTINED_UNRESOLVED, but fail-safe
  // to zero edges regardless): contribute nothing.
  return [];
}

// packetRows: the 326-row packet. ledgerRows: relation-closure-candidate-
// ledger.v0.2.jsonl (326 rows). excludeRelationCandidateIds: an optional set
// of relation_candidate_id values whose contribution is dropped entirely --
// used by the "individually decisive" cohort test to rebuild the graph
// without one specific provisional row's edges.
export function buildDecisionRespectingGraph({ packetRows, ledgerRows, excludeRelationCandidateIds = new Set() }) {
  const ledgerById = new Map(ledgerRows.map((r) => [r.relation_candidate_id, r]));
  const uf = new UnionFind();
  const touchedBaseComponents = new Set();
  const rawEdges = [];
  const excludedNoComponentEdges = [];
  const crossComponentPairKeys = new Set();

  for (const row of packetRows) {
    if (excludeRelationCandidateIds.has(row.relation_candidate_id)) continue;
    const ledgerRow = ledgerById.get(row.relation_candidate_id);
    const candidatesToUse = selectDecisionRespectingCandidates({ packetRow: row, ledgerRow });
    const sourceComponentId = row.source_component_id ?? null;
    for (const candidate of candidatesToUse) {
      const targetComponentId = candidate.target_component_id ?? null;
      rawEdges.push({
        relation_candidate_id: row.relation_candidate_id,
        source_document_id: row.source_document_id,
        target_document_id: candidate.target_document_id,
        source_component_id: sourceComponentId,
        target_component_id: targetComponentId,
        decision_authority: ledgerRow?.decision_authority ?? null,
        final_disposition: ledgerRow?.final_disposition ?? null,
        edge_basis: ledgerRow?.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL"
          ? "PROVISIONAL_PLAUSIBLE_NOT_A_CONFIRMED_FACT"
          : "DECISION_CONFIRMED_SINGLE_EDGE",
      });
      if (sourceComponentId === null || targetComponentId === null) {
        excludedNoComponentEdges.push({ relation_candidate_id: row.relation_candidate_id, source_document_id: row.source_document_id, target_document_id: candidate.target_document_id });
        continue;
      }
      touchedBaseComponents.add(sourceComponentId);
      touchedBaseComponents.add(targetComponentId);
      if (sourceComponentId !== targetComponentId) crossComponentPairKeys.add([sourceComponentId, targetComponentId].sort().join("|"));
      uf.union(sourceComponentId, targetComponentId);
    }
  }

  const membersByRoot = new Map();
  for (const baseId of touchedBaseComponents) {
    const root = uf.find(baseId);
    if (!membersByRoot.has(root)) membersByRoot.set(root, new Set());
    membersByRoot.get(root).add(baseId);
  }
  const maximalComponents = [...membersByRoot.values()]
    .map((members) => {
      const sortedMembers = [...members].sort();
      return {
        maximal_component_id: `dr_maximal_component_${sha256(sortedMembers.join(" ")).slice(0, 24)}`,
        member_base_component_ids: sortedMembers,
        base_component_count: sortedMembers.length,
      };
    })
    .sort((a, b) => a.maximal_component_id.localeCompare(b.maximal_component_id));

  const baseToMaximalId = new Map();
  for (const comp of maximalComponents) for (const baseId of comp.member_base_component_ids) baseToMaximalId.set(baseId, comp.maximal_component_id);
  function resolveMaximalComponentId(baseComponentId) {
    if (baseComponentId === null || baseComponentId === undefined) return null;
    return baseToMaximalId.get(baseComponentId) ?? `dr_maximal_component_singleton_${sha256(baseComponentId).slice(0, 24)}`;
  }

  return Object.freeze({
    rawEdges,
    excludedNoComponentEdges,
    totalCandidateEdgeCount: rawEdges.length,
    distinctCrossComponentPairCount: crossComponentPairKeys.size,
    maximalComponents,
    resolveMaximalComponentId,
  });
}

// chain_component_id -> planned_split, built from the real 500-record
// Candidate Pool. By construction every record sharing a chain_component_id
// already carries the SAME planned_split (see
// domain/evaluation/candidate-pool-builder.mjs's own computeLeakageReport) --
// this just makes that mapping queryable.
export function buildComponentSplitMap({ poolRecords }) {
  const map = new Map();
  for (const record of poolRecords) {
    if (record.chain_component_id) map.set(record.chain_component_id, record.planned_split);
  }
  return map;
}

// chain_component_id -> author_allocation, from the 150 Anchor v0.2/Author
// v0.2 records only (components with no Anchor member are simply absent).
export function buildComponentAuthorMap({ authorRows }) {
  const map = new Map();
  for (const record of authorRows) {
    if (record.chain_component_id) map.set(record.chain_component_id, record.author_allocation);
  }
  return map;
}

const CLOSED_LABELS = Object.freeze([
  "DIRECT_CROSS_SPLIT_EDGE",
  "DIRECT_CROSS_AUTHOR_EDGE",
  "INDIVIDUALLY_DECISIVE",
  "REDUNDANT_BUT_COMPONENT_RELEVANT",
  "NO_CURRENT_SPLIT_IMPACT",
]);
export { CLOSED_LABELS };

// Classifies every REVIEWER_CONSENSUS_PROVISIONAL row against a baseline
// decision-respecting graph + its violation set, using ONLY the five closed
// labels above (a row may carry more than one). `violatingMaximalComponentIds`
// is the union of every maximal_component_id that appears in the baseline
// split OR author violation lists (computed by the caller via the shared
// computeMaximalGraphSplitImpact/computeMaximalGraphAuthorImpact functions
// from relation-closure-maximal-graph.mjs, reused unchanged -- they operate
// on any `resolveMaximalComponentId`, decision-respecting or extreme).
//
// "INDIVIDUALLY_DECISIVE" is determined by `rebuildAndCountViolations`, a
// caller-supplied function that rebuilds the WHOLE decision-respecting graph
// excluding this one row's relation_candidate_id and returns
// { splitViolationCount, authorViolationCount } -- kept as an injected
// callback (rather than this module doing the rebuild itself) so the 294
// rebuilds stay a pure, easily-tested loop over a caller-provided pool/author
// dataset without this module needing to import the impact functions itself.
export function classifyProvisionalRow({
  packetRow,
  componentSplitMap,
  componentAuthorMap,
  resolveMaximalComponentId,
  violatingMaximalComponentIds,
  baselineViolationCount,
  rebuildAndCountViolationsExcludingThisRow,
  otherProvisionalPacketRows,
}) {
  const candidates = packetRow.candidates ?? [];
  const sourceComponentId = packetRow.source_component_id ?? null;

  let directCrossSplit = false;
  let directCrossAuthor = false;
  let touchesViolatingComponent = false;
  const affectedMaximalComponentIds = new Set();
  const affectedDocumentIds = new Set([packetRow.source_document_id]);
  const affectedBaseComponentIds = new Set(sourceComponentId ? [sourceComponentId] : []);

  for (const candidate of candidates) {
    const targetComponentId = candidate.target_component_id ?? null;
    affectedDocumentIds.add(candidate.target_document_id);
    if (targetComponentId) affectedBaseComponentIds.add(targetComponentId);

    if (sourceComponentId && targetComponentId) {
      const sourceSplit = componentSplitMap.get(sourceComponentId);
      const targetSplit = componentSplitMap.get(targetComponentId);
      if (sourceSplit && targetSplit && sourceSplit !== targetSplit) directCrossSplit = true;

      const sourceAuthor = componentAuthorMap.get(sourceComponentId);
      const targetAuthor = componentAuthorMap.get(targetComponentId);
      if (sourceAuthor && targetAuthor && sourceAuthor !== targetAuthor) directCrossAuthor = true;

      const maximalId = resolveMaximalComponentId(sourceComponentId);
      if (violatingMaximalComponentIds.has(maximalId)) {
        touchesViolatingComponent = true;
        affectedMaximalComponentIds.add(maximalId);
      }
      const targetMaximalId = resolveMaximalComponentId(targetComponentId);
      if (violatingMaximalComponentIds.has(targetMaximalId)) {
        touchesViolatingComponent = true;
        affectedMaximalComponentIds.add(targetMaximalId);
      }
    }
  }

  // Duplicate-path evidence (informational, not itself a closed label): other
  // provisional rows whose source or any candidate target shares a base
  // component with this row's own source/target set.
  const duplicatePathWithRelationCandidateIds = otherProvisionalPacketRows
    .filter((other) => other.relation_candidate_id !== packetRow.relation_candidate_id)
    .filter((other) => {
      const otherComponents = new Set([other.source_component_id, ...(other.candidates ?? []).map((c) => c.target_component_id)].filter(Boolean));
      for (const id of affectedBaseComponentIds) if (otherComponents.has(id)) return true;
      return false;
    })
    .map((other) => other.relation_candidate_id)
    .sort();

  let individuallyDecisive = false;
  if (touchesViolatingComponent) {
    const after = rebuildAndCountViolationsExcludingThisRow(packetRow.relation_candidate_id);
    const afterCount = after.splitViolationCount + after.authorViolationCount;
    individuallyDecisive = afterCount < baselineViolationCount;
  }

  const labels = [];
  if (directCrossSplit) labels.push("DIRECT_CROSS_SPLIT_EDGE");
  if (directCrossAuthor) labels.push("DIRECT_CROSS_AUTHOR_EDGE");
  if (individuallyDecisive) labels.push("INDIVIDUALLY_DECISIVE");
  if (touchesViolatingComponent && !individuallyDecisive) labels.push("REDUNDANT_BUT_COMPONENT_RELEVANT");
  if (!touchesViolatingComponent) labels.push("NO_CURRENT_SPLIT_IMPACT");

  return Object.freeze({
    relation_candidate_id: packetRow.relation_candidate_id,
    labels,
    direct_cross_split_edge: directCrossSplit,
    direct_cross_author_edge: directCrossAuthor,
    individually_decisive: individuallyDecisive,
    touches_violating_component: touchesViolatingComponent,
    affected_maximal_component_ids: [...affectedMaximalComponentIds].sort(),
    affected_document_ids: [...affectedDocumentIds].sort(),
    affected_base_component_ids: [...affectedBaseComponentIds].sort(),
    duplicate_path_with_relation_candidate_ids: duplicatePathWithRelationCandidateIds,
  });
}
