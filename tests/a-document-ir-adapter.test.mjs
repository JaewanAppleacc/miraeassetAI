import test from "node:test";
import assert from "node:assert/strict";
import { adaptADocumentIR, mapCoverageState } from "../domain/adapters/a-document-ir.mjs";

const source = {
  corpus_snapshot_id: "snap_test",
  doc_id: "exchange_20250728800035",
  parser_version: "1.0.0",
  schema_version: "1.0",
  source_files: [{
    rel_path: "20250728800035.xml",
    is_attachment: false,
    content_format: "kind_html",
    schema_version: null,
    content_sha256: "a".repeat(64),
    declared_encoding: "euc-kr",
    actual_encoding_used: "utf-8",
  }],
  parse_quality: { tier: "structured" },
  warnings: [{
    rel_path: "20250728800035.xml",
    code: "encoding_declaration_mismatch",
    severity: "warning",
  }],
  nodes: [
    {
      kind: "section",
      node_id: "section-1",
      title_text: "계약 내역",
      parent_section_id: "ROOT",
      level: 1,
      level_confident: true,
      section_hierarchy: [],
      source: { rel_path: "20250728800035.xml", order_index: 0, byte_offset: null },
    },
    {
      kind: "table",
      node_id: "table-1",
      section_hierarchy: ["계약 내역"],
      source: { rel_path: "20250728800035.xml", order_index: 1, byte_offset: null },
      normalized_rows: [["계약금액(원)", "100"]],
      raw_rows: [[{ text: "계약금액(원)" }, { text: "100" }]],
      header_row_indices: [],
      unit_text: "원",
    },
  ],
};

test("maps A DocumentIR without changing source semantics", () => {
  const adapted = adaptADocumentIR(source, {
    completedAt: "2026-08-04T00:00:00.000Z",
    targetCorpusSnapshotId: "corpus_target",
  });
  assert.equal(adapted.document_id, source.doc_id);
  assert.equal(adapted.corpus_snapshot_id, "corpus_target");
  assert.equal(adapted.quality_summary.source_corpus_snapshot_id, "snap_test");
  assert.equal(adapted.files[0].detected_format, "HTML");
  assert.equal(adapted.files[0].file_role, "MAIN");
  assert.equal(adapted.blocks[1].parent_block_id, "section-1");
  assert.equal(adapted.blocks[1].table.body_rows[0][1], "100");
  assert.equal(adapted.blocks[1].table.raw_rows[0][1].text, "100");
  assert.equal(adapted.quality_summary.coverage_reason_code, "PARSE_SUCCESS");
});

test("maps fallback to a partial parse failure without erasing its text", () => {
  const fallback = { ...source, parse_quality: { tier: "fallback" } };
  assert.deepEqual(mapCoverageState(fallback), {
    state: "PARTIAL_PARSE_FAILURE",
    reason_code: "FALLBACK_TEXT_ONLY",
  });
});

test("maps a zero-block parser failure to PARSE_FAILED", () => {
  const failed = {
    ...source,
    parse_quality: { tier: "partial" },
    nodes: [],
    warnings: [{ rel_path: "20250728800035.xml", code: "parse_failed", severity: "error" }],
  };
  assert.deepEqual(mapCoverageState(failed), {
    state: "PARSE_FAILED",
    reason_code: "PARSE_FAILED_NO_BLOCKS",
  });
});

test("maps empty PDF viewer documents to a specific terminal parse failure", () => {
  const failed = {
    ...source,
    parse_quality: { tier: "partial" },
    source_files: [
      {
        rel_path: "20260619000667.pdf",
        is_attachment: false,
        content_format: "pdf",
        content_sha256: "b".repeat(64),
      },
      {
        rel_path: "20260619000667_viewer.html",
        is_attachment: false,
        content_format: "kind_html",
        content_sha256: "c".repeat(64),
      },
    ],
    nodes: [],
    warnings: [{
      rel_path: "20260619000667_viewer.html",
      code: "parse_failed",
      severity: "warning",
      message: "no <table> found in KIND HTML document",
    }],
  };
  assert.deepEqual(mapCoverageState(failed), {
    state: "PARSE_FAILED",
    reason_code: "PDF_VIEWER_EMPTY_NO_TABLES",
  });
  const adapted = adaptADocumentIR(failed, { completedAt: "2026-08-04T00:00:00.000Z" });
  assert.equal(adapted.files[0].file_role, "PDF_FALLBACK");
  assert.equal(adapted.files[0].text_loss_suspected, true);
  assert.equal(adapted.files[1].file_role, "VIEWER_HTML");
  assert.equal(adapted.files[1].parse_status, "FAILED");
});
