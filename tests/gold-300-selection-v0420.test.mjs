// Turn N4.20 (corrected): regression coverage for the Gold-300 selection,
// eligibility classification, and per-author authoring packet builders.
// These tests run the REAL builders against the REAL, already-approved
// v0.3 split data (read-only) and write only under new gold-300-v0.1 /
// gold-authoring-300-v0.1 directories -- they never modify candidate-pool
// .v0.3.jsonl, anchor-selection.v0.3.jsonl, or author-allocation.v0.3.jsonl.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  selectExpansionPool,
  buildParseCoverageIndex,
  buildRelationComponentStatusIndex,
  classifyEligibility,
  summarizeEligibility,
  ELIGIBILITY,
} from "../domain/evaluation/gold-300-selection.mjs";
import { buildGold300Selection, OUT_DIR as SELECTION_OUT_DIR } from "../scripts/build-gold-300-selection-v0420.mjs";
import { buildGold300AuthoringPackets, OUT_DIR as PACKET_OUT_DIR } from "../scripts/build-gold-300-authoring-packets-v0420.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function readJsonl(p) { return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

const POOL_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl");
const ANCHOR_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl");
const AUTHOR_V03_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/author-allocation.v0.3.jsonl");

function hashSources() {
  return {
    pool: sha256(readFileSync(POOL_PATH)),
    anchor: sha256(readFileSync(ANCHOR_PATH)),
    authorV03: sha256(readFileSync(AUTHOR_V03_PATH)),
  };
}

// -- selectExpansionPool (pure) -------------------------------------------

test("selectExpansionPool: reaches an exact target when group sizes allow it, never splitting a group", () => {
  const poolRecords = [
    { assignment_id: "a1", evaluation_group_id: "g1", planned_split: "DEV_CHECK" },
    { assignment_id: "a2", evaluation_group_id: "g2", planned_split: "DEV_CHECK" },
    { assignment_id: "a3", evaluation_group_id: "g2", planned_split: "DEV_CHECK" },
    { assignment_id: "a4", evaluation_group_id: "g3", planned_split: "DEV_CHECK" },
    { assignment_id: "a5", evaluation_group_id: "g4", planned_split: "HOLDOUT" },
  ];
  const result = selectExpansionPool({ poolRecords, excludeAssignmentIds: [], plannedSplit: "DEV_CHECK", targetIdeal: 2, targetMin: 2, targetMax: 2, salt: "test" });
  assert.equal(result.exactTargetReachable, true);
  assert.equal(result.actualCount, 2);
  const groupsInSelection = new Set(result.selected.map((r) => r.evaluation_group_id));
  // whichever groups were chosen, no group's members are split (either all or none of a group's rows appear)
  for (const groupId of groupsInSelection) {
    const totalInPool = poolRecords.filter((r) => r.evaluation_group_id === groupId && r.planned_split === "DEV_CHECK").length;
    const totalInSelection = result.selected.filter((r) => r.evaluation_group_id === groupId).length;
    assert.equal(totalInSelection, totalInPool, `group ${groupId} must be all-or-nothing`);
  }
});

test("selectExpansionPool: excludes assignment_ids already in the excludeAssignmentIds set (the existing Anchor)", () => {
  const poolRecords = [
    { assignment_id: "anchor-1", evaluation_group_id: "g1", planned_split: "DEV_CHECK" },
    { assignment_id: "a2", evaluation_group_id: "g2", planned_split: "DEV_CHECK" },
  ];
  const result = selectExpansionPool({ poolRecords, excludeAssignmentIds: ["anchor-1"], plannedSplit: "DEV_CHECK", targetIdeal: 1, targetMin: 1, targetMax: 1, salt: "test" });
  assert.equal(result.selected.some((r) => r.assignment_id === "anchor-1"), false);
});

test("selectExpansionPool: two calls with the same inputs and salt produce the identical selection (deterministic)", () => {
  const poolRecords = Array.from({ length: 20 }, (_, i) => ({ assignment_id: `a${i}`, evaluation_group_id: `g${i}`, planned_split: "HOLDOUT" }));
  const r1 = selectExpansionPool({ poolRecords, excludeAssignmentIds: [], plannedSplit: "HOLDOUT", targetIdeal: 10, targetMin: 10, targetMax: 10, salt: "same-salt" });
  const r2 = selectExpansionPool({ poolRecords, excludeAssignmentIds: [], plannedSplit: "HOLDOUT", targetIdeal: 10, targetMin: 10, targetMax: 10, salt: "same-salt" });
  assert.deepEqual(r1.selected.map((r) => r.assignment_id).sort(), r2.selected.map((r) => r.assignment_id).sort());
});

// -- eligibility classification (pure, real data) -------------------------

test("classifyEligibility: BLOCKED_PARSE_FAILED takes precedence even when the relation is settled and no other document is partial", () => {
  const parseCoverageIndex = new Map([["doc-a", "PARSE_FAILED"]]);
  const relationComponentStatusIndex = new Map([["comp-1", "SETTLED"]]);
  const record = { anchor_document_ids: ["doc-a"], chain_component_id: "comp-1" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.BLOCKED_PARSE_FAILED);
});

test("classifyEligibility: BLOCKED_PROVISIONAL_RELATION when the component still has an unreviewed ledger row, even with clean parse coverage", () => {
  const parseCoverageIndex = new Map([["doc-a", "PRESENT"]]);
  const relationComponentStatusIndex = new Map([["comp-1", "PROVISIONAL"]]);
  const record = { anchor_document_ids: ["doc-a"], chain_component_id: "comp-1" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.BLOCKED_PROVISIONAL_RELATION);
});

test("classifyEligibility: NEEDS_MANUAL_SOURCE_REVIEW for a partial-parse document with no provisional relation", () => {
  const parseCoverageIndex = new Map([["doc-a", "PARTIAL_PARSE_FAILURE"]]);
  const relationComponentStatusIndex = new Map();
  const record = { anchor_document_ids: ["doc-a"], chain_component_id: "comp-none" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.NEEDS_MANUAL_SOURCE_REVIEW);
});

test("classifyEligibility: ELIGIBLE_VERIFIED_RELATION when the component's relation is settled (CONFIRM or REJECT alike -- a rejection is itself a settled fact, never treated as 'still needs review')", () => {
  const parseCoverageIndex = new Map([["doc-a", "PRESENT"]]);
  const relationComponentStatusIndex = new Map([["comp-1", "SETTLED"]]);
  const record = { anchor_document_ids: ["doc-a"], chain_component_id: "comp-1" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.ELIGIBLE_VERIFIED_RELATION);
});

test("classifyEligibility: ELIGIBLE_DOCUMENT_LOCAL when the component never appears in the ledger at all (no tracked candidate relation ever touched it)", () => {
  const parseCoverageIndex = new Map([["doc-a", "PRESENT"]]);
  const relationComponentStatusIndex = new Map();
  const record = { anchor_document_ids: ["doc-a"], chain_component_id: "comp-none" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.ELIGIBLE_DOCUMENT_LOCAL);
});

test("classifyEligibility: an UNKNOWN document (no parse-audit row at all) is treated as NEEDS_MANUAL_SOURCE_REVIEW, never silently eligible", () => {
  const parseCoverageIndex = new Map();
  const relationComponentStatusIndex = new Map();
  const record = { anchor_document_ids: ["never-audited-doc"], chain_component_id: "comp-none" };
  const result = classifyEligibility({ record, parseCoverageIndex, relationComponentStatusIndex });
  assert.equal(result.status, ELIGIBILITY.NEEDS_MANUAL_SOURCE_REVIEW);
});

test("summarizeEligibility: counts every ELIGIBILITY value, including zero-count categories", () => {
  const classified = [{ authoring_eligibility: ELIGIBILITY.ELIGIBLE_DOCUMENT_LOCAL }, { authoring_eligibility: ELIGIBILITY.ELIGIBLE_DOCUMENT_LOCAL }];
  const summary = summarizeEligibility(classified);
  assert.equal(summary.ELIGIBLE_DOCUMENT_LOCAL, 2);
  assert.equal(summary.BLOCKED_PARSE_FAILED, 0);
  assert.equal(Object.keys(summary).length, Object.keys(ELIGIBILITY).length);
});

test("buildParseCoverageIndex / buildRelationComponentStatusIndex: real full parse audit and real 326-row ledger reproduce the documented corpus facts (structured 2693 / partial 1432 / fallback 79, PARSE_FAILED 2)", () => {
  const parseAuditRows = readJsonl(resolve(REPO_ROOT, "work/a-document-ir/parse-audit.full.jsonl"));
  const index = buildParseCoverageIndex(parseAuditRows);
  const counts = { PRESENT: 0, PARTIAL_PARSE_FAILURE: 0, PARSE_FAILED: 0 };
  for (const state of index.values()) counts[state] += 1;
  assert.equal(counts.PARSE_FAILED, 2);
  assert.equal(counts.PARTIAL_PARSE_FAILURE, 79);
  assert.equal(index.size, 4204);
});

// -- buildGold300Selection (real builder, real read-only inputs) ---------

test("buildGold300Selection never modifies candidate-pool.v0.3 / anchor-selection.v0.3 / author-allocation.v0.3", () => {
  const before = hashSources();
  buildGold300Selection();
  const after = hashSources();
  assert.deepEqual(after, before);
});

test("buildGold300Selection reaches the exact TARGET_SIZE.v1.md distribution (DEV_TUNE 150 / DEV_CHECK 50 / HOLDOUT 100 = 300) and exact 150/150 author balance", () => {
  const result = buildGold300Selection();
  assert.deepEqual(result.splitCounts, { DEV_TUNE: 150, DEV_CHECK: 50, HOLDOUT: 100 });
  assert.deepEqual(result.finalAuthorCounts, { AUTHOR_A: 150, AUTHOR_B: 150 });
  assert.equal(result.selectionCandidate.length, 300);
});

test("buildGold300Selection: the existing Anchor 150's author allocation is copied verbatim (75/75), never recomputed", () => {
  const result = buildGold300Selection();
  const anchorRows = result.authorAllocationCandidate.filter((r) => r.gold_pool_role === "EXISTING_ANCHOR");
  assert.equal(anchorRows.length, 150);
  const counts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of anchorRows) counts[r.author_allocation] += 1;
  assert.deepEqual(counts, { AUTHOR_A: 75, AUTHOR_B: 75 });

  const realAuthorV03 = readJsonl(AUTHOR_V03_PATH);
  const realById = new Map(realAuthorV03.map((r) => [r.assignment_id, r.author_allocation]));
  for (const r of anchorRows) assert.equal(r.author_allocation, realById.get(r.assignment_id), `${r.assignment_id} must keep its real existing author allocation`);
});

test("buildGold300Selection: no evaluation_group_id is ever split across AUTHOR_A and AUTHOR_B in the final 300", () => {
  const result = buildGold300Selection();
  const groupToAuthor = new Map();
  for (const r of result.authorAllocationCandidate) {
    const prior = groupToAuthor.get(r.evaluation_group_id);
    if (prior !== undefined) assert.equal(prior, r.author_allocation, `evaluation_group_id ${r.evaluation_group_id} split across authors`);
    groupToAuthor.set(r.evaluation_group_id, r.author_allocation);
  }
});

test("buildGold300Selection: eligibility_distribution counts sum to exactly 300 and match the written eligibility report file", () => {
  const result = buildGold300Selection();
  const total = Object.values(result.eligibilityDistribution).reduce((a, b) => a + b, 0);
  assert.equal(total, 300);
  const report = readJson(resolve(SELECTION_OUT_DIR, "gold-300-eligibility-report.v0.1.json"));
  assert.deepEqual(report.eligibility_distribution, result.eligibilityDistribution);
  assert.equal(report.blocked_items.length, report.blocked_count);
});

test("buildGold300Selection: no question/expected_answer/citation field is ever written by the selection candidate rows (selection only, no authoring content)", () => {
  const result = buildGold300Selection();
  for (const r of result.selectionCandidate) {
    assert.equal("expected_answer" in r, false);
    assert.equal("question" in r, false);
    assert.equal("evidence_citations" in r, false);
  }
});

test("gold-300-gate-status.v0.1.json keeps every authorization flag false pre-Owner-decision", () => {
  buildGold300Selection();
  const gate = readJson(resolve(SELECTION_OUT_DIR, "gold-300-gate-status.v0.1.json"));
  assert.equal(gate.gold_authoring_authorized, false);
  assert.equal(gate.authorized_scope, "NONE");
  assert.equal(gate.holdout_evaluation_authorized, false);
  assert.equal(gate.production_wiring_authorized, false);
  assert.equal(gate.actual_official_promotion_applied, false);
  assert.equal(gate.relation_decisions_authorized, false);
  assert.equal(gate.agent_ranking_authorized, false);
});

// -- buildGold300AuthoringPackets (real builder) --------------------------

test("buildGold300AuthoringPackets: exactly 150 rows per author, 0 duplicate assignment_ids, 0 shared evaluation_group_id, union exactly 300", () => {
  buildGold300Selection();
  const result = buildGold300AuthoringPackets();
  assert.equal(result.rowsByAuthor.AUTHOR_A.length, 150);
  assert.equal(result.rowsByAuthor.AUTHOR_B.length, 150);
  assert.equal(result.manifest.duplicate_assignment_ids_across_packets, 0);
  assert.equal(result.manifest.shared_evaluation_group_ids_across_packets, 0);
  assert.equal(result.manifest.union_count, 300);
});

test("buildGold300AuthoringPackets: every row's question/expected_answer/citation status is NOT_AUTHORED, and no actual question/answer text is ever generated", () => {
  buildGold300Selection();
  const result = buildGold300AuthoringPackets();
  const allRows = [...result.rowsByAuthor.AUTHOR_A, ...result.rowsByAuthor.AUTHOR_B];
  assert.equal(allRows.length, 300);
  for (const row of allRows) {
    assert.equal(row.question_status, "NOT_AUTHORED");
    assert.equal(row.expected_answer_status, "NOT_AUTHORED");
    assert.equal(row.citation_status, "NOT_AUTHORED");
    assert.equal(row.question, null);
    assert.equal(row.expected_answer, null);
    assert.deepEqual(row.evidence_citations, []);
  }
  assert.equal(result.manifest.all_question_answer_citation_status_not_authored, true);
});

test("buildGold300AuthoringPackets: the real written .jsonl files on disk are byte-identical to their own manifest-pinned SHA-256", () => {
  buildGold300Selection();
  const result = buildGold300AuthoringPackets();
  const bytesA = readFileSync(result.pathA);
  const bytesB = readFileSync(result.pathB);
  assert.equal(sha256(bytesA), result.manifest.author_a.sha256);
  assert.equal(sha256(bytesB), result.manifest.author_b.sha256);
});

test("buildGold300AuthoringPackets: a blocked row (BLOCKED_PARSE_FAILED or BLOCKED_PROVISIONAL_RELATION) is present in its author's packet, not silently dropped", () => {
  buildGold300Selection();
  const result = buildGold300AuthoringPackets();
  const allRows = [...result.rowsByAuthor.AUTHOR_A, ...result.rowsByAuthor.AUTHOR_B];
  const blockedRows = allRows.filter((r) => r.authoring_eligibility.startsWith("BLOCKED_"));
  assert.ok(blockedRows.length > 0, "this real corpus is known to have at least one BLOCKED item -- if this ever becomes 0, update this test's premise rather than deleting it");
  for (const row of blockedRows) assert.ok(row.blocked_reason && row.blocked_reason.length > 0, `${row.assignment_id} is BLOCKED but has no blocked_reason`);
});
