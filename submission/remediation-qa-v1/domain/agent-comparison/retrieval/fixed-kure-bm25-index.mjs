// 한 적재 세션(Fixed-512-o64 x KURE-v1)의 청크들 위에 영속 BM25 어휘 색인을 만들고
// (역)직렬화한다. bm25.mjs(k1=1.5, b=0.75, tokenizeWithOffsets)를 무수정 재사용하며,
// PostgreSQL ts_rank로 대체하지 않는다.
//
// 색인 대상 텍스트는 raw_text가 아니라 embed_text(회사/문서/섹션 문맥 접두)다 — 임베딩
// 파이프라인과 의미상 동일한 선택을 유지하기 위함이다. embed_text는 공유 청크 테이블에
// 영속되지 않으므로(그 테이블은 원문 그대로의 raw_text를 저장) 적재기 내부의 staging x
// canonical_queue 조인에서 재구성한다 — 그 두 적재기 내부 테이블을 지우지 않는 이유다.
import { mkdir } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync, renameSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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

// Real full-corpus measurement (442,549
// chunks) reproduced the EXACT SAME "Invalid string length" failure this
// whole AC-STREAMING-FIXED-DISCOVERY/AC-VFINAL-ALIGNMENT investigation is
// about, here in persistFixedKureBm25Index's own single JSON.stringify(...)
// over the full docTokens map (442,549 documents' worth of tokenized
// arrays exceeds V8's ~1GB max string length). Fixed the SAME way as
// scripts/p11f0-embedding-input-manifest.mjs's own fix: never build one
// in-memory string for the whole index. On-disk format changed from one
// JSON object (v1) to newline-delimited JSON (v2, ".ndjson" -- a new
// bm25CachePath extension, so a stale v1 cache file is never
// mis-interpreted as v2): line 1 is a header object (idf/orderedIds/counts
// -- bounded by vocabulary size, tens of MB at most, safe to hold as one
// string), followed by one line per docTokens entry (the only part that
// scales with 442K+ documents). No format-version fixture depends on the
// old shape (grep-verified: only the exported persist/load functions are
// used by any caller/test, never the file's raw bytes).
export function bm25CachePath(cacheDir, loadSessionId) {
  return path.join(cacheDir, `${loadSessionId}.bm25-index.v2.ndjson`);
}

export async function persistFixedKureBm25Index(cacheDir, loadSessionId, index) {
  await mkdir(cacheDir, { recursive: true });
  const finalPath = bm25CachePath(cacheDir, loadSessionId);
  const partialPath = `${finalPath}.partial`;
  const fd = openSync(partialPath, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const writeLine = (value) => {
      const buf = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      writeSync(fd, buf);
      hash.update(buf);
      bytes += buf.length;
    };
    writeLine({
      format: "fixed-kure-bm25-index-ndjson-v2",
      documentCount: index.documentCount,
      averageDocLength: index.averageDocLength,
      idf: [...index.idf.entries()],
      orderedIds: index.orderedIds,
    });
    for (const entry of index.docTokens.entries()) writeLine(entry);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partialPath, finalPath);
  return { sha256: hash.digest("hex"), bytes, documentCount: index.documentCount };
}

export async function loadFixedKureBm25Index(cacheDir, loadSessionId) {
  const filePath = bm25CachePath(cacheDir, loadSessionId);
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null;
  const docTokens = new Map();
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (header === null) {
      header = JSON.parse(line);
      continue;
    }
    const [docId, tokens] = JSON.parse(line);
    docTokens.set(docId, tokens);
  }
  if (header === null) throw new Error(`bm25 index cache file "${filePath}" has no header line`);
  return Object.freeze({
    documentCount: header.documentCount,
    averageDocLength: header.averageDocLength,
    idf: new Map(header.idf),
    docTokens,
    orderedIds: header.orderedIds,
    tokenize: defaultTokenize,
  });
}

// Re-exported so callers never need a second import of bm25.mjs directly
// (this module is the ONE place P11-F0 code touches BM25 search).
export { bm25Search };
