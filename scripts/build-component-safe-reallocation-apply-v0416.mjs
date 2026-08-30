#!/usr/bin/env node
// Turn N4.16: applies Turn N4.13's Strategy A delta (Owner-approved per
// Turn N4.15's verified decision) onto a BRAND-NEW v0.3 candidate
// assignment, and independently re-verifies every invariant against that
// v0.3 state. This script NEVER overwrites the real v0.2/v0.1 files:
//   - anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl,
//     candidate-pool.v0.1.jsonl are read-only inputs, proven
//     byte-unmodified below
//   - all v0.3 output is written to a NEW, dedicated directory
//     (component-safe-reallocation-v0.1/applied-v0.3/)
// This script also NEVER sets official_split_eligible or
// gold_authoring_authorized true, and never writes to the official 326-row
// ledger or any Relation/Fact/Evidence/Gold store. Producing v0.3 is a
// CANDIDATE assignment awaiting a SEPARATE official-split approval gate
// (Turn N4.17) -- it is not itself an official split.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPoolSplitDelta, applyAuthorDelta, diffRecordsByAssignmentId, verifyDeltaApplicationScope } from "../domain/evaluation/component-safe-reallocation-apply.mjs";
import { buildProspectiveGraph } from "../domain/evaluation/relation-closure-prospective-consensus-graph.mjs";
import { computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact, computeMaximalGraphQuarantineImpact, buildDocumentToBaseComponentMap } from "../domain/evaluation/relation-closure-maximal-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const SPLIT_ORDER = ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"];

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const OWNER_REVIEW_DIR = resolve(CSR_DIR, "owner-review-v0.1");
const APPLIED_V03_DIR = resolve(CSR_DIR, "applied-v0.3");

const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const POOL_MANIFEST_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.manifest.json");
const DELTA_PATH = resolve(CSR_DIR, "strategy-a-assignment-delta.v0.1.jsonl");
const PLAN_PATH = resolve(CSR_DIR, "strategy-a-assignment-only-plan.v0.1.json");
const QUARANTINE_MANIFEST_PATH = resolve(V02_DIR, "quarantine/quarantine-manifest.v0.2.json");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const RATIFIED_CONSENSUS_PATH = resolve(V02_DIR, "decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratified-consensus.v0.1.jsonl");
const ANCHOR_V01_MANIFEST_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/anchor-selection.v0.1.manifest.json");
const N415_OWNER_DECISION_PATH = resolve(OWNER_REVIEW_DIR, "results/owner-v0.1/component-safe-reallocation-owner-decision.v0.1.json");
const N415_VERIFICATION_REPORT_PATH = resolve(OWNER_REVIEW_DIR, "results/owner-v0.1/component-safe-reallocation-owner-decision-verification-report.v0.1.json");

mkdirSync(APPLIED_V03_DIR, { recursive: true });

// == 0. Read-only-input byte-unmodified guard (before AND after) ============
const anchorBefore = sha256File(ANCHOR_V02_PATH);
const authorBefore = sha256File(AUTHOR_V02_PATH);
const poolBefore = sha256File(POOL_PATH);

// == 1. Authorization gate: this script requires Turn N4.15's VERIFIED,
// APPROVED Owner decision to already exist. It never re-derives approval
// on its own. ===============================================================
const n415Decision = readJson(N415_OWNER_DECISION_PATH);
if (n415Decision.owner_disposition !== "APPROVE_COMPONENT_SAFE_REALLOCATION") {
  console.error(`BLOCKER: Turn N4.15 Owner decision is not APPROVE_COMPONENT_SAFE_REALLOCATION (actual ${n415Decision.owner_disposition}) -- Strategy A must not be applied without an approved decision`);
  process.exit(1);
}
const n415Report = readJson(N415_VERIFICATION_REPORT_PATH);
if (n415Report.status !== "OWNER_DECISION_VERIFIED_STRATEGY_A_NOT_APPLIED") {
  console.error(`BLOCKER: Turn N4.15 verification report status is not OWNER_DECISION_VERIFIED_STRATEGY_A_NOT_APPLIED (actual ${n415Report.status})`);
  process.exit(1);
}
if (!n415Report.cross_reference_checks.all_passed) {
  console.error("BLOCKER: Turn N4.15 verification report cross_reference_checks.all_passed is not true");
  process.exit(1);
}

// == 2. Pre-verification of real read-only inputs ============================
const anchorV02 = readJsonl(ANCHOR_V02_PATH);
if (anchorV02.length !== 150) { console.error(`BLOCKER: Anchor v0.2 count ${anchorV02.length} !== 150`); process.exit(1); }
const authorV02 = readJsonl(AUTHOR_V02_PATH);
if (authorV02.length !== 150) { console.error(`BLOCKER: Author v0.2 count ${authorV02.length} !== 150`); process.exit(1); }
const poolRecords = readJsonl(POOL_PATH);
if (poolRecords.length !== 500) { console.error(`BLOCKER: Candidate Pool count ${poolRecords.length} !== 500`); process.exit(1); }
const poolManifest = readJson(POOL_MANIFEST_PATH);
if (poolManifest.candidate_pool_record_count !== 500) { console.error("BLOCKER: Candidate Pool manifest record_count is not 500"); process.exit(1); }

const plan = readJson(PLAN_PATH);
if (plan.verdict !== "FEASIBLE_EXACT") { console.error(`BLOCKER: Strategy A verdict is not FEASIBLE_EXACT (actual ${plan.verdict})`); process.exit(1); }
if (plan.status !== "CANDIDATE_NOT_APPLIED") { console.error("BLOCKER: Strategy A plan status is not CANDIDATE_NOT_APPLIED (has it already been applied elsewhere?)"); process.exit(1); }

const deltaRows = readJsonl(DELTA_PATH);
const splitDeltaIds = deltaRows.filter((r) => r.dimension === "split").map((r) => r.assignment_id).sort();
const authorDeltaIds = deltaRows.filter((r) => r.dimension === "author").map((r) => r.assignment_id).sort();
if (splitDeltaIds.length !== 62) { console.error(`BLOCKER: split delta count ${splitDeltaIds.length} !== 62`); process.exit(1); }
if (authorDeltaIds.length !== 8) { console.error(`BLOCKER: author delta count ${authorDeltaIds.length} !== 8`); process.exit(1); }

const quarantineManifest = readJson(QUARANTINE_MANIFEST_PATH);
if (quarantineManifest.quarantine_document_count !== 50) { console.error("BLOCKER: quarantine document count is not 50"); process.exit(1); }
const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const ledgerRows = readJsonl(LEDGER_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }
const provisionalCountBefore = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
if (provisionalCountBefore !== 294) { console.error(`BLOCKER: provisional relation count ${provisionalCountBefore} !== 294`); process.exit(1); }
const ratifiedConsensus = readJsonl(RATIFIED_CONSENSUS_PATH);
if (ratifiedConsensus.length !== 13) { console.error(`BLOCKER: ratified consensus row count ${ratifiedConsensus.length} !== 13`); process.exit(1); }

// == 3. Apply the delta onto BRAND-NEW v0.3 in-memory records ===============
const poolV03 = applyPoolSplitDelta({ poolRecords, deltaRows });
const anchorV03 = anchorV02.map((r) => ({ ...r })); // Strategy A never touches Anchor membership or content -- copied unchanged, new version stamp only
const authorV03 = applyAuthorDelta({ authorRows: authorV02, deltaRows });

// == 4. Diff-verification -- prove ONLY the claimed ids/fields changed ======
const poolDiff = diffRecordsByAssignmentId({ before: poolRecords, after: poolV03 });
const poolScope = verifyDeltaApplicationScope({ diff: poolDiff, expectedChangedIds: splitDeltaIds, allowedFields: ["planned_split"] });
const anchorDiff = diffRecordsByAssignmentId({ before: anchorV02, after: anchorV03 });
const anchorScope = verifyDeltaApplicationScope({ diff: anchorDiff, expectedChangedIds: [], allowedFields: [] });
const authorDiff = diffRecordsByAssignmentId({ before: authorV02, after: authorV03 });
const authorScope = verifyDeltaApplicationScope({ diff: authorDiff, expectedChangedIds: authorDeltaIds, allowedFields: ["author_allocation"] });
if (!poolScope.ok || !anchorScope.ok || !authorScope.ok) {
  console.error(`BLOCKER: delta application touched unexpected ids/fields: ${JSON.stringify({ pool: poolScope.violations, anchor: anchorScope.violations, author: authorScope.violations }, null, 2)}`);
  process.exit(1);
}

// == 5. Independent re-verification of ALL invariants against v0.3 ==========
const consensusByRelationCandidateId = new Map(ratifiedConsensus.map((r) => [r.relation_candidate_id, { consensus_disposition: r.consensus_disposition, consensus_target_document_id: r.consensus_target_document_id }]));
const prospectiveGraph = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId });
if (prospectiveGraph.totalCandidateEdgeCount !== 1428) { console.error(`BLOCKER: recomputed prospective edge count ${prospectiveGraph.totalCandidateEdgeCount} !== 1428`); process.exit(1); }

const splitImpactV03 = computeMaximalGraphSplitImpact({ poolRecords: poolV03, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const authorImpactV03 = computeMaximalGraphAuthorImpact({ authorRows: authorV03, resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId });
const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: packet326 });
const quarantineImpactV03 = computeMaximalGraphQuarantineImpact({
  quarantineDocumentIds: quarantineManifest.quarantine_document_ids,
  docToBaseComponentId,
  authorRows: anchorV03.map((r) => ({ assignment_id: r.assignment_id, chain_component_id: r.chain_component_id, anchor_document_ids: r.anchor_document_ids })),
  resolveMaximalComponentId: prospectiveGraph.resolveMaximalComponentId,
});

const splitCountsV03 = {};
for (const s of SPLIT_ORDER) splitCountsV03[s] = poolV03.filter((r) => r.planned_split === s).length;
const authorCountsV03 = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV03) authorCountsV03[r.author_allocation] += 1;

const anchorV01Manifest = readJson(ANCHOR_V01_MANIFEST_PATH);
const criticalTagFloors = anchorV01Manifest.critical_tag_floors;
function tagCounts(rows) {
  const counts = {};
  for (const r of rows) for (const t of r.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}
const tagCountsV02 = tagCounts(anchorV02);
const tagCountsV03 = tagCounts(anchorV03);
const criticalFloorsPreservedV03 = Object.entries(criticalTagFloors).every(([tag, floor]) => (tagCountsV03[tag] ?? 0) >= floor && (tagCountsV03[tag] ?? 0) === (tagCountsV02[tag] ?? 0));

const anchorMembershipV02 = new Set(anchorV02.map((r) => r.assignment_id));
const anchorMembershipV03 = new Set(anchorV03.map((r) => r.assignment_id));
const anchorMembershipUnchanged = anchorMembershipV02.size === anchorMembershipV03.size && [...anchorMembershipV02].every((id) => anchorMembershipV03.has(id));

const invariantChecks = {
  split_leakage_zero: splitImpactV03.violations.length === 0,
  author_leakage_zero: authorImpactV03.violations.length === 0,
  quarantine_intrusion_zero: quarantineImpactV03.violations.length === 0,
  split_counts_preserved: SPLIT_ORDER.every((s) => splitCountsV03[s] === plan.split_plan.original_split_counts[s]),
  author_counts_balanced_75_75: authorCountsV03.AUTHOR_A === 75 && authorCountsV03.AUTHOR_B === 75,
  critical_slice_floors_preserved: criticalFloorsPreservedV03,
  anchor_membership_unchanged: anchorMembershipUnchanged,
  anchor_count_150: anchorV03.length === 150,
  candidate_pool_count_500: poolV03.length === 500,
  author_count_150: authorV03.length === 150,
  delta_application_scope_pool_ok: poolScope.ok,
  delta_application_scope_anchor_ok: anchorScope.ok,
  delta_application_scope_author_ok: authorScope.ok,
  ledger_326_rows_untouched: ledgerRows.length === 326,
  provisional_294_untouched: provisionalCountBefore === 294,
};
const allInvariantsPassed = Object.values(invariantChecks).every(Boolean);
if (!allInvariantsPassed) {
  console.error(`BLOCKER: v0.3 application failed invariant re-verification: ${JSON.stringify(invariantChecks, null, 2)}`);
  process.exit(1);
}

// == 6. Write v0.3 output (NEW files only, never overwriting v0.2/v0.1) =====
const poolV03Path = resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl");
const anchorV03Path = resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl");
const authorV03Path = resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl");
writeJsonl(poolV03Path, poolV03);
writeJsonl(anchorV03Path, anchorV03);
writeJsonl(authorV03Path, authorV03);

const poolV03Sha256 = sha256File(poolV03Path);
const anchorV03Sha256 = sha256File(anchorV03Path);
const authorV03Sha256 = sha256File(authorV03Path);

writeJson(resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.16",
  status: "V0.3_CANDIDATE_BUILT_NOT_OFFICIAL",
  source_authorization: {
    n415_owner_decision_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/owner-review-v0.1/results/owner-v0.1/component-safe-reallocation-owner-decision.v0.1.json",
    n415_decision_id: n415Decision.decision_id,
    n415_owner: n415Decision.owner,
    n415_owner_disposition: n415Decision.owner_disposition,
  },
  delta_applied: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-delta.v0.1.jsonl", sha256: sha256File(DELTA_PATH), split_moves: splitDeltaIds.length, author_moves: authorDeltaIds.length },
  outputs: {
    candidate_pool_v0_3: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl", sha256: poolV03Sha256, row_count: poolV03.length },
    anchor_selection_v0_3: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl", sha256: anchorV03Sha256, row_count: anchorV03.length, content_note: "byte-identical to anchor-selection.v0.2.jsonl in every field -- Strategy A never touches Anchor content, this is a version-stamped copy only" },
    author_allocation_v0_3: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/author-allocation.v0.3.jsonl", sha256: authorV03Sha256, row_count: authorV03.length },
  },
  diff_verification: {
    pool: { changed_id_count: poolDiff.changed_id_count, expected_changed_id_count: splitDeltaIds.length, scope_ok: poolScope.ok },
    anchor: { changed_id_count: anchorDiff.changed_id_count, expected_changed_id_count: 0, scope_ok: anchorScope.ok },
    author: { changed_id_count: authorDiff.changed_id_count, expected_changed_id_count: authorDeltaIds.length, scope_ok: authorScope.ok },
  },
  invariant_checks: invariantChecks,
  all_invariants_passed: allInvariantsPassed,
  live_recomputed_values: {
    split_counts: splitCountsV03,
    author_counts: authorCountsV03,
    split_leakage_after: splitImpactV03.violations.length,
    author_leakage_after: authorImpactV03.violations.length,
    quarantine_intrusion_after: quarantineImpactV03.violations.length,
  },
  real_v02_files_unmodified: {
    anchor_selection_v02_unchanged: sha256File(ANCHOR_V02_PATH) === anchorBefore,
    author_allocation_v02_unchanged: sha256File(AUTHOR_V02_PATH) === authorBefore,
    candidate_pool_v01_unchanged: sha256File(POOL_PATH) === poolBefore,
  },
  official_split_eligible: false,
  gold_authoring_authorized: false,
  relation_decisions_authorized: false,
  actual_official_promotion_applied: false,
  remaining_281_provisional_rows_untouched: true,
  note: "This Turn produces a CANDIDATE v0.3 assignment in a brand-new directory. It does NOT overwrite anchor-selection.v0.2.jsonl, author-allocation.v0.2.jsonl, or candidate-pool.v0.1.jsonl (all three proven byte-unmodified above). It does NOT make v0.3 the official split, does NOT authorize Gold authoring, and does NOT touch Runtime/PostgreSQL/v0.20 or any of the remaining 281 provisional relations. Designating v0.3 as the official split is a SEPARATE Owner approval gate (Turn N4.17).",
});

const anchorAfter = sha256File(ANCHOR_V02_PATH);
const authorAfter = sha256File(AUTHOR_V02_PATH);
const poolAfter = sha256File(POOL_PATH);
if (anchorAfter !== anchorBefore || authorAfter !== authorBefore || poolAfter !== poolBefore) {
  console.error("BLOCKER: a real v0.2/v0.1 file changed during this script's own execution");
  process.exit(1);
}

console.log(JSON.stringify({
  status: "V0.3_CANDIDATE_BUILT_NOT_OFFICIAL",
  all_invariants_passed: allInvariantsPassed,
  split_leakage_after: splitImpactV03.violations.length,
  author_leakage_after: authorImpactV03.violations.length,
  quarantine_intrusion_after: quarantineImpactV03.violations.length,
  split_counts: splitCountsV03,
  author_counts: authorCountsV03,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  output_dir: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/",
}, null, 2));
