// Turn N4.11: pure functions for (1) mechanically verifying a single
// reviewer's Priority Wave 1 decision file, (2) comparing Reviewer E vs
// Reviewer F for exact agreement, and (3) building the PROSPECTIVE
// (never-official) decision-respecting graph that overlays that agreement
// onto Turn N4.9's policy for exactly the 13 Priority Wave 1 rows, leaving
// every other row (the 281 remaining provisional rows, the 8 Owner REJECT
// rows, the 2 Reviewer-C/D-confirmed rows, and the 1 quarantined row)
// governed by the UNCHANGED N4.9 rule.
//
// This module never writes a confirmed_target_document_id or disposition to
// the official ledger, never promotes a consensus to a confirmed Relation,
// and never adjudicates any of the 281 rows outside Priority Wave 1.
import { createHash } from "node:crypto";
import { selectDecisionRespectingCandidates } from "./relation-closure-decision-respecting-graph.mjs";

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

const ALLOWED_DISPOSITIONS = new Set(["CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"]);

// Verifies ONE reviewer's decision array against every mechanical
// precondition this Turn requires (checks 1-9 excluding the cross-reviewer
// checks 11-12, which compareReviewerAgreement covers). Returns
// { ok, violations }, never throws itself.
export function verifyReviewerDecisionSet({ decisions, expectedRelationCandidateIds, expectedPacketSha256, expectedReviewerRole, packetById }) {
  const violations = [];
  if (decisions.length !== expectedRelationCandidateIds.length) {
    violations.push({ type: "ROW_COUNT_MISMATCH", expected: expectedRelationCandidateIds.length, actual: decisions.length });
  }
  const seen = new Set();
  for (const d of decisions) {
    if (seen.has(d.relation_candidate_id)) violations.push({ type: "DUPLICATE_RELATION_CANDIDATE_ID", relation_candidate_id: d.relation_candidate_id });
    seen.add(d.relation_candidate_id);
  }
  const expectedSet = new Set(expectedRelationCandidateIds);
  const missing = [...expectedSet].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !expectedSet.has(id));
  if (missing.length > 0) violations.push({ type: "MISSING_RELATION_CANDIDATE_IDS", ids: missing });
  if (extra.length > 0) violations.push({ type: "UNEXPECTED_EXTRA_RELATION_CANDIDATE_IDS", ids: extra });

  for (const d of decisions) {
    if (!ALLOWED_DISPOSITIONS.has(d.owner_disposition)) {
      violations.push({ type: "DISALLOWED_DISPOSITION", relation_candidate_id: d.relation_candidate_id, value: d.owner_disposition });
      continue;
    }
    if (d.owner_disposition === "CONFIRM") {
      const consideredOk = Array.isArray(d.considered_target_document_ids) && d.considered_target_document_ids.includes(d.confirmed_target_document_id);
      if (!consideredOk) violations.push({ type: "CONFIRM_TARGET_NOT_IN_CONSIDERED_SET", relation_candidate_id: d.relation_candidate_id });
      const packetRow = packetById.get(d.relation_candidate_id);
      const realCandidateIds = new Set((packetRow?.candidates ?? []).map((c) => c.target_document_id));
      if (!realCandidateIds.has(d.confirmed_target_document_id)) {
        violations.push({ type: "CONFIRM_TARGET_NOT_A_REAL_PACKET_CANDIDATE", relation_candidate_id: d.relation_candidate_id });
      }
    } else if (d.confirmed_target_document_id !== null && d.confirmed_target_document_id !== undefined) {
      violations.push({ type: "NON_CONFIRM_ROW_HAS_TARGET", relation_candidate_id: d.relation_candidate_id, disposition: d.owner_disposition });
    }
    if (typeof d.note !== "string" || d.note.trim().length === 0) {
      violations.push({ type: "EMPTY_NOTE", relation_candidate_id: d.relation_candidate_id });
    }
    if (d.input_packet_sha256 !== expectedPacketSha256) {
      violations.push({ type: "PACKET_SHA_MISMATCH", relation_candidate_id: d.relation_candidate_id, expected: expectedPacketSha256, actual: d.input_packet_sha256 });
    }
    if (d.reviewer_role !== expectedReviewerRole) {
      violations.push({ type: "REVIEWER_ROLE_MISMATCH", relation_candidate_id: d.relation_candidate_id, expected: expectedReviewerRole, actual: d.reviewer_role });
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations });
}

// Compares E vs F disposition AND target per row. Never hardcodes an
// expected count -- everything is derived from the two input arrays.
export function compareReviewerAgreement({ eDecisions, fDecisions }) {
  const eById = new Map(eDecisions.map((d) => [d.relation_candidate_id, d]));
  const fById = new Map(fDecisions.map((d) => [d.relation_candidate_id, d]));
  const allIds = [...new Set([...eById.keys(), ...fById.keys()])].sort();
  const rows = allIds.map((id) => {
    const e = eById.get(id);
    const f = fById.get(id);
    const dispositionAgrees = !!e && !!f && e.owner_disposition === f.owner_disposition;
    const targetAgrees = dispositionAgrees && e.confirmed_target_document_id === f.confirmed_target_document_id;
    const agrees = dispositionAgrees && targetAgrees;
    return Object.freeze({
      relation_candidate_id: id,
      reviewer_e: e ? { disposition: e.owner_disposition, confirmed_target_document_id: e.confirmed_target_document_id, note: e.note } : null,
      reviewer_f: f ? { disposition: f.owner_disposition, confirmed_target_document_id: f.confirmed_target_document_id, note: f.note } : null,
      agrees,
      consensus_disposition: agrees ? e.owner_disposition : null,
      consensus_target_document_id: agrees && e.owner_disposition === "CONFIRM" ? e.confirmed_target_document_id : null,
    });
  });
  const agreedRows = rows.filter((r) => r.agrees);
  const disagreedRows = rows.filter((r) => !r.agrees);
  const distribution = { CONFIRM: 0, REJECT: 0, NEEDS_MORE_REVIEW: 0 };
  for (const r of agreedRows) distribution[r.consensus_disposition] += 1;
  return Object.freeze({
    rows,
    totalCount: allIds.length,
    exactAgreementCount: agreedRows.length,
    disagreementCount: disagreedRows.length,
    disagreements: disagreedRows,
    distribution,
  });
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
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }
}

// Selects candidate edges for ONE packet row under the PROSPECTIVE overlay:
// if the row's relation_candidate_id has a Wave-1 consensus entry, the
// consensus (never the real ledger authority) decides; otherwise the
// UNCHANGED N4.9 decision-respecting rule applies verbatim (imported, not
// reimplemented). A disagreement/NEEDS_MORE_REVIEW consensus entry (none
// exist in the real data, but handled honestly) falls back to the SAME
// "all candidates, still just plausible" treatment N4.9 gives ordinary
// REVIEWER_CONSENSUS_PROVISIONAL rows -- never a confirmed edge is
// fabricated for it.
export function selectProspectiveCandidates({ packetRow, ledgerRow, consensusByRelationCandidateId }) {
  const consensus = consensusByRelationCandidateId.get(packetRow.relation_candidate_id);
  if (!consensus) return selectDecisionRespectingCandidates({ packetRow, ledgerRow });
  if (consensus.consensus_disposition === "CONFIRM") {
    const match = (packetRow.candidates ?? []).find((c) => c.target_document_id === consensus.consensus_target_document_id);
    return match ? [match] : [];
  }
  if (consensus.consensus_disposition === "REJECT") return [];
  // disagreement or NEEDS_MORE_REVIEW consensus (not expected in real data).
  return packetRow.candidates ?? [];
}

export function buildProspectiveGraph({ packetRows, ledgerRows, consensusByRelationCandidateId, excludeRelationCandidateIds = new Set() }) {
  const ledgerById = new Map(ledgerRows.map((r) => [r.relation_candidate_id, r]));
  const uf = new UnionFind();
  const touchedBaseComponents = new Set();
  const rawEdges = [];
  const excludedNoComponentEdges = [];
  const crossComponentPairKeys = new Set();

  for (const row of packetRows) {
    if (excludeRelationCandidateIds.has(row.relation_candidate_id)) continue;
    const ledgerRow = ledgerById.get(row.relation_candidate_id);
    const candidatesToUse = selectProspectiveCandidates({ packetRow: row, ledgerRow, consensusByRelationCandidateId });
    const sourceComponentId = row.source_component_id ?? null;
    const isWave1 = consensusByRelationCandidateId.has(row.relation_candidate_id);
    for (const candidate of candidatesToUse) {
      const targetComponentId = candidate.target_component_id ?? null;
      rawEdges.push({
        relation_candidate_id: row.relation_candidate_id,
        source_document_id: row.source_document_id,
        target_document_id: candidate.target_document_id,
        source_component_id: sourceComponentId,
        target_component_id: targetComponentId,
        edge_basis: isWave1 ? "PROSPECTIVE_WAVE1_CONSENSUS_PENDING_OWNER" : (ledgerRow?.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL" ? "PROVISIONAL_PLAUSIBLE_NOT_A_CONFIRMED_FACT" : "DECISION_CONFIRMED_SINGLE_EDGE"),
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
        maximal_component_id: `prospective_component_${sha256(sortedMembers.join(" ")).slice(0, 24)}`,
        member_base_component_ids: sortedMembers,
        base_component_count: sortedMembers.length,
      };
    })
    .sort((a, b) => a.maximal_component_id.localeCompare(b.maximal_component_id));

  const baseToMaximalId = new Map();
  for (const comp of maximalComponents) for (const baseId of comp.member_base_component_ids) baseToMaximalId.set(baseId, comp.maximal_component_id);
  function resolveMaximalComponentId(baseComponentId) {
    if (baseComponentId === null || baseComponentId === undefined) return null;
    return baseToMaximalId.get(baseComponentId) ?? `prospective_component_singleton_${sha256(baseComponentId).slice(0, 24)}`;
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
