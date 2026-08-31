#!/usr/bin/env node
// Turn N4.20.1: read-only re-verification of N4.20's Gold-300 selection
// and author-allocation candidates, computing the per-author (AUTHOR_A/
// AUTHOR_B) eligibility breakdown that N4.20 never produced. This script
// NEVER writes to any N4.20 file (candidate-pool.v0.3, anchor-selection
// .v0.3, author-allocation.v0.3, gold-300-selection-candidate.v0.1.jsonl,
// gold-300-author-allocation-candidate.v0.1.jsonl, the two authoring
// packets) -- all read-only, hash-verified unchanged.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildParseCoverageIndex, buildRelationComponentStatusIndex, classifyEligibility } from "../domain/evaluation/gold-300-selection.mjs";
import { summarizeEligibilityByAuthor, verifyAuthorSplitMatchesTotal } from "../domain/evaluation/gold-300-authorization.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const GOLD_300_DIR = resolve(V02_DIR, "gold-300-v0.1");
const AUTHORING_V01_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const PARSE_AUDIT_PATH = resolve(REPO_ROOT, "work/a-document-ir/parse-audit.full.jsonl");

const SELECTION_PATH = resolve(GOLD_300_DIR, "gold-300-selection-candidate.v0.1.jsonl");
const AUTHOR_ALLOC_PATH = resolve(GOLD_300_DIR, "gold-300-author-allocation-candidate.v0.1.jsonl");
const GATE_STATUS_V01_PATH = resolve(GOLD_300_DIR, "gold-300-gate-status.v0.1.json");
const PACKET_A_PATH = resolve(AUTHORING_V01_DIR, "author-a-gold-150-authoring-packet.v0.1.jsonl");
const PACKET_B_PATH = resolve(AUTHORING_V01_DIR, "author-b-gold-150-authoring-packet.v0.1.jsonl");

export const OUT_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2");

export function buildGold300PlanReverification({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  // ---- 1. Snapshot every real N4.20 input's SHA before touching anything -
  const before = {
    selection: sha256File(SELECTION_PATH),
    authorAlloc: sha256File(AUTHOR_ALLOC_PATH),
    packetA: sha256File(PACKET_A_PATH),
    packetB: sha256File(PACKET_B_PATH),
  };

  const selection = readJsonl(SELECTION_PATH);
  const authorAlloc = readJsonl(AUTHOR_ALLOC_PATH);
  const gateStatusV01 = readJson(GATE_STATUS_V01_PATH);
  const ledgerRows = readJsonl(LEDGER_PATH);
  const parseAuditRows = readJsonl(PARSE_AUDIT_PATH);

  if (selection.length !== 300) throw new Error(`buildGold300PlanReverification: selection candidate must have 300 rows, got ${selection.length}`);
  if (authorAlloc.length !== 300) throw new Error(`buildGold300PlanReverification: author allocation candidate must have 300 rows, got ${authorAlloc.length}`);

  const authorAllocById = new Map(authorAlloc.map((r) => [r.assignment_id, r.author_allocation]));
  const finalAuthorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const author of authorAllocById.values()) finalAuthorCounts[author] += 1;
  if (finalAuthorCounts.AUTHOR_A !== 150 || finalAuthorCounts.AUTHOR_B !== 150) {
    throw new Error(`buildGold300PlanReverification: A/B must be 150/150, got ${JSON.stringify(finalAuthorCounts)}`);
  }

  // ---- 2. Live re-classification (never trusts the cached N4.20 report) -
  const parseCoverageIndex = buildParseCoverageIndex(parseAuditRows);
  const relationComponentStatusIndex = buildRelationComponentStatusIndex(ledgerRows);
  const classifiedRows = selection.map((record) => {
    const { status } = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
    const author = authorAllocById.get(record.assignment_id);
    if (!author) throw new Error(`buildGold300PlanReverification: ${record.assignment_id} has no author allocation`);
    return {
      assignment_id: record.assignment_id, evaluation_group_id: record.evaluation_group_id, chain_component_id: record.chain_component_id,
      author_allocation: author, planned_split: record.planned_split, gold_pool_role: record.gold_pool_role, authoring_eligibility: status,
    };
  });

  // ---- 3. No evaluation_group_id/chain_component_id ever split across authors
  const groupToAuthor = new Map();
  const componentToAuthor = new Map();
  for (const row of classifiedRows) {
    const priorGroup = groupToAuthor.get(row.evaluation_group_id);
    if (priorGroup !== undefined && priorGroup !== row.author_allocation) {
      throw new Error(`buildGold300PlanReverification: evaluation_group_id ${row.evaluation_group_id} split across authors`);
    }
    groupToAuthor.set(row.evaluation_group_id, row.author_allocation);
    // A null chain_component_id means "this row has no chain component at
    // all" -- it is not a shared identity, so many independent null rows
    // going to different authors is never a real split. Only a real,
    // non-null component id is checked.
    if (row.chain_component_id !== null && row.chain_component_id !== undefined) {
      const priorComponent = componentToAuthor.get(row.chain_component_id);
      if (priorComponent !== undefined && priorComponent !== row.author_allocation) {
        throw new Error(`buildGold300PlanReverification: chain_component_id ${row.chain_component_id} split across authors`);
      }
      componentToAuthor.set(row.chain_component_id, row.author_allocation);
    }
  }

  // ---- 4. Duplicate / intersection checks against the two real packets --
  const idSet = new Set(classifiedRows.map((r) => r.assignment_id));
  if (idSet.size !== 300) throw new Error(`buildGold300PlanReverification: duplicate assignment_id in selection candidate (${300 - idSet.size} dup(s))`);
  const packetAIds = new Set(readJsonl(PACKET_A_PATH).map((r) => r.assignment_id));
  const packetBIds = new Set(readJsonl(PACKET_B_PATH).map((r) => r.assignment_id));
  const intersection = [...packetAIds].filter((id) => packetBIds.has(id));
  if (intersection.length !== 0) throw new Error(`buildGold300PlanReverification: packet intersection non-empty: ${intersection.join(", ")}`);

  // ---- 5. Per-author distribution + cross-check against combined totals -
  const summary = summarizeEligibilityByAuthor(classifiedRows);
  const expectedCombined = {
    total: 300,
    eligible_count: gateStatusV01.eligible_count,
    blocked_count: gateStatusV01.blocked_count,
  };
  const crossCheck = verifyAuthorSplitMatchesTotal({ summary, expectedCombined });
  if (!crossCheck.ok) {
    throw new Error(`buildGold300PlanReverification: A/B totals do not sum to the combined total -- ${JSON.stringify(crossCheck.violations)}`);
  }

  const immediatelyAuthorizableCount = summary.combined.eligible_count;
  const manualReviewRequiredCount = summary.combined.manual_review_count;
  const blockedCount = summary.combined.blocked_count;
  const authorAImmediatelyAuthorizable = summary.perAuthor.AUTHOR_A.eligible_count;
  const authorBImmediatelyAuthorizable = summary.perAuthor.AUTHOR_B.eligible_count;
  const authorABlocked = summary.perAuthor.AUTHOR_A.blocked_count;
  const authorBBlocked = summary.perAuthor.AUTHOR_B.blocked_count;

  // ---- 6. Confirm every N4.20 input is still byte-unmodified -----------
  const after = {
    selection: sha256File(SELECTION_PATH),
    authorAlloc: sha256File(AUTHOR_ALLOC_PATH),
    packetA: sha256File(PACKET_A_PATH),
    packetB: sha256File(PACKET_B_PATH),
  };
  const n4_20_inputs_unmodified = JSON.stringify(before) === JSON.stringify(after);
  if (!n4_20_inputs_unmodified) throw new Error("buildGold300PlanReverification: an N4.20 input file changed during re-verification -- refusing to proceed");

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    schema_version: "0.1.0", turn: "N4.20.1", generated_at: now,
    scope_note: "Read-only re-verification of N4.20's Gold-300 selection/author-allocation candidates. Computes the per-author (AUTHOR_A/AUTHOR_B) eligibility breakdown N4.20 never produced. Never writes to any N4.20 file.",
    n4_20_inputs_unmodified,
    n4_20_input_shas: after,
    total_plan_count: 300,
    author_a_assigned_count: finalAuthorCounts.AUTHOR_A,
    author_b_assigned_count: finalAuthorCounts.AUTHOR_B,
    immediately_authorizable_count: immediatelyAuthorizableCount,
    manual_review_required_count: manualReviewRequiredCount,
    blocked_count: blockedCount,
    author_a_immediately_authorizable_count: authorAImmediatelyAuthorizable,
    author_b_immediately_authorizable_count: authorBImmediatelyAuthorizable,
    author_a_blocked_count: authorABlocked,
    author_b_blocked_count: authorBBlocked,
    per_author: summary.perAuthor,
    combined: summary.combined,
    cross_check_against_n4_20_gate_status: crossCheck,
    duplicate_assignment_ids: 300 - idSet.size,
    packet_intersection_count: intersection.length,
    no_group_or_component_split_across_authors: true,
  };
  writeJson(resolve(OUT_DIR, "gold-300-eligibility-by-author-v0.2.json"), report);

  return Object.freeze({ outDir: OUT_DIR, report, classifiedRows });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300PlanReverification();
  console.log(JSON.stringify({
    status: "GOLD_300_PLAN_REVERIFICATION_COMPLETE",
    n4_20_inputs_unmodified: result.report.n4_20_inputs_unmodified,
    immediately_authorizable_count: result.report.immediately_authorizable_count,
    manual_review_required_count: result.report.manual_review_required_count,
    blocked_count: result.report.blocked_count,
    per_author: { AUTHOR_A: result.report.per_author.AUTHOR_A, AUTHOR_B: result.report.per_author.AUTHOR_B },
  }, null, 2));
}
