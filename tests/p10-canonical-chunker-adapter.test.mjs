import test from "node:test";
import assert from "node:assert/strict";
import { adaptCanonicalRecordToChunkerInput, ChunkerInputAdaptError } from "../domain/agent-comparison/chunking-comparison/b-canonical-to-chunker-input.mjs";
import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";

const CANONICAL_RECORD = {
  schema_version: "0.1.0",
  corpus_snapshot_id: "snap_test",
  document_id: "exchange_20230406800008",
  parser: { name: "a-document-ir-adapter", version: "0.1.0" },
  files: [{ file_id: "file_abc", relative_path: "x.xml", detected_format: "HTML", parse_status: "SUCCESS" }],
  blocks: [
    { block_id: "b0", file_id: "file_abc", parent_block_id: null, block_type: "TITLE", ordinal: 0, section_path: [], text: "계약 내역", table: null, metadata: { source_node_id: "n0" } },
    { block_id: "b1", file_id: "file_abc", parent_block_id: "b0", block_type: "PARAGRAPH", ordinal: 1, section_path: ["계약 내역"], text: "계약에 관한 설명입니다.", table: null, metadata: { source_node_id: "n1" } },
    {
      block_id: "b2", file_id: "file_abc", parent_block_id: "b0", block_type: "TABLE", ordinal: 2, section_path: ["계약 내역"], text: null,
      table: { caption: "계약 요약", header_rows: [["항목", "금액"]], body_rows: [["계약금액", "1,000"], ["계약상대", "A사"]], unit_text: "(단위: 백만원)", raw_rows: [["항목", "금액"], ["계약금액", "1,000"], ["계약상대", "A사"]] },
      metadata: { source_node_id: "n2" },
    },
    { block_id: "b3", file_id: "file_abc", parent_block_id: null, block_type: "PAGE_BREAK", ordinal: 3, section_path: [], text: null, table: null, metadata: {} },
  ],
  quality_summary: { source_parser_version: "1.0.0", source_schema_version: "1.0", source_parse_tier: "structured" },
};

const COMPANY = { corpCode: "00126380", corpName: "삼성전자", listedName: "삼성전자" };
const PROVENANCE = { targetCorpusSnapshotId: "corpus_target", parserCodeRevision: "e4a417c280aa0bfb437f8c15c60a36c3b777798d", parserConfigHash: "52b37a07da4cb420cb607183fb2e1f088634eb003b69435748b0670eb366bfe1" };

test("adapter: rejects an unresolved (non 8-digit) corp_code rather than defaulting it", () => {
  assert.throws(() => adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, { corpCode: null }), ChunkerInputAdaptError);
  assert.throws(() => adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, { corpCode: "not-a-code" }), ChunkerInputAdaptError);
});

test("adapter: derives doc_group and receipt_date from document_id, never fabricated", () => {
  const { document } = adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, COMPANY);
  assert.equal(document.doc_group, "exchange");
  assert.equal(document.receipt_date, "2023-04-06");
  assert.equal(document.corp_code, "00126380");
});

test("adapter: PAGE_BREAK blocks are dropped, not miscast into a chunkable node kind", () => {
  const { record } = adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, COMPANY);
  assert.equal(record.nodes.length, 3);
  assert.ok(record.nodes.every((n) => ["section", "paragraph", "table"].includes(n.kind)));
});

test("adapter: table row reconstruction is header-first, cell values unchanged", () => {
  const { record } = adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, COMPANY);
  const tableNode = record.nodes.find((n) => n.kind === "table");
  assert.deepEqual(tableNode.normalized_rows, [["항목", "금액"], ["계약금액", "1,000"], ["계약상대", "A사"]]);
  assert.deepEqual(tableNode.header_row_indices, [0]);
  assert.equal(tableNode.unit_text, "(단위: 백만원)");
});

test("adapted input runs through the real chunker for all 3 P10 strategies without error, and every chunk traces back to a real node", () => {
  const { record, document } = adaptCanonicalRecordToChunkerInput(CANONICAL_RECORD, COMPANY);
  const realNodeIds = new Set(record.nodes.map((n) => n.node_id));
  for (const strategyConfig of P10_STRATEGIES) {
    const chunks = chunkDocument(record, document, strategyConfig, PROVENANCE);
    assert.ok(chunks.length > 0, `${strategyConfig.chunking_config_id} produced zero chunks`);
    for (const chunk of chunks) {
      assert.equal(chunk.metadata.corp_code, "00126380");
      assert.equal(chunk.document_id, "exchange_20230406800008");
      for (const nodeId of chunk.source_node_ids) assert.ok(realNodeIds.has(nodeId), `chunk references unknown node_id ${nodeId}`);
      assert.ok(chunk.raw_text.trim().length > 0, "no empty chunk allowed");
    }
  }
});

test("adapter: throws on a malformed document_id rather than guessing doc_group", () => {
  const bad = { ...CANONICAL_RECORD, document_id: "not-a-real-id" };
  assert.throws(() => adaptCanonicalRecordToChunkerInput(bad, COMPANY), ChunkerInputAdaptError);
});
