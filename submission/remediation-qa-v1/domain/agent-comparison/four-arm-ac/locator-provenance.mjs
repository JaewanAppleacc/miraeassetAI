// Fixed-512 청크의 locator 출처(provenance) 해석.
//
// chunker.mjs의 chunkFixed()는 청크마다 기여한 DocumentIR 노드 span 전체 목록
// (chunk.source_spans)을 기록한다 — 임의로 고른 대표 노드 하나가 아니다. 반면 각 span의
// 노드별 본문이나 청크 raw_text 안에서의 문자 오프셋은 영속되지 않으므로, 여러 노드를 합친
// 청크를 임의 span 하나로 축소하는 것은 금지된 "대표 node 임의 선택"이 된다. 이 모듈은 그
// 축소를 하지 않는다: 다중 노드 청크는 MULTI_NODE_AMBIGUOUS로 분류하고 후보 목록 전체를
// 붙여 돌려준다.
//
// Fixed-512 토큰 창 청킹에서 다중 span은 결함이 아니라 기대되는 모양이다(실측: 검증 샤드
// 1,144청크 중 98.95%가 노드 2~36개 기여). readiness는 전 청크가 해석 가능한 비어 있지
// 않은 후보 집합을 갖는지(provenance_ready)로 판정하고, 하류 단계가 후보별로 fetch_node()
// 를 호출하게 한다. all_fully_resolved는 관측용 지표로만 남는다.

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
