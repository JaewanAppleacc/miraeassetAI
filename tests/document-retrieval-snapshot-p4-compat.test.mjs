import test from "node:test";
import assert from "node:assert/strict";
import { toP4DocumentChunkRecord } from "../domain/agent-comparison/retrieval/document-snapshot/p4-document-chunk-adapter.mjs";
import { computeChunkId } from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { CHUNK_ID_PATTERN, computeSnapshotChunkId, sha256Hex } from "../domain/agent-comparison/retrieval/document-snapshot/contracts.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";

function sampleSnapshotChunk(overrides = {}) {
  const textContent = overrides.text_content ?? "샘플 청크 텍스트입니다.";
  const textSha256 = sha256Hex(textContent);
  const snapshotId = overrides.snapshot_id ?? "docsnap_" + "a".repeat(32);
  const sourceDocumentId = overrides.source_document_id ?? "exchange_20250101000001";
  const nodeId = overrides.node_id ?? "exchange_20250101000001::a.xml::n0";
  const chunkOrdinal = overrides.chunk_ordinal ?? 0;
  return {
    schema_version: "0.1.0",
    snapshot_id: snapshotId,
    chunking_policy_id: "document-node-first-v0.1",
    chunking_policy_sha256: "b".repeat(64),
    chunk_id: computeSnapshotChunkId({ snapshotId, sourceDocumentId, nodeId, chunkOrdinal, textSha256 }),
    source_document_id: sourceDocumentId,
    corp_code: overrides.corp_code === undefined ? "00000001" : overrides.corp_code,
    source_group: "exchange",
    document_type: "단일판매공급계약체결",
    source_locator: `${sourceDocumentId}/a.xml#node=0`,
    node_id: nodeId,
    chunk_ordinal: chunkOrdinal,
    char_start: 0,
    char_end: textContent.length,
    text_content: textContent,
    text_sha256: textSha256,
    parse_status: "SUCCESS",
    metadata: { block_type: "PARAGRAPH", section_path: [], node_chunk_index: 0, node_chunk_count: 1, table_row_range: null, file_id: "file_" + "c".repeat(24), file_relative_path: "a.xml" },
  };
}

test("toP4DocumentChunkRecord produces a shape satisfying every 003_reference_vector_retrieval.sql CHECK constraint", () => {
  const retrievalIndexId = "retrieval_index_" + "d".repeat(32);
  const snapshotChunk = sampleSnapshotChunk();
  const record = toP4DocumentChunkRecord({ retrievalIndexId, snapshotChunk });

  assert.match(record.chunk_id, CHUNK_ID_PATTERN);
  assert.equal(record.chunk_id, computeChunkId({ retrievalIndexId, recordKey: snapshotChunk.chunk_id }), "must use P4's own computeChunkId, not a reimplementation");
  assert.equal(record.source_kind, "DOCUMENT_CHUNK");
  assert.equal(record.evidence_id, null, "CHECK only requires evidence_id for VERIFIED_EVIDENCE; DOCUMENT_CHUNK must send null");
  assert.match(record.corp_code, /^[0-9]{8}$/);
  assert.equal(record.source_document_id, snapshotChunk.source_document_id);
  assert.ok(record.text_content.length > 0);
  assert.match(record.text_sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof record.record_key, "string");
  assert.ok(record.record_key.length > 0);
  assert.equal(record.metadata.snapshot_chunk_id, snapshotChunk.chunk_id, "must be traceable back to the exact snapshot chunk");
});

test("record_key is this snapshot's own chunk_id, so it is globally unique without needing the retrieval index", () => {
  const chunkA = sampleSnapshotChunk({ chunk_ordinal: 0 });
  const chunkB = sampleSnapshotChunk({ chunk_ordinal: 1 });
  const recordA = toP4DocumentChunkRecord({ retrievalIndexId: "retrieval_index_x", snapshotChunk: chunkA });
  const recordB = toP4DocumentChunkRecord({ retrievalIndexId: "retrieval_index_x", snapshotChunk: chunkB });
  assert.notEqual(recordA.record_key, recordB.record_key);
  assert.notEqual(recordA.chunk_id, recordB.chunk_id);
});

test("corp_code null is passed through as null (never guessed) and still satisfies the nullable CHECK", () => {
  const snapshotChunk = sampleSnapshotChunk({ corp_code: null });
  const record = toP4DocumentChunkRecord({ retrievalIndexId: "retrieval_index_y", snapshotChunk });
  assert.equal(record.corp_code, null);
});

test("toP4DocumentChunkRecord requires retrievalIndexId and snapshotChunk", () => {
  assert.throws(() => toP4DocumentChunkRecord({ retrievalIndexId: "", snapshotChunk: sampleSnapshotChunk() }), TypeError);
  assert.throws(() => toP4DocumentChunkRecord({ retrievalIndexId: "retrieval_index_z", snapshotChunk: null }), TypeError);
});

test("a fake deterministic embedding adapter can embed snapshot chunk texts, preserving order/count/dimension, without persisting anything", async () => {
  const chunks = [sampleSnapshotChunk({ chunk_ordinal: 0, text_content: "첫 번째 청크" }), sampleSnapshotChunk({ chunk_ordinal: 1, text_content: "두 번째 청크, 다른 내용" })];
  const adapter = createDeterministicFakeEmbeddingAdapter({ dimension: 16 });
  const vectors = await adapter.embedDocuments(chunks.map((c) => c.text_content));
  assert.equal(vectors.length, chunks.length);
  for (const vector of vectors) {
    assert.equal(vector.length, 16);
    assert.ok(vector.every((value) => Number.isFinite(value)));
  }
  // Same text -> same vector (determinism), different text -> different vector.
  const repeat = await adapter.embedDocuments([chunks[0].text_content]);
  assert.deepEqual(repeat[0], vectors[0]);
  assert.notDeepEqual(vectors[0], vectors[1]);
});
