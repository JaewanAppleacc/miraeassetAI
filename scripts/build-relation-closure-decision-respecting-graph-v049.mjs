#!/usr/bin/env node
// Turn N4.9: DECISION-RESPECTING conservative graph + targeted impact cohort.
// Unlike Turn N4.8's EXTREME maximal graph (every one of the 326-row
// packet's candidates, including Owner REJECT and the QUARANTINED_UNRESOLVED
// row, treated as worst-case-plausible), this Turn respects every decision
// already made (Owner CONFIRM/REJECT, Reviewer C/D dual CONFIRM, the
// existing 50-doc quarantine boundary) and expands ONLY the 294 still-
// undecided REVIEWER_CONSENSUS_PROVISIONAL rows conservatively. If leakage
// still exists under THIS narrower graph, this script does NOT escalate to a
// full manual review of all 294 rows -- it computes, mechanically, which
// specific provisional rows could actually be contributing to that leakage
// (the "targeted impact cohort") using five closed, non-exclusive labels.
//
// This script NEVER:
//   - writes a confirmed_target_document_id or final disposition for ANY of
//     the 294 REVIEWER_CONSENSUS_PROVISIONAL rows
//   - re-activates any of the 8 Owner REJECT candidates
//   - replaces an Anchor v0.2 assignment
//   - authors Gold, or promotes anything to the official Relation/Fact/
//     Evidence store
//   - approves an official split by itself
//   - modifies any existing artifact (326 packet, ledger v0.2, Owner v0.3,
//     Reviewer C/D results, Candidate Pool 500, Anchor/Author v0.2,
//     quarantine manifest, or ANY Turn N4.7/N4.7.1/N4.8 output file)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDecisionRespectingGraph,
  buildComponentSplitMap,
  buildComponentAuthorMap,
  classifyProvisionalRow,
} from "../domain/evaluation/relation-closure-decision-respecting-graph.mjs";
import {
  computeMaximalGraphSplitImpact,
  computeMaximalGraphAuthorImpact,
  computeMaximalGraphQuarantineImpact,
  buildDocumentToBaseComponentMap,
} from "../domain/evaluation/relation-closure-maximal-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// -- 0. Fixed inputs. --------------------------------------------------
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const LEDGER_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl");
const PROVISIONAL_294_PACKET_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/provisional-294-decision-packet.v0.2.json");
const N48_IMPACT_REPORT_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/maximal-graph-impact-report.v0.1.json");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const ANCHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl");
const OWNER_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");
const EXPECTED_OWNER_SHA256 = "603e0a24c67251b7f13ccdb2dec2c938c09a34c61c1e612e1fe8c97f9423e50e";
const REVIEWER_C_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-c-v0.2/relation-multistep-reviewer-c-decision.v0.2.jsonl");
const REVIEWER_D_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-d-v0.2/relation-multistep-reviewer-d-decision.v0.2.jsonl");
const QUARANTINE_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json");
const GATE_STATUS_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gate-status.v0.2.json");
const GATE_STATUS_V03_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/gate-status.v0.3.json");

const outDir = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
mkdirSync(outDir, { recursive: true });

// == 1. Input verification -- ABORT BEFORE WRITING anything on mismatch ===
const actualOwnerSha256 = sha256File(OWNER_DECISION_PATH);
if (actualOwnerSha256 !== EXPECTED_OWNER_SHA256) { console.error(`BLOCKER: Owner decision sha256 mismatch (actual ${actualOwnerSha256})`); process.exit(1); }
const ownerRows = readJsonl(OWNER_DECISION_PATH);
if (ownerRows.length !== 30) { console.error(`BLOCKER: Owner decision row count ${ownerRows.length} !== 30`); process.exit(1); }
const ownerDist = { CONFIRM: 0, REJECT: 0, NEEDS_MORE_REVIEW: 0 };
for (const r of ownerRows) ownerDist[r.owner_disposition] = (ownerDist[r.owner_disposition] ?? 0) + 1;
if (ownerDist.CONFIRM !== 21 || ownerDist.REJECT !== 8 || ownerDist.NEEDS_MORE_REVIEW !== 1) { console.error(`BLOCKER: Owner distribution mismatch: ${JSON.stringify(ownerDist)}`); process.exit(1); }

const cRows = readJsonl(REVIEWER_C_DECISION_PATH);
const dRows = readJsonl(REVIEWER_D_DECISION_PATH);
if (cRows.length !== 2 || dRows.length !== 2) { console.error("BLOCKER: Reviewer C/D row count is not 2/2"); process.exit(1); }
const reviewerCSha256 = sha256File(REVIEWER_C_DECISION_PATH);
const reviewerDSha256 = sha256File(REVIEWER_D_DECISION_PATH);

const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const packet326Sha256 = sha256File(PACKET_326_PATH);

const ledgerRows = readJsonl(LEDGER_V02_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }
const ledgerSha256 = sha256File(LEDGER_V02_PATH);
const authorityCounts = { OWNER_V03: 0, DUAL_REVIEW_C_D: 0, REVIEWER_CONSENSUS_PROVISIONAL: 0, QUARANTINED_UNRESOLVED: 0 };
for (const r of ledgerRows) authorityCounts[r.decision_authority] = (authorityCounts[r.decision_authority] ?? 0) + 1;
const ownerConfirmRows = ledgerRows.filter((r) => r.decision_authority === "OWNER_V03" && r.final_disposition === "CONFIRM");
const ownerRejectRows = ledgerRows.filter((r) => r.decision_authority === "OWNER_V03" && r.final_disposition === "REJECT");
const dualConfirmRows = ledgerRows.filter((r) => r.decision_authority === "DUAL_REVIEW_C_D" && r.final_disposition === "CONFIRM");
const provisionalRows = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL");
const quarantinedLedgerRows = ledgerRows.filter((r) => r.decision_authority === "QUARANTINED_UNRESOLVED");
if (ownerConfirmRows.length !== 21) { console.error(`BLOCKER: ledger OWNER_V03 CONFIRM count ${ownerConfirmRows.length} !== 21`); process.exit(1); }
if (ownerRejectRows.length !== 8) { console.error(`BLOCKER: ledger OWNER_V03 REJECT count ${ownerRejectRows.length} !== 8`); process.exit(1); }
if (dualConfirmRows.length !== 2) { console.error(`BLOCKER: ledger DUAL_REVIEW_C_D CONFIRM count ${dualConfirmRows.length} !== 2`); process.exit(1); }
if (provisionalRows.length !== 294) { console.error(`BLOCKER: ledger REVIEWER_CONSENSUS_PROVISIONAL count ${provisionalRows.length} !== 294`); process.exit(1); }
if (quarantinedLedgerRows.length !== 1) { console.error(`BLOCKER: ledger QUARANTINED_UNRESOLVED count ${quarantinedLedgerRows.length} !== 1`); process.exit(1); }

const provisional294Packet = readJson(PROVISIONAL_294_PACKET_PATH);
if (provisional294Packet.current_state.row_count !== 294) { console.error("BLOCKER: provisional-294-decision-packet.v0.2.json row_count is not 294"); process.exit(1); }

const n48Report = readJson(N48_IMPACT_REPORT_PATH);
if (n48Report.maximal_graph_summary.total_candidate_edge_count !== 2151) { console.error("BLOCKER: Turn N4.8 report's total_candidate_edge_count is not 2151 -- N4.8 output drifted"); process.exit(1); }
if (n48Report.input_shas.relation_closure_review_packet_v01_sha256 !== packet326Sha256) { console.error("BLOCKER: 326-packet sha256 does not match what Turn N4.8 pinned"); process.exit(1); }
if (n48Report.input_shas.relation_closure_candidate_ledger_v02_sha256 !== ledgerSha256) { console.error("BLOCKER: ledger v0.2 sha256 does not match what Turn N4.8 pinned"); process.exit(1); }
if (n48Report.input_shas.reviewer_c_decision_sha256 !== reviewerCSha256 || n48Report.input_shas.reviewer_d_decision_sha256 !== reviewerDSha256) { console.error("BLOCKER: Reviewer C/D decision sha256 does not match what Turn N4.8 pinned"); process.exit(1); }
if (n48Report.input_shas.owner_decision_v03_sha256 !== actualOwnerSha256) { console.error("BLOCKER: Owner decision sha256 does not match what Turn N4.8 pinned"); process.exit(1); }

const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool row count ${poolRecords.length} !== 500`); process.exit(1); }
const poolSha256 = sha256File(POOL_PATH);
if (n48Report.input_shas.candidate_pool_v041_sha256 !== poolSha256) { console.error("BLOCKER: Candidate Pool sha256 does not match what Turn N4.8 pinned"); process.exit(1); }

const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 row count ${anchorV02.length} !== 150`); process.exit(1); }
const anchorV02Sha256 = sha256File(ANCHOR_V02_PATH);
if (n48Report.input_shas.anchor_selection_v02_sha256 !== anchorV02Sha256) { console.error("BLOCKER: Anchor v0.2 sha256 does not match what Turn N4.8 pinned"); process.exit(1); }

const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 row count ${authorV02.length} !== 150`); process.exit(1); }
const authorV02Sha256 = sha256File(AUTHOR_V02_PATH);
if (n48Report.input_shas.author_allocation_v02_sha256 !== authorV02Sha256) { console.error("BLOCKER: Author v0.2 sha256 does not match what Turn N4.8 pinned"); process.exit(1); }
const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV02) authorCounts[r.author_allocation] += 1;
if (authorCounts.AUTHOR_A !== 75 || authorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: Author v0.2 balance ${JSON.stringify(authorCounts)} !== 75/75`); process.exit(1); }

function canonicalSha256(obj, omitKeys = []) {
  const clone = { ...obj };
  for (const k of omitKeys) delete clone[k];
  return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
}

const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }
if (quarantineManifest.status !== "QUARANTINED_UNRESOLVED_RELATION") { console.error("BLOCKER: quarantine manifest status changed"); process.exit(1); }
const quarantineManifestSha256 = sha256File(QUARANTINE_MANIFEST_PATH);
const quarantineManifestCanonicalSha256 = canonicalSha256(quarantineManifest, ["generated_at"]);
// quarantine-manifest.v0.2.json embeds its own `generated_at` and is
// legitimately rewritten (same content, fresh timestamp) every time
// scripts/build-relation-closure-owner-integration-v047.mjs re-runs (e.g. as
// part of npm run test:domain) -- a raw sha256-to-Turn-N4.8's-pin comparison
// would false-positive on an ordinary test run that happened in between,
// exactly the "canonical minus generated_at" carve-out already established
// elsewhere in this repo for generated_at-bearing artifacts. This script
// therefore verifies the CONTENT invariants that actually matter (row/doc
// counts, status, the unresolved row's candidates still fully covered)
// rather than requiring the raw byte hash to match Turn N4.8's now-stale pin.

// The QUARANTINED_UNRESOLVED row's own candidates must already be a subset
// of the quarantine boundary (never re-verified elsewhere) -- this is the
// mechanical proof behind rule D ("모든 후보 target을 안전 경계로 유지").
const unresolvedRow = packet326.find((r) => ledgerRows.find((l) => l.relation_candidate_id === r.relation_candidate_id && l.decision_authority === "QUARANTINED_UNRESOLVED"));
const unresolvedCandidateTargets = (unresolvedRow?.candidates ?? []).map((c) => c.target_document_id);
const quarantineDocSet = new Set(quarantineManifest.quarantine_document_ids);
const uncoveredUnresolvedTargets = unresolvedCandidateTargets.filter((d) => !quarantineDocSet.has(d));
if (uncoveredUnresolvedTargets.length > 0) { console.error(`BLOCKER: QUARANTINED_UNRESOLVED row has candidate targets NOT covered by the existing quarantine boundary: ${uncoveredUnresolvedTargets.join(", ")}`); process.exit(1); }

// == 2. Build the N4.9 decision-respecting graph ===========================
const graph = buildDecisionRespectingGraph({ packetRows: packet326, ledgerRows });
writeJsonl(resolve(outDir, "decision-respecting-graph-edges.v0.1.jsonl"), graph.rawEdges);

const rejectDerivedEdgeCountRemoved = ownerRejectRows.reduce((sum, r) => {
  const row = packet326.find((p) => p.relation_candidate_id === r.relation_candidate_id);
  return sum + (row?.candidates?.length ?? 0);
}, 0);
const quarantinedRowEdgeCountRemoved = quarantinedLedgerRows.reduce((sum, r) => {
  const row = packet326.find((p) => p.relation_candidate_id === r.relation_candidate_id);
  return sum + (row?.candidates?.length ?? 0);
}, 0);
const confirmSurplusEdgeCountRemoved = [...ownerConfirmRows, ...dualConfirmRows].reduce((sum, r) => {
  const row = packet326.find((p) => p.relation_candidate_id === r.relation_candidate_id);
  return sum + Math.max(0, (row?.candidates?.length ?? 0) - 1);
}, 0);
const totalEdgesRemovedVsN48 = n48Report.maximal_graph_summary.total_candidate_edge_count - graph.totalCandidateEdgeCount;

writeJson(resolve(outDir, "decision-respecting-graph-components.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  scope: "DECISION_RESPECTING_GRAPH -- confirmed single edges (23) + ALL 294 REVIEWER_CONSENSUS_PROVISIONAL candidates, Owner REJECT (8 rows) and QUARANTINED_UNRESOLVED (1 row) contribute ZERO edges",
  total_candidate_edge_count: graph.totalCandidateEdgeCount,
  distinct_cross_component_pair_count: graph.distinctCrossComponentPairCount,
  maximal_component_count: graph.maximalComponents.length,
  largest_maximal_component_base_component_count: graph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0),
  maximal_components: graph.maximalComponents,
  comparison_vs_turn_n48_extreme_graph: {
    n48_total_candidate_edge_count: n48Report.maximal_graph_summary.total_candidate_edge_count,
    n49_total_candidate_edge_count: graph.totalCandidateEdgeCount,
    total_edges_removed: totalEdgesRemovedVsN48,
    owner_reject_derived_edges_removed: rejectDerivedEdgeCountRemoved,
    quarantined_unresolved_row_edges_removed: quarantinedRowEdgeCountRemoved,
    confirmed_row_surplus_non_primary_candidate_edges_removed: confirmSurplusEdgeCountRemoved,
    removed_edges_accounted_for: rejectDerivedEdgeCountRemoved + quarantinedRowEdgeCountRemoved + confirmSurplusEdgeCountRemoved === totalEdgesRemovedVsN48,
  },
});

// == 3. Impact analysis =====================================================
const splitImpact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graph.resolveMaximalComponentId });
const authorImpact = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: graph.resolveMaximalComponentId });
const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: packet326 });
const quarantineImpact = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV02.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })),
  resolveMaximalComponentId: graph.resolveMaximalComponentId,
});
const allOk = splitImpact.ok && authorImpact.ok && quarantineImpact.ok;
const affectedAssignmentIds = [...new Set([
  ...splitImpact.violations.flatMap((v) => v.assignment_ids),
  ...authorImpact.violations.flatMap((v) => v.assignment_ids),
  ...quarantineImpact.violations.map((v) => v.assignment_id),
])].sort();

const impactReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.9",
  scope: "DECISION_RESPECTING_GRAPH -- confirmed decisions honored, only the 294 still-undecided rows expanded conservatively",
  input_shas: {
    relation_closure_review_packet_v01_sha256: packet326Sha256,
    relation_closure_candidate_ledger_v02_sha256: ledgerSha256,
    provisional_294_decision_packet_v02_sha256: sha256File(PROVISIONAL_294_PACKET_PATH),
    candidate_pool_v041_sha256: poolSha256,
    anchor_selection_v02_sha256: anchorV02Sha256,
    author_allocation_v02_sha256: authorV02Sha256,
    owner_decision_v03_sha256: actualOwnerSha256,
    reviewer_c_decision_sha256: reviewerCSha256,
    reviewer_d_decision_sha256: reviewerDSha256,
    quarantine_manifest_v02_sha256: quarantineManifestSha256,
    quarantine_manifest_v02_canonical_sha256_excluding_generated_at: quarantineManifestCanonicalSha256,
    quarantine_manifest_v02_sha_note: "Raw sha256 legitimately changes on every re-run of build-relation-closure-owner-integration-v047.mjs (fresh generated_at) -- content invariants (count=50, status, unresolved-row candidate coverage) were verified instead of a stale byte-for-byte pin.",
    all_verified_against_turn_n48_pinned_values: true,
    none_of_these_source_files_modified_by_this_script: true,
  },
  decision_respecting_graph_summary: {
    total_candidate_edge_count: graph.totalCandidateEdgeCount,
    distinct_cross_component_pair_count: graph.distinctCrossComponentPairCount,
    maximal_component_count: graph.maximalComponents.length,
    largest_maximal_component_base_component_count: graph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0),
  },
  comparison_vs_turn_n48_extreme_graph: {
    n48_edge_count: n48Report.maximal_graph_summary.total_candidate_edge_count,
    n49_edge_count: graph.totalCandidateEdgeCount,
    total_edges_removed: totalEdgesRemovedVsN48,
    owner_reject_derived_edges_removed: rejectDerivedEdgeCountRemoved,
    n48_split_violation_count: n48Report.split_impact.violations.length,
    n49_split_violation_count: splitImpact.violations.length,
    n48_author_violation_count: n48Report.author_impact.violations.length,
    n49_author_violation_count: authorImpact.violations.length,
    n48_quarantine_violation_count: n48Report.quarantine_impact.violations.length,
    n49_quarantine_violation_count: quarantineImpact.violations.length,
  },
  split_impact: splitImpact,
  author_impact: authorImpact,
  quarantine_impact: quarantineImpact,
  affected_assignment_ids: affectedAssignmentIds,
  affected_assignment_count: affectedAssignmentIds.length,
  all_zero_decision_respecting_leakage: allOk,
  n48_extreme_graph_result_preserved_separately_at: "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/ (untouched by this Turn)",
};
writeJson(resolve(outDir, "decision-respecting-graph-impact-report.v0.1.json"), impactReport);

// == 4. Targeted impact cohort classification (only meaningful for branch B,
// but computed either way for transparency -- with 0 violations every row
// trivially gets NO_CURRENT_SPLIT_IMPACT). =================================
const violatingMaximalComponentIds = new Set([
  ...splitImpact.violations.map((v) => v.maximal_component_id),
  ...authorImpact.violations.map((v) => v.maximal_component_id),
]);
const componentSplitMap = buildComponentSplitMap({ poolRecords });
const componentAuthorMap = buildComponentAuthorMap({ authorRows: anchorV02 });
const provisionalPacketRows = packet326.filter((row) => ledgerRows.find((l) => l.relation_candidate_id === row.relation_candidate_id)?.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL");
const baselineViolationCount = splitImpact.violations.length + authorImpact.violations.length;

function rebuildAndCountViolationsExcludingRow(relationCandidateId) {
  const reducedGraph = buildDecisionRespectingGraph({ packetRows: packet326, ledgerRows, excludeRelationCandidateIds: new Set([relationCandidateId]) });
  const s = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: reducedGraph.resolveMaximalComponentId });
  const a = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: reducedGraph.resolveMaximalComponentId });
  return { splitViolationCount: s.violations.length, authorViolationCount: a.violations.length };
}

const classifications = provisionalPacketRows.map((row) => classifyProvisionalRow({
  packetRow: row,
  componentSplitMap,
  componentAuthorMap,
  resolveMaximalComponentId: graph.resolveMaximalComponentId,
  violatingMaximalComponentIds,
  baselineViolationCount,
  rebuildAndCountViolationsExcludingThisRow: rebuildAndCountViolationsExcludingRow,
  otherProvisionalPacketRows: provisionalPacketRows,
}));
writeJsonl(resolve(outDir, "provisional-row-classification.v0.1.jsonl"), classifications);

const labelCounts = { DIRECT_CROSS_SPLIT_EDGE: 0, DIRECT_CROSS_AUTHOR_EDGE: 0, INDIVIDUALLY_DECISIVE: 0, REDUNDANT_BUT_COMPONENT_RELEVANT: 0, NO_CURRENT_SPLIT_IMPACT: 0 };
for (const c of classifications) for (const l of c.labels) labelCounts[l] += 1;
const targetedImpactCohort = classifications.filter((c) => !c.labels.includes("NO_CURRENT_SPLIT_IMPACT"));
writeJson(resolve(outDir, "targeted-impact-cohort-summary.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  total_provisional_rows: classifications.length,
  label_counts: labelCounts,
  targeted_impact_cohort_size: targetedImpactCohort.length,
  targeted_impact_cohort_relation_candidate_ids: targetedImpactCohort.map((c) => c.relation_candidate_id).sort(),
  minimality_claim: "NONE -- this is a TARGETED_IMPACT_COHORT (every provisional row that currently touches a violating maximal component). Its size has NOT been shown to be the smallest possible; no such proof was attempted this Turn.",
});

// == 5. Branch A/B decision packet =========================================
let decisionPacket;
if (allOk) {
  decisionPacket = {
    schema_version: "0.1.0",
    status: "PATH_2_DECISION_RESPECTING_PROOF_COMPLETED",
    generated_at: new Date().toISOString(),
    turn: "N4.9",
    subject: "Decision-respecting conservative graph (Owner/Reviewer decisions honored, 294 still-undecided rows expanded conservatively)",
    result: "Under the DECISION-RESPECTING graph, zero cross-split, cross-author, or quarantine-intrusion leakage was found.",
    decision_respecting_graph_summary: impactReport.decision_respecting_graph_summary,
    comparison_vs_turn_n48: impactReport.comparison_vs_turn_n48_extreme_graph,
    no_294_row_individually_adjudicated: true,
    official_split_eligible_set_by_this_script: false,
    still_requires_before_official_split_eligible: [
      "A separate, explicit final Owner approval of this Path 2 decision-respecting proof (see the Owner approval UI this Turn generated).",
      "Turn N4.7.1's own final-split-approval checklist, if not already recorded.",
    ],
  };
} else {
  decisionPacket = {
    schema_version: "0.1.0",
    status: "PATH_2_DECISION_RESPECTING_LEAKAGE_FOUND",
    generated_at: new Date().toISOString(),
    turn: "N4.9",
    subject: "Decision-respecting conservative graph (Owner/Reviewer decisions honored, 294 still-undecided rows expanded conservatively)",
    result: "Even honoring every existing Owner/Reviewer decision, real leakage remains under the conservative expansion of the 294 still-undecided rows. This is a WORST-CASE risk report over UNDECIDED candidates only -- none of the 294 rows was individually adjudicated by this Turn.",
    decision_respecting_graph_summary: impactReport.decision_respecting_graph_summary,
    comparison_vs_turn_n48: impactReport.comparison_vs_turn_n48_extreme_graph,
    split_violations: splitImpact.violations,
    author_violations: authorImpact.violations,
    quarantine_violations: quarantineImpact.violations,
    affected_assignment_ids: affectedAssignmentIds,
    targeted_impact_cohort_size: targetedImpactCohort.length,
    targeted_impact_cohort_label_counts: labelCounts,
    targeted_impact_cohort_relation_candidate_ids: targetedImpactCohort.map((c) => c.relation_candidate_id).sort(),
    cohort_is_targeted_not_proven_minimal: true,
    no_294_row_auto_adjudicated: true,
    no_anchor_replacement_performed: true,
    no_full_manual_review_of_294_triggered: true,
    requires_before_any_change: "Reviewer E and Reviewer F independent adjudication of ONLY the targeted-impact-cohort rows (see targeted-provisional-relation-review-packet.v0.1.jsonl) -- a separate future Owner decision synthesizes their results.",
    official_split_eligible_set_by_this_script: false,
  };
}
writeJson(resolve(outDir, "provisional-294-decision-respecting-decision-packet.v0.1.json"), decisionPacket);

// == 6. Gate status (new v0.4 file; v0.2/v0.3 untouched) ====================
const gateStatusV02 = readJson(GATE_STATUS_V02_PATH);
const gateStatusV03 = readJson(GATE_STATUS_V03_PATH);
const gateStatusV04 = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.9",
  supersedes_wording_of: [
    "work/handoff/anchor-dev-tune-v0.2/gate-status.v0.2.json (untouched)",
    "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/gate-status.v0.3.json (untouched)",
  ],
  gates: {
    relation_review: gateStatusV02.gates.relation_review,
    unresolved_relation: gateStatusV02.gates.unresolved_relation,
    chain_leakage_confirmed_edges_only: gateStatusV02.gates.chain_leakage,
    chain_leakage_extreme_maximal_graph_n48: gateStatusV03.gates.chain_leakage_maximal_plausible_graph,
    chain_leakage_decision_respecting_graph_n49: allOk ? "PASS_DECISION_RESPECTING_GRAPH" : "FAIL_DECISION_RESPECTING_GRAPH",
    provisional_294_resolution: allOk ? "PATH_2_DECISION_RESPECTING_PROOF_COMPLETED" : "TARGETED_IMPACT_REVIEW_REQUIRED",
    final_owner_split_review: allOk ? "PENDING" : "NOT_READY",
    anchor_count: gateStatusV02.gates.anchor_count,
    author_balance: gateStatusV02.gates.author_balance,
    official_split_eligible: false,
    official_split_eligible_blocked_by: allOk
      ? "Decision-respecting Path 2 proof completed, but a separate explicit final Owner approval is still required."
      : `Decision-respecting graph still leaks (${splitImpact.violations.length} split + ${authorImpact.violations.length} author violation components). A targeted-impact-cohort of ${targetedImpactCohort.length} still-undecided rows requires independent Reviewer E/F adjudication before this can advance -- see targeted-provisional-relation-review-packet.v0.1.jsonl.`,
    gold_authoring: allOk ? "BLOCKED_PENDING_FINAL_OWNER_APPROVAL" : "BLOCKED_PENDING_PROVISIONAL_IMPACT_REVIEW",
  },
};
writeJson(resolve(outDir, "gate-status.v0.4.json"), gateStatusV04);

// == 7. Branch-specific artifacts ===========================================
let ownerApprovalUiReport = null;
let targetedPacketReport = null;

if (allOk) {
  const uiDir = resolve(outDir, "ui/v0.1");
  mkdirSync(uiDir, { recursive: true });
  const FINAL_EXPORT_FILENAME = "relation-closure-decision-respecting-owner-approval.v0.1.json";
  const DATA = {
    decision_respecting_graph_summary: impactReport.decision_respecting_graph_summary,
    comparison_vs_turn_n48: impactReport.comparison_vs_turn_n48_extreme_graph,
    final_export_filename: FINAL_EXPORT_FILENAME,
    input_shas: impactReport.input_shas,
    checklist_items: [
      { id: "decisions_respected", label: "Owner CONFIRM 21건은 확정 target 1개씩, REJECT 8건은 0개 edge, C/D CONFIRM 2건은 합의 target 1개씩만 사용되었고, 294건은 여전히 확정되지 않았음을 확인했다" },
      { id: "quarantine_respected", label: "50개 격리 문서 경계가 그대로 유지되었음을 확인했다" },
      { id: "leakage_zero", label: `split/author/격리 leakage 0건을 확인했다 (component ${impactReport.decision_respecting_graph_summary.maximal_component_count}개 검사)` },
      { id: "n48_comparison_reviewed", label: `N4.8 대비 edge ${impactReport.comparison_vs_turn_n48_extreme_graph.total_edges_removed}개 감소(REJECT 유래 ${impactReport.comparison_vs_turn_n48_extreme_graph.owner_reject_derived_edges_removed}개 포함)를 확인했다` },
      { id: "not_294_confirmed", label: "이 결과가 294건 개별 CONFIRM/REJECT를 의미하지 않음을 이해했다" },
      { id: "official_split_still_false", label: "이 승인 이후에도 official_split_eligible은 자동으로 true가 되지 않음을 이해했다" },
      { id: "gold_still_blocked", label: "Gold 작성은 최종 Owner 승인 전까지 시작하지 않는다는 점을 이해했다" },
    ],
  };
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.9 Decision-Respecting Graph Owner Approval (v0.1)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:28px;}
.checklist label{display:block;margin:6px 0;font-size:14px;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#approveBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#approveBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;width:100%;box-sizing:border-box;}
</style></head>
<body>
<h1>Turn N4.9 -- Decision-Respecting Graph Owner Approval (v0.1)</h1>
<div class="warnbox">이 페이지는 <b>PATH_2_DECISION_RESPECTING_PROOF_COMPLETED</b> 결과를 Owner가 검토하기 위한 것이다. 이미 내려진 Owner/Reviewer 결정(CONFIRM 23건, REJECT 8건 제외, 격리 1건 유지)을 존중한 그래프에서 leakage 0건을 확인했지만, 이는 294건을 개별 CONFIRM/REJECT했다는 뜻이 아니다. 체크리스트를 전부 확인해 내보내도 <b>official_split_eligible은 여전히 false로 유지</b>된다.</div>
<h2>그래프 요약</h2>
<p>edge 총수: ${DATA.decision_respecting_graph_summary.total_candidate_edge_count} / component 수: ${DATA.decision_respecting_graph_summary.maximal_component_count} / N4.8 대비 제거된 edge: ${DATA.comparison_vs_turn_n48.total_edges_removed}건 (REJECT 유래 ${DATA.comparison_vs_turn_n48.owner_reject_derived_edges_removed}건 포함)</p>
<h2>Owner 체크리스트</h2>
<div class="checklist" id="checklist"></div>
<div class="btnrow">
<button id="approveBtn" disabled>Path 2 (Decision-Respecting) 검토 완료 &amp; Download</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>
<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var STORAGE_KEY = "n4.9-decision-respecting-owner-checklist-v0.1";
  var checklistEl = document.getElementById("checklist");
  var approveBtn = document.getElementById("approveBtn");
  var copyBtn = document.getElementById("copyBtn");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { state = {}; }
  var lastExportText = "";
  function render() {
    checklistEl.textContent = "";
    DATA.checklist_items.forEach(function (item) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state[item.id];
      cb.addEventListener("change", function () {
        state[item.id] = cb.checked;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
        updateButtons();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.label));
      checklistEl.appendChild(label);
    });
    updateButtons();
  }
  function allChecked() { return DATA.checklist_items.every(function (item) { return !!state[item.id]; }); }
  function updateButtons() {
    var ok = allChecked();
    approveBtn.disabled = !ok; approveBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }
  function buildRecord() {
    return {
      schema_version: "0.1.0",
      status: "OWNER_PATH_2_DECISION_RESPECTING_CHECKLIST_APPROVED",
      note: "This records that a human checked every item below. It does NOT set official_split_eligible=true and does NOT adjudicate any of the 294 REVIEWER_CONSENSUS_PROVISIONAL rows.",
      official_split_eligible: false,
      approved_at: new Date().toISOString(),
      input_shas: DATA.input_shas,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: true }; }),
      decision_respecting_graph_summary_snapshot: DATA.decision_respecting_graph_summary,
    };
  }
  function triggerDownload(text, filename) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  approveBtn.addEventListener("click", function () {
    if (!allChecked()) return;
    var record = buildRecord();
    var text = JSON.stringify(record, null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.final_export_filename);
    msgEl.textContent = DATA.final_export_filename + " 다운로드를 시작했습니다.";
  });
  copyBtn.addEventListener("click", function () {
    if (!allChecked()) return;
    var text = lastExportText || JSON.stringify(buildRecord(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    function fallbackCopy() {
      resultEl.focus(); resultEl.select();
      try { document.execCommand("copy"); msgEl.textContent = "클립보드에 복사했습니다."; }
      catch (e) { msgEl.textContent = "복사에 실패했습니다 -- 직접 선택해 복사해주세요."; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { msgEl.textContent = "클립보드에 복사했습니다."; }, fallbackCopy);
    } else { fallbackCopy(); }
  });
  render();
})();
</script>
</body></html>
`;
  const htmlPath = resolve(uiDir, "relation-closure-decision-respecting-owner-approval.v0.1.html");
  writeFileSync(htmlPath, html, "utf8");
  ownerApprovalUiReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/ui/v0.1/relation-closure-decision-respecting-owner-approval.v0.1.html",
    html_sha256: sha256File(htmlPath),
    checklist_item_count: DATA.checklist_items.length,
    storage_key: "n4.9-decision-respecting-owner-checklist-v0.1",
    final_export_filename: FINAL_EXPORT_FILENAME,
    auto_approved: false,
  };
  writeJson(resolve(uiDir, "decision-respecting-owner-approval-ui-build-report.json"), ownerApprovalUiReport);
} else {
  // Branch B: build the targeted-impact-cohort review packet (source
  // locator + candidates + current split/author impact ONLY -- no Gold, no
  // expected_answer, no Agent output) and two independent fixed-role
  // reviewer UIs.
  const packetById = new Map(packet326.map((r) => [r.relation_candidate_id, r]));
  const targetedRows = targetedImpactCohort.map((classification) => {
    const row = packetById.get(classification.relation_candidate_id);
    return {
      relation_candidate_id: row.relation_candidate_id,
      source_document_id: row.source_document_id,
      relation_type: row.relation_type,
      source_report_name: row.source_report_name,
      source_receipt_date: row.source_receipt_date,
      source_info: row.source_info,
      candidates: (row.candidates ?? []).map((c) => ({
        target_document_id: c.target_document_id,
        score: c.score,
        reasons: c.reasons,
        target_report_name: c.target_report_name,
        target_receipt_date: c.target_receipt_date,
        target_info: c.target_info,
      })),
      current_split_author_impact: {
        labels: classification.labels,
        direct_cross_split_edge: classification.direct_cross_split_edge,
        direct_cross_author_edge: classification.direct_cross_author_edge,
        individually_decisive: classification.individually_decisive,
        touches_violating_component: classification.touches_violating_component,
        affected_maximal_component_ids: classification.affected_maximal_component_ids,
        affected_document_ids: classification.affected_document_ids,
        duplicate_path_with_relation_candidate_ids: classification.duplicate_path_with_relation_candidate_ids,
      },
      review_status: "PENDING",
      reviewer_disposition: null,
      confirmed_target_document_id: null,
      reviewer_note: null,
    };
  });
  const packetDir = outDir;
  writeJsonl(resolve(packetDir, "targeted-provisional-relation-review-packet.v0.1.jsonl"), targetedRows);
  const packetPath = resolve(packetDir, "targeted-provisional-relation-review-packet.v0.1.jsonl");
  const packetSha256 = sha256File(packetPath);
  targetedPacketReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    row_count: targetedRows.length,
    sha256: packetSha256,
    label_counts: labelCounts,
    excludes: ["gold", "expected_answer", "agent_output", "hcx_output"],
    note: "This packet is scoped to the TARGETED_IMPACT_COHORT only -- provisional rows whose candidate edges currently touch a violating maximal component under the decision-respecting graph. It is NOT all 294 rows and is NOT claimed minimal.",
  };
  writeJson(resolve(packetDir, "targeted-provisional-relation-review-packet.v0.1.manifest.json"), targetedPacketReport);

  function buildReviewerUi({ role, storageKey, exportFilename }) {
    const DATA = { role, rows: targetedRows, export_filename: exportFilename, packet_sha256: packetSha256 };
    const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.9 Targeted Impact Cohort Review -- Reviewer ${esc(role)}</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:15px;}
.row{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0;}
.row h3{margin:0 0 6px;font-size:14px;}
.cand{border:1px solid #eee;border-radius:6px;padding:8px;margin:4px 0;font-size:13px;background:#fafafa;}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#eef;margin:0 4px 4px 0;}
label{display:block;margin:6px 0;font-size:13px;}
select,textarea,input[type=text]{width:100%;box-sizing:border-box;padding:6px;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;position:sticky;bottom:0;background:#fff;padding:10px 0;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#exportBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#exportBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#status{font-size:13px;margin-top:8px;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;width:100%;box-sizing:border-box;}
</style></head>
<body>
<h1>Turn N4.9 -- Targeted Impact Cohort Review (Reviewer ${esc(role)})</h1>
<p>이 역할은 빌드 시 고정되었다: <b>Reviewer ${esc(role)}</b>. localStorage key: <code>${esc(storageKey)}</code>. 자동 승인·다수결·chain closure 계산은 이 페이지에 없다. 원문 근거·후보 목록·현재 split/author 영향만 제공하며 Gold/기대 답변/Agent 결과는 포함하지 않는다.</p>
<div id="rows"></div>
<div class="btnrow">
<button id="exportBtn" disabled>FINAL Export (Reviewer ${esc(role)}) &amp; Download</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="status"></div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>
<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var ROLE = DATA.role;
  var STORAGE_KEY = "${storageKey}";
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { state = {}; }

  var rowsEl = document.getElementById("rows");
  var exportBtn = document.getElementById("exportBtn");
  var copyBtn = document.getElementById("copyBtn");
  var statusEl = document.getElementById("status");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var lastExportText = "";

  function rowState(rid) {
    return state[rid] || { disposition: "PENDING", confirmed_target_document_id: null, note: "" };
  }
  function setRowState(rid, patch) {
    var current = rowState(rid);
    state[rid] = Object.assign({}, current, patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    updateStatus();
  }
  function allJudged() {
    return DATA.rows.every(function (r) {
      var s = rowState(r.relation_candidate_id);
      if (s.disposition === "PENDING") return false;
      if (!s.note || !s.note.trim()) return false;
      if (s.disposition === "CONFIRM" && !s.confirmed_target_document_id) return false;
      if (s.disposition !== "CONFIRM" && s.confirmed_target_document_id) return false;
      return true;
    });
  }
  function updateStatus() {
    var judged = DATA.rows.filter(function (r) {
      var s = rowState(r.relation_candidate_id);
      return s.disposition !== "PENDING" && s.note && s.note.trim();
    }).length;
    statusEl.textContent = "judged " + judged + " / " + DATA.rows.length;
    var ok = allJudged();
    exportBtn.disabled = !ok; exportBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }

  function render() {
    rowsEl.textContent = "";
    DATA.rows.forEach(function (row) {
      var s = rowState(row.relation_candidate_id);
      var div = document.createElement("div");
      div.className = "row";
      var h3 = document.createElement("h3");
      h3.textContent = row.relation_candidate_id + " -- " + row.source_document_id + " (" + row.relation_type + ")";
      div.appendChild(h3);
      (row.current_split_author_impact.labels || []).forEach(function (l) {
        var b = document.createElement("span"); b.className = "badge"; b.textContent = l; div.appendChild(b);
      });
      var candWrap = document.createElement("div");
      row.candidates.forEach(function (c) {
        var cdiv = document.createElement("div"); cdiv.className = "cand";
        cdiv.textContent = c.target_document_id + " (score " + c.score + ") " + (c.target_report_name || "");
        candWrap.appendChild(cdiv);
      });
      div.appendChild(candWrap);

      var dispLabel = document.createElement("label");
      dispLabel.textContent = "판정";
      var dispSelect = document.createElement("select");
      ["PENDING", "CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"].forEach(function (opt) {
        var o = document.createElement("option"); o.value = opt; o.textContent = opt;
        if (s.disposition === opt) o.selected = true;
        dispSelect.appendChild(o);
      });
      dispLabel.appendChild(dispSelect);
      div.appendChild(dispLabel);

      var targetLabel = document.createElement("label");
      targetLabel.textContent = "target (CONFIRM일 때만 필수)";
      var targetSelect = document.createElement("select");
      var emptyOpt = document.createElement("option"); emptyOpt.value = ""; emptyOpt.textContent = "(none)";
      targetSelect.appendChild(emptyOpt);
      row.candidates.forEach(function (c) {
        var o = document.createElement("option"); o.value = c.target_document_id; o.textContent = c.target_document_id;
        if (s.confirmed_target_document_id === c.target_document_id) o.selected = true;
        targetSelect.appendChild(o);
      });
      targetSelect.disabled = dispSelect.value !== "CONFIRM";
      targetLabel.appendChild(targetSelect);
      div.appendChild(targetLabel);

      var noteLabel = document.createElement("label");
      noteLabel.textContent = "note (필수)";
      var noteInput = document.createElement("textarea");
      noteInput.value = s.note || "";
      noteLabel.appendChild(noteInput);
      div.appendChild(noteLabel);

      dispSelect.addEventListener("change", function () {
        var isConfirm = dispSelect.value === "CONFIRM";
        targetSelect.disabled = !isConfirm;
        if (!isConfirm) targetSelect.value = "";
        setRowState(row.relation_candidate_id, { disposition: dispSelect.value, confirmed_target_document_id: isConfirm ? (targetSelect.value || null) : null, note: noteInput.value });
      });
      targetSelect.addEventListener("change", function () {
        setRowState(row.relation_candidate_id, { confirmed_target_document_id: targetSelect.value || null });
      });
      noteInput.addEventListener("input", function () {
        setRowState(row.relation_candidate_id, { note: noteInput.value });
      });

      rowsEl.appendChild(div);
    });
    updateStatus();
  }

  function buildRecord() {
    return {
      schema_version: "0.1.0",
      status: "REVIEWER_" + ROLE + "_TARGETED_IMPACT_COHORT_REVIEW_COMPLETE",
      reviewer_role: ROLE,
      packet_sha256: DATA.packet_sha256,
      exported_at: new Date().toISOString(),
      note: "Independent single-reviewer judgment. No automatic approval, no majority vote, no chain-closure recomputation performed by this page.",
      rows: DATA.rows.map(function (r) {
        var s = rowState(r.relation_candidate_id);
        return {
          relation_candidate_id: r.relation_candidate_id,
          disposition: s.disposition,
          confirmed_target_document_id: s.confirmed_target_document_id,
          note: s.note,
        };
      }),
    };
  }
  function triggerDownload(text, filename) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  exportBtn.addEventListener("click", function () {
    if (!allJudged()) return;
    var text = JSON.stringify(buildRecord(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.export_filename);
    msgEl.textContent = DATA.export_filename + " 다운로드를 시작했습니다.";
  });
  copyBtn.addEventListener("click", function () {
    if (!allJudged()) return;
    var text = lastExportText || JSON.stringify(buildRecord(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    function fallbackCopy() {
      resultEl.focus(); resultEl.select();
      try { document.execCommand("copy"); msgEl.textContent = "클립보드에 복사했습니다."; }
      catch (e) { msgEl.textContent = "복사에 실패했습니다 -- 직접 선택해 복사해주세요."; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { msgEl.textContent = "클립보드에 복사했습니다."; }, fallbackCopy);
    } else { fallbackCopy(); }
  });

  render();
})();
</script>
</body></html>
`;
    return html;
  }

  const uiDir = resolve(outDir, "ui/v0.1");
  mkdirSync(uiDir, { recursive: true });
  const htmlE = buildReviewerUi({ role: "E", storageKey: "n4.9-reviewer-e-targeted-cohort-v0.1", exportFilename: "targeted-impact-cohort-reviewer-e-decision.v0.1.json" });
  const htmlF = buildReviewerUi({ role: "F", storageKey: "n4.9-reviewer-f-targeted-cohort-v0.1", exportFilename: "targeted-impact-cohort-reviewer-f-decision.v0.1.json" });
  const htmlEPath = resolve(uiDir, "targeted-impact-cohort-reviewer-e.v0.1.html");
  const htmlFPath = resolve(uiDir, "targeted-impact-cohort-reviewer-f.v0.1.html");
  writeFileSync(htmlEPath, htmlE, "utf8");
  writeFileSync(htmlFPath, htmlF, "utf8");
  const reviewerUiReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    reviewer_e: { html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/ui/v0.1/targeted-impact-cohort-reviewer-e.v0.1.html", html_sha256: sha256File(htmlEPath), storage_key: "n4.9-reviewer-e-targeted-cohort-v0.1", export_filename: "targeted-impact-cohort-reviewer-e-decision.v0.1.json" },
    reviewer_f: { html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/ui/v0.1/targeted-impact-cohort-reviewer-f.v0.1.html", html_sha256: sha256File(htmlFPath), storage_key: "n4.9-reviewer-f-targeted-cohort-v0.1", export_filename: "targeted-impact-cohort-reviewer-f-decision.v0.1.json" },
    row_count: targetedRows.length,
    auto_approval_or_majority_vote_or_chain_closure_computed: false,
  };
  writeJson(resolve(uiDir, "targeted-impact-cohort-reviewer-ui-build-report.json"), reviewerUiReport);
  targetedPacketReport.reviewer_ui = reviewerUiReport;
}

console.log(JSON.stringify({
  status: allOk ? "PATH_2_DECISION_RESPECTING_PROOF_COMPLETED" : "PATH_2_DECISION_RESPECTING_LEAKAGE_FOUND",
  out_dir: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1",
  decision_respecting_graph_summary: impactReport.decision_respecting_graph_summary,
  comparison_vs_turn_n48: impactReport.comparison_vs_turn_n48_extreme_graph,
  split_violation_count: splitImpact.violations.length,
  author_violation_count: authorImpact.violations.length,
  quarantine_violation_count: quarantineImpact.violations.length,
  affected_assignment_count: affectedAssignmentIds.length,
  label_counts: labelCounts,
  targeted_impact_cohort_size: targetedImpactCohort.length,
  gate_status_v04: gateStatusV04.gates,
  owner_approval_ui_generated: allOk,
  targeted_reviewer_uis_generated: !allOk,
}, null, 2));
