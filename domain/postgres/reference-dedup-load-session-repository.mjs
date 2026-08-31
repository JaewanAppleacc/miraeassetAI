// Turn P8: durable state for the Resumable Bounded-Memory Dedup Embedding
// Loader (005_reference_dedup_load_sessions.sql). Every method here issues
// a parameterized statement against the CALLER's own client/transaction --
// this module never opens or commits a transaction itself (the orchestrator
// in reference-dedup-resumable-loader.mjs owns transaction boundaries,
// exactly like reference-dedup-retrieval-loader.mjs does for 004).
//
// THE ONE THING EVERY METHOD HERE EXISTS TO AVOID: holding the full
// 723,875-row canonical set or the full 1,874,688-row occurrence set in
// process memory. Every batch method takes and returns only the ONE batch
// it was given -- dedup/uniqueness is enforced by the table's own PRIMARY
// KEY via `ON CONFLICT ... DO NOTHING`, not by an in-process Set/Map.
import { createHash } from "node:crypto";
import { computeDedupRetrievalIndexId } from "./reference-dedup-retrieval-loader.mjs";

export class DedupLoadSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DedupLoadSessionError";
    this.code = code ?? "DEDUP_LOAD_SESSION_ERROR";
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

// load_session_id is deliberately the SAME digest as the 004
// retrieval_index_id it will eventually materialize into (only the prefix
// differs) -- one snapshot+embedding-config identity, one session, one
// index. This is what makes "same snapshot+config resumes the same
// session" true by construction rather than by a separate lookup table.
export function computeDedupLoadSessionId(pins) {
  const retrievalIndexId = computeDedupRetrievalIndexId(pins);
  return retrievalIndexId.replace(/^dedup_index_/, "load_session_");
}

export function computeEmbeddingConfigSha256({ provider, model, revision, dimension, distanceMetric }) {
  return sha256Hex({ provider, model, revision, dimension, distance_metric: distanceMetric });
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required and must be a non-empty string`);
}

function toPgvectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

const SESSION_COLUMNS = `
  load_session_id, retrieval_index_id, release_id, snapshot_id, snapshot_manifest_sha256, document_chunks_sha256,
  embedding_config_sha256, embedding_provider, embedding_model, embedding_revision, embedding_dimension, distance_metric,
  chunking_policy_id, chunking_policy_sha256, batch_size, discovery_batch_size, max_retry_attempts,
  lease_duration_ms, code_revision, status, source_line_count, source_byte_offset, source_line_number,
  expected_canonical_count, expected_occurrence_count, discovered_canonical_count, discovered_occurrence_count,
  embedded_canonical_count, materialized_canonical_count, materialized_occurrence_count, last_error_code,
  created_at, updated_at
`;

function trimmedSessionRow(row) {
  if (!row) return null;
  return Object.freeze({ ...row });
}

export function createDedupLoadSessionRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");

  async function getSession(loadSessionId) {
    assertNonEmptyString(loadSessionId, "loadSessionId");
    const result = await client.query(
      `SELECT ${SESSION_COLUMNS} FROM disclosure_reference.reference_dedup_load_sessions WHERE load_session_id = $1`,
      [loadSessionId],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  // Creates a CREATED session row if none exists; if one exists, verifies
  // the identity/config pins match exactly (fail-closed on any mismatch --
  // a different embedding config must never silently reuse this session's
  // already-discovered/embedded state) and returns it unmodified.
  async function createOrGetSession(pins) {
    const {
      releaseId, snapshotId, snapshotManifestSha256, documentChunksSha256,
      embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric,
      chunkingPolicyId, chunkingPolicySha256,
      batchSize, discoveryBatchSize, maxRetryAttempts, leaseDurationMs, codeRevision,
    } = pins;
    for (const [name, value] of Object.entries({
      releaseId, snapshotId, snapshotManifestSha256, documentChunksSha256, embeddingProvider, embeddingModel,
      embeddingRevision, chunkingPolicyId, chunkingPolicySha256, codeRevision,
    })) {
      assertNonEmptyString(value, name);
    }
    if (!Number.isInteger(embeddingDimension) || embeddingDimension < 1) throw new TypeError("embeddingDimension must be a positive integer");
    if (!["cosine", "l2", "inner_product"].includes(distanceMetric)) throw new TypeError("distanceMetric must be cosine|l2|inner_product");

    const loadSessionId = computeDedupLoadSessionId({
      releaseId, sourceSnapshotId: snapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId,
    });
    const retrievalIndexId = loadSessionId.replace(/^load_session_/, "dedup_index_");
    const embeddingConfigSha256 = computeEmbeddingConfigSha256({
      provider: embeddingProvider, model: embeddingModel, revision: embeddingRevision, dimension: embeddingDimension, distanceMetric,
    });

    const existing = await getSession(loadSessionId);
    if (existing) {
      if (existing.embedding_config_sha256 !== embeddingConfigSha256) {
        throw new DedupLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT embedding_config_sha256 -- a different embedding config must never reuse the same session/index`,
          "EMBEDDING_CONFIG_MISMATCH",
        );
      }
      if (existing.snapshot_manifest_sha256 !== snapshotManifestSha256 || existing.document_chunks_sha256 !== documentChunksSha256) {
        throw new DedupLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT snapshot pin -- refusing to reuse it against different source data`,
          "SNAPSHOT_MISMATCH",
        );
      }
      return { session: existing, created: false };
    }

    await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_load_sessions
         (load_session_id, retrieval_index_id, release_id, snapshot_id, snapshot_manifest_sha256, document_chunks_sha256,
          embedding_config_sha256, embedding_provider, embedding_model, embedding_revision, embedding_dimension, distance_metric,
          chunking_policy_id, chunking_policy_sha256, batch_size, discovery_batch_size, max_retry_attempts,
          lease_duration_ms, code_revision, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'CREATED')`,
      [
        loadSessionId, retrievalIndexId, releaseId, snapshotId, snapshotManifestSha256, documentChunksSha256,
        embeddingConfigSha256, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric,
        chunkingPolicyId, chunkingPolicySha256, batchSize, discoveryBatchSize, maxRetryAttempts,
        leaseDurationMs, codeRevision,
      ],
    );
    return { session: await getSession(loadSessionId), created: true };
  }

  // Generic guarded transition: succeeds only if the row's CURRENT status is
  // one of `fromStatuses` (the 005 trigger enforces the legal-edge graph
  // itself; this WHERE clause additionally protects against a concurrent
  // writer having already moved the row out from under us -- 0 rows
  // updated means "someone else already transitioned this session").
  async function transitionStatus(loadSessionId, fromStatuses, toStatus, extraSet = {}) {
    const params = [loadSessionId, fromStatuses, toStatus];
    const setClauses = ["status = $3"];
    for (const [column, value] of Object.entries(extraSet)) {
      params.push(value);
      setClauses.push(`${column} = $${params.length}`);
    }
    const result = await client.query(
      `UPDATE disclosure_reference.reference_dedup_load_sessions
       SET ${setClauses.join(", ")}
       WHERE load_session_id = $1 AND status::text = ANY($2::text[])
       RETURNING ${SESSION_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new DedupLoadSessionError(
        `load session "${loadSessionId}": cannot transition to ${toStatus} (not currently in one of [${fromStatuses.join(", ")}])`,
        "ILLEGAL_TRANSITION",
      );
    }
    return trimmedSessionRow(result.rows[0]);
  }

  async function updateDiscoveryCheckpoint(loadSessionId, { byteOffset, lineNumber, newCanonicalCount, occurrenceCount }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_dedup_load_sessions
       SET source_byte_offset = $2, source_line_number = $3,
           discovered_canonical_count = discovered_canonical_count + $4,
           discovered_occurrence_count = discovered_occurrence_count + $5
       WHERE load_session_id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId, byteOffset, lineNumber, newCanonicalCount, occurrenceCount],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  async function completeDiscovery(loadSessionId) {
    const session = await getSession(loadSessionId);
    return transitionStatus(loadSessionId, ["DISCOVERING"], "DISCOVERY_COMPLETE", {
      source_line_count: session.source_line_number,
      expected_canonical_count: session.discovered_canonical_count,
      expected_occurrence_count: session.discovered_occurrence_count,
    });
  }

  // Bulk-insert one discovery batch's DISTINCT-within-batch canonical rows.
  // ON CONFLICT DO NOTHING is the entire cross-batch/cross-run dedup
  // mechanism -- no in-process Set of the full 723,875-hash universe is
  // ever built. Returns which hashes this call actually inserted (for
  // counting) plus a defensive collision check against already-stored text.
  async function insertCanonicalBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedHashes: [] };
    const hashes = rows.map((r) => r.textSha256);
    const texts = rows.map((r) => r.canonicalText);
    const lengths = rows.map((r) => r.charLength);

    const existing = await client.query(
      `SELECT text_sha256, canonical_text FROM disclosure_reference.reference_dedup_canonical_queue
       WHERE load_session_id = $1 AND text_sha256 = ANY($2::text[])`,
      [loadSessionId, hashes],
    );
    const existingByHash = new Map(existing.rows.map((r) => [r.text_sha256, r.canonical_text]));
    for (const row of rows) {
      const priorText = existingByHash.get(row.textSha256);
      if (priorText !== undefined && priorText !== row.canonicalText) {
        throw new DedupLoadSessionError(
          `text_sha256 collision with different text_content: ${row.textSha256} -- refusing to treat two different texts as the same canonical row`,
          "TEXT_SHA256_COLLISION",
        );
      }
    }

    const inserted = await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_canonical_queue (load_session_id, text_sha256, canonical_text, char_length)
       SELECT $1, t, c, l FROM unnest($2::text[], $3::text[], $4::int[]) AS x(t, c, l)
       ON CONFLICT (load_session_id, text_sha256) DO NOTHING
       RETURNING text_sha256`,
      [loadSessionId, hashes, texts, lengths],
    );
    return { insertedHashes: inserted.rows.map((r) => r.text_sha256) };
  }

  // Bulk-insert one discovery batch's occurrence provenance rows. A
  // returned row count LOWER than the batch means some chunk_id already
  // existed for this session -- since the discovery checkpoint only ever
  // advances past a line AFTER its batch's transaction commits, a fresh
  // forward-progress batch must never collide; if it does, the source
  // itself contains a genuine duplicate chunk_id and the whole batch is
  // rejected (caller rolls back the transaction).
  async function insertOccurrenceBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedCount: 0 };
    const cols = [
      "chunk_id", "text_sha256", "source_document_id", "corp_code", "source_group", "document_type",
      "node_id", "source_locator", "block_type", "parse_status", "chunk_ordinal", "char_start", "char_end", "metadata",
    ];
    const arrays = Object.fromEntries(cols.map((c) => [c, []]));
    for (const r of rows) {
      arrays.chunk_id.push(r.chunkId);
      arrays.text_sha256.push(r.textSha256);
      arrays.source_document_id.push(r.sourceDocumentId);
      arrays.corp_code.push(r.corpCode ?? null);
      arrays.source_group.push(r.sourceGroup ?? null);
      arrays.document_type.push(r.documentType ?? null);
      arrays.node_id.push(r.nodeId);
      arrays.source_locator.push(r.sourceLocator);
      arrays.block_type.push(r.blockType);
      arrays.parse_status.push(r.parseStatus);
      arrays.chunk_ordinal.push(r.chunkOrdinal);
      arrays.char_start.push(r.charStart);
      arrays.char_end.push(r.charEnd);
      arrays.metadata.push(JSON.stringify(r.metadata ?? {}));
    }
    const result = await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_occurrence_staging
         (load_session_id, chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type,
          node_id, source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata)
       SELECT $1, x.* FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::text[], $11::text[], $12::int[], $13::int[], $14::int[], $15::jsonb[]
       ) AS x(chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type,
              node_id, source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata)
       ON CONFLICT (load_session_id, chunk_id) DO NOTHING
       RETURNING chunk_id`,
      [
        loadSessionId, arrays.chunk_id, arrays.text_sha256, arrays.source_document_id, arrays.corp_code, arrays.source_group,
        arrays.document_type, arrays.node_id, arrays.source_locator, arrays.block_type, arrays.parse_status,
        arrays.chunk_ordinal, arrays.char_start, arrays.char_end, arrays.metadata,
      ],
    );
    return { insertedCount: result.rows.length };
  }

  // Lease (FOR UPDATE SKIP LOCKED) up to `limit` canonical rows that are
  // either PENDING or whose previous lease has expired (a dead/crashed
  // worker's own lease -- this IS the reclaim mechanism, applied lazily at
  // the next lease attempt rather than via a separate sweeper process).
  // Two concurrent workers calling this against the SAME session never
  // receive overlapping rows: SKIP LOCKED guarantees each row is leased by
  // at most one worker at a time.
  async function leaseCanonicalBatch(loadSessionId, { limit, leaseOwner, leaseDurationMs }) {
    const result = await client.query(
      `WITH candidates AS (
         SELECT text_sha256 FROM disclosure_reference.reference_dedup_canonical_queue
         WHERE load_session_id = $1
           AND (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at < now()))
         ORDER BY text_sha256
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE disclosure_reference.reference_dedup_canonical_queue q
       SET status = 'LEASED', lease_owner = $3, lease_expires_at = now() + ($4 || ' milliseconds')::interval,
           attempt_count = q.attempt_count + 1
       FROM candidates
       WHERE q.load_session_id = $1 AND q.text_sha256 = candidates.text_sha256
       RETURNING q.text_sha256, q.canonical_text, q.attempt_count`,
      [loadSessionId, limit, leaseOwner, String(leaseDurationMs)],
    );
    return result.rows;
  }

  async function markEmbedded(loadSessionId, entries) {
    if (entries.length === 0) return;
    await client.query(
      `UPDATE disclosure_reference.reference_dedup_canonical_queue q
       SET status = 'EMBEDDED', embedding = x.embedding::vector, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
       FROM unnest($2::text[], $3::text[]) AS x(text_sha256, embedding)
       WHERE q.load_session_id = $1 AND q.text_sha256 = x.text_sha256`,
      [loadSessionId, entries.map((e) => e.textSha256), entries.map((e) => toPgvectorLiteral(e.embedding))],
    );
  }

  // Failure handling for a leased batch: rows under their retry budget go
  // back to PENDING (lease released) for a future attempt; rows that have
  // exhausted `maxRetryAttempts` are marked FAILED permanently. Returns
  // whether any row in this batch became permanently FAILED (the caller
  // uses this to decide whether the whole session must stop).
  async function markEmbeddingBatchFailed(loadSessionId, textHashes, { maxRetryAttempts, errorCode }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_dedup_canonical_queue
       SET status = (CASE WHEN attempt_count >= $3 THEN 'FAILED' ELSE 'PENDING' END)::disclosure_reference.dedup_queue_status,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = $4
       WHERE load_session_id = $1 AND text_sha256 = ANY($2::text[])
       RETURNING text_sha256, status`,
      [loadSessionId, textHashes, maxRetryAttempts, errorCode],
    );
    return {
      permanentlyFailed: result.rows.filter((r) => r.status === "FAILED").map((r) => r.text_sha256),
      requeued: result.rows.filter((r) => r.status === "PENDING").map((r) => r.text_sha256),
    };
  }

  async function queueStatusCounts(loadSessionId) {
    const result = await client.query(
      `SELECT status, count(*)::int AS n FROM disclosure_reference.reference_dedup_canonical_queue
       WHERE load_session_id = $1 GROUP BY status`,
      [loadSessionId],
    );
    const counts = { PENDING: 0, LEASED: 0, EMBEDDED: 0, FAILED: 0 };
    for (const row of result.rows) counts[row.status] = row.n;
    return counts;
  }

  async function ensureRetrievalIndexRow({ retrievalIndexId, releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256 }) {
    await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_indexes
         (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
          embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, index_status, manifest_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'LOADING',$11)
       ON CONFLICT (retrieval_index_id) DO NOTHING`,
      [retrievalIndexId, releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256],
    );
  }

  async function materializeCanonicalBatch(loadSessionId, retrievalIndexId, embeddingConfigHash, limit) {
    const candidates = await client.query(
      `SELECT text_sha256, canonical_text, char_length, embedding FROM disclosure_reference.reference_dedup_canonical_queue
       WHERE load_session_id = $1 AND materialized = false AND status = 'EMBEDDED'
       ORDER BY text_sha256 LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [loadSessionId, limit],
    );
    if (candidates.rows.length === 0) return { materializedCount: 0, done: true };
    const hashes = candidates.rows.map((r) => r.text_sha256);
    await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_canonical_texts
         (retrieval_index_id, text_sha256, canonical_text, char_length, embedding_config_hash, embedding)
       SELECT $1, x.text_sha256, x.canonical_text, x.char_length, $2, x.embedding::vector
       FROM unnest($3::text[], $4::text[], $5::int[], $6::text[])
         AS x(text_sha256, canonical_text, char_length, embedding)
       ON CONFLICT (retrieval_index_id, text_sha256) DO NOTHING`,
      [
        retrievalIndexId, embeddingConfigHash, hashes,
        candidates.rows.map((r) => r.canonical_text), candidates.rows.map((r) => r.char_length),
        // r.embedding already comes back from `pg` as pgvector's own text
        // representation ("[0.1,0.2,...]") -- NOT a JS array -- because no
        // type parser is registered for the custom `vector` OID. Passing it
        // through unchanged (never re-`.join()`ing it, which would throw)
        // and casting with ::vector in the SQL above is the correct path.
        candidates.rows.map((r) => r.embedding),
      ],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_dedup_canonical_queue SET materialized = true
       WHERE load_session_id = $1 AND text_sha256 = ANY($2::text[])`,
      [loadSessionId, hashes],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_dedup_load_sessions
       SET materialized_canonical_count = materialized_canonical_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, hashes.length],
    );
    return { materializedCount: hashes.length, done: false };
  }

  async function materializeOccurrenceBatch(loadSessionId, retrievalIndexId, limit) {
    const candidates = await client.query(
      `SELECT chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type, node_id,
              source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata
       FROM disclosure_reference.reference_dedup_occurrence_staging
       WHERE load_session_id = $1 AND materialized = false
       ORDER BY chunk_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [loadSessionId, limit],
    );
    if (candidates.rows.length === 0) return { materializedCount: 0, done: true };
    const chunkIds = candidates.rows.map((r) => r.chunk_id);
    await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_occurrences
         (retrieval_index_id, chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type,
          node_id, source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata)
       SELECT $1, x.* FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::text[], $11::text[], $12::int[], $13::int[], $14::int[], $15::jsonb[]
       ) AS x(chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type,
              node_id, source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata)
       ON CONFLICT (retrieval_index_id, chunk_id) DO NOTHING`,
      [
        retrievalIndexId,
        chunkIds, candidates.rows.map((r) => r.text_sha256), candidates.rows.map((r) => r.source_document_id),
        candidates.rows.map((r) => r.corp_code), candidates.rows.map((r) => r.source_group), candidates.rows.map((r) => r.document_type),
        candidates.rows.map((r) => r.node_id), candidates.rows.map((r) => r.source_locator), candidates.rows.map((r) => r.block_type),
        candidates.rows.map((r) => r.parse_status), candidates.rows.map((r) => r.chunk_ordinal), candidates.rows.map((r) => r.char_start),
        candidates.rows.map((r) => r.char_end), candidates.rows.map((r) => JSON.stringify(r.metadata ?? {})),
      ],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_dedup_occurrence_staging SET materialized = true
       WHERE load_session_id = $1 AND chunk_id = ANY($2::text[])`,
      [loadSessionId, chunkIds],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_dedup_load_sessions
       SET materialized_occurrence_count = materialized_occurrence_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, chunkIds.length],
    );
    return { materializedCount: chunkIds.length, done: false };
  }

  async function finalize(loadSessionId, retrievalIndexId) {
    // Sequential, not Promise.all -- a single pg.Client (as opposed to a
    // Pool) processes one query at a time; issuing several concurrently on
    // the SAME client only queues them internally and triggers a
    // deprecation warning, with no actual parallelism gained.
    const session = await getSession(loadSessionId);
    const canonicalActual = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id = $1", [retrievalIndexId]);
    const occurrenceActual = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id = $1", [retrievalIndexId]);
    const canonicalCount = canonicalActual.rows[0].n;
    const occurrenceCount = occurrenceActual.rows[0].n;
    const mismatches = [];
    if (session.discovered_occurrence_count !== session.expected_occurrence_count) mismatches.push("discovered_occurrence_count != expected_occurrence_count");
    if (session.discovered_canonical_count !== session.expected_canonical_count) mismatches.push("discovered_canonical_count != expected_canonical_count");
    if (session.materialized_canonical_count !== session.discovered_canonical_count) mismatches.push("materialized_canonical_count != discovered_canonical_count");
    if (session.materialized_occurrence_count !== session.discovered_occurrence_count) mismatches.push("materialized_occurrence_count != discovered_occurrence_count");
    if (canonicalCount !== session.discovered_canonical_count) mismatches.push(`actual canonical row count (${canonicalCount}) != discovered_canonical_count (${session.discovered_canonical_count})`);
    if (occurrenceCount !== session.discovered_occurrence_count) mismatches.push(`actual occurrence row count (${occurrenceCount}) != discovered_occurrence_count (${session.discovered_occurrence_count})`);

    if (mismatches.length > 0) {
      throw new DedupLoadSessionError(`finalization refused -- READY guard failed: ${mismatches.join("; ")}`, "FINALIZATION_MISMATCH");
    }

    await client.query(
      `UPDATE disclosure_reference.reference_dedup_indexes
       SET index_status = 'READY', ready_at = now(), canonical_count = $2, occurrence_count = $3
       WHERE retrieval_index_id = $1`,
      [retrievalIndexId, canonicalCount, occurrenceCount],
    );
    return transitionStatus(loadSessionId, ["MATERIALIZING"], "READY");
  }

  return Object.freeze({
    getSession, createOrGetSession, transitionStatus, updateDiscoveryCheckpoint, completeDiscovery,
    insertCanonicalBatch, insertOccurrenceBatch, leaseCanonicalBatch, markEmbedded, markEmbeddingBatchFailed,
    queueStatusCounts, ensureRetrievalIndexRow, materializeCanonicalBatch, materializeOccurrenceBatch, finalize,
  });
}
