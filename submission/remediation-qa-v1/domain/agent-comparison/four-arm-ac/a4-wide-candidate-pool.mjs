// A4 광역 후보 풀.
//
// 이미 계산된 순위 목록 셋 — Arm A의 기존 공식 top-20, BM25 top-100 leg, KURE dense top-100
// leg — 를 chunk_id 기준으로 합집합·중복 제거하는 순수 결정론 모듈. 검색기·DB·임베딩 모델·
// 재정렬기를 호출하지 않고, A를 재실행하지 않으며, 반환 전에 자체 출력을 절단하지 않는다.
// Arm A의 frozen 출력은 읽기만 하고(세 입력 중 하나) 어디서도 수정하지 않는다.
//
// 각 입력 레코드의 순위는 배열 내 위치가 아니라 명시적 `rank` 필드다 — 풀 구성은 입력 배열
// 나열 순서가 아니라 각 레코드의 선언된 identity/rank/score에만 의존한다.

export const A4_WIDE_POOL_VERSION = "fourarm.a4-wide-candidate-pool.v1";

// vFINAL section E / arm-retriever-adapter.mjs's own BM25_TOP_K=100,
// RRF_K_CONSTANT=60 -- reproduced here as fixed constants (not re-derived,
// not configurable per call) so a caller cannot silently change the
// per-question candidate budget by passing a different k.
export const BM25_CANDIDATE_K = 100;
export const ORIGINAL_DENSE_CANDIDATE_K = 20;
export const WIDE_DENSE_CANDIDATE_K = 100;
export const RRF_CONSTANT = 60;
export const ORIGINAL_OUTPUT_K = 20;

export class WideCandidatePoolInputError extends TypeError {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WideCandidatePoolInputError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(message, code, details) {
  throw new WideCandidatePoolInputError(message, code, details);
}

// ---------------------------------------------------------------------------
// Fixed, explicit tie-break: plain codepoint (lexicographic) string order on
// chunk_id, never locale-sensitive collation. Used both for RRF-score ties
// and for the pool's own final array order.
// ---------------------------------------------------------------------------

function compareChunkId(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Input record validation -- fail-closed on any malformed record.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNodeIndicesArray(value) {
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}

// listName: "original_a_top20" | "bm25_top100" | "dense_top100"
// requireScore: bm25/dense legs must carry a numeric score; original_a_top20
// does not (it is informational only -- this module recomputes A's RRF
// score independently rather than trusting a passed-through value).
function validateRecord(record, listName, index, { requireScore }) {
  if (!isPlainObject(record)) {
    fail(`${listName}[${index}] must be a plain object`, "RECORD_NOT_OBJECT", { listName, index });
  }
  if (typeof record.chunk_id !== "string" || record.chunk_id === "") {
    fail(`${listName}[${index}].chunk_id must be a non-empty string`, "CHUNK_ID_INVALID", { listName, index });
  }
  if (typeof record.document_id !== "string" || record.document_id === "") {
    fail(`${listName}[${index}].document_id must be a non-empty string`, "DOCUMENT_ID_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.text !== null && typeof record.text !== "string") {
    fail(`${listName}[${index}].text must be a string or null`, "TEXT_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (typeof record.chunk_text_sha256 !== "string" || record.chunk_text_sha256 === "") {
    fail(`${listName}[${index}].chunk_text_sha256 must be a non-empty string`, "SHA256_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.node_index !== null && !Number.isInteger(record.node_index)) {
    fail(`${listName}[${index}].node_index must be an integer or null`, "NODE_INDEX_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.node_indices !== undefined && !isNodeIndicesArray(record.node_indices)) {
    fail(`${listName}[${index}].node_indices must be an integer array`, "NODE_INDICES_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.locator !== undefined && record.locator !== null && !isPlainObject(record.locator)) {
    fail(`${listName}[${index}].locator must be an object or null`, "LOCATOR_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.provenance !== undefined && record.provenance !== null && !isPlainObject(record.provenance)) {
    fail(`${listName}[${index}].provenance must be an object or null`, "PROVENANCE_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.metadata !== undefined && record.metadata !== null && !isPlainObject(record.metadata)) {
    fail(`${listName}[${index}].metadata must be an object or null`, "METADATA_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (!Number.isInteger(record.rank) || record.rank < 1) {
    fail(`${listName}[${index}].rank must be a positive integer`, "RANK_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (requireScore && !isFiniteNumber(record.score)) {
    fail(`${listName}[${index}].score must be a finite number`, "SCORE_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
  if (record.score !== undefined && record.score !== null && !isFiniteNumber(record.score)) {
    fail(`${listName}[${index}].score must be a finite number when provided`, "SCORE_INVALID", { listName, index, chunk_id: record.chunk_id });
  }
}

// Validates: array type, per-record shape, per-array chunk_id uniqueness,
// per-array rank uniqueness, and capacity. Ranks need not be a contiguous
// 1..length run -- a caller may legitimately supply a partial/sparse
// representative subset of a ranked list (e.g. a test fixture, or a leg
// that returned fewer eligible candidates than its capacity) as long as no
// two records claim the same rank and no rank exceeds the fixed capacity.
function validateList(list, listName, { capacity, requireScore }) {
  if (!Array.isArray(list)) fail(`${listName} must be an array`, "LIST_NOT_ARRAY", { listName });
  if (list.length > capacity) {
    fail(`${listName} has ${list.length} entries, more than the fixed capacity ${capacity}`, "LIST_EXCEEDS_CAPACITY", { listName, actual: list.length, capacity });
  }
  const seenChunkIds = new Set();
  const seenRanks = new Set();
  list.forEach((record, index) => {
    validateRecord(record, listName, index, { requireScore });
    if (seenChunkIds.has(record.chunk_id)) {
      fail(`${listName} contains chunk_id "${record.chunk_id}" more than once`, "DUPLICATE_CHUNK_ID_IN_LIST", { listName, chunk_id: record.chunk_id });
    }
    seenChunkIds.add(record.chunk_id);
    if (seenRanks.has(record.rank)) {
      fail(`${listName} contains rank ${record.rank} more than once`, "DUPLICATE_RANK_IN_LIST", { listName, rank: record.rank });
    }
    seenRanks.add(record.rank);
    if (record.rank > capacity) {
      fail(`${listName}[${index}].rank=${record.rank} exceeds the fixed capacity ${capacity}`, "RANK_EXCEEDS_CAPACITY", { listName, index, rank: record.rank, capacity });
    }
  });
}

// ---------------------------------------------------------------------------
// RRF: contribution = 1 / (RRF_CONSTANT + rank) per leg the chunk appears
// in, summed across legs -- a leg the chunk is absent from contributes 0
// (never drops the chunk, matching arm A's own HYBRID_UNION_RRF semantics).
// ---------------------------------------------------------------------------

function rrfContribution(rank) {
  return 1 / (RRF_CONSTANT + rank);
}

// legRankById: array of Map<chunk_id, rank>, one per leg. Returns a Map
// chunk_id -> { score, rank } where rank is the 1-based position after
// sorting by score desc, tie-break by chunk_id ascending. Only chunk_ids
// present in at least one leg are included.
function fuseRrf(legRankMaps) {
  const scoreById = new Map();
  for (const legMap of legRankMaps) {
    for (const [chunkId, rank] of legMap) {
      scoreById.set(chunkId, (scoreById.get(chunkId) ?? 0) + rrfContribution(rank));
    }
  }
  const ordered = [...scoreById.entries()].sort((a, b) => (b[1] - a[1]) || compareChunkId(a[0], b[0]));
  const result = new Map();
  ordered.forEach(([chunkId, score], index) => {
    result.set(chunkId, Object.freeze({ score, rank: index + 1 }));
  });
  return result;
}

function toRankMap(list) {
  return new Map(list.map((r) => [r.chunk_id, r.rank]));
}

// ---------------------------------------------------------------------------
// Base-field merge across duplicate chunk_id occurrences. Priority order:
// original_a_top20 > bm25_top100 > dense_top100 (A's own official record is
// the most authoritative source for descriptive fields). node_indices is
// the one exception: it is the UNION of every occurrence's node_index/
// node_indices, sorted ascending and deduplicated, so multi-node provenance
// is never narrowed by which list happened to carry it.
// ---------------------------------------------------------------------------

function firstNonNull(values) {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function mergeNodeIndices(records) {
  const set = new Set();
  for (const r of records) {
    if (Number.isInteger(r.node_index)) set.add(r.node_index);
    if (Array.isArray(r.node_indices)) for (const n of r.node_indices) set.add(n);
  }
  return Object.freeze([...set].sort((a, b) => a - b));
}

// records: already sorted by caller into fixed priority order
// (original_a_top20 > bm25_top100 > dense_top100 -- see priorityOrder at
// the call site). node_index is picked by that SAME priority order (the
// first occurrence that actually declares a non-null node_index wins),
// never by numeric magnitude -- frozen arm A's own representative
// node_index for a chunk is not necessarily the smallest node in that
// chunk's merged node_indices set, and this function must never silently
// swap it for a different (even if numerically smaller) node just because
// a BM25/dense occurrence also touched that chunk. node_indices itself is
// unaffected: it stays the full sorted/deduplicated union of every
// occurrence's node_index/node_indices, regardless of which one becomes
// the representative node_index.
function mergeBaseFields(records) {
  const documentIds = [...new Set(records.map((r) => r.document_id))];
  if (documentIds.length > 1) {
    fail(
      `chunk_id "${records[0].chunk_id}" has conflicting document_id values across input lists: ${JSON.stringify(documentIds)}`,
      "DOCUMENT_ID_CONFLICT", { chunk_id: records[0].chunk_id, document_ids: documentIds },
    );
  }
  const shas = [...new Set(records.map((r) => r.chunk_text_sha256))];
  if (shas.length > 1) {
    fail(
      `chunk_id "${records[0].chunk_id}" has conflicting chunk_text_sha256 values across input lists: ${JSON.stringify(shas)}`,
      "CHUNK_TEXT_SHA256_CONFLICT", { chunk_id: records[0].chunk_id, sha256_values: shas },
    );
  }

  const nodeIndices = mergeNodeIndices(records);
  // Priority: original_a_top20's own node_index first, then bm25's, then
  // dense's (the order `records` already arrives in); only when NONE of
  // the occurrences declares a node_index do we fall back to the smallest
  // member of the merged set.
  const preferredNodeIndex = firstNonNull(records.map((r) => (Number.isInteger(r.node_index) ? r.node_index : null)));
  const nodeIndex = preferredNodeIndex !== null ? preferredNodeIndex : (nodeIndices.length > 0 ? nodeIndices[0] : null);
  if (nodeIndex !== null && !nodeIndices.includes(nodeIndex)) {
    fail(
      `chunk_id "${records[0].chunk_id}" selected node_index ${nodeIndex} is not a member of its own merged node_indices ${JSON.stringify(nodeIndices)}`,
      "NODE_INDEX_NOT_IN_NODE_INDICES", { chunk_id: records[0].chunk_id, node_index: nodeIndex, node_indices: nodeIndices },
    );
  }

  return Object.freeze({
    chunk_id: records[0].chunk_id,
    document_id: documentIds[0],
    text: firstNonNull(records.map((r) => r.text)),
    chunk_text_sha256: shas[0],
    node_index: nodeIndex,
    node_indices: nodeIndices,
    locator: firstNonNull(records.map((r) => r.locator ?? null)) ?? Object.freeze({}),
    provenance: firstNonNull(records.map((r) => r.provenance ?? null)) ?? Object.freeze({}),
    metadata: firstNonNull(records.map((r) => r.metadata ?? null)) ?? Object.freeze({}),
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// original_a_top20: arm A's existing, unmodified official top-
// ORIGINAL_OUTPUT_K result, each record carrying its own official `rank`
// (1..20). Read-only input -- this function never mutates or re-derives A's
// actual returned order; it only verifies (see below) that A's order is
// reproducible from bm25_top100 + dense_top100's own top-
// ORIGINAL_DENSE_CANDIDATE_K subset via the same RRF formula, and includes
// every one of A's candidates in the pool unconditionally.
//
// bm25_top100: the BM25 leg's own ranked list (up to BM25_CANDIDATE_K).
// dense_top100: the KURE dense leg's own WIDE ranked list (up to
// WIDE_DENSE_CANDIDATE_K) -- its own rank-1..ORIGINAL_DENSE_CANDIDATE_K
// subset is what A's original retrieval actually saw.
//
// Every record in every list carries the common candidate base fields
// (chunk_id, document_id, text, chunk_text_sha256, node_index,
// node_indices, locator, provenance, metadata) plus its own `rank` (and,
// for bm25/dense, `score`) -- see A4_WIDE_CANDIDATE_POOL_V1_CONTRACT.md.
//
// Returns { pool, diagnostics } where `pool` is the deduplicated,
// chunk_id-ascending-sorted A4 candidate array (never truncated) and
// `diagnostics` records the fixed config this call used.
export function buildWideCandidatePool({ original_a_top20, bm25_top100, dense_top100 } = {}) {
  validateList(original_a_top20 ?? [], "original_a_top20", { capacity: ORIGINAL_OUTPUT_K, requireScore: false });
  validateList(bm25_top100 ?? [], "bm25_top100", { capacity: BM25_CANDIDATE_K, requireScore: true });
  validateList(dense_top100 ?? [], "dense_top100", { capacity: WIDE_DENSE_CANDIDATE_K, requireScore: true });

  const originalATop20 = original_a_top20 ?? [];
  const bm25Top100 = bm25_top100 ?? [];
  const denseTop100 = dense_top100 ?? [];

  const originalDenseSubset = denseTop100.filter((r) => r.rank <= ORIGINAL_DENSE_CANDIDATE_K);

  // Two independent RRF fusions over the SAME bm25 leg: one restricted to
  // the dense leg's own original top-ORIGINAL_DENSE_CANDIDATE_K subset
  // (reproducing exactly what A's original retrieval computed), one over
  // the full wide dense leg (diagnostic only, never the final ranking).
  const originalARrf = fuseRrf([toRankMap(bm25Top100), toRankMap(originalDenseSubset)]);
  const wideRrf = fuseRrf([toRankMap(bm25Top100), toRankMap(denseTop100)]);

  // Reproduction check: if A's own official top-20 was given, the
  // recomputed original-A RRF order's leading entries must match it
  // exactly (same chunk_ids, same order) -- any divergence means the
  // bm25/dense legs supplied here are not the ones A's actual retrieval
  // used, which is a caller data-consistency bug, not a case to paper over.
  if (originalATop20.length > 0) {
    const givenOrder = [...originalATop20].sort((a, b) => a.rank - b.rank).map((r) => r.chunk_id);
    const recomputedOrder = [...originalARrf.entries()]
      .sort((a, b) => a[1].rank - b[1].rank)
      .slice(0, givenOrder.length)
      .map(([chunkId]) => chunkId);
    if (JSON.stringify(givenOrder) !== JSON.stringify(recomputedOrder)) {
      fail(
        "original_a_top20 is not reproducible from bm25_top100 + dense_top100's own top-"
        + `${ORIGINAL_DENSE_CANDIDATE_K} subset via RRF(k=${RRF_CONSTANT}) -- given ${JSON.stringify(givenOrder)}, recomputed ${JSON.stringify(recomputedOrder)}`,
        "ORIGINAL_A_RRF_NOT_REPRODUCIBLE", { given: givenOrder, recomputed: recomputedOrder },
      );
    }
  }

  // Union across all three lists, keyed by chunk_id.
  const byChunkId = new Map();
  const track = (record, listName) => {
    if (!byChunkId.has(record.chunk_id)) byChunkId.set(record.chunk_id, []);
    byChunkId.get(record.chunk_id).push({ record, listName });
  };
  for (const r of originalATop20) track(r, "original_a_top20");
  for (const r of bm25Top100) track(r, "bm25_top100");
  for (const r of denseTop100) track(r, "dense_top100");

  const bm25RankMap = toRankMap(bm25Top100);
  const bm25ScoreMap = new Map(bm25Top100.map((r) => [r.chunk_id, r.score]));
  const denseRankMap = toRankMap(denseTop100);
  const denseScoreMap = new Map(denseTop100.map((r) => [r.chunk_id, r.score]));

  const pool = [];
  for (const [chunkId, occurrences] of byChunkId) {
    // Priority order for descriptive-field merge: original_a_top20 first,
    // then bm25_top100, then dense_top100 -- never dependent on the order
    // occurrences happen to have been pushed above (that order is fixed by
    // this function's own source code, not by caller input order).
    const priorityOrder = { original_a_top20: 0, bm25_top100: 1, dense_top100: 2 };
    const orderedRecords = [...occurrences]
      .sort((a, b) => priorityOrder[a.listName] - priorityOrder[b.listName])
      .map((o) => o.record);
    const base = mergeBaseFields(orderedRecords);

    const inOriginalA = occurrences.some((o) => o.listName === "original_a_top20");
    const inBm25 = bm25RankMap.has(chunkId);
    const inDense = denseRankMap.has(chunkId);

    const originalAEntry = originalARrf.get(chunkId) ?? null;
    const wideEntry = wideRrf.get(chunkId) ?? null;

    pool.push(Object.freeze({
      ...base,
      source_membership: Object.freeze({
        original_a_top20: inOriginalA,
        bm25_top100: inBm25,
        dense_top100: inDense,
      }),
      source_ranks: Object.freeze({
        original_a: originalAEntry ? originalAEntry.rank : null,
        bm25: inBm25 ? bm25RankMap.get(chunkId) : null,
        dense: inDense ? denseRankMap.get(chunkId) : null,
        wide_rrf: wideEntry ? wideEntry.rank : null,
      }),
      source_scores: Object.freeze({
        bm25: inBm25 ? bm25ScoreMap.get(chunkId) : null,
        dense: inDense ? denseScoreMap.get(chunkId) : null,
        original_a_rrf: originalAEntry ? originalAEntry.score : null,
        wide_rrf: wideEntry ? wideEntry.score : null,
      }),
    }));
  }

  // Final, canonical order: chunk_id ascending. Independent of any input
  // array's order and independent of Map/Set iteration order above --
  // guarantees byte-identical output regardless of input array ordering.
  // This is NOT a ranking; wide_rrf_rank (or original_a for A-comparable
  // ranking) must be read from each item's own source_ranks field.
  pool.sort((a, b) => compareChunkId(a.chunk_id, b.chunk_id));

  return Object.freeze({
    pool: Object.freeze(pool),
    diagnostics: Object.freeze({
      version: A4_WIDE_POOL_VERSION,
      bm25_candidate_k: BM25_CANDIDATE_K,
      original_dense_candidate_k: ORIGINAL_DENSE_CANDIDATE_K,
      wide_dense_candidate_k: WIDE_DENSE_CANDIDATE_K,
      rrf_constant: RRF_CONSTANT,
      original_output_k: ORIGINAL_OUTPUT_K,
      pool_size: pool.length,
      original_a_top20_count: originalATop20.length,
      bm25_top100_count: bm25Top100.length,
      dense_top100_count: denseTop100.length,
    }),
  });
}
