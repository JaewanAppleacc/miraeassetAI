// Turn P4: loader that reads VERIFIED Evidence read-only from an
// ALREADY-PINNED, READY reference-repository.mjs Repository (the caller
// constructs that repository with its own 4-pin -- this loader never picks
// or defaults a release itself), embeds each Evidence's own quoted_text
// verbatim, and writes ONE LOADING retrieval index + its chunks in a
// single transaction before flipping it READY. It never touches
// disclosure_reference.releases/artifacts/records -- those stay exactly as
// 002_reference_release.sql left them; this loader only ever reads them
// (via the Repository) and writes to the two NEW tables
// 003_reference_vector_retrieval.sql added.
//
// VERIFIED_EVIDENCE CHUNK CONTRACT: one Evidence record -> one chunk, no
// exceptions. `text_content` is `payload.quoted_text` byte-for-byte -- this
// loader never splits, joins, paraphrases, or otherwise synthesizes a
// sentence that was not already the Evidence's own stored quote. An empty
// quoted_text, or an Evidence whose verification_status is not VERIFIED
// (the Repository's own queryEvidence already only returns VERIFIED rows,
// re-checked here defensively), is skipped -- never indexed as an empty or
// unverified chunk.
//
// DOCUMENT_CHUNK is NOT implemented by this loader at all this Turn (see
// domain/postgres/README.md's Turn P4 section) -- only its schema/interface
// exists (003_reference_vector_retrieval.sql's source_kind enum,
// domain/agent-comparison/retrieval/'s embedding contracts). Loading real
// document chunks requires a full-corpus DocumentIR portable snapshot and a
// chunking_policy pin this Turn does not create.
import { createHash } from "node:crypto";
import { computeChunkId } from "./reference-vector-retrieval-repository.mjs";

export class VectorRetrievalLoaderError extends Error {
  constructor(message) {
    super(message);
    this.name = "VectorRetrievalLoaderError";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonicalize(value))).digest("hex");
}

// Deterministic: the SAME (release, embedding config, chunking policy)
// always produces the SAME retrieval_index_id -- this is what makes a
// re-run of this loader against unchanged inputs an idempotent no-op
// rather than a fresh, colliding-or-duplicate index.
export function computeRetrievalIndexId({ releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId }) {
  const digest = sha256Hex({ releaseId, sourceSnapshotId, embeddingProvider, embeddingModel, embeddingRevision, chunkingPolicyId });
  return `retrieval_index_${digest.slice(0, 32)}`;
}

const FAR_FUTURE_AS_OF_DATE = "9999-12-31";
export const VERIFIED_EVIDENCE_CHUNKING_POLICY_ID = "verified-evidence-one-chunk-per-evidence-v1";
const VERIFIED_EVIDENCE_CHUNKING_POLICY_SHA256 = sha256Hex({
  policy: VERIFIED_EVIDENCE_CHUNKING_POLICY_ID,
  rule: "one VERIFIED Evidence record -> exactly one chunk, quoted_text verbatim, no synthesis",
});

function toPgvectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function assertFiniteVector(vector, dimension, label) {
  if (!Array.isArray(vector) || vector.length !== dimension) {
    throw new VectorRetrievalLoaderError(`${label}: expected a ${dimension}-dimension vector, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new VectorRetrievalLoaderError(`${label}: embedding vector must contain only finite numbers (no NaN/Infinity)`);
  }
}

// Mirrors reference-repository.mjs's own internal buildDocumentCorpMap:
// resolves each source_document_id's corp_code from the SAME release's
// VERIFIED Fact records (an Evidence record itself carries no corp_code --
// see semantic-bundle.schema.json's evidence $def). A document with no
// resolvable corp_code (no VERIFIED Fact anchors it) simply gets
// corp_code=null -- never guessed.
async function buildDocumentCorpMap(referenceRepository, signal) {
  const facts = await referenceRepository.queryFacts({ as_of_date: FAR_FUTURE_AS_OF_DATE, limit: 1000 }, { signal });
  const map = new Map();
  for (const record of facts) {
    const corpCode = record.payload?.corp_code;
    const documentId = record.payload?.source_document_id;
    if (documentId && corpCode) map.set(documentId, corpCode);
  }
  return map;
}

async function fetchVerifiedEvidenceChunks(referenceRepository, retrievalIndexId, signal) {
  const evidenceRecords = await referenceRepository.queryEvidence({ as_of_date: FAR_FUTURE_AS_OF_DATE, limit: 1000 }, { signal });
  if (evidenceRecords.length >= 1000) {
    throw new VectorRetrievalLoaderError(
      "this release has >= 1000 VERIFIED_EVIDENCE records -- reference-repository.mjs's own query limit (1000) means this loader cannot see them all in one call. " +
      "This Turn's scope is the v0.20-r3 VERIFIED Evidence set only (well under this limit); a future Turn indexing a larger release must add pagination here.",
    );
  }
  const documentCorpMap = await buildDocumentCorpMap(referenceRepository, signal);

  const chunks = [];
  let ordinal = 0;
  for (const record of evidenceRecords) {
    const payload = record.payload;
    if (payload.verification_status !== "VERIFIED") continue; // defensive; queryEvidence already guarantees this
    if (typeof payload.quoted_text !== "string" || payload.quoted_text.trim() === "") continue; // never index an empty/absent quote
    chunks.push({
      chunk_id: computeChunkId({ retrievalIndexId, recordKey: payload.evidence_id }),
      source_kind: "VERIFIED_EVIDENCE",
      record_key: payload.evidence_id,
      evidence_id: payload.evidence_id,
      source_document_id: payload.document_id,
      corp_code: documentCorpMap.get(payload.document_id) ?? null,
      source_locator: payload.source_locator,
      chunk_ordinal: ordinal,
      text_content: payload.quoted_text,
      text_sha256: sha256Hex(payload.quoted_text),
      // file_id is carried in metadata rather than as its own column --
      // reference_retrieval_chunks intentionally has no dedicated file_id
      // column (see 003_reference_vector_retrieval.sql's own minimal
      // column set). It is only needed downstream to build a valid
      // RetrieverResult.results[].source_spans[].file_id (see
      // domain/agent-comparison/retrieval/pgvector-retriever-adapter.mjs),
      // never for search filtering itself.
      metadata: { file_id: payload.file_id, extraction_method: payload.extraction_method ?? null, confidence: payload.confidence ?? null },
    });
    ordinal += 1;
  }
  return chunks;
}

// One transaction: LOADING index row -> all chunk rows -> READY flip.
// `client` must be a single, dedicated connection (not a Pool) so BEGIN/
// COMMIT/ROLLBACK apply to the same underlying session throughout -- the
// same requirement domain/postgres/reference-release-loader.mjs's own
// importReferenceRelease documents for the exact same reason.
export async function loadVerifiedEvidenceRetrievalIndex({
  client,
  referenceRepository,
  embeddingAdapter,
  embeddingConfig,
  distanceMetric = "cosine",
  sourceSnapshotId,
  signal,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("client is required (a single dedicated connection, not a Pool)");
  if (!referenceRepository || typeof referenceRepository.queryEvidence !== "function") throw new TypeError("referenceRepository is required");
  if (!embeddingAdapter || typeof embeddingAdapter.embedDocuments !== "function") throw new TypeError("embeddingAdapter is required");
  if (!embeddingConfig || typeof embeddingConfig.provider !== "string" || typeof embeddingConfig.model !== "string"
    || typeof embeddingConfig.revision !== "string" || !Number.isInteger(embeddingConfig.dimension) || embeddingConfig.dimension < 1) {
    throw new TypeError("embeddingConfig must be { provider, model, revision, dimension }");
  }
  if (typeof sourceSnapshotId !== "string" || sourceSnapshotId === "") throw new TypeError("sourceSnapshotId is required");

  const retrievalIndexId = computeRetrievalIndexId({
    releaseId: referenceRepository.releaseId,
    sourceSnapshotId,
    embeddingProvider: embeddingConfig.provider,
    embeddingModel: embeddingConfig.model,
    embeddingRevision: embeddingConfig.revision,
    chunkingPolicyId: VERIFIED_EVIDENCE_CHUNKING_POLICY_ID,
  });

  const chunks = await fetchVerifiedEvidenceChunks(referenceRepository, retrievalIndexId, signal);
  const manifestSha256 = sha256Hex({
    release_id: referenceRepository.releaseId,
    source_snapshot_id: sourceSnapshotId,
    embedding_provider: embeddingConfig.provider,
    embedding_model: embeddingConfig.model,
    embedding_revision: embeddingConfig.revision,
    embedding_dimension: embeddingConfig.dimension,
    distance_metric: distanceMetric,
    chunking_policy_id: VERIFIED_EVIDENCE_CHUNKING_POLICY_ID,
    chunking_policy_sha256: VERIFIED_EVIDENCE_CHUNKING_POLICY_SHA256,
    chunk_fingerprints: chunks.map((c) => [c.chunk_id, c.text_sha256]).sort((a, b) => a[0].localeCompare(b[0])),
  });

  // --- idempotency / reuse-prevention check (before opening a transaction) ---
  const existing = await client.query(
    `SELECT retrieval_index_id, index_status, manifest_sha256, embedding_provider, embedding_model, embedding_revision, embedding_dimension
     FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1`,
    [retrievalIndexId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.index_status === "LOADING") {
      throw new VectorRetrievalLoaderError(`retrieval index "${retrievalIndexId}" already exists in LOADING status -- refusing to resume or duplicate an in-flight/abandoned load`);
    }
    if (row.manifest_sha256 !== manifestSha256) {
      throw new VectorRetrievalLoaderError(
        `retrieval index "${retrievalIndexId}" already exists with a DIFFERENT manifest_sha256 -- a different embedding config must never reuse the same retrieval_index_id`,
      );
    }
    // Same manifest, already READY -- idempotent no-op.
    return { retrievalIndexId, created: false, recordCount: chunks.length, manifestSha256 };
  }

  if (chunks.length === 0) {
    throw new VectorRetrievalLoaderError("no indexable VERIFIED Evidence chunks were found -- refusing to create an empty retrieval index");
  }

  const embeddings = await embeddingAdapter.embedDocuments(chunks.map((c) => c.text_content), embeddingConfig);
  if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
    throw new VectorRetrievalLoaderError(`embedDocuments returned ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings} vectors for ${chunks.length} input texts -- order/count must be preserved 1:1`);
  }
  embeddings.forEach((vector, index) => assertFiniteVector(vector, embeddingConfig.dimension, `embedding for chunk_id=${chunks[index].chunk_id}`));

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO disclosure_reference.reference_retrieval_indexes
         (retrieval_index_id, release_id, source_snapshot_id, embedding_provider, embedding_model, embedding_revision,
          embedding_dimension, distance_metric, chunking_policy_id, chunking_policy_sha256, index_status, record_count, manifest_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'LOADING', $11, $12)`,
      [
        retrievalIndexId, referenceRepository.releaseId, sourceSnapshotId, embeddingConfig.provider, embeddingConfig.model,
        embeddingConfig.revision, embeddingConfig.dimension, distanceMetric, VERIFIED_EVIDENCE_CHUNKING_POLICY_ID,
        VERIFIED_EVIDENCE_CHUNKING_POLICY_SHA256, chunks.length, manifestSha256,
      ],
    );

    for (const [index, chunk] of chunks.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO disclosure_reference.reference_retrieval_chunks
           (retrieval_index_id, chunk_id, source_kind, record_key, evidence_id, source_document_id, corp_code,
            source_locator, chunk_ordinal, text_content, text_sha256, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector)`,
        [
          retrievalIndexId, chunk.chunk_id, chunk.source_kind, chunk.record_key, chunk.evidence_id, chunk.source_document_id,
          chunk.corp_code, chunk.source_locator, chunk.chunk_ordinal, chunk.text_content, chunk.text_sha256,
          JSON.stringify(chunk.metadata), toPgvectorLiteral(embeddings[index]),
        ],
      );
    }

    await client.query(
      `UPDATE disclosure_reference.reference_retrieval_indexes SET index_status = 'READY', ready_at = now() WHERE retrieval_index_id = $1`,
      [retrievalIndexId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  return { retrievalIndexId, created: true, recordCount: chunks.length, manifestSha256 };
}
