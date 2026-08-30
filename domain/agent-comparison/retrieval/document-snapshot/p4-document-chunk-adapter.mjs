// Turn P5: pure, read-only compatibility bridge between this Turn's
// portable snapshot chunk shape and Turn P4's
// `disclosure_reference.reference_retrieval_chunks` DOCUMENT_CHUNK input
// shape (domain/postgres/003_reference_vector_retrieval.sql,
// domain/postgres/reference-vector-retrieval-loader.mjs's own
// VERIFIED_EVIDENCE chunk-building convention). This module NEVER opens a
// database connection, NEVER computes an embedding, and NEVER imports
// anything from domain/postgres other than the pure `computeChunkId`
// helper -- it only proves the shapes line up, exactly the way Turn P4's
// own smoke tests proved a Retriever adapter's output shape against the
// frozen retrieval-result.schema.json without a real search backend.
//
// A retrieval_index_id is required here because P4's chunk_id is INDEX-
// scoped (computeChunkId({ retrievalIndexId, recordKey })) -- this
// snapshot's own chunk_id (see contracts.mjs's computeSnapshotChunkId) is
// snapshot-scoped instead. That is why record_key below is this snapshot's
// own chunk_id: it is already a globally unique, deterministic natural key,
// so a future real DOCUMENT_CHUNK loader can compute a stable P4 chunk_id
// from it without this module needing to know which retrieval index it
// will eventually be loaded into.
import { computeChunkId } from "../../../postgres/reference-vector-retrieval-repository.mjs";

export function toP4DocumentChunkRecord({ retrievalIndexId, snapshotChunk }) {
  if (typeof retrievalIndexId !== "string" || retrievalIndexId === "") {
    throw new TypeError("retrievalIndexId is required");
  }
  if (!snapshotChunk || typeof snapshotChunk !== "object") {
    throw new TypeError("snapshotChunk is required");
  }
  const recordKey = snapshotChunk.chunk_id;
  return {
    retrieval_index_id: retrievalIndexId,
    chunk_id: computeChunkId({ retrievalIndexId, recordKey }),
    source_kind: "DOCUMENT_CHUNK",
    record_key: recordKey,
    evidence_id: null,
    source_document_id: snapshotChunk.source_document_id,
    corp_code: snapshotChunk.corp_code ?? null,
    source_locator: snapshotChunk.source_locator,
    chunk_ordinal: snapshotChunk.chunk_ordinal,
    text_content: snapshotChunk.text_content,
    text_sha256: snapshotChunk.text_sha256,
    // Carries the snapshot's own identity forward so a future loader (or an
    // audit) can trace a loaded row back to the exact portable snapshot
    // chunk it came from, without this table needing dedicated columns for
    // it -- exactly the convention reference-vector-retrieval-loader.mjs
    // already uses for VERIFIED_EVIDENCE's file_id/extraction_method.
    metadata: {
      snapshot_id: snapshotChunk.snapshot_id,
      snapshot_chunk_id: snapshotChunk.chunk_id,
      chunking_policy_id: snapshotChunk.chunking_policy_id,
      chunking_policy_sha256: snapshotChunk.chunking_policy_sha256,
      source_group: snapshotChunk.source_group,
      document_type: snapshotChunk.document_type,
      node_id: snapshotChunk.node_id,
      ...snapshotChunk.metadata,
    },
  };
}
