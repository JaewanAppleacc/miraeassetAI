import { createHash } from "node:crypto";

const FORMAT_MAP = new Map([
  ["dart_xml", "XML"],
  ["kind_html", "HTML"],
  ["html", "HTML"],
  ["pdf", "PDF"],
]);

const BLOCK_TYPE_MAP = new Map([
  ["section", "TITLE"],
  ["paragraph", "PARAGRAPH"],
  ["table", "TABLE"],
  ["page_break", "PAGE_BREAK"],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableFileId(documentId, relativePath) {
  return `file_${sha256(`${documentId}\0${relativePath}`).slice(0, 24)}`;
}

function detectFormat(sourceFile) {
  const format = String(sourceFile.content_format ?? "").toLowerCase();
  if (FORMAT_MAP.has(format)) return FORMAT_MAP.get(format);
  if (format.includes("html")) return "HTML";
  if (format.includes("xml")) return "XML";
  if (format.includes("pdf")) return "PDF";
  return "UNKNOWN";
}

function deriveFileRole(sourceFile) {
  const path = String(sourceFile.rel_path ?? "").toLowerCase();
  const format = detectFormat(sourceFile);
  if (format === "PDF") return "PDF_FALLBACK";
  if (format === "HTML" && /(?:^|[_-])viewer\.html?$/.test(path)) return "VIEWER_HTML";
  if (!sourceFile.is_attachment) return "MAIN";
  if (/(연결.*감사|consolidated.*audit)/i.test(path)) return "CONSOLIDATED_AUDIT";
  if (/(감사|audit)/i.test(path)) return "AUDIT";
  if (format === "HTML") return "VIEWER_HTML";
  return "OTHER";
}

function warningsByPath(record) {
  const result = new Map();
  for (const warning of record.warnings ?? []) {
    const path = warning.rel_path;
    if (!path) continue;
    const warnings = result.get(path) ?? [];
    warnings.push(warning);
    result.set(path, warnings);
  }
  return result;
}

function mapFile(record, sourceFile, warningMap) {
  const warnings = warningMap.get(sourceFile.rel_path) ?? [];
  const warningCodes = [...new Set(warnings.map((warning) => warning.code).filter(Boolean))].sort();
  const hasFailure = warnings.some((warning) =>
    warning.severity === "error" || /(?:parse_failed|decode_failed)/i.test(warning.code ?? "")
  );
  const repairUsed = record.parse_quality?.tier === "fallback" || warningCodes.some((code) =>
    /(?:sanitiz|repair|fallback)/i.test(code)
  );
  const documentIsEmptyAfterFailure =
    (record.nodes?.length ?? 0) === 0 &&
    (record.warnings ?? []).some((warning) => /(?:parse_failed|decode_failed)/i.test(warning.code ?? ""));
  const textLossSuspected =
    record.parse_quality?.tier === "fallback" ||
    (detectFormat(sourceFile) === "PDF" && documentIsEmptyAfterFailure) ||
    warningCodes.some((code) => /(?:truncat|text_loss|missing_pdf|parse_failed)/i.test(code));

  return {
    file_id: stableFileId(record.doc_id, sourceFile.rel_path),
    relative_path: sourceFile.rel_path,
    file_role: deriveFileRole(sourceFile),
    detected_format: detectFormat(sourceFile),
    declared_encoding: sourceFile.declared_encoding ?? null,
    detected_encoding: sourceFile.actual_encoding_used ?? null,
    parse_status: hasFailure ? "FAILED" : record.parse_quality?.tier === "structured" ? "SUCCESS" : "PARTIAL",
    repair_used: repairUsed,
    text_loss_suspected: textLossSuspected,
    warning_codes: warningCodes,
    content_sha256: sourceFile.content_sha256,
  };
}

function hierarchyKey(parts) {
  return JSON.stringify(parts ?? []);
}

function sectionParentIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    if (node.kind !== "section") continue;
    const fullPath = [...(node.section_hierarchy ?? []), node.title_text].filter(Boolean);
    index.set(hierarchyKey(fullPath), node.node_id);
  }
  return index;
}

function sourceLocator(documentId, node) {
  const path = node.source?.rel_path ?? "unknown";
  const order = Number.isInteger(node.source?.order_index) ? node.source.order_index : 0;
  return `${documentId}/${path}#node=${order}`;
}

function tablePayload(node) {
  if (node.kind !== "table") return undefined;
  const normalizedRows = Array.isArray(node.normalized_rows) ? node.normalized_rows : [];
  const headerIndices = new Set(node.header_row_indices ?? []);
  return {
    caption: node.normalized_title_guess ?? null,
    header_rows: normalizedRows.filter((_, index) => headerIndices.has(index)),
    body_rows: normalizedRows.filter((_, index) => !headerIndices.has(index)),
    unit_text: node.unit_text ?? null,
    raw_rows: node.raw_rows ?? [],
  };
}

function mapBlock(record, node, fileIds, parentIndex) {
  const sectionPath = node.section_hierarchy ?? [];
  const directParent =
    node.kind === "section"
      ? node.parent_section_id === "ROOT" ? null : node.parent_section_id ?? null
      : parentIndex.get(hierarchyKey(sectionPath)) ?? null;
  const text = node.kind === "section" ? node.title_text ?? null : node.text ?? null;

  return {
    block_id: node.node_id,
    file_id: fileIds.get(node.source?.rel_path),
    parent_block_id: directParent,
    block_type: BLOCK_TYPE_MAP.get(node.kind) ?? "OTHER",
    ordinal: Number.isInteger(node.source?.order_index) ? node.source.order_index : 0,
    section_path: sectionPath,
    source_locator: sourceLocator(record.doc_id, node),
    text,
    ...(node.kind === "table" ? { table: tablePayload(node) } : {}),
    metadata: {
      source_node_kind: node.kind,
      source_node_id: node.node_id,
      byte_offset: node.source?.byte_offset ?? null,
      ...(node.kind === "section"
        ? {
            section_level: node.level ?? null,
            section_level_confident: node.level_confident ?? null,
            start_order_index: node.start_order_index ?? null,
            end_order_index: node.end_order_index ?? null,
          }
        : {}),
      ...(node.kind === "paragraph" ? { is_footnote_like: node.is_footnote_like ?? false } : {}),
      ...(node.kind === "table"
        ? {
            n_declared_cols: node.n_declared_cols ?? null,
            actual_col_counts: node.actual_col_counts ?? [],
            title_confirmed: node.title_confirmed ?? false,
            period_text: node.period_text ?? null,
            consolidation_basis: node.consolidation_basis ?? null,
            consolidation_basis_reason: node.consolidation_basis_reason ?? null,
          }
        : {}),
    },
  };
}

function extractedCharCount(nodes) {
  let total = 0;
  for (const node of nodes) {
    if (typeof node.text === "string") total += node.text.length;
    if (typeof node.title_text === "string") total += node.title_text.length;
    if (node.kind === "table") {
      for (const row of node.normalized_rows ?? []) {
        total += row.reduce((sum, cell) => sum + String(cell ?? "").length, 0);
      }
    }
  }
  return total;
}

export function mapCoverageState(record) {
  const tier = record.parse_quality?.tier;
  const warnings = record.warnings ?? [];
  const blockCount = record.nodes?.length ?? 0;
  const hasParseFailure = warnings.some((warning) =>
    warning.severity === "error" || /(?:parse_failed|decode_failed)/i.test(warning.code ?? "")
  );

  if (tier === "structured") {
    return { state: "PRESENT", reason_code: "PARSE_SUCCESS" };
  }
  if (tier === "partial" && !hasParseFailure) {
    return { state: "PRESENT", reason_code: "PARSE_SUCCESS_WITH_WARNINGS" };
  }
  if (tier === "fallback") {
    return { state: "PARTIAL_PARSE_FAILURE", reason_code: "FALLBACK_TEXT_ONLY" };
  }
  if (hasParseFailure && blockCount === 0) {
    const formats = new Set((record.source_files ?? []).map((file) => detectFormat(file)));
    const hasNoTableViewerFailure = warnings.some((warning) =>
      warning.code === "parse_failed" && /no\s*<table>\s*found/i.test(warning.message ?? "")
    );
    if (formats.has("PDF") && formats.has("HTML") && hasNoTableViewerFailure) {
      return { state: "PARSE_FAILED", reason_code: "PDF_VIEWER_EMPTY_NO_TABLES" };
    }
    return { state: "PARSE_FAILED", reason_code: "PARSE_FAILED_NO_BLOCKS" };
  }
  return { state: "PARTIAL_PARSE_FAILURE", reason_code: "PARTIAL_PARSE_FAILURE" };
}

export function adaptADocumentIR(record, options = {}) {
  if (!record || typeof record !== "object") throw new TypeError("A DocumentIR record must be an object");
  if (!record.doc_id) throw new Error("A DocumentIR record is missing doc_id");
  if (!Array.isArray(record.source_files) || record.source_files.length === 0) {
    throw new Error(`${record.doc_id}: source_files must be a non-empty array`);
  }
  if (!Array.isArray(record.nodes)) throw new Error(`${record.doc_id}: nodes must be an array`);

  const completedAt = options.completedAt ?? new Date().toISOString();
  const warningMap = warningsByPath(record);
  const files = record.source_files.map((sourceFile) => mapFile(record, sourceFile, warningMap));
  const fileIds = new Map(files.map((file) => [file.relative_path, file.file_id]));
  const parentIndex = sectionParentIndex(record.nodes);
  const blocks = record.nodes.map((node) => mapBlock(record, node, fileIds, parentIndex));

  for (const block of blocks) {
    if (!block.file_id) throw new Error(`${record.doc_id}: node references unknown file in ${block.block_id}`);
  }

  const coverage = mapCoverageState(record);
  return {
    schema_version: "0.1.0",
    corpus_snapshot_id: options.targetCorpusSnapshotId ?? record.corpus_snapshot_id,
    document_id: record.doc_id,
    parser: {
      name: "a-document-ir-adapter",
      version: options.adapterVersion ?? "0.1.0",
      completed_at: completedAt,
    },
    files,
    blocks,
    quality_summary: {
      extracted_char_count: extractedCharCount(record.nodes),
      table_count: record.nodes.filter((node) => node.kind === "table").length,
      source_parser_version: record.parser_version,
      source_schema_version: record.schema_version,
      source_corpus_snapshot_id: record.corpus_snapshot_id,
      source_parse_tier: record.parse_quality?.tier ?? null,
      warning_count: (record.warnings ?? []).length,
      coverage_state: coverage.state,
      coverage_reason_code: coverage.reason_code,
    },
  };
}
