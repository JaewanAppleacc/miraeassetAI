#!/usr/bin/env node
// Turn N4.8: Path 2 from provisional-294-decision-packet.v0.2.json --
// "모든 plausible edge를 보수적으로 포함한 그래프에서도 leakage 0 증명". This
// script performs ONLY a mechanical impact analysis of the CONSERVATIVE
// MAXIMAL plausible relation graph (every one of the 326-row packet's listed
// candidate targets, regardless of Owner CONFIRM/REJECT/NEEDS_MORE_REVIEW or
// REVIEWER_CONSENSUS_PROVISIONAL status, unioned as a worst-case edge) against
// the real Candidate Pool 500 planned_split, Anchor v0.2/Author v0.2
// allocation, and the N4.7 quarantine set.
//
// This script NEVER:
//   - adjudicates any of the 294 REVIEWER_CONSENSUS_PROVISIONAL rows
//   - writes a new Relation/Fact/Evidence/Gold record
//   - modifies any existing artifact (326 packet, ledger v0.2, Owner v0.3,
//     Reviewer C/D results, Candidate Pool 500, Anchor/Author v0.2, quarantine
//     manifest, gate-status.v0.2.json, final-integration-packet.v0.2.json)
//   - applies any Anchor replacement it computes (replacement candidates are
//     reported as SUGGESTIONS only, requiring a separate future Owner
//     decision -- see PATH_2 branch B output)
//   - flips official_split_eligible to true by itself
//
// Every input file's SHA-256 is verified against either a pre-existing
// pinned value (Owner v0.3, Reviewer C/D risk packet -- reusing the SAME
// constants/paths Turn N4.7's build-relation-closure-owner-integration-v047
// .mjs already pinned) or, for artifacts with no prior pin, computed fresh
// and recorded in this Turn's own manifest for future immutability tracking.
// All outputs are written under a NEW subdirectory
// (work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/) so nothing from
// Turn N4.7/N4.7.1 is overwritten.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMaximalPlausibleGraph,
  computeMaximalGraphSplitImpact,
  computeMaximalGraphAuthorImpact,
  computeMaximalGraphQuarantineImpact,
  buildDocumentToBaseComponentMap,
  suggestReplacementCandidates,
} from "../domain/evaluation/relation-closure-maximal-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// -- 0. Fixed inputs (all repo-local, read-only). ---------------------------
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const LEDGER_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl");
const PROVISIONAL_294_PACKET_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/provisional-294-decision-packet.v0.2.json");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const POOL_MANIFEST_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.manifest.json");
const ANCHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl");
const OWNER_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");
const EXPECTED_OWNER_SHA256 = "603e0a24c67251b7f13ccdb2dec2c938c09a34c61c1e612e1fe8c97f9423e50e";
const REVIEWER_C_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-c-v0.2/relation-multistep-reviewer-c-decision.v0.2.jsonl");
const REVIEWER_D_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/results/multistep-reviewer-d-v0.2/relation-multistep-reviewer-d-decision.v0.2.jsonl");
const QUARANTINE_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json");
const FINAL_INTEGRATION_PACKET_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/final-integration-packet.v0.2.json");
const GATE_STATUS_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gate-status.v0.2.json");

const outDir = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1");
mkdirSync(outDir, { recursive: true });

// == 1. SHA verification (fail-closed, never modifies a source) ============
const actualOwnerSha256 = sha256File(OWNER_DECISION_PATH);
if (actualOwnerSha256 !== EXPECTED_OWNER_SHA256) { console.error(`BLOCKER: Owner decision sha256 mismatch (actual ${actualOwnerSha256})`); process.exit(1); }

const finalPacketV02 = readJson(FINAL_INTEGRATION_PACKET_V02_PATH);
const gateStatusV02 = readJson(GATE_STATUS_V02_PATH);
const cRows = readJsonl(REVIEWER_C_DECISION_PATH);
const dRows = readJsonl(REVIEWER_D_DECISION_PATH);
const reviewerCSha256 = sha256File(REVIEWER_C_DECISION_PATH);
const reviewerDSha256 = sha256File(REVIEWER_D_DECISION_PATH);
const expectedCdCombined = `${reviewerCSha256}+${reviewerDSha256}`;
// N4.7's own ledger manifest records DUAL_REVIEW_C_D artifact sha as this
// exact "sha1+sha2" string on every ledger row with that authority; recompute
// and confirm at least one such row still matches -- proves neither reviewer
// file drifted since N4.7 without re-deriving the whole ledger.
const ledgerRows = readJsonl(LEDGER_V02_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }
const dualReviewRow = ledgerRows.find((r) => r.decision_authority === "DUAL_REVIEW_C_D");
if (!dualReviewRow || dualReviewRow.decision_artifact_sha256 !== expectedCdCombined) {
  console.error("BLOCKER: Reviewer C/D decision files drifted since Turn N4.7 (sha mismatch against ledger's own pinned artifact sha)");
  process.exit(1);
}
if (cRows.length !== 2 || dRows.length !== 2) { console.error("BLOCKER: Reviewer C/D row count is not 2/2"); process.exit(1); }

const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const packet326Sha256 = sha256File(PACKET_326_PATH);

const provisional294Packet = readJson(PROVISIONAL_294_PACKET_PATH);
if (provisional294Packet.current_state.row_count !== 294) { console.error("BLOCKER: provisional-294-decision-packet.v0.2.json row_count is not 294"); process.exit(1); }
const provisionalRows = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL");
if (provisionalRows.length !== 294) { console.error(`BLOCKER: ledger REVIEWER_CONSENSUS_PROVISIONAL count ${provisionalRows.length} !== 294`); process.exit(1); }

const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool row count ${poolRecords.length} !== 500`); process.exit(1); }
const poolSha256 = sha256File(POOL_PATH);
const poolManifest = readJson(POOL_MANIFEST_PATH);
if (poolManifest.candidate_pool_record_count !== 500) { console.error("BLOCKER: Candidate Pool manifest record_count is not 500"); process.exit(1); }

const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 row count ${anchorV02.length} !== 150`); process.exit(1); }
const anchorV02Sha256 = sha256File(ANCHOR_V02_PATH);

const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 row count ${authorV02.length} !== 150`); process.exit(1); }
const authorV02Sha256 = sha256File(AUTHOR_V02_PATH);
const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV02) authorCounts[r.author_allocation] += 1;
if (authorCounts.AUTHOR_A !== 75 || authorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: Author v0.2 balance ${JSON.stringify(authorCounts)} !== 75/75`); process.exit(1); }

const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }
const quarantineManifestSha256 = sha256File(QUARANTINE_MANIFEST_PATH);

const inputShaManifest = {
  schema_version: "0.1.0",
  turn: "N4.8",
  note: "SHA-256 of every pinned input this Turn read. owner_decision reuses the SAME expected constant Turn N4.7 pinned. reviewer_c/d are cross-checked against the combined sha the ledger's own DUAL_REVIEW_C_D row already recorded in Turn N4.7 (proves no drift since then). Every other value here is a FIRST-TIME pin recorded for future immutability tracking, not a prior committed expectation.",
  relation_closure_review_packet_v01_sha256: packet326Sha256,
  relation_closure_candidate_ledger_v02_sha256: sha256File(LEDGER_V02_PATH),
  provisional_294_decision_packet_v02_sha256: sha256File(PROVISIONAL_294_PACKET_PATH),
  candidate_pool_v041_sha256: poolSha256,
  candidate_pool_v041_manifest_pinned_sha256: poolManifest.candidate_pool_sha256,
  candidate_pool_v041_manifest_pin_matches_actual: poolManifest.candidate_pool_sha256 === poolSha256 || poolManifest.candidate_pool_sha256.replace(/^0/, "") === poolSha256,
  anchor_selection_v02_sha256: anchorV02Sha256,
  author_allocation_v02_sha256: authorV02Sha256,
  owner_decision_v03_sha256: actualOwnerSha256,
  reviewer_c_decision_sha256: reviewerCSha256,
  reviewer_d_decision_sha256: reviewerDSha256,
  quarantine_manifest_v02_sha256: quarantineManifestSha256,
  none_of_these_source_files_were_modified_by_this_script: true,
};

// == 2. Build the maximal plausible graph (Path 2) ==========================
const graph = buildMaximalPlausibleGraph({ packetRows: packet326 });
writeJsonl(resolve(outDir, "maximal-graph-edges.v0.1.jsonl"), graph.rawEdges);
writeJson(resolve(outDir, "maximal-graph-components.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  scope: "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED",
  total_candidate_edge_count: graph.totalCandidateEdgeCount,
  distinct_cross_component_pair_count: graph.distinctCrossComponentPairCount,
  excluded_no_component_edge_count: graph.excludedNoComponentEdges.length,
  excluded_no_component_edges: graph.excludedNoComponentEdges,
  maximal_component_count: graph.maximalComponents.length,
  largest_maximal_component_base_component_count: graph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0),
  maximal_components: graph.maximalComponents,
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
// Duplicate assignment / evaluation_group sanity (same style as
// domain/evaluation/candidate-pool-builder.mjs's computeLeakageReport, but at
// the maximal-graph level -- reported separately from split/author leakage).
const seenAssignmentIds = new Set();
const duplicateAssignmentIds = [];
for (const r of poolRecords) { if (seenAssignmentIds.has(r.assignment_id)) duplicateAssignmentIds.push(r.assignment_id); seenAssignmentIds.add(r.assignment_id); }

const allOk = splitImpact.ok && authorImpact.ok && quarantineImpact.ok && duplicateAssignmentIds.length === 0;

const impactReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.8",
  scope: "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED",
  input_shas: inputShaManifest,
  maximal_graph_summary: {
    total_candidate_edge_count: graph.totalCandidateEdgeCount,
    distinct_cross_component_pair_count: graph.distinctCrossComponentPairCount,
    maximal_component_count: graph.maximalComponents.length,
    largest_maximal_component_base_component_count: graph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0),
  },
  split_impact: splitImpact,
  author_impact: authorImpact,
  quarantine_impact: quarantineImpact,
  duplicate_assignment_id_count: duplicateAssignmentIds.length,
  duplicate_assignment_ids: duplicateAssignmentIds,
  all_zero_maximal_graph_leakage: allOk,
  confirmed_edge_23_result_preserved_separately_at: "work/handoff/anchor-dev-tune-v0.2/split-leakage-report.v0.2.json (untouched by this Turn)",
  note: "This report's scope is the CONSERVATIVE MAXIMAL PLAUSIBLE graph (every one of the 326-row packet's candidate targets, including REJECT and REVIEWER_CONSENSUS_PROVISIONAL rows, unioned as a worst-case edge). It is NOT the same graph or the same result as split-leakage-report.v0.2.json, which covers ONLY the 23 Owner/Reviewer-C/D CONFIRMED edges. Both are preserved on disk, separately, at all times.",
};
writeJson(resolve(outDir, "maximal-graph-impact-report.v0.1.json"), impactReport);

// == 4. Branch A/B decision packet + (A only) Owner approval UI ============
const violatingAssignmentIds = [
  ...splitImpact.violations.flatMap((v) => v.assignment_ids),
  ...authorImpact.violations.flatMap((v) => v.assignment_ids),
  ...quarantineImpact.violations.map((v) => v.assignment_id),
];

let decisionPacket;
if (allOk) {
  decisionPacket = {
    schema_version: "0.1.0",
    status: "PATH_2_MECHANICAL_PROOF_COMPLETED",
    generated_at: new Date().toISOString(),
    turn: "N4.8",
    subject: "PATH_2_CONSERVATIVE_MAXIMAL_GRAPH_LEAKAGE_PROOF from provisional-294-decision-packet.v0.2.json",
    result: "Even under the CONSERVATIVE MAXIMAL PLAUSIBLE graph (every one of the 326-row packet's listed candidate targets treated as worst-case-real, including all 294 REVIEWER_CONSENSUS_PROVISIONAL rows and the 8 Owner REJECT rows), zero cross-split, cross-author, or quarantine-intrusion leakage was found against the real Candidate Pool 500 / Anchor v0.2 / Author v0.2 assignments.",
    maximal_graph_summary: impactReport.maximal_graph_summary,
    still_requires_before_official_split_eligible: [
      "A separate, explicit final Owner approval of THIS Path 2 proof (see the Owner approval UI this Turn generated) -- checking this Turn's checklist alone does not set official_split_eligible=true.",
      "The final_owner_split_review approval from Turn N4.7.1's own Owner final-split-approval UI, if not already recorded.",
    ],
    no_auto_adjudication_of_294_rows: true,
    no_294_row_promoted_to_confirmed_or_rejected: true,
    official_split_eligible_set_by_this_script: false,
  };
} else {
  // Excludes EVERY globally violating assignment id (not just this one
  // violation's own set) -- a candidate that is itself tangled in a
  // DIFFERENT split/author/quarantine violation elsewhere must never be
  // suggested as if it were a clean replacement.
  const allViolatingAssignmentIds = [...new Set(violatingAssignmentIds)];
  const splitReplacementSuggestions = Object.fromEntries(
    splitImpact.violations.map((v) => [
      v.maximal_component_id,
      suggestReplacementCandidates({
        violatingAssignmentIds: allViolatingAssignmentIds,
        poolRecords,
        anchorV02AssignmentIds: anchorV02.map((r) => r.assignment_id),
        resolveMaximalComponentId: graph.resolveMaximalComponentId,
        targetPlannedSplit: v.splits[0],
      }).slice(0, 5),
    ]),
  );
  decisionPacket = {
    schema_version: "0.1.0",
    status: "PATH_2_LEAKAGE_FOUND_NOT_RESOLVED",
    generated_at: new Date().toISOString(),
    turn: "N4.8",
    subject: "PATH_2_CONSERVATIVE_MAXIMAL_GRAPH_LEAKAGE_PROOF from provisional-294-decision-packet.v0.2.json",
    result: "Under the CONSERVATIVE MAXIMAL PLAUSIBLE graph, real leakage was found. This is a WORST-CASE risk report, not a proof any of these plausible relations is actually true -- none of the 294 REVIEWER_CONSENSUS_PROVISIONAL rows or the 8 REJECT rows was adjudicated by this Turn.",
    maximal_graph_summary: impactReport.maximal_graph_summary,
    split_violations: splitImpact.violations,
    author_violations: authorImpact.violations,
    quarantine_violations: quarantineImpact.violations,
    affected_assignment_ids: [...new Set(violatingAssignmentIds)].sort(),
    computed_replacement_suggestions_by_maximal_component_id: splitReplacementSuggestions,
    replacement_suggestions_are_computed_only_not_applied: true,
    no_auto_adjudication_of_294_rows: true,
    no_actual_anchor_replacement_performed_this_turn: true,
    no_full_manual_review_of_294_triggered_by_this_turn: true,
    requires_before_any_change: "A separate, explicit Owner decision selecting which replacement (if any) to apply -- this Turn only reports exact components/documents/assignments/split boundaries and computed candidate suggestions.",
    official_split_eligible_set_by_this_script: false,
  };
}
writeJson(resolve(outDir, "provisional-294-maximal-graph-decision-packet.v0.1.json"), decisionPacket);

// == 5. Gate wording correction (new v0.3 file, v0.2 untouched) =============
const finalOwnerSplitReviewStatus = gateStatusV02.gates.final_owner_split_review; // "PENDING" as of N4.7.1
const provisional294ResolutionStatus = allOk ? "PATH_2_PROOF_COMPLETED" : "PENDING";
const goldAuthoringStatus = "BLOCKED_PENDING_PROVISIONAL_294_RESOLUTION";
const gateStatusV03 = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.8",
  supersedes_wording_of: "work/handoff/anchor-dev-tune-v0.2/gate-status.v0.2.json (left on disk, unmodified -- this file only corrects GATE WORDING, not the underlying facts)",
  gates: {
    relation_review: gateStatusV02.gates.relation_review,
    unresolved_relation: gateStatusV02.gates.unresolved_relation,
    final_owner_split_review: finalOwnerSplitReviewStatus,
    provisional_294_resolution: provisional294ResolutionStatus,
    provisional_294_resolution_path: allOk ? "PATH_2_CONSERVATIVE_MAXIMAL_GRAPH_LEAKAGE_PROOF" : null,
    chain_leakage_confirmed_edges_only: gateStatusV02.gates.chain_leakage,
    chain_leakage_maximal_plausible_graph: allOk ? "PASS_MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE" : "FAIL_MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE",
    anchor_count: gateStatusV02.gates.anchor_count,
    author_balance: gateStatusV02.gates.author_balance,
    official_split_eligible: false,
    official_split_eligible_blocked_by: allOk
      ? "Path 2 mechanical proof completed, but a separate explicit final Owner approval of that proof (and of Turn N4.7.1's final-split checklist, if not already recorded) is still required before official_split_eligible may become true."
      : "Maximal-graph leakage found and not yet resolved -- see provisional-294-maximal-graph-decision-packet.v0.1.json for exact components/assignments and computed (not applied) replacement suggestions.",
    gold_authoring: goldAuthoringStatus,
    gold_authoring_note: "Renamed from BLOCKED_PENDING_FINAL_SPLIT_APPROVAL (Turn N4.7.1's wording, which did not name the actual blocking cause) to BLOCKED_PENDING_PROVISIONAL_294_RESOLUTION -- Gold authoring may not start until BOTH final_owner_split_review=APPROVED AND provisional_294_resolution=PATH_2_PROOF_COMPLETED (or one of the other two policy paths) are true.",
  },
};
writeJson(resolve(outDir, "gate-status.v0.3.json"), gateStatusV03);

// == 6. Owner approval UI (branch A only) -- never auto-approves ===========
let uiBuildReport = null;
if (allOk) {
  const uiDir = resolve(outDir, "ui/v0.1");
  mkdirSync(uiDir, { recursive: true });
  const FINAL_EXPORT_FILENAME = "relation-closure-maximal-graph-owner-approval.v0.1.json";
  const DATA = {
    maximal_graph_summary: impactReport.maximal_graph_summary,
    split_impact: { ok: splitImpact.ok, maximal_component_count_touching_pool: splitImpact.maximal_component_count_touching_pool, largest_component_assignment_count: splitImpact.largest_component_assignment_count },
    author_impact: { ok: authorImpact.ok },
    quarantine_impact: { ok: quarantineImpact.ok, quarantine_maximal_component_count: quarantineImpact.quarantine_maximal_component_count },
    input_shas: inputShaManifest,
    final_export_filename: FINAL_EXPORT_FILENAME,
    checklist_items: [
      { id: "maximal_graph_scope_understood", label: "이 그래프는 326건 전체(REJECT 8건·REVIEWER_CONSENSUS_PROVISIONAL 294건 포함)의 모든 candidate target을 실제라고 가정한 최악 조건 그래프이며, 실제 relation 확정이 아님을 이해했다" },
      { id: "no_row_adjudicated", label: "이 Turn은 294건 중 어느 것도 CONFIRM/REJECT로 확정하지 않았음을 확인했다" },
      { id: "split_impact_zero", label: `split leakage 0건을 확인했다 (검사한 maximal component ${DATA.split_impact.maximal_component_count_touching_pool}개, 최대 크기 ${DATA.split_impact.largest_component_assignment_count})` },
      { id: "author_impact_zero", label: "AUTHOR_A/AUTHOR_B 간 동일 maximal component 분할 0건을 확인했다" },
      { id: "quarantine_impact_zero", label: "격리 문서로의 유입 위험 0건을 확인했다" },
      { id: "official_split_still_false", label: "이 승인 이후에도 official_split_eligible은 자동으로 true가 되지 않으며, 별도의 최종 Owner 승인이 여전히 필요함을 이해했다" },
      { id: "gold_still_blocked", label: "Gold 작성은 final_owner_split_review=APPROVED와 provisional_294_resolution=PATH_2_PROOF_COMPLETED가 모두 확인되기 전까지 시작하지 않는다는 점을 이해했다" },
    ],
  };
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.8 Path 2 Maximal-Graph Owner Approval (v0.1)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:28px;}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;}
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
<h1>Turn N4.8 -- Path 2 Maximal-Graph Owner Approval (v0.1)</h1>
<div class="warnbox">이 페이지는 <b>PATH_2_MECHANICAL_PROOF_COMPLETED</b> 결과를 Owner가 검토하기 위한 것이다. 최대 그래프(326건 전체 candidate, REJECT·PROVISIONAL 포함)에서도 split/author/격리 leakage가 0건임을 기계적으로 확인했지만, 이 페이지의 체크리스트를 전부 확인해 내보내도 <b>official_split_eligible은 여전히 false로 유지</b>된다 -- 별도의 최종 Owner 승인(Turn N4.7.1의 final-split 체크리스트 포함)이 남아있다.</div>
<h2>최대 그래프 요약</h2>
<p>candidate edge 총수: ${impactReport.maximal_graph_summary.total_candidate_edge_count} / component 수: ${impactReport.maximal_graph_summary.maximal_component_count} / 최대 component 크기(base component 기준): ${impactReport.maximal_graph_summary.largest_maximal_component_base_component_count}</p>
<h2>Owner 체크리스트</h2>
<div class="checklist" id="checklist"></div>
<div class="btnrow">
<button id="approveBtn" disabled>Path 2 검토 완료 &amp; Download (JSON)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>
<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var STORAGE_KEY = "n4.8-maximal-graph-owner-checklist-v0.1";
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
      status: "OWNER_PATH_2_MAXIMAL_GRAPH_CHECKLIST_APPROVED",
      note: "This records that a human checked every item below in a browser. It does NOT set official_split_eligible=true and does NOT adjudicate any of the 294 REVIEWER_CONSENSUS_PROVISIONAL rows.",
      official_split_eligible: false,
      approved_at: new Date().toISOString(),
      input_shas: DATA.input_shas,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: true }; }),
      maximal_graph_summary_snapshot: DATA.maximal_graph_summary,
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
  const htmlPath = resolve(uiDir, "relation-closure-maximal-graph-owner-approval.v0.1.html");
  writeFileSync(htmlPath, html, "utf8");
  uiBuildReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    html_path: "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1/ui/v0.1/relation-closure-maximal-graph-owner-approval.v0.1.html",
    html_sha256: sha256File(htmlPath),
    checklist_item_count: DATA.checklist_items.length,
    storage_key: "n4.8-maximal-graph-owner-checklist-v0.1",
    final_export_filename: FINAL_EXPORT_FILENAME,
    auto_approved: false,
    official_split_eligible_settable_by_this_ui: false,
  };
  writeJson(resolve(uiDir, "maximal-graph-owner-approval-ui-build-report.json"), uiBuildReport);
}

console.log(JSON.stringify({
  status: allOk ? "PATH_2_MECHANICAL_PROOF_COMPLETED" : "PATH_2_LEAKAGE_FOUND_NOT_RESOLVED",
  out_dir: "work/handoff/anchor-dev-tune-v0.2/maximal-graph-v0.1",
  maximal_graph_summary: impactReport.maximal_graph_summary,
  split_impact_ok: splitImpact.ok,
  split_violation_count: splitImpact.violations.length,
  author_impact_ok: authorImpact.ok,
  author_violation_count: authorImpact.violations.length,
  quarantine_impact_ok: quarantineImpact.ok,
  quarantine_violation_count: quarantineImpact.violations.length,
  duplicate_assignment_id_count: duplicateAssignmentIds.length,
  gate_status_v03: gateStatusV03.gates,
  ui_generated: allOk,
}, null, 2));
