// Turn P5.2: loader for the EXACT_TEXT_DEDUP_INDEX tables added by
// 004_reference_dedup_retrieval_index.sql. Reads Turn P5's own portable
// snapshot chunks (via a caller-supplied async-iterable FACTORY -- see
// below for why a factory, not a single iterable), embeds each DISTINCT
// text_sha256 exactly once, then writes every ORIGINAL chunk as its own
// occurrence row referencing that canonical embedding. Never touches Turn
// P5's snapshot files, never calls a real embedding API itself (the
// embeddingAdapter it's given decides that), never opens more than one
// transaction per load.
//
// WHY chunkSourceFactory (a function that returns a FRESH async iterable),
// not one iterable: this loader needs TWO passes over the same chunk
// sequence -- pass 1 discovers the distinct text_sha256 set (so it knows
// what to embed, batched), pass 2 writes one occurrence row per original
// chunk (so every chunk_id/source_document_id/source_locator survives).
// An in-flight Node stream can only be consumed once; a factory lets the
// caller re-open the same real file (or hand back the same in-memory
// fixture array) for each pass without this module knowing which.
//
// SCALE NOTE (see the Turn P5.2 task brief's own text): loading the FULL
// 723,875 unique texts / 1,874,688 occurrences into a real database is
// explicitly NOT required this Turn -- pass 1's canonical Map is held
// fully in memory (bounded by the INPUT's own distinct text_sha256 count),
// which is appropriate for a bounded sample/shard, not yet engineered for
// full-corpus scale (that would need a disk-backed or multi-pass merge
// strategy a future Turn can add if the Owner selects this strategy for
// full-scale loading).
import { createHash } from "node:crypto";

export class DedupRetrievalLoaderError extends Error {
  constructor(message) {
    super(message);
    this.name = "DedupRetrievalLoaderError";
  }
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeForHash(value[key])]));
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonicalizeForHash(value))).digest("hex");
}

export function computeDedupRetrievalIndexId({ releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }) {
  const digest = sha256Hex({ releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
  return `dedup_index_${digest.slice(0, 32)}`;
}

function toPgvectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function assertFiniteVector(vector, dimension, label) {
  if (!Array.isArray(vector) || vector.length !== dimension) {
    throw new DedupRetrievalLoaderError(`${label}: expected a ${dimension}-dimension vector, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new DedupRetrievalLoaderError(`${label}: embedding vector must contain only finite numbers (no NaN/Infinity)`);
  }
}

function* batches(array, batchSize) {
  for (let index = 0; index < array.length; index += batchSize) yield array.slice(index, index + batchSize);
}

const VALID_PARSE_STATUSES = new Set(["SUCCESS", "PARTIAL", "FAILED"]);

function assertValidChunk(chunk) {
  for (const field of ["chunk_id", "source_document_id", "node_id", "source_locator", "text_sha256", "text_content"]) {
    if (typeof chunk[field] !== "string" || chunk[field] === "") {
      throw new DedupRetrievalLoaderError(`chunk is missing required non-empty string field: ${field}`);
    }
  }
  const blockType = chunk.metadata?.block_type;
  if (typeof blockType !== "string" || blockType === "") {
    throw new DedupRetrievalLoaderError(`chunk ${chunk.chunk_id}: metadata.block_type is required`);
  }
  if (!VALID_PARSE_STATUSES.has(chunk.parse_status)) {
    throw new DedupRetrievalLoaderError(`chunk ${chunk.chunk_id}: invalid parse_status ${chunk.parse_status}`);
  }
}

// Pass 1: builds the canonical text_sha256 -> { text, charLength } map and
// counts total occurrences, WITHOUT holding the occurrence rows themselves
// in memory (only counting them).
async function scanCanonicalTexts(chunkSourceFactory) {
  const canonicalByHash = new Map();
  const seenChunkIds = new Set();
  let occurrenceCount = 0;
  for await (const chunk of chunkSourceFactory()) {
    assertValidChunk(chunk);
    if (seenChunkIds.has(chunk.chunk_id)) {
      throw new DedupRetrievalLoaderError(`duplicate chunk_id in source: ${chunk.chunk_id}`);
    }
    seenChunkIds.add(chunk.chunk_id);
    occurrenceCount += 1;
    if (!canonicalByHash.has(chunk.text_sha256)) {
      canonicalByHash.set(chunk.text_sha256, { text: chunk.text_content, charLength: chunk.text_content.length });
    } else {
      const existing = canonicalByHash.get(chunk.text_sha256);
      if (existing.text !== chunk.text_content) {
        throw new DedupRetrievalLoaderError(
          `text_sha256 collision with different text_content: ${chunk.text_sha256} (chunk_id=${chunk.chunk_id}) -- refusing to treat two different texts as the same canonical row`,
        );
      }
    }
  }
  return { canonicalByHash, occurrenceCount };
}

export async function loadExactTextDedupIndex({
  client,
  chunkSourceFactory,
  embeddingAdapter,
  embeddingConfig,
  distanceMetric = "cosine",
  releaseId,
  sourceSnapshotId,
  chunkingPolicyId,
  chunkingPolicySha256,
  batchSize = 100,
  signal,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required (a single dedicated connection, not a Pool)");
  if (typeof chunkSourceFactory !== "function") throw new TypeError("chunkSourceFactory (a function returning a fresh async iterable) is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedDocuments !== "function") throw new TypeError("embeddingAdapter is required");
  if (!embeddingConfig || typeof embeddingConfig.provider !== "string" || typeof embeddingConfig.model !== "string"
    || typeof embeddingConfig.revision !== "string" || !Number.isInteger(embeddingConfig.dimension) || embeddingConfig.dimension < 1) {
    throw new TypeError("embeddingConfig must be { provider, model, revision, dimension }");
  }
  for (const field of [["releaseId", releaseId], ["sourceSnapshotId", sourceSnapshotId], ["chunkingPolicyId", chunkingPolicyId], ["chunkingPolicySha256", chunkingPolicySha256]]) {
    if (typeof field[1] !== "string" || field[1] === "") throw new TypeError(`${field[0]} is required`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError("batchSize must be a positive integer");

  const retrievalIndexId = computeDedupRetrievalIndexId({
    releaseId, sourceSnapshotId,
    embeddingProvider: embeddingConfig.provider, embeddingModel: embeddingConfig.model, embeddingRevision: embeddingConfig.revision,
    chunkingPolicyId,
  });

  const { canonicalByHash, occurrenceCount } = await scanCanonicalTexts(chunkSourceFactory);
  if (canonicalByHash.size === 0) {
    throw new DedupRetrievalLoaderError("no chunks were found in the source -- refusing to create an empty dedup index");
  }

  const embeddingConfigHash = sha256Hex({ provider: embeddingConfig.provider, model: embeddingConfig.model, revision: embeddingConfig.revision, dimension: embeddingConfig.dimension });
  const canonicalFingerprints = [...canonicalByHash.keys()].sort();
  const manifestSha256 = sha256Hex({
    release_id: releaseId,
    source_snapshot_id: sourceSnapshotId,
    embedding_provider: embeddingConfig.provider,
    embedding_model: embeddingConfig.model,
    embedding_revision: embeddingConfig.revision,
    embedding_dimension: embeddingConfig.dimension,
    distance_metric: distanceMetric,
    chunking_policy_id: chunkingPolicyId,
    chunking_policy_sha256: chunkingPolicySha256,
    canonical_text_sha256_fingerprints: canonicalFingerprints,
    occurrence_count: occurrenceCount,
  });

  // --- idempotency / reuse-prevention check (before opening a transaction) ---
  const existing = await client.query(
    `SELECT retrieval_index_id, index_status, manifest_sha256
     FROM disclosure_reference.reference_dedup_indexes WHERE retrieval_index_id = $1`,
    [retrievalIndexId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.index_status === "LOADING") {
      throw new DedupRetrievalLoaderError(`dedup retrieval index "${retrievalIndexId}" already exists in LOADING status -- refusing to resume or duplicate an in-flight/abandoned load`);
    }
    if (row.manifest_sha256 !== manifestSha256) {
      throw new DedupRetrievalLoaderError(`dedup retrieval index "${retrievalIndexId}" already exists with a DIFFERENT manifest_sha256 -- a different embedding config/snapshot must never reuse the same retrieval_index_id`);
    }
    return { retrievalIndexId, created: false, canonicalCount: canonicalByHash.size, occurrenceCount, manifestSha256 };
  }

  // --- embed every DISTINCT text exactly once, in configurable batches ---
  const orderedHashes = [...canonicalByHash.keys()];
  const embeddingByHash = new Map();
  for (const batch of batches(orderedHashes, batchSize)) {
    if (signal?.aborted) throw new DedupRetrievalLoaderError("aborted before embedding completed");
    const texts = batch.map((hash) => canonicalByHash.get(hash).text);
    // eslint-disable-next-line no-await-in-loop
    const vectors = await embeddingAdapter.embedDocuments(texts, embeddingConfig);
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new DedupRetrievalLoaderError(`embedDocuments returned ${Array.isArray(vectors) ? vectors.length : typeof vectors} vectors for ${batch.length} input texts -- order/count must be preserved 1:1`);
    }
    vectors.forEach((vector, index) => {
      assertFiniteVector(vector, embeddingConfig.dimension, `embedding for text_sha256=${batch[index]}`);
      embeddingByHash.set(batch[index], vector);
    });
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO disclosure_reference.reference_dedup_indexes
         (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
          embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, index_status, canonical_count, occurrence_count, manifest_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'LOADING', $11, $12, $13)`,
      [
        retrievalIndexId, releaseId, sourceSnapshotId, embeddingConfig.provider, embeddingConfig.model, embeddingConfig.revision,
        embeddingConfig.dimension, distanceMetric, chunkingPolicyId, chunkingPolicySha256, canonicalByHash.size, occurrenceCount, manifestSha256,
      ],
    );

    for (const hash of orderedHashes) {
      const entry = canonicalByHash.get(hash);
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO disclosure_reference.reference_dedup_canonical_texts
           (retrieval_index_id, text_sha256, canonical_text, char_length, embedding_config_hash, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [retrievalIndexId, hash, entry.text, entry.charLength, embeddingConfigHash, toPgvectorLiteral(embeddingByHash.get(hash))],
      );
    }

    for await (const chunk of chunkSourceFactory()) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO disclosure_reference.reference_dedup_occurrences
           (retrieval_index_id, chunk_id, text_sha256, source_document_id, corp_code, source_group, document_type,
            node_id, source_locator, block_type, parse_status, chunk_ordinal, char_start, char_end, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          retrievalIndexId, chunk.chunk_id, chunk.text_sha256, chunk.source_document_id, chunk.corp_code ?? null,
          chunk.source_group ?? null, chunk.document_type ?? null, chunk.node_id, chunk.source_locator,
          chunk.metadata.block_type, chunk.parse_status, chunk.chunk_ordinal, chunk.char_start, chunk.char_end,
          JSON.stringify(chunk.metadata ?? {}),
        ],
      );
    }

    await client.query(
      `UPDATE disclosure_reference.reference_dedup_indexes SET index_status = 'READY', ready_at = now() WHERE retrieval_index_id = $1`,
      [retrievalIndexId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  return { retrievalIndexId, created: true, canonicalCount: canonicalByHash.size, occurrenceCount, manifestSha256 };
}
