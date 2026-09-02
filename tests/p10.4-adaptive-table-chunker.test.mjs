import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { chunkAdaptive, hasIrregularColumnCounts } from "../domain/chunking/adaptive-table-chunker.mjs";
import { chunkFixed } from "../domain/chunking/chunker.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { CONTEXT_STATE, ADAPTIVE_CHUNK_TYPE, TABLE_ROW_CHILD_MAX_TOKENS } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { PARSE_LIMITED_TABLE_SOURCES, PARSE_LIMITED_TABLE_NODE_IDS } from "../domain/chunking/adaptive-parse-limited-sources.v0.1.mjs";
import strategyConfigsModule from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const FIXED_CONFIG = strategyConfigsModule.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
const ADAPTIVE_CONFIG = { chunking_config_id: "adaptive-fixed512-table-aware-v0.1.0", strategy_name: "adaptive-table-aware", strategy_version: "0.1.0", max_tokens: 512, overlap_tokens: 64, table_row_child_max_tokens: 512 };
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });

let cacheLines;
try {
  cacheLines = readFileSync(RAW_CACHE_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch {
  cacheLines = null;
}

function syntheticRecord({ docId = "doc1", relPath = "f.xml", rows = [["항목", "전기", "당기"], ["매출액", "100", "200"]], headerRowIndices = [0], titleConfirmed = false, caption = null, sectionTitle = null, actualColCounts = null } = {}) {
  const nodes = [];
  let orderIndex = 0;
  if (sectionTitle) {
    nodes.push({ node_id: `${docId}::${relPath}::sec0`, kind: "section", title_text: sectionTitle, section_hierarchy: [], source: { rel_path: relPath, order_index: orderIndex } });
    orderIndex += 1;
  }
  nodes.push({
    // A real parser populates section_hierarchy directly on EVERY node
    // (including tables), not just on section nodes -- chunker.mjs's
    // sourceSegments() derives a non-section node's sectionPath from ITS
    // OWN section_hierarchy field, never from document-order lookback
    // (verified against real corpus data: e.g. holding_20230330001204's
    // table node n5 carries section_hierarchy directly). A test fixture
    // that only sets section_hierarchy on the SECTION node (not the
    // table) under-represents this and was caught by this suite.
    node_id: `${docId}::${relPath}::n${orderIndex}`, kind: "table", source: { rel_path: relPath, order_index: orderIndex },
    normalized_rows: rows, header_row_indices: headerRowIndices, normalized_title_guess: caption, title_confirmed: titleConfirmed,
    n_declared_cols: rows[0]?.length ?? 0, actual_col_counts: actualColCounts ?? rows.map((r) => r.length),
    section_hierarchy: sectionTitle ? [sectionTitle] : [],
  });
  return { doc_id: docId, corpus_snapshot_id: "corpus_test", parser_version: "test", schema_version: "0.1.0", parse_quality: { tier: "structured" }, warnings: [], source_files: [{ content_format: "xml" }], nodes };
}
function syntheticDocument(docId = "doc1") {
  return { document_id: docId, corp_code: "00000000", doc_group: "exchange", doc_subtype: "test", report_name: "test", receipt_date: "2024-01-01", base_year: null, base_month: null, is_correction: false, manifest_payload: {}, filer_name: "test" };
}

test("table child context preservation: row_header/column_header/unit/table_title are populated (and printed) when explicitly present in source; section_title is populated in metadata but NOT printed into row-level text (Turn P10.4-R / Section H: deferred to TABLE_PARENT_CONTEXT + late expansion, real cost overhead with no hard-gated preservation requirement)", () => {
  const record = syntheticRecord({ titleConfirmed: true, caption: "재무상태표", sectionTitle: "재무제표" });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunk = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.ok(rowChunk, "expected a row chunk for the value row");
  assert.equal(rowChunk.metadata.context_states.row_header, CONTEXT_STATE.EXPLICIT_IN_SOURCE);
  assert.equal(rowChunk.metadata.context_states.column_header, CONTEXT_STATE.EXPLICIT_IN_SOURCE);
  assert.equal(rowChunk.metadata.context_states.table_title, CONTEXT_STATE.EXPLICIT_IN_SOURCE);
  assert.equal(rowChunk.metadata.context_states.section_title, CONTEXT_STATE.EXPLICIT_IN_SOURCE, "ground truth is still correctly tracked in metadata even though not printed");
  assert.match(rowChunk.raw_text, /표제목: 재무상태표/);
  assert.doesNotMatch(rowChunk.raw_text, /섹션:/, "section breadcrumb is deliberately never printed into row-level chunk text -- available via TABLE_PARENT_CONTEXT + late expansion instead");

  const parentChunk = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_PARENT_CONTEXT);
  assert.ok(parentChunk, "expected a TABLE_PARENT_CONTEXT chunk");
  assert.match(parentChunk.raw_text, /섹션: 재무제표/, "the full section context IS still available, just deferred to TABLE_PARENT_CONTEXT");
});

test("explicit/inherited/absent context state distinction: an unconfirmed title guess is ABSENT_IN_SOURCE, never treated as explicit (no inference)", () => {
  const record = syntheticRecord({ titleConfirmed: false, caption: "추정된 제목" });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunk = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.equal(rowChunk.metadata.context_states.table_title, CONTEXT_STATE.ABSENT_IN_SOURCE);
  assert.doesNotMatch(rowChunk.raw_text, /추정된 제목/, "an unconfirmed guess must never be fabricated into the chunk text");
});

test("explicit/inherited/absent: a unit declared in a SEPARATE row is INHERITED_FROM_TABLE_CONTEXT, an inline unit is EXPLICIT_IN_SOURCE, no unit anywhere is ABSENT_IN_SOURCE", () => {
  const withDeclaredUnit = syntheticRecord({ rows: [["(단위: 백만원)"], ["항목", "전기", "당기"], ["매출액", "100", "200"]], headerRowIndices: [1] });
  const chunksA = chunkAdaptive(withDeclaredUnit, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowA = chunksA.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.equal(rowA.metadata.context_states.unit, CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT);

  const withInlineUnit = syntheticRecord({ rows: [["항목", "전기", "당기"], ["매출액", "100백만원", "200백만원"]], headerRowIndices: [0] });
  const chunksB = chunkAdaptive(withInlineUnit, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowB = chunksB.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.equal(rowB.metadata.context_states.unit, CONTEXT_STATE.EXPLICIT_IN_SOURCE);

  const withNoUnit = syntheticRecord({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"]], headerRowIndices: [0] });
  const chunksC = chunkAdaptive(withNoUnit, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowC = chunksC.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.equal(rowC.metadata.context_states.unit, CONTEXT_STATE.ABSENT_IN_SOURCE);
});

test("ABSENT_IN_SOURCE is never counted as a violation -- it is a normal, expected context_state value, not a flag needing correction", () => {
  const record = syntheticRecord({ rows: [["단일값"]], headerRowIndices: [] });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunk = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS);
  assert.equal(rowChunk.metadata.context_states.row_header, CONTEXT_STATE.ABSENT_IN_SOURCE);
  assert.doesNotThrow(() => chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE));
});

test("row segment header repetition: a row split across multiple TABLE_ROW_SEGMENT_WITH_HEADERS chunks repeats the SAME row/column header context in every segment", () => {
  // chunker.mjs's tokenizer matches a contiguous run of letters/digits as
  // ONE token (word-level, not character-count-based) -- a cell needs
  // internal whitespace/punctuation to accumulate many tokens. 300
  // whitespace-separated-word cells comfortably exceeds the 256-token
  // budget (minus ~40 reserved for repeated headers).
  const longCells = Array.from({ length: 300 }, (_, i) => `값 ${i} 데이터 항목 설명`);
  const record = syntheticRecord({ rows: [["항목", ...Array.from({ length: 300 }, (_, i) => `기간 ${i}`)], ["매출액", ...longCells]], headerRowIndices: [0] });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  // Both the header row (row 0) and the value row (row 1) are long enough
  // to split here -- filter to the VALUE row's segments specifically.
  const segments = chunks.filter((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_SEGMENT_WITH_HEADERS && c.source_spans[0].row_start === 1);
  assert.ok(segments.length >= 2, "expected the long value row to split into multiple segments");
  for (const seg of segments) {
    assert.equal(seg.metadata.context_states.row_header, CONTEXT_STATE.EXPLICIT_IN_SOURCE);
    assert.match(seg.raw_text, /행: 매출액/, "each segment must repeat the row header");
  }
  // actual included column range is recorded as metadata
  for (const seg of segments) assert.ok(seg.metadata.column_group);
});

test("locator provenance: every table-aware chunk carries document_id/node_id/row/column back to the real source (some span's row_start<=target<=row_end -- Turn P10.4-R: packed chunks carry ONE span PER row, never a single range span)", () => {
  const record = syntheticRecord();
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunk = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.raw_text.includes("매출액"));
  assert.ok(rowChunk.source_spans.every((s) => s.node_id === "doc1::f.xml::n0"));
  const covering = rowChunk.source_spans.find((s) => s.row_start <= 1 && 1 <= s.row_end);
  assert.ok(covering, "some span must cover the target row (index 1)");
  assert.ok(covering.canonical_source_locator.includes("row="));
});

test("Turn P10.4-R / Section D: a packed chunk carries ONE span per row, each with THAT row's own accurate col_end -- not a single range span sized off only the last row", () => {
  // 3 rows of DIFFERING column counts, all small enough to pack into one chunk.
  const record = syntheticRecord({
    rows: [
      ["항목", "2023", "2024"],
      ["매출액", "100", "200", "300"], // wider than its siblings (4 cols)
      ["영업이익", "10"], // narrower than its siblings (2 cols)
    ],
    headerRowIndices: [0],
  });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const packed = chunks.find((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS && c.metadata.packed_row_count === 3);
  assert.ok(packed, "expected all 3 rows to pack into one chunk");
  assert.equal(packed.source_spans.length, 3, "one span per packed row, not one span for the whole group");

  const spanForRow1 = packed.source_spans.find((s) => s.row_start === 1 && s.row_end === 1);
  const spanForRow2 = packed.source_spans.find((s) => s.row_start === 2 && s.row_end === 2);
  // Regression case for the exact bug: a single group-level span sized off
  // the LAST row (2 cols, col_end=1) would silently claim row 1's own
  // last column (index 3) does not exist.
  assert.equal(spanForRow1.col_start, 0);
  assert.equal(spanForRow1.col_end, 3, "the wider interior row's own last column must not be lost");
  // And the narrower row must not falsely claim a column range only its
  // wider sibling has.
  assert.equal(spanForRow2.col_start, 0);
  assert.equal(spanForRow2.col_end, 1, "the narrower row must not claim a column index only a sibling row has");

  // Per-row reverse resolution: chunkCoversLocator must resolve each row's
  // OWN actual last column, and must reject a column index only a sibling
  // row has.
  const covers = (row, col) => packed.source_spans.some((s) => s.row_start <= row && row <= s.row_end && s.col_start <= col && col <= s.col_end);
  assert.ok(covers(1, 3), "row 1's own last column (index 3) must be covered");
  assert.ok(!covers(2, 3), "row 2 (only 2 cols) must not falsely claim column index 3, which only row 1 has");
  assert.ok(covers(2, 1), "row 2's own last column (index 1) must be covered");
});

test("Turn P10.4-R / Section H: a packed TABLE_ROW_WITH_HEADERS chunk NEVER exceeds the 512-token budget, even for a table with a wide column-header line -- the packing budget must reserve for the column-header/unit lines too, not just table title/section", () => {
  // A wide header row (many period columns) makes the shared "열/기간: ..."
  // line alone a substantial token cost -- the exact real-corpus bug this
  // regression test targets: a budget calculation that ignored this line
  // entirely let composed packed chunks exceed 512 tokens (measured p95
  // utilization 1.18 = 18% OVER budget before the fix).
  const headerRow = ["항목", ...Array.from({ length: 100 }, (_, i) => `기간${i}`)];
  const dataRow1 = ["매출액", ...Array.from({ length: 100 }, (_, i) => String(1000 + i))];
  const dataRow2 = ["영업이익", ...Array.from({ length: 100 }, (_, i) => String(2000 + i))];
  const record = syntheticRecord({ rows: [headerRow, dataRow1, dataRow2], headerRowIndices: [0] });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunks = chunks.filter((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS);
  assert.ok(rowChunks.length > 0, "expected at least one packed row chunk");
  for (const c of rowChunks) {
    assert.ok(c.token_count <= TABLE_ROW_CHILD_MAX_TOKENS, `packed chunk token_count (${c.token_count}) must never exceed the ${TABLE_ROW_CHILD_MAX_TOKENS}-token budget`);
  }
});

test("Turn P10.4-R / Section H: a deeply-nested section breadcrumb combined with a dense, mis-parsed unit-like row still never exceeds the 512-token budget -- exact real-corpus reproduction (periodic_20260515002520, table n212)", () => {
  // Real DART financial-statement-notes documents can have a
  // section_hierarchy 30+ levels deep (an enumeration of every note
  // topic, not a genuine ancestor chain), AND a row whose cells got
  // flattened during parsing into a dense blob containing "단위:" plus
  // many comma-grouped numbers (looks like a unit label to the regex, is
  // actually mis-parsed tabular data) -- BOTH combined pushed a real
  // packed chunk to 534 tokens before this Turn's fixes.
  const deepSection = Array.from({ length: 37 }, (_, i) => `[${String(i).padStart(2, "0")}] 섹션 항목 ${i} (연결)`);
  const denseFakeUnitRow = ["단위 : 원", "35.1 보고기간 중 기타수익의 내역은 다음과 같습니다. 구분 당분기 전분기 유형자산처분이익 21,954,492 - 무형자산처분이익 - 8,495,080 종속기업투자처분이익 - 140,050,886 합계 41,985,846 287,428,646"];
  const headerRow = ["구분", "당분기", "전분기"];
  const dataRows = Array.from({ length: 10 }, (_, i) => [`항목${i}`, String(1000 + i), String(2000 + i)]);
  const rows = [denseFakeUnitRow, headerRow, ...dataRows];
  const nodes = [
    { node_id: "doc1::f.xml::n0", kind: "table", source: { rel_path: "f.xml", order_index: 0 },
      normalized_rows: rows, header_row_indices: [1], normalized_title_guess: null, title_confirmed: false,
      n_declared_cols: 3, actual_col_counts: rows.map((r) => r.length), section_hierarchy: deepSection },
  ];
  const record = { doc_id: "doc1", corpus_snapshot_id: "corpus_test", parser_version: "test", schema_version: "0.1.0", parse_quality: { tier: "structured" }, warnings: [], source_files: [{ content_format: "xml" }], nodes };
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const rowChunks = chunks.filter((c) => c.chunk_type === ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS);
  assert.ok(rowChunks.length > 0, "expected at least one packed row chunk");
  for (const c of rowChunks) {
    assert.ok(c.token_count <= TABLE_ROW_CHILD_MAX_TOKENS, `packed chunk token_count (${c.token_count}) must never exceed the ${TABLE_ROW_CHILD_MAX_TOKENS}-token budget`);
  }
});

test("stable chunk ID: deterministic across two independent calls, and changes when policy/document/node/row/col/type change", () => {
  const record = syntheticRecord();
  const run1 = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const run2 = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  assert.deepEqual(run1.map((c) => c.chunk_id), run2.map((c) => c.chunk_id));

  const otherDoc = chunkAdaptive(syntheticRecord({ docId: "doc2" }), syntheticDocument("doc2"), ADAPTIVE_CONFIG, PROVENANCE);
  const overlap = run1.filter((c) => otherDoc.some((o) => o.chunk_id === c.chunk_id));
  assert.equal(overlap.length, 0, "chunk IDs for a different document must never collide");
});

test("byte-equivalence: non-table Fixed content is IDENTICAL (chunk_id, raw_text, content_sha256, source_spans) between plain chunkFixed() and Adaptive's FIXED_WINDOW pass-through", () => {
  const record = syntheticRecord({ rows: [["a", "b"]] });
  // add a paragraph node so there is real non-table content to compare
  record.nodes.unshift({ node_id: "doc1::f.xml::p0", kind: "paragraph", text: "이것은 표와 무관한 일반 문단입니다.", section_hierarchy: [], source: { rel_path: "f.xml", order_index: -1 } });
  const fixedChunks = chunkFixed(record, syntheticDocument(), FIXED_CONFIG, PROVENANCE);
  const adaptiveChunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const fixedById = new Map(fixedChunks.map((c) => [c.chunk_id, c]));
  for (const c of adaptiveChunks.filter((c) => c.chunk_type === "FIXED_WINDOW")) {
    const f = fixedById.get(c.chunk_id);
    assert.ok(f, `${c.chunk_id} missing from plain chunkFixed() output`);
    assert.equal(f.raw_text, c.raw_text);
    assert.equal(f.content_sha256, c.content_sha256);
    assert.deepEqual(f.source_spans, c.source_spans);
  }
});

test("table-touching FIXED_WINDOW chunks are demoted to non-retrieval-eligible under Adaptive, without altering their content", () => {
  const record = syntheticRecord();
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const tableTouching = chunks.filter((c) => c.chunk_type === "FIXED_WINDOW" && c.source_spans.some((s) => s.row_start !== null));
  for (const c of tableTouching) assert.equal(c.metadata.retrieval_eligible, false);
});

test("parent context is never a base search candidate: TABLE_PARENT_CONTEXT and MULTI_ROW_CONTEXT are always retrieval_eligible: false / index_role: CONTEXT_ONLY", () => {
  const record = syntheticRecord();
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  for (const c of chunks.filter((c) => c.chunk_type === "TABLE_PARENT_CONTEXT" || c.chunk_type === "MULTI_ROW_CONTEXT")) {
    assert.equal(c.metadata.retrieval_eligible, false);
    assert.equal(c.metadata.index_role, "CONTEXT_ONLY");
  }
});

test("multi-row evidence is preserved: MULTI_ROW_CONTEXT contains ALL rows' text, not a lossy summary", () => {
  const record = syntheticRecord({ rows: [["항목", "전기", "당기"], ["매출액", "100", "200"], ["영업이익", "10", "20"]], headerRowIndices: [0] });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const multiRow = chunks.find((c) => c.chunk_type === "MULTI_ROW_CONTEXT");
  assert.match(multiRow.raw_text, /매출액/);
  assert.match(multiRow.raw_text, /영업이익/);
});

test("forbidden pattern: a large table is never emitted as ONE giant search chunk -- rows are packed up to the token budget (bounded, like Fixed's own windowing), not one-per-row and not one-for-everything", () => {
  // A real-corpus finding (Turn P10.4 Stage 5): unbounded one-chunk-per-
  // row on a table with tens of thousands of rows produced 15.8x Fixed's
  // full-corpus search-eligible chunk count. This large synthetic table
  // (400 rows, substantial per-cell text) must split into SEVERAL bounded
  // chunks -- neither 1 (whole table) nor 400 (one per row).
  const rows = [["항목", "전기", "당기"]];
  for (let i = 0; i < 400; i += 1) rows.push([`항목 ${i} 상세 설명 데이터`, `${i} 00 값 데이터`, `${i} 00 값 데이터`]);
  const record = syntheticRecord({ rows, headerRowIndices: [0] });
  const chunks = chunkAdaptive(record, syntheticDocument(), ADAPTIVE_CONFIG, PROVENANCE);
  const retrievalEligibleTableChunks = chunks.filter((c) => (c.chunk_type === "TABLE_ROW_WITH_HEADERS" || c.chunk_type === "TABLE_ROW_SEGMENT_WITH_HEADERS") && c.metadata.retrieval_eligible);
  assert.ok(retrievalEligibleTableChunks.length > 1, "must not collapse to one giant chunk");
  assert.ok(retrievalEligibleTableChunks.length < 400, "must not be one chunk per row either -- rows are packed up to the token budget");
  for (const c of retrievalEligibleTableChunks) {
    assert.ok(c.token_count <= ADAPTIVE_CONFIG.table_row_child_max_tokens + 64, `chunk ${c.chunk_id} exceeds the token budget by more than repeated-header overhead: ${c.token_count}`);
    assert.ok(c.source_spans[0].row_end - c.source_spans[0].row_start < 400, "no single chunk covers the entire table");
  }
});

test("real-data integration: chunkAdaptive over a real bounded-corpus document produces a plausible chunk set with no crash", { skip: !cacheLines }, () => {
  const entry = cacheLines[0];
  const doc = toChunkerDocument(entry.metadata);
  const chunks = chunkAdaptive(entry.raw_record, doc, ADAPTIVE_CONFIG, PROVENANCE);
  assert.ok(Array.isArray(chunks));
  assert.ok(chunks.every((c) => c.chunk_id && c.raw_text.length > 0));
});

test("hasIrregularColumnCounts is retained but is NOT used as a chunk-time gate (real-data regression guard for the corrected design)", { skip: !cacheLines }, () => {
  const entry = cacheLines.find((e) => e.document_id === "holding_20240403000410") ?? cacheLines[0];
  const doc = toChunkerDocument(entry.metadata);
  const chunks = chunkAdaptive(entry.raw_record, doc, ADAPTIVE_CONFIG, PROVENANCE);
  const irregularTableNodeIds = new Set((entry.raw_record.nodes ?? []).filter((n) => n.kind === "table" && hasIrregularColumnCounts(n)).map((n) => n.node_id));
  if (irregularTableNodeIds.size === 0) return; // nothing to assert for this particular document
  const rowChunksForIrregularTables = chunks.filter((c) => c.chunk_type === "TABLE_ROW_WITH_HEADERS" && irregularTableNodeIds.has(c.metadata.table_node_id));
  assert.ok(rowChunksForIrregularTables.length > 0, "irregular-column-count tables must still receive normal row-level chunking");
});

test("Turn P10.4-R / Section C: the 4 pinned PARSE_RECOVERY_REQUIRED sources never produce table-aware children, and their Fixed windows stay retrieval-eligible fallback", { skip: !cacheLines }, () => {
  assert.equal(PARSE_LIMITED_TABLE_SOURCES.length, 4);
  let pinnedNodesEncountered = 0;
  for (const source of PARSE_LIMITED_TABLE_SOURCES) {
    const entry = cacheLines.find((e) => e.document_id === source.document_id);
    if (!entry) continue; // this document not present in the bounded 372-doc corpus -- skip, full corpus is checked at Stage 5
    const pinnedNode = entry.raw_record.nodes.find((n) => n.node_id === source.node_id);
    assert.ok(pinnedNode, `pinned node ${source.node_id} must exist in the real DocumentIR`);
    pinnedNodesEncountered += 1;

    const doc = toChunkerDocument(entry.metadata);
    const chunks = chunkAdaptive(entry.raw_record, doc, ADAPTIVE_CONFIG, PROVENANCE);
    const tableAwareChildrenForPinnedNode = chunks.filter((c) =>
      (c.chunk_type === "TABLE_ROW_WITH_HEADERS" || c.chunk_type === "TABLE_ROW_SEGMENT_WITH_HEADERS" || c.chunk_type === "MULTI_ROW_CONTEXT" || c.chunk_type === "TABLE_PARENT_CONTEXT")
      && c.metadata.table_node_id === source.node_id);
    assert.equal(tableAwareChildrenForPinnedNode.length, 0, `pinned node ${source.node_id} must never produce a table-aware child (Fixed fallback only, never disguised as a normal row/column child)`);

    const touchingFixedChunks = chunks.filter((c) => c.chunk_type === "FIXED_WINDOW" && c.source_spans.some((s) => s.node_id === source.node_id));
    assert.ok(touchingFixedChunks.length > 0, `expected at least one Fixed window touching pinned node ${source.node_id}`);
    for (const c of touchingFixedChunks) {
      assert.equal(c.metadata.retrieval_eligible, true, "the pinned table's Fixed fallback window must stay retrieval-eligible, never demoted");
      assert.notEqual(c.metadata.index_role, "CONTEXT_ONLY");
    }
  }
  assert.ok(pinnedNodesEncountered > 0, "at least one of the 4 pinned sources must be present in the bounded corpus cache to exercise this test");
});

test("PARSE_LIMITED_TABLE_NODE_IDS is a Set with exactly the 4 pinned node_ids, no duplicates", () => {
  assert.equal(PARSE_LIMITED_TABLE_NODE_IDS.size, 4);
  for (const source of PARSE_LIMITED_TABLE_SOURCES) assert.ok(PARSE_LIMITED_TABLE_NODE_IDS.has(source.node_id));
});
