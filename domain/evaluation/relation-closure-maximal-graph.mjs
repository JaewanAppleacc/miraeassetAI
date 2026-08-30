// Turn N4.8: pure, dependency-injected builder for the CONSERVATIVE MAXIMAL
// PLAUSIBLE relation graph -- Path 2 from
// work/handoff/anchor-dev-tune-v0.2/provisional-294-decision-packet.v0.2.json
// ("모든 plausible edge를 보수적으로 포함한 그래프에서도 leakage 0 증명").
//
// This module never touches the filesystem and never assigns CONFIRM/REJECT
// to any relation candidate. It takes the already-materialized 326-row
// relation-closure-review-packet.v0.1.jsonl (every row already carries each
// candidate's own `source_component_id` / `target_component_id`, computed
// once upstream by domain/evaluation/anchor-allocation-builder.mjs's
// buildRelationClosurePacket against the SAME base chain-component graph
// Candidate Pool 500 / Anchor v0.2 / Author v0.2 were built from) and unions
// EVERY listed candidate target into the base component graph, REGARDLESS of
// Owner CONFIRM/REJECT/NEEDS_MORE_REVIEW or REVIEWER_CONSENSUS_PROVISIONAL
// status. That is the worst-case assumption Path 2 requires: if a real
// AMENDS/TERMINATES relation existed at every one of the 326 rows' listed
// candidate targets simultaneously, would any evaluation split, Anchor
// selection, or author allocation leak? It never promotes a candidate to a
// confirmed Fact/Relation and never writes to the official relation-of-record
// store -- the resulting `maximal_component_id` values exist ONLY inside this
// module's output, tagged MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED,
// and must never be described as "chain closure 완료" or "실제 relation".
//
// Determinism: every id is a SHA-256 digest of stable, caller-supplied input
// (sorted member lists) -- never Math.random()/Date.now()/crypto.randomUUID()
// -- and the union-find below is symmetric/idempotent, so re-running with the
// SAME 326 rows in ANY order, or with duplicated candidate rows, produces the
// byte-identical maximal_component_id set (see
// tests/relation-closure-maximal-graph.test.mjs's order-independence and
// duplicate-edge counterexamples).
import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

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
    // Deterministic tie-break, independent of insertion/candidate order.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

// packetRows: relation-closure-review-packet.v0.1.jsonl rows, EXACTLY as
// written by buildRelationClosurePacket -- each row has
// { relation_candidate_id, source_document_id, source_component_id,
//   candidates: [{ target_document_id, target_component_id, score, ... }] }.
// This function reads NO disposition field (owner_disposition,
// decision_authority, final_disposition) from the ledger -- it is
// deliberately blind to CONFIRM/REJECT/PROVISIONAL so that REJECT and
// REVIEWER_CONSENSUS_PROVISIONAL candidates are still unioned as
// worst-case-plausible edges, exactly like CONFIRM ones. Nothing here reads
// or writes review disposition.
export function buildMaximalPlausibleGraph({ packetRows }) {
  const uf = new UnionFind();
  const touchedBaseComponents = new Set();
  const rawEdges = [];
  const excludedNoComponentEdges = [];
  const crossComponentPairKeys = new Set();
  let totalCandidateEdgeCount = 0;

  for (const row of packetRows) {
    const sourceComponentId = row.source_component_id ?? null;
    for (const candidate of row.candidates ?? []) {
      totalCandidateEdgeCount += 1;
      const targetComponentId = candidate.target_component_id ?? null;
      rawEdges.push({
        relation_candidate_id: row.relation_candidate_id,
        source_document_id: row.source_document_id,
        target_document_id: candidate.target_document_id,
        source_component_id: sourceComponentId,
        target_component_id: targetComponentId,
        edge_basis: "MAXIMAL_PLAUSIBLE_CANDIDATE_NOT_A_CONFIRMED_FACT",
      });
      if (sourceComponentId === null || targetComponentId === null) {
        excludedNoComponentEdges.push({
          relation_candidate_id: row.relation_candidate_id,
          source_document_id: row.source_document_id,
          target_document_id: candidate.target_document_id,
          reason: "one_or_both_documents_never_anchored_in_any_evaluation_component",
        });
        continue;
      }
      touchedBaseComponents.add(sourceComponentId);
      touchedBaseComponents.add(targetComponentId);
      if (sourceComponentId !== targetComponentId) {
        crossComponentPairKeys.add([sourceComponentId, targetComponentId].sort().join("|"));
      }
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
        maximal_component_id: `maximal_component_${sha256(sortedMembers.join(" ")).slice(0, 24)}`,
        member_base_component_ids: sortedMembers,
        base_component_count: sortedMembers.length,
      };
    })
    .sort((a, b) => a.maximal_component_id.localeCompare(b.maximal_component_id));

  const baseToMaximalId = new Map();
  for (const comp of maximalComponents) {
    for (const baseId of comp.member_base_component_ids) baseToMaximalId.set(baseId, comp.maximal_component_id);
  }
  // A base component id NEVER touched by any candidate edge (i.e. no
  // plausible AMENDS/TERMINATES/CONFIRMS candidate ever names it or a
  // document inside it) stays its own singleton maximal component --
  // deterministic function of its own id, never merged with anything.
  function resolveMaximalComponentId(baseComponentId) {
    if (baseComponentId === null || baseComponentId === undefined) return null;
    return baseToMaximalId.get(baseComponentId) ?? `maximal_component_singleton_${sha256(baseComponentId).slice(0, 24)}`;
  }

  return Object.freeze({
    rawEdges,
    excludedNoComponentEdges,
    totalCandidateEdgeCount,
    distinctCrossComponentPairCount: crossComponentPairKeys.size,
    maximalComponents,
    resolveMaximalComponentId,
  });
}

// Cross-references the maximal graph against the FULL 500-record Candidate
// Pool's already-assigned `planned_split` (DEV_TUNE/DEV_CHECK/HOLDOUT). A
// violation means: if every one of the 326 rows' plausible candidates turned
// out to be a real relation, two records that currently sit in DIFFERENT
// splits would actually belong to the same chain -- a genuine future
// leakage risk, not a proof that it exists today.
export function computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId }) {
  const byMaximal = new Map();
  for (const record of poolRecords) {
    if (!record.chain_component_id) continue; // LOCKED_BY_COVERAGE: no document, no relation risk
    const maximalId = resolveMaximalComponentId(record.chain_component_id);
    const list = byMaximal.get(maximalId) ?? [];
    list.push(record);
    byMaximal.set(maximalId, list);
  }
  const violations = [];
  let largestComponentAssignmentCount = 0;
  let largestComponentId = null;
  for (const [maximalId, records] of byMaximal) {
    if (records.length > largestComponentAssignmentCount) {
      largestComponentAssignmentCount = records.length;
      largestComponentId = maximalId;
    }
    const splits = new Set(records.map((r) => r.planned_split));
    if (splits.size > 1) {
      violations.push({
        type: "MAXIMAL_GRAPH_CROSS_SPLIT_LEAKAGE",
        maximal_component_id: maximalId,
        splits: [...splits].sort(),
        assignment_ids: records.map((r) => r.assignment_id).sort(),
        document_ids: [...new Set(records.flatMap((r) => r.anchor_document_ids))].sort(),
        base_component_ids: [...new Set(records.map((r) => r.chain_component_id))].sort(),
      });
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations,
    maximal_component_count_touching_pool: byMaximal.size,
    largest_component_assignment_count: largestComponentAssignmentCount,
    largest_component_id: largestComponentId,
    scope: "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED",
  });
}

// Same idea for AUTHOR_A/AUTHOR_B -- rows here are the 150 Anchor v0.2 /
// Author v0.2 records only (a subset of poolRecords that also carries
// author_allocation).
export function computeMaximalGraphAuthorImpact({ authorRows, resolveMaximalComponentId }) {
  const byMaximal = new Map();
  for (const record of authorRows) {
    if (!record.chain_component_id) continue;
    const maximalId = resolveMaximalComponentId(record.chain_component_id);
    const list = byMaximal.get(maximalId) ?? [];
    list.push(record);
    byMaximal.set(maximalId, list);
  }
  const violations = [];
  for (const [maximalId, records] of byMaximal) {
    const authors = new Set(records.map((r) => r.author_allocation));
    if (authors.size > 1) {
      violations.push({
        type: "MAXIMAL_GRAPH_CROSS_AUTHOR_LEAKAGE",
        maximal_component_id: maximalId,
        authors: [...authors].sort(),
        assignment_ids: records.map((r) => r.assignment_id).sort(),
        document_ids: [...new Set(records.flatMap((r) => r.anchor_document_ids))].sort(),
        base_component_ids: [...new Set(records.map((r) => r.chain_component_id))].sort(),
      });
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations,
    scope: "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED",
  });
}

// Checks whether any currently-INCLUDED Anchor v0.2 document could, under the
// maximal plausible graph, transitively chain into one of the documents
// already quarantined by Turn N4.7 (quarantine-manifest.v0.2.json's
// quarantine_document_ids). `docToBaseComponentId` is built by the caller
// from the 326-row packet's own source/target component fields (covers
// every document the packet ever mentions).
export function computeMaximalGraphQuarantineImpact({ quarantineDocumentIds, docToBaseComponentId, authorRows, resolveMaximalComponentId }) {
  const quarantineMaximalIds = new Set();
  const unresolvedQuarantineDocs = [];
  for (const doc of quarantineDocumentIds) {
    const baseId = docToBaseComponentId.get(doc) ?? null;
    if (baseId) quarantineMaximalIds.add(resolveMaximalComponentId(baseId));
    else unresolvedQuarantineDocs.push(doc);
  }
  const violations = [];
  for (const record of authorRows) {
    if (!record.chain_component_id) continue;
    const maximalId = resolveMaximalComponentId(record.chain_component_id);
    if (quarantineMaximalIds.has(maximalId)) {
      violations.push({
        type: "MAXIMAL_GRAPH_QUARANTINE_INTRUSION_RISK",
        maximal_component_id: maximalId,
        assignment_id: record.assignment_id,
        anchor_document_ids: record.anchor_document_ids,
      });
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations,
    quarantine_maximal_component_count: quarantineMaximalIds.size,
    quarantine_documents_with_no_known_component: unresolvedQuarantineDocs,
    scope: "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED",
  });
}

// Builds a document_id -> base_component_id map from every source/candidate
// mention in the 326-row packet (used to resolve quarantine documents that
// may not appear directly as a Candidate Pool / Anchor assignment).
export function buildDocumentToBaseComponentMap({ packetRows }) {
  const map = new Map();
  for (const row of packetRows) {
    if (row.source_component_id) map.set(row.source_document_id, row.source_component_id);
    for (const candidate of row.candidates ?? []) {
      if (candidate.target_component_id) map.set(candidate.target_document_id, candidate.target_component_id);
    }
  }
  return map;
}

// For a REPORTED (never applied) split-leakage violation, computes which
// OTHER Candidate Pool records (same evaluation-item shape, still eligible,
// not already Anchor v0.2 members, not inside the maximal component that
// caused the violation) could stand in as a replacement -- the same
// "equivalent candidate" idea Turn N4.7's own Anchor supplementation used,
// but here it is only a computed SUGGESTION for the Owner to review, never
// applied by this module.
export function suggestReplacementCandidates({ violatingAssignmentIds, poolRecords, anchorV02AssignmentIds, resolveMaximalComponentId, targetPlannedSplit }) {
  const anchorSet = new Set(anchorV02AssignmentIds);
  const violatingSet = new Set(violatingAssignmentIds);
  const violatingComponentIds = new Set(
    poolRecords
      .filter((r) => violatingSet.has(r.assignment_id) && r.chain_component_id)
      .map((r) => resolveMaximalComponentId(r.chain_component_id)),
  );
  return poolRecords
    .filter((r) => r.planned_split === targetPlannedSplit)
    .filter((r) => !anchorSet.has(r.assignment_id))
    .filter((r) => !violatingSet.has(r.assignment_id))
    .filter((r) => !r.chain_component_id || !violatingComponentIds.has(resolveMaximalComponentId(r.chain_component_id)))
    .map((r) => ({ assignment_id: r.assignment_id, evaluation_group_id: r.evaluation_group_id, bucket: r.bucket, tags: r.tags }));
}
