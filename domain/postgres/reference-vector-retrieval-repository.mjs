// Turn P4: read-only repository for the pgvector-backed candidate-search
// tables added by 003_reference_vector_retrieval.sql. Mirrors
// reference-repository.mjs's own conventions exactly: every method issues
// a fresh, parameter-bound SELECT (no construction-time caching), a real
// DB failure is never reduced to NOT_FOUND, an already-aborted signal
// (or one that fires mid-query) throws RequestAbortedError, and every
// returned value is a deep-frozen, independent copy.
//
// IMPORTANT: this module NEVER claims a search hit is a verified Fact. It
// only returns candidate rows this project's own loader already wrote
// (reference-vector-retrieval-loader.mjs) -- whether a hit is trustworthy
// enough to ground an answer is decided later, by
// services.validator.validateEvidence (see
// domain/agent-comparison/retrieval/pgvector-retriever-adapter.mjs).
import { createHash } from "node:crypto";
import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";

const INDEXES_TABLE = "disclosure_reference.reference_retrieval_indexes";
const CHUNKS_TABLE = "disclosure_reference.reference_retrieval_chunks";

export class VectorRetrievalRepositoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "VectorRetrievalRepositoryError";
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
  // pgvector accepts a text literal like '[0.1,0.2,0.3]' bound as an
  // ordinary text parameter, cast with ::vector -- this keeps the query
  // fully parameter-bound (no string concatenation of the vector's own
  // numbers into the SQL text itself).
  return `[${vector.join(",")}]`;
}

// Every metric orders ASCENDING by its own pgvector distance operator --
// best match first -- and similarity_score is derived so that HIGHER
// always means MORE similar, regardless of which metric an index pins.
const METRIC_SQL = Object.freeze({
  cosine: { operator: "<=>", similarityExpr: (col) => `1 - (${col} <=> $QUERY)` },
  l2: { operator: "<->", similarityExpr: (col) => `-(${col} <-> $QUERY)` },
  inner_product: { operator: "<#>", similarityExpr: (col) => `-(${col} <#> $QUERY)` },
});

function assertKnownMetric(distanceMetric) {
  if (!METRIC_SQL[distanceMetric]) throw new VectorRetrievalRepositoryError(`unknown distance_metric: ${distanceMetric}`);
  return METRIC_SQL[distanceMetric];
}

// A caller-supplied similarity_threshold (higher-is-better, same scale as
// the returned similarity_score) is converted to the equivalent
// DISTANCE-side bound so it can be pushed into the SQL WHERE clause
// directly, rather than computed post-hoc in JS after fetching everything.
function similarityThresholdToDistanceBound(distanceMetric, similarityThreshold) {
  if (similarityThreshold === undefined || similarityThreshold === null) return null;
  if (distanceMetric === "cosine") return 1 - similarityThreshold;
  if (distanceMetric === "l2") return -similarityThreshold;
  if (distanceMetric === "inner_product") return -similarityThreshold;
  throw new VectorRetrievalRepositoryError(`unknown distance_metric: ${distanceMetric}`);
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
    record_count: row.record_count,
    manifest_sha256: row.manifest_sha256,
  });
}

export function createPostgresVectorRetrievalRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client (or pool) is required");

  async function getRetrievalIndex(retrievalIndexId, { signal } = {}) {
    assertNonEmptyString(retrievalIndexId, "retrievalIndexId");
    const result = await checkedQuery(
      client, signal,
      `SELECT retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model,
              embedding_revision, embedding_dimension, distance_metric, chunking_policy_id,
              chunking_policy_sha256, index_status, created_at, ready_at, record_count, manifest_sha256
       FROM ${INDEXES_TABLE} WHERE retrieval_index_id = $1`,
      [retrievalIndexId],
    );
    return result.rows[0] ? trimmedIndexRow(result.rows[0]) : null;
  }

  // Fail-closed on every pin: no row -> throws. Wrong status -> throws.
  // Any expected pin the caller supplied that disagrees with the real row
  // -> throws. Never falls back to "the most recent READY index" -- a
  // caller must always name the exact retrieval_index_id it wants.
  async function assertReadyRetrievalIndex(retrievalIndexId, expectedPins = {}, { signal } = {}) {
    const index = await getRetrievalIndex(retrievalIndexId, { signal });
    if (!index) throw new VectorRetrievalRepositoryError(`retrieval index "${retrievalIndexId}" was not found`);
    if (index.index_status !== "READY") {
      throw new VectorRetrievalRepositoryError(`retrieval index "${retrievalIndexId}" is not READY (index_status=${index.index_status})`);
    }
    for (const [key, expected] of Object.entries(expectedPins)) {
      if (expected === undefined) continue;
      if (index[key] !== expected) {
        throw new VectorRetrievalRepositoryError(
          `retrieval index "${retrievalIndexId}": ${key} mismatch (expected ${JSON.stringify(expected)}, found ${JSON.stringify(index[key])})`,
        );
      }
    }
    return index;
  }

  function trimmedChunkRow(row) {
    return deepFreeze({
      chunk_id: row.chunk_id,
      source_kind: row.source_kind,
      evidence_id: row.evidence_id,
      source_document_id: row.source_document_id,
      corp_code: row.corp_code,
      source_locator: row.source_locator,
      chunk_ordinal: row.chunk_ordinal,
      text_sha256: row.text_sha256,
      text_content: row.text_content,
      // Carried through verbatim so a Retriever adapter can recover
      // loader-time detail (e.g. the source Evidence's file_id) without
      // this repository needing its own opinion about what a consumer
      // does with it -- see domain/agent-comparison/retrieval/
      // pgvector-retriever-adapter.mjs.
      metadata: structuredClone(row.metadata ?? {}),
      similarity_score: Number(row.similarity_score),
      retrieval_index_id: row.retrieval_index_id,
      release_id: row.release_id,
      source_snapshot_id: row.source_snapshot_id,
    });
  }

  // The one real search implementation -- searchEvidenceByVector/
  // searchDocumentChunksByVector below are thin, source_kind-fixed
  // wrappers over this.
  async function search({
    retrievalIndexId, sourceKinds, queryVector, topK,
    corpCodes, documentIds, similarityThreshold, expectedPins,
  }, { signal } = {}) {
    assertNonEmptyString(retrievalIndexId, "retrievalIndexId");
    if (!Array.isArray(queryVector) || queryVector.length === 0) throw new TypeError("queryVector must be a non-empty array of numbers");
    if (!queryVector.every((value) => Number.isFinite(value))) throw new TypeError("queryVector must contain only finite numbers (no NaN/Infinity)");
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw new TypeError("topK must be an integer between 1 and 100");

    // READY + pin check happens BEFORE any chunk query -- a mismatched or
    // not-yet-READY index is fail-closed here, never silently searched.
    const index = await assertReadyRetrievalIndex(retrievalIndexId, expectedPins ?? {}, { signal });
    if (queryVector.length !== index.embedding_dimension) {
      throw new VectorRetrievalRepositoryError(
        `queryVector has ${queryVector.length} dimensions, retrieval index "${retrievalIndexId}" expects ${index.embedding_dimension}`,
      );
    }
    const metric = assertKnownMetric(index.distance_metric);
    const distanceBound = similarityThresholdToDistanceBound(index.distance_metric, similarityThreshold);

    const params = [retrievalIndexId, toPgvectorLiteral(queryVector)];
    const conditions = ["c.retrieval_index_id = $1"];
    if (Array.isArray(sourceKinds) && sourceKinds.length > 0) {
      params.push(sourceKinds);
      conditions.push(`c.source_kind = ANY($${params.length})`);
    }
    if (Array.isArray(corpCodes) && corpCodes.length > 0) {
      params.push(corpCodes);
      conditions.push(`c.corp_code = ANY($${params.length})`);
    }
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      params.push(documentIds);
      conditions.push(`c.source_document_id = ANY($${params.length})`);
    }
    const distanceExpr = `c.embedding ${metric.operator} $2::vector`;
    if (distanceBound !== null) {
      params.push(distanceBound);
      conditions.push(`(${distanceExpr}) <= $${params.length}`);
    }
    params.push(topK);
    const topKParamIndex = params.length;

    const sql = `
      SELECT c.chunk_id, c.source_kind, c.evidence_id, c.source_document_id, c.corp_code,
             c.source_locator, c.chunk_ordinal, c.text_sha256, c.text_content, c.metadata, c.retrieval_index_id,
             i.release_id, i.source_snapshot_id,
             ${metric.similarityExpr("c.embedding").replace("$QUERY", "$2::vector")} AS similarity_score
      FROM ${CHUNKS_TABLE} c
      JOIN ${INDEXES_TABLE} i ON i.retrieval_index_id = c.retrieval_index_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY (${distanceExpr}) ASC, c.source_document_id ASC, c.chunk_id ASC
      LIMIT $${topKParamIndex}
    `;
    const result = await checkedQuery(client, signal, sql, params);
    return deepFreeze(result.rows.map(trimmedChunkRow));
  }

  return Object.freeze({
    getRetrievalIndex,
    assertReadyRetrievalIndex,
    async searchEvidenceByVector(request, options = {}) {
      return search({ ...request, sourceKinds: ["VERIFIED_EVIDENCE"] }, options);
    },
    async searchDocumentChunksByVector(request, options = {}) {
      return search({ ...request, sourceKinds: ["DOCUMENT_CHUNK"] }, options);
    },
    async search(request, options = {}) {
      return search(request, options);
    },
  });
}

export function computeChunkId({ retrievalIndexId, recordKey }) {
  const digest = createHash("sha256").update(`${retrievalIndexId} ${recordKey}`).digest("hex");
  return `chunk_${digest.slice(0, 24)}`;
}
