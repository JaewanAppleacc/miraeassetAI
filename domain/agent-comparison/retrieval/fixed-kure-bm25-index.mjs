// Turn P11-F0 section H: builds and (de)serializes a PERSISTED BM25
// lexical index over one Fixed-512-o64 x KURE-v1 load session's chunks,
// reusing P10.2's own bm25.mjs (k1=1.5, b=0.75, tokenizeWithOffsets)
// UNCHANGED -- never re-implemented, never silently swapped for
// PostgreSQL's ts_rank (CLAUDE.md Turn P11-F0 section H's own explicit
// warning against exactly that substitution).
//
// P10.2's own stage2 script builds its BM25 index over chunk.embed_text
// (company/document/section-context-prefixed), not raw_text -- this Turn
// matches that choice exactly for semantic parity
// (scripts/p10.2-stage2-embedding-grid.mjs's own
// `buildBm25Index(filtered.map((c) => ({ id: c.chunk_id, text: c.embed_text })))`).
// embed_text is never persisted in 003's shared reference_retrieval_chunks
// table (which stores the VERBATIM raw_text instead, for
// RetrieverResult.raw_text/SOURCE_VERBATIM) -- it is reconstructed here
// from this loader's OWN, indefinitely-persisted
// reference_fixed_kure_chunk_staging x reference_fixed_kure_canonical_queue
// join, which is exactly why those two loader-internal tables are never
// deleted after materialization.
//
// "영속" (persisted): built ONCE per load_session_id and serialized to a
// task-owned cache file (never git, never work/) -- a later process
// start loads it back from disk instead of re-querying/re-tokenizing the
// whole chunk set, and NEVER re-scans the raw 8.6GB corpus.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildBm25Index, bm25Search, defaultTokenize } from "../chunking-comparison/bm25.mjs";

const PAGE_SIZE = 2000;

// Streams (chunk_id, embed_text) pairs for every retrieval-eligible,
// materialized chunk in this load session, paginated -- never holds more
// than one page in memory at build time (the FINAL in-memory index itself
// is, by design, the one long-lived structure this module builds; see this
// file's own header for why that is the correct tradeoff here).
async function* streamChunkEmbedTexts(client, loadSessionId) {
  let lastChunkId = "";
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await client.query(
      `SELECT s.chunk_id, q.embed_text
       FROM disclosure_reference.reference_fixed_kure_chunk_staging s
       JOIN disclosure_reference.reference_fixed_kure_canonical_queue q
         ON q.load_session_id = s.load_session_id AND q.embed_text_sha256 = s.embed_text_sha256
       WHERE s.load_session_id = $1 AND s.chunk_id > $2
       ORDER BY s.chunk_id LIMIT $3`,
      [loadSessionId, lastChunkId, PAGE_SIZE],
    );
    if (page.rows.length === 0) return;
    for (const row of page.rows) yield { id: row.chunk_id, text: row.embed_text };
    lastChunkId = page.rows[page.rows.length - 1].chunk_id;
  }
}

export async function buildFixedKureBm25Index(client, loadSessionId) {
  const documents = [];
  // eslint-disable-next-line no-await-in-loop
  for await (const doc of streamChunkEmbedTexts(client, loadSessionId)) documents.push(doc);
  return { index: buildBm25Index(documents), documentCount: documents.length };
}

function serializeIndex(index) {
  return {
    documentCount: index.documentCount,
    averageDocLength: index.averageDocLength,
    idf: [...index.idf.entries()],
    docTokens: [...index.docTokens.entries()],
    orderedIds: index.orderedIds,
  };
}

function deserializeIndex(serialized) {
  return Object.freeze({
    documentCount: serialized.documentCount,
    averageDocLength: serialized.averageDocLength,
    idf: new Map(serialized.idf),
    docTokens: new Map(serialized.docTokens),
    orderedIds: serialized.orderedIds,
    tokenize: defaultTokenize,
  });
}

export function bm25CachePath(cacheDir, loadSessionId) {
  return path.join(cacheDir, `${loadSessionId}.bm25-index.v1.json`);
}

export async function persistFixedKureBm25Index(cacheDir, loadSessionId, index) {
  await mkdir(cacheDir, { recursive: true });
  const serialized = serializeIndex(index);
  const json = JSON.stringify(serialized);
  const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
  await writeFile(bm25CachePath(cacheDir, loadSessionId), json, "utf8");
  return { sha256, bytes: Buffer.byteLength(json, "utf8"), documentCount: serialized.documentCount };
}

export async function loadFixedKureBm25Index(cacheDir, loadSessionId) {
  const raw = await readFile(bm25CachePath(cacheDir, loadSessionId), "utf8");
  return deserializeIndex(JSON.parse(raw));
}

// Re-exported so callers never need a second import of bm25.mjs directly
// (this module is the ONE place P11-F0 code touches BM25 search).
export { bm25Search };
