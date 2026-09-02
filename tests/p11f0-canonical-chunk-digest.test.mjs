// Turn P11-F0: scoped, offline tests for canonical-chunk-digest.mjs.
// Synthetic fixtures only -- no real corpus, no DB, no Gold.
import assert from "node:assert/strict";
import test from "node:test";
import { toChunkDigestRecord, canonicalChunkDigestSha256, createChunkStreamDigestAccumulator } from "../domain/agent-comparison/chunking-comparison/canonical-chunk-digest.mjs";

function fakeChunk(overrides = {}) {
  return {
    chunk_id: "chunk_000000000000000000000001",
    document_id: "periodic_00000000000001",
    chunk_index: 0,
    chunk_type: "FIXED_WINDOW",
    parent_chunk_id: null,
    content_sha256: "a".repeat(64),
    raw_text: "매출액은 1,000,000원입니다.",
    embed_text: "기업: 테스트\n문서: 사업보고서\n청크유형: FIXED_WINDOW\n\n매출액은 1,000,000원입니다.",
    token_count: 12,
    section_path: ["섹션1"],
    source_locator: "periodic_00000000000001/file_1#node=1",
    source_spans: [{ node_id: "n1" }],
    chunking_config_id: "fixed-token-512-o64.v0.1.0",
    strategy_version: "0.1.0",
    metadata: { corp_code: "00000001", doc_group: "periodic", receipt_date: "2026-01-01", retrieval_eligible: true },
    ...overrides,
  };
}

test("toChunkDigestRecord: derives embed_text_sha256 and never invents fields", () => {
  const digest = toChunkDigestRecord(fakeChunk());
  assert.equal(digest.chunk_id, "chunk_000000000000000000000001");
  assert.equal(digest.chunk_type, "FIXED_WINDOW");
  assert.equal(digest.parent_chunk_id, null);
  assert.equal(digest.retrieval_eligible, true);
  assert.equal(digest.corp_code, "00000001");
  assert.match(digest.embed_text_sha256, /^[0-9a-f]{64}$/);
});

test("toChunkDigestRecord: retrieval_eligible reads metadata.retrieval_eligible, never assumed true", () => {
  const digest = toChunkDigestRecord(fakeChunk({ metadata: { corp_code: "00000001", doc_group: "periodic", retrieval_eligible: false } }));
  assert.equal(digest.retrieval_eligible, false);
});

test("canonicalChunkDigestSha256: identical structural fields (different raw_text/embed_text CONTENT, same hashes) produce the identical digest sha256", () => {
  const chunk = fakeChunk();
  const digestA = toChunkDigestRecord(chunk);
  // Different embed_text STRING but identical embed_text_sha256 (impossible
  // in reality without a hash collision, but this proves the digest hashes
  // the SHA, never the raw text itself).
  const digestB = { ...digestA, embed_text: "totally different text, same sha", raw_text: "different too" };
  assert.equal(canonicalChunkDigestSha256(digestA), canonicalChunkDigestSha256(digestB));
});

test("canonicalChunkDigestSha256: a different chunk_id changes the digest", () => {
  const digestA = toChunkDigestRecord(fakeChunk());
  const digestB = toChunkDigestRecord(fakeChunk({ chunk_id: "chunk_000000000000000000000002" }));
  assert.notEqual(canonicalChunkDigestSha256(digestA), canonicalChunkDigestSha256(digestB));
});

test("createChunkStreamDigestAccumulator: same sequence of chunks (two independent passes) yields the identical stream sha256", () => {
  const chunks = [fakeChunk(), fakeChunk({ chunk_id: "chunk_000000000000000000000002", chunk_index: 1 })];

  const pass1 = createChunkStreamDigestAccumulator();
  for (const chunk of chunks) pass1.update(toChunkDigestRecord(chunk));
  const result1 = pass1.finalize();

  const pass2 = createChunkStreamDigestAccumulator();
  for (const chunk of chunks) pass2.update(toChunkDigestRecord(chunk));
  const result2 = pass2.finalize();

  assert.equal(result1.streamSha256, result2.streamSha256);
  assert.equal(result1.chunkCount, 2);
  assert.equal(result2.chunkCount, 2);
});

test("createChunkStreamDigestAccumulator: order matters -- reversing the chunk sequence changes the stream sha256", () => {
  const chunks = [fakeChunk(), fakeChunk({ chunk_id: "chunk_000000000000000000000002", chunk_index: 1 })];

  const forward = createChunkStreamDigestAccumulator();
  for (const chunk of chunks) forward.update(toChunkDigestRecord(chunk));

  const reversed = createChunkStreamDigestAccumulator();
  for (const chunk of [...chunks].reverse()) reversed.update(toChunkDigestRecord(chunk));

  assert.notEqual(forward.finalize().streamSha256, reversed.finalize().streamSha256);
});
