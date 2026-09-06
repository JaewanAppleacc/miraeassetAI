// Turn A2-DOCUMENTIR-NODESTORE-V1.1: a real, read-only `fetchNode` backed by
// the canonical DocumentIR (4 JSONL files pinned by manifest_sha256
// `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`), not a
// DB. This is a NEW, separate file. It does not modify, replace, or change
// the meaning of `arm-retriever-adapter.mjs`'s existing `fetch_node()`, and
// it does not modify `a2-real-node-store-adapter.mjs` (the prior turn's DB-
// shaped adapter, kept as-is for a future live-DB deployment).
//
// Bounded access to the 7.6GB periodic file (Section 3's own constraint:
// never load the whole file into memory):
//   - Preferred path: load a pre-built {doc_id -> {file, offset, length}}
//     byte-offset index (the same shape `dart_corpus.retrieval.node_store`
//     already builds and the frozen scorer already consumes -- "기존
//     검증된 raw-corpus extractor를 재사용"), verify it against the LIVE
//     DocumentIR files' own SHA-256 (never trusted blindly), then read
//     exactly `length` bytes at `offset` per lookup -- one document's
//     bytes, never the whole file.
//   - Fallback path (no index available, or it fails verification): one
//     bounded, buffer-based streaming pass per file that decodes only a
//     small fixed-size prefix of each line to test for a needed doc_id,
//     and fully parses only the lines that actually match -- "필요한 문서
//     ID만 bounded streaming으로 추출".
//
// Deterministic node rendering (Section 3): mirrors the existing verified
// `node_dict_to_text` rule (section -> title_text, paragraph -> text, table
// -> row-ordered cell text) and additionally surfaces period_text/unit_text/
// consolidation_basis when the parser actually populated them (frequently
// null in this corpus -- never fabricated when absent). No field not
// present on the raw DocumentIR node is ever invented.

import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";

export const DOCUMENTIR_MANIFEST_SHA256 =
  "04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364";

export const DEFAULT_FILE_NAMES = Object.freeze({
  exchange: "exchange.jsonl",
  holding: "holding.jsonl",
  major: "major.jsonl",
  periodic: "periodic.jsonl", // logical name; resolveFileNames() may map this to an on-disk alias (e.g. periodic-001.jsonl)
});

export const EXPECTED_FILE_SHA256 = Object.freeze({
  "exchange.jsonl": "80000c1c12f09bb59ce5bea41f62c5a70a39bdc965859c8436c261e9bde02c2a",
  "holding.jsonl": "fd88d83c53a4c465ec1cbedce0a41046cfa7819822e2d7df046fccf42b8cbc09",
  "major.jsonl": "5c58da7ad32fe31603f59bdea6829c29e6cb00b823c336b6e90b71f41d25d3ba",
  "periodic.jsonl": "0aee546312b93797cf35f946144e044d8f43a947c38bb49b0766b623076be852",
});

function docGroupOf(documentId) {
  const idx = documentId.indexOf("_");
  return idx === -1 ? documentId : documentId.slice(0, idx);
}

// ---------------------------------------------------------------------------
// File verification (never trust an index or a file's presence blindly).
// ---------------------------------------------------------------------------

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// documentIrPaths: { exchange, holding, major, periodic } -> absolute file paths.
// Returns { ok: boolean, mismatches: [{ group, path, expected, actual }] }.
export async function verifyDocumentIrFiles(documentIrPaths, expectedSha256 = EXPECTED_FILE_SHA256) {
  const mismatches = [];
  for (const [group, filePath] of Object.entries(documentIrPaths)) {
    const logicalName = DEFAULT_FILE_NAMES[group] ?? `${group}.jsonl`;
    const expected = expectedSha256[logicalName];
    if (!expected) continue;
    // eslint-disable-next-line no-await-in-loop
    const actual = await sha256File(filePath).catch(() => null);
    if (actual !== expected) mismatches.push({ group, path: filePath, expected, actual });
  }
  return Object.freeze({ ok: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}

// ---------------------------------------------------------------------------
// Preferred path: load + verify a pre-built byte-offset index.
// ---------------------------------------------------------------------------

// indexManifest: parsed index_manifest.json shape { manifest_sha256, files: { "<name>.jsonl": { sha256, bytes, n_docs } } }
// documentIrPaths: { exchange, holding, major, periodic } -> absolute paths actually used for reads.
export async function loadPrebuiltOffsetIndex({ indexDir, documentIrPaths }) {
  const manifestPath = path.join(indexDir, "index_manifest.json");
  const offsetsPath = path.join(indexDir, "node_offsets.jsonl");
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch {
    return Object.freeze({ ok: false, reason: "INDEX_MANIFEST_UNREADABLE", locations: null });
  }
  if (manifest.manifest_sha256 !== DOCUMENTIR_MANIFEST_SHA256) {
    return Object.freeze({ ok: false, reason: "INDEX_MANIFEST_PIN_MISMATCH", locations: null });
  }
  const liveCheck = await verifyDocumentIrFiles(documentIrPaths, EXPECTED_FILE_SHA256);
  if (!liveCheck.ok) {
    return Object.freeze({ ok: false, reason: "DOCUMENTIR_FILE_SHA_MISMATCH", mismatches: liveCheck.mismatches, locations: null });
  }

  let offsetsRaw;
  try {
    offsetsRaw = await fsp.readFile(offsetsPath, "utf8");
  } catch {
    return Object.freeze({ ok: false, reason: "INDEX_OFFSETS_UNREADABLE", locations: null });
  }
  const locations = new Map();
  for (const line of offsetsRaw.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    locations.set(rec.doc_id, Object.freeze({
      file: rec.file, offset: rec.offset, length: rec.length, n_nodes: rec.n_nodes,
    }));
  }
  return Object.freeze({ ok: true, reason: null, manifest, locations });
}

// ---------------------------------------------------------------------------
// Bounded read of exactly one document's bytes at a known offset/length.
// ---------------------------------------------------------------------------

export async function readDocumentAtLocation(filePath, location) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(location.length);
    await fh.read(buffer, 0, location.length, location.offset);
    return JSON.parse(buffer.toString("utf8"));
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Fallback path: bounded streaming extraction of only the needed doc_ids,
// with no pre-built index (or one that failed verification). Never holds
// more than one chunk + one candidate line in memory at a time; never
// parses a line whose cheap prefix scan does not match a needed doc_id.
// ---------------------------------------------------------------------------

export async function extractDocumentsByBoundedScan(filePath, neededDocIds) {
  const remaining = new Set(neededDocIds);
  const found = new Map();
  if (remaining.size === 0) return found;

  const stream = createReadStream(filePath, { highWaterMark: 1 << 20 });
  let leftover = Buffer.alloc(0);
  const docIdPattern = /"doc_id"\s*:\s*"([^"]+)"/;

  for await (const chunk of stream) {
    if (remaining.size === 0) break;
    const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
    let start = 0;
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const lineBuf = buf.subarray(start, nl);
      start = nl + 1;
      if (lineBuf.length === 0) continue;
      const prefix = lineBuf.subarray(0, Math.min(lineBuf.length, 200)).toString("utf8");
      const m = docIdPattern.exec(prefix);
      if (m && remaining.has(m[1])) {
        const parsed = JSON.parse(lineBuf.toString("utf8"));
        found.set(m[1], parsed);
        remaining.delete(m[1]);
        if (remaining.size === 0) break;
      }
    }
    leftover = buf.subarray(start);
  }
  stream.destroy();
  return found;
}

// ---------------------------------------------------------------------------
// Deterministic node rendering (Section 3). Mirrors the existing verified
// node_dict_to_text/table_dict_to_text rule (section/paragraph/table), and
// additionally surfaces period_text/unit_text/consolidation_basis, none of
// which that minimal rule carries -- fabricates nothing not already on the
// node.
// ---------------------------------------------------------------------------

function cellsToRows(node) {
  if (Array.isArray(node.raw_rows) && node.raw_rows.length > 0) {
    // raw_rows: array of arrays of { row, col, text, ... } -- already in
    // original row order (Section 3: "원래 행 순서의 raw_rows/raw_cells").
    return node.raw_rows.map((row) => row.map((cell) => String(cell?.text ?? "").trim()));
  }
  if (Array.isArray(node.raw_cells) && node.raw_cells.length > 0) {
    // raw_cells: flat list -- group by `row` (already in the parser's own
    // emission order, which is row-major; a stable sort by row then col
    // preserves original order without inventing any new ordering rule).
    const byRow = new Map();
    for (const cell of node.raw_cells) {
      const r = cell.row ?? 0;
      const list = byRow.get(r) ?? [];
      list.push(cell);
      byRow.set(r, list);
    }
    const rowKeys = [...byRow.keys()].sort((a, b) => a - b);
    return rowKeys.map((r) => byRow.get(r)
      .slice()
      .sort((a, b) => (a.col ?? 0) - (b.col ?? 0))
      .map((cell) => String(cell?.text ?? "").trim()));
  }
  return [];
}

function renderTableNode(node) {
  const rows = cellsToRows(node);
  const hasContent = rows.some((row) => row.some((cell) => cell.length > 0));
  const headerLines = [];
  if (node.consolidation_basis) headerLines.push(`구분: ${node.consolidation_basis}`);
  if (node.period_text) headerLines.push(`기간: ${node.period_text}`);
  if (node.unit_text) headerLines.push(`단위: ${node.unit_text}`);
  const bodyLines = rows.map((row) => row.join(" | "));
  const text = [...headerLines, ...bodyLines].join("\n");

  const sectionTitle = Array.isArray(node.section_hierarchy) && node.section_hierarchy.length > 0
    ? node.section_hierarchy[node.section_hierarchy.length - 1]
    : null;
  const title = node.title_text ?? sectionTitle ?? null;
  const rowLabels = rows.length > 0 ? rows.map((row) => row[0] ?? "").filter((v) => v.length > 0) : null;
  const colLabels = rows.length > 0 ? rows[0].filter((v) => typeof v === "string" && v.length > 0) : null;

  return Object.freeze({
    hasContent,
    text,
    table: Object.freeze({
      title, period: node.period_text ?? null, unit: node.unit_text ?? null,
      rowLabels: rowLabels && rowLabels.length > 0 ? Object.freeze(rowLabels) : null,
      colLabels: colLabels && colLabels.length > 0 ? Object.freeze(colLabels) : null,
    }),
  });
}

// Returns { isTable, text, table } -- `table` is null for non-table nodes.
// Never invents a field the raw node does not itself carry.
export function renderNode(node) {
  const kind = node.kind;
  if (kind === "table") {
    const rendered = renderTableNode(node);
    return Object.freeze({ isTable: true, text: rendered.hasContent || rendered.text ? rendered.text : "", table: rendered.table, hasContent: rendered.hasContent });
  }
  if (kind === "section") {
    const text = typeof node.title_text === "string" ? node.title_text.trim() : "";
    return Object.freeze({ isTable: false, text, table: null, hasContent: text.length > 0 });
  }
  if (kind === "paragraph") {
    const text = typeof node.text === "string" ? node.text.trim() : "";
    return Object.freeze({ isTable: false, text, table: null, hasContent: text.length > 0 });
  }
  return Object.freeze({ isTable: false, text: "", table: null, hasContent: false });
}

// ---------------------------------------------------------------------------
// fetchNode factory (the a2-node-grounded-evidence.mjs contract).
// ---------------------------------------------------------------------------

function unresolved(documentId, nodeIndex, row, col, reason) {
  return Object.freeze({
    found: false, documentId, nodeIndex, nodeId: null, sourceLocator: null,
    isTable: false, row: row ?? null, col: col ?? null, text: null, table: null,
    unresolvedReason: reason,
  });
}

// documentIrPaths: { exchange, holding, major, periodic } -> absolute file paths.
// offsetIndex: the `locations` Map from loadPrebuiltOffsetIndex() (preferred),
//   or null to force the bounded-scan fallback for every lookup.
// allowedLookupKeys: optional Set of "documentId::nodeIndex" strings, drawn
//   only from the frozen Arm A top-20's own provenance candidates -- when
//   supplied, any lookup outside this set fails closed regardless of what
//   the caller passes (defense in depth; a2-node-grounded-evidence.mjs
//   already only ever calls fetchNode for its own candidates, but this adds
//   an independent, testable guarantee).
export function createDocumentIrFetchNode({ documentIrPaths, offsetIndex = null, allowedLookupKeys = null } = {}) {
  const docCache = new Map(); // documentId -> parsed raw record, cleared never within one process run (bounded by n distinct docs actually looked up)

  async function loadRawDocument(documentId) {
    if (docCache.has(documentId)) return docCache.get(documentId);
    const group = docGroupOf(documentId);
    const filePath = documentIrPaths[group];
    if (!filePath) { docCache.set(documentId, null); return null; }

    let raw = null;
    const location = offsetIndex?.get(documentId) ?? null;
    if (location) {
      try {
        raw = await readDocumentAtLocation(filePath, location);
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      const found = await extractDocumentsByBoundedScan(filePath, [documentId]);
      raw = found.get(documentId) ?? null;
    }
    if (raw && raw.doc_id !== documentId) raw = null; // fail-closed identity re-check
    docCache.set(documentId, raw);
    return raw;
  }

  return async function fetchNode({ documentId, nodeIndex, row = null, col = null } = {}) {
    if (typeof documentId !== "string" || documentId.length === 0 || !Number.isInteger(nodeIndex) || nodeIndex < 0) {
      return unresolved(documentId ?? null, Number.isInteger(nodeIndex) ? nodeIndex : null, row, col, "INVALID_LOOKUP_KEY");
    }
    if (allowedLookupKeys && !allowedLookupKeys.has(`${documentId}::${nodeIndex}`)) {
      return unresolved(documentId, nodeIndex, row, col, "OUTSIDE_FROZEN_A_CANDIDATE_SET");
    }

    let raw;
    try {
      raw = await loadRawDocument(documentId);
    } catch {
      raw = null;
    }
    if (!raw || !Array.isArray(raw.nodes)) {
      return unresolved(documentId, nodeIndex, row, col, "DOCUMENT_NOT_FOUND");
    }
    const node = raw.nodes[nodeIndex];
    if (!node) return unresolved(documentId, nodeIndex, row, col, "NODE_INDEX_OUT_OF_RANGE");

    const expectedSuffix = `::n${nodeIndex}`;
    if (typeof node.node_id !== "string" || !node.node_id.endsWith(expectedSuffix)) {
      return unresolved(documentId, nodeIndex, row, col, "NODE_ID_INDEX_MISMATCH");
    }

    const rendered = renderNode(node);
    if (!rendered.hasContent) {
      return unresolved(documentId, nodeIndex, row, col, "NODE_TEXT_UNAVAILABLE");
    }

    return Object.freeze({
      found: true, documentId, nodeIndex,
      nodeId: node.node_id, sourceLocator: node.node_id,
      isTable: rendered.isTable, row: null, col: null,
      text: rendered.text, table: rendered.table,
    });
  };
}
