// Turn P10.4-R / Section C: the exact 4 PARSE_RECOVERY_REQUIRED table
// sources confirmed by P10.3.2's parse-limited-source-disposition.v0.1.json
// (work/p10.3.2-table-full-population-audit/), pinned by document_id +
// node_id -- NOT a heuristic column-count pattern applied corpus-wide.
//
// P10.3.2's disposition file records the 4 unresolvable sources only by
// shape (irregular actual_col_counts, NODE_ONLY_COLON locator scheme,
// n_rows/n_declared_cols), not by document/node id. Cross-referenced here
// against corrected-table-item-inventory.v0.2.json's 4 per-item entries
// with unresolvable_source_count: 1 and the real Gold JSONL
// (domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl),
// question_ids author_2b919170b3f420b30f592dbf, author_39b7a1a229844d5607de32fb,
// author_558c9267989c17f3e0aa14ad, author_f115e4cb0e6b913c663df555 -- each
// has exactly one acceptable_source, and each source_locator IS the raw
// A-parser node_id verbatim (table-evidence-resolver.mjs's findNodeById
// convention: node.node_id === "docId::relPath::nodeId"). All 4 are the
// same "1. 판매·공급계약 구분" contract-disclosure table shape: a
// hierarchical key-value layout (declared 4 cols) where one nested
// sub-item row breaks uniform column count -- confirmed
// table_aware_chunk_applicable: false, row_column_recoverable_without_
// parser_fix: false by P10.3.2.
export const PARSE_LIMITED_TABLE_SOURCES = Object.freeze([
  {
    document_id: "exchange_20230914800073",
    node_id: "exchange_20230914800073::20230914800073.xml::n0",
    reason: "irregular hierarchical key-value table shape, confirmed PARSE_RECOVERY_REQUIRED by P10.3.2 (actual_col_counts distinct=2, n_declared_cols=4, n_rows=18)",
  },
  {
    document_id: "exchange_20241112800101",
    node_id: "exchange_20241112800101::20241112800101.xml::n0",
    reason: "irregular hierarchical key-value table shape, confirmed PARSE_RECOVERY_REQUIRED by P10.3.2 (actual_col_counts distinct=2, n_declared_cols=4, n_rows=18)",
  },
  {
    document_id: "exchange_20230926800443",
    node_id: "exchange_20230926800443::20230926800443.xml::n0",
    reason: "irregular hierarchical key-value table shape, confirmed PARSE_RECOVERY_REQUIRED by P10.3.2 (actual_col_counts distinct=3, n_declared_cols=4, n_rows=16)",
  },
  {
    document_id: "exchange_20230918800156",
    node_id: "exchange_20230918800156::20230918800156.xml::n0",
    reason: "irregular hierarchical key-value table shape, confirmed PARSE_RECOVERY_REQUIRED by P10.3.2 (actual_col_counts distinct=2, n_declared_cols=4, n_rows=18)",
  },
]);

export const PARSE_LIMITED_TABLE_NODE_IDS = new Set(PARSE_LIMITED_TABLE_SOURCES.map((s) => s.node_id));
