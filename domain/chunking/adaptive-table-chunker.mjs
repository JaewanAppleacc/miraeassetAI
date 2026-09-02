// Turn P10.4 / Stage 2-3: Adaptive Table Chunking. PARAGRAPH/TITLE content
// reuses domain/chunking/chunker.mjs's chunkFixed() UNMODIFIED (byte-
// identical chunk_id/raw_text/source_spans, verified by test) -- this
// module ONLY adds new logic for TABLE content: TABLE_ROW_WITH_HEADERS,
// TABLE_ROW_SEGMENT_WITH_HEADERS (token-budget overflow), MULTI_ROW_
// CONTEXT and TABLE_PARENT_CONTEXT (both index_role: CONTEXT_ONLY, never
// embedded/indexed as base search candidates -- attached only by late
// parent expansion, see adaptive-parent-expansion.mjs).
import { createHash } from "node:crypto";
import { ids, stableId } from "../contracts.mjs";
import { chunkFixed, sourceSegments, qualityEligibility, embedText, chunkMetadata, tokenizeWithOffsets } from "./chunker.mjs";
import strategyConfigs from "./strategy-configs.v0.1.json" with { type: "json" };
import { ADAPTIVE_POLICY_ID, ADAPTIVE_CHUNK_TYPE, CONTEXT_STATE, BASE_FIXED_CONFIG_ID, TABLE_ROW_CHILD_MAX_TOKENS } from "./adaptive-chunking-policy.mjs";
import { PARSE_LIMITED_TABLE_NODE_IDS } from "./adaptive-parse-limited-sources.v0.1.mjs";

const BASE_FIXED_STRATEGY_CONFIG = strategyConfigs.strategies.find((s) => s.chunking_config_id === BASE_FIXED_CONFIG_ID);
if (!BASE_FIXED_STRATEGY_CONFIG) throw new Error(`adaptive-table-chunker.mjs: ${BASE_FIXED_CONFIG_ID} not found in strategy-configs.v0.1.json`);

const UNIT_TOKEN_PATTERN = /(?:원|천원|백만원|억원|%|퍼센트|주|천주|만주|배|포인트|bp)/;
const UNIT_VALUE_TOKEN_PATTERN = /[\d,.]\s*(?:천원|백만원|억원|퍼센트|천주|만주|포인트|원|%|주|배|bp)/;
const UNIT_DECLARATION_PATTERN = /\(?\s*단위\s*[:：]/;
// A comma-grouped number ("21,954,492") is the signature of embedded
// TABULAR DATA, never present in a genuine "(단위: 백만원)" label row.
const COMMA_GROUPED_NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+/g;
const MAX_SECTION_PATH_DEPTH = 6;

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Same mechanical signal established and validated across P10.3.1/P10.3.2:
// a table whose per-row column count is inconsistent cannot be reliably
// row/column-addressed without an upstream parser fix.
export function hasIrregularColumnCounts(node) {
  const counts = node?.actual_col_counts ?? [];
  if (counts.length < 2) return false;
  return new Set(counts).size > 1;
}

// Turn P10.4-R / Section H: a genuine "(단위: ...)" declaration is always a
// short, compact LABEL -- real-corpus measurement of every row across the
// bounded 372-doc corpus that matches UNIT_DECLARATION_PATTERN +
// UNIT_TOKEN_PATTERN found p50=26 chars, p90=69, p99=309 (n=20,963), but a
// small number of DART "note"-style tables have a giant narrative/footnote
// row (one measured at 72,008 chars) that happens to contain "단위:" and a
// percent sign somewhere within unrelated prose. Without a length bound,
// that whole narrative row gets selected as THE table's unit declaration
// and is re-embedded into EVERY packed chunk of that table -- measured
// real-corpus impact: a single chunk at 5,068 tokens (~10x the 512-token
// budget). Bounded here at a length well above the real p99 (so no
// genuine unit row is ever excluded) but firmly below the pathological
// narrative-row range.
const UNIT_DECLARING_ROW_MAX_LENGTH = 400;
// A second, independent signal (not just length): a genuine unit LABEL
// never contains multiple large comma-grouped numbers -- a real-corpus
// case measured a 380-char row that passed the length bound alone but was
// actually a mis-parsed sub-table (two "35.1"/"35.2" note sections'
// worth of labeled numeric rows flattened into one cell), still pushing a
// packed chunk to 534 tokens. Capped here independent of the length bound.
const MAX_COMMA_GROUPED_NUMBERS_IN_UNIT_ROW = 2;

function findUnitDeclaringRowIndex(rows) {
  for (const [rowIndex, row] of rows.entries()) {
    const joined = normalize(row.join(" | "));
    if (joined.length > UNIT_DECLARING_ROW_MAX_LENGTH) continue;
    if ((joined.match(COMMA_GROUPED_NUMBER_PATTERN) ?? []).length > MAX_COMMA_GROUPED_NUMBERS_IN_UNIT_ROW) continue;
    if (UNIT_DECLARATION_PATTERN.test(joined) && UNIT_TOKEN_PATTERN.test(joined)) return rowIndex;
  }
  return -1;
}

function rowOwnUnitToken(cells) {
  const joined = normalize(cells.join(" | "));
  return UNIT_VALUE_TOKEN_PATTERN.test(joined);
}

function makeAdaptiveSpan({ documentId, node, rowStart, rowEnd, colStart, colEnd }) {
  const base = `${documentId}/${node.source.rel_path}#node=${node.source.order_index}`;
  const source_locator = rowStart === null ? base : `${base}&row=${rowStart}${rowEnd !== rowStart ? `-${rowEnd}` : ""}&col=${colStart}${colEnd !== colStart ? `-${colEnd}` : ""}`;
  return {
    file_id: ids.file(documentId, node.source.rel_path),
    rel_path: node.source.rel_path,
    node_id: node.node_id,
    order_index: node.source.order_index,
    row_start: rowStart, row_end: rowEnd, col_start: colStart, col_end: colEnd,
    source_locator,
    canonical_source_locator: source_locator,
  };
}

// Resolves table_title / section_title / unit context ONCE per table node,
// reusing the row-0 table-row segment's tableMetadata/sectionPath (all
// rows of one table share identical tableMetadata/sectionPath by
// construction in chunker.mjs's sourceSegments()) -- never inferring a
// title chunker.mjs itself did not confirm.
//
// Exported (Turn P10.4-R / Section E) so callers OTHER than the chunker
// itself (Stage 6's structure-preservation script, Stage 7's cell-level
// metrics) can compute the SAME ground-truth ("is this info even present
// in the source at all") independent of whatever chunk happened to be
// retrieved -- fixes a bug where applicable/preserved denominators were
// derived from a retrieved chunk's own metadata claim instead of the
// table's actual structure, wrongly penalizing tables that genuinely have
// no confirmed title/section/unit as "violations".
export function resolveTableContext(node, rowSegmentsForTable) {
  const sample = rowSegmentsForTable[0];
  const tableTitle = sample?.tableMetadata?.title_confirmed && sample.tableMetadata.caption
    ? { value: sample.tableMetadata.caption, context_state: CONTEXT_STATE.EXPLICIT_IN_SOURCE }
    : { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
  // Turn P10.4-R / Section H: real-corpus DART "재무제표 주석" (financial
  // statement notes) documents can have a section_hierarchy 30+ levels
  // deep (one measured case: 37 levels, an enumeration of every note
  // topic in the document, not a genuine ancestor chain) -- an unbounded
  // breadcrumb here contributed directly to a packed chunk exceeding the
  // 512-token budget (this exact table measured). Capped to the MOST
  // SPECIFIC (deepest) levels, which are also the most retrieval-relevant
  // -- the table's own title (captured separately above) already names
  // the specific topic, so the generic top-level ancestors are the least
  // valuable context to drop under this bound.
  const sectionPath = sample?.sectionPath ?? [];
  const cappedSectionPath = sectionPath.length > MAX_SECTION_PATH_DEPTH ? sectionPath.slice(-MAX_SECTION_PATH_DEPTH) : sectionPath;
  const sectionTitle = cappedSectionPath.length > 0
    ? { value: cappedSectionPath.join(" > "), context_state: CONTEXT_STATE.EXPLICIT_IN_SOURCE }
    : { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
  const unitRowIndex = findUnitDeclaringRowIndex(node.normalized_rows ?? []);
  return { tableTitle, sectionTitle, unitRowIndex };
}

function resolveRowHeader(cells) {
  if (cells.length > 1 && cells[0]) return { value: cells[0], context_state: CONTEXT_STATE.EXPLICIT_IN_SOURCE };
  return { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
}

function resolveColumnPeriodHeader(node, rowIndex, cells) {
  const headerRowIndices = node.header_row_indices ?? [];
  if (headerRowIndices.length === 0 || headerRowIndices.includes(rowIndex)) {
    return { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
  }
  const headerRow = (node.normalized_rows?.[headerRowIndices[0]] ?? []).map((c) => normalize(c));
  return { value: headerRow.join(" | "), context_state: CONTEXT_STATE.EXPLICIT_IN_SOURCE };
}

// Exported (Turn P10.4-R / Section E) -- same ground-truth reasoning as
// resolveTableContext() above, but per-row (a row's OWN inline unit token
// takes precedence over the table-level inherited unit row).
export function resolveUnit(cells, node, unitRowIndex) {
  if (rowOwnUnitToken(cells)) return { value: null, context_state: CONTEXT_STATE.EXPLICIT_IN_SOURCE, inline: true };
  if (unitRowIndex >= 0) {
    const unitRow = (node.normalized_rows?.[unitRowIndex] ?? []).map((c) => normalize(c)).join(" | ");
    return { value: unitRow, context_state: CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT, inline: false };
  }
  return { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE, inline: false };
}

// Turn P10.4-R / Section H: the "섹션: ..." breadcrumb is deliberately
// NOT printed into row-level chunk text (here or in
// formatPackedHeaderLines below) -- it is still fully available via
// TABLE_PARENT_CONTEXT (composed further below, unaffected) and attached
// on demand by late parent expansion (Section F). Repeating a full
// section breadcrumb in EVERY row-level chunk of a table (sometimes many
// per table) is real, measured, corpus-wide overhead with no hard-gated
// preservation requirement (only column-header >=95% and unit >=90% are
// gated in adaptive-success-threshold.mjs; section preservation is
// descriptive-only) -- table_title (the specific topic name, always
// short) is kept here as the precise per-chunk context that matters most.
// metadata.context_states.section_title still correctly reports ground
// truth (EXPLICIT_IN_SOURCE/ABSENT_IN_SOURCE) regardless of this.
function composeRowText({ tableTitle, unit, columnHeader, rowHeader, cells, colStart, colEnd }) {
  const lines = [];
  if (tableTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE) lines.push(`표제목: ${tableTitle.value}`);
  if (unit.context_state === CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT) lines.push(`단위: ${unit.value}`);
  if (columnHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE) lines.push(`열/기간: ${columnHeader.value}`);
  if (rowHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE) lines.push(`행: ${rowHeader.value}`);
  const valueCells = cells.slice(colStart, colEnd + 1);
  lines.push(valueCells.join(" | "));
  return lines.join("\n");
}

// Exported (Turn P10.4-R / Section E) so Stage 6/7 can derive per-row
// ground-truth applicability (row header / column header / unit) the same
// way the chunker itself does, rather than re-deriving a parallel,
// possibly-diverging version.
export function buildRowContextFields({ node, rowIndex, cells, tableContext }) {
  const rowHeader = resolveRowHeader(cells);
  const columnHeader = resolveColumnPeriodHeader(node, rowIndex, cells);
  const unit = resolveUnit(cells, node, tableContext.unitRowIndex);
  return { rowHeader, columnHeader, periodHeader: columnHeader, unit, tableTitle: tableContext.tableTitle, sectionTitle: tableContext.sectionTitle };
}

function chunkRowOverBudget({ cells, maxTokens, reservedTokens }) {
  const budget = Math.max(32, maxTokens - reservedTokens);
  const groups = [];
  let currentStart = 0;
  let currentTokens = 0;
  for (let col = 0; col < cells.length; col += 1) {
    const cellTokens = tokenizeWithOffsets(cells[col]).length;
    if (currentTokens > 0 && currentTokens + cellTokens > budget) {
      groups.push({ colStart: currentStart, colEnd: col - 1 });
      currentStart = col;
      currentTokens = 0;
    }
    currentTokens += cellTokens;
  }
  groups.push({ colStart: currentStart, colEnd: cells.length - 1 });
  return groups;
}

// Real-corpus measurement (Turn P10.4 Stage 5, first full-corpus run):
// unbounded one-chunk-per-row generation produced 6,986,711 search-
// eligible chunks vs Fixed's real full-corpus baseline of 442,549 (~15.8x)
// -- a small number of pathologically large tables (tens of thousands of
// rows each, e.g. full shareholder registries in periodic filings) blew
// this up far past Stage 8's <=1.5x cost gate. FIXED by packing multiple
// CONSECUTIVE rows into one TABLE_ROW_WITH_HEADERS chunk up to the token
// budget -- mirroring exactly how chunkFixed() itself bounds chunk count
// (pack until the budget is exceeded, then start a new chunk), so Adaptive
// is bounded by TOTAL TABLE TEXT VOLUME the same way Fixed already is,
// never by raw row count. Stage 1's own field list anticipates this
// ("row 또는 row_range"). A single row that alone exceeds the budget still
// falls back to column-range splitting via chunkRowOverBudget() above.
function packRowsIntoChunks({ rowSegments, node, fieldsByRow, maxTokens, headerOverheadTokens }) {
  const budget = Math.max(64, maxTokens - headerOverheadTokens);
  const groups = [];
  let current = [];
  let currentTokens = 0;
  for (const seg of rowSegments) {
    const rowIndex = seg.rowIndex;
    const cells = fieldsByRow.get(rowIndex).cells;
    // Turn P10.4-R / Section H: measured with the EXACT same formatting
    // function (formatPackedRowLine) composePackedRowsText() below uses to
    // build the real output line -- a real-corpus measurement found the
    // PREVIOUS estimate (rowHeader.value + cells, missing the "행: "
    // prefix and using the wrong separator) under-measured every row,
    // which combined with headerOverheadTokens also missing the column-
    // header/unit lines' real cost, let packed chunks exceed the 512-
    // token budget entirely (p95 utilization measured at 1.18, i.e. 18%
    // OVER budget) -- both are fixed together here, sharing one
    // formatting function so the measured and the emitted text can never
    // drift apart again.
    const rowLineTokens = tokenizeWithOffsets(formatPackedRowLine(fieldsByRow.get(rowIndex))).length;
    if (rowLineTokens > budget) {
      // this single row alone exceeds even the packed budget -- flush
      // whatever is pending, then handle it as its own oversized-row
      // group (caller splits it via chunkRowOverBudget()).
      if (current.length > 0) { groups.push(current); current = []; currentTokens = 0; }
      groups.push([{ rowIndex, oversized: true }]);
      continue;
    }
    if (current.length > 0 && currentTokens + rowLineTokens > budget) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push({ rowIndex, oversized: false });
    currentTokens += rowLineTokens;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Shared by BOTH the packing-budget measurement (packRowsIntoChunks above)
// and the actual composed output below -- ONE formatting function used
// for both means the estimate can never drift from what actually gets
// emitted (the root cause of the Turn P10.4-R / Section H over-budget
// bug: the two used to be two independently-hand-written strings).
// Turn P10.4-R / Section H: see composeRowText()'s comment above -- the
// "섹션: ..." breadcrumb is deliberately never printed here either, for
// the same reason (still fully available via TABLE_PARENT_CONTEXT +
// late expansion, never hard-gated, real measured per-chunk overhead).
function formatPackedHeaderLines({ tableTitle, unit, columnHeader }) {
  const lines = [];
  if (tableTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE) lines.push(`표제목: ${tableTitle.value}`);
  if (unit.context_state === CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT) lines.push(`단위: ${unit.value}`);
  if (columnHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE) lines.push(`열/기간: ${columnHeader.value}`);
  return lines;
}
function formatPackedRowLine(row) {
  return row.rowHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE
    ? `행: ${row.rowHeader.value} | ${row.cells.join(" | ")}`
    : row.cells.join(" | ");
}

// Turn P10.4-R / Section H: HARD safety net, independent of the specific
// pathologies already fixed above (giant mis-detected unit row, deep
// section breadcrumb) -- verifies the ACTUAL composed text of a packed
// group against the real 512-token budget and, if it still doesn't fit
// (any other cause this Turn's fixes didn't anticipate), binary-splits
// the group into smaller packed groups and re-verifies each, recursively,
// rather than ever silently emitting an over-budget chunk. Never drops a
// row. Only the ALREADY-VALIDATED estimate from packRowsIntoChunks is
// expected to need this in a rare residual case; when it fires it fires
// on the ACTUAL text, not another estimate.
function splitGroupToFitBudget({ group, fieldsByRow, tableContext, maxTokens }) {
  const rows = group.map((g) => ({ rowIndex: g.rowIndex, ...fieldsByRow.get(g.rowIndex) }));
  const representativeColumnHeader = rows.find((r) => r.columnHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE)?.columnHeader ?? rows[0].columnHeader;
  const representativeUnit = rows.find((r) => r.unit.context_state !== CONTEXT_STATE.ABSENT_IN_SOURCE)?.unit ?? rows[0].unit;
  const rawText = composePackedRowsText({ tableTitle: tableContext.tableTitle, sectionTitle: tableContext.sectionTitle, unit: representativeUnit, columnHeader: representativeColumnHeader, rows });
  const tokenCount = tokenizeWithOffsets(rawText).length;
  if (tokenCount <= maxTokens || group.length <= 1) {
    return [{ rows, rawText, representativeColumnHeader, representativeUnit, tokenCount }];
  }
  const mid = Math.floor(group.length / 2);
  return [
    ...splitGroupToFitBudget({ group: group.slice(0, mid), fieldsByRow, tableContext, maxTokens }),
    ...splitGroupToFitBudget({ group: group.slice(mid), fieldsByRow, tableContext, maxTokens }),
  ];
}

function composePackedRowsText({ tableTitle, sectionTitle, unit, columnHeader, rows }) {
  // Header lines are shared ONCE per packed chunk; each row still gets its
  // OWN "행: ..." line so multiple rows remain individually identifiable
  // and locator-traceable within the packed chunk.
  const lines = formatPackedHeaderLines({ tableTitle, sectionTitle, unit, columnHeader });
  for (const row of rows) lines.push(formatPackedRowLine(row));
  return lines.join("\n");
}

// Tables above this row count skip whole-table MULTI_ROW_CONTEXT
// generation entirely -- a genuine multi-row Gold calculation never
// legitimately needs an adjacency window spanning tens of thousands of
// rows, and materializing one giant joined string per such table was a
// second, independent contributor to the real-corpus memory/volume blowup
// this fix addresses (measured: RSS climbing toward the 8GB cap on the
// periodic-001.jsonl batch).
const MULTI_ROW_CONTEXT_MAX_ROWS = 200;

// Main entry point. Returns the flat chunk array (base Fixed chunks,
// table-touching ones demoted to non-retrieval-eligible, plus new table-
// aware chunks). Gold-source-specific parse-limited bookkeeping (the 4
// known P10.3.2 sources) is handled separately in Stage 4, not here --
// this function chunks every table uniformly, no per-table exclusion.
export function chunkAdaptive(record, document, config, provenance) {
  if (record.doc_id !== document.document_id) throw new Error("DocumentIR and manifest document IDs do not match");
  if ((record.nodes?.length ?? 0) === 0) return [];
  if (record.parse_quality?.tier === "fallback") {
    // Fallback-tier documents are handled identically to Fixed (no table
    // structure to exploit) -- delegate entirely, no Adaptive-specific path.
    return chunkFixed(record, document, BASE_FIXED_STRATEGY_CONFIG, provenance);
  }

  const eligibility = qualityEligibility(record);
  const baseChunks = chunkFixed(record, document, BASE_FIXED_STRATEGY_CONFIG, provenance);

  // Fixed chunks that touch ANY table row are demoted to non-retrieval-
  // eligible under Adaptive (TABLE_AWARE_CHILD becomes the searchable
  // unit for table content instead) -- the underlying chunk object is
  // NEVER mutated; a new object is produced so chunk_id/raw_text/
  // source_spans/content_sha256 stay byte-identical to a plain chunkFixed()
  // call, only metadata.retrieval_eligible/index_role differ.
  //
  // EXCEPT the 4 pinned PARSE_RECOVERY_REQUIRED sources (Turn P10.4-R /
  // Section C, adaptive-parse-limited-sources.v0.1.mjs) -- excluded here
  // so their Fixed windows stay retrieval_eligible (Fixed fallback),
  // never demoted in favor of a table-aware child this table's own
  // irregular shape cannot honestly produce.
  const tableRowNodeIds = new Set((record.nodes ?? []).filter((n) => n.kind === "table" && !PARSE_LIMITED_TABLE_NODE_IDS.has(n.node_id)).map((n) => n.node_id));
  const adaptedBaseChunks = baseChunks.map((chunk) => {
    const touchesTable = chunk.source_spans.some((span) => tableRowNodeIds.has(span.node_id) && span.row_start !== null);
    if (!touchesTable) return chunk;
    return { ...chunk, metadata: { ...chunk.metadata, retrieval_eligible: false, index_role: "CONTEXT_ONLY", adaptive_demoted_table_touching: true } };
  });

  const segments = sourceSegments(record);
  const rowSegmentsByTable = new Map();
  for (const seg of segments) {
    if (seg.kind !== "table-row") continue;
    const list = rowSegmentsByTable.get(seg.tableNodeId) ?? [];
    list.push(seg);
    rowSegmentsByTable.set(seg.tableNodeId, list);
  }

  const tableChunks = [];
  const maxTokens = config.table_row_child_max_tokens ?? TABLE_ROW_CHILD_MAX_TOKENS;

  for (const node of record.nodes ?? []) {
    if (node.kind !== "table") continue;
    if (PARSE_LIMITED_TABLE_NODE_IDS.has(node.node_id)) {
      // Pinned PARSE_RECOVERY_REQUIRED source (Turn P10.4-R / Section C):
      // no TABLE_ROW_WITH_HEADERS/SEGMENT/MULTI_ROW_CONTEXT/
      // TABLE_PARENT_CONTEXT is ever generated for this table -- it never
      // masquerades as a normal row/column child. Its Fixed windows were
      // already excluded from demotion above (tableRowNodeIds), so they
      // remain the retrieval-eligible fallback for this table's content.
      continue;
    }
    const rowSegments = rowSegmentsByTable.get(node.node_id) ?? [];
    if (rowSegments.length === 0) continue;

    // NOTE (design correction found during smoke-testing): an earlier
    // version of this function excluded any table with irregular
    // actual_col_counts from row-level chunking entirely, reasoning by
    // analogy from P10.3.1/P10.3.2's 4 GOLD_LOCATOR_UNRESOLVABLE cases.
    // That was wrong: irregular column counts only broke GOLD's
    // evidence_span TEXT-matching heuristic (a citation string not
    // aligning to one row's substring) -- it does not prevent Adaptive
    // from reading each row's OWN actual cells directly and
    // deterministically (no assumption of a uniform column count across
    // rows is needed at all). A real-data smoke test showed irregular
    // column counts are common (many financial tables have a shorter
    // totals/footer row), so blanket-excluding them would have removed
    // most real tables from row-level chunking -- corrected to chunk
    // every table normally; hasIrregularColumnCounts() is retained ONLY
    // for Stage 4's Gold-source-specific exclusion bookkeeping (the 4
    // known P10.3.2 sources), never as a chunk-time gate.
    const tableContext = resolveTableContext(node, rowSegments);

    // Precompute per-row context fields once (reused by both the packing
    // pass and the composed text) -- cells/rowHeader/columnHeader/unit
    // never depend on which OTHER rows end up packed alongside a given row.
    const fieldsByRow = new Map();
    for (const seg of rowSegments) {
      const rowIndex = seg.rowIndex;
      const cells = (node.normalized_rows?.[rowIndex] ?? []).map((c) => normalize(c));
      fieldsByRow.set(rowIndex, { cells, ...buildRowContextFields({ node, rowIndex, cells, tableContext }) });
    }
    // Turn P10.4-R / Section H: MUST also reserve for the column-header
    // ("열/기간: ...") and unit ("단위: ...") lines, not just table title/
    // section -- both are the SAME text for every row of this table
    // (derived from header_row_indices[0]/unitRowIndex regardless of
    // which row is being described), so a representative sample found
    // anywhere in fieldsByRow correctly reserves for every row's packed
    // group. Missing this reservation (the previous version) let a wide
    // table's column-header line alone push a packed chunk's REAL token
    // count past the 512 budget while the packing decision itself never
    // knew -- a real-corpus measurement found p95 packed-chunk utilization
    // at 1.18 (18% OVER budget) before this fix.
    const anyRowFields = [...fieldsByRow.values()];
    const representativeHeaderColumnHeader = anyRowFields.find((r) => r.columnHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE)?.columnHeader ?? { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
    const representativeHeaderUnit = anyRowFields.find((r) => r.unit.context_state === CONTEXT_STATE.INHERITED_FROM_TABLE_CONTEXT)?.unit ?? { value: null, context_state: CONTEXT_STATE.ABSENT_IN_SOURCE };
    const headerOverheadTokens = tokenizeWithOffsets(formatPackedHeaderLines({
      tableTitle: tableContext.tableTitle, sectionTitle: tableContext.sectionTitle, unit: representativeHeaderUnit, columnHeader: representativeHeaderColumnHeader,
    }).join("\n")).length + 4; // small fixed safety margin only -- the reservation above is exact, not a substitute for it

    const rowGroups = packRowsIntoChunks({ rowSegments, node, fieldsByRow, maxTokens, headerOverheadTokens });
    for (const group of rowGroups) {
      if (group.length === 1 && group[0].oversized) {
        // A single row too large even alone -- fall back to column-range
        // splitting (TABLE_ROW_SEGMENT_WITH_HEADERS), unchanged from before.
        const rowIndex = group[0].rowIndex;
        const rowFields = fieldsByRow.get(rowIndex);
        const seg = rowSegments.find((s) => s.rowIndex === rowIndex);
        // composeRowText() below also adds a SEPARATE "행: rowHeader" line
        // (unlike the packed path, which combines it with the values line)
        // -- reserved for here too, so this fallback path shares the same
        // exact-reservation guarantee.
        const rowHeaderLineTokens = rowFields.rowHeader.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE ? tokenizeWithOffsets(`행: ${rowFields.rowHeader.value}`).length : 0;
        const columnGroups = chunkRowOverBudget({ cells: rowFields.cells, maxTokens, reservedTokens: headerOverheadTokens + rowHeaderLineTokens });
        for (const colGroup of columnGroups) {
          const chunkType = ADAPTIVE_CHUNK_TYPE.TABLE_ROW_SEGMENT_WITH_HEADERS;
          const rawText = composeRowText({ ...rowFields, colStart: colGroup.colStart, colEnd: colGroup.colEnd });
          const contentSha = sha256Hex(rawText);
          const span = makeAdaptiveSpan({ documentId: document.document_id, node, rowStart: rowIndex, rowEnd: rowIndex, colStart: colGroup.colStart, colEnd: colGroup.colEnd });
          tableChunks.push({
            schema_version: "0.1.0", corpus_snapshot_id: provenance.targetCorpusSnapshotId,
            source_document_ir: { source_corpus_snapshot_id: record.corpus_snapshot_id, parser_version: record.parser_version, schema_version: record.schema_version, parser_code_revision: provenance.parserCodeRevision, parser_config_hash: provenance.parserConfigHash },
            chunking_config_id: config.chunking_config_id, strategy_name: config.strategy_name, strategy_version: config.strategy_version,
            chunk_id: stableId("chunk", ADAPTIVE_POLICY_ID, document.document_id, node.node_id, `${rowIndex}-${rowIndex}`, `${colGroup.colStart}-${colGroup.colEnd}`, chunkType, contentSha.slice(0, 16)),
            document_id: document.document_id, chunk_index: tableChunks.length, chunk_type: chunkType,
            parent_chunk_id: null, raw_text: rawText, embed_text: embedText(document, chunkType, seg.sectionPath, rawText),
            tokenizer: { name: "unicode-word-punct", version: "1.0.0" }, token_count: tokenizeWithOffsets(rawText).length, embed_token_count: tokenizeWithOffsets(rawText).length,
            source_node_ids: [node.node_id], source_section_ids: seg.sectionIds, section_path: seg.sectionPath,
            source_locator: span.source_locator, source_spans: [span], content_sha256: contentSha,
            duplicate_group_id: `duplicate_${contentSha.slice(0, 24)}`, repeated_section: false,
            metadata: chunkMetadata(record, document, eligibility, {
              retrieval_eligible: true, fact_eligible: eligibility.factEligible, index_role: "RETRIEVAL",
              context_states: { row_header: rowFields.rowHeader.context_state, column_header: rowFields.columnHeader.context_state, period_header: rowFields.periodHeader.context_state, unit: rowFields.unit.context_state, table_title: rowFields.tableTitle.context_state, section_title: rowFields.sectionTitle.context_state },
              table_node_id: node.node_id, column_group: { total_groups: columnGroups.length },
            }),
          });
        }
        continue;
      }

      // Normal (possibly multi-row) packed group -> one or more
      // TABLE_ROW_WITH_HEADERS chunks, each covering a row_range, headers
      // shared once per chunk, each row individually identifiable via its
      // own "행: ..." line. Turn P10.4-R / Section H: verified against the
      // REAL 512-token budget by splitGroupToFitBudget() (never just the
      // upstream estimate) -- a group that still doesn't fit as a whole is
      // split into more than one chunk here, never silently over-budget.
      const budgetedPieces = splitGroupToFitBudget({ group, fieldsByRow, tableContext, maxTokens });
      for (const piece of budgetedPieces) {
        const { rows, rawText, representativeColumnHeader, representativeUnit, tokenCount } = piece;
        const rowStart = rows[0].rowIndex;
        const rowEnd = rows[rows.length - 1].rowIndex;
        if (tokenCount > maxTokens) {
          // Irreducible even at a single row (headers alone, e.g. a
          // pathologically wide column-header line, already exceed the
          // budget) -- fail closed rather than silently ship an over-
          // budget chunk. Not expected to fire given the fixes above;
          // if it does, the document/table identifies exactly where to
          // extend this Turn's fix.
          throw new Error(`FAIL-CLOSED: TABLE_ROW_WITH_HEADERS for ${document.document_id}/${node.node_id} row ${rowStart}-${rowEnd} still exceeds the ${maxTokens}-token budget (${tokenCount} tokens) even as a single row -- a pathology this Turn's header-overhead fixes did not anticipate.`);
        }
        const contentSha = sha256Hex(rawText);
        const seg = rowSegments.find((s) => s.rowIndex === rowStart);
        const lastCellCount = rows[rows.length - 1].cells.length;
        // Turn P10.4-R / Section D: a packed group's chunk-level
        // source_locator (primarySpan below) names the chunk's overall
        // row-range EXTENT/IDENTITY, exactly as before -- but source_spans[]
        // is now ONE ACCURATE SPAN PER ROW (each with that row's own actual
        // col_end), never a single range span sized off only the LAST row's
        // column count. A single range span silently lost a wider interior
        // row's last column and falsely claimed a column range a narrower
        // row in the same packed chunk doesn't have -- both
        // chunkCoversLocator() (dev-tune-evidence-locator.mjs) and Stage 6's
        // row-level checks iterate source_spans generically, so per-row
        // accuracy here is what makes row+col resolution correct for every
        // row in the group, not just the last one.
        const primarySpan = makeAdaptiveSpan({ documentId: document.document_id, node, rowStart, rowEnd, colStart: 0, colEnd: Math.max(0, lastCellCount - 1) });
        const perRowSpans = rows.map((row) => makeAdaptiveSpan({ documentId: document.document_id, node, rowStart: row.rowIndex, rowEnd: row.rowIndex, colStart: 0, colEnd: Math.max(0, row.cells.length - 1) }));
        tableChunks.push({
          schema_version: "0.1.0", corpus_snapshot_id: provenance.targetCorpusSnapshotId,
          source_document_ir: { source_corpus_snapshot_id: record.corpus_snapshot_id, parser_version: record.parser_version, schema_version: record.schema_version, parser_code_revision: provenance.parserCodeRevision, parser_config_hash: provenance.parserConfigHash },
          chunking_config_id: config.chunking_config_id, strategy_name: config.strategy_name, strategy_version: config.strategy_version,
          chunk_id: stableId("chunk", ADAPTIVE_POLICY_ID, document.document_id, node.node_id, `${rowStart}-${rowEnd}`, "0-N", ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS, contentSha.slice(0, 16)),
          document_id: document.document_id, chunk_index: tableChunks.length, chunk_type: ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS,
          parent_chunk_id: null, raw_text: rawText, embed_text: embedText(document, ADAPTIVE_CHUNK_TYPE.TABLE_ROW_WITH_HEADERS, seg.sectionPath, rawText),
          tokenizer: { name: "unicode-word-punct", version: "1.0.0" }, token_count: tokenCount, embed_token_count: tokenCount,
          source_node_ids: [node.node_id], source_section_ids: seg.sectionIds, section_path: seg.sectionPath,
          source_locator: primarySpan.source_locator, source_spans: perRowSpans, content_sha256: contentSha,
          duplicate_group_id: `duplicate_${contentSha.slice(0, 24)}`, repeated_section: false,
          metadata: chunkMetadata(record, document, eligibility, {
            retrieval_eligible: true, fact_eligible: eligibility.factEligible, index_role: "RETRIEVAL",
            context_states: { row_header: rows[0].rowHeader.context_state, column_header: representativeColumnHeader.context_state, period_header: representativeColumnHeader.context_state, unit: representativeUnit.context_state, table_title: rows[0].tableTitle.context_state, section_title: rows[0].sectionTitle.context_state },
            table_node_id: node.node_id, packed_row_count: rows.length,
          }),
        });
      }
    }

    // MULTI_ROW_CONTEXT: whole-table row context, CONTEXT_ONLY, never a
    // base search candidate -- attached only by late expansion. Skipped
    // entirely for pathologically large tables (see
    // MULTI_ROW_CONTEXT_MAX_ROWS's comment) -- a real multi-row Gold
    // calculation never legitimately spans that many rows.
    if (rowSegments.length <= MULTI_ROW_CONTEXT_MAX_ROWS) {
      const allRowsText = rowSegments.map((seg) => seg.text).join("\n");
      const multiRowSha = sha256Hex(allRowsText);
      const multiRowSpan = makeAdaptiveSpan({ documentId: document.document_id, node, rowStart: rowSegments[0].rowIndex, rowEnd: rowSegments[rowSegments.length - 1].rowIndex, colStart: 0, colEnd: Math.max(0, (node.normalized_rows?.[0]?.length ?? 1) - 1) });
      tableChunks.push({
        schema_version: "0.1.0", corpus_snapshot_id: provenance.targetCorpusSnapshotId,
        source_document_ir: { source_corpus_snapshot_id: record.corpus_snapshot_id, parser_version: record.parser_version, schema_version: record.schema_version, parser_code_revision: provenance.parserCodeRevision, parser_config_hash: provenance.parserConfigHash },
        chunking_config_id: config.chunking_config_id, strategy_name: config.strategy_name, strategy_version: config.strategy_version,
        chunk_id: stableId("chunk", ADAPTIVE_POLICY_ID, document.document_id, node.node_id, `${rowSegments[0].rowIndex}-${rowSegments[rowSegments.length - 1].rowIndex}`, "ALL", ADAPTIVE_CHUNK_TYPE.MULTI_ROW_CONTEXT, multiRowSha.slice(0, 16)),
        document_id: document.document_id, chunk_index: tableChunks.length, chunk_type: ADAPTIVE_CHUNK_TYPE.MULTI_ROW_CONTEXT,
        parent_chunk_id: null, raw_text: allRowsText, embed_text: embedText(document, ADAPTIVE_CHUNK_TYPE.MULTI_ROW_CONTEXT, rowSegments[0].sectionPath, allRowsText),
        tokenizer: { name: "unicode-word-punct", version: "1.0.0" }, token_count: tokenizeWithOffsets(allRowsText).length, embed_token_count: tokenizeWithOffsets(allRowsText).length,
        source_node_ids: [node.node_id], source_section_ids: rowSegments[0].sectionIds, section_path: rowSegments[0].sectionPath,
        source_locator: multiRowSpan.source_locator, source_spans: [multiRowSpan], content_sha256: multiRowSha,
        duplicate_group_id: `duplicate_${multiRowSha.slice(0, 24)}`, repeated_section: false,
        metadata: chunkMetadata(record, document, eligibility, { retrieval_eligible: false, fact_eligible: false, index_role: "CONTEXT_ONLY", table_node_id: node.node_id }),
      });
    }

    // TABLE_PARENT_CONTEXT: title/unit/header only, no row values --
    // CONTEXT_ONLY, attached only by late expansion.
    const parentLines = [
      tableContext.tableTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE ? `표제목: ${tableContext.tableTitle.value}` : null,
      tableContext.sectionTitle.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE ? `섹션: ${tableContext.sectionTitle.value}` : null,
      tableContext.unitRowIndex >= 0 ? `단위: ${(node.normalized_rows?.[tableContext.unitRowIndex] ?? []).map((c) => normalize(c)).join(" | ")}` : null,
      (node.header_row_indices ?? []).length > 0 ? `열/기간 헤더: ${(node.normalized_rows?.[node.header_row_indices[0]] ?? []).map((c) => normalize(c)).join(" | ")}` : null,
    ].filter(Boolean).join("\n");
    if (parentLines) {
      const parentSha = sha256Hex(parentLines);
      const parentSpan = makeAdaptiveSpan({ documentId: document.document_id, node, rowStart: null, rowEnd: null, colStart: null, colEnd: null });
      tableChunks.push({
        schema_version: "0.1.0", corpus_snapshot_id: provenance.targetCorpusSnapshotId,
        source_document_ir: { source_corpus_snapshot_id: record.corpus_snapshot_id, parser_version: record.parser_version, schema_version: record.schema_version, parser_code_revision: provenance.parserCodeRevision, parser_config_hash: provenance.parserConfigHash },
        chunking_config_id: config.chunking_config_id, strategy_name: config.strategy_name, strategy_version: config.strategy_version,
        chunk_id: stableId("chunk", ADAPTIVE_POLICY_ID, document.document_id, node.node_id, "ALL", "ALL", ADAPTIVE_CHUNK_TYPE.TABLE_PARENT_CONTEXT, parentSha.slice(0, 16)),
        document_id: document.document_id, chunk_index: tableChunks.length, chunk_type: ADAPTIVE_CHUNK_TYPE.TABLE_PARENT_CONTEXT,
        parent_chunk_id: null, raw_text: parentLines, embed_text: embedText(document, ADAPTIVE_CHUNK_TYPE.TABLE_PARENT_CONTEXT, tableContext.sectionTitle.value ? [tableContext.sectionTitle.value] : [], parentLines),
        tokenizer: { name: "unicode-word-punct", version: "1.0.0" }, token_count: tokenizeWithOffsets(parentLines).length, embed_token_count: tokenizeWithOffsets(parentLines).length,
        source_node_ids: [node.node_id], source_section_ids: rowSegments[0].sectionIds, section_path: rowSegments[0].sectionPath,
        source_locator: parentSpan.source_locator, source_spans: [parentSpan], content_sha256: parentSha,
        duplicate_group_id: `duplicate_${parentSha.slice(0, 24)}`, repeated_section: false,
        metadata: chunkMetadata(record, document, eligibility, { retrieval_eligible: false, fact_eligible: false, index_role: "CONTEXT_ONLY", table_node_id: node.node_id }),
      });
    }
  }

  return [...adaptedBaseChunks, ...tableChunks];
}
