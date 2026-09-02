// Turn P11-F0: the canonical per-chunk digest record CLAUDE.md section C
// requires ("집계 count만 hash하는 방식은 금지한다") -- every field a
// double-pass determinism check and a materialized-chunk provenance row
// both need, derived UNCHANGED from domain/chunking/chunker.mjs's own
// chunkDocument() output (no field is re-synthesized or renamed to mean
// something different than it already means there).
import { createHash } from "node:crypto";

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

// The embed_text actually sent to the embedding model (see
// scripts/p10.2-stage2-embedding-grid.mjs's own embedRoleCached call sites
// -- chunk.embed_text, never chunk.raw_text) is what this loader dedups on
// for the embedding pass; content_sha256 (raw_text) is a SEPARATE,
// narrower identity chunker.mjs already computes for its own
// duplicate_group_id.
export function toChunkDigestRecord(chunk) {
  return Object.freeze({
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    chunk_index: chunk.chunk_index,
    chunk_type: chunk.chunk_type,
    parent_chunk_id: chunk.parent_chunk_id ?? null,
    content_sha256: chunk.content_sha256,
    raw_text: chunk.raw_text,
    embed_text_sha256: sha256Hex(chunk.embed_text),
    embed_text: chunk.embed_text,
    token_count: chunk.token_count,
    corp_code: chunk.metadata.corp_code ?? null,
    doc_group: chunk.metadata.doc_group,
    receipt_date: chunk.metadata.receipt_date ?? null,
    section_path: chunk.section_path,
    source_locator: chunk.source_locator,
    source_spans: chunk.source_spans,
    chunking_policy_id: chunk.chunking_config_id,
    chunking_policy_version: chunk.strategy_version,
    retrieval_eligible: chunk.metadata.retrieval_eligible === true,
    metadata: chunk.metadata,
  });
}

// Deterministic, order-sensitive: only the fields that identify/describe
// the chunk (never a wall-clock timestamp, never a random id) -- the SAME
// chunk stream (same corpus, same chunking policy, processed in the SAME
// fixed 4-file/document/chunk-index order full-corpus-streamer.mjs already
// guarantees) always yields the SAME sha256, in both discovery passes.
export function canonicalChunkDigestSha256(digestRecord) {
  // eslint-disable-next-line no-unused-vars -- the digest hashes content_sha256/embed_text_sha256, never the raw embed_text/raw_text themselves (keeps this hash cheap and never accidentally logs full text)
  const { embed_text, raw_text, ...withoutRawText } = digestRecord;
  return sha256Hex(withoutRawText);
}

// A running, O(1)-memory accumulator for the whole-corpus double-pass
// stream digest: never buffers more than one chunk's digest at a time.
// update() feeds one chunk's canonical digest sha256 into the running
// hash, in stream order; digest() finalizes it. This is a hash-of-hashes
// (sha256 over the concatenation of every per-chunk canonicalChunkDigestSha256,
// in order) -- collision-resistant and cheap to recompute in a second,
// pure, DB-write-free verification pass.
export function createChunkStreamDigestAccumulator() {
  const hash = createHash("sha256");
  let count = 0;
  return {
    update(digestRecord) {
      hash.update(canonicalChunkDigestSha256(digestRecord), "utf8");
      count += 1;
    },
    finalize() {
      return { streamSha256: hash.digest("hex"), chunkCount: count };
    },
  };
}
