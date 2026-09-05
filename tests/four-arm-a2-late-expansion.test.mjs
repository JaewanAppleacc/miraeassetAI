// Turn A2-LATE-EXPANSION: scoped, offline tests for
// domain/agent-comparison/four-arm-ac/{a2-node-grounded-evidence,a2-stable-evidence-filter}.mjs.
// No DB, no KURE server, no BM25/dense/RRF, no Gold, no DEV_TUNE/DEV_CHECK/
// HOLDOUT access, no real fetch_node -- every fetchNode here is a synthetic,
// hand-authored stub over a synthetic provenance/candidate fixture.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildProvenanceSet } from "../domain/agent-comparison/four-arm-ac/locator-provenance.mjs";
import {
  buildNodeGroundedEvidence, NODE_GROUNDED_STATUS, DEFAULT_LIMITS,
} from "../domain/agent-comparison/four-arm-ac/a2-node-grounded-evidence.mjs";
import {
  applyStableEvidenceFilter, VALIDATION_STATUS,
} from "../domain/agent-comparison/four-arm-ac/a2-stable-evidence-filter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const DOC_ID = "periodic_00000000000001";

// ---------- fixtures ----------

function span(nodeIndex, overrides = {}) {
  return {
    file_id: "file_1", rel_path: "file_1.xml", node_id: `node_${nodeIndex}`, order_index: nodeIndex,
    row_start: null, row_end: null, col_start: null, col_end: null,
    source_locator: `${DOC_ID}/file_1.xml#node=${nodeIndex}`,
    ...overrides,
  };
}

function tableSpan(nodeIndex, row, overrides = {}) {
  return span(nodeIndex, {
    row_start: row, row_end: row, col_start: 0, col_end: 2,
    source_locator: `${DOC_ID}/file_1.xml#node=${nodeIndex};row=${row}-${row};col=0-2`,
    ...overrides,
  });
}

function retrievalItemFromSpans(spans, overrides = {}) {
  const provenanceSet = buildProvenanceSet(spans);
  return {
    rank: 1, chunk_id: "chunk_1", doc_id: DOC_ID,
    node_index: provenanceSet.resolved?.node_index ?? null,
    locator: provenanceSet.candidates[0]?.source_locator ?? null,
    row: provenanceSet.resolved?.row ?? null, col: provenanceSet.resolved?.col ?? null,
    provenance: provenanceSet,
    ...overrides,
  };
}

function textNode(nodeIndex, text, { sourceLocator = `${DOC_ID}/file_1.xml#node=${nodeIndex}` } = {}) {
  return { found: true, documentId: DOC_ID, nodeIndex, nodeId: `node_${nodeIndex}`, sourceLocator, isTable: false, row: null, col: null, text, table: null };
}

function tableNode(nodeIndex, { title = null, period = null, unit = null, rowLabels = null, colLabels = null, text = "" } = {}) {
  return {
    found: true, documentId: DOC_ID, nodeIndex, nodeId: `node_${nodeIndex}`,
    sourceLocator: `${DOC_ID}/file_1.xml#node=${nodeIndex}`, isTable: true, row: null, col: null,
    text, table: { title, period, unit, rowLabels, colLabels },
  };
}

function fetchNodeFromMap(nodeMap) {
  return async ({ documentId, nodeIndex }) => {
    const key = `${documentId}#${nodeIndex}`;
    if (!nodeMap.has(key)) return { found: false, documentId, nodeIndex, nodeId: null, sourceLocator: null, isTable: false, row: null, col: null, text: null, table: null };
    return nodeMap.get(key);
  };
}

function withNode(map, node) { map.set(`${node.documentId}#${node.nodeIndex}`, node); return map; }

// ---------- buildNodeGroundedEvidence ----------

test("multi-node candidate: every span's locator is preserved separately", async () => {
  const spans = [span(0), span(1), span(2)];
  const item = retrievalItemFromSpans(spans);
  const nodeMap = new Map();
  withNode(nodeMap, textNode(0, "본문 0"));
  withNode(nodeMap, textNode(1, "본문 1"));
  withNode(nodeMap, textNode(2, "본문 2"));
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });

  assert.equal(evidence.status, NODE_GROUNDED_STATUS.READY);
  assert.deepEqual(evidence.candidateNodeIndices, [0, 1, 2]);
  assert.equal(evidence.locatorCandidates.length, 3);
  const locators = evidence.locatorCandidates.map((l) => l.sourceLocator);
  assert.deepEqual(locators, spans.map((s) => s.source_locator));
  // Every span independently preserved -- not merged into one string.
  assert.equal(new Set(locators).size, 3);
});

test("invalid document/node combination fails closed as UNRESOLVED", async () => {
  const item = retrievalItemFromSpans([span(0)]);
  const fetchNode = async () => ({ found: false, documentId: DOC_ID, nodeIndex: 0, nodeId: null, sourceLocator: null, isTable: false, row: null, col: null, text: null, table: null });
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.UNRESOLVED);
  assert.equal(evidence.unresolvedReason, "NODE_FETCH_FAILED");
  assert.equal(evidence.expandedNodes[0].fetchFailed, true);
});

test("a mismatched documentId/nodeIndex returned by fetchNode is rejected, not trusted", async () => {
  const item = retrievalItemFromSpans([span(0)]);
  // fetchNode claims a DIFFERENT node/document than what was requested.
  const fetchNode = async () => ({ found: true, documentId: "other_doc", nodeIndex: 99, nodeId: "x", sourceLocator: "x", isTable: false, row: null, col: null, text: "should not be trusted", table: null });
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.UNRESOLVED);
  assert.equal(evidence.unresolvedReason, "NODE_FETCH_FAILED");
});

test("max candidate node limit is actually enforced and reported", async () => {
  const spans = Array.from({ length: 12 }, (_, i) => span(i));
  const item = retrievalItemFromSpans(spans);
  const nodeMap = new Map();
  for (let i = 0; i < 12; i += 1) withNode(nodeMap, textNode(i, `본문 ${i}`));
  const evidence = await buildNodeGroundedEvidence({
    retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap), limits: { maxCandidateNodes: 8 },
  });
  assert.equal(evidence.candidateNodeIndices.length, 8);
  assert.deepEqual(evidence.candidateNodeIndices, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(evidence.truncation.candidateNodesTruncated, true);
  assert.equal(evidence.truncation.totalCandidateNodeCount, 12);
  assert.equal(evidence.truncation.includedCandidateNodeCount, 8);
});

test("max single-node char limit truncates plain-text node content without forcing UNRESOLVED", async () => {
  const item = retrievalItemFromSpans([span(0)]);
  const longText = "가".repeat(500);
  const nodeMap = withNode(new Map(), textNode(0, longText));
  const evidence = await buildNodeGroundedEvidence({
    retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap), limits: { maxSingleNodeChars: 100 },
  });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.READY);
  assert.equal(evidence.expandedNodes[0].text.length, 100);
  assert.equal(evidence.expandedNodes[0].truncated, true);
  assert.deepEqual(evidence.truncation.singleNodeTruncatedNodeIndices, [0]);
});

test("max expanded char budget truncates across nodes and is reported", async () => {
  const spans = [span(0), span(1), span(2)];
  const item = retrievalItemFromSpans(spans);
  const nodeMap = new Map();
  withNode(nodeMap, textNode(0, "가".repeat(50)));
  withNode(nodeMap, textNode(1, "나".repeat(50)));
  withNode(nodeMap, textNode(2, "다".repeat(50)));
  const evidence = await buildNodeGroundedEvidence({
    retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap), limits: { maxExpandedChars: 80 },
  });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.READY);
  assert.equal(evidence.truncation.expandedCharsTruncated, true);
  assert.ok(evidence.truncation.totalExpandedChars <= 80);
  // The third node must have been excluded wholesale once the budget ran out.
  assert.equal(evidence.expandedNodes[2].excludedByBudget, true);
});

test("table title/row/col/period/unit context is preserved when it fits within limits", async () => {
  const item = retrievalItemFromSpans([tableSpan(0, 1), tableSpan(0, 2)]);
  const nodeMap = withNode(new Map(), tableNode(0, {
    title: "요약재무제표", period: "2025년 1분기", unit: "백만원",
    rowLabels: ["매출액", "영업이익"], colLabels: ["당기", "전기"],
    text: "매출액 100 90\n영업이익 10 8",
  }));
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.READY);
  assert.equal(evidence.tableContext.length, 1);
  const ctx = evidence.tableContext[0];
  assert.equal(ctx.title, "요약재무제표");
  assert.equal(ctx.period, "2025년 1분기");
  assert.equal(ctx.unit, "백만원");
  assert.deepEqual(ctx.rowLabels, ["매출액", "영업이익"]);
  assert.deepEqual(ctx.colLabels, ["당기", "전기"]);
  // Never fabricated: exactly two distinct row spans preserved for this node.
  assert.equal(evidence.locatorCandidates.length, 2);
});

test("a table node never gets a value it did not carry (no fabrication)", async () => {
  const item = retrievalItemFromSpans([tableSpan(0, 1)]);
  const nodeMap = withNode(new Map(), tableNode(0, { title: "요약재무제표", period: null, unit: null, rowLabels: null, colLabels: null, text: "" }));
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });
  const ctx = evidence.tableContext[0];
  assert.equal(ctx.period, null);
  assert.equal(ctx.unit, null);
  assert.equal(ctx.rowLabels, null);
  assert.equal(ctx.colLabels, null);
});

test("truncation that would cut a required table dimension yields UNRESOLVED, not partial READY", async () => {
  const item = retrievalItemFromSpans([tableSpan(0, 1)]);
  const nodeMap = withNode(new Map(), tableNode(0, {
    title: "매우 긴 표 제목".repeat(20), period: "2025년 1분기", unit: "백만원",
    rowLabels: ["매출액"], colLabels: ["당기"], text: "본문",
  }));
  const evidence = await buildNodeGroundedEvidence({
    retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap), limits: { maxSingleNodeChars: 20 },
  });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.UNRESOLVED);
  assert.equal(evidence.unresolvedReason, "REQUIRED_TABLE_DIMENSION_TRUNCATED");
  assert.equal(evidence.expandedNodes[0].text, null);
});

test("some node fetch failing among several candidates yields overall UNRESOLVED", async () => {
  const item = retrievalItemFromSpans([span(0), span(1)]);
  const nodeMap = withNode(new Map(), textNode(0, "본문 0"));
  // node 1 is deliberately absent from nodeMap -> fetchNodeFromMap returns found:false.
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.UNRESOLVED);
  assert.equal(evidence.unresolvedReason, "NODE_FETCH_FAILED");
  assert.equal(evidence.expandedNodes[0].fetchFailed, undefined);
  assert.equal(evidence.expandedNodes[0].text, "본문 0");
  assert.equal(evidence.expandedNodes[1].fetchFailed, true);
});

test("a chunk with no persisted spans (EMPTY_SPANS_INVALID) is UNRESOLVED without calling fetchNode", async () => {
  const item = retrievalItemFromSpans([]);
  let called = false;
  const fetchNode = async () => { called = true; return { found: false }; };
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.UNRESOLVED);
  assert.equal(evidence.unresolvedReason, "NO_SOURCE_SPANS_PERSISTED");
  assert.equal(called, false);
});

test("node_index/node_indices fallback works when provenance is absent entirely", async () => {
  const item = { rank: 1, chunk_id: "chunk_x", doc_id: DOC_ID, node_index: 3, node_indices: [3, 4] };
  const nodeMap = new Map();
  withNode(nodeMap, textNode(3, "본문 3"));
  withNode(nodeMap, textNode(4, "본문 4"));
  const evidence = await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });
  assert.equal(evidence.status, NODE_GROUNDED_STATUS.READY);
  assert.deepEqual(evidence.candidateNodeIndices, [3, 4]);
});

test("buildNodeGroundedEvidence never mutates its retrievalItem input", async () => {
  const item = retrievalItemFromSpans([span(0), span(1)]);
  const before = JSON.parse(JSON.stringify(item));
  const nodeMap = new Map();
  withNode(nodeMap, textNode(0, "본문 0"));
  withNode(nodeMap, textNode(1, "본문 1"));
  await buildNodeGroundedEvidence({ retrievalItem: item, fetchNode: fetchNodeFromMap(nodeMap) });
  assert.deepEqual(JSON.parse(JSON.stringify(item)), before);
});

test("default limits match the pre-fixed contract (8 / 12000 / 6000)", () => {
  assert.equal(DEFAULT_LIMITS.maxCandidateNodes, 8);
  assert.equal(DEFAULT_LIMITS.maxExpandedChars, 12000);
  assert.equal(DEFAULT_LIMITS.maxSingleNodeChars, 6000);
});

// ---------- applyStableEvidenceFilter ----------

function frozenTop20Fixture(n = 5) {
  return Array.from({ length: n }, (_, i) => Object.freeze({ rank: i + 1, chunk_id: `chunk_${i + 1}`, doc_id: DOC_ID, score: 1 - i * 0.01 }));
}

test("PASS is accepted in existing rank order", () => {
  const top = frozenTop20Fixture(5);
  const validationResults = top.map((item) => ({ chunkId: item.chunk_id, status: VALIDATION_STATUS.PASS }));
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 3 });
  assert.deepEqual(result.finalTopK.map((i) => i.chunk_id), ["chunk_1", "chunk_2", "chunk_3"]);
  assert.equal(result.accepted.length, 5);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.finalTopKShortfall, 0);
});

test("REJECT is removed and refilled by the next existing-rank candidate", () => {
  const top = frozenTop20Fixture(5);
  const validationResults = [
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.REJECT, reason: "SCOPE_MISMATCH" },
    { chunkId: "chunk_3", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_4", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_5", status: VALIDATION_STATUS.PASS },
  ];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 3 });
  assert.deepEqual(result.finalTopK.map((i) => i.chunk_id), ["chunk_1", "chunk_3", "chunk_4"]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].chunk_id, "chunk_2");
});

test("UNRESOLVED is excluded from finalTopK and recorded separately, not adopted", () => {
  const top = frozenTop20Fixture(4);
  const validationResults = [
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.UNRESOLVED, reason: "NODE_FETCH_FAILED" },
    { chunkId: "chunk_3", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_4", status: VALIDATION_STATUS.PASS },
  ];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 3 });
  assert.deepEqual(result.finalTopK.map((i) => i.chunk_id), ["chunk_1", "chunk_3", "chunk_4"]);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].chunk_id, "chunk_2");
});

test("a missing validation entry defaults to UNRESOLVED, not silently PASS", () => {
  const top = frozenTop20Fixture(2);
  const validationResults = [{ chunkId: "chunk_1", status: VALIDATION_STATUS.PASS }];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 2 });
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].chunk_id, "chunk_2");
  assert.equal(result.refillTrace[1].reason, "NO_VALIDATION_RESULT");
});

test("when finalK cannot be filled, the shortfall is reported, not silently padded", () => {
  const top = frozenTop20Fixture(3);
  const validationResults = [
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.REJECT },
    { chunkId: "chunk_3", status: VALIDATION_STATUS.UNRESOLVED },
  ];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 10 });
  assert.equal(result.finalTopK.length, 1);
  assert.equal(result.finalTopKShortfall, 9);
});

test("a validationResults entry for a chunk outside frozenTop20 can never enter finalTopK", () => {
  const top = frozenTop20Fixture(2);
  const validationResults = [
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_999_outside_top20", status: VALIDATION_STATUS.PASS },
  ];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 10 });
  const allChunkIds = [...result.accepted, ...result.finalTopK].map((i) => i.chunk_id);
  assert.ok(!allChunkIds.includes("chunk_999_outside_top20"));
  assert.equal(result.finalTopK.length, 2);
});

test("existing rank order is never changed, even when validationResults is supplied out of order", () => {
  const top = frozenTop20Fixture(4);
  const validationResults = [
    { chunkId: "chunk_4", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_3", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.PASS },
  ];
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 4 });
  assert.deepEqual(result.finalTopK.map((i) => i.chunk_id), ["chunk_1", "chunk_2", "chunk_3", "chunk_4"]);
});

test("applyStableEvidenceFilter never mutates frozenTop20 or its items", () => {
  const top = frozenTop20Fixture(3);
  const before = JSON.parse(JSON.stringify(top));
  const validationResults = [
    { chunkId: "chunk_1", status: VALIDATION_STATUS.PASS },
    { chunkId: "chunk_2", status: VALIDATION_STATUS.REJECT },
    { chunkId: "chunk_3", status: VALIDATION_STATUS.PASS },
  ];
  applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(top)), before);
});

test("applyStableEvidenceFilter never invents a new score field on any item", () => {
  const top = frozenTop20Fixture(2);
  const validationResults = top.map((item) => ({ chunkId: item.chunk_id, status: VALIDATION_STATUS.PASS }));
  const result = applyStableEvidenceFilter({ frozenTop20: top, validationResults, finalK: 2 });
  for (const item of result.finalTopK) assert.equal(item, top.find((t) => t.chunk_id === item.chunk_id));
});

// ---------- structural guarantees (no KURE/BM25/dense/RRF path, no leaks) ----------

const SOURCE_FILES = [
  "domain/agent-comparison/four-arm-ac/a2-node-grounded-evidence.mjs",
  "domain/agent-comparison/four-arm-ac/a2-stable-evidence-filter.mjs",
];

function stripLineComments(text) {
  return text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

test("neither module imports or calls BM25/dense/RRF/embedding search paths", () => {
  const forbidden = [
    "bm25Search", "reciprocalRankFusion", "embedQuery", "searchDocumentChunksByVector",
    "createFixedKureHybridRetrieverAdapter", "vectorRepository", "KURE_PIN",
  ];
  for (const relPath of SOURCE_FILES) {
    const text = stripLineComments(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${relPath} must not reference ${token} in executable code`);
    }
  }
});

test("neither module performs any DB/network/filesystem mutation", () => {
  const forbidden = ["client.query", "INSERT INTO", "UPDATE ", "DELETE FROM", "writeFileSync", "fetch(", "http.request"];
  for (const relPath of SOURCE_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    for (const token of forbidden) {
      assert.ok(!text.includes(token), `${relPath} must not reference ${token}`);
    }
  }
});

test("neither module hardcodes a packet/question/company/value literal", () => {
  // Real packet IDs in this repo look like u-<12 hex chars>; real corp codes
  // are 8-digit codes distinct from this test file's own synthetic fixture
  // constants. Scan the SOURCE modules only (not this test file).
  const packetIdPattern = /u-[0-9a-f]{12}/;
  for (const relPath of SOURCE_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    assert.ok(!packetIdPattern.test(text), `${relPath} must not hardcode a packet id`);
    assert.ok(!/corp_code\s*[:=]\s*"\d{8}"/.test(text), `${relPath} must not hardcode a corp code`);
  }
});
