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
// (98.95%) are multi-span (2 to 36 contributing nodes).
//
// Turn AC-LOCATOR-READY: that ~99% multi-span figure is NOT provenance
// loss -- it is the expected shape of Fixed-512 token-window chunking over
// concatenated DocumentIR segments (chunker.mjs's tokenWindowsFromSegments
// slides a fixed token window across many rows/nodes at once, by design).
// The prior Turn's readiness() gated official_experiment_ready on
// `all_fully_resolved` (100% single-node+row), which conflated legitimate
// multi-row/multi-node ambiguity with an actual defect. This Turn corrects
// that: readiness now gates on `provenance_ready` (every chunk has SOME
// interpretable, non-empty candidate set -- see summarizeLocatorCoverage
// and buildProvenanceSet below); a chunk's candidate list is exposed in
// full (buildProvenanceSet/buildDownstreamExpansionInput) so a downstream
// claim/evidence step can call fetch_node() per candidate rather than this
// module ever guessing one. `all_fully_resolved` remains available as an
// observability-only measurement, not a gate. See arm-retriever-adapter.mjs.

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
//
// `all_fully_resolved`/`fully_resolved_fraction` are kept as
// OBSERVABILITY-ONLY measurements (how many chunks happen to reduce to a
// single node+row) -- they are NOT a readiness gate. A Fixed-512 chunk that
// legitimately spans multiple table rows (same node) or multiple nodes is
// not a defect: chunkFixed() concatenates DocumentIR segments and slides a
// fixed token window across them (chunker.mjs's tokenWindowsFromSegments),
// so a chunk crossing row/node boundaries is expected, structural output,
// not lost provenance. The actual readiness gate is `provenance_ready`:
// every chunk must have an INTERPRETABLE provenance set (single-candidate
// or multi-candidate) -- only EMPTY_SPANS_INVALID (no persisted spans at
// all, e.g. a parser/loader join failure) is a genuine gap, isolated here
// as `unresolved_count` rather than conflated with legitimate ambiguity.
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
  const unresolvedCount = counts[LOCATOR_STATUS.EMPTY_SPANS_INVALID];
  const ambiguousCount = counts[LOCATOR_STATUS.NODE_RESOLVED_ROW_AMBIGUOUS] + counts[LOCATOR_STATUS.MULTI_NODE_AMBIGUOUS];
  return Object.freeze({
    total_chunks: total,
    counts: Object.freeze(counts),
    fully_resolved_fraction: total === 0 ? 0 : fullyResolved / total,
    all_fully_resolved: total > 0 && fullyResolved === total,
    unresolved_count: unresolvedCount,
    ambiguous_count: ambiguousCount,
    // The real readiness gate: every chunk resolved to SOME interpretable
    // provenance set (candidate list of 1+), zero chunks with none at all.
    // Multi-row/multi-node ambiguity does not fail this -- see header note.
    provenance_ready: total > 0 && unresolvedCount === 0,
  });
}

// Deterministic, deduplicated candidate list for downstream node-grounded
// disambiguation (Section C.2/C.3): a chunk with N contributing spans keeps
// ALL N candidates (never collapsed to one arbitrary "representative"),
// deduplicated by (node identity + row/col) and in the spans' own
// document-order (chunker.mjs's mergeSpans is itself a stable, first-
// occurrence-order uniqueBy, so no re-sort is applied here -- re-sorting
// could itself introduce a fabricated ordering not present in the source).
function dedupeCandidates(spans) {
  const seen = new Set();
  const candidates = [];
  for (const span of spans) {
    const key = JSON.stringify([span.node_id, span.order_index, span.row_start, span.row_end, span.col_start, span.col_end]);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(Object.freeze({
      node_index: span.order_index,
      node_id: span.node_id,
      row_start: span.row_start ?? null,
      row_end: span.row_end ?? null,
      col_start: span.col_start ?? null,
      col_end: span.col_end ?? null,
      source_locator: span.source_locator,
      is_table: span.row_start !== null && span.row_start !== undefined,
    }));
  }
  return Object.freeze(candidates);
}

// The occurrence-level provenance sidecar (Section C.1): built purely from
// the already-persisted `source_spans` -- reads chunk text/embeddings
// nowhere, mutates nothing. Safe to attach to every A/C search() result
// item without touching the frozen chunk_id/raw_text/embedding contract.
export function buildProvenanceSet(spans) {
  const resolution = classifySpans(spans);
  const unresolved = resolution.status === LOCATOR_STATUS.EMPTY_SPANS_INVALID;
  return Object.freeze({
    status: resolution.status,
    unresolved,
    unresolved_reason: unresolved ? "NO_SOURCE_SPANS_PERSISTED" : null,
    resolved: resolution.status === LOCATOR_STATUS.NODE_AND_ROW_RESOLVED
      ? Object.freeze({ node_index: resolution.node_index, row: resolution.row, col: resolution.col, locator: resolution.locator })
      : null,
    candidates: unresolved ? Object.freeze([]) : dedupeCandidates(spans),
    candidate_count: unresolved ? 0 : dedupeCandidates(spans).length,
    is_table: resolution.is_table,
  });
}

// Ready-to-call fetch_node() input for node-grounded late expansion
// (Section C.4): one {doc_id, node_index} pair per distinct candidate node,
// document order preserved, deduplicated. A downstream claim/evidence step
// calls fetch_node() once per pair to verify which node the actual evidence
// came from -- this module never picks one for it.
export function buildDownstreamExpansionInput(documentId, provenanceSet) {
  const seenNodes = new Set();
  const pairs = [];
  for (const candidate of provenanceSet.candidates) {
    if (seenNodes.has(candidate.node_index)) continue;
    seenNodes.add(candidate.node_index);
    pairs.push(Object.freeze({ doc_id: documentId, node_index: candidate.node_index }));
  }
  return Object.freeze(pairs);
}

// Identity verification for fetch_node(doc_id, node_index): confirms the
// requested node actually appears among a chunk's own persisted spans --
// fail-closed (returns found:false) rather than fabricating a match. This
// verifies LOCATOR identity (node_id/order_index/row/col consistency), not
// the node's own original text -- that text is never persisted separately
// from chunk-level raw_text (see this file's header). Callers must not
// read node_text as a verified verbatim quote of the source document.
// `row`/`col`, when supplied, add a further fail-closed check: a candidate
// must not just be the right node, it must be the right row/column too --
// a caller cannot claim row=5 exists in a node whose persisted spans only
// ever covered rows 0-2. Omitting them keeps the original node-only check.
export function verifyNodeIdentity({ documentId, nodeIndex, row = null, col = null, chunkRows }) {
  const matches = [];
  for (const chunkRow of chunkRows) {
    const spans = Array.isArray(chunkRow.source_spans) ? chunkRow.source_spans : [];
    for (const span of spans) {
      if (span.order_index !== nodeIndex) continue;
      if (row !== null && !(span.row_start !== null && span.row_start !== undefined && span.row_start <= row && row <= span.row_end)) continue;
      if (col !== null && !(span.col_start !== null && span.col_start !== undefined && span.col_start <= col && col <= span.col_end)) continue;
      matches.push(Object.freeze({ chunk_id: chunkRow.chunk_id, span: Object.freeze({ ...span }) }));
    }
  }
  if (matches.length === 0) {
    return Object.freeze({
      found: false, document_id: documentId, node_index: nodeIndex, row, col,
      matches: [], node_text_available: false, node_text: null,
    });
  }
  const locators = uniqueValues(matches.map((m) => m.span.source_locator.replace(/;row=\d+-\d+;col=\d+-\d+$/, "")));
  return Object.freeze({
    found: true, document_id: documentId, node_index: nodeIndex, row, col,
    matches: Object.freeze(matches),
    locator_consistent: locators.length === 1,
    // Never fabricated: the underlying DocumentIR node text is not
    // persisted independently of chunk-level raw_text in this loader, so
    // this is always false/null rather than a guessed substring.
    node_text_available: false, node_text: null,
  });
}
