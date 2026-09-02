// Turn P10.1: bounded, streaming extraction from the real, full DocumentIR
// corpus at .../work/a-document-ir/source/{exchange,holding,major,
// periodic-001}.jsonl (this Turn's brief-authorized read-only path). One
// of these files (periodic-001.jsonl) is ~8GB -- this module NEVER loads a
// source file fully into memory; it streams line-by-line and keeps only
// records whose doc_id is in the caller-supplied target set. Each record
// is ALREADY in domain/chunking/chunker.mjs's native input shape
// (doc_id, schema_version, parser_version, corpus_snapshot_id,
// source_files, nodes, warnings, parse_quality) -- no adapter needed here
// (unlike Turn P10's b-canonical-to-chunker-input.mjs, which bridged a
// DIFFERENT, already-adapted B-canonical shape).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const DOC_ID_PREFIX_PATTERN = /"doc_id"\s*:\s*"([^"]+)"/;

const DOC_GROUP_TO_FILENAME = Object.freeze({
  periodic: "periodic-001.jsonl",
  major: "major.jsonl",
  exchange: "exchange.jsonl",
  holding: "holding.jsonl",
});

function docGroupOf(documentId) {
  const match = /^(periodic|major|exchange|holding)_/.exec(documentId);
  if (!match) throw new Error(`raw-corpus-extractor: cannot derive doc_group from document_id: ${documentId}`);
  return match[1];
}

// targetDocumentIds: Set<string>. Returns Map<document_id, rawRecord>.
// Missing ids are simply absent from the result (never fabricated) --
// callers must check for completeness themselves.
export async function extractRawRecords(sourceDir, targetDocumentIds) {
  const byGroup = new Map();
  for (const id of targetDocumentIds) {
    const group = docGroupOf(id);
    if (!byGroup.has(group)) byGroup.set(group, new Set());
    byGroup.get(group).add(id);
  }

  const result = new Map();
  for (const [group, ids] of byGroup) {
    const filePath = path.join(sourceDir, DOC_GROUP_TO_FILENAME[group]);
    const remaining = new Set(ids);
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // eslint-disable-next-line no-await-in-loop
    for await (const line of lines) {
      if (remaining.size === 0) break; // found everything needed from this file -- stop reading early
      if (!line.trim()) continue;
      // O(1) prefilter per line (regex-extracted doc_id + Set.has) --
      // deliberately avoids an O(|remaining|) scan per line, which would
      // be far too slow against periodic-001.jsonl (~8GB, ~1,000+ docs).
      const idMatch = DOC_ID_PREFIX_PATTERN.exec(line);
      if (!idMatch || !remaining.has(idMatch[1])) continue;
      const record = JSON.parse(line);
      if (remaining.has(record.doc_id)) {
        result.set(record.doc_id, record);
        remaining.delete(record.doc_id);
      }
    }
    stream.destroy();
  }
  return result;
}
