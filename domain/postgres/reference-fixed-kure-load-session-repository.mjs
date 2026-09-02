// Turn P11-F0: durable state for the Resumable Bounded-Memory
// Fixed-512-o64 x KURE-v1 Hybrid Retrieval Loader
// (006_reference_fixed_kure_load_sessions.sql). Mirrors
// reference-dedup-load-session-repository.mjs's (Turn P8) exact pattern --
// every method issues a parameterized statement against the CALLER's own
// client/transaction; this module never opens or commits a transaction
// itself (the orchestrator in reference-fixed-kure-resumable-loader.mjs
// owns transaction boundaries).
//
// THE ONE THING EVERY METHOD HERE EXISTS TO AVOID: holding the full
// ~442k-chunk / ~442k-unique-text set in process memory. Every batch
// method takes and returns only the ONE batch it was given -- dedup is
// enforced by the table's own PRIMARY KEY via `ON CONFLICT ... DO
// NOTHING`, never by an in-process Set/Map.
//
// UNLIKE the dedup loader's materialization (canonical-text-per-row into
// 004's reference_dedup_canonical_texts, occurrence-per-row into
// reference_dedup_occurrences), THIS loader's finished output is
// CHUNK-per-row into 003's EXISTING reference_retrieval_chunks
// (source_kind='DOCUMENT_CHUNK') -- one row per chunk_id, each carrying
// its own copy of the embedding vector looked up from the matching
// canonical_queue row by embed_text_sha256 at materialization time. 003's
// schema was designed for exactly this (its own header: "source_kind =
// 'DOCUMENT_CHUNK' is reserved for the future full-corpus chunking
// pipeline").
import { createHash } from "node:crypto";

export class FixedKureLoadSessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FixedKureLoadSessionError";
    this.code = code ?? "FIXED_KURE_LOAD_SESSION_ERROR";
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

// load_session_id is deterministic in the SAME pins -> SAME id sense as
// computeDedupLoadSessionId (Turn P8) -- one (corpus_snapshot_id,
// chunking_policy, embedding_config) identity, one session, one index.
export function computeFixedKureRetrievalIndexId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }) {
  return `fixed_kure_index_${sha256Hex({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }).slice(0, 32)}`;
}

export function computeFixedKureLoadSessionId(pins) {
  return computeFixedKureRetrievalIndexId(pins).replace(/^fixed_kure_index_/, "fixed_kure_session_");
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
  load_session_id, retrieval_index_id, release_id, corpus_snapshot_id, corpus_manifest_sha256,
  chunking_policy_id, chunking_policy_sha256, embedding_config_sha256, embedding_provider, embedding_model,
  embedding_revision, embedding_dimension, distance_metric, batch_size, discovery_batch_size, max_retry_attempts,
  lease_duration_ms, code_revision, status, source_files_progress, discovery_pass_number,
  pass1_chunk_stream_sha256, pass2_chunk_stream_sha256,
  expected_document_count, expected_total_chunk_count, expected_search_eligible_count, expected_unique_embeddable_count,
  discovered_document_count, discovered_total_chunk_count, discovered_search_eligible_count, discovered_unique_text_count,
  embedded_unique_text_count, materialized_chunk_count, last_error_code, created_at, updated_at
`;

function trimmedSessionRow(row) {
  if (!row) return null;
  return Object.freeze({ ...row });
}

export function createFixedKureLoadSessionRepository({ client }) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required");

  async function getSession(loadSessionId) {
    assertNonEmptyString(loadSessionId, "loadSessionId");
    const result = await client.query(
      `SELECT ${SESSION_COLUMNS} FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1`,
      [loadSessionId],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  // Creates a CREATED session row if none exists; if one exists, verifies
  // the identity/config pins match exactly (fail-closed on any mismatch)
  // and returns it unmodified.
  async function createOrGetSession(pins) {
    const {
      releaseId, corpusSnapshotId, corpusManifestSha256,
      embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric,
      chunkingPolicyId, chunkingPolicySha256,
      batchSize, discoveryBatchSize, maxRetryAttempts, leaseDurationMs, codeRevision,
    } = pins;
    for (const [name, value] of Object.entries({
      releaseId, corpusSnapshotId, corpusManifestSha256, embeddingProvider, embeddingModel,
      embeddingRevision, chunkingPolicyId, chunkingPolicySha256, codeRevision,
    })) {
      assertNonEmptyString(value, name);
    }
    if (!Number.isInteger(embeddingDimension) || embeddingDimension < 1) throw new TypeError("embeddingDimension must be a positive integer");
    if (!["cosine", "l2", "inner_product"].includes(distanceMetric)) throw new TypeError("distanceMetric must be cosine|l2|inner_product");

    const loadSessionId = computeFixedKureLoadSessionId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const retrievalIndexId = computeFixedKureRetrievalIndexId({ releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
    const embeddingConfigSha256 = computeEmbeddingConfigSha256({
      provider: embeddingProvider, model: embeddingModel, revision: embeddingRevision, dimension: embeddingDimension, distanceMetric,
    });

    const existing = await getSession(loadSessionId);
    if (existing) {
      if (existing.embedding_config_sha256 !== embeddingConfigSha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT embedding_config_sha256`,
          "EMBEDDING_CONFIG_MISMATCH",
        );
      }
      if (existing.corpus_manifest_sha256 !== corpusManifestSha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT corpus_manifest_sha256 -- refusing to reuse it against different source data`,
          "CORPUS_MANIFEST_MISMATCH",
        );
      }
      if (existing.chunking_policy_sha256 !== chunkingPolicySha256) {
        throw new FixedKureLoadSessionError(
          `load session "${loadSessionId}" already exists with a DIFFERENT chunking_policy_sha256`,
          "CHUNKING_POLICY_MISMATCH",
        );
      }
      return { session: existing, created: false };
    }

    await client.query(
      `INSERT INTO disclosure_reference.reference_fixed_kure_load_sessions
         (load_session_id, retrieval_index_id, release_id, corpus_snapshot_id, corpus_manifest_sha256,
          chunking_policy_id, chunking_policy_sha256, embedding_config_sha256, embedding_provider, embedding_model,
          embedding_revision, embedding_dimension, distance_metric, batch_size, discovery_batch_size,
          max_retry_attempts, lease_duration_ms, code_revision, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'CREATED')`,
      [
        loadSessionId, retrievalIndexId, releaseId, corpusSnapshotId, corpusManifestSha256,
        chunkingPolicyId, chunkingPolicySha256, embeddingConfigSha256, embeddingProvider, embeddingModel,
        embeddingRevision, embeddingDimension, distanceMetric, batchSize, discoveryBatchSize,
        maxRetryAttempts, leaseDurationMs, codeRevision,
      ],
    );
    return { session: await getSession(loadSessionId), created: true };
  }

  async function transitionStatus(loadSessionId, fromStatuses, toStatus, extraSet = {}) {
    const params = [loadSessionId, fromStatuses, toStatus];
    const setClauses = ["status = $3"];
    for (const [column, value] of Object.entries(extraSet)) {
      params.push(value);
      setClauses.push(`${column} = $${params.length}`);
    }
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET ${setClauses.join(", ")}
       WHERE load_session_id = $1 AND status::text = ANY($2::text[])
       RETURNING ${SESSION_COLUMNS}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new FixedKureLoadSessionError(
        `load session "${loadSessionId}": cannot transition to ${toStatus} (not currently in one of [${fromStatuses.join(", ")}])`,
        "ILLEGAL_TRANSITION",
      );
    }
    return trimmedSessionRow(result.rows[0]);
  }

  async function updateDiscoveryCheckpoint(loadSessionId, { sourceFilesProgress, newDocumentCount, newTotalChunkCount, newSearchEligibleCount, newUniqueTextCount }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET source_files_progress = $2::jsonb,
           discovered_document_count = discovered_document_count + $3,
           discovered_total_chunk_count = discovered_total_chunk_count + $4,
           discovered_search_eligible_count = discovered_search_eligible_count + $5,
           discovered_unique_text_count = discovered_unique_text_count + $6
       WHERE load_session_id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId, JSON.stringify(sourceFilesProgress), newDocumentCount, newTotalChunkCount, newSearchEligibleCount, newUniqueTextCount],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  async function recordPassStreamSha256(loadSessionId, passNumber, streamSha256) {
    const column = passNumber === 1 ? "pass1_chunk_stream_sha256" : "pass2_chunk_stream_sha256";
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET ${column} = $2, discovery_pass_number = $3
       WHERE load_session_id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [loadSessionId, streamSha256, passNumber],
    );
    return trimmedSessionRow(result.rows[0]);
  }

  async function completeDiscovery(loadSessionId) {
    const session = await getSession(loadSessionId);
    return transitionStatus(loadSessionId, ["DISCOVERING"], "DISCOVERY_COMPLETE", {
      expected_document_count: session.discovered_document_count,
      expected_total_chunk_count: session.discovered_total_chunk_count,
      expected_search_eligible_count: session.discovered_search_eligible_count,
      expected_unique_embeddable_count: session.discovered_unique_text_count,
    });
  }

  // Bulk-insert one discovery batch's DISTINCT-within-batch unique
  // embed_text rows. ON CONFLICT DO NOTHING is the entire cross-batch dedup
  // mechanism.
  async function insertCanonicalBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedHashes: [] };
    const hashes = rows.map((r) => r.embedTextSha256);
    const texts = rows.map((r) => r.embedText);
    const lengths = rows.map((r) => r.charLength);

    const existing = await client.query(
      `SELECT embed_text_sha256, embed_text FROM disclosure_reference.reference_fixed_kure_canonical_queue
       WHERE load_session_id = $1 AND embed_text_sha256 = ANY($2::text[])`,
      [loadSessionId, hashes],
    );
    const existingByHash = new Map(existing.rows.map((r) => [r.embed_text_sha256, r.embed_text]));
    for (const row of rows) {
      const priorText = existingByHash.get(row.embedTextSha256);
      if (priorText !== undefined && priorText !== row.embedText) {
        throw new FixedKureLoadSessionError(
          `embed_text_sha256 collision with different text content: ${row.embedTextSha256}`,
          "TEXT_SHA256_COLLISION",
        );
      }
    }

    const inserted = await client.query(
      `INSERT INTO disclosure_reference.reference_fixed_kure_canonical_queue (load_session_id, embed_text_sha256, embed_text, char_length)
       SELECT $1, t, c, l FROM unnest($2::text[], $3::text[], $4::int[]) AS x(t, c, l)
       ON CONFLICT (load_session_id, embed_text_sha256) DO NOTHING
       RETURNING embed_text_sha256`,
      [loadSessionId, hashes, texts, lengths],
    );
    return { insertedHashes: inserted.rows.map((r) => r.embed_text_sha256) };
  }

  // Bulk-insert one discovery batch's chunk canonical-digest rows (the full
  // per-chunk provenance CLAUDE.md Turn P11-F0 section C requires).
  async function insertChunkBatch(loadSessionId, rows) {
    if (rows.length === 0) return { insertedCount: 0 };
    const cols = [
      "chunk_id", "document_id", "chunk_index", "chunk_type", "parent_chunk_id", "content_sha256",
      "raw_text", "embed_text_sha256", "token_count",
      "corp_code", "doc_group", "receipt_date", "section_path", "source_locator", "source_spans",
      "chunking_policy_id", "chunking_policy_version", "retrieval_eligible", "metadata",
    ];
    const arrays = Object.fromEntries(cols.map((c) => [c, []]));
    for (const r of rows) {
      arrays.chunk_id.push(r.chunkId);
      arrays.document_id.push(r.documentId);
      arrays.chunk_index.push(r.chunkIndex);
      arrays.chunk_type.push(r.chunkType);
      arrays.parent_chunk_id.push(r.parentChunkId ?? null);
      arrays.content_sha256.push(r.contentSha256);
      arrays.raw_text.push(r.rawText);
      arrays.embed_text_sha256.push(r.embedTextSha256);
      arrays.token_count.push(r.tokenCount);
      arrays.corp_code.push(r.corpCode ?? null);
      arrays.doc_group.push(r.docGroup);
      arrays.receipt_date.push(r.receiptDate ?? null);
      arrays.section_path.push(JSON.stringify(r.sectionPath ?? []));
      arrays.source_locator.push(r.sourceLocator);
      arrays.source_spans.push(JSON.stringify(r.sourceSpans ?? []));
      arrays.chunking_policy_id.push(r.chunkingPolicyId);
      arrays.chunking_policy_version.push(r.chunkingPolicyVersion);
      arrays.retrieval_eligible.push(r.retrievalEligible);
      arrays.metadata.push(JSON.stringify(r.metadata ?? {}));
    }
    const result = await client.query(
      `INSERT INTO disclosure_reference.reference_fixed_kure_chunk_staging
         (load_session_id, chunk_id, document_id, chunk_index, chunk_type, parent_chunk_id, content_sha256,
          raw_text, embed_text_sha256, token_count,
          corp_code, doc_group, receipt_date, section_path, source_locator, source_spans,
          chunking_policy_id, chunking_policy_version, retrieval_eligible, metadata)
       SELECT $1, x.* FROM unnest(
         $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::int[],
         $11::text[], $12::text[], $13::text[], $14::jsonb[], $15::text[], $16::jsonb[],
         $17::text[], $18::text[], $19::boolean[], $20::jsonb[]
       ) AS x(chunk_id, document_id, chunk_index, chunk_type, parent_chunk_id, content_sha256,
              raw_text, embed_text_sha256, token_count,
              corp_code, doc_group, receipt_date, section_path, source_locator, source_spans,
              chunking_policy_id, chunking_policy_version, retrieval_eligible, metadata)
       ON CONFLICT (load_session_id, chunk_id) DO NOTHING
       RETURNING chunk_id`,
      [
        loadSessionId, arrays.chunk_id, arrays.document_id, arrays.chunk_index, arrays.chunk_type, arrays.parent_chunk_id,
        arrays.content_sha256, arrays.raw_text, arrays.embed_text_sha256, arrays.token_count, arrays.corp_code, arrays.doc_group, arrays.receipt_date,
        arrays.section_path, arrays.source_locator, arrays.source_spans, arrays.chunking_policy_id,
        arrays.chunking_policy_version, arrays.retrieval_eligible, arrays.metadata,
      ],
    );
    return { insertedCount: result.rows.length };
  }

  // Lease (FOR UPDATE SKIP LOCKED) up to `limit` unique-text rows that are
  // either PENDING or whose previous lease has expired.
  async function leaseCanonicalBatch(loadSessionId, { limit, leaseOwner, leaseDurationMs }) {
    const result = await client.query(
      `WITH candidates AS (
         SELECT embed_text_sha256 FROM disclosure_reference.reference_fixed_kure_canonical_queue
         WHERE load_session_id = $1
           AND (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at < now()))
         ORDER BY embed_text_sha256
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE disclosure_reference.reference_fixed_kure_canonical_queue q
       SET status = 'LEASED', lease_owner = $3, lease_expires_at = now() + ($4 || ' milliseconds')::interval,
           attempt_count = q.attempt_count + 1
       FROM candidates
       WHERE q.load_session_id = $1 AND q.embed_text_sha256 = candidates.embed_text_sha256
       RETURNING q.embed_text_sha256, q.embed_text, q.attempt_count`,
      [loadSessionId, limit, leaseOwner, String(leaseDurationMs)],
    );
    return result.rows;
  }

  async function markEmbedded(loadSessionId, entries) {
    if (entries.length === 0) return;
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_canonical_queue q
       SET status = 'EMBEDDED', embedding = x.embedding::vector, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
       FROM unnest($2::text[], $3::text[]) AS x(embed_text_sha256, embedding)
       WHERE q.load_session_id = $1 AND q.embed_text_sha256 = x.embed_text_sha256`,
      [loadSessionId, entries.map((e) => e.embedTextSha256), entries.map((e) => toPgvectorLiteral(e.embedding))],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET embedded_unique_text_count = embedded_unique_text_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, entries.length],
    );
  }

  async function markEmbeddingBatchFailed(loadSessionId, textHashes, { maxRetryAttempts, errorCode }) {
    const result = await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_canonical_queue
       SET status = (CASE WHEN attempt_count >= $3 THEN 'FAILED' ELSE 'PENDING' END)::disclosure_reference.fixed_kure_queue_status,
           lease_owner = NULL, lease_expires_at = NULL, last_error_code = $4
       WHERE load_session_id = $1 AND embed_text_sha256 = ANY($2::text[])
       RETURNING embed_text_sha256, status`,
      [loadSessionId, textHashes, maxRetryAttempts, errorCode],
    );
    return {
      permanentlyFailed: result.rows.filter((r) => r.status === "FAILED").map((r) => r.embed_text_sha256),
      requeued: result.rows.filter((r) => r.status === "PENDING").map((r) => r.embed_text_sha256),
    };
  }

  async function queueStatusCounts(loadSessionId) {
    const result = await client.query(
      `SELECT status, count(*)::int AS n FROM disclosure_reference.reference_fixed_kure_canonical_queue
       WHERE load_session_id = $1 GROUP BY status`,
      [loadSessionId],
    );
    const counts = { PENDING: 0, LEASED: 0, EMBEDDED: 0, FAILED: 0 };
    for (const row of result.rows) counts[row.status] = row.n;
    return counts;
  }

  async function ensureRetrievalIndexRow({ retrievalIndexId, releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256 }) {
    await client.query(
      `INSERT INTO disclosure_reference.reference_retrieval_indexes
         (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
          embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, index_status, manifest_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'LOADING',$11)
       ON CONFLICT (retrieval_index_id) DO NOTHING`,
      [retrievalIndexId, releaseId, corpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, embeddingDimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, manifestSha256],
    );
  }

  // Materializes one batch of staged chunks into 003's
  // reference_retrieval_chunks (source_kind='DOCUMENT_CHUNK'), joining each
  // chunk's embed_text_sha256 against the canonical_queue's EMBEDDED
  // embedding. A chunk whose embed_text is not yet EMBEDDED is simply not
  // selected this pass (picked up on a later call once embedding catches
  // up) -- never materialized with a placeholder/null vector.
  async function materializeChunkBatch(loadSessionId, retrievalIndexId, limit) {
    const candidates = await client.query(
      `SELECT s.chunk_id, s.document_id, s.corp_code, s.chunk_index, s.chunk_type, s.parent_chunk_id,
              s.source_locator, s.content_sha256, s.raw_text, s.metadata,
              q.embed_text_sha256, q.embedding
       FROM disclosure_reference.reference_fixed_kure_chunk_staging s
       JOIN disclosure_reference.reference_fixed_kure_canonical_queue q
         ON q.load_session_id = s.load_session_id AND q.embed_text_sha256 = s.embed_text_sha256 AND q.status = 'EMBEDDED'
       WHERE s.load_session_id = $1 AND s.materialized = false
       ORDER BY s.chunk_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED`,
      [loadSessionId, limit],
    );
    if (candidates.rows.length === 0) return { materializedCount: 0, done: true };
    const chunkIds = candidates.rows.map((r) => r.chunk_id);
    // chunk_type/parent_chunk_id have no dedicated column on 003's
    // reference_retrieval_chunks (a table shared with VERIFIED_EVIDENCE
    // rows that have no such concept) -- folded into `metadata` instead,
    // where the RetrieverAdapter reads them back for
    // RetrieverResult.chunk_type/parent_chunk_id.
    const mergedMetadata = candidates.rows.map((r) => JSON.stringify({ ...(r.metadata ?? {}), chunk_type: r.chunk_type, parent_chunk_id: r.parent_chunk_id }));
    await client.query(
      `INSERT INTO disclosure_reference.reference_retrieval_chunks
         (retrieval_index_id, chunk_id, source_kind, record_key, evidence_id, source_document_id, corp_code,
          source_locator, chunk_ordinal, text_content, text_sha256, metadata, embedding)
       SELECT $1, x.chunk_id, 'DOCUMENT_CHUNK', x.chunk_id, NULL, x.document_id, x.corp_code,
              x.source_locator, x.chunk_index, x.raw_text, x.content_sha256, x.metadata, x.embedding::vector
       FROM unnest(
         $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::text[]
       ) AS x(chunk_id, document_id, corp_code, chunk_index, source_locator, raw_text, content_sha256, metadata, embedding)
       ON CONFLICT (retrieval_index_id, chunk_id) DO NOTHING`,
      [
        retrievalIndexId, chunkIds,
        candidates.rows.map((r) => r.document_id), candidates.rows.map((r) => r.corp_code),
        candidates.rows.map((r) => r.chunk_index), candidates.rows.map((r) => r.source_locator),
        candidates.rows.map((r) => r.raw_text), candidates.rows.map((r) => r.content_sha256),
        mergedMetadata, candidates.rows.map((r) => r.embedding),
      ],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_chunk_staging SET materialized = true
       WHERE load_session_id = $1 AND chunk_id = ANY($2::text[])`,
      [loadSessionId, chunkIds],
    );
    await client.query(
      `UPDATE disclosure_reference.reference_fixed_kure_load_sessions
       SET materialized_chunk_count = materialized_chunk_count + $2 WHERE load_session_id = $1`,
      [loadSessionId, chunkIds.length],
    );
    return { materializedCount: chunkIds.length, done: false };
  }

  async function finalize(loadSessionId, retrievalIndexId) {
    const session = await getSession(loadSessionId);
    const chunkActual = await client.query(
      "SELECT count(*)::int AS n FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id = $1 AND source_kind = 'DOCUMENT_CHUNK'",
      [retrievalIndexId],
    );
    const chunkCount = chunkActual.rows[0].n;
    const mismatches = [];
    if (session.discovered_search_eligible_count !== session.expected_search_eligible_count) mismatches.push("discovered_search_eligible_count != expected_search_eligible_count");
    if (session.discovered_unique_text_count !== session.expected_unique_embeddable_count) mismatches.push("discovered_unique_text_count != expected_unique_embeddable_count");
    if (session.embedded_unique_text_count !== session.discovered_unique_text_count) mismatches.push("embedded_unique_text_count != discovered_unique_text_count");
    if (session.materialized_chunk_count !== session.discovered_search_eligible_count) mismatches.push("materialized_chunk_count != discovered_search_eligible_count");
    if (chunkCount !== session.discovered_search_eligible_count) mismatches.push(`actual chunk row count (${chunkCount}) != discovered_search_eligible_count (${session.discovered_search_eligible_count})`);
    if (!session.pass1_chunk_stream_sha256 || session.pass1_chunk_stream_sha256 !== session.pass2_chunk_stream_sha256) mismatches.push("pass1_chunk_stream_sha256 != pass2_chunk_stream_sha256 (double-pass determinism check failed)");

    if (mismatches.length > 0) {
      throw new FixedKureLoadSessionError(`finalization refused -- READY guard failed: ${mismatches.join("; ")}`, "FINALIZATION_MISMATCH");
    }

    await client.query(
      `UPDATE disclosure_reference.reference_retrieval_indexes
       SET index_status = 'READY', ready_at = now(), record_count = $2
       WHERE retrieval_index_id = $1`,
      [retrievalIndexId, chunkCount],
    );
    return transitionStatus(loadSessionId, ["MATERIALIZING"], "READY");
  }

  return Object.freeze({
    getSession, createOrGetSession, transitionStatus, updateDiscoveryCheckpoint, recordPassStreamSha256, completeDiscovery,
    insertCanonicalBatch, insertChunkBatch, leaseCanonicalBatch, markEmbedded, markEmbeddingBatchFailed,
    queueStatusCounts, ensureRetrievalIndexRow, materializeChunkBatch, finalize,
  });
}
