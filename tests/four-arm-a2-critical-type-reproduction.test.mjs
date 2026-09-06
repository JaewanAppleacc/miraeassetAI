// Turn A2-DOCUMENTIR-NODESTORE-V1.1, Section 5: synthetic reproductions of
// the two real critical failure TYPES (연결/별도 scope confusion) that
// motivated A2 in the first place (ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md),
// plus period/unit conflict, insufficient-information, and exact-match
// end-to-end through the FULL real pipeline: extractQuestionConditions ->
// createDocumentIrFetchNode (backed by a small synthetic JSONL fixture, NOT
// the real corpus) -> runA2OverFrozenTop20. No packet ID, Gold, or real
// corpus content is used anywhere in this file.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractQuestionConditions } from "../domain/agent-comparison/four-arm-ac/a2-question-condition-extractor.mjs";
import { createDocumentIrFetchNode } from "../domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs";
import { runA2OverFrozenTop20 } from "../domain/agent-comparison/four-arm-ac/a2-integration-pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "a2-critical-type-repro-"));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

function writeSyntheticMajorJsonl(docs) {
  const filePath = path.join(TMP, "major.jsonl");
  writeFileSync(filePath, `${docs.map((d) => JSON.stringify(d)).join("\n")}\n`, "utf8");
  return filePath;
}

function frozenItem(rank, docId, nodeIndex) {
  return Object.freeze({
    rank, doc_id: docId, node_index: nodeIndex, node_indices: [nodeIndex],
    locator: `${docId}::f.xml::n${nodeIndex}`, row: null, col: null,
    chunk_id: `chunk_${String(rank).padStart(24, "0")}`, score: 1 / rank, score_type: "RRF",
  });
}

function consolidatedTableNode(docId, idx) {
  return {
    kind: "table", node_id: `${docId}::f.xml::n${idx}`, section_hierarchy: ["재무제표"],
    consolidation_basis: "연결", period_text: "2024년 1분기", unit_text: "백만원",
    raw_cells: [{ row: 0, col: 0, text: "매출액" }, { row: 0, col: 1, text: "1,000" }],
  };
}
function separateTableNode(docId, idx) {
  return {
    kind: "table", node_id: `${docId}::f.xml::n${idx}`, section_hierarchy: ["재무제표"],
    consolidation_basis: "별도", period_text: "2024년 1분기", unit_text: "백만원",
    raw_cells: [{ row: 0, col: 0, text: "매출액" }, { row: 0, col: 1, text: "900" }],
  };
}
function wrongPeriodTableNode(docId, idx) {
  return {
    kind: "table", node_id: `${docId}::f.xml::n${idx}`, section_hierarchy: ["재무제표"],
    consolidation_basis: "연결", period_text: "2024년 4분기 3개월", unit_text: "백만원",
    raw_cells: [{ row: 0, col: 0, text: "매출액" }, { row: 0, col: 1, text: "1,100" }],
  };
}
function noSpansNode() {
  return null; // simulates a node index that does not exist at all -> UNRESOLVED
}

async function runOneItem({ docId, node, questionText }) {
  const filePath = writeSyntheticMajorJsonl([{ doc_id: docId, nodes: node ? [node] : [] }]);
  const fetchNode = createDocumentIrFetchNode({ documentIrPaths: { major: filePath } });
  const frozenTop20 = [frozenItem(1, docId, 0)];
  const questionConditions = extractQuestionConditions({ questionText });
  const result = await runA2OverFrozenTop20({ frozenTop20, questionConditions, fetchNode, finalK: 10 });
  return result.validationResults[0];
}

// ---------------------------------------------------------------------------
// The two real critical failure TYPES, reproduced generically (no packet ID).
// ---------------------------------------------------------------------------

test("critical type 1: question requires 연결 (consolidated), evidence node is 별도 (separate) -> REJECT", async () => {
  const vr = await runOneItem({
    docId: "major_synthtype1", node: separateTableNode("major_synthtype1", 0),
    questionText: "가상회사의 2024년 1분기 연결 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "REJECT");
  assert.equal(vr.reason, "SCOPE_CONFLICT");
});

test("critical type 2: question requires 별도 (separate), evidence node is 연결 (consolidated) -> REJECT", async () => {
  const vr = await runOneItem({
    docId: "major_synthtype2", node: consolidatedTableNode("major_synthtype2", 0),
    questionText: "가상회사의 2024년 1분기 별도재무제표 기준 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "REJECT");
  assert.equal(vr.reason, "SCOPE_CONFLICT");
});

// ---------------------------------------------------------------------------
// Period/unit conflict -> REJECT.
// ---------------------------------------------------------------------------

test("period conflict: question requires Q1, evidence node is Q4-3개월 -> REJECT", async () => {
  const vr = await runOneItem({
    docId: "major_synthperiod", node: wrongPeriodTableNode("major_synthperiod", 0),
    questionText: "가상회사의 2024년 1분기 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "REJECT");
  assert.equal(vr.reason, "PERIOD_CONFLICT");
});

// ---------------------------------------------------------------------------
// Insufficient information -> UNRESOLVED (never an automatic PASS).
// ---------------------------------------------------------------------------

test("insufficient information: node does not exist at the frozen index -> UNRESOLVED, never PASS", async () => {
  const vr = await runOneItem({
    docId: "major_synthmissing", node: noSpansNode(),
    questionText: "가상회사의 2024년 1분기 연결 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "UNRESOLVED");
});

test("insufficient information: Q4 without an explicit 누적/3개월 qualifier stays UNRESOLVED (never auto-PASS or auto-REJECT)", async () => {
  const q4NoQualifierNode = {
    kind: "table", node_id: "major_synthq4::f.xml::n0", section_hierarchy: ["재무제표"],
    consolidation_basis: "연결", period_text: "2024년 4분기", unit_text: "백만원", // no 누적/3개월 -- genuinely ambiguous
    raw_cells: [{ row: 0, col: 0, text: "매출액" }, { row: 0, col: 1, text: "1,200" }],
  };
  const vr = await runOneItem({
    docId: "major_synthq4", node: q4NoQualifierNode,
    questionText: "가상회사의 2024년 4분기 3개월 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "UNRESOLVED");
});

// ---------------------------------------------------------------------------
// Exact match -> PASS.
// ---------------------------------------------------------------------------

test("exact match: scope/period both align -> PASS", async () => {
  const vr = await runOneItem({
    docId: "major_synthexact", node: consolidatedTableNode("major_synthexact", 0),
    questionText: "가상회사의 2024년 1분기 연결 매출액은 얼마인가?",
  });
  assert.equal(vr.status, "PASS");
});

// ---------------------------------------------------------------------------
// entity resolution: neither A's result items nor buildNodeGroundedEvidence
// carries an `entity` field at all -- without a resolveEntity callback
// (e.g. wired to the real documents.jsonl's own filer_name), a question
// requiring an entity match would be permanently UNRESOLVED regardless of
// how well every other dimension matches. This was found and fixed during
// this turn's own pre-execution real-corpus batch smoke check (before any
// Gold/score was opened) -- not a post-hoc threshold change.
// ---------------------------------------------------------------------------

test("entity: without resolveEntity, a question requiring an entity match is UNRESOLVED even when everything else matches exactly", async () => {
  const vr = await runOneItem({
    docId: "major_synthentity1", node: consolidatedTableNode("major_synthentity1", 0),
    questionText: "가상회사의 2024년 1분기 연결 매출액은 얼마인가?",
  });
  // (runOneItem never wires resolveEntity, and this question's extracted
  // conditions carry no entity either since no officialConditions.corps was
  // supplied -- this test instead directly exercises evaluateFrozenItem
  // with a manually-supplied entity requirement.)
  const questionConditions = { scope: "CONSOLIDATED", period: { fiscal_year: 2024, start_month: 1, end_month: 3 }, unit: null, row_column: null, entity: "가상회사" };
  const filePath = writeSyntheticMajorJsonl([{ doc_id: "major_synthentity1b", nodes: [consolidatedTableNode("major_synthentity1b", 0)] }]);
  const fetchNode = createDocumentIrFetchNode({ documentIrPaths: { major: filePath } });
  const item = frozenItem(1, "major_synthentity1b", 0);
  const result = await runA2OverFrozenTop20({ frozenTop20: [item], questionConditions, fetchNode, finalK: 10 });
  assert.equal(result.validationResults[0].status, "UNRESOLVED");
});

test("entity: with resolveEntity wired to real document metadata (never Gold), an exact entity match PASSes and a mismatch REJECTs", async () => {
  const questionConditionsMatch = { scope: "CONSOLIDATED", period: { fiscal_year: 2024, start_month: 1, end_month: 3 }, unit: null, row_column: null, entity: "가상회사" };
  const filePath = writeSyntheticMajorJsonl([{ doc_id: "major_synthentity2", nodes: [consolidatedTableNode("major_synthentity2", 0)] }]);
  const fetchNode = createDocumentIrFetchNode({ documentIrPaths: { major: filePath } });
  const item = frozenItem(1, "major_synthentity2", 0);
  const resolveEntity = (docId) => (docId === "major_synthentity2" ? "가상회사" : null);

  const matched = await runA2OverFrozenTop20({ frozenTop20: [item], questionConditions: questionConditionsMatch, fetchNode, finalK: 10, resolveEntity });
  assert.equal(matched.validationResults[0].status, "PASS");

  const questionConditionsMismatch = { ...questionConditionsMatch, entity: "다른회사" };
  const mismatched = await runA2OverFrozenTop20({ frozenTop20: [item], questionConditions: questionConditionsMismatch, fetchNode, finalK: 10, resolveEntity });
  assert.equal(mismatched.validationResults[0].status, "REJECT");
  assert.equal(mismatched.validationResults[0].reason, "ENTITY_CONFLICT");
});

// ---------------------------------------------------------------------------
// Original A top-20 order preservation + zero out-of-top-20 candidates,
// through the full pipeline with a realistic multi-item top-20.
// ---------------------------------------------------------------------------

test("original top-20 rank order is preserved end to end and no candidate outside the frozen top-20 ever appears in finalTopK", async () => {
  const docs = [];
  const items = [];
  for (let rank = 1; rank <= 5; rank += 1) {
    const docId = `major_synthorder${rank}`;
    const node = rank % 2 === 0 ? separateTableNode(docId, 0) : consolidatedTableNode(docId, 0);
    docs.push({ doc_id: docId, nodes: [node] });
    items.push(frozenItem(rank, docId, 0));
  }
  const filePath = writeSyntheticMajorJsonl(docs);
  const fetchNode = createDocumentIrFetchNode({ documentIrPaths: { major: filePath } });
  const questionConditions = extractQuestionConditions({ questionText: "가상회사의 2024년 1분기 연결 매출액은 얼마인가?" });
  const result = await runA2OverFrozenTop20({ frozenTop20: items, questionConditions, fetchNode, finalK: 10 });

  const finalRanks = result.filterResult.finalTopK.map((i) => i.rank);
  assert.deepEqual(finalRanks, [...finalRanks].sort((a, b) => a - b)); // stable, ascending
  assert.deepEqual(finalRanks, [1, 3, 5]); // odd ranks are 연결 (PASS); even ranks are 별도 (REJECT)
  const frozenIds = new Set(items.map((i) => i.chunk_id));
  for (const item of result.filterResult.finalTopK) assert.ok(frozenIds.has(item.chunk_id));
});

// ---------------------------------------------------------------------------
// Zero new retrieval calls / zero DB writes in the two Section-4 new files.
// ---------------------------------------------------------------------------

test("zero BM25/dense/RRF/KURE-embedding-call references and zero write-statement keywords in the new v1.1 source files' executable code", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs",
    "domain/agent-comparison/four-arm-ac/a2-question-condition-extractor.mjs",
  ];
  for (const rel of files) {
    const source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(codeOnly, /bm25|reciprocalRankFusion|embedQuery|searchDocumentChunksByVector|dense_search|rrf\(/i, rel);
    assert.doesNotMatch(codeOnly, /\bKURE\b/, rel);
    assert.doesNotMatch(codeOnly, /\b(INSERT INTO|UPDATE |DELETE FROM|DROP TABLE|TRUNCATE|CREATE TABLE|ALTER TABLE)\b/i, rel);
  }
});

// ---------------------------------------------------------------------------
// Original A/B/C/D result/run/scorer files remain byte-unchanged.
// ---------------------------------------------------------------------------

test("no existing A/B/C/D result/run/scorer file is modified relative to the pre-A2 base commit", () => {
  const trackedPaths = [
    "domain/agent-comparison/four-arm-ac/results/A.results.jsonl",
    "domain/agent-comparison/four-arm-ac/results/A.run.json",
    "domain/agent-comparison/four-arm-ac/results/C.results.jsonl",
    "domain/agent-comparison/four-arm-ac/results/C.run.json",
    "domain/agent-comparison/four-arm-ac/official/B.run.json",
    "domain/agent-comparison/four-arm-ac/official/D.run.json",
    "domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/fourarm.patched.py",
    "domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/fourarm.patch.diff",
  ];
  const diff = execFileSync(
    "git",
    ["diff", "--name-only", "622759a39681f96d00d103eca53d07276b705a29", "--", ...trackedPaths],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim();
  assert.equal(diff, "", `expected zero diff vs base commit for frozen A/B/C/D/scorer files, got:\n${diff}`);
});
