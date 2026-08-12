// Real, read-only DocumentStore adapter (domain/runtime/citation-validator.mjs's
// `{ getDocument }` interface) backed by A's canonical DocumentIR JSONL
// (domain/interfaces/document-ir.schema.json), produced by
// scripts/adapt-a-document-ir.mjs. Never writes to or mutates A's canonical
// artifact — it only scans the file to answer getDocument(document_id).
//
// A's canonical records carry A's own source snapshot id
// (e.g. "snap_7484a10220422056"); domain/HANDOFF.md maps that 1:1 to B's
// corpus_snapshot_id ("corpus_04750795e1a2d5c3"), which every other
// component in this repo (structured-query/result, retrieval examples,
// etc.) already uses. This adapter performs exactly that documented
// mapping when handing a document to DocumentStore, via the single shared
// mapping in domain/adapters/a-snapshot-contract.mjs — it does not declare
// its own copy, so it and seed-canonical-document-ir-store.mjs can never
// silently disagree about what a given raw snapshot id maps to. An
// unrecognized raw snapshot id is rejected (thrown), never passed through
// unmapped.
//
// KNOWN LIMITATION: this does a linear scan of the JSONL file per lookup.
// Fine for the 4-document sample (work/a-document-ir/canonical.sample.jsonl)
// this is exercised against today; the full corpus is 4,204 documents /
// 8.6GB across 4 files (work/a-document-ir/inventory.json) and was never
// materialized in this repo, so there is nothing to index yet. Add a
// document_id -> byte-offset index (or a real DB) before pointing this at
// the full corpus.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { remapSourceSnapshotId } from "./a-snapshot-contract.mjs";

function remapSnapshot(record) {
  return { ...record, corpus_snapshot_id: remapSourceSnapshotId(record.corpus_snapshot_id) };
}

// Deliberately does NOT catch file-not-found / permission / stream-read /
// malformed-JSON errors into a null return. "The store is broken" and
// "this document isn't in the store" are different facts — DocumentStore
// (citation-validator.mjs) already treats a thrown error as
// DOCUMENT_STORE_UNAVAILABLE and a clean `null` as DOCUMENT_NOT_FOUND;
// swallowing errors here would silently collapse that distinction back
// into DOCUMENT_NOT_FOUND (told "the corpus doesn't have this document"
// when the real problem is the backing file is missing or corrupt).
export function createCanonicalJsonlDocumentAdapter(jsonlPath) {
  return {
    async getDocument(documentId) {
      const stream = createReadStream(jsonlPath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line) continue;
          // Loose prefilter before JSON.parse — must not depend on exact
          // JSON.stringify byte formatting (key ordering, whitespace).
          if (!line.includes(documentId)) continue;
          const record = JSON.parse(line); // a malformed line is real corruption — let it throw
          if (record.document_id === documentId) return remapSnapshot(record);
        }
        return null; // reached only after a fully, cleanly read file
      } finally {
        stream.destroy();
      }
    },
  };
}
