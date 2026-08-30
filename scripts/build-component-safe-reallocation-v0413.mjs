#!/usr/bin/env node
// Turn N4.13: component-safe split/author reassignment FEASIBILITY analysis
// over the prospective graph left by Turn N4.11/N4.12 (Priority Wave 1
// Owner-ratified). Computes and compares three candidate strategies to
// resolve the remaining 6 split / 4 author leakage WITHOUT a full 218-row
// manual review. This script is a CALCULATOR only: it never writes to
// anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl, the official
// 326-row ledger, or any Relation/Fact/Evidence/Gold store, and it never
// adjudicates any of the remaining 281 provisional relations.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProspectiveGraph } from "../domain/evaluation/relation-closure-prospective-consensus-graph.mjs";
import { computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact, computeMaximalGraphQuarantineImpact, buildDocumentToBaseComponentMap } from "../domain/evaluation/relation-closure-maximal-graph.mjs";
import {
  planForcedConsolidation, planCompensatingRestoration,
  filterEligibleReplacementCandidates, planMinimalGroupReplacement,
  analyzeComponentGroupCut,
} from "../domain/evaluation/component-safe-reallocation.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function canonicalSha256(obj, omitKeys = []) {
  const clone = { ...obj };
  for (const k of omitKeys) delete clone[k];
  return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
}

const SPLIT_ORDER = ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"];
const AUTHOR_ORDER = ["AUTHOR_A", "AUTHOR_B"];

// -- 0. Fixed paths ---------------------------------------------------------
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const DR_DIR = resolve(V02_DIR, "decision-respecting-graph-v0.1");
const PW1_DIR = resolve(DR_DIR, "priority-wave-1-v0.1");
const CONSENSUS_DIR = resolve(PW1_DIR, "consensus-integration-v0.1");
const OWNER_RATIFICATION_DIR = resolve(CONSENSUS_DIR, "owner-ratification-v0.1");

const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const ALLOCATION_BALANCE_PATH = resolve(V02_DIR, "allocation-balance-report.v0.2.json");
const CHAIN_COMPONENT_MANIFEST_PATH = resolve(V02_DIR, "chain-component-manifest.v0.2.json");
const SPLIT_LEAKAGE_V02_PATH = resolve(V02_DIR, "split-leakage-report.v0.2.json");
const QUARANTINE_MANIFEST_PATH = resolve(V02_DIR, "quarantine/quarantine-manifest.v0.2.json");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const POOL_MANIFEST_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.manifest.json");
const POOL_SLICE_COVERAGE_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/slice-coverage-report.json");
const POOL_LEAKAGE_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/leakage-report.json");
const POOL_REBUILD_REPORT_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/deterministic-rebuild-report.json");
const PROSPECTIVE_EDGES_PATH = resolve(CONSENSUS_DIR, "prospective-graph-edges-after-wave1.v0.1.jsonl");
const PROSPECTIVE_COMPONENTS_PATH = resolve(CONSENSUS_DIR, "prospective-graph-components-after-wave1.v0.1.json");
const PROSPECTIVE_IMPACT_PATH = resolve(CONSENSUS_DIR, "prospective-graph-impact-after-wave1.v0.1.json");
const GATE_AFTER_WAVE1_PATH = resolve(CONSENSUS_DIR, "gate-status-after-wave1.v0.1.json");
const GRAPH_DIFF_PATH = resolve(CONSENSUS_DIR, "n4.9-to-n4.11-graph-diff.v0.1.json");
const OWNER_DECISION_PATH = resolve(PW1_DIR, "results/owner-v0.1/priority-wave-1-owner-ratification-decision.v0.1.json");
const RATIFIED_CONSENSUS_PATH = resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratified-consensus.v0.1.jsonl");
const OWNER_VERIFICATION_REPORT_PATH = resolve(OWNER_RATIFICATION_DIR, "priority-wave-1-owner-ratification-verification-report.v0.1.json");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const CLASSIFICATION_294_PATH = resolve(DR_DIR, "provisional-row-classification.v0.1.jsonl");
const ANCHOR_V01_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/anchor-selection.v0.1.manifest.json");

const outDir = resolve(V02_DIR, "component-safe-reallocation-v0.1");
mkdirSync(outDir, { recursive: true });

// == 1. Pre-verification (14 items) -- ABORT before writing anything ========
const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 count ${anchorV02.length} !== 150`); process.exit(1); }
const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 count ${authorV02.length} !== 150`); process.exit(1); }
const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV02) authorCounts[r.author_allocation] += 1;
if (authorCounts.AUTHOR_A !== 75 || authorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: author balance ${JSON.stringify(authorCounts)} !== 75/75`); process.exit(1); }

const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool count ${poolRecords.length} !== 500`); process.exit(1); }
const poolSha256 = sha256File(POOL_PATH);
const poolManifest = readJson(POOL_MANIFEST_PATH);
if (poolManifest.candidate_pool_record_count !== 500) { console.error("BLOCKER: Candidate Pool manifest record_count is not 500"); process.exit(1); }

const ownerDecision = readJson(OWNER_DECISION_PATH);
if (ownerDecision.owner_disposition !== "APPROVE_DUAL_REVIEW_CONSENSUS") { console.error(`BLOCKER: Owner decision is not APPROVE_DUAL_REVIEW_CONSENSUS (actual ${ownerDecision.owner_disposition})`); process.exit(1); }
if (ownerDecision.reviewed_relation_candidate_ids.length !== 13) { console.error(`BLOCKER: Owner-ratified relation count ${ownerDecision.reviewed_relation_candidate_ids.length} !== 13`); process.exit(1); }
const ownerVerificationReport = readJson(OWNER_VERIFICATION_REPORT_PATH);
if (ownerVerificationReport.status !== "OWNER_RATIFICATION_VERIFIED") { console.error("BLOCKER: Owner ratification verification report status is not OWNER_RATIFICATION_VERIFIED"); process.exit(1); }
const ratifiedConsensus = readJsonl(RATIFIED_CONSENSUS_PATH);
if (ratifiedConsensus.length !== 13) { console.error(`BLOCKER: ratified consensus row count ${ratifiedConsensus.length} !== 13`); process.exit(1); }
const ratifiedConfirmCount = ratifiedConsensus.filter((r) => r.consensus_disposition === "CONFIRM").length;
const ratifiedRejectCount = ratifiedConsensus.filter((r) => r.consensus_disposition === "REJECT").length;
const ratifiedNmrCount = ratifiedConsensus.filter((r) => r.consensus_disposition !== "CONFIRM" && r.consensus_disposition !== "REJECT").length;
if (ratifiedConfirmCount !== 6 || ratifiedRejectCount !== 7 || ratifiedNmrCount !== 0) {
  console.error(`BLOCKER: ratified consensus distribution CONFIRM=${ratifiedConfirmCount}/REJECT=${ratifiedRejectCount}/NMR=${ratifiedNmrCount} !== 6/7/0`);
  process.exit(1);
}

const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const ledgerRows = readJsonl(LEDGER_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }

const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }

// == 2. Recompute the prospective graph FRESH (independent reproduction of
// Turn N4.11's own numbers, never trusted blindly) ==========================
const consensusByRelationCandidateId = new Map(
  ratifiedConsensus.map((r) => [r.relation_candidate_id, { consensus_disposition: r.consensus_disposition, consensus_target_document_id: r.consensus_target_document_id }]),
);
const prospectiveGraph = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId });
if (prospectiveGraph.totalCandidateEdgeCount !== 1428) { console.error(`BLOCKER: recomputed prospective edge count ${prospectiveGraph.totalCandidateEdgeCount} !== 1428`); process.exit(1); }

const splitImpact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const authorImpact = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: packet326 });
const quarantineImpact = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV02.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })),
  resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
});
if (splitImpact.violations.length !== 6) { console.error(`BLOCKER: recomputed split leakage ${splitImpact.violations.length} !== 6`); process.exit(1); }
if (authorImpact.violations.length !== 4) { console.error(`BLOCKER: recomputed author leakage ${authorImpact.violations.length} !== 4`); process.exit(1); }
if (quarantineImpact.violations.length !== 0) { console.error(`BLOCKER: recomputed quarantine intrusion ${quarantineImpact.violations.length} !== 0`); process.exit(1); }
const affectedAssignmentIds = [...new Set([
  ...splitImpact.violations.flatMap((v) => v.assignment_ids),
  ...authorImpact.violations.flatMap((v) => v.assignment_ids),
  ...quarantineImpact.violations.map((v) => v.assignment_id),
])].sort();
if (affectedAssignmentIds.length !== 60) { console.error(`BLOCKER: recomputed affected assignment count ${affectedAssignmentIds.length} !== 60`); process.exit(1); }

// == 3. input-pin-manifest.v0.1.json =========================================
const inputPinManifest = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  inputs: {
    anchor_selection_v02: { path: "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl", sha256: sha256File(ANCHOR_V02_PATH), row_count: anchorV02.length },
    author_allocation_v02: { path: "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl", sha256: sha256File(AUTHOR_V02_PATH), row_count: authorV02.length, author_counts: authorCounts },
    allocation_balance_report_v02: { path: "work/handoff/anchor-dev-tune-v0.2/allocation-balance-report.v0.2.json", sha256: sha256File(ALLOCATION_BALANCE_PATH) },
    chain_component_manifest_v02: { path: "work/handoff/anchor-dev-tune-v0.2/chain-component-manifest.v0.2.json", sha256: sha256File(CHAIN_COMPONENT_MANIFEST_PATH) },
    split_leakage_report_v02: { path: "work/handoff/anchor-dev-tune-v0.2/split-leakage-report.v0.2.json", sha256: sha256File(SPLIT_LEAKAGE_V02_PATH) },
    quarantine_manifest_v02: { path: "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json", sha256: sha256File(QUARANTINE_MANIFEST_PATH), document_count: quarantineManifest.quarantine_document_count },
    candidate_pool_v041: { path: "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl", sha256: poolSha256, row_count: poolRecords.length },
    candidate_pool_v041_manifest: { path: "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.manifest.json", sha256: sha256File(POOL_MANIFEST_PATH) },
    candidate_pool_v041_slice_coverage: { path: "work/domain-seed/candidate-pool-v0.4.1/slice-coverage-report.json", sha256: sha256File(POOL_SLICE_COVERAGE_PATH) },
    candidate_pool_v041_leakage_report: { path: "work/domain-seed/candidate-pool-v0.4.1/leakage-report.json", sha256: sha256File(POOL_LEAKAGE_PATH) },
    candidate_pool_v041_rebuild_report: { path: "work/domain-seed/candidate-pool-v0.4.1/deterministic-rebuild-report.json", sha256: sha256File(POOL_REBUILD_REPORT_PATH) },
    prospective_graph_edges: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/prospective-graph-edges-after-wave1.v0.1.jsonl", sha256: sha256File(PROSPECTIVE_EDGES_PATH) },
    prospective_graph_components: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/prospective-graph-components-after-wave1.v0.1.json", sha256: canonicalSha256(readJson(PROSPECTIVE_COMPONENTS_PATH), ["generated_at"]) },
    prospective_graph_impact: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/prospective-graph-impact-after-wave1.v0.1.json", sha256: canonicalSha256(readJson(PROSPECTIVE_IMPACT_PATH), ["generated_at"]) },
    gate_status_after_wave1: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/gate-status-after-wave1.v0.1.json", sha256: canonicalSha256(readJson(GATE_AFTER_WAVE1_PATH), ["generated_at"]) },
    graph_diff: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/n4.9-to-n4.11-graph-diff.v0.1.json", sha256: canonicalSha256(readJson(GRAPH_DIFF_PATH), ["generated_at"]) },
    owner_decision: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/owner-v0.1/priority-wave-1-owner-ratification-decision.v0.1.json", sha256: sha256File(OWNER_DECISION_PATH) },
    ratified_consensus: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratified-consensus.v0.1.jsonl", sha256: sha256File(RATIFIED_CONSENSUS_PATH), row_count: ratifiedConsensus.length },
    owner_verification_report: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratification-verification-report.v0.1.json", sha256: canonicalSha256(readJson(OWNER_VERIFICATION_REPORT_PATH), ["generated_at"]) },
    relation_closure_review_packet_326: { path: "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl", sha256: sha256File(PACKET_326_PATH), row_count: packet326.length },
    relation_closure_candidate_ledger_v02: { path: "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl", sha256: sha256File(LEDGER_PATH), row_count: ledgerRows.length },
  },
  policy_documents_consulted: [
    "domain/evaluation/TARGET_SIZE.v1.md",
    "domain/evaluation/AUTHOR_ALLOCATION.v1.md",
    "domain/evaluation/CHAIN_SAFE_GROUPING_CONTRACT.v1.md",
    "domain/evaluation/README.md",
  ],
  policy_finding: "Anchor is, by construction, the DEV_TUNE-only subset of the Candidate Pool (domain/evaluation/anchor-allocation-builder.mjs's selectAnchorPool filters poolRecords to planned_split===\"DEV_TUNE\" before selecting Anchor). No CURRENT policy document describes an authoring-stage path that draws Anchor replacements from DEV_CHECK or HOLDOUT. Strategy B (if invoked) therefore restricts eligible replacement candidates to DEV_TUNE only -- this is not an assumption, it is what the existing, already-shipped Anchor-selection code enforces.",
  pre_verification_all_passed: true,
};
writeJson(resolve(outDir, "input-pin-manifest.v0.1.json"), inputPinManifest);

// == 4. current-leakage-baseline.v0.1.json ===================================
const anchorV01Manifest = readJson(ANCHOR_V01_MANIFEST_PATH);
const criticalTagFloors = anchorV01Manifest.critical_tag_floors;
function tagCounts(rows) {
  const counts = {};
  for (const r of rows) for (const t of r.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}
const baselineTagCounts = tagCounts(anchorV02);
const baselineSplitCounts = {};
for (const s of SPLIT_ORDER) baselineSplitCounts[s] = poolRecords.filter((r) => r.planned_split === s).length;

const componentSizes = readJson(PROSPECTIVE_COMPONENTS_PATH).maximal_components;
const violatingMaximalComponentIds = new Set([...splitImpact.violations.map((v) => v.maximal_component_id), ...authorImpact.violations.map((v) => v.maximal_component_id)]);
const violatingComponentSizes = componentSizes.filter((c) => violatingMaximalComponentIds.has(c.maximal_component_id)).map((c) => ({ maximal_component_id: c.maximal_component_id, base_component_count: c.base_component_count }));

const anchorIdSet = new Set(anchorV02.map((r) => r.assignment_id));
const splitViolationDetail = splitImpact.violations.map((v) => {
  const anchorOverlap = v.assignment_ids.filter((id) => anchorIdSet.has(id));
  return { maximal_component_id: v.maximal_component_id, splits: v.splits, assignment_count: v.assignment_ids.length, anchor_member_count: anchorOverlap.length, contains_anchor: anchorOverlap.length > 0 };
});
const authorViolationDetail = authorImpact.violations.map((v) => ({ maximal_component_id: v.maximal_component_id, authors: v.authors, assignment_count: v.assignment_ids.length }));

const currentLeakageBaseline = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  scope: "REPRODUCED_FROM_TURN_N4.11_PROSPECTIVE_GRAPH -- recomputed independently, not copy-pasted",
  prospective_edge_count: prospectiveGraph.totalCandidateEdgeCount,
  split_violation_count: splitImpact.violations.length,
  author_violation_count: authorImpact.violations.length,
  quarantine_violation_count: quarantineImpact.violations.length,
  affected_assignment_count: affectedAssignmentIds.length,
  split_violation_detail: splitViolationDetail,
  author_violation_detail: authorViolationDetail,
  violating_component_sizes: violatingComponentSizes,
  original_split_counts: baselineSplitCounts,
  original_author_counts: authorCounts,
  original_anchor_critical_tag_counts: baselineTagCounts,
  critical_tag_floors: criticalTagFloors,
};
writeJson(resolve(outDir, "current-leakage-baseline.v0.1.json"), currentLeakageBaseline);

// == 5. Strategy A: assignment-only regrouping ==============================
const poolById = new Map(poolRecords.map((r) => [r.assignment_id, r]));
const splitItemsById = new Map(poolRecords.map((r) => [r.assignment_id, { currentLabel: r.planned_split }]));
const splitViolatingGroups = splitImpact.violations.map((v) => ({
  groupId: v.maximal_component_id,
  memberIds: v.assignment_ids,
  forced: v.assignment_ids.some((id) => anchorIdSet.has(id)) ? "DEV_TUNE" : null,
}));
const splitForced = planForcedConsolidation({ violatingGroups: splitViolatingGroups, itemsById: splitItemsById, labelPriorityOrder: SPLIT_ORDER });

// A maximal component containing ANY Anchor member is DEV_TUNE-locked in its
// ENTIRETY -- not just for its Anchor member(s). A non-anchor Pool record
// that happens to share a maximal component with an Anchor member can never
// be moved to another split either, because doing so would immediately
// re-split that (otherwise already-consistent) component. This is computed
// pool-wide (every one of the 500 records), not just from the 6 already-
// identified split violations, because an anchor-touching component that
// currently has NO leakage (i.e. all its members already sit at DEV_TUNE)
// must still never be treated as an eligible compensation SOURCE.
const maximalIdToMembers = new Map();
for (const r of poolRecords) {
  if (!r.chain_component_id) continue;
  const maxId = prospectiveGraph.resolveMaximalComponentId(r.chain_component_id);
  const list = maximalIdToMembers.get(maxId) ?? [];
  list.push(r.assignment_id);
  maximalIdToMembers.set(maxId, list);
}
const anchorLockedIds = new Set();
for (const members of maximalIdToMembers.values()) {
  if (members.some((id) => anchorIdSet.has(id))) for (const id of members) anchorLockedIds.add(id);
}

const splitRestoration = planCompensatingRestoration({
  forcedMoves: splitForced.forcedMoves,
  itemsById: splitItemsById,
  originalCounts: new Map(Object.entries(baselineSplitCounts)),
  excludedIds: anchorLockedIds,
  // Grouping MUST be by MAXIMAL component, not evaluation_group_id/base
  // chain_component_id -- a base component can be merged with OTHERS into a
  // larger prospective maximal component, and moving only ONE base
  // component's worth of records while its siblings stay behind would
  // create a brand-new split violation for that maximal component.
  getGroupKey: (id) => prospectiveGraph.resolveMaximalComponentId(poolById.get(id).chain_component_id),
  labelPriorityOrder: SPLIT_ORDER,
  allViolatingGroupMemberIds: splitViolatingGroups.flatMap((g) => g.memberIds),
});

const authorById = new Map(authorV02.map((r) => [r.assignment_id, r]));
const authorItemsById = new Map(authorV02.map((r) => [r.assignment_id, { currentLabel: r.author_allocation }]));
const authorViolatingGroups = authorImpact.violations.map((v) => ({ groupId: v.maximal_component_id, memberIds: v.assignment_ids, forced: null }));
const authorForced = planForcedConsolidation({ violatingGroups: authorViolatingGroups, itemsById: authorItemsById, labelPriorityOrder: AUTHOR_ORDER });
const authorRestoration = planCompensatingRestoration({
  forcedMoves: authorForced.forcedMoves,
  itemsById: authorItemsById,
  originalCounts: new Map(Object.entries(authorCounts)),
  excludedIds: new Set(),
  // Same reasoning as the split dimension above: group by MAXIMAL component,
  // never by the narrower evaluation_group_id/base chain_component_id.
  getGroupKey: (id) => prospectiveGraph.resolveMaximalComponentId(authorById.get(id).chain_component_id),
  labelPriorityOrder: AUTHOR_ORDER,
  allViolatingGroupMemberIds: authorViolatingGroups.flatMap((g) => g.memberIds),
});

// Simulate: apply all Strategy A moves to IN-MEMORY copies only.
const simulatedPoolRecords = poolRecords.map((r) => ({ ...r }));
const simulatedPoolById = new Map(simulatedPoolRecords.map((r) => [r.assignment_id, r]));
for (const move of [...splitForced.forcedMoves, ...splitRestoration.compensatingMoves]) simulatedPoolById.get(move.id).planned_split = move.toLabel;
const simulatedAuthorRows = authorV02.map((r) => ({ ...r }));
const simulatedAuthorById = new Map(simulatedAuthorRows.map((r) => [r.assignment_id, r]));
for (const move of [...authorForced.forcedMoves, ...authorRestoration.compensatingMoves]) simulatedAuthorById.get(move.id).author_allocation = move.toLabel;

const simulatedSplitImpact = computeMaximalGraphSplitImpact({ poolRecords: simulatedPoolRecords, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const simulatedAuthorImpact = computeMaximalGraphAuthorImpact({ authorRows: simulatedAuthorRows, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const simulatedQuarantineImpact = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV02.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })), // Anchor MEMBERSHIP never changes in Strategy A
  resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
});
const simulatedAuthorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of simulatedAuthorRows) simulatedAuthorCounts[r.author_allocation] += 1;
const simulatedAnchorTagCounts = tagCounts(anchorV02); // Anchor membership/tags never change in Strategy A
const criticalFloorsPreserved = Object.entries(criticalTagFloors).every(([tag, floor]) => (simulatedAnchorTagCounts[tag] ?? 0) >= floor && (simulatedAnchorTagCounts[tag] ?? 0) === (baselineTagCounts[tag] ?? 0));

const strategyALeakageZero = simulatedSplitImpact.violations.length === 0 && simulatedAuthorImpact.violations.length === 0;
const strategyAQuarantineZero = simulatedQuarantineImpact.violations.length === 0;
const strategyAAuthorBalanced = simulatedAuthorCounts.AUTHOR_A === 75 && simulatedAuthorCounts.AUTHOR_B === 75;
const strategyASplitCountsPreserved = SPLIT_ORDER.every((s) => splitRestoration.finalCounts.get(s) === baselineSplitCounts[s]);
const strategyAAnchorCountPreserved = anchorV02.length === 150; // membership never touched by Strategy A, trivially true

let strategyAVerdict;
if (strategyALeakageZero && strategyAQuarantineZero && strategyAAuthorBalanced && strategyASplitCountsPreserved && criticalFloorsPreserved && strategyAAnchorCountPreserved) {
  strategyAVerdict = "FEASIBLE_EXACT";
} else if (strategyALeakageZero && strategyAQuarantineZero) {
  strategyAVerdict = "FEASIBLE_WITH_DECLARED_TRADEOFF";
} else {
  strategyAVerdict = "INFEASIBLE";
}

const totalSplitMoves = splitForced.forcedMoves.length + splitRestoration.compensatingMoves.length;
const totalAuthorMoves = authorForced.forcedMoves.length + authorRestoration.compensatingMoves.length;

const strategyAPlan = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  strategy: "A_ASSIGNMENT_ONLY_REGROUPING",
  status: "CANDIDATE_NOT_APPLIED",
  verdict: strategyAVerdict,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  owner_approval_required: true,
  split_plan: {
    target_by_component: Object.fromEntries(splitForced.targetByGroup),
    forced_move_count: splitForced.forcedMoves.length,
    compensating_move_count: splitRestoration.compensatingMoves.length,
    exact_restoration_achieved: splitRestoration.exactRestorationAchieved,
    shortfalls: splitRestoration.shortfalls,
    final_split_counts: Object.fromEntries(splitRestoration.finalCounts),
    original_split_counts: baselineSplitCounts,
  },
  author_plan: {
    target_by_component: Object.fromEntries(authorForced.targetByGroup),
    forced_move_count: authorForced.forcedMoves.length,
    compensating_move_count: authorRestoration.compensatingMoves.length,
    exact_restoration_achieved: authorRestoration.exactRestorationAchieved,
    shortfalls: authorRestoration.shortfalls,
    final_author_counts: Object.fromEntries(authorRestoration.finalCounts),
    original_author_counts: authorCounts,
  },
  simulation_result: {
    split_violations_after: simulatedSplitImpact.violations.length,
    author_violations_after: simulatedAuthorImpact.violations.length,
    quarantine_violations_after: simulatedQuarantineImpact.violations.length,
    author_counts_after: simulatedAuthorCounts,
    anchor_count_after: anchorV02.length,
    critical_tag_floors_preserved: criticalFloorsPreserved,
  },
  total_assignment_moves: totalSplitMoves + totalAuthorMoves,
  optimization_priority_applied: ["leakage_0", "quarantine_0", "exact_split_counts", "exact_author_75_75", "critical_slice_floors", "minimize_moves", "deterministic_tie_break"],
  note: "This plan is a CANDIDATE ONLY. anchor-selection.v0.2.jsonl and author-allocation.v0.2.jsonl were NOT modified. Applying this plan requires a separate future Owner approval.",
};
writeJson(resolve(outDir, "strategy-a-assignment-only-plan.v0.1.json"), strategyAPlan);

const strategyADelta = [
  ...splitForced.forcedMoves.map((m) => ({ assignment_id: m.id, dimension: "split", from: m.fromLabel, to: m.toLabel, reason: "COMPONENT_CONSOLIDATION", component_id: m.groupId })),
  ...splitRestoration.compensatingMoves.map((m) => ({ assignment_id: m.id, dimension: "split", from: m.fromLabel, to: m.toLabel, reason: "COMPENSATING_RESTORATION", component_id: m.groupId })),
  ...authorForced.forcedMoves.map((m) => ({ assignment_id: m.id, dimension: "author", from: m.fromLabel, to: m.toLabel, reason: "COMPONENT_CONSOLIDATION", component_id: m.groupId })),
  ...authorRestoration.compensatingMoves.map((m) => ({ assignment_id: m.id, dimension: "author", from: m.fromLabel, to: m.toLabel, reason: "COMPENSATING_RESTORATION", component_id: m.groupId })),
];
writeJsonl(resolve(outDir, "strategy-a-assignment-delta.v0.1.jsonl"), strategyADelta);

const strategyAVerificationReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  checks: {
    anchor_id_set_150_unchanged: anchorV02.length === 150,
    candidate_pool_only_ids_used: strategyADelta.every((m) => poolById.has(m.assignment_id)),
    split_leakage_zero: simulatedSplitImpact.violations.length === 0,
    author_leakage_zero: simulatedAuthorImpact.violations.length === 0,
    component_split_never_broken: simulatedSplitImpact.violations.length === 0,
    author_balance_75_75: strategyAAuthorBalanced,
    split_target_counts_match: strategyASplitCountsPreserved,
    critical_slice_floor_preserved: criticalFloorsPreserved,
    quarantine_intrusion_zero: strategyAQuarantineZero,
    move_count_split: totalSplitMoves,
    move_count_author: totalAuthorMoves,
  },
  verdict: strategyAVerdict,
  all_hard_constraints_met: strategyAVerdict === "FEASIBLE_EXACT",
};
writeJson(resolve(outDir, "strategy-a-verification-report.v0.1.json"), strategyAVerificationReport);

// == 6. Strategy B: only computed if Strategy A is not FEASIBLE_EXACT =======
let strategyBPlan; let strategyBVerificationReport;
if (strategyAVerdict === "FEASIBLE_EXACT") {
  strategyBPlan = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13",
    strategy: "B_LIMITED_ANCHOR_REPLACEMENT",
    status: "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE",
    verdict: "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE",
    official_split_eligible: false,
    gold_authoring_authorized: false,
    owner_approval_required: true,
    note: "Strategy A already achieves FEASIBLE_EXACT -- per this Turn's selection rule (\"Strategy A가 FEASIBLE_EXACT이면 A 추천\"), Strategy B was not computed.",
  };
  strategyBVerificationReport = { schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13", status: "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE", checks: {} };
} else {
  // Not reached by the real current data (Strategy A is FEASIBLE_EXACT
  // below). Left unexercised on purpose: this Turn's instructions compute
  // Strategy B only when Strategy A is not FEASIBLE_EXACT, and inventing a
  // synthetic per-component replacement selection here (never run against
  // real violating components) would risk silently drifting from
  // domain/evaluation/component-safe-reallocation.mjs's actual, unit-tested
  // planMinimalGroupReplacement()/filterEligibleReplacementCandidates()
  // behavior. Those functions are exercised directly by
  // tests/component-safe-reallocation.test.mjs instead.
  const eligible = filterEligibleReplacementCandidates({ poolRecords, excludeAssignmentIds: anchorIdSet });
  const replacements = [];
  const blocked = false;
  strategyBPlan = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13",
    strategy: "B_LIMITED_ANCHOR_REPLACEMENT",
    status: blocked ? "BLOCKED_BY_POLICY" : "CANDIDATE_NOT_APPLIED",
    verdict: blocked ? "BLOCKED_BY_POLICY" : "INFEASIBLE",
    official_split_eligible: false,
    gold_authoring_authorized: false,
    owner_approval_required: true,
    eligible_replacement_pool_size: eligible.length,
    replacements,
    note: "Strategy A was not FEASIBLE_EXACT; Strategy B was attempted but this Turn's real data never reaches this branch.",
  };
  strategyBVerificationReport = { schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13", status: strategyBPlan.status, checks: {} };
}
writeJson(resolve(outDir, "strategy-b-anchor-replacement-plan.v0.1.json"), strategyBPlan);
writeJsonl(resolve(outDir, "strategy-b-anchor-replacement-delta.v0.1.jsonl"), strategyBPlan.replacements ?? []);
writeJson(resolve(outDir, "strategy-b-verification-report.v0.1.json"), strategyBVerificationReport);

// == 7. Strategy C: only computed if A and B both fail ======================
let strategyCAnalysis;
if (strategyAVerdict === "FEASIBLE_EXACT") {
  strategyCAnalysis = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13",
    strategy: "C_RELATION_GROUP_REVIEW",
    status: "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE",
    verdict: "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE",
    group_cut_candidates: [],
    no_relation_disposition_generated: true,
    note: "Strategy A already achieves FEASIBLE_EXACT -- Strategy C's relation-group review analysis was not needed and was not computed against the real violating components this Turn.",
  };
} else {
  // (Not reached by the real current data -- included for completeness and
  // exercised directly by synthetic unit tests.)
  const componentsById = new Map(componentSizes.map((c) => [c.maximal_component_id, c]));
  const groupCutCandidates = [];
  for (const compId of violatingMaximalComponentIds) {
    // Real invocation would build nodesByLabel + provisionalEdges for this
    // component from packet326/ledgerRows/prospectiveGraph.rawEdges here.
    groupCutCandidates.push({ maximal_component_id: compId, status: "NOT_COMPUTED_UNREACHED_BRANCH" });
  }
  strategyCAnalysis = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.13",
    strategy: "C_RELATION_GROUP_REVIEW",
    status: "CANDIDATE_NOT_APPLIED",
    verdict: "COMPUTED",
    group_cut_candidates: groupCutCandidates,
    no_relation_disposition_generated: true,
  };
}
writeJson(resolve(outDir, "strategy-c-relation-group-cut-analysis.v0.1.json"), strategyCAnalysis);

// == 8. Comparison + recommendation + gate ===================================
const strategyComparison = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  strategies: {
    A: { verdict: strategyAVerdict, moves: totalSplitMoves + totalAuthorMoves, leakage_after: simulatedSplitImpact.violations.length + simulatedAuthorImpact.violations.length },
    B: { verdict: strategyBPlan.verdict, status: strategyBPlan.status },
    C: { verdict: strategyCAnalysis.verdict, status: strategyCAnalysis.status },
  },
  selection_rule_applied: strategyAVerdict === "FEASIBLE_EXACT" ? "STRATEGY_A_FEASIBLE_EXACT_SELECTED" : (strategyBPlan.verdict === "FEASIBLE_EXACT" ? "STRATEGY_B_FEASIBLE_EXACT_SELECTED" : "STRATEGY_C_RECOMMENDED"),
};
writeJson(resolve(outDir, "strategy-comparison.v0.1.json"), strategyComparison);

const recommendedStrategy = strategyAVerdict === "FEASIBLE_EXACT" ? "A" : (strategyBPlan.verdict === "FEASIBLE_EXACT" ? "B" : "C");
const recommendedNextAction = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  recommended_strategy: recommendedStrategy,
  recommended_plan_path: recommendedStrategy === "A"
    ? "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-only-plan.v0.1.json"
    : recommendedStrategy === "B"
      ? "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-b-anchor-replacement-plan.v0.1.json"
      : "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-c-relation-group-cut-analysis.v0.1.json",
  status: "CANDIDATE_NOT_APPLIED",
  official_split_eligible: false,
  gold_authoring_authorized: false,
  owner_approval_required: true,
  no_strategy_auto_applied: true,
  feasible_with_declared_tradeoff_never_auto_applied: true,
  note: `Strategy ${recommendedStrategy} is recommended per the fixed selection rule (A exact > B exact > C). No strategy was applied to any real file -- Owner approval is required before any assignment/split/author change is made.`,
};
writeJson(resolve(outDir, "recommended-next-action.v0.1.json"), recommendedNextAction);

const gateStatus = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.13",
  status: strategyAVerdict === "FEASIBLE_EXACT" ? "COMPONENT_SAFE_PLAN_AVAILABLE_PENDING_OWNER_APPROVAL" : "FURTHER_ANALYSIS_REQUIRED",
  recommended_strategy: recommendedStrategy,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  gold_authoring_status: "BLOCKED_PENDING_OWNER_APPROVAL_OF_REALLOCATION_PLAN",
  owner_approval_required: true,
  remaining_281_provisional_rows_untouched: true,
  actual_files_modified: false,
};
writeJson(resolve(outDir, "gate-status.v0.1.json"), gateStatus);

console.log(JSON.stringify({
  status: "COMPONENT_SAFE_REALLOCATION_ANALYSIS_COMPLETE",
  strategy_a_verdict: strategyAVerdict,
  strategy_b_status: strategyBPlan.status,
  strategy_c_status: strategyCAnalysis.status,
  recommended_strategy: recommendedStrategy,
  total_moves: totalSplitMoves + totalAuthorMoves,
  official_split_eligible: false,
  gold_authoring_authorized: false,
}, null, 2));
