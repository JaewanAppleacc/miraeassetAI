// Turn A2-DOCUMENTIR-NODESTORE-V1.1: scoped, offline tests for
// a2-documentir-node-store.mjs. Uses small synthetic JSONL fixture files
// written to a temp directory (not the real 4-file corpus, not Gold) so the
// module's own file-IO/offset/rendering logic is exercised directly.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  sha256File, verifyDocumentIrFiles, loadPrebuiltOffsetIndex, readDocumentAtLocation,
  extractDocumentsByBoundedScan, renderNode, createDocumentIrFetchNode,
  DOCUMENTIR_MANIFEST_SHA256,
} from "../domain/agent-comparison/four-arm-ac/a2-documentir-node-store.mjs";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const TMP = mkdtempSync(path.join(tmpdir(), "a2-documentir-test-"));

function writeJsonlDoc(filePath, docs) {
  const lines = docs.map((d) => JSON.stringify(d));
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return lines;
}

const SECTION_NODE = { kind: "section", node_id: "major_doc1::f.xml::n0", title_text: "개요", section_hierarchy: [] };
const PARAGRAPH_NODE = { kind: "paragraph", node_id: "major_doc1::f.xml::n1", text: "본문 문단", section_hierarchy: ["개요"] };
const TABLE_NODE_CELLS = {
  kind: "table", node_id: "major_doc1::f.xml::n2", section_hierarchy: ["개요", "재무제표"],
  consolidation_basis: "연결", period_text: "2024년 1분기", unit_text: "백만원",
  raw_cells: [
    { row: 0, col: 0, text: "구분" }, { row: 0, col: 1, text: "2024년 1분기" },
    { row: 1, col: 0, text: "매출액" }, { row: 1, col: 1, text: "1,000" },
  ],
};
const TABLE_NODE_ROWS = {
  kind: "table", node_id: "major_doc1::f.xml::n3", section_hierarchy: ["개요"],
  consolidation_basis: null, period_text: null, unit_text: null,
  raw_rows: [[{ text: "구분" }, { text: "당기" }], [{ text: "매출액" }, { text: "500" }]],
};
const EMPTY_TABLE_NODE = { kind: "table", node_id: "major_doc1::f.xml::n4", section_hierarchy: [], raw_cells: [] };

const DOC1 = { doc_id: "major_doc1", nodes: [SECTION_NODE, PARAGRAPH_NODE, TABLE_NODE_CELLS, TABLE_NODE_ROWS, EMPTY_TABLE_NODE] };
const DOC2 = { doc_id: "major_doc2", nodes: [{ kind: "section", node_id: "major_doc2::f.xml::n0", title_text: "다른 문서" }] };

const majorPath = path.join(TMP, "major.jsonl");
const lines = writeJsonlDoc(majorPath, [DOC1, DOC2]);

test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// File verification
// ---------------------------------------------------------------------------

test("sha256File computes the real file hash", async () => {
  const expected = sha256(`${lines.join("\n")}\n`);
  const actual = await sha256File(majorPath);
  assert.equal(actual, expected);
});

test("verifyDocumentIrFiles detects a mismatch against a wrong expected hash", async () => {
  const result = await verifyDocumentIrFiles({ major: majorPath }, { "major.jsonl": "0".repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 1);
});

test("verifyDocumentIrFiles passes when the expected hash matches the live file", async () => {
  const expected = await sha256File(majorPath);
  const result = await verifyDocumentIrFiles({ major: majorPath }, { "major.jsonl": expected });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Prebuilt offset index: pin mismatch and live-file mismatch both fail closed.
// ---------------------------------------------------------------------------

test("loadPrebuiltOffsetIndex fails closed on a wrong manifest_sha256 pin", async () => {
  const indexDir = path.join(TMP, "idx-badpin");
  const fs = await import("node:fs/promises");
  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(path.join(indexDir, "index_manifest.json"), JSON.stringify({ manifest_sha256: "wrong" }));
  await fs.writeFile(path.join(indexDir, "node_offsets.jsonl"), "");
  const result = await loadPrebuiltOffsetIndex({ indexDir, documentIrPaths: { major: majorPath } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INDEX_MANIFEST_PIN_MISMATCH");
});

test("loadPrebuiltOffsetIndex fails closed when a live DocumentIR file's SHA-256 no longer matches", async () => {
  const indexDir = path.join(TMP, "idx-badfile");
  const fs = await import("node:fs/promises");
  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(path.join(indexDir, "index_manifest.json"), JSON.stringify({ manifest_sha256: DOCUMENTIR_MANIFEST_SHA256 }));
  await fs.writeFile(path.join(indexDir, "node_offsets.jsonl"), "");
  const result = await loadPrebuiltOffsetIndex({ indexDir, documentIrPaths: { major: majorPath } });
  // EXPECTED_FILE_SHA256["major.jsonl"] is the REAL corpus's pin, not this
  // synthetic fixture's hash -- so this must fail closed, not silently pass.
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DOCUMENTIR_FILE_SHA_MISMATCH");
});

test("readDocumentAtLocation reads exactly the bytes at offset/length and parses them", async () => {
  const firstLineBytes = Buffer.byteLength(`${lines[0]}\n`, "utf8");
  const doc = await readDocumentAtLocation(majorPath, { offset: 0, length: firstLineBytes - 1 });
  assert.equal(doc.doc_id, "major_doc1");
  const secondLineBytes = Buffer.byteLength(`${lines[1]}\n`, "utf8");
  const doc2 = await readDocumentAtLocation(majorPath, { offset: firstLineBytes, length: secondLineBytes - 1 });
  assert.equal(doc2.doc_id, "major_doc2");
});

// ---------------------------------------------------------------------------
// Bounded streaming fallback
// ---------------------------------------------------------------------------

test("extractDocumentsByBoundedScan finds only the needed doc_id(s), ignoring the rest", async () => {
  const found = await extractDocumentsByBoundedScan(majorPath, ["major_doc2"]);
  assert.equal(found.size, 1);
  assert.equal(found.get("major_doc2").doc_id, "major_doc2");
  assert.ok(!found.has("major_doc1"));
});

test("extractDocumentsByBoundedScan returns an empty map for a doc_id that does not exist", async () => {
  const found = await extractDocumentsByBoundedScan(majorPath, ["major_does_not_exist"]);
  assert.equal(found.size, 0);
});

// ---------------------------------------------------------------------------
// Deterministic rendering -- never fabricates a field the node lacks.
// ---------------------------------------------------------------------------

test("renderNode: section uses title_text verbatim", () => {
  const r = renderNode(SECTION_NODE);
  assert.equal(r.isTable, false);
  assert.equal(r.text, "개요");
  assert.equal(r.table, null);
});

test("renderNode: paragraph uses its own text field verbatim", () => {
  const r = renderNode(PARAGRAPH_NODE);
  assert.equal(r.text, "본문 문단");
});

test("renderNode: table with raw_cells renders consolidation_basis/period/unit headers + row-ordered cells, never fabricating an absent field", () => {
  const r = renderNode(TABLE_NODE_CELLS);
  assert.equal(r.isTable, true);
  assert.ok(r.text.startsWith("구분: 연결\n기간: 2024년 1분기\n단위: 백만원\n"));
  assert.ok(r.text.includes("구분 | 2024년 1분기"));
  assert.ok(r.text.includes("매출액 | 1,000"));
  assert.equal(r.table.title, "재무제표"); // no title_text on the node -> falls back to nearest section_hierarchy entry, not invented
  assert.deepEqual(r.table.rowLabels, ["구분", "매출액"]);
  assert.deepEqual(r.table.colLabels, ["구분", "2024년 1분기"]);
});

test("renderNode: table with raw_rows (nested) and no consolidation_basis/period/unit omits those header lines entirely (never fabricated)", () => {
  const r = renderNode(TABLE_NODE_ROWS);
  assert.ok(!r.text.includes("구분:"));
  assert.ok(!r.text.includes("기간:"));
  assert.ok(!r.text.includes("단위:"));
  assert.ok(r.text.startsWith("구분 | 당기"));
});

test("renderNode: an empty table (no cells at all) has no content", () => {
  const r = renderNode(EMPTY_TABLE_NODE);
  assert.equal(r.hasContent, false);
});

test("renderNode: unknown kind has no content and no table", () => {
  const r = renderNode({ kind: "unknown_kind" });
  assert.equal(r.hasContent, false);
  assert.equal(r.table, null);
});

// ---------------------------------------------------------------------------
// fetchNode factory: exact match, fail-closed identity, allowlist, determinism.
// ---------------------------------------------------------------------------

function makeFetchNode(extra = {}) {
  return createDocumentIrFetchNode({ documentIrPaths: { major: majorPath }, offsetIndex: null, ...extra });
}

test("createDocumentIrFetchNode: exact document_id + node_index returns real, non-fabricated text", async () => {
  const fetchNode = makeFetchNode();
  const result = await fetchNode({ documentId: "major_doc1", nodeIndex: 1 });
  assert.equal(result.found, true);
  assert.equal(result.text, "본문 문단");
  assert.equal(result.nodeId, "major_doc1::f.xml::n1");
});

test("createDocumentIrFetchNode: wrong node_index for an existing document is UNRESOLVED, never a neighboring node's content", async () => {
  const fetchNode = makeFetchNode();
  const result = await fetchNode({ documentId: "major_doc1", nodeIndex: 999 });
  assert.equal(result.found, false);
  assert.equal(result.unresolvedReason, "NODE_INDEX_OUT_OF_RANGE");
});

test("createDocumentIrFetchNode: a document that does not exist is UNRESOLVED, never a different document", async () => {
  const fetchNode = makeFetchNode();
  const result = await fetchNode({ documentId: "major_does_not_exist", nodeIndex: 0 });
  assert.equal(result.found, false);
  assert.equal(result.unresolvedReason, "DOCUMENT_NOT_FOUND");
});

test("createDocumentIrFetchNode: node_id/node_index cross-check mismatch fails closed", async () => {
  const badMajorPath = path.join(TMP, "major-bad-id.jsonl");
  writeJsonlDoc(badMajorPath, [{ doc_id: "major_bad", nodes: [{ kind: "paragraph", node_id: "major_bad::f.xml::n99", text: "x" }] }]);
  const fetchNode = createDocumentIrFetchNode({ documentIrPaths: { major: badMajorPath } });
  const result = await fetchNode({ documentId: "major_bad", nodeIndex: 0 }); // node_id says n99, requested index 0
  assert.equal(result.found, false);
  assert.equal(result.unresolvedReason, "NODE_ID_INDEX_MISMATCH");
});

test("createDocumentIrFetchNode: a node with no real content (empty table) is UNRESOLVED, never returned as found with empty text", async () => {
  const fetchNode = makeFetchNode();
  const result = await fetchNode({ documentId: "major_doc1", nodeIndex: 4 });
  assert.equal(result.found, false);
  assert.equal(result.unresolvedReason, "NODE_TEXT_UNAVAILABLE");
});

test("createDocumentIrFetchNode: allowedLookupKeys blocks any lookup outside the frozen A candidate set", async () => {
  const fetchNode = makeFetchNode({ allowedLookupKeys: new Set(["major_doc1::1"]) });
  const allowed = await fetchNode({ documentId: "major_doc1", nodeIndex: 1 });
  assert.equal(allowed.found, true);
  const blocked = await fetchNode({ documentId: "major_doc1", nodeIndex: 2 });
  assert.equal(blocked.found, false);
  assert.equal(blocked.unresolvedReason, "OUTSIDE_FROZEN_A_CANDIDATE_SET");
});

test("createDocumentIrFetchNode: repeated lookups of the same node are byte-identical (cache does not change the result)", async () => {
  const fetchNode = makeFetchNode();
  const first = JSON.stringify(await fetchNode({ documentId: "major_doc1", nodeIndex: 2 }));
  const second = JSON.stringify(await fetchNode({ documentId: "major_doc1", nodeIndex: 2 }));
  assert.equal(first, second);
});

test("createDocumentIrFetchNode: never accepts a Gold value as part of its lookup key (signature has no such parameter)", async () => {
  const fetchNode = makeFetchNode();
  // Calling with extraneous fields (as if a caller tried to pass Gold-derived hints) must not change behavior.
  const result = await fetchNode({ documentId: "major_doc1", nodeIndex: 1, gold: "should be ignored", acceptable_sources: ["x"] });
  assert.equal(result.found, true);
  assert.equal(result.text, "본문 문단");
});
