// Turn P10.2: unbounded, streaming iteration over the REAL, FULL DocumentIR
// corpus at .../work/a-document-ir/source/{exchange,holding,major,
// periodic-001}.jsonl (~8.8GB across the 4 files; periodic-001.jsonl alone
// is ~7.6GB). Unlike raw-corpus-extractor.mjs (Turn P10.1, bounded to a
// caller-supplied target document_id set), this module NEVER holds more
// than one record in memory at a time -- it yields {documentId, rawRecord,
// byteLength} for EVERY document across every file, for a caller-supplied
// per-file byte/line counter and chunk-then-discard consumer (Stage 1's
// count-only script never accumulates full chunk arrays for the whole
// corpus, only running aggregate statistics).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { stat } from "node:fs/promises";
import path from "node:path";

export const CORPUS_SOURCE_FILES = Object.freeze([
  { docGroup: "exchange", filename: "exchange.jsonl" },
  { docGroup: "major", filename: "major.jsonl" },
  { docGroup: "holding", filename: "holding.jsonl" },
  { docGroup: "periodic", filename: "periodic-001.jsonl" },
]);

export async function corpusSourceFileStats(sourceDir) {
  const stats = [];
  for (const { docGroup, filename } of CORPUS_SOURCE_FILES) {
    const filePath = path.join(sourceDir, filename);
    // eslint-disable-next-line no-await-in-loop
    const info = await stat(filePath);
    stats.push({ docGroup, filename, path: filePath, bytes: info.size });
  }
  return stats;
}

// Async generator: yields { documentId, docGroup, rawRecord } for every
// document in every source file, one at a time. A malformed line is real
// corruption and is allowed to throw (never silently skipped).
export async function* streamAllDocuments(sourceDir) {
  for (const { docGroup, filename } of CORPUS_SOURCE_FILES) {
    const filePath = path.join(sourceDir, filename);
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // eslint-disable-next-line no-await-in-loop
    for await (const line of lines) {
      if (!line.trim()) continue;
      const rawRecord = JSON.parse(line);
      yield { documentId: rawRecord.doc_id, docGroup, rawRecord };
    }
    stream.destroy();
  }
}
