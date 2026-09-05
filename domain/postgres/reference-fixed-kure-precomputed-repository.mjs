// Control-plane repository for Turn AC-VECTOR-IMPORT-V1. Large vector
// payloads are loaded by psql COPY in the CLI; this module performs only
// bounded metadata/state transitions and recount-based integrity checks.
export class FixedKurePrecomputedImportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FixedKurePrecomputedImportError";
    this.code = code;
  }
}

function requireId(value, name) {
  if (typeof value !== "string" || !/^[a-z0-9_-]+$/i.test(value)) {
    throw new TypeError(`${name} must be a non-empty safe identifier`);
  }
}

export function createFixedKurePrecomputedRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");

  async function inheritDiscovery({ successorLoadSessionId, sourceLoadSessionId }) {
    requireId(successorLoadSessionId, "successorLoadSessionId");
    requireId(sourceLoadSessionId, "sourceLoadSessionId");
    await client.query(
      "SELECT disclosure_reference.inherit_fixed_kure_discovery($1, $2)",
      [successorLoadSessionId, sourceLoadSessionId],
    );
    return getImportState(successorLoadSessionId);
  }

  async function beginEmbeddingImport(loadSessionId) {
    requireId(loadSessionId, "loadSessionId");
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET status = 'EMBEDDING'
       WHERE load_session_id = $1 AND status = 'DISCOVERY_COMPLETE'
       RETURNING load_session_id, status, discovery_source_load_session_id,
                 expected_search_eligible_count, expected_unique_embeddable_count`,
      [loadSessionId],
    );
    if (result.rows.length === 0) {
      const current = await getImportState(loadSessionId);
      if (current?.status === "EMBEDDING") return current;
      throw new FixedKurePrecomputedImportError(
        `load session ${loadSessionId} is not DISCOVERY_COMPLETE/EMBEDDING`,
        "IMPORT_STATUS_NOT_READY",
      );
    }
    return result.rows[0];
  }

  async function getImportState(loadSessionId) {
    requireId(loadSessionId, "loadSessionId");
    const result = await client.query(
      `SELECT s.load_session_id, s.status, s.discovery_source_load_session_id,
              s.expected_search_eligible_count, s.expected_unique_embeddable_count,
              s.embedded_unique_text_count, s.materialized_chunk_count,
              (SELECT count(*)::int
               FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
               WHERE p.load_session_id = s.load_session_id) AS imported_vector_count,
              (SELECT count(*)::int
               FROM disclosure_reference.reference_fixed_kure_precomputed_embedding_shards sh
               WHERE sh.load_session_id = s.load_session_id) AS imported_shard_count
       FROM disclosure_reference.reference_fixed_kure_load_sessions s
       WHERE s.load_session_id = $1`,
      [loadSessionId],
    );
    return result.rows[0] ?? null;
  }

  async function getImportedShard(loadSessionId, shardIndex) {
    requireId(loadSessionId, "loadSessionId");
    if (!Number.isInteger(shardIndex) || shardIndex < 0) throw new TypeError("shardIndex must be a non-negative integer");
    const result = await client.query(
      `SELECT * FROM disclosure_reference.reference_fixed_kure_precomputed_embedding_shards
       WHERE load_session_id = $1 AND shard_index = $2`,
      [loadSessionId, shardIndex],
    );
    return result.rows[0] ?? null;
  }

  async function completeEmbeddingImport(loadSessionId, { expectedShardCount, expectedRowCount }) {
    requireId(loadSessionId, "loadSessionId");
    if (!Number.isInteger(expectedShardCount) || expectedShardCount < 1) throw new TypeError("expectedShardCount must be positive");
    if (!Number.isInteger(expectedRowCount) || expectedRowCount < 1) throw new TypeError("expectedRowCount must be positive");

    const result = await client.query(
      `WITH state AS (
         SELECT s.status, s.discovery_source_load_session_id,
                s.expected_unique_embeddable_count,
                (SELECT count(*)::int FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
                 WHERE p.load_session_id = s.load_session_id) AS vector_count,
                (SELECT count(DISTINCT p.global_eligible_index)::int FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
                 WHERE p.load_session_id = s.load_session_id) AS index_count,
                (SELECT min(p.global_eligible_index)::bigint FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
                 WHERE p.load_session_id = s.load_session_id) AS min_index,
                (SELECT max(p.global_eligible_index)::bigint FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
                 WHERE p.load_session_id = s.load_session_id) AS max_index,
                (SELECT count(*)::int FROM disclosure_reference.reference_fixed_kure_precomputed_embedding_shards sh
                 WHERE sh.load_session_id = s.load_session_id) AS shard_count
         FROM disclosure_reference.reference_fixed_kure_load_sessions s
         WHERE s.load_session_id = $1
       ), unsupported AS (
         SELECT count(*)::int AS n
         FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
         CROSS JOIN state st
         WHERE p.load_session_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM disclosure_reference.reference_fixed_kure_chunk_staging c
             WHERE c.load_session_id = st.discovery_source_load_session_id
               AND c.retrieval_eligible
               AND c.embed_text_sha256 = p.embed_text_sha256
           )
       )
       SELECT state.*, unsupported.n AS unsupported_hash_count FROM state, unsupported`,
      [loadSessionId],
    );
    const state = result.rows[0];
    const mismatches = [];
    if (!state || state.status !== "EMBEDDING") mismatches.push("status is not EMBEDDING");
    if (state?.vector_count !== expectedRowCount) mismatches.push(`vector_count=${state?.vector_count}`);
    if (state?.index_count !== expectedRowCount) mismatches.push(`index_count=${state?.index_count}`);
    if (state?.expected_unique_embeddable_count !== expectedRowCount) mismatches.push(`expected_unique_embeddable_count=${state?.expected_unique_embeddable_count}`);
    if (Number(state?.min_index) !== 0 || Number(state?.max_index) !== expectedRowCount - 1) mismatches.push(`global_range=${state?.min_index}..${state?.max_index}`);
    if (state?.shard_count !== expectedShardCount) mismatches.push(`shard_count=${state?.shard_count}`);
    if (state?.unsupported_hash_count !== 0) mismatches.push(`unsupported_hash_count=${state?.unsupported_hash_count}`);
    if (mismatches.length > 0) {
      throw new FixedKurePrecomputedImportError(
        `precomputed embedding import incomplete or invalid: ${mismatches.join("; ")}`,
        "PRECOMPUTED_IMPORT_INTEGRITY_MISMATCH",
      );
    }

    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET embedded_unique_text_count = $2
       WHERE load_session_id = $1 AND status = 'EMBEDDING'`,
      [loadSessionId, expectedRowCount],
    );
    return getImportState(loadSessionId);
  }

  // Materializes inherited discovery rows without changing the terminal
  // source attempt. Retry safety comes from NOT EXISTS + INSERT RETURNING;
  // the successor counter is always reconciled to the real target count.
  async function materializeInheritedChunkBatch(loadSessionId, retrievalIndexId, limit) {
    requireId(loadSessionId, "loadSessionId");
    requireId(retrievalIndexId, "retrievalIndexId");
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be positive");
    const session = await client.query(
      `SELECT status, discovery_source_load_session_id
       FROM disclosure_reference.reference_fixed_kure_load_sessions
       WHERE load_session_id = $1`,
      [loadSessionId],
    );
    const sourceId = session.rows[0]?.discovery_source_load_session_id;
    if (session.rows[0]?.status !== "MATERIALIZING" || !sourceId) {
      throw new FixedKurePrecomputedImportError("inherited materialization requires MATERIALIZING status and a discovery source", "MATERIALIZATION_STATUS_NOT_READY");
    }

    const inserted = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT s.chunk_id, s.document_id, s.corp_code, s.chunk_index, s.source_locator,
                s.raw_text, s.content_sha256,
                (s.metadata || jsonb_build_object('chunk_type', s.chunk_type, 'parent_chunk_id', s.parent_chunk_id)) AS metadata,
                p.embedding
         FROM disclosure_reference.reference_fixed_kure_chunk_staging s
         JOIN disclosure_reference.reference_fixed_kure_precomputed_embeddings p
           ON p.load_session_id = $1 AND p.embed_text_sha256 = s.embed_text_sha256
         WHERE s.load_session_id = $2 AND s.retrieval_eligible
           AND s.chunk_id > COALESCE((
             SELECT precomputed_materialization_cursor_chunk_id
             FROM disclosure_reference.reference_fixed_kure_load_sessions
             WHERE load_session_id = $1
           ), '')
         ORDER BY s.chunk_id
         LIMIT $4
       ), inserted AS (
       INSERT INTO disclosure_reference.reference_retrieval_chunks
         (retrieval_index_id, chunk_id, source_kind, record_key, evidence_id,
          source_document_id, corp_code, source_locator, chunk_ordinal,
          text_content, text_sha256, metadata, embedding)
       SELECT $3, chunk_id, 'DOCUMENT_CHUNK', chunk_id, NULL, document_id,
              corp_code, source_locator, chunk_index, raw_text, content_sha256,
              metadata, embedding
       FROM candidates
       ON CONFLICT (retrieval_index_id, chunk_id) DO NOTHING
       RETURNING chunk_id
       ), cursor_update AS (
         UPDATE disclosure_reference.reference_fixed_kure_load_sessions
         SET precomputed_materialization_cursor_chunk_id = (SELECT max(chunk_id) FROM candidates)
         WHERE load_session_id = $1 AND EXISTS (SELECT 1 FROM candidates)
         RETURNING precomputed_materialization_cursor_chunk_id
       )
       SELECT
         (SELECT count(*)::int FROM inserted) AS inserted_count,
         (SELECT count(*)::int FROM candidates) AS candidate_count,
         (SELECT precomputed_materialization_cursor_chunk_id FROM cursor_update) AS cursor_chunk_id`,
      [loadSessionId, sourceId, retrievalIndexId, limit],
    );
    const countResult = await client.query(
      `SELECT count(*)::int AS n FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND source_kind = 'DOCUMENT_CHUNK'`,
      [retrievalIndexId],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET materialized_chunk_count = $2
       WHERE load_session_id = $1 AND status = 'MATERIALIZING'`,
      [loadSessionId, countResult.rows[0].n],
    );
    const batch = inserted.rows[0] ?? { inserted_count: 0, candidate_count: 0, cursor_chunk_id: null };
    return {
      materializedCount: batch.inserted_count,
      candidateCount: batch.candidate_count,
      totalMaterializedCount: countResult.rows[0].n,
      cursorChunkId: batch.cursor_chunk_id,
      done: batch.candidate_count === 0,
    };
  }

  return Object.freeze({
    inheritDiscovery,
    beginEmbeddingImport,
    getImportState,
    getImportedShard,
    completeEmbeddingImport,
    materializeInheritedChunkBatch,
  });
}
