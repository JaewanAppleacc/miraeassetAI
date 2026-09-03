// Turn AC-IMPL, section G: locator provenance for Fixed-512 chunks.
//
// domain/chunking/chunker.mjs's own chunkFixed() already records, per
// chunk, the FULL ordered list of contributing DocumentIR node-level spans
// (`chunk.source_spans`, each `{file_id, rel_path, node_id, order_index,
// row_start, row_end, col_start, col_end, source_locator}` -- see
// chunker.mjs's makeSpan/mergeSpans) -- never just one arbitrarily-picked
// "representative" node. scripts/p11f0-corpus-discovery.mjs persists this
// full array into disclosure_reference.reference_fixed_kure_chunk_staging
// (006 migration's own `source_spans jsonb` column), and that staging
// table is never deleted after materialization (see
// fixed-kure-bm25-index.mjs's own header for why).
//
// What is NOT persisted anywhere: each span's own node-local TEXT, or the
// character offset at which that node's text starts/ends inside the
// chunk's own `raw_text` ("\n"-joined at chunk-build time, chunker.mjs's
// concatenateSegments -- see that separator's own note there). Without
// that offset, a chunk that merges N>1 source nodes cannot be reduced to
// ONE verified node_index for an arbitrary slot-match span -- doing so
// would be exactly the "대표 node를 임의 선택" (arbitrarily pick a
// representative node) vFINAL section G forbids. This module never does
// that: a multi-node chunk is classified MULTI_NODE_AMBIGUOUS, with the
// full candidate list attached, instead of silently narrowing to one guess.
//
// Measured against the existing 1,144-chunk validation shard
// (fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583): only 12/1144
// (1.05%) chunks are single-span (unambiguously resolvable); 1,132/1144
// (98.95%) are multi-span (2 to 36 contributing nodes). This is why this
// Turn's overall readiness() reports A_C_LOCATOR_PROVENANCE_NOT_READY --
// see arm-retriever-adapter.mjs.

export const LOCATOR_STATUS = Object.freeze({
  EMPTY_SPANS_INVALID: "EMPTY_SPANS_INVALID",
  NODE_AND_ROW_RESOLVED: "NODE_AND_ROW_RESOLVED",
  NODE_RESOLVED_ROW_AMBIGUOUS: "NODE_RESOLVED_ROW_AMBIGUOUS",
  MULTI_NODE_AMBIGUOUS: "MULTI_NODE_AMBIGUOUS",
});

function uniqueValues(values) {
  return [...new Set(values)];
}

// spans: chunk.source_spans (or the persisted `source_spans` jsonb column,
// parsed) -- an ordered array, document order preserved (chunker.mjs's own
// mergeSpans is a stable, first-occurrence-order uniqueBy). Never mutates
// its input.
export function classifySpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) {
    return Object.freeze({
      status: LOCATOR_STATUS.EMPTY_SPANS_INVALID,
      node_index: null, row: null, col: null, is_table: false,
      locator: null, candidate_node_indices: [], candidate_spans: [],
    });
  }
  const nodeIndices = uniqueValues(spans.map((s) => s.order_index));
  const isTable = spans.some((s) => s.row_start !== null && s.row_start !== undefined);
  if (nodeIndices.length > 1) {
    return Object.freeze({
      status: LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS,
      node_index: null, row: null, col: null, is_table: isTable,
      // The chunk-level locator (chunker.mjs's spans[0].source_locator) is
      // still surfaced for continuity with the existing runtime contract,
      // but callers must not treat it as THE resolved node -- it is only
      // the first candidate in document order, explicitly labeled as such.
      locator: spans[0].source_locator, candidate_node_indices: nodeIndices,
      candidate_spans: spans.map((s) => Object.freeze({ ...s })),
    });
  }
  const rows = uniqueValues(spans.map((s) => (s.row_start === null || s.row_start === undefined ? null : `${s.row_start}-${s.row_end}`)));
  if (isTable && rows.length > 1) {
    return Object.freeze({
      status: LOCATOR_STATUS.NODE_RESOLVED_ROW_AMBIGUOUS,
      node_index: nodeIndices[0], row: null, col: null, is_table: true,
      locator: spans[0].source_locator, candidate_node_indices: nodeIndices,
      candidate_spans: spans.map((s) => Object.freeze({ ...s })),
    });
  }
  const resolved = spans[0];
  return Object.freeze({
    status: LOCATOR_STATUS.NODE_AND_ROW_RESOLVED,
    node_index: resolved.order_index,
    row: resolved.row_start ?? null,
    col: resolved.col_start ?? null,
    is_table: isTable,
    locator: resolved.source_locator,
    candidate_node_indices: nodeIndices,
    candidate_spans: spans.map((s) => Object.freeze({ ...s })),
  });
}

// Aggregate classifySpans() over every staging row of one load session --
// used by readiness() to report a measured (not assumed) provenance
// coverage fraction. `rows`: [{ source_spans }] (already-parsed JS arrays,
// e.g. from `SELECT source_spans FROM reference_fixed_kure_chunk_staging
// WHERE load_session_id = $1`).
export function summarizeLocatorCoverage(rows) {
  const counts = {
    [LOCATOR_STATUS.EMPTY_SPANS_INVALID]: 0,
    [LOCATOR_STATUS.NODE_AND_ROW_RESOLVED]: 0,
    [LOCATOR_STATUS.NODE_RESOLVED_ROW_AMBIGUOUS]: 0,
    [LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS]: 0,
  };
  for (const row of rows) counts[classifySpans(row.source_spans).status] += 1;
  const total = rows.length;
  const fullyResolved = counts[LOCATOR_STATUS.NODE_AND_ROW_RESOLVED];
  return Object.freeze({
    total_chunks: total,
    counts: Object.freeze(counts),
    fully_resolved_fraction: total === 0 ? 0 : fullyResolved / total,
    all_fully_resolved: total > 0 && fullyResolved === total,
  });
}

// Identity verification for fetch_node(doc_id, node_index): confirms the
// requested node actually appears among a chunk's own persisted spans --
// fail-closed (returns found:false) rather than fabricating a match. This
// verifies LOCATOR identity (node_id/order_index/row/col consistency), not
// the node's own original text -- that text is never persisted separately
// from chunk-level raw_text (see this file's header). Callers must not
// read node_text as a verified verbatim quote of the source document.
export function verifyNodeIdentity({ documentId, nodeIndex, chunkRows }) {
  const matches = [];
  for (const row of chunkRows) {
    const spans = Array.isArray(row.source_spans) ? row.source_spans : [];
    for (const span of spans) {
      if (span.order_index === nodeIndex) {
        matches.push(Object.freeze({ chunk_id: row.chunk_id, span: Object.freeze({ ...span }) }));
      }
    }
  }
  if (matches.length === 0) {
    return Object.freeze({
      found: false, document_id: documentId, node_index: nodeIndex,
      matches: [], node_text_available: false, node_text: null,
    });
  }
  const locators = uniqueValues(matches.map((m) => m.span.source_locator.replace(/;row=\d+-\d+;col=\d+-\d+$/, "")));
  return Object.freeze({
    found: true, document_id: documentId, node_index: nodeIndex,
    matches: Object.freeze(matches),
    locator_consistent: locators.length === 1,
    // Never fabricated: the underlying DocumentIR node text is not
    // persisted independently of chunk-level raw_text in this loader, so
    // this is always false/null rather than a guessed substring.
    node_text_available: false, node_text: null,
  });
}
