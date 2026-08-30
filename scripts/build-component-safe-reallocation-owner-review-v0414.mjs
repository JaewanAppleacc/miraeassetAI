#!/usr/bin/env node
// Turn N4.14: builds the Owner review packet + decision template + UI for
// Turn N4.13's Strategy A (component-safe assignment-only reallocation)
// plan. This script NEVER applies the plan: anchor-selection.v0.2.jsonl,
// author-allocation.v0.2.jsonl, and candidate-pool.v0.1.jsonl are read-only
// inputs, byte-unmodified by this script or by checking every box in the
// generated UI. official_split_eligible and gold_authoring_authorized are
// hardcoded false everywhere this script writes, and the UI's own
// JavaScript can never set them true either.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMovementSummary } from "../domain/evaluation/component-safe-reallocation-owner-review.mjs";
import { buildProspectiveGraph } from "../domain/evaluation/relation-closure-prospective-consensus-graph.mjs";
import { computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact, computeMaximalGraphQuarantineImpact, buildDocumentToBaseComponentMap } from "../domain/evaluation/relation-closure-maximal-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
// N4.11/N4.12 already discovered this exact volatility class: any Turn N4.13
// output that embeds its own `generated_at` (plan, verification report,
// baseline, input-pin-manifest -- everything except the delta jsonl, whose
// rows carry no timestamp) is legitimately rewritten with a fresh
// generated_at every time build-component-safe-reallocation-v0413.mjs
// re-runs (e.g. inside npm run test:domain). A RAW file hash for these
// fields would make every downloaded Owner decision go stale on the very
// next test run. Use the CANONICAL (generated_at-excluded) digest instead,
// exactly like consensus_manifest_sha256/prospective_graph_report_sha256
// already do for the Priority Wave 1 flow.
function canonicalSha256File(p) {
  const obj = JSON.parse(readFileSync(p, "utf8"));
  const clone = { ...obj };
  delete clone.generated_at;
  return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const DR_DIR = resolve(V02_DIR, "decision-respecting-graph-v0.1");
const OWNER_REVIEW_DIR = resolve(CSR_DIR, "owner-review-v0.1");

const PLAN_PATH = resolve(CSR_DIR, "strategy-a-assignment-only-plan.v0.1.json");
const DELTA_PATH = resolve(CSR_DIR, "strategy-a-assignment-delta.v0.1.jsonl");
const VERIFICATION_REPORT_PATH = resolve(CSR_DIR, "strategy-a-verification-report.v0.1.json");
const BASELINE_PATH = resolve(CSR_DIR, "current-leakage-baseline.v0.1.json");
const INPUT_PIN_MANIFEST_PATH = resolve(CSR_DIR, "input-pin-manifest.v0.1.json");
const STRATEGY_COMPARISON_PATH = resolve(CSR_DIR, "strategy-comparison.v0.1.json");
const RECOMMENDED_ACTION_PATH = resolve(CSR_DIR, "recommended-next-action.v0.1.json");
const GATE_STATUS_V01_PATH = resolve(CSR_DIR, "gate-status.v0.1.json");

const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const POOL_MANIFEST_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.manifest.json");
const QUARANTINE_MANIFEST_PATH = resolve(V02_DIR, "quarantine/quarantine-manifest.v0.2.json");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const RATIFIED_CONSENSUS_PATH = resolve(DR_DIR, "priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratified-consensus.v0.1.jsonl");
const OWNER_DECISION_PATH = resolve(DR_DIR, "priority-wave-1-v0.1/results/owner-v0.1/priority-wave-1-owner-ratification-decision.v0.1.json");

mkdirSync(OWNER_REVIEW_DIR, { recursive: true });

// == 1. Pre-verification (15 items) -- ABORT before writing anything ========
const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 count ${anchorV02.length} !== 150`); process.exit(1); }
const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 count ${authorV02.length} !== 150`); process.exit(1); }
const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV02) authorCounts[r.author_allocation] += 1;
if (authorCounts.AUTHOR_A !== 75 || authorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: author balance ${JSON.stringify(authorCounts)} !== 75/75`); process.exit(1); }

const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool count ${poolRecords.length} !== 500`); process.exit(1); }
const poolManifest = readJson(POOL_MANIFEST_PATH);
if (poolManifest.candidate_pool_record_count !== 500) { console.error("BLOCKER: Candidate Pool manifest record_count is not 500"); process.exit(1); }

const plan = readJson(PLAN_PATH);
if (plan.verdict !== "FEASIBLE_EXACT") { console.error(`BLOCKER: Strategy A verdict is not FEASIBLE_EXACT (actual ${plan.verdict})`); process.exit(1); }
if (plan.status !== "CANDIDATE_NOT_APPLIED") { console.error(`BLOCKER: Strategy A plan status is not CANDIDATE_NOT_APPLIED (actual ${plan.status})`); process.exit(1); }
if (plan.official_split_eligible !== false) { console.error("BLOCKER: Strategy A plan official_split_eligible is not false"); process.exit(1); }
if (plan.gold_authoring_authorized !== false) { console.error("BLOCKER: Strategy A plan gold_authoring_authorized is not false"); process.exit(1); }

const deltaRows = readJsonl(DELTA_PATH);
const splitOpCount = deltaRows.filter((r) => r.dimension === "split").length;
const authorOpCount = deltaRows.filter((r) => r.dimension === "author").length;
if (splitOpCount !== 62) { console.error(`BLOCKER: split operation count ${splitOpCount} !== 62`); process.exit(1); }
if (authorOpCount !== 8) { console.error(`BLOCKER: author operation count ${authorOpCount} !== 8`); process.exit(1); }

const verificationReport = readJson(VERIFICATION_REPORT_PATH);
if (!verificationReport.checks.quarantine_intrusion_zero) { console.error("BLOCKER: strategy-a-verification-report quarantine_intrusion_zero is not true"); process.exit(1); }
if (!verificationReport.checks.critical_slice_floor_preserved) { console.error("BLOCKER: strategy-a-verification-report critical_slice_floor_preserved is not true"); process.exit(1); }

const baseline = readJson(BASELINE_PATH);
const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }

// == 2. Independent recomputation -- never trust the stored report blindly =
const packet326 = readJsonl(PACKET_326_PATH);
const ledgerRows = readJsonl(LEDGER_PATH);
const ratifiedConsensus = readJsonl(RATIFIED_CONSENSUS_PATH);
const consensusByRelationCandidateId = new Map(ratifiedConsensus.map((r) => [r.relation_candidate_id, { consensus_disposition: r.consensus_disposition, consensus_target_document_id: r.consensus_target_document_id }]));
const prospectiveGraph = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId });

const originalSplitCounts = {};
for (const s of ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"]) originalSplitCounts[s] = poolRecords.filter((r) => r.planned_split === s).length;
if (originalSplitCounts.DEV_TUNE !== 242 || originalSplitCounts.DEV_CHECK !== 81 || originalSplitCounts.HOLDOUT !== 177) {
  console.error(`BLOCKER: current Candidate Pool split counts ${JSON.stringify(originalSplitCounts)} !== 242/81/177`);
  process.exit(1);
}
const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: packet326 });
const beforeSplitImpact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const beforeAuthorImpact = computeMaximalGraphAuthorImpact({ authorRows: authorV02, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
if (beforeSplitImpact.violations.length !== 6) { console.error(`BLOCKER: recomputed BEFORE split leakage ${beforeSplitImpact.violations.length} !== 6`); process.exit(1); }
if (beforeAuthorImpact.violations.length !== 4) { console.error(`BLOCKER: recomputed BEFORE author leakage ${beforeAuthorImpact.violations.length} !== 4`); process.exit(1); }

// Apply the delta to FRESH in-memory copies only.
const simulatedPoolById = new Map(poolRecords.map((r) => [r.assignment_id, { ...r }]));
const simulatedAuthorById = new Map(authorV02.map((r) => [r.assignment_id, { ...r }]));
for (const move of deltaRows) {
  if (move.dimension === "split") simulatedPoolById.get(move.assignment_id).planned_split = move.to;
  else if (move.dimension === "author") simulatedAuthorById.get(move.assignment_id).author_allocation = move.to;
}
const simulatedPoolRecords = [...simulatedPoolById.values()];
const simulatedAuthorRows = [...simulatedAuthorById.values()];
const afterSplitImpact = computeMaximalGraphSplitImpact({ poolRecords: simulatedPoolRecords, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const afterAuthorImpact = computeMaximalGraphAuthorImpact({ authorRows: simulatedAuthorRows, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const afterQuarantineImpact = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV02.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })),
  resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
});
if (afterSplitImpact.violations.length !== 0) { console.error(`BLOCKER: recomputed AFTER split leakage ${afterSplitImpact.violations.length} !== 0`); process.exit(1); }
if (afterAuthorImpact.violations.length !== 0) { console.error(`BLOCKER: recomputed AFTER author leakage ${afterAuthorImpact.violations.length} !== 0`); process.exit(1); }
if (afterQuarantineImpact.violations.length !== 0) { console.error(`BLOCKER: recomputed AFTER quarantine intrusion ${afterQuarantineImpact.violations.length} !== 0`); process.exit(1); }

const afterSplitCounts = {};
for (const s of ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"]) afterSplitCounts[s] = simulatedPoolRecords.filter((r) => r.planned_split === s).length;
if (JSON.stringify(afterSplitCounts) !== JSON.stringify(originalSplitCounts)) { console.error(`BLOCKER: split counts not restored exactly: before=${JSON.stringify(originalSplitCounts)} after=${JSON.stringify(afterSplitCounts)}`); process.exit(1); }
const afterAuthorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of simulatedAuthorRows) afterAuthorCounts[r.author_allocation] += 1;
if (afterAuthorCounts.AUTHOR_A !== 75 || afterAuthorCounts.AUTHOR_B !== 75) { console.error(`BLOCKER: author counts not restored to 75/75: ${JSON.stringify(afterAuthorCounts)}`); process.exit(1); }
if (anchorV02.length !== 150) { console.error("BLOCKER: Anchor membership count changed (impossible -- delta never touches Anchor list)"); process.exit(1); }
// Anchor membership itself is never touched by the delta (only planned_split/
// author_allocation LABELS on existing records) -- critical slice floors,
// which are purely a function of Anchor MEMBERSHIP + tags, are therefore
// trivially and exactly preserved. Confirmed by construction, not assumed:
// the Anchor v0.2 array read above is the SAME 150 records before and after.

// == 3. Movement summary (never assumes 70 unique == 70 operations) ========
const movementSummary = computeMovementSummary({ deltaRows });
if (movementSummary.split_operation_count !== 62 || movementSummary.author_operation_count !== 8) {
  console.error(`BLOCKER: movement summary operation counts ${movementSummary.split_operation_count}/${movementSummary.author_operation_count} !== 62/8`);
  process.exit(1);
}
writeJson(resolve(OWNER_REVIEW_DIR, "strategy-a-movement-summary.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.14",
  ...movementSummary,
  note: "operations (70 total: 62 split + 8 author) are NOT assumed to equal 70 unique assignments -- unique_changed_assignment_count and overlapping_assignment_ids are computed directly from the delta file.",
});

// == 4. Owner review packet + manifest ======================================
const planSha256 = canonicalSha256File(PLAN_PATH);
const deltaSha256 = sha256File(DELTA_PATH); // delta rows carry no generated_at -- raw hash is genuinely stable
const verificationReportSha256 = canonicalSha256File(VERIFICATION_REPORT_PATH);
const baselineSha256 = canonicalSha256File(BASELINE_PATH);
const inputPinManifestSha256 = canonicalSha256File(INPUT_PIN_MANIFEST_PATH);

const ownerReviewPacket = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.14",
  meaning: {
    what_strategy_a_is: "A component-safe relabeling of EXISTING Pool500/Anchor150 records' planned_split and author_allocation fields, so that every prospective maximal component ends up entirely on one split and (where it includes Anchor members) one author.",
    anchor_questions_not_replaced: true,
    question_answer_document_content_unchanged: true,
    only_split_author_labels_change: true,
    not_a_relation_281_decision: true,
    not_a_gold_authoring_approval: true,
  },
  operation_counts: { split: splitOpCount, author: authorOpCount, total: splitOpCount + authorOpCount },
  unique_vs_overlap: {
    unique_changed_assignment_count: movementSummary.unique_changed_assignment_count,
    overlap_count: movementSummary.overlap_count,
    overlapping_assignment_ids: movementSummary.overlapping_assignment_ids,
  },
  forced_vs_compensating: { split: movementSummary.split_reason_counts, author: movementSummary.author_reason_counts },
  component_movement_summary: movementSummary.component_movement_summary,
  split_transition_counts: movementSummary.split_transition_counts,
  author_transition_counts: movementSummary.author_transition_counts,
  before_after: {
    split_counts: { before: originalSplitCounts, after: afterSplitCounts },
    author_counts: { before: authorCounts, after: afterAuthorCounts },
    split_leakage: { before: beforeSplitImpact.violations.length, after: afterSplitImpact.violations.length },
    author_leakage: { before: beforeAuthorImpact.violations.length, after: afterAuthorImpact.violations.length },
    quarantine_intrusion: { before: 0, after: afterQuarantineImpact.violations.length },
  },
  critical_slice_floor_preserved: true,
  anchor_membership_unchanged: true,
  candidate_pool_count: poolRecords.length,
  anchor_count: anchorV02.length,
  status: "CANDIDATE_NOT_APPLIED",
  official_split_eligible: false,
  gold_authoring_authorized: false,
  owner_approval_required: true,
};
const ownerReviewPacketPath = resolve(OWNER_REVIEW_DIR, "strategy-a-owner-review-packet.v0.1.json");
writeJson(ownerReviewPacketPath, ownerReviewPacket);
const ownerReviewPacketSha256 = sha256File(ownerReviewPacketPath);

writeJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-review-packet.v0.1.manifest.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.14",
  inputs: {
    strategy_a_plan: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-only-plan.v0.1.json", sha256: planSha256 },
    strategy_a_delta: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-delta.v0.1.jsonl", sha256: deltaSha256, row_count: deltaRows.length },
    strategy_a_verification_report: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-verification-report.v0.1.json", sha256: verificationReportSha256 },
    current_leakage_baseline: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/current-leakage-baseline.v0.1.json", sha256: baselineSha256 },
    input_pin_manifest: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/input-pin-manifest.v0.1.json", sha256: inputPinManifestSha256 },
    anchor_selection_v02: { path: "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl", sha256: sha256File(ANCHOR_V02_PATH), row_count: anchorV02.length },
    author_allocation_v02: { path: "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl", sha256: sha256File(AUTHOR_V02_PATH), row_count: authorV02.length },
    candidate_pool_v041: { path: "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl", sha256: sha256File(POOL_PATH), row_count: poolRecords.length },
    quarantine_manifest_v02: { path: "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json", sha256: sha256File(QUARANTINE_MANIFEST_PATH) },
    owner_ratification_decision_wave1: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/results/owner-v0.1/priority-wave-1-owner-ratification-decision.v0.1.json", sha256: sha256File(OWNER_DECISION_PATH) },
  },
  pre_verification_all_passed: true,
  output: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/owner-review-v0.1/strategy-a-owner-review-packet.v0.1.json", sha256: ownerReviewPacketSha256 },
});

// == 5. Decision template (schema only, PENDING) ============================
const decisionTemplate = {
  schema_version: "0.1.0",
  decision_id: null,
  owner: null,
  decided_at: null,
  owner_disposition: "PENDING",
  owner_note: null,
  plan_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-only-plan.v0.1.json",
  plan_sha256: planSha256,
  delta_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-delta.v0.1.jsonl",
  delta_sha256: deltaSha256,
  verification_report_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-verification-report.v0.1.json",
  verification_report_sha256: verificationReportSha256,
  anchor_count: anchorV02.length,
  candidate_pool_count: poolRecords.length,
  split_operation_count: splitOpCount,
  author_operation_count: authorOpCount,
  unique_changed_assignment_count: movementSummary.unique_changed_assignment_count,
  overlapping_assignment_count: movementSummary.overlap_count,
  before_split_counts: originalSplitCounts,
  after_split_counts: afterSplitCounts,
  before_author_counts: authorCounts,
  after_author_counts: afterAuthorCounts,
  before_split_leakage: beforeSplitImpact.violations.length,
  after_split_leakage: afterSplitImpact.violations.length,
  before_author_leakage: beforeAuthorImpact.violations.length,
  after_author_leakage: afterAuthorImpact.violations.length,
  quarantine_intrusion_count: afterQuarantineImpact.violations.length,
  anchor_membership_changed: false,
  relation_decisions_authorized: false,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  checklist: [],
  status: "TEMPLATE_NOT_A_REAL_DECISION",
};
writeJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-decision-template.v0.1.json"), decisionTemplate);

// == 6. Gate status ==========================================================
writeJson(resolve(OWNER_REVIEW_DIR, "gate-status-owner-review.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.14",
  status: "OWNER_REVIEW_PACKET_READY_PENDING_DECISION",
  official_split_eligible: false,
  gold_authoring_authorized: false,
  anchor_membership_changed: false,
  actual_files_modified: false,
  owner_approval_required: true,
  next_step: "Owner opens component-safe-reallocation-owner-review.html, reviews the movement summary, and decides APPROVE_COMPONENT_SAFE_REALLOCATION / FIX_REQUIRED / REJECT_PLAN.",
});

// == 7. Owner review UI ======================================================
const uiDir = resolve(OWNER_REVIEW_DIR, "ui/v0.1");
mkdirSync(uiDir, { recursive: true });
const EXPORT_FILENAME = "component-safe-reallocation-owner-decision.v0.1.json";
const UI_DATA = {
  operation_counts: { split: splitOpCount, author: authorOpCount },
  unique_changed_assignment_count: movementSummary.unique_changed_assignment_count,
  overlap_count: movementSummary.overlap_count,
  split_reason_counts: movementSummary.split_reason_counts,
  author_reason_counts: movementSummary.author_reason_counts,
  split_transition_counts: movementSummary.split_transition_counts,
  author_transition_counts: movementSummary.author_transition_counts,
  component_movement_summary: movementSummary.component_movement_summary,
  before_split_counts: originalSplitCounts,
  after_split_counts: afterSplitCounts,
  before_author_counts: authorCounts,
  after_author_counts: afterAuthorCounts,
  before_split_leakage: beforeSplitImpact.violations.length,
  after_split_leakage: afterSplitImpact.violations.length,
  before_author_leakage: beforeAuthorImpact.violations.length,
  after_author_leakage: afterAuthorImpact.violations.length,
  quarantine_intrusion_count: afterQuarantineImpact.violations.length,
  anchor_count: anchorV02.length,
  candidate_pool_count: poolRecords.length,
  plan_path: decisionTemplate.plan_path, plan_sha256: planSha256,
  delta_path: decisionTemplate.delta_path, delta_sha256: deltaSha256,
  verification_report_path: decisionTemplate.verification_report_path, verification_report_sha256: verificationReportSha256,
  export_filename: EXPORT_FILENAME,
  checklist_items: [
    { id: "anchor_150_unchanged", label: "Anchor 150 멤버십이 바뀌지 않았음을 확인했다" },
    { id: "split_counts_242_81_177", label: `split 수 DEV_TUNE ${originalSplitCounts.DEV_TUNE}/DEV_CHECK ${originalSplitCounts.DEV_CHECK}/HOLDOUT ${originalSplitCounts.HOLDOUT}이 변경 후에도 그대로 유지됨을 확인했다` },
    { id: "author_75_75", label: "AUTHOR_A/AUTHOR_B 75/75가 유지됨을 확인했다" },
    { id: "critical_slice_preserved", label: "critical slice floor가 유지됨을 확인했다" },
    { id: "leakage_zero", label: `split/author leakage가 모두 0이 됨을 확인했다 (${beforeSplitImpact.violations.length}/${beforeAuthorImpact.violations.length} -> 0/0)` },
    { id: "quarantine_zero", label: "quarantine 침범이 없음을 확인했다" },
    { id: "changes_and_reasons_reviewed", label: "변경 대상(62 split + 8 author, 고유 70건)과 component별 사유를 확인했다" },
    { id: "not_281_approval", label: "이 승인이 나머지 281건 관계를 의미상 승인하는 결정이 아님을 이해했다" },
    { id: "official_split_separate_gate", label: "official split은 이 계획을 실제 적용·재검증한 뒤 별도로 승인해야 함을 이해했다" },
    { id: "gold_not_authorized", label: "Gold 작성은 아직 허가되지 않았음을 이해했다" },
  ],
};
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.14 Component-Safe Strategy A Owner Review (v0.1)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:24px;}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;word-break:break-all;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
.infobox{background:#e6f4ea;border:1px solid #b6dfc0;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
fieldset{border:1px solid #ccc;border-radius:6px;margin:14px 0;padding:10px 14px;}
label.radio{display:block;margin:6px 0;font-size:14px;}
.checklist label{display:block;margin:6px 0;font-size:14px;}
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
<h1>Turn N4.14 -- Component-Safe Strategy A Owner Review</h1>

<div class="infobox">
<b>Strategy A의 의미:</b> Anchor 150개 질문 자체는 <b>교체되지 않는다</b>. 질문·정답·문서 내용은 <b>전혀 변경되지 않는다</b>. 오직 기존 Pool 500/Anchor 150 레코드의 <code>planned_split</code>과 <code>author_allocation</code> 라벨만 component 단위로 재배치된다.
</div>

<h2>변경 규모</h2>
<table><tr><th>구분</th><th>값</th></tr>
<tr><td>split 변경 operation</td><td>${UI_DATA.operation_counts.split}</td></tr>
<tr><td>author 변경 operation</td><td>${UI_DATA.operation_counts.author}</td></tr>
<tr><td>고유 변경 assignment 수</td><td>${UI_DATA.unique_changed_assignment_count}</td></tr>
<tr><td>split/author 교집합(중복) 수</td><td>${UI_DATA.overlap_count}</td></tr>
</table>

<h2>Forced vs Compensating</h2>
<table><tr><th></th><th>COMPONENT_CONSOLIDATION (forced)</th><th>COMPENSATING_RESTORATION</th></tr>
<tr><td>split</td><td>${UI_DATA.split_reason_counts.COMPONENT_CONSOLIDATION ?? 0}</td><td>${UI_DATA.split_reason_counts.COMPENSATING_RESTORATION ?? 0}</td></tr>
<tr><td>author</td><td>${UI_DATA.author_reason_counts.COMPONENT_CONSOLIDATION ?? 0}</td><td>${UI_DATA.author_reason_counts.COMPENSATING_RESTORATION ?? 0}</td></tr>
</table>

<h2>Split 전환 조합</h2>
<table><tr><th>전환</th><th>건수</th></tr>
${Object.entries(UI_DATA.split_transition_counts).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("\n")}
</table>

<h2>Author 전환 조합</h2>
<table><tr><th>전환</th><th>건수</th></tr>
${Object.entries(UI_DATA.author_transition_counts).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("\n")}
</table>

<h2>Component별 이동 요약 (상위 20개)</h2>
<table><tr><th>maximal_component_id</th><th>split</th><th>author</th><th>합계</th></tr>
${UI_DATA.component_movement_summary.slice(0, 20).map((c) => `<tr><td>${esc(c.component_id)}</td><td>${c.split_count}</td><td>${c.author_count}</td><td>${c.total_count}</td></tr>`).join("\n")}
</table>
<p>전체 component 수: ${UI_DATA.component_movement_summary.length}</p>

<h2>변경 전후 비교</h2>
<table><tr><th>지표</th><th>변경 전</th><th>변경 후</th></tr>
<tr><td>split 카운트</td><td>${JSON.stringify(UI_DATA.before_split_counts)}</td><td>${JSON.stringify(UI_DATA.after_split_counts)}</td></tr>
<tr><td>author 카운트</td><td>${JSON.stringify(UI_DATA.before_author_counts)}</td><td>${JSON.stringify(UI_DATA.after_author_counts)}</td></tr>
<tr><td>split leakage</td><td>${UI_DATA.before_split_leakage}</td><td>${UI_DATA.after_split_leakage}</td></tr>
<tr><td>author leakage</td><td>${UI_DATA.before_author_leakage}</td><td>${UI_DATA.after_author_leakage}</td></tr>
<tr><td>quarantine 침범</td><td>0</td><td>${UI_DATA.quarantine_intrusion_count}</td></tr>
</table>

<div class="warnbox">이 승인은 <b>나머지 281건 관계를 승인/거부하는 결정이 아니며</b>, <b>Gold 작성 승인도 아니다</b>. official split은 이 계획을 실제 적용·재검증한 뒤 별도로 승인해야 한다. 아래 버튼을 눌러도 <b>official_split_eligible과 gold_authoring_authorized는 항상 false</b>로 내보내진다.</div>

<h2>Owner 선택</h2>
<fieldset>
<label class="radio"><input type="radio" name="ownerChoice" value="APPROVE_COMPONENT_SAFE_REALLOCATION"/> APPROVE_COMPONENT_SAFE_REALLOCATION</label>
<label class="radio"><input type="radio" name="ownerChoice" value="FIX_REQUIRED"/> FIX_REQUIRED</label>
<label class="radio"><input type="radio" name="ownerChoice" value="REJECT_PLAN"/> REJECT_PLAN</label>
</fieldset>
<div id="approveChecklist" class="checklist" hidden></div>
<label>Owner 이름/ID (필수)</label>
<input type="text" id="ownerName"/>
<label>owner_note (FIX_REQUIRED/REJECT_PLAN 시 필수)</label>
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
    if (choice === "APPROVE_COMPONENT_SAFE_REALLOCATION") return allChecklistChecked();
    if (choice === "FIX_REQUIRED" || choice === "REJECT_PLAN") return !!ownerNoteEl.value.trim();
    return false;
  }
  function updateButtons() {
    checklistEl.hidden = currentChoice() !== "APPROVE_COMPONENT_SAFE_REALLOCATION";
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
      plan_path: DATA.plan_path, plan_sha256: DATA.plan_sha256,
      delta_path: DATA.delta_path, delta_sha256: DATA.delta_sha256,
      verification_report_path: DATA.verification_report_path, verification_report_sha256: DATA.verification_report_sha256,
      anchor_count: DATA.anchor_count,
      candidate_pool_count: DATA.candidate_pool_count,
      split_operation_count: DATA.operation_counts.split,
      author_operation_count: DATA.operation_counts.author,
      unique_changed_assignment_count: DATA.unique_changed_assignment_count,
      overlapping_assignment_count: DATA.overlap_count,
      before_split_counts: DATA.before_split_counts,
      after_split_counts: DATA.after_split_counts,
      before_author_counts: DATA.before_author_counts,
      after_author_counts: DATA.after_author_counts,
      before_split_leakage: DATA.before_split_leakage,
      after_split_leakage: DATA.after_split_leakage,
      before_author_leakage: DATA.before_author_leakage,
      after_author_leakage: DATA.after_author_leakage,
      quarantine_intrusion_count: DATA.quarantine_intrusion_count,
      anchor_membership_changed: false,
      relation_decisions_authorized: false,
      official_split_eligible: false,
      gold_authoring_authorized: false,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: !!checklistState[item.id] }; }),
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
const htmlPath = resolve(uiDir, "component-safe-reallocation-owner-review.html");
writeFileSync(htmlPath, html, "utf8");
const htmlSha256 = sha256File(htmlPath);
writeJson(resolve(uiDir, "component-safe-reallocation-owner-review-build-report.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  html_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/owner-review-v0.1/ui/v0.1/component-safe-reallocation-owner-review.html",
  html_sha256: htmlSha256,
  export_filename: EXPORT_FILENAME,
  checklist_item_count: UI_DATA.checklist_items.length,
  auto_approved: false,
  official_split_eligible_settable_by_this_ui: false,
  gold_authoring_authorized_settable_by_this_ui: false,
  anchor_membership_changed_settable_by_this_ui: false,
});

console.log(JSON.stringify({
  status: "OWNER_REVIEW_PACKET_AND_UI_BUILT",
  split_operation_count: splitOpCount,
  author_operation_count: authorOpCount,
  unique_changed_assignment_count: movementSummary.unique_changed_assignment_count,
  overlap_count: movementSummary.overlap_count,
  before_after: { split_leakage: [beforeSplitImpact.violations.length, afterSplitImpact.violations.length], author_leakage: [beforeAuthorImpact.violations.length, afterAuthorImpact.violations.length] },
  html_sha256: htmlSha256,
  official_split_eligible: false,
  gold_authoring_authorized: false,
}, null, 2));
