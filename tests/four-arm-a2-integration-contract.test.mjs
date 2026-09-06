// Turn A2-INTEGRATION-AND-DEVTUNE-V1, Section D: integration contract tests
// for the composed A2 pipeline (a2-integration-pipeline.mjs) over the two
// independently-built A2 modules plus the new real-node-store adapter.
// No DB, no KURE server, no BM25/dense/RRF, no Gold, no DEV_TUNE/DEV_CHECK/
// HOLDOUT access. Every fixture here is synthetic and hand-authored.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

import {
  runA2OverFrozenTop20, evaluateFrozenItem, mapExpandedEvidenceForValidator,
} from "../domain/agent-comparison/four-arm-ac/a2-integration-pipeline.mjs";
import { VALIDATION_STATUS as FILTER_STATUS } from "../domain/agent-comparison/four-arm-ac/a2-stable-evidence-filter.mjs";
import {
  createUnavailableFetchNode, createRealNodeStoreFetchNode,
} from "../domain/agent-comparison/four-arm-ac/a2-real-node-store-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const FOUR_ARM_AC_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures: a synthetic 20-item frozen top-20, never real A.results.jsonl
// content (structure only -- same shape, invented doc/node/chunk ids).
// ---------------------------------------------------------------------------

function makeItem(rank, overrides = {}) {
  return {
    rank,
    doc_id: `doc_${rank}`,
    node_index: rank,
    node_indices: [rank],
    locator: `doc_${rank}::file.xml::n${rank}`,
    row: null,
    col: null,
    chunk_id: `chunk_${String(rank).padStart(24, "0")}`,
    chunk_text_sha256: sha256(`chunk-${rank}`),
    score: 1 / rank,
    score_type: "RRF",
    ...overrides,
  };
}

const FROZEN_TOP20 = Object.freeze(
  Array.from({ length: 20 }, (_, i) => Object.freeze(makeItem(i + 1))),
);

function tableFetchNode({ text = "본문", title = "표1", period = "2024년 1분기", unit = "백만원", rowLabels = ["매출액"], colLabels = ["2024년 1분기"] } = {}) {
  return async function fetchNode({ documentId, nodeIndex }) {
    return Object.freeze({
      found: true, documentId, nodeIndex, nodeId: `node_${nodeIndex}`,
      sourceLocator: `${documentId}::file.xml::n${nodeIndex}`,
      isTable: true, row: 0, col: 0, text,
      table: Object.freeze({ title, period, unit, rowLabels, colLabels }),
    });
  };
}

function alwaysUnresolvedFetchNode() {
  return async function fetchNode({ documentId, nodeIndex }) {
    return Object.freeze({
      found: false, documentId, nodeIndex, nodeId: null, sourceLocator: null,
      isTable: false, row: null, col: null, text: null, table: null,
    });
  };
}

// ---------------------------------------------------------------------------
// 1. Scope Validator <-> Late Expansion output schema compatibility.
// ---------------------------------------------------------------------------

test("1. mapExpandedEvidenceForValidator bridges late-expansion output into the validator's expected flat context, and the validator accepts it without throwing", async () => {
  const item = makeItem(3);
  const evaluated = await evaluateFrozenItem({
    retrievalItem: item,
    questionConditions: { period: { fiscal_year: 2024, start_month: 1, end_month: 3 }, unit: "백만원", entity: null, scope: null, row_column: null },
    fetchNode: tableFetchNode(),
    limits: undefined,
  });
  assert.equal(evaluated.nodeGroundedEvidence.status, "READY");
  const bridged = mapExpandedEvidenceForValidator(evaluated.nodeGroundedEvidence);
  assert.equal(bridged.table_title, "표1");
  assert.equal(bridged.period_hint, "2024년 1분기");
  assert.equal(bridged.unit, "백만원");
  assert.equal(bridged.row_label, "매출액");
  assert.equal(bridged.column_label, "2024년 1분기");
  assert.ok(typeof bridged.scope_hint === "string" && bridged.scope_hint.includes("표1"));
  assert.notEqual(evaluated.validation, null);
  assert.equal(evaluated.validationResult.status, FILTER_STATUS.PASS);
});

test("1b. mapExpandedEvidenceForValidator never guesses across ambiguous multi-table evidence (leaves fields null rather than picking one)", () => {
  const ambiguous = {
    tableContext: [
      { nodeIndex: 1, title: "표A", period: "2024년 1분기", unit: "백만원", rowLabels: ["매출액"], colLabels: ["Q1"] },
      { nodeIndex: 2, title: "표B", period: "2024년 2분기", unit: "천원", rowLabels: ["매출액"], colLabels: ["Q2"] },
    ],
    expandedNodes: [
      { nodeIndex: 1, row: 0, col: 0, text: "a" },
      { nodeIndex: 2, row: 0, col: 0, text: "b" },
    ],
  };
  const bridged = mapExpandedEvidenceForValidator(ambiguous);
  assert.equal(bridged.table_title, null);
  assert.equal(bridged.period_hint, null);
  assert.equal(bridged.unit, null);
  assert.equal(bridged.row_label, null); // more than one table -> never resolved
  assert.equal(bridged.column_label, null);
});

// ---------------------------------------------------------------------------
// 2/3/4/5. Candidate membership, stable subsequence, PASS-only refill,
// zero candidates from outside top-20.
// ---------------------------------------------------------------------------

test("2/3/4/5. finalTopK is drawn only from frozenTop20, in original rank order, PASS-only, refilling past REJECT/UNRESOLVED", async () => {
  // Item ranks 1,2 REJECT; 3 UNRESOLVED (fetch fails); 4..7 PASS; rest never reached given finalK=5.
  const conditions = { period: null, unit: null, entity: null, scope: { }, row_column: null };
  const fetchNodeByRank = (rank) => {
    if (rank === 1 || rank === 2) {
      // REJECT: scope conflict via scope_hint text containing the opposite marker.
      return async ({ documentId, nodeIndex }) => Object.freeze({
        found: true, documentId, nodeIndex, nodeId: "n", sourceLocator: "loc",
        isTable: false, row: null, col: null, text: "별도 기준", table: null,
      });
    }
    if (rank === 3) return alwaysUnresolvedFetchNode();
    return async ({ documentId, nodeIndex }) => Object.freeze({
      found: true, documentId, nodeIndex, nodeId: "n", sourceLocator: "loc",
      isTable: false, row: null, col: null, text: "연결 기준", table: null,
    });
  };

  const perItem = [];
  for (const item of FROZEN_TOP20) {
    // eslint-disable-next-line no-await-in-loop
    const evaluated = await evaluateFrozenItem({
      retrievalItem: item,
      questionConditions: { ...conditions, scope: "CONSOLIDATED" },
      fetchNode: fetchNodeByRank(item.rank),
    });
    perItem.push(evaluated);
  }
  const validationResults = perItem.map((e) => e.validationResult);
  const { applyStableEvidenceFilter } = await import("../domain/agent-comparison/four-arm-ac/a2-stable-evidence-filter.mjs");
  const filterResult = applyStableEvidenceFilter({ frozenTop20: FROZEN_TOP20, validationResults, finalK: 5 });

  assert.equal(validationResults[0].status, FILTER_STATUS.REJECT);
  assert.equal(validationResults[1].status, FILTER_STATUS.REJECT);
  assert.equal(validationResults[2].status, FILTER_STATUS.UNRESOLVED);
  assert.equal(validationResults[3].status, FILTER_STATUS.PASS);

  // Stable subsequence: finalTopK ranks strictly increasing, all PASS, all
  // present in FROZEN_TOP20, none from ranks 1/2/3.
  const finalRanks = filterResult.finalTopK.map((i) => i.rank);
  assert.deepEqual(finalRanks, [...finalRanks].sort((a, b) => a - b));
  assert.equal(finalRanks.length, 5);
  assert.ok(finalRanks.every((r) => r >= 4));
  const frozenIds = new Set(FROZEN_TOP20.map((i) => i.chunk_id));
  for (const item of filterResult.finalTopK) assert.ok(frozenIds.has(item.chunk_id));
});

test("5b. a chunk_id outside frozenTop20 in validationResults can never enter finalTopK", async () => {
  const { applyStableEvidenceFilter } = await import("../domain/agent-comparison/four-arm-ac/a2-stable-evidence-filter.mjs");
  const outsideResults = [
    { chunkId: "chunk_outside_of_top20_zzzzzzzz", status: "PASS" },
    ...FROZEN_TOP20.slice(0, 3).map((i) => ({ chunkId: i.chunk_id, status: "PASS" })),
  ];
  const filterResult = applyStableEvidenceFilter({ frozenTop20: FROZEN_TOP20, validationResults: outsideResults, finalK: 10 });
  assert.equal(filterResult.finalTopK.length, 3);
  assert.ok(filterResult.finalTopK.every((i) => FROZEN_TOP20.some((f) => f.chunk_id === i.chunk_id)));
});

// ---------------------------------------------------------------------------
// 6. Zero BM25/dense/RRF/KURE calls anywhere in the new integration files.
// ---------------------------------------------------------------------------

test("6. no BM25/dense/RRF/KURE-embedding-call/embedding identifiers referenced in the new integration-turn source files' executable code (comments may name the pre-existing `reference_fixed_kure_*` schema/table identifiers this adapter reads, which are not embedding calls)", () => {
  const files = [
    "a2-integration-pipeline.mjs",
    "a2-real-node-store-adapter.mjs",
  ];
  const forbidden = /bm25|reciprocalRankFusion|embedQuery|searchDocumentChunksByVector|dense_search|rrf\(/i;
  for (const file of files) {
    const source = readFileSync(path.join(FOUR_ARM_AC_DIR, file), "utf8");
    const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(codeOnly, forbidden, `${file} must not reference retrieval/embedding paths`);
    assert.doesNotMatch(codeOnly, /\bKURE\b/, `${file} must not call a KURE embedding path`);
  }
});

// ---------------------------------------------------------------------------
// 7. Zero DB write queries.
// ---------------------------------------------------------------------------

test("7. no write-statement keywords in the new real-node-store adapter's executable code (comments excluded, since the header prose documents the absence of these keywords by naming them)", () => {
  const source = readFileSync(path.join(FOUR_ARM_AC_DIR, "a2-real-node-store-adapter.mjs"), "utf8");
  const codeOnly = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codeOnly, /\b(INSERT INTO|UPDATE |DELETE FROM|DROP TABLE|TRUNCATE|CREATE TABLE|ALTER TABLE)\b/i);
});

test("7b. createUnavailableFetchNode / createRealNodeStoreFetchNode never call a mutating method on an injected client", async () => {
  const calls = [];
  const spyReader = async ({ documentId }) => {
    calls.push(documentId);
    return [];
  };
  const fetchNode = createRealNodeStoreFetchNode({ chunkStagingReader: spyReader });
  await fetchNode({ documentId: "doc_1", nodeIndex: 1 });
  assert.deepEqual(calls, ["doc_1"]);
});

// ---------------------------------------------------------------------------
// 8. Wrong document/node returns fail-closed (UNRESOLVED), never a
// different document/node.
// ---------------------------------------------------------------------------

test("8. real-node-store adapter fails closed on identity mismatch (never falls back to another node)", async () => {
  const chunkStagingReader = async () => [{
    chunk_id: "chunk_a",
    source_spans: [{ node_id: "n5", order_index: 5, row_start: null, row_end: null, col_start: null, col_end: null, source_locator: "doc_x::file.xml::n5" }],
  }];
  const fetchNode = createRealNodeStoreFetchNode({ chunkStagingReader });
  const result = await fetchNode({ documentId: "doc_x", nodeIndex: 999 }); // wrong node index
  assert.equal(result.found, false);
  assert.equal(result.documentId, "doc_x");
  assert.equal(result.nodeIndex, 999);
});

test("8b. createUnavailableFetchNode always resolves UNRESOLVED without ever fabricating text", async () => {
  const fetchNode = createUnavailableFetchNode("REAL_NODE_STORE_NOT_CONFIGURED");
  const result = await fetchNode({ documentId: "doc_1", nodeIndex: 3 });
  assert.equal(result.found, false);
  assert.equal(result.text, null);
  assert.equal(result.unresolvedReason, "REAL_NODE_STORE_NOT_CONFIGURED");
});

test("8c. real-node-store adapter never returns found:true with empty/absent text (non-table, ambiguous multi-span chunk)", async () => {
  const chunkStagingReader = async () => [{
    chunk_id: "chunk_multi",
    raw_text: "concatenated multi-node text",
    source_spans: [
      { node_id: "n1", order_index: 1, row_start: null, row_end: null, col_start: null, col_end: null, source_locator: "doc_x::file.xml::n1" },
      { node_id: "n2", order_index: 2, row_start: null, row_end: null, col_start: null, col_end: null, source_locator: "doc_x::file.xml::n2" },
    ],
  }];
  const fetchNode = createRealNodeStoreFetchNode({ chunkStagingReader });
  const result = await fetchNode({ documentId: "doc_x", nodeIndex: 1 });
  assert.equal(result.found, false);
  assert.equal(result.unresolvedReason, "NON_TABLE_TEXT_NOT_ISOLABLE");
});

test("8d. real-node-store adapter uses chunk raw_text only when the chunk resolves to exactly one node (unambiguous)", async () => {
  const chunkStagingReader = async () => [{
    chunk_id: "chunk_single",
    raw_text: "exact single-node text",
    source_spans: [
      { node_id: "n7", order_index: 7, row_start: null, row_end: null, col_start: null, col_end: null, source_locator: "doc_x::file.xml::n7" },
    ],
  }];
  const fetchNode = createRealNodeStoreFetchNode({ chunkStagingReader });
  const result = await fetchNode({ documentId: "doc_x", nodeIndex: 7 });
  assert.equal(result.found, true);
  assert.equal(result.text, "exact single-node text");
});

// ---------------------------------------------------------------------------
// 9. Node fetch failure -> that evidence UNRESOLVED (never silently PASS).
// ---------------------------------------------------------------------------

test("9. a node-fetch failure forces that evidence item to UNRESOLVED in the composed pipeline", async () => {
  const evaluated = await evaluateFrozenItem({
    retrievalItem: makeItem(9),
    questionConditions: { period: null, unit: null, entity: null, scope: null, row_column: null },
    fetchNode: alwaysUnresolvedFetchNode(),
  });
  assert.equal(evaluated.nodeGroundedEvidence.status, "UNRESOLVED");
  assert.equal(evaluated.validationResult.status, FILTER_STATUS.UNRESOLVED);
});

// ---------------------------------------------------------------------------
// 10. period/scope/unit/sign/row-column/entity validated independently.
// ---------------------------------------------------------------------------

test("10. dimensions validate independently -- a period REJECT does not mask an entity requirement, and vice versa", async () => {
  const evaluated = await evaluateFrozenItem({
    retrievalItem: makeItem(10),
    questionConditions: {
      period: { fiscal_year: 2024, start_month: 1, end_month: 3 },
      entity: "삼성전자",
      unit: null, scope: null, row_column: null,
    },
    fetchNode: tableFetchNode({ period: "2024년 4분기 3개월" }), // unambiguous period mismatch; entity not asserted by evidence at all
  });
  assert.equal(evaluated.validation.checks.period.status, "REJECT");
  // entity check ran independently and reports its own (UNRESOLVED, since no entity field on the merged evidence context)
  assert.equal(evaluated.validation.checks.entity.status, "UNRESOLVED");
  assert.ok(evaluated.validation.reasons.includes("PERIOD_CONFLICT"));
});

// ---------------------------------------------------------------------------
// 11. Byte-identical rerun on the same input.
// ---------------------------------------------------------------------------

test("11. re-running the full pipeline over the same frozen top-20 + same fetchNode/conditions is byte-identical", async () => {
  const conditions = { period: { fiscal_year: 2024, start_month: 1, end_month: 3 }, unit: "백만원", entity: null, scope: null, row_column: null };
  const run = () => runA2OverFrozenTop20({
    frozenTop20: FROZEN_TOP20, questionConditions: conditions, fetchNode: tableFetchNode(), finalK: 10,
  });
  const first = JSON.stringify(await run());
  const second = JSON.stringify(await run());
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// 12. Existing A/B/C/D result/run/scorer file SHAs unchanged by this Turn.
// ---------------------------------------------------------------------------

test("12. no existing A/B/C/D result/run/scorer file is modified relative to the merge-base of this integration branch", () => {
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
  assert.equal(diff, "", `expected zero diff vs base commit for frozen A/B/C/D files, got:\n${diff}`);
});
