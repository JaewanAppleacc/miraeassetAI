// Turn P10: adapter from B's canonical DocumentIR record shape (the shape
// actually materialized in this worktree's seed-release bundles --
// { schema_version, corpus_snapshot_id, document_id, parser, files, blocks,
// quality_summary }, produced upstream by domain/adapters/a-document-ir.mjs's
// adaptADocumentIr(), and identical to what domain/interfaces/document-ir.schema.json
// / seed-canonical-document-ir-store.mjs already serve) into the {record,
// document} shape domain/chunking/chunker.mjs's chunkDocument() expects
// (a THIRD, older shape -- see tests/chunker.test.mjs's fixture -- with
// record.nodes[].kind/node_id/title_text|text/normalized_rows/
// header_row_indices, not B's blocks[].block_type/text/table.header_rows|
// body_rows). No existing adapter bridges these two; this is that bridge.
//
// NEVER invents corp_code, report_name, filer_name, or any other document
// metadata this module cannot resolve from real data. A document whose
// corp_code cannot be resolved (see resolvable-bundle-corpus.mjs) must
// never reach this adapter -- callers pass corpCode/companyInfo in
// explicitly, already resolved from a real source (VERIFIED_FACT /
// COMPANY_DIRECTORY), and this module trusts that resolution rather than
// re-deriving it.
//
// Table row reconstruction: B's table payload splits header_rows and
// body_rows (see a-document-ir.mjs's tablePayload()), which loses each
// row's ORIGINAL interleaved position. This adapter reconstructs
// normalized_rows as header_rows ++ body_rows (headers first), with
// header_row_indices = [0..header_rows.length). Cell VALUES are never
// altered, invented, or reordered relative to their own group; only the
// header/body group ORDER is normalized. This is a documented,
// deterministic transform, not data fabrication.

const BLOCK_TYPE_TO_NODE_KIND = Object.freeze({
  TITLE: "section",
  PARAGRAPH: "paragraph",
  TABLE: "table",
});

const DOC_ID_PATTERN = /^(periodic|major|exchange|holding)_(\d{4})(\d{2})(\d{2})\d{6}$/;

export class ChunkerInputAdaptError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ChunkerInputAdaptError";
    this.code = code ?? "CHUNKER_INPUT_ADAPT_ERROR";
  }
}

function deriveDocGroupAndReceiptDate(documentId) {
  const match = DOC_ID_PATTERN.exec(documentId);
  if (!match) {
    throw new ChunkerInputAdaptError(`document_id does not match the expected (periodic|major|exchange|holding)_YYYYMMDDnnnnnn pattern: ${documentId}`, "MALFORMED_DOCUMENT_ID");
  }
  const [, docGroup, year, month, day] = match;
  return { docGroup, receiptDate: `${year}-${month}-${day}` };
}

function fileRelPathById(canonicalRecord) {
  const byId = new Map();
  for (const file of canonicalRecord.files ?? []) byId.set(file.file_id, file.relative_path);
  return byId;
}

function toSourceFilesForEligibility(canonicalRecord) {
  // qualityEligibility() in chunker.mjs only inspects content_format==="pdf"
  // and does not need the full file record -- reconstruct just enough,
  // honestly, from B's own detected_format field (never guessed from the
  // relative_path extension when detected_format already says otherwise).
  return (canonicalRecord.files ?? []).map((file) => ({
    rel_path: file.relative_path,
    content_format: file.detected_format === "PDF" ? "pdf" : (file.detected_format ?? "unknown").toLowerCase(),
  }));
}

function toWarningsForEligibility(canonicalRecord) {
  return (canonicalRecord.files ?? [])
    .filter((file) => file.parse_status === "FAILED")
    .map((file) => ({ code: "parse_failed", rel_path: file.relative_path }));
}

function adaptTableNode(block, fileRelPath) {
  const table = block.table ?? {};
  const headerRows = Array.isArray(table.header_rows) ? table.header_rows : [];
  const bodyRows = Array.isArray(table.body_rows) ? table.body_rows : [];
  const normalizedRows = [...headerRows, ...bodyRows];
  return {
    kind: "table",
    node_id: block.metadata?.source_node_id ?? block.block_id,
    section_hierarchy: block.section_path ?? [],
    source: { rel_path: fileRelPath, order_index: block.ordinal },
    normalized_rows: normalizedRows,
    header_row_indices: headerRows.map((_, index) => index),
    normalized_title_guess: table.caption ?? null,
    title_confirmed: block.metadata?.title_confirmed ?? false,
    unit_text: table.unit_text ?? null,
    period_text: block.metadata?.period_text ?? null,
    consolidation_basis: block.metadata?.consolidation_basis ?? null,
    raw_rows: table.raw_rows ?? [],
  };
}

// Converts one canonical DocumentIR record (B's blocks[] shape) plus
// already-resolved company info into chunker.mjs's {record, document}
// input pair. `corpCode` MUST already be resolved by the caller from real
// data (see resolvable-bundle-corpus.mjs) -- this function throws rather
// than silently defaulting it.
export function adaptCanonicalRecordToChunkerInput(canonicalRecord, { corpCode, corpName = null, listedName = null, stockCode = null } = {}) {
  if (typeof corpCode !== "string" || !/^\d{8}$/.test(corpCode)) {
    throw new ChunkerInputAdaptError(`corpCode must be a resolved 8-digit string, got: ${JSON.stringify(corpCode)}`, "UNRESOLVED_CORP_CODE");
  }
  const documentId = canonicalRecord.document_id;
  const { docGroup, receiptDate } = deriveDocGroupAndReceiptDate(documentId);
  const relPathById = fileRelPathById(canonicalRecord);

  const nodes = [];
  for (const block of canonicalRecord.blocks ?? []) {
    const kind = BLOCK_TYPE_TO_NODE_KIND[block.block_type];
    if (!kind) continue; // PAGE_BREAK / OTHER -- not a chunkable node kind
    const fileRelPath = relPathById.get(block.file_id) ?? "unknown";
    if (kind === "table") {
      nodes.push(adaptTableNode(block, fileRelPath));
      continue;
    }
    const base = {
      kind,
      node_id: block.metadata?.source_node_id ?? block.block_id,
      section_hierarchy: block.section_path ?? [],
      source: { rel_path: fileRelPath, order_index: block.ordinal },
    };
    nodes.push(kind === "section" ? { ...base, title_text: block.text } : { ...base, text: block.text });
  }

  const record = {
    corpus_snapshot_id: canonicalRecord.corpus_snapshot_id,
    doc_id: documentId,
    parser_version: canonicalRecord.quality_summary?.source_parser_version ?? "unknown",
    schema_version: canonicalRecord.quality_summary?.source_schema_version ?? "unknown",
    parse_quality: { tier: canonicalRecord.quality_summary?.source_parse_tier ?? "fallback" },
    warnings: toWarningsForEligibility(canonicalRecord),
    source_files: toSourceFilesForEligibility(canonicalRecord),
    nodes,
  };

  const document = {
    document_id: documentId,
    corp_code: corpCode,
    doc_group: docGroup,
    // doc_subtype is not resolvable from this bundle's DocumentIR or
    // COMPANY_DIRECTORY roles -- left null (an honest "unknown"), never
    // guessed from doc_group or filename.
    doc_subtype: null,
    report_name: null,
    receipt_date: receiptDate,
    base_year: null,
    base_month: null,
    filer_name: corpName,
    // is_correction is not resolvable from available bundle roles for
    // this document universe -- conservatively recorded as false, and
    // flagged as UNVERIFIED by callers that need to disclose this gap
    // (see resolvable-bundle-corpus.mjs's isCorrectionVerified: false).
    is_correction: false,
    manifest_payload: { corp_name: corpName, listed_name: listedName, stock_code: stockCode },
  };

  return { record, document };
}
