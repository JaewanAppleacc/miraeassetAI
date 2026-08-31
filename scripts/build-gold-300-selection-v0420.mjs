#!/usr/bin/env node
// Turn N4.20 (corrected): selects the additional 150 "Expansion" Gold-300
// candidates from the Candidate Pool's non-Anchor DEV_CHECK/HOLDOUT rows,
// combines them with the already-approved, untouched Anchor 150, and
// produces a candidate (not yet Owner-approved) Gold-300 selection +
// author-allocation + eligibility report + gate status.
//
// This script NEVER:
//   - overwrites candidate-pool.v0.3.jsonl / anchor-selection.v0.3.jsonl /
//     author-allocation.v0.3.jsonl (all three read-only, hash-verified)
//   - changes the existing Anchor 150's membership or its existing
//     AUTHOR_A/AUTHOR_B 75/75 allocation (copied through verbatim)
//   - writes a Gold question, expected answer, or evidence locator
//   - marks any provisional relation as confirmed/rejected, or silently
//     drops/replaces a parse-blocked or provisional-relation-blocked item
//   - sets gold_authoring_authorized/holdout_access/phase2/production/
//     relation-decision flags to true (all hard-coded false; this is a
//     CANDIDATE selection pending Owner approval)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateAuthors, computeAuthorLeakageReport } from "../domain/evaluation/anchor-allocation-builder.mjs";
import {
  selectExpansionPool,
  buildParseCoverageIndex,
  buildRelationComponentStatusIndex,
  classifyEligibility,
  summarizeEligibility,
} from "../domain/evaluation/gold-300-selection.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const APPLIED_V03_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1/applied-v0.3");
const POOL_PATH = resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl");
const ANCHOR_PATH = resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl");
const AUTHOR_V03_PATH = resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const PARSE_AUDIT_PATH = resolve(REPO_ROOT, "work/a-document-ir/parse-audit.full.jsonl");

export const OUT_DIR = resolve(V02_DIR, "gold-300-v0.1");

const TARGET = Object.freeze({ DEV_TUNE: 150, DEV_CHECK: 50, HOLDOUT: 100, TOTAL: 300 });

export function buildGold300Selection({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const poolBefore = sha256File(POOL_PATH);
  const anchorBefore = sha256File(ANCHOR_PATH);
  const authorV03Before = sha256File(AUTHOR_V03_PATH);

  const pool = readJsonl(POOL_PATH);
  const anchor = readJsonl(ANCHOR_PATH);
  const authorV03 = readJsonl(AUTHOR_V03_PATH);
  const ledgerRows = readJsonl(LEDGER_PATH);
  const parseAuditRows = readJsonl(PARSE_AUDIT_PATH);

  if (pool.length !== 500) throw new Error(`buildGold300Selection: candidate pool must have 500 rows, got ${pool.length}`);
  if (anchor.length !== 150) throw new Error(`buildGold300Selection: Anchor must have 150 rows, got ${anchor.length}`);
  if (authorV03.length !== 150) throw new Error(`buildGold300Selection: author-allocation.v0.3 must have 150 rows, got ${authorV03.length}`);
  if (!anchor.every((r) => r.planned_split === "DEV_TUNE")) throw new Error("buildGold300Selection: every Anchor row must be planned_split=DEV_TUNE");

  const anchorIds = new Set(anchor.map((r) => r.assignment_id));
  const authorV03ById = new Map(authorV03.map((r) => [r.assignment_id, r.author_allocation]));
  for (const id of anchorIds) {
    if (!authorV03ById.has(id)) throw new Error(`buildGold300Selection: Anchor assignment ${id} has no existing author allocation in author-allocation.v0.3.jsonl`);
  }
  const existingCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const author of authorV03ById.values()) existingCounts[author] += 1;
  if (existingCounts.AUTHOR_A !== 75 || existingCounts.AUTHOR_B !== 75) {
    throw new Error(`buildGold300Selection: existing Anchor author split must be 75/75, got ${JSON.stringify(existingCounts)}`);
  }

  // ---- Select 50 DEV_CHECK + 100 HOLDOUT expansion candidates, group-atomic ----
  const devCheckSelection = selectExpansionPool({
    poolRecords: pool, excludeAssignmentIds: anchorIds, plannedSplit: "DEV_CHECK",
    targetIdeal: TARGET.DEV_CHECK, targetMin: TARGET.DEV_CHECK, targetMax: TARGET.DEV_CHECK,
    salt: "n4.20-gold300-devcheck-expansion",
  });
  const holdoutSelection = selectExpansionPool({
    poolRecords: pool, excludeAssignmentIds: anchorIds, plannedSplit: "HOLDOUT",
    targetIdeal: TARGET.HOLDOUT, targetMin: TARGET.HOLDOUT, targetMax: TARGET.HOLDOUT,
    salt: "n4.20-gold300-holdout-expansion",
  });
  if (!devCheckSelection.exactTargetReachable || devCheckSelection.actualCount !== TARGET.DEV_CHECK) {
    throw new Error(`buildGold300Selection: DEV_CHECK expansion selection did not reach exactly ${TARGET.DEV_CHECK} (got ${devCheckSelection.actualCount}, exactTargetReachable=${devCheckSelection.exactTargetReachable})`);
  }
  if (!holdoutSelection.exactTargetReachable || holdoutSelection.actualCount !== TARGET.HOLDOUT) {
    throw new Error(`buildGold300Selection: HOLDOUT expansion selection did not reach exactly ${TARGET.HOLDOUT} (got ${holdoutSelection.actualCount}, exactTargetReachable=${holdoutSelection.exactTargetReachable})`);
  }

  const expansionSelected = [...devCheckSelection.selected, ...holdoutSelection.selected];
  if (expansionSelected.length !== 150) throw new Error(`buildGold300Selection: expansion total must be 150, got ${expansionSelected.length}`);

  // ---- Author-balance the 150 Expansion candidates only (existing Anchor
  // A/B 75/75 is untouched, copied through verbatim below) ---------------
  const expansionAllocation = allocateAuthors({ selected: expansionSelected, salt: "n4.20-gold300-expansion-author-balance" });
  if (expansionAllocation.used.AUTHOR_A !== 75 || expansionAllocation.used.AUTHOR_B !== 75) {
    throw new Error(`buildGold300Selection: expansion author balance must be 75/75, got ${JSON.stringify(expansionAllocation.used)}`);
  }
  const expansionLeakage = computeAuthorLeakageReport({ allocated: expansionAllocation.allocated });
  if (!expansionLeakage.ok) throw new Error(`buildGold300Selection: expansion author leakage detected: ${JSON.stringify(expansionLeakage.violations)}`);

  // ---- Combined Gold-300 selection candidate (existing Anchor untouched
  // content + newly selected Expansion, each tagged with its pool role) --
  const selectionCandidate = [
    ...anchor.map((r) => ({ ...r, gold_pool_role: "EXISTING_ANCHOR", gold_300_status: "CANDIDATE" })),
    ...expansionSelected.map((r) => ({ ...r, gold_pool_role: "EXPANSION", gold_300_status: "CANDIDATE" })),
  ];
  if (selectionCandidate.length !== TARGET.TOTAL) throw new Error(`buildGold300Selection: combined selection must total ${TARGET.TOTAL}, got ${selectionCandidate.length}`);

  const splitCounts = { DEV_TUNE: 0, DEV_CHECK: 0, HOLDOUT: 0 };
  for (const r of selectionCandidate) splitCounts[r.planned_split] += 1;
  if (splitCounts.DEV_TUNE !== TARGET.DEV_TUNE || splitCounts.DEV_CHECK !== TARGET.DEV_CHECK || splitCounts.HOLDOUT !== TARGET.HOLDOUT) {
    throw new Error(`buildGold300Selection: final split distribution must be ${JSON.stringify(TARGET)}, got ${JSON.stringify(splitCounts)}`);
  }

  // ---- Combined author-allocation candidate: existing Anchor allocation
  // copied verbatim (never recomputed) + newly computed Expansion --------
  const authorAllocationCandidate = [
    ...anchor.map((r) => ({ assignment_id: r.assignment_id, evaluation_group_id: r.evaluation_group_id, chain_component_id: r.chain_component_id, planned_split: r.planned_split, gold_pool_role: "EXISTING_ANCHOR", author_allocation: authorV03ById.get(r.assignment_id) })),
    ...expansionAllocation.allocated.map((r) => ({ assignment_id: r.assignment_id, evaluation_group_id: r.evaluation_group_id, chain_component_id: r.chain_component_id, planned_split: r.planned_split, gold_pool_role: "EXPANSION", author_allocation: r.author_allocation })),
  ];
  const finalAuthorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of authorAllocationCandidate) finalAuthorCounts[r.author_allocation] += 1;
  if (finalAuthorCounts.AUTHOR_A !== 150 || finalAuthorCounts.AUTHOR_B !== 150) {
    throw new Error(`buildGold300Selection: final author totals must be 150/150, got ${JSON.stringify(finalAuthorCounts)}`);
  }
  // No evaluation_group_id may ever appear under more than one author, and
  // Anchor's already-approved allocation must never be split by this Turn.
  const groupToAuthor = new Map();
  for (const r of authorAllocationCandidate) {
    const prior = groupToAuthor.get(r.evaluation_group_id);
    if (prior !== undefined && prior !== r.author_allocation) {
      throw new Error(`buildGold300Selection: evaluation_group_id ${r.evaluation_group_id} is split across authors (${prior} vs ${r.author_allocation})`);
    }
    groupToAuthor.set(r.evaluation_group_id, r.author_allocation);
  }

  // ---- Eligibility classification over all 300, from live parse/ledger data ----
  const parseCoverageIndex = buildParseCoverageIndex(parseAuditRows);
  const relationComponentStatusIndex = buildRelationComponentStatusIndex(ledgerRows);
  const classified = selectionCandidate.map((record) => {
    const { status, blocked_reason } = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
    return { assignment_id: record.assignment_id, evaluation_group_id: record.evaluation_group_id, chain_component_id: record.chain_component_id, planned_split: record.planned_split, gold_pool_role: record.gold_pool_role, authoring_eligibility: status, blocked_reason };
  });
  const eligibilityDistribution = summarizeEligibility(classified);
  const blockedCount = classified.filter((c) => c.authoring_eligibility.startsWith("BLOCKED_")).length;
  const eligibleCount = classified.length - blockedCount;

  // ---- Write outputs -----------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  writeJsonl(resolve(OUT_DIR, "gold-300-selection-candidate.v0.1.jsonl"), selectionCandidate);
  writeJsonl(resolve(OUT_DIR, "gold-300-author-allocation-candidate.v0.1.jsonl"), authorAllocationCandidate);

  const selectionManifest = {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now, status: "CANDIDATE_NOT_OWNER_APPROVED",
    target_size_contract: { source: "domain/evaluation/TARGET_SIZE.v1.md", dev_tune: TARGET.DEV_TUNE, dev_check: TARGET.DEV_CHECK, holdout: TARGET.HOLDOUT, total: TARGET.TOTAL },
    inputs: {
      candidate_pool_v03: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl", sha256_before: poolBefore, sha256_after: sha256File(POOL_PATH), row_count: pool.length },
      anchor_selection_v03: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl", sha256_before: anchorBefore, sha256_after: sha256File(ANCHOR_PATH), row_count: anchor.length },
    },
    split_counts: splitCounts,
    dev_check_expansion: { targetIdeal: devCheckSelection.targetIdeal, actualCount: devCheckSelection.actualCount, exactTargetReachable: devCheckSelection.exactTargetReachable, groupsSelected: devCheckSelection.includedGroupIds.length },
    holdout_expansion: { targetIdeal: holdoutSelection.targetIdeal, actualCount: holdoutSelection.actualCount, exactTargetReachable: holdoutSelection.exactTargetReachable, groupsSelected: holdoutSelection.includedGroupIds.length },
    real_v03_files_unmodified: { candidate_pool_v03_unchanged: poolBefore === sha256File(POOL_PATH), anchor_selection_v03_unchanged: anchorBefore === sha256File(ANCHOR_PATH), author_allocation_v03_unchanged: authorV03Before === sha256File(AUTHOR_V03_PATH) },
  };
  writeJson(resolve(OUT_DIR, "gold-300-selection-manifest.v0.1.json"), selectionManifest);

  const authorManifest = {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now, status: "CANDIDATE_NOT_OWNER_APPROVED",
    total_gold_count: TARGET.TOTAL,
    author_a_count: finalAuthorCounts.AUTHOR_A, author_b_count: finalAuthorCounts.AUTHOR_B,
    existing_anchor_count: 150, expansion_count: 150,
    author_a_anchor_count: 75, author_a_expansion_count: expansionAllocation.used.AUTHOR_A,
    author_b_anchor_count: 75, author_b_expansion_count: expansionAllocation.used.AUTHOR_B,
    existing_anchor_allocation_copied_verbatim: true,
    author_leakage: expansionLeakage,
  };
  writeJson(resolve(OUT_DIR, "gold-300-author-allocation-manifest.v0.1.json"), authorManifest);

  const eligibilityReport = {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now,
    total: classified.length, eligible_count: eligibleCount, blocked_count: blockedCount,
    eligibility_distribution: eligibilityDistribution,
    scope_note: "Classification recomputed from live parse-audit coverage_state and the real 326-row relation-closure-candidate-ledger.v0.2.jsonl review_status -- no count is hardcoded. A BLOCKED item is preserved in the 300 selection, not dropped or replaced; a provisional relation candidate this Turn found is never treated as confirmed or rejected.",
    blocked_items: classified.filter((c) => c.authoring_eligibility.startsWith("BLOCKED_")),
    needs_manual_review_items: classified.filter((c) => c.authoring_eligibility === "NEEDS_MANUAL_SOURCE_REVIEW"),
  };
  writeJson(resolve(OUT_DIR, "gold-300-eligibility-report.v0.1.json"), eligibilityReport);

  const gateStatus = {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now,
    total_gold_count: TARGET.TOTAL, author_a_count: finalAuthorCounts.AUTHOR_A, author_b_count: finalAuthorCounts.AUTHOR_B,
    split_counts: splitCounts, eligible_count: eligibleCount, blocked_count: blockedCount,
    gold_authoring_authorized: false, authorized_scope: "NONE",
    holdout_evaluation_authorized: false, production_wiring_authorized: false,
    actual_official_promotion_applied: false, relation_decisions_authorized: false, agent_ranking_authorized: false,
    block_reason: "PENDING_OWNER_APPROVAL_OF_GOLD_300_AUTHORING_PLAN",
    real_v03_files_unmodified: selectionManifest.real_v03_files_unmodified,
  };
  writeJson(resolve(OUT_DIR, "gold-300-gate-status.v0.1.json"), gateStatus);

  return Object.freeze({
    outDir: OUT_DIR, selectionCandidate, authorAllocationCandidate, classified,
    splitCounts, finalAuthorCounts, eligibilityDistribution, eligibleCount, blockedCount,
    devCheckSelection, holdoutSelection, expansionAllocation,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300Selection();
  console.log(`Gold-300 selection candidate built at ${result.outDir}`);
  console.log(JSON.stringify({ splitCounts: result.splitCounts, finalAuthorCounts: result.finalAuthorCounts, eligibilityDistribution: result.eligibilityDistribution }, null, 2));
}
