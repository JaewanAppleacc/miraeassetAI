// Turn P5: deterministic, DocumentIR-node-first chunking policy.
//
// Rule order (see domain/HANDOFF.md / the Turn P5 task brief for the full
// principle list this implements):
//   1. domain/interfaces/document-ir.schema.json's own `blocks[]` (already
//      produced by the existing, unmodified domain/adapters/a-document-ir.mjs
//      adapter) is the node boundary this chunker starts from -- it never
//      re-parses raw XML/HTML itself.
//   2. A block whose own text/table fits under `maxChunkChars` becomes
//      exactly one chunk.
//   3. Only a block that does NOT fit is subdivided.
//   4. TABLE blocks are subdivided by whole ROWS -- a row's cells are never
//      split across two chunks (a single oversized row becomes its own
//      chunk rather than being torn apart).
//   5. Non-table text is subdivided at the last newline boundary inside the
//      window if one exists, else the last sentence-ending boundary
//      (`.`/`!`/`?`/full-width `。` followed by whitespace or end-of-text),
//      else a hard character cut at `maxChunkChars` (last resort only).
//   6. `maxChunkChars` / `overlapChars` / `tableMaxChunkChars` are injected
//      via `policy`, never hard-coded in this module's logic.
//   7. Whitespace normalization is exactly: trim leading/trailing
//      whitespace from the emitted `text_content`. Nothing else about the
//      text is altered.
//   8. `char_start`/`char_end` always index into the ORIGINAL (pre-trim)
//      node text (or, for a table, this module's own deterministic
//      row-joined serialization of that table) -- trimming only shrinks
//      `text_content` relative to that span, it never moves the span.
//   9. A node with no extractable text (null/blank `text`, or zero table
//      rows) produces zero chunks -- this chunker never invents content.
//  10. This entire module is a pure function of its inputs: same `blocks` +
//      same `policy` always yields the same chunk boundaries, order, and
//      character offsets, regardless of process, machine, or OS.
import { sha256Hex } from "./contracts.mjs";

export const CHUNKING_POLICY_ID = "document-node-first-v0.1";

export const DEFAULT_CHUNKING_POLICY = Object.freeze({
  chunking_policy_id: CHUNKING_POLICY_ID,
  schema_version: "0.1.0",
  max_chunk_chars: 1200,
  overlap_chars: 150,
  table_max_chunk_chars: 1200,
  whitespace_normalization: "TRIM_LEADING_TRAILING_ONLY",
  boundary_priority: ["NODE", "TABLE_ROW", "NEWLINE", "SENTENCE_END", "HARD_CHAR_CUT"],
  table_row_join: " | ",
  table_row_separator: "\n",
  sentence_boundary_chars: [".", "!", "?", "。"],
});

export function computeChunkingPolicySha256(policy) {
  return sha256Hex(policy);
}

export function assertValidPolicy(policy) {
  if (!Number.isInteger(policy.max_chunk_chars) || policy.max_chunk_chars < 1) {
    throw new TypeError("policy.max_chunk_chars must be a positive integer");
  }
  if (!Number.isInteger(policy.overlap_chars) || policy.overlap_chars < 0) {
    throw new TypeError("policy.overlap_chars must be a non-negative integer");
  }
  if (policy.overlap_chars >= policy.max_chunk_chars) {
    throw new TypeError("policy.overlap_chars must be strictly less than policy.max_chunk_chars (forward progress guarantee)");
  }
  if (!Number.isInteger(policy.table_max_chunk_chars) || policy.table_max_chunk_chars < 1) {
    throw new TypeError("policy.table_max_chunk_chars must be a positive integer");
  }
  return policy;
}

function lastNewlineBoundary(windowStr) {
  const index = windowStr.lastIndexOf("\n");
  return index > 0 ? index + 1 : -1; // include the newline in the earlier chunk
}

function lastSentenceBoundary(windowStr, sentenceChars) {
  let best = -1;
  for (const char of sentenceChars) {
    let searchFrom = windowStr.length;
    for (;;) {
      const index = windowStr.lastIndexOf(char, searchFrom - 1);
      if (index <= 0) break;
      const next = windowStr[index + 1];
      if (next === undefined || /\s/.test(next)) {
        best = Math.max(best, index + 1);
        break;
      }
      searchFrom = index;
    }
  }
  return best;
}

// Pure: fullText -> ordered, non-overlapping-in-content-boundary (may share
// `overlap_chars` of REPEATED text at the seam) list of { start, end }
// spans covering [0, fullText.length). Always makes forward progress.
export function splitTextDeterministic(fullText, policy) {
  const { max_chunk_chars: maxChunkChars, overlap_chars: overlapChars, sentence_boundary_chars: sentenceChars } = policy;
  const n = fullText.length;
  const spans = [];
  let start = 0;
  while (start < n) {
    let end = Math.min(start + maxChunkChars, n);
    if (end < n) {
      const windowStr = fullText.slice(start, end);
      let boundary = lastNewlineBoundary(windowStr);
      if (boundary <= 0) boundary = lastSentenceBoundary(windowStr, sentenceChars);
      if (boundary > 0) end = start + boundary;
    }
    spans.push({ start, end });
    if (end >= n) break;
    const nextStart = end - overlapChars > start ? end - overlapChars : end;
    start = nextStart;
  }
  return spans;
}

function buildTableText(rows, policy) {
  const rowTexts = rows.map((row) => row.map((cell) => String(cell ?? "")).join(policy.table_row_join));
  const rowOffsets = [];
  let pos = 0;
  for (const rowText of rowTexts) {
    rowOffsets.push({ start: pos, end: pos + rowText.length });
    pos += rowText.length + policy.table_row_separator.length;
  }
  return { rowTexts, rowOffsets, fullTableText: rowTexts.join(policy.table_row_separator) };
}

// Pure: rows (array of array-of-cell-strings) -> ordered list of
// { start, end, rowRange: [firstRowIndex, lastRowIndexInclusive] } spans
// into this module's own deterministic row-joined serialization. A row is
// never split; an oversized single row becomes its own (oversized) chunk.
export function packTableRowsDeterministic(rows, policy) {
  if (!Array.isArray(rows) || rows.length === 0) return { spans: [], fullTableText: "" };
  const { rowTexts, rowOffsets, fullTableText } = buildTableText(rows, policy);
  const spans = [];
  let rowStart = 0;
  while (rowStart < rowTexts.length) {
    let rowEnd = rowStart;
    let currentLen = rowTexts[rowStart].length;
    while (rowEnd + 1 < rowTexts.length) {
      const additional = policy.table_row_separator.length + rowTexts[rowEnd + 1].length;
      if (currentLen + additional > policy.table_max_chunk_chars) break;
      rowEnd += 1;
      currentLen += additional;
    }
    spans.push({ start: rowOffsets[rowStart].start, end: rowOffsets[rowEnd].end, rowRange: [rowStart, rowEnd] });
    rowStart = rowEnd + 1;
  }
  return { spans, fullTableText };
}

function tableRowsOf(block) {
  const table = block.table;
  if (!table) return [];
  const header = Array.isArray(table.header_rows) ? table.header_rows : [];
  const body = Array.isArray(table.body_rows) ? table.body_rows : [];
  return [...header, ...body];
}

// Pure: adapted DocumentIR `blocks[]` -> ordered list of raw chunk
// descriptors. Never touches disk, never computes ids/hashes for the
// snapshot itself (that is document-record.mjs's job, one layer up) --
// this module only knows about text/table geometry.
export function chunkBlocks(blocks, rawPolicy = DEFAULT_CHUNKING_POLICY) {
  const policy = assertValidPolicy(rawPolicy);
  const descriptors = [];

  for (const block of blocks) {
    if (block.block_type === "TABLE") {
      const rows = tableRowsOf(block);
      if (rows.length === 0) continue; // rule 9: empty node, no chunk
      const { spans, fullTableText } = packTableRowsDeterministic(rows, policy);
      spans.forEach((span, index) => {
        const rawText = fullTableText.slice(span.start, span.end);
        const trimmed = rawText.trim();
        if (trimmed === "") return; // rule 9, applied per-span defensively
        descriptors.push({
          node_id: block.block_id,
          block_type: block.block_type,
          section_path: block.section_path,
          char_start: span.start,
          char_end: span.end,
          text_content: trimmed,
          node_chunk_index: index,
          node_chunk_count: spans.length,
          table_row_range: span.rowRange,
        });
      });
      continue;
    }

    const fullText = typeof block.text === "string" ? block.text : "";
    if (fullText.trim() === "") continue; // rule 9: empty node, no chunk

    const spans = splitTextDeterministic(fullText, policy);
    spans.forEach((span, index) => {
      const rawText = fullText.slice(span.start, span.end);
      const trimmed = rawText.trim();
      if (trimmed === "") return; // rule 9, applied per-span defensively
      descriptors.push({
        node_id: block.block_id,
        block_type: block.block_type,
        section_path: block.section_path,
        char_start: span.start,
        char_end: span.end,
        text_content: trimmed,
        node_chunk_index: index,
        node_chunk_count: spans.length,
        table_row_range: null,
      });
    });
  }

  return descriptors;
}
