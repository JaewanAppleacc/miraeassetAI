// Turn N4.5.1: read-only loader for the REAL, full canonical DocumentIR
// corpus at work/a-document-ir/source/*.jsonl (4,204 documents: exchange
// 1,469 / holding 1,083 / major 598 / periodic 1,054 -- domain/HANDOFF.md's
// own audited totals). This is a DIFFERENT shape from
// domain/adapters/a-document-ir-reader.mjs's createCanonicalJsonlDocumentAdapter,
// which targets the adaptADocumentIR()-transformed canonical shape
// (document_id / TITLE-PARAGRAPH-TABLE blocks) and was only ever pointed at
// a 4-document sample. This loader reads the RAW source shard shape
// directly: top-level `doc_id` (not `document_id`), `nodes[]` of kind
// "table"/"paragraph" carrying `raw_rows`/`normalized_rows`, and a
// `node_id` per node usable as a citable source locator.
//
// Turn N4.5's root-cause defect: it searched only
// work/domain-seed/seed-canonical-document-ir.v0.6/.v0.7.delta/.v0.15.delta.jsonl
// (a ~69-document Seed-evaluation-scoped derived snapshot) and concluded "0
// local DocumentIR coverage" for two real documents that were sitting the
// whole time in these four repository-committed source files. Never repeat
// that mistake: this loader's default paths are these four files, and it
// works with NO environment variable set.
//
// Read-only: this module never writes to or mutates any file under
// work/a-document-ir/. Every path returned to a caller is repo-root-relative
// (portable) -- never an absolute filesystem path.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

// Portable, repo-relative -- resolved against a caller-supplied repoRoot,
// never derived from process.cwd() or a personal absolute path.
export const DOCUMENT_IR_SOURCE_RELATIVE_PATHS = Object.freeze({
  exchange: "work/a-document-ir/source/exchange.jsonl",
  major: "work/a-document-ir/source/major.jsonl",
  holding: "work/a-document-ir/source/holding.jsonl",
  periodic: "work/a-document-ir/source/periodic-001.jsonl",
});

// General doc_id -> doc_group inference from the id's own prefix
// convention (e.g. "exchange_20250113800603" -> "exchange"). This is a
// structural rule over the id's own shape, never a specific document id or
// company literal.
export function inferDocGroupFromDocId(docId) {
  const match = /^([a-z]+)_/.exec(String(docId ?? ""));
  if (!match) return null;
  const group = match[1];
  return Object.prototype.hasOwnProperty.call(DOCUMENT_IR_SOURCE_RELATIVE_PATHS, group) ? group : null;
}

const DOC_ID_LINE_PREFIX_RE = /^\{"doc_id":\s*"([^"]*)"/;

// Streams each NEEDED source file at most once, extracting only the
// records whose doc_id is in `docIds`. A cheap prefix-regex avoids a full
// JSON.parse of every line in the (up to 8.1GB) periodic-001.jsonl shard;
// every line whose cheaply-extracted doc_id IS wanted is still fully
// JSON.parse()'d, and a parse failure there is a real fail-closed error
// (never silently skipped or downgraded to "not found").
export async function loadDocumentIrRecordsByIds({ repoRoot, docIds }) {
  const wanted = new Set(docIds);
  const recordsById = new Map();
  const parseFailures = [];
  const duplicates = [];

  const byGroup = new Map();
  for (const docId of wanted) {
    const group = inferDocGroupFromDocId(docId);
    if (!group) continue; // unrecognized prefix -- left out of recordsById, caller treats as not found
    if (!byGroup.has(group)) byGroup.set(group, new Set());
    byGroup.get(group).add(docId);
  }

  for (const [group, idsInGroup] of byGroup) {
    const relativePath = DOCUMENT_IR_SOURCE_RELATIVE_PATHS[group];
    const absolutePath = path.join(repoRoot, relativePath);
    const stream = createReadStream(absolutePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line) continue;
        const match = DOC_ID_LINE_PREFIX_RE.exec(line);
        const cheapDocId = match ? match[1] : null;
        if (!cheapDocId || !idsInGroup.has(cheapDocId)) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          parseFailures.push({ docId: cheapDocId, group, relativePath, lineNumber, error: error.message });
          continue;
        }
        if (record.doc_id !== cheapDocId) {
          parseFailures.push({ docId: cheapDocId, group, relativePath, lineNumber, error: "doc_id mismatch between cheap prefix scan and parsed record" });
          continue;
        }
        if (recordsById.has(record.doc_id)) {
          duplicates.push({ docId: record.doc_id, group, relativePath, lineNumber });
          continue;
        }
        recordsById.set(record.doc_id, { record, sourceRelativePath: relativePath, lineNumber });
      }
    } finally {
      stream.destroy();
    }
  }

  if (duplicates.length > 0) {
    throw new Error(`loadDocumentIrRecordsByIds: duplicate doc_id encountered while streaming (fail-closed): ${JSON.stringify(duplicates)}`);
  }

  const notFound = [...wanted].filter((id) => !recordsById.has(id));
  return { recordsById, notFound, parseFailures };
}

// Convenience single-id lookup built on the batch loader above.
export async function loadDocumentIrRecordById({ repoRoot, docId }) {
  const { recordsById, notFound, parseFailures } = await loadDocumentIrRecordsByIds({ repoRoot, docIds: [docId] });
  if (parseFailures.length > 0) {
    throw new Error(`loadDocumentIrRecordById: PARSE_FAILED for ${docId}: ${JSON.stringify(parseFailures)}`);
  }
  if (notFound.includes(docId)) return null;
  return recordsById.get(docId) ?? null;
}
