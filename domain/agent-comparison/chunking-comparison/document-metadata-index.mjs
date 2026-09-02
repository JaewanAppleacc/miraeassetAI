// Turn P10.1: read-only index over the FULL 4,204-document metadata file
// (work/domain-seed/documents.jsonl in the main checkout -- NOT this
// Turn's brief's explicitly-named a-document-ir/source/ raw-corpus path,
// but a necessary, non-Gold, non-DEV_CHECK/HOLDOUT sibling: without a
// document_id -> corp_code/doc_group/receipt_date mapping, neither a valid
// chunk.schema.json `document` object nor deterministic hard-negative
// selection by corp_code/doc_group/date is possible -- this file already
// carries every field chunker.mjs's own `document` parameter needs
// (corp_code, doc_group, doc_subtype, report_name, receipt_date,
// base_year, base_month, filer_name, is_correction, manifest_payload),
// which the raw a-document-ir/source/*.jsonl records do NOT.
// Read-only; never written to, never copied into git.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function loadDocumentMetadataIndex(documentsJsonlPath) {
  const byDocumentId = new Map();
  const byCorpDocGroup = new Map(); // `${corp_code}|${doc_group}` -> array of document_id, sorted by receipt_date then document_id

  const stream = createReadStream(documentsJsonlPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    byDocumentId.set(record.document_id, record);
    const key = `${record.corp_code}|${record.doc_group}`;
    if (!byCorpDocGroup.has(key)) byCorpDocGroup.set(key, []);
    byCorpDocGroup.get(key).push(record.document_id);
  }

  for (const [key, ids] of byCorpDocGroup) {
    ids.sort((a, b) => {
      const dateA = byDocumentId.get(a).receipt_date;
      const dateB = byDocumentId.get(b).receipt_date;
      return dateA < dateB ? -1 : dateA > dateB ? 1 : a.localeCompare(b);
    });
    byCorpDocGroup.set(key, ids);
  }

  return Object.freeze({ byDocumentId, byCorpDocGroup });
}

// Builds the chunker.mjs `document` parameter directly from an indexed
// metadata record -- no synthesis, no null-guessing (every field comes
// from documents.jsonl's real content).
export function toChunkerDocument(metadataRecord) {
  return {
    document_id: metadataRecord.document_id,
    corp_code: metadataRecord.corp_code,
    doc_group: metadataRecord.doc_group,
    doc_subtype: metadataRecord.doc_subtype ?? null,
    report_name: metadataRecord.report_name ?? null,
    receipt_date: metadataRecord.receipt_date,
    base_year: metadataRecord.base_year ?? null,
    base_month: metadataRecord.base_month ?? null,
    filer_name: metadataRecord.filer_name ?? null,
    is_correction: metadataRecord.is_correction === true,
    manifest_payload: metadataRecord.manifest_payload ?? {},
  };
}
