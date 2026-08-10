import test from "node:test";
import assert from "node:assert/strict";
import configs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };
import { chunkDocument, tokenizeWithOffsets } from "../domain/chunking/chunker.mjs";

const document = {
  document_id: "exchange_20230406800008",
  corp_code: "00126380",
  doc_group: "exchange",
  doc_subtype: "단일판매공급계약체결",
  report_name: "단일판매ㆍ공급계약체결",
  receipt_date: "2023-04-06",
  base_year: null,
  base_month: null,
  filer_name: "삼성전자",
  is_correction: false,
  manifest_payload: { corp_name: "삼성전자", listed_name: "삼성전자", stock_code: "005930" },
};
const record = {
  corpus_snapshot_id: "snap_source",
  doc_id: document.document_id,
  parser_version: "1.0.0",
  schema_version: "1.0",
  parse_quality: { tier: "structured" },
  warnings: [],
  source_files: [{ rel_path: "x.xml", content_format: "kind_html" }],
  nodes: [
    {
      kind: "section", node_id: "s1", title_text: "계약 내역", section_hierarchy: [],
      source: { rel_path: "x.xml", order_index: 0 },
    },
    {
      kind: "paragraph", node_id: "p1", text: "계약에 관한 설명입니다.", section_hierarchy: ["계약 내역"],
      source: { rel_path: "x.xml", order_index: 1 },
    },
    {
      kind: "table", node_id: "t1", normalized_rows: [["계약금액(원)", "1,000"], ["계약상대", "A사"]],
      section_hierarchy: ["계약 내역"], source: { rel_path: "x.xml", order_index: 2 },
    },
  ],
};
const provenance = {
  targetCorpusSnapshotId: "corpus_target",
  parserCodeRevision: "e4a417c280aa0bfb437f8c15c60a36c3b777798d",
  parserConfigHash: "52b37a07da4cb420cb607183fb2e1f088634eb003b69435748b0670eb366bfe1",
};

test("tokenizer preserves deterministic offsets", () => {
  assert.deepEqual(tokenizeWithOffsets("매출 1,000원").map((token) => token.text), ["매출", "1", ",", "000원"]);
});

test("hierarchical strategy emits linked table parent and row child", () => {
  const config = configs.strategies.find((item) => item.role === "PRIMARY");
  const chunks = chunkDocument(record, document, config, provenance);
  const tableParent = chunks.find((chunk) => chunk.chunk_type === "TABLE_WHOLE");
  const tableRow = chunks.find((chunk) => chunk.chunk_type === "TABLE_ROW");
  assert.ok(tableParent);
  assert.equal(tableRow.parent_chunk_id, tableParent.chunk_id);
  assert.equal(tableRow.source_spans[0].row_start, 0);
  assert.equal(tableRow.source_spans.at(-1).row_end, 1);
  assert.match(tableRow.embed_text, /기업: 삼성전자/);
});

test("fallback chunks are emitted for audit but are not retrieval eligible", () => {
  const config = configs.strategies[0];
  const chunks = chunkDocument({ ...record, parse_quality: { tier: "fallback" } }, document, config, provenance);
  assert.ok(chunks.every((chunk) => chunk.chunk_type === "DOCUMENT_FALLBACK"));
  assert.ok(chunks.every((chunk) => chunk.metadata.retrieval_eligible === false));
});

test("unit-only table rows remain traceable but are not indexed independently", () => {
  const config = configs.strategies.find((item) => item.role === "PRIMARY");
  const unitRecord = {
    ...record,
    nodes: [{
      kind: "table",
      node_id: "table-unit",
      section_hierarchy: ["재무정보"],
      source: { rel_path: "sample.xml", order_index: 1 },
      normalized_rows: [["(단위 : 백만원)"]],
      raw_rows: [[{ text: "(단위 : 백만원)" }]],
      header_row_indices: [],
    }],
  };
  const chunks = chunkDocument(unitRecord, document, config, provenance);
  const row = chunks.find((chunk) => chunk.chunk_type === "TABLE_ROW");
  assert.ok(row);
  assert.equal(row.metadata.auxiliary_table_metadata, true);
  assert.equal(row.metadata.retrieval_eligible, false);
  assert.equal(row.metadata.index_role, "CONTEXT_ONLY");
  assert.ok(row.parent_chunk_id);
});
