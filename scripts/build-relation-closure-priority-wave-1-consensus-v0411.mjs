#!/usr/bin/env node
// Turn N4.11: mechanically cross-checks Reviewer E vs Reviewer F's
// independent Priority Wave 1 (13-row) decisions, and -- ONLY if they agree
// exactly on every row -- records that agreement as
// DUAL_REVIEW_CONSENSUS_PENDING_OWNER (never an auto-promoted official
// Relation), recomputes a PROSPECTIVE decision-respecting graph that
// overlays that consensus onto Turn N4.9's unchanged policy for every other
// row, and builds an Owner batch-ratification UI + decision template.
//
// This script NEVER:
//   - promotes the E/F consensus to an official Relation/Fact/Evidence
//   - sets official_split_eligible to true
//   - authors Gold
//   - auto-adjudicates any of the remaining 281 provisional rows
//   - modifies Reviewer E/F's decision/attestation files, the 13-row
//     Priority Wave 1 packet, any Turn N4.9 artifact, Candidate Pool 500,
//     Anchor v0.2/Author v0.2, the quarantine manifest, or Owner's existing
//     v0.3 decisions
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyReviewerDecisionSet,
  compareReviewerAgreement,
  buildProspectiveGraph,
} from "../domain/evaluation/relation-closure-prospective-consensus-graph.mjs";
import {
  computeMaximalGraphSplitImpact,
  computeMaximalGraphAuthorImpact,
  computeMaximalGraphQuarantineImpact,
  buildDocumentToBaseComponentMap,
} from "../domain/evaluation/relation-closure-maximal-graph.mjs";
import {
  classifyProvisionalRow,
  buildComponentSplitMap,
  buildComponentAuthorMap,
} from "../domain/evaluation/relation-closure-decision-respecting-graph.mjs";
import { selectPriorityWave1 } from "../domain/evaluation/relation-closure-priority-wave-selection.mjs";

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
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// -- 0. Fixed paths + pinned expected SHAs (given verbatim by this Turn's
// instructions -- never recomputed FROM the files themselves as the
// "expected" value, always compared AGAINST them). ---------------------
const DR_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
const PW1_DIR = resolve(DR_DIR, "priority-wave-1-v0.1");
const CONSENSUS_DIR = resolve(PW1_DIR, "consensus-integration-v0.1");

const PACKET_PATH = resolve(PW1_DIR, "priority-wave-1-review-packet.v0.1.jsonl");
const E_DECISION_PATH = resolve(PW1_DIR, "results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl");
const E_ATTESTATION_PATH = resolve(PW1_DIR, "results/reviewer-e-v0.1/priority-wave-1-reviewer-e-attestation.v0.1.json");
const F_DECISION_PATH = resolve(PW1_DIR, "results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl");
const F_ATTESTATION_PATH = resolve(PW1_DIR, "results/reviewer-f-v0.1/priority-wave-1-reviewer-f-attestation.v0.1.json");

const EXPECTED_PACKET_SHA256 = "3bd80e8bc77f2df1b79a22c9f231a209613dea0e2d2c49e09b67b5b47f601c8d";
const EXPECTED_E_DECISION_SHA256 = "6dab48af2204ed8c4ffe45a1002c1f9478e1fd36d2c8c1e41e2fa00e962a72e1";
const EXPECTED_E_ATTESTATION_SHA256 = "95aae066e0bf286512cb005d4f12bd9b98cc8bb3088fde7574af9172248267d4";
const EXPECTED_F_DECISION_SHA256 = "6c93be0bb35f5da15f4bc1146198e8e7cb98334310929160b370837f303c7d49";
const EXPECTED_F_ATTESTATION_SHA256 = "79ca501dbaf6d78d3453a112d09d4db3085afde70c503c4ac0bef108cb45f454";

const TARGETED_231_PATH = resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl");
const CLASSIFICATION_294_PATH = resolve(DR_DIR, "provisional-row-classification.v0.1.jsonl");
const N49_IMPACT_REPORT_PATH = resolve(DR_DIR, "decision-respecting-graph-impact-report.v0.1.json");
const LEDGER_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const ANCHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl");
const QUARANTINE_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json");

// == 1. SHA verification -- ABORT before writing anything on mismatch ======
const packetSha256 = sha256File(PACKET_PATH);
if (packetSha256 !== EXPECTED_PACKET_SHA256) { console.error(`BLOCKER: priority-wave-1 packet sha256 mismatch (actual ${packetSha256})`); process.exit(1); }
const eDecisionSha256 = sha256File(E_DECISION_PATH);
if (eDecisionSha256 !== EXPECTED_E_DECISION_SHA256) { console.error(`BLOCKER: Reviewer E decision sha256 mismatch (actual ${eDecisionSha256})`); process.exit(1); }
const eAttestationSha256 = sha256File(E_ATTESTATION_PATH);
if (eAttestationSha256 !== EXPECTED_E_ATTESTATION_SHA256) { console.error(`BLOCKER: Reviewer E attestation sha256 mismatch (actual ${eAttestationSha256})`); process.exit(1); }
const fDecisionSha256 = sha256File(F_DECISION_PATH);
if (fDecisionSha256 !== EXPECTED_F_DECISION_SHA256) { console.error(`BLOCKER: Reviewer F decision sha256 mismatch (actual ${fDecisionSha256})`); process.exit(1); }
const fAttestationSha256 = sha256File(F_ATTESTATION_PATH);
if (fAttestationSha256 !== EXPECTED_F_ATTESTATION_SHA256) { console.error(`BLOCKER: Reviewer F attestation sha256 mismatch (actual ${fAttestationSha256})`); process.exit(1); }

const priorityPacket = readJsonl(PACKET_PATH);
if (priorityPacket.length !== 13) { console.error(`BLOCKER: Priority Wave 1 packet row count ${priorityPacket.length} !== 13`); process.exit(1); }
const packetById = new Map(priorityPacket.map((r) => [r.relation_candidate_id, r]));
const expectedIds = [...packetById.keys()].sort();

const eDecisions = readJsonl(E_DECISION_PATH);
const fDecisions = readJsonl(F_DECISION_PATH);

// == 2. Per-reviewer mechanical verification (checks 1-9) ===================
const eVerification = verifyReviewerDecisionSet({ decisions: eDecisions, expectedRelationCandidateIds: expectedIds, expectedPacketSha256: EXPECTED_PACKET_SHA256, expectedReviewerRole: "REVIEWER_E", packetById });
if (!eVerification.ok) { console.error(`BLOCKER: Reviewer E decision set failed verification: ${JSON.stringify(eVerification.violations)}`); process.exit(1); }
const fVerification = verifyReviewerDecisionSet({ decisions: fDecisions, expectedRelationCandidateIds: expectedIds, expectedPacketSha256: EXPECTED_PACKET_SHA256, expectedReviewerRole: "REVIEWER_F", packetById });
if (!fVerification.ok) { console.error(`BLOCKER: Reviewer F decision set failed verification: ${JSON.stringify(fVerification.violations)}`); process.exit(1); }

// == 3. Attestation cross-reference (check 10) -- both known attestation
// shapes (Reviewer E's and Reviewer F's differ in field layout; both are
// handled explicitly, never guessed). =======================================
const eAttestation = readJson(E_ATTESTATION_PATH);
const fAttestation = readJson(F_ATTESTATION_PATH);
const eAttestedDecisionSha = eAttestation.outputs?.decisions_sha256;
const fAttestedDecisionSha = fAttestation.outputs?.decision_jsonl?.sha256;
if (eAttestedDecisionSha !== EXPECTED_E_DECISION_SHA256) { console.error(`BLOCKER: Reviewer E attestation cites decision sha256 ${eAttestedDecisionSha}, expected ${EXPECTED_E_DECISION_SHA256}`); process.exit(1); }
if (fAttestedDecisionSha !== EXPECTED_F_DECISION_SHA256) { console.error(`BLOCKER: Reviewer F attestation cites decision sha256 ${fAttestedDecisionSha}, expected ${EXPECTED_F_DECISION_SHA256}`); process.exit(1); }
if (eAttestation.input_packet?.sha256 !== EXPECTED_PACKET_SHA256) { console.error("BLOCKER: Reviewer E attestation cites the wrong packet sha256"); process.exit(1); }
if (fAttestation.input_packet?.sha256 !== EXPECTED_PACKET_SHA256) { console.error("BLOCKER: Reviewer F attestation cites the wrong packet sha256"); process.exit(1); }
if (eAttestation.reviewer_role !== "REVIEWER_E") { console.error("BLOCKER: Reviewer E attestation reviewer_role is not REVIEWER_E"); process.exit(1); }
if (fAttestation.reviewer_role !== "REVIEWER_F") { console.error("BLOCKER: Reviewer F attestation reviewer_role is not REVIEWER_F"); process.exit(1); }

// == 4. Cross-reviewer agreement (checks 11-12) + fail-closed on the exact
// contracted distribution (never hardcoded per-id; recomputed fresh, then
// compared). =================================================================
const agreement = compareReviewerAgreement({ eDecisions, fDecisions });
const EXPECTED_TOTAL = 13;
const EXPECTED_EXACT_AGREEMENT = 13;
const EXPECTED_DISAGREEMENT = 0;
const EXPECTED_DISTRIBUTION = { CONFIRM: 6, REJECT: 7, NEEDS_MORE_REVIEW: 0 };
if (agreement.totalCount !== EXPECTED_TOTAL) { console.error(`BLOCKER: agreement.totalCount ${agreement.totalCount} !== ${EXPECTED_TOTAL}`); process.exit(1); }
if (agreement.exactAgreementCount !== EXPECTED_EXACT_AGREEMENT) { console.error(`BLOCKER: exact agreement ${agreement.exactAgreementCount}/${EXPECTED_TOTAL} !== ${EXPECTED_EXACT_AGREEMENT}/${EXPECTED_TOTAL} -- refusing to write any output`); process.exit(1); }
if (agreement.disagreementCount !== EXPECTED_DISAGREEMENT) { console.error(`BLOCKER: disagreement count ${agreement.disagreementCount} !== ${EXPECTED_DISAGREEMENT}`); process.exit(1); }
for (const key of Object.keys(EXPECTED_DISTRIBUTION)) {
  if (agreement.distribution[key] !== EXPECTED_DISTRIBUTION[key]) {
    console.error(`BLOCKER: consensus distribution ${JSON.stringify(agreement.distribution)} does not match contracted ${JSON.stringify(EXPECTED_DISTRIBUTION)}`);
    process.exit(1);
  }
}

mkdirSync(CONSENSUS_DIR, { recursive: true });

// == 5. Consensus ledger (13 rows) ==========================================
const consensusRows = agreement.rows.map((r) => {
  const source = packetById.get(r.relation_candidate_id);
  return {
    relation_candidate_id: r.relation_candidate_id,
    source_document_id: source.source_document_id,
    relation_type: source.relation_type,
    reviewer_e: { disposition: r.reviewer_e.disposition, confirmed_target_document_id: r.reviewer_e.confirmed_target_document_id, note: r.reviewer_e.note },
    reviewer_f: { disposition: r.reviewer_f.disposition, confirmed_target_document_id: r.reviewer_f.confirmed_target_document_id, note: r.reviewer_f.note },
    agreement: r.agrees,
    consensus_disposition: r.consensus_disposition,
    consensus_target_document_id: r.consensus_target_document_id,
    consensus_status: "DUAL_REVIEW_CONSENSUS_PENDING_OWNER",
    official_relation_status: "NOT_YET_OWNER_APPROVED",
    reviewer_e_decision_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl",
    reviewer_e_decision_sha256: eDecisionSha256,
    reviewer_f_decision_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl",
    reviewer_f_decision_sha256: fDecisionSha256,
    packet_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/priority-wave-1-review-packet.v0.1.jsonl",
    packet_sha256: packetSha256,
    auto_promoted_to_official_relation: false,
    official_split_eligible: false,
  };
});
const consensusLedgerPath = resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.jsonl");
writeJsonl(consensusLedgerPath, consensusRows);
const consensusLedgerSha256 = sha256File(consensusLedgerPath);

writeJson(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.manifest.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.11",
  status: "DUAL_REVIEW_CONSENSUS_RECORDED_PENDING_OWNER",
  inputs: {
    priority_wave_1_packet: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/priority-wave-1-review-packet.v0.1.jsonl", sha256: packetSha256, row_count: priorityPacket.length },
    reviewer_e_decision: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl", sha256: eDecisionSha256 },
    reviewer_e_attestation: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-e-v0.1/priority-wave-1-reviewer-e-attestation.v0.1.json", sha256: eAttestationSha256 },
    reviewer_f_decision: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl", sha256: fDecisionSha256 },
    reviewer_f_attestation: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-f-v0.1/priority-wave-1-reviewer-f-attestation.v0.1.json", sha256: fAttestationSha256 },
  },
  exact_agreement_count: agreement.exactAgreementCount,
  total_count: agreement.totalCount,
  disagreement_count: agreement.disagreementCount,
  distribution: agreement.distribution,
  output: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/priority-wave-1-dual-review-consensus.v0.1.jsonl", sha256: consensusLedgerSha256, row_count: consensusRows.length },
  official_split_eligible: false,
  gold_authoring_status: "BLOCKED",
  no_auto_promotion_to_official_relation: true,
  remaining_281_provisional_rows_not_adjudicated: true,
});

writeJson(resolve(CONSENSUS_DIR, "priority-wave-1-consensus-verification-report.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.11",
  checks: {
    "1_e_row_count_13": eDecisions.length === 13,
    "1_f_row_count_13": fDecisions.length === 13,
    "2_zero_duplicate_ids_e": !eVerification.violations.some((v) => v.type === "DUPLICATE_RELATION_CANDIDATE_ID"),
    "2_zero_duplicate_ids_f": !fVerification.violations.some((v) => v.type === "DUPLICATE_RELATION_CANDIDATE_ID"),
    "3_id_sets_match_packet_e": !eVerification.violations.some((v) => v.type === "MISSING_RELATION_CANDIDATE_IDS" || v.type === "UNEXPECTED_EXTRA_RELATION_CANDIDATE_IDS"),
    "3_id_sets_match_packet_f": !fVerification.violations.some((v) => v.type === "MISSING_RELATION_CANDIDATE_IDS" || v.type === "UNEXPECTED_EXTRA_RELATION_CANDIDATE_IDS"),
    "4_no_disallowed_disposition_e": !eVerification.violations.some((v) => v.type === "DISALLOWED_DISPOSITION"),
    "4_no_disallowed_disposition_f": !fVerification.violations.some((v) => v.type === "DISALLOWED_DISPOSITION"),
    "5_confirm_targets_in_considered_set_e": !eVerification.violations.some((v) => v.type === "CONFIRM_TARGET_NOT_IN_CONSIDERED_SET"),
    "5_confirm_targets_in_considered_set_f": !fVerification.violations.some((v) => v.type === "CONFIRM_TARGET_NOT_IN_CONSIDERED_SET"),
    "6_non_confirm_targets_null_e": !eVerification.violations.some((v) => v.type === "NON_CONFIRM_ROW_HAS_TARGET"),
    "6_non_confirm_targets_null_f": !fVerification.violations.some((v) => v.type === "NON_CONFIRM_ROW_HAS_TARGET"),
    "7_zero_empty_notes_e": !eVerification.violations.some((v) => v.type === "EMPTY_NOTE"),
    "7_zero_empty_notes_f": !fVerification.violations.some((v) => v.type === "EMPTY_NOTE"),
    "8_packet_sha_matches_e": !eVerification.violations.some((v) => v.type === "PACKET_SHA_MISMATCH"),
    "8_packet_sha_matches_f": !fVerification.violations.some((v) => v.type === "PACKET_SHA_MISMATCH"),
    "9_reviewer_role_correct_e": !eVerification.violations.some((v) => v.type === "REVIEWER_ROLE_MISMATCH"),
    "9_reviewer_role_correct_f": !fVerification.violations.some((v) => v.type === "REVIEWER_ROLE_MISMATCH"),
    "10_attestation_cites_own_decision_sha_e": eAttestedDecisionSha === EXPECTED_E_DECISION_SHA256,
    "10_attestation_cites_own_decision_sha_f": fAttestedDecisionSha === EXPECTED_F_DECISION_SHA256,
    "10_attestation_cites_packet_sha_e": eAttestation.input_packet?.sha256 === EXPECTED_PACKET_SHA256,
    "10_attestation_cites_packet_sha_f": fAttestation.input_packet?.sha256 === EXPECTED_PACKET_SHA256,
    "11_disposition_13_of_13_identical": agreement.exactAgreementCount === 13 && agreement.rows.every((r) => r.reviewer_e.disposition === r.reviewer_f.disposition),
    "12_confirm_target_13_of_13_identical": agreement.rows.every((r) => r.reviewer_e.confirmed_target_document_id === r.reviewer_f.confirmed_target_document_id),
  },
  e_violations: eVerification.violations,
  f_violations: fVerification.violations,
  agreement_summary: { total: agreement.totalCount, exact_agreement: agreement.exactAgreementCount, disagreement: agreement.disagreementCount, distribution: agreement.distribution },
  all_checks_passed: eVerification.ok && fVerification.ok && agreement.exactAgreementCount === 13 && agreement.disagreementCount === 0,
});

// == 6. Prospective graph (N4.9 policy unchanged, Wave 1 overlay applied) ==
const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const packet326Sha256 = sha256File(PACKET_326_PATH);
const n49Report = readJson(N49_IMPACT_REPORT_PATH);
if (n49Report.input_shas.relation_closure_review_packet_v01_sha256 !== packet326Sha256) { console.error("BLOCKER: 326-packet sha256 does not match Turn N4.9's own pin"); process.exit(1); }

const ledgerRows = readJsonl(LEDGER_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }
const ledgerSha256 = sha256File(LEDGER_PATH);
if (n49Report.input_shas.relation_closure_candidate_ledger_v02_sha256 !== ledgerSha256) { console.error("BLOCKER: ledger v0.2 sha256 does not match Turn N4.9's own pin"); process.exit(1); }
const ownerRejectCount = ledgerRows.filter((r) => r.decision_authority === "OWNER_V03" && r.final_disposition === "REJECT").length;
if (ownerRejectCount !== 8) { console.error(`BLOCKER: Owner REJECT count ${ownerRejectCount} !== 8`); process.exit(1); }
const provisionalLedgerRows = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL");
if (provisionalLedgerRows.length !== 294) { console.error(`BLOCKER: provisional ledger row count ${provisionalLedgerRows.length} !== 294`); process.exit(1); }

const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool row count ${poolRecords.length} !== 500`); process.exit(1); }
const poolSha256 = sha256File(POOL_PATH);
if (n49Report.input_shas.candidate_pool_v041_sha256 !== poolSha256) { console.error("BLOCKER: Candidate Pool sha256 does not match Turn N4.9's own pin"); process.exit(1); }

const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 row count ${anchorV02.length} !== 150`); process.exit(1); }
const anchorV02Sha256 = sha256File(ANCHOR_V02_PATH);
if (n49Report.input_shas.anchor_selection_v02_sha256 !== anchorV02Sha256) { console.error("BLOCKER: Anchor v0.2 sha256 does not match Turn N4.9's own pin"); process.exit(1); }

const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 row count ${authorV02.length} !== 150`); process.exit(1); }
const authorV02Sha256 = sha256File(AUTHOR_V02_PATH);
if (n49Report.input_shas.author_allocation_v02_sha256 !== authorV02Sha256) { console.error("BLOCKER: Author v0.2 sha256 does not match Turn N4.9's own pin"); process.exit(1); }
const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV02) authorCounts[r.author_allocation] += 1;
if (authorCounts.AUTHOR_A !== 75 || authorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: Author v0.2 balance ${JSON.stringify(authorCounts)} !== 75/75`); process.exit(1); }

const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }
if (quarantineManifest.status !== "QUARANTINED_UNRESOLVED_RELATION") { console.error("BLOCKER: quarantine manifest status changed"); process.exit(1); }
// quarantine-manifest.v0.2.json's own generated_at legitimately changes on
// every re-run of build-relation-closure-owner-integration-v047.mjs -- see
// Turn N4.9's own note on this. Content invariants checked above instead of
// a raw byte-for-byte sha pin.

const consensusByRelationCandidateId = new Map(agreement.rows.map((r) => [r.relation_candidate_id, { consensus_disposition: r.consensus_disposition, consensus_target_document_id: r.consensus_target_document_id }]));
const wave1Ids = new Set(consensusByRelationCandidateId.keys());

const prospectiveGraph = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId });
writeJsonl(resolve(CONSENSUS_DIR, "prospective-graph-edges-after-wave1.v0.1.jsonl"), prospectiveGraph.rawEdges);
writeJson(resolve(CONSENSUS_DIR, "prospective-graph-components-after-wave1.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  scope: "PROSPECTIVE_GRAPH_AFTER_WAVE1_CONSENSUS -- NOT an official relation graph; Owner has not ratified this",
  total_candidate_edge_count: prospectiveGraph.totalCandidateEdgeCount,
  distinct_cross_component_pair_count: prospectiveGraph.distinctCrossComponentPairCount,
  maximal_component_count: prospectiveGraph.maximalComponents.length,
  largest_maximal_component_base_component_count: prospectiveGraph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0),
  maximal_components: prospectiveGraph.maximalComponents,
});

const splitImpact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const authorImpact = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: packet326 });
const quarantineImpact = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV02.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })),
  resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
});
const allOk = splitImpact.ok && authorImpact.ok && quarantineImpact.ok;
const affectedAssignmentIds = [...new Set([
  ...splitImpact.violations.flatMap((v) => v.assignment_ids),
  ...authorImpact.violations.flatMap((v) => v.assignment_ids),
  ...quarantineImpact.violations.map((v) => v.assignment_id),
])].sort();

const prospectiveImpactReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.11",
  scope: "PROSPECTIVE_GRAPH_AFTER_WAVE1_CONSENSUS -- N4.9 policy unchanged for every row outside Priority Wave 1's 13; NOT official, Owner has not ratified",
  wave1_consensus_applied_to_relation_candidate_ids: [...wave1Ids].sort(),
  graph_summary: { total_candidate_edge_count: prospectiveGraph.totalCandidateEdgeCount, distinct_cross_component_pair_count: prospectiveGraph.distinctCrossComponentPairCount, maximal_component_count: prospectiveGraph.maximalComponents.length, largest_maximal_component_base_component_count: prospectiveGraph.maximalComponents.reduce((max, c) => Math.max(max, c.base_component_count), 0) },
  split_impact: splitImpact,
  author_impact: authorImpact,
  quarantine_impact: quarantineImpact,
  affected_assignment_ids: affectedAssignmentIds,
  affected_assignment_count: affectedAssignmentIds.length,
  all_zero_prospective_leakage: allOk,
  candidate_pool_500_unchanged: poolRecords.length === 500,
  anchor_150_unchanged: anchorV02.length === 150,
  author_75_75_unchanged: authorCounts.AUTHOR_A === 75 && authorCounts.AUTHOR_B === 75,
  official_split_eligible: false,
};
const prospectiveImpactReportPath = resolve(CONSENSUS_DIR, "prospective-graph-impact-after-wave1.v0.1.json");
writeJson(prospectiveImpactReportPath, prospectiveImpactReport);

// == 7. N4.9 -> N4.11 diff ===================================================
const n49EdgesForWave1Ids = readJsonl(resolve(DR_DIR, "decision-respecting-graph-edges.v0.1.jsonl")).filter((e) => wave1Ids.has(e.relation_candidate_id));
const n411EdgesForWave1Ids = prospectiveGraph.rawEdges.filter((e) => wave1Ids.has(e.relation_candidate_id));
const graphDiff = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.11",
  n49: {
    total_candidate_edge_count: n49Report.decision_respecting_graph_summary.total_candidate_edge_count,
    maximal_component_count: n49Report.decision_respecting_graph_summary.maximal_component_count,
    largest_maximal_component_base_component_count: n49Report.decision_respecting_graph_summary.largest_maximal_component_base_component_count,
    split_violation_count: n49Report.split_impact.violations.length,
    author_violation_count: n49Report.author_impact.violations.length,
    quarantine_violation_count: n49Report.quarantine_impact.violations.length,
    affected_assignment_count: n49Report.affected_assignment_count,
    wave1_edge_count_before: n49EdgesForWave1Ids.length,
  },
  n411: {
    total_candidate_edge_count: prospectiveGraph.totalCandidateEdgeCount,
    maximal_component_count: prospectiveGraph.maximalComponents.length,
    largest_maximal_component_base_component_count: prospectiveImpactReport.graph_summary.largest_maximal_component_base_component_count,
    split_violation_count: splitImpact.violations.length,
    author_violation_count: authorImpact.violations.length,
    quarantine_violation_count: quarantineImpact.violations.length,
    affected_assignment_count: affectedAssignmentIds.length,
    wave1_edge_count_after: n411EdgesForWave1Ids.length,
  },
  deltas: {
    total_candidate_edge_count_delta: prospectiveGraph.totalCandidateEdgeCount - n49Report.decision_respecting_graph_summary.total_candidate_edge_count,
    wave1_edges_removed: n49EdgesForWave1Ids.length - n411EdgesForWave1Ids.length,
    maximal_component_count_delta: prospectiveGraph.maximalComponents.length - n49Report.decision_respecting_graph_summary.maximal_component_count,
    split_violation_count_delta: splitImpact.violations.length - n49Report.split_impact.violations.length,
    author_violation_count_delta: authorImpact.violations.length - n49Report.author_impact.violations.length,
    affected_assignment_count_delta: affectedAssignmentIds.length - n49Report.affected_assignment_count,
  },
  note: "N4.9's own artifacts (this section's 'n49' values) were read-only inputs here and are byte-unmodified. This diff is PROSPECTIVE-vs-baseline only, never a claim that N4.9's result was wrong.",
};
writeJson(resolve(CONSENSUS_DIR, "n4.9-to-n4.11-graph-diff.v0.1.json"), graphDiff);

// == 8. Gate branch A/B =====================================================
const gateAfterWave1 = allOk
  ? {
      schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.11",
      status: "PROSPECTIVE_LEAKAGE_FREE_PENDING_OWNER_RATIFICATION",
      official_split_eligible: false,
      gold_authoring_status: "BLOCKED_PENDING_WAVE1_OWNER_RATIFICATION",
      wave2_created: false,
      note: "Split and author leakage are both 0 under the prospective (post-Wave-1-consensus) graph. No Wave 2 was created. Owner ratification of the 13-row consensus is still required before official_split_eligible can ever become true.",
    }
  : {
      schema_version: "0.1.0", generated_at: new Date().toISOString(), turn: "N4.11",
      status: "LEAKAGE_REMAINS_AFTER_PRIORITY_WAVE_1",
      official_split_eligible: false,
      gold_authoring_status: "BLOCKED_PENDING_NEXT_PRIORITY_WAVE",
      wave2_created: true,
      note: `${splitImpact.violations.length} split + ${authorImpact.violations.length} author violation components remain under the prospective graph. Priority Wave 2 CANDIDATES (packet + manifest only, no Reviewer UI) were computed from the remaining 281 provisional rows.`,
    };
writeJson(resolve(CONSENSUS_DIR, "gate-status-after-wave1.v0.1.json"), gateAfterWave1);

// == 9. Wave 2 candidates (branch B only) ===================================
let wave2Report = null;
if (!allOk) {
  const remaining281 = packet326.filter((row) => provisionalLedgerRows.some((r) => r.relation_candidate_id === row.relation_candidate_id) && !wave1Ids.has(row.relation_candidate_id));
  if (remaining281.length !== 281) { console.error(`BLOCKER: remaining provisional row count ${remaining281.length} !== 281`); process.exit(1); }

  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows: anchorV02 });
  const violatingMaximalComponentIds = new Set([...splitImpact.violations.map((v) => v.maximal_component_id), ...authorImpact.violations.map((v) => v.maximal_component_id)]);
  const baselineViolationCount = splitImpact.violations.length + authorImpact.violations.length;

  function rebuildAndCountExcluding(relationCandidateId) {
    const reduced = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId, excludeRelationCandidateIds: new Set([relationCandidateId]) });
    const s = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: reduced.resolveMaximalComponentId });
    const a = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: reduced.resolveMaximalComponentId });
    return { splitViolationCount: s.violations.length, authorViolationCount: a.violations.length };
  }

  const classifications281 = remaining281.map((row) => classifyProvisionalRow({
    packetRow: row,
    componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
    violatingMaximalComponentIds,
    baselineViolationCount,
    rebuildAndCountViolationsExcludingThisRow: rebuildAndCountExcluding,
    otherProvisionalPacketRows: remaining281,
  }));
  const wave2Selection = selectPriorityWave1({ classifications: classifications281.map((c) => ({ relation_candidate_id: c.relation_candidate_id, direct_cross_split_edge: c.direct_cross_split_edge, direct_cross_author_edge: c.direct_cross_author_edge, individually_decisive: c.individually_decisive })) });

  const wave2ById = new Map(remaining281.map((r) => [r.relation_candidate_id, r]));
  const wave2Rows = wave2Selection.relationCandidateIds.map((rid) => {
    const row = wave2ById.get(rid);
    const classification = classifications281.find((c) => c.relation_candidate_id === rid);
    return {
      relation_candidate_id: row.relation_candidate_id,
      source_document_id: row.source_document_id,
      relation_type: row.relation_type,
      source_report_name: row.source_report_name,
      source_receipt_date: row.source_receipt_date,
      source_info: row.source_info,
      candidates: row.candidates,
      priority_wave_2_selection_reasons: wave2Selection.reasonsById.get(rid),
      classification_labels: classification.labels,
      owner_disposition: "PENDING",
      confirmed_target_document_id: null,
    };
  });
  const wave2PacketPath = resolve(CONSENSUS_DIR, "priority-wave-2-candidate-packet.v0.1.jsonl");
  writeJsonl(wave2PacketPath, wave2Rows);
  const wave2PacketSha256 = sha256File(wave2PacketPath);
  wave2Report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "N4.11",
    status: "PRIORITY_WAVE_2_CANDIDATES_ONLY_NO_REVIEWER_UI",
    selection_rule: "Union of remaining-281 provisional rows (computed fresh against the PROSPECTIVE post-Wave-1 graph) satisfying direct_cross_split_edge, direct_cross_author_edge, or individually_decisive. Never a hardcoded id list or count.",
    remaining_provisional_row_count: remaining281.length,
    distribution: wave2Selection.distribution,
    multi_condition_count: wave2Selection.multiConditionCount,
    union_count: wave2Selection.unionCount,
    minimality_claim: "NONE -- this is a candidate set, not shown to be the smallest possible.",
    reviewer_ui_created_this_turn: false,
    remaining_281_not_all_auto_reviewed: true,
    output: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/priority-wave-2-candidate-packet.v0.1.jsonl", sha256: wave2PacketSha256, row_count: wave2Rows.length },
  };
  writeJson(resolve(CONSENSUS_DIR, "priority-wave-2-candidate-packet.v0.1.manifest.json"), wave2Report);
}

// == 10. Owner batch-ratification UI (built regardless of gate branch, since
// the 13-row consensus is exact either way -- the page itself renders
// whichever prospective result actually occurred). =========================
const confirmRows = consensusRows.filter((r) => r.consensus_disposition === "CONFIRM");
const rejectRows = consensusRows.filter((r) => r.consensus_disposition === "REJECT");
const uiDir = resolve(CONSENSUS_DIR, "ui/v0.1");
mkdirSync(uiDir, { recursive: true });
const RATIFICATION_EXPORT_FILENAME = "priority-wave-1-owner-ratification-decision.v0.1.json";
const UI_DATA = {
  input_files: {
    reviewer_e_decision: { path: "results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl", sha256: eDecisionSha256 },
    reviewer_f_decision: { path: "results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl", sha256: fDecisionSha256 },
    packet: { path: "priority-wave-1-review-packet.v0.1.jsonl", sha256: packetSha256 },
  },
  agreement: { total: agreement.totalCount, exact: agreement.exactAgreementCount, distribution: agreement.distribution },
  confirm_rows: confirmRows.map((r) => ({ relation_candidate_id: r.relation_candidate_id, source_document_id: r.source_document_id, target: r.consensus_target_document_id })),
  reject_rows: rejectRows.map((r) => ({ relation_candidate_id: r.relation_candidate_id, source_document_id: r.source_document_id, e_note: r.reviewer_e.note, f_note: r.reviewer_f.note })),
  prospective: { before: graphDiff.n49, after: graphDiff.n411, deltas: graphDiff.deltas, leakage_remains: !allOk, gate_status: gateAfterWave1.status },
  consensus_manifest_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/priority-wave-1-dual-review-consensus.v0.1.manifest.json",
  consensus_manifest_sha256: canonicalSha256(readJson(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.manifest.json")), ["generated_at"]),
  reviewer_e_decision_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl",
  reviewer_e_decision_sha256: eDecisionSha256,
  reviewer_f_decision_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl",
  reviewer_f_decision_sha256: fDecisionSha256,
  reviewed_relation_candidate_ids: expectedIds,
  confirm_count: agreement.distribution.CONFIRM,
  reject_count: agreement.distribution.REJECT,
  needs_more_review_count: agreement.distribution.NEEDS_MORE_REVIEW,
  prospective_graph_report_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/prospective-graph-impact-after-wave1.v0.1.json",
  // Turn N4.12 fix: this report embeds its own generated_at (regenerated on
  // every rerun, e.g. every time this script's own test file's test.before
  // executes it) -- a raw file sha256 here would make every downloaded
  // Owner decision go stale on the very next test run, exactly the same
  // volatility class as quarantine-manifest.v0.2.json. Use the CANONICAL
  // (generated_at-excluded) digest instead, matching consensus_manifest_sha256
  // below.
  prospective_graph_report_sha256: canonicalSha256(readJson(prospectiveImpactReportPath), ["generated_at"]),
  export_filename: RATIFICATION_EXPORT_FILENAME,
  checklist_items: [
    { id: "e_f_independent", label: "Reviewer E와 Reviewer F가 이 13건 모두를 독립적으로 검수했음을 확인했다" },
    { id: "disposition_match", label: "disposition이 13/13 정확히 일치함을 확인했다" },
    { id: "confirm_target_match", label: "CONFIRM target이 6/6 정확히 일치함을 확인했다" },
    { id: "reject_reason_real", label: "REJECT 7건은 후보 목록 내 실제 target 부재(원본 미대응)로 판정되었음을 확인했다" },
    { id: "scope_13_only", label: "이번 승인은 이 13건에만 적용됨을 이해했다" },
    { id: "no_281_approval", label: "나머지 281건을 이 승인으로 승인하지 않음을 이해했다" },
    { id: "prospective_reviewed", label: "prospective graph before/after 결과를 확인했다" },
    { id: "gates_separate", label: "official split과 Gold 작성은 이 승인과 별도의 gate임을 이해했다" },
  ],
};
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.11 Priority Wave 1 Owner Ratification (v0.1)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:24px;}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;word-break:break-all;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;}
.pass{background:#e6f4ea;color:#1a7f37;} .fail{background:#fde2e1;color:#c0362c;}
.checklist label{display:block;margin:6px 0;font-size:14px;}
fieldset{border:1px solid #ccc;border-radius:6px;margin:14px 0;padding:10px 14px;}
label.radio{display:block;margin:6px 0;font-size:14px;}
textarea,input[type=text]{width:100%;box-sizing:border-box;padding:6px;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#downloadBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#downloadBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;width:100%;box-sizing:border-box;}
</style></head>
<body>
<h1>Turn N4.11 -- Priority Wave 1 Owner Batch Ratification</h1>
<div class="warnbox">이 승인은 Reviewer E/F 13건 합의를 <b>기록</b>하는 것이며, 공식 Relation 승격·official split·Gold 작성과는 별개다. 아래 버튼을 눌러도 <b>official_split_eligible과 gold_authoring_authorized는 항상 false</b>로 내보내진다.</div>

<h2>입력 파일</h2>
<table><tr><th>파일</th><th>SHA-256</th></tr>
<tr><td>Reviewer E decision</td><td><code>${esc(UI_DATA.input_files.reviewer_e_decision.sha256)}</code></td></tr>
<tr><td>Reviewer F decision</td><td><code>${esc(UI_DATA.input_files.reviewer_f_decision.sha256)}</code></td></tr>
<tr><td>Priority Wave 1 packet</td><td><code>${esc(UI_DATA.input_files.packet.sha256)}</code></td></tr>
</table>

<h2>일치 결과</h2>
<p>exact agreement: <b>${UI_DATA.agreement.exact}/${UI_DATA.agreement.total}</b> / CONFIRM ${UI_DATA.agreement.distribution.CONFIRM} / REJECT ${UI_DATA.agreement.distribution.REJECT} / NEEDS_MORE_REVIEW ${UI_DATA.agreement.distribution.NEEDS_MORE_REVIEW}</p>

<h2>CONFIRM ${UI_DATA.confirm_rows.length}건 (source -> target)</h2>
<table><tr><th>relation_candidate_id</th><th>source</th><th>target</th></tr>
${UI_DATA.confirm_rows.map((r) => `<tr><td>${esc(r.relation_candidate_id)}</td><td>${esc(r.source_document_id)}</td><td>${esc(r.target)}</td></tr>`).join("\n")}
</table>

<h2>REJECT ${UI_DATA.reject_rows.length}건 (source, 후보 부재 근거 요약)</h2>
<table><tr><th>relation_candidate_id</th><th>source</th><th>E note (요약)</th></tr>
${UI_DATA.reject_rows.map((r) => `<tr><td>${esc(r.relation_candidate_id)}</td><td>${esc(r.source_document_id)}</td><td>${esc((r.e_note || "").slice(0, 160))}...</td></tr>`).join("\n")}
</table>

<h2>Prospective Graph (N4.9 -> N4.11)</h2>
<table><tr><th>지표</th><th>N4.9 (before)</th><th>N4.11 prospective (after)</th></tr>
<tr><td>edge 수</td><td>${UI_DATA.prospective.before.total_candidate_edge_count}</td><td>${UI_DATA.prospective.after.total_candidate_edge_count}</td></tr>
<tr><td>component 수</td><td>${UI_DATA.prospective.before.maximal_component_count}</td><td>${UI_DATA.prospective.after.maximal_component_count}</td></tr>
<tr><td>split leakage</td><td>${UI_DATA.prospective.before.split_violation_count}</td><td>${UI_DATA.prospective.after.split_violation_count}</td></tr>
<tr><td>author leakage</td><td>${UI_DATA.prospective.before.author_violation_count}</td><td>${UI_DATA.prospective.after.author_violation_count}</td></tr>
<tr><td>영향 assignment 수</td><td>${UI_DATA.prospective.before.affected_assignment_count}</td><td>${UI_DATA.prospective.after.affected_assignment_count}</td></tr>
</table>
<p>leakage 잔존: <span class="badge ${UI_DATA.prospective.leakage_remains ? "fail" : "pass"}">${UI_DATA.prospective.leakage_remains ? "YES (LEAKAGE_REMAINS_AFTER_PRIORITY_WAVE_1)" : "NO (PROSPECTIVE_LEAKAGE_FREE_PENDING_OWNER_RATIFICATION)"}</span></p>
<div class="warnbox">official split은 아직 <b>false</b>다. Gold 작성은 아직 <b>BLOCKED</b>다. 이 페이지의 승인은 그 상태를 바꾸지 않는다.</div>

<h2>Owner 선택</h2>
<fieldset>
<label class="radio"><input type="radio" name="ownerChoice" value="APPROVE_DUAL_REVIEW_CONSENSUS"/> APPROVE_DUAL_REVIEW_CONSENSUS</label>
<label class="radio"><input type="radio" name="ownerChoice" value="FIX_REQUIRED"/> FIX_REQUIRED</label>
<label class="radio"><input type="radio" name="ownerChoice" value="REJECT_BATCH"/> REJECT_BATCH</label>
</fieldset>
<div id="approveChecklist" class="checklist" hidden></div>
<label>Owner 이름/ID (필수)</label>
<input type="text" id="ownerName"/>
<label>owner_note (FIX_REQUIRED/REJECT_BATCH 시 필수)</label>
<textarea id="ownerNote"></textarea>
<div class="btnrow">
<button id="downloadBtn" disabled>Download Decision (JSON)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>

<script id="review-data" type="application/json">${JSON.stringify(UI_DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var downloadBtn = document.getElementById("downloadBtn");
  var copyBtn = document.getElementById("copyBtn");
  var checklistEl = document.getElementById("approveChecklist");
  var ownerNameEl = document.getElementById("ownerName");
  var ownerNoteEl = document.getElementById("ownerNote");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var checklistState = {};
  var lastExportText = "";

  function renderChecklist() {
    checklistEl.textContent = "";
    DATA.checklist_items.forEach(function (item) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checklistState[item.id];
      cb.addEventListener("change", function () { checklistState[item.id] = cb.checked; updateButtons(); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.label));
      checklistEl.appendChild(label);
    });
  }
  renderChecklist();

  function currentChoice() {
    var checked = document.querySelector('input[name="ownerChoice"]:checked');
    return checked ? checked.value : null;
  }
  function allChecklistChecked() { return DATA.checklist_items.every(function (item) { return !!checklistState[item.id]; }); }
  function readyToExport() {
    var choice = currentChoice();
    if (!choice) return false;
    if (!ownerNameEl.value.trim()) return false;
    if (choice === "APPROVE_DUAL_REVIEW_CONSENSUS") return allChecklistChecked();
    if (choice === "FIX_REQUIRED" || choice === "REJECT_BATCH") return !!ownerNoteEl.value.trim();
    return false;
  }
  function updateButtons() {
    checklistEl.hidden = currentChoice() !== "APPROVE_DUAL_REVIEW_CONSENSUS";
    var ok = readyToExport();
    downloadBtn.disabled = !ok; downloadBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }
  document.querySelectorAll('input[name="ownerChoice"]').forEach(function (r) { r.addEventListener("change", updateButtons); });
  ownerNameEl.addEventListener("input", updateButtons);
  ownerNoteEl.addEventListener("input", updateButtons);
  updateButtons();

  function buildDecision() {
    return {
      schema_version: "0.1.0",
      decision_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
      owner: ownerNameEl.value.trim(),
      decided_at: new Date().toISOString(),
      owner_disposition: currentChoice(),
      owner_note: ownerNoteEl.value.trim() || null,
      consensus_manifest_path: DATA.consensus_manifest_path,
      consensus_manifest_sha256: DATA.consensus_manifest_sha256,
      reviewer_e_decision_path: DATA.reviewer_e_decision_path,
      reviewer_e_decision_sha256: DATA.reviewer_e_decision_sha256,
      reviewer_f_decision_path: DATA.reviewer_f_decision_path,
      reviewer_f_decision_sha256: DATA.reviewer_f_decision_sha256,
      reviewed_relation_candidate_ids: DATA.reviewed_relation_candidate_ids,
      confirm_count: DATA.confirm_count,
      reject_count: DATA.reject_count,
      needs_more_review_count: DATA.needs_more_review_count,
      prospective_graph_report_path: DATA.prospective_graph_report_path,
      prospective_graph_report_sha256: DATA.prospective_graph_report_sha256,
      official_split_eligible: false,
      gold_authoring_authorized: false,
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
  downloadBtn.addEventListener("click", function () {
    if (!readyToExport()) return;
    var text = JSON.stringify(buildDecision(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.export_filename);
    msgEl.textContent = DATA.export_filename + " 다운로드를 시작했습니다.";
  });
  copyBtn.addEventListener("click", function () {
    if (!readyToExport()) return;
    var text = lastExportText || JSON.stringify(buildDecision(), null, 2);
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
})();
</script>
</body></html>
`;
const htmlPath = resolve(uiDir, "priority-wave-1-owner-ratification.html");
writeFileSync(htmlPath, html, "utf8");
const uiHtmlSha256 = sha256File(htmlPath);
writeJson(resolve(uiDir, "priority-wave-1-owner-ratification-ui-build-report.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/ui/v0.1/priority-wave-1-owner-ratification.html",
  html_sha256: uiHtmlSha256,
  export_filename: RATIFICATION_EXPORT_FILENAME,
  auto_approved: false,
  official_split_eligible_settable_by_this_ui: false,
  gold_authoring_authorized_settable_by_this_ui: false,
});

console.log(JSON.stringify({
  status: "PRIORITY_WAVE_1_CONSENSUS_RECORDED_PENDING_OWNER",
  gate_status: gateAfterWave1.status,
  agreement: { total: agreement.totalCount, exact: agreement.exactAgreementCount, distribution: agreement.distribution },
  graph_diff: graphDiff.deltas,
  wave2_created: !allOk,
  wave2_summary: wave2Report ? { union_count: wave2Report.union_count, distribution: wave2Report.distribution, multi_condition_count: wave2Report.multi_condition_count } : null,
  owner_ui_html_sha256: uiHtmlSha256,
}, null, 2));
