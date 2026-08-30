// Turn P5.2: read-only repository for the EXACT_TEXT_DEDUP_INDEX tables
// added by 004_reference_dedup_retrieval_index.sql. Mirrors
// reference-vector-retrieval-repository.mjs's own conventions exactly:
// every method issues a fresh, parameter-bound SQL statement, a real DB
// failure is never reduced to NOT_FOUND, an already-aborted signal (or one
// that fires mid-query) throws RequestAbortedError, and every returned
// value is a deep-frozen, independent copy.
//
// THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE (see the migration's own
// header comment): search() filters reference_dedup_occurrences by
// corp_code/source_document_id FIRST, narrows the candidate canonical text
// set to only what those filtered occurrences reference, THEN ranks by
// vector similarity and takes the top-K CANONICAL hits, and only THEN
// expands each canonical hit back out to every occurrence that both (a)
// shares that canonical text and (b) already passed the metadata filter.
// It is structurally impossible for this query to rank a canonical row
// using metadata from a document/company that does not actually have a
// matching occurrence, because the canonical table carries no such column
// to filter on in the first place.
import { createHash } from "node:crypto";
import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";

const INDEXES_TABLE = "disclosure_reference.reference_dedup_indexes";
const CANONICAL_TABLE = "disclosure_reference.reference_dedup_canonical_texts";
const OCCURRENCES_TABLE = "disclosure_reference.reference_dedup_occurrences";

export class DedupRetrievalRepositoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "DedupRetrievalRepositoryError";
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required and must be a non-empty string`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

async function checkedQuery(client, signal, sql, params) {
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  const result = await client.query(sql, params);
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  return result;
}

function toPgvectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

// Same convention as reference-vector-retrieval-repository.mjs: ASCENDING
// by the metric's own pgvector distance operator, similarity_score always
// HIGHER-is-better regardless of which metric an index pins.
const METRIC_SQL = Object.freeze({
  cosine: { operator: "<=>", similarityExpr: (col) => `1 - (${col} <=> $QUERY)` },
  l2: { operator: "<->", similarityExpr: (col) => `-(${col} <-> $QUERY)` },
  inner_product: { operator: "<#>", similarityExpr: (col) => `-(${col} <#> $QUERY)` },
});

function assertKnownMetric(distanceMetric) {
  if (!METRIC_SQL[distanceMetric]) throw new DedupRetrievalRepositoryError(`unknown distance_metric: ${distanceMetric}`);
  return METRIC_SQL[distanceMetric];
}

function similarityThresholdToDistanceBound(distanceMetric, similarityThreshold) {
  if (similarityThreshold === undefined || similarityThreshold === null) return null;
  if (distanceMetric === "cosine") return 1 - similarityThreshold;
  if (distanceMetric === "l2") return -similarityThreshold;
  if (distanceMetric === "inner_product") return -similarityThreshold;
  throw new DedupRetrievalRepositoryError(`unknown distance_metric: ${distanceMetric}`);
}

function trimmedIndexRow(row) {
  return deepFreeze({
    retrieval_index_id: row.retrieval_index_id,
    release_id: row.release_id,
    source_snapshot_id: row.source_snapshot_id,
    embedding_provider: row.embedding_provider,
    embedding_model: row.embedding_model,
    embedding_revision: row.embedding_revision,
    embedding_dimension: row.embedding_dimension,
    distance_metric: row.distance_metric,
    chunking_policy_id: row.chunking_policy_id,
    chunking_policy_sha256: row.chunking_policy_sha256,
    index_status: row.index_status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ready_at: row.ready_at instanceof Date ? row.ready_at.toISOString() : row.ready_at,
    canonical_count: row.canonical_count,
    occurrence_count: row.occurrence_count,
    manifest_sha256: row.manifest_sha256,
  });
}

export function createPostgresDedupRetrievalRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client (or pool) is required");

  async function getRetrievalIndex(retrievalIndexId, { signal } = {}) {
    assertNonEmptyString(retrievalIndexId, "retrievalIndexId");
    const result = await checkedQuery(
      client, signal,
      `SELECT retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model,
              embedding_revision, embedding_dimension, distance_metric, chunking_policy_id,
              chunking_policy_sha256, index_status, created_at, ready_at, canonical_count, occurrence_count, manifest_sha256
       FROM ${INDEXES_TABLE} WHERE retrieval_index_id = $1`,
      [retrievalIndexId],
    );
    return result.rows[0] ? trimmedIndexRow(result.rows[0]) : null;
  }

  async function assertReadyRetrievalIndex(retrievalIndexId, expectedPins = {}, { signal } = {}) {
    const index = await getRetrievalIndex(retrievalIndexId, { signal });
    if (!index) throw new DedupRetrievalRepositoryError(`dedup retrieval index "${retrievalIndexId}" was not found`);
    if (index.index_status !== "READY") {
      throw new DedupRetrievalRepositoryError(`dedup retrieval index "${retrievalIndexId}" is not READY (index_status=${index.index_status})`);
    }
    for (const [key, expected] of Object.entries(expectedPins)) {
      if (expected === undefined) continue;
      if (index[key] !== expected) {
        throw new DedupRetrievalRepositoryError(
          `dedup retrieval index "${retrievalIndexId}": ${key} mismatch (expected ${JSON.stringify(expected)}, found ${JSON.stringify(index[key])})`,
        );
      }
    }
    return index;
  }

  function trimmedResultRow(row) {
    return deepFreeze({
      chunk_id: row.chunk_id,
      text_sha256: row.text_sha256,
      source_document_id: row.source_document_id,
      corp_code: row.corp_code,
      source_group: row.source_group,
      document_type: row.document_type,
      node_id: row.node_id,
      source_locator: row.source_locator,
      block_type: row.block_type,
      parse_status: row.parse_status,
      chunk_ordinal: row.chunk_ordinal,
      char_start: row.char_start,
      char_end: row.char_end,
      metadata: structuredClone(row.metadata ?? {}),
      canonical_text: row.canonical_text,
      similarity_score: Number(row.similarity_score),
      retrieval_index_id: row.retrieval_index_id,
      release_id: row.release_id,
      source_snapshot_id: row.source_snapshot_id,
    });
  }

  // metadata-filter-before-top-k search. `topK` bounds the number of
  // DISTINCT canonical texts ranked -- the number of returned ROWS can
  // legitimately exceed topK, because one canonical hit may expand to
  // several occurrences that all separately passed the metadata filter
  // (e.g. the same boilerplate phrase appearing in two of the SAME
  // company's own filings). This is intentional: every returned row is a
  // real, independently citable occurrence, never a synthesized duplicate.
  async function search({
    retrievalIndexId, queryVector, topK,
    corpCodes, documentIds, similarityThreshold, expectedPins,
  }, { signal } = {}) {
    assertNonEmptyString(retrievalIndexId, "retrievalIndexId");
    if (!Array.isArray(queryVector) || queryVector.length === 0) throw new TypeError("queryVector must be a non-empty array of numbers");
    if (!queryVector.every((value) => Number.isFinite(value))) throw new TypeError("queryVector must contain only finite numbers (no NaN/Infinity)");
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new TypeError("topK must be an integer between 1 and 100");

    const index = await assertReadyRetrievalIndex(retrievalIndexId, expectedPins ?? {}, { signal });
    if (queryVector.length !== index.embedding_dimension) {
      throw new DedupRetrievalRepositoryError(
        `queryVector has ${queryVector.length} dimensions, dedup retrieval index "${retrievalIndexId}" expects ${index.embedding_dimension}`,
      );
    }
    const metric = assertKnownMetric(index.distance_metric);
    const distanceBound = similarityThresholdToDistanceBound(index.distance_metric, similarityThreshold);

    const params = [retrievalIndexId, toPgvectorLiteral(queryVector)];
    const occurrenceConditions = ["o.retrieval_index_id = $1"];
    if (Array.isArray(corpCodes) && corpCodes.length > 0) {
      params.push(corpCodes);
      occurrenceConditions.push(`o.corp_code = ANY($${params.length})`);
    }
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      params.push(documentIds);
      occurrenceConditions.push(`o.source_document_id = ANY($${params.length})`);
    }
    const distanceExpr = `c.embedding ${metric.operator} $2::vector`;
    let distanceBoundClause = "";
    if (distanceBound !== null) {
      params.push(distanceBound);
      distanceBoundClause = `AND (${distanceExpr}) <= $${params.length}`;
    }
    params.push(topK);
    const topKParamIndex = params.length;

    const sql = `
      WITH filtered_occurrences AS (
        SELECT o.chunk_id, o.text_sha256, o.source_document_id, o.corp_code, o.source_group, o.document_type,
               o.node_id, o.source_locator, o.block_type, o.parse_status, o.chunk_ordinal, o.char_start, o.char_end, o.metadata
        FROM ${OCCURRENCES_TABLE} o
        WHERE ${occurrenceConditions.join(" AND ")}
      ),
      candidate_canonical AS (
        SELECT DISTINCT c.text_sha256, c.embedding, c.canonical_text
        FROM ${CANONICAL_TABLE} c
        JOIN filtered_occurrences fo ON fo.text_sha256 = c.text_sha256
        WHERE c.retrieval_index_id = $1
      ),
      top_canonical AS (
        SELECT text_sha256, canonical_text, ${metric.similarityExpr("embedding").replace("$QUERY", "$2::vector")} AS similarity_score
        FROM candidate_canonical
        WHERE true ${distanceBoundClause}
        ORDER BY (${distanceExpr.replace("c.embedding", "embedding")}) ASC, text_sha256 ASC
        LIMIT $${topKParamIndex}
      )
      SELECT fo.chunk_id, fo.source_document_id, fo.corp_code, fo.source_group, fo.document_type,
             fo.node_id, fo.source_locator, fo.block_type, fo.parse_status, fo.chunk_ordinal, fo.char_start, fo.char_end, fo.metadata,
             tc.text_sha256, tc.canonical_text, tc.similarity_score,
             $1::text AS retrieval_index_id
      FROM top_canonical tc
      JOIN filtered_occurrences fo ON fo.text_sha256 = tc.text_sha256
      ORDER BY tc.similarity_score DESC, fo.source_document_id ASC, fo.chunk_id ASC
    `;
    const result = await checkedQuery(client, signal, sql, params);
    return deepFreeze(result.rows.map((row) => trimmedResultRow({ ...row, release_id: index.release_id, source_snapshot_id: index.source_snapshot_id })));
  }

  return Object.freeze({
    getRetrievalIndex,
    assertReadyRetrievalIndex,
    async search(request, options = {}) {
      return search(request, options);
    },
  });
}

export function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
