import { createHash } from "node:crypto";
import { ids } from "../contracts.mjs";

const TOKEN_PATTERN = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function tokenizeWithOffsets(text) {
  return [...String(text).matchAll(TOKEN_PATTERN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function sourceLocator(documentId, node, rowStart = null, rowEnd = null, colStart = null, colEnd = null) {
  const base = `${documentId}/${node.source.rel_path}#node=${node.source.order_index}`;
  if (rowStart === null) return base;
  return `${base};row=${rowStart}-${rowEnd};col=${colStart}-${colEnd}`;
}

function deriveSectionIds(nodes) {
  const current = new Map();
  const result = new Map();
  for (const node of nodes) {
    const file = node.source?.rel_path ?? "unknown";
    if (node.kind === "section") {
      const fullPath = [...(node.section_hierarchy ?? []), node.title_text].filter(Boolean);
      current.set(`${file}\0${JSON.stringify(fullPath)}`, node.node_id);
    }
    const sectionPath = node.kind === "section"
      ? [...(node.section_hierarchy ?? []), node.title_text].filter(Boolean)
      : node.section_hierarchy ?? [];
    const sectionIds = [];
    for (let depth = 1; depth <= sectionPath.length; depth += 1) {
      const id = current.get(`${file}\0${JSON.stringify(sectionPath.slice(0, depth))}`);
      if (id) sectionIds.push(id);
    }
    result.set(node.node_id, { sectionPath, sectionIds });
  }
  return result;
}

function makeSpan(documentId, node, rowStart = null, rowEnd = null, colStart = null, colEnd = null) {
  return {
    file_id: ids.file(documentId, node.source.rel_path),
    rel_path: node.source.rel_path,
    node_id: node.node_id,
    order_index: node.source.order_index,
    row_start: rowStart,
    row_end: rowEnd,
    col_start: colStart,
    col_end: colEnd,
    source_locator: sourceLocator(documentId, node, rowStart, rowEnd, colStart, colEnd),
  };
}

function sourceSegments(record) {
  const sectionInfo = deriveSectionIds(record.nodes);
  const segments = [];
  for (const node of record.nodes) {
    const info = sectionInfo.get(node.node_id) ?? { sectionPath: [], sectionIds: [] };
    if (node.kind === "section" && node.title_text?.trim()) {
      segments.push({
        text: node.title_text.trim(), kind: "section", nodeId: node.node_id,
        tableNodeId: null, rowIndex: null, sectionPath: info.sectionPath,
        sectionIds: info.sectionIds,
        span: makeSpan(record.doc_id, node),
      });
    } else if (node.kind === "paragraph" && node.text?.trim()) {
      segments.push({
        text: node.text.trim(), kind: "paragraph", nodeId: node.node_id,
        tableNodeId: null, rowIndex: null, sectionPath: info.sectionPath,
        sectionIds: info.sectionIds,
        span: makeSpan(record.doc_id, node),
      });
    } else if (node.kind === "table") {
      for (const [rowIndex, row] of (node.normalized_rows ?? []).entries()) {
        const cells = row.map((cell) => String(cell ?? "").trim());
        const text = cells.join(" | ").trim();
        if (!text || /^\|(?:\s*\|)*$/.test(text)) continue;
        const colEnd = Math.max(0, cells.length - 1);
        segments.push({
          text, kind: "table-row", nodeId: node.node_id,
          tableNodeId: node.node_id, rowIndex, sectionPath: info.sectionPath,
          sectionIds: info.sectionIds,
          span: makeSpan(record.doc_id, node, rowIndex, rowIndex, 0, colEnd),
          tableMetadata: {
            caption: node.normalized_title_guess ?? null,
            title_confirmed: node.title_confirmed ?? false,
            unit_text: node.unit_text ?? null,
            period_text: node.period_text ?? null,
            consolidation_basis: node.consolidation_basis ?? null,
          },
        });
      }
    }
  }
  return segments;
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function commonSectionPath(segments) {
  if (segments.length === 0) return [];
  const paths = segments.map((segment) => segment.sectionPath ?? []);
  const result = [];
  for (let index = 0; index < Math.min(...paths.map((path) => path.length)); index += 1) {
    if (paths.every((path) => path[index] === paths[0][index])) result.push(paths[0][index]);
    else break;
  }
  return result;
}

function mergeSpans(segments) {
  return uniqueBy(segments.map((segment) => segment.span), (span) => JSON.stringify(span));
}

function concatenateSegments(segments) {
  let text = "";
  const ranges = [];
  for (const segment of segments) {
    if (text) text += "\n";
    const start = text.length;
    text += segment.text;
    ranges.push({ start, end: text.length, segment });
  }
  return { text, ranges };
}

function isAuxiliaryTableText(rawText) {
  const text = String(rawText).normalize("NFKC").replace(/\s+/g, " ").trim();
  if (/^☞\s*본문\s*위치로\s*이동$/.test(text)) return true;
  return /^(?:(?:전기말|전분기|당기말|당분기)\s*\|\s*)?\(?\s*(?:작성기준일|기준일|단위)\s*:/i.test(text)
    && !/[가-힣A-Za-z]{3,}\s*\|\s*[-+]?\d[\d,.]*/.test(text);
}

function tokenWindowsFromSegments(segments, maxTokens, overlapTokens) {
  if (segments.length === 0) return [];
  const { text, ranges } = concatenateSegments(segments);
  const tokens = tokenizeWithOffsets(text);
  if (tokens.length === 0) return [];
  const windows = [];
  const step = Math.max(1, maxTokens - overlapTokens);
  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += step) {
    const tokenEnd = Math.min(tokens.length, tokenStart + maxTokens);
    const charStart = tokens[tokenStart].start;
    const charEnd = tokens[tokenEnd - 1].end;
    const usedSegments = ranges
      .filter((range) => range.end > charStart && range.start < charEnd)
      .map((range) => range.segment);
    windows.push({ rawText: text.slice(charStart, charEnd).trim(), segments: usedSegments });
    if (tokenEnd === tokens.length) break;
  }
  return windows;
}

function packSegments(segments, maxTokens, maxSegments) {
  const result = [];
  let current = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length > 0) result.push({ rawText: current.map((segment) => segment.text).join("\n"), segments: current });
    current = [];
    currentTokens = 0;
  };
  for (const segment of segments) {
    const count = tokenizeWithOffsets(segment.text).length;
    if (count > maxTokens) {
      flush();
      result.push(...tokenWindowsFromSegments([segment], maxTokens, 0));
      continue;
    }
    if (current.length > 0 && (currentTokens + count > maxTokens || current.length >= maxSegments)) flush();
    current.push(segment);
    currentTokens += count;
  }
  flush();
  return result;
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function spanOverlap(left, right) {
  if (left.node_id !== right.node_id) return false;
  if (left.row_start === null || right.row_start === null) return true;
  return left.row_start <= right.row_end && right.row_start <= left.row_end;
}

function findParent(chunks, segments) {
  const spans = mergeSpans(segments);
  const overlap = chunks.find((chunk) =>
    chunk.source_spans.some((parentSpan) => spans.some((span) => spanOverlap(parentSpan, span)))
  );
  if (overlap) return overlap;
  const sectionPath = commonSectionPath(segments);
  return chunks.find((chunk) => JSON.stringify(chunk.section_path) === JSON.stringify(sectionPath))
    ?? chunks.find((chunk) => chunk.source_spans.some((span) => spans.some((target) => span.rel_path === target.rel_path)))
    ?? null;
}

function qualityEligibility(record) {
  const tier = record.parse_quality?.tier ?? "fallback";
  const hasPdf = (record.source_files ?? []).some((file) => file.content_format === "pdf");
  const hasParseFailure = (record.warnings ?? []).some((warning) => warning.code === "parse_failed");
  return {
    sourceParseTier: tier,
    retrievalEligible: tier !== "fallback" && record.nodes.length > 0,
    factEligible: tier !== "fallback" && !hasPdf && !hasParseFailure && record.nodes.length > 0,
  };
}

function embedText(document, chunkType, sectionPath, rawText) {
  const company = document.manifest_payload?.listed_name ?? document.manifest_payload?.corp_name ?? document.filer_name;
  const context = [
    `기업: ${company}`,
    `문서: ${document.report_name}`,
    `청크유형: ${chunkType}`,
    sectionPath.length > 0 ? `섹션: ${sectionPath.join(" > ")}` : null,
  ].filter(Boolean).join("\n");
  return `${context}\n\n${rawText}`;
}

function chunkMetadata(record, document, eligibility, extra = {}) {
  return {
    corp_code: document.corp_code,
    corp_name: document.manifest_payload?.corp_name ?? null,
    listed_name: document.manifest_payload?.listed_name ?? null,
    stock_code: document.manifest_payload?.stock_code ?? null,
    industry: document.manifest_payload?.industry ?? null,
    sector: document.manifest_payload?.sector ?? null,
    doc_group: document.doc_group,
    doc_subtype: document.doc_subtype,
    report_name: document.report_name,
    receipt_date: document.receipt_date,
    base_year: document.base_year,
    base_month: document.base_month,
    is_correction: document.is_correction,
    source_parse_tier: eligibility.sourceParseTier,
    retrieval_eligible: eligibility.retrievalEligible,
    fact_eligible: eligibility.factEligible,
    warning_codes: [...new Set((record.warnings ?? []).map((warning) => warning.code))].sort(),
    ...extra,
  };
}

function makeFinalizer(record, document, config, provenance) {
  const chunks = [];
  const eligibility = qualityEligibility(record);
  return {
    chunks,
    add({ chunkType, rawText, segments, parentChunkId = null, metadata = {} }) {
      if (!rawText?.trim() || segments.length === 0) return null;
      const index = chunks.length;
      const spans = mergeSpans(segments);
      const sectionPath = commonSectionPath(segments);
      const effectiveType = eligibility.sourceParseTier === "fallback" ? "DOCUMENT_FALLBACK" : chunkType;
      const raw = rawText.trim();
      const embedded = embedText(document, effectiveType, sectionPath, raw);
      const contentHash = sha256(raw);
      const chunk = {
        schema_version: "0.1.0",
        corpus_snapshot_id: provenance.targetCorpusSnapshotId,
        source_document_ir: {
          source_corpus_snapshot_id: record.corpus_snapshot_id,
          parser_version: record.parser_version,
          schema_version: record.schema_version,
          parser_code_revision: provenance.parserCodeRevision,
          parser_config_hash: provenance.parserConfigHash,
        },
        chunking_config_id: config.chunking_config_id,
        strategy_name: config.strategy_name,
        strategy_version: config.strategy_version,
        chunk_id: ids.chunk(config.chunking_config_id, document.document_id, index, contentHash),
        document_id: document.document_id,
        chunk_index: index,
        chunk_type: effectiveType,
        parent_chunk_id: parentChunkId,
        raw_text: raw,
        embed_text: embedded,
        tokenizer: { name: "unicode-word-punct", version: "1.0.0" },
        token_count: tokenizeWithOffsets(raw).length,
        embed_token_count: tokenizeWithOffsets(embedded).length,
        source_node_ids: uniqueBy(segments.map((segment) => segment.nodeId), (value) => value),
        source_section_ids: uniqueBy(segments.flatMap((segment) => segment.sectionIds), (value) => value),
        section_path: sectionPath,
        source_locator: spans[0].source_locator,
        source_spans: spans,
        content_sha256: contentHash,
        duplicate_group_id: `duplicate_${contentHash.slice(0, 24)}`,
        repeated_section: false,
        metadata: chunkMetadata(record, document, eligibility, {
          ...metadata,
          retrieval_eligible: eligibility.retrievalEligible && metadata.index_role !== "CONTEXT_ONLY",
          fact_eligible: eligibility.factEligible && metadata.index_role !== "CONTEXT_ONLY",
        }),
      };
      chunks.push(chunk);
      return chunk;
    },
  };
}

function chunkFixed(record, document, config, provenance) {
  const segments = sourceSegments(record);
  const finalizer = makeFinalizer(record, document, config, provenance);
  for (const fileSegments of groupBy(segments, (segment) => segment.span.rel_path).values()) {
    for (const window of tokenWindowsFromSegments(fileSegments, config.max_tokens, config.overlap_tokens)) {
      finalizer.add({ chunkType: "FIXED_WINDOW", ...window, metadata: { index_role: "RETRIEVAL" } });
    }
  }
  return finalizer.chunks;
}

function chunkSectionFlat(record, document, config, provenance) {
  const segments = sourceSegments(record);
  const finalizer = makeFinalizer(record, document, config, provenance);
  const groups = groupBy(segments, (segment) => `${segment.span.rel_path}\0${JSON.stringify(segment.sectionPath)}`);
  for (const sectionSegments of groups.values()) {
    for (const window of tokenWindowsFromSegments(sectionSegments, config.max_tokens, config.overlap_tokens)) {
      finalizer.add({ chunkType: "SECTION_FLAT", ...window, metadata: { index_role: "RETRIEVAL" } });
    }
  }
  return finalizer.chunks;
}

function chunkHierarchical(record, document, config, provenance) {
  const segments = sourceSegments(record);
  const finalizer = makeFinalizer(record, document, config, provenance);
  if (segments.length === 0) return [];
  const isPeriodic = document.doc_group === "periodic";
  const contextualSegments = segments.filter((segment) => segment.kind !== "table-row");
  const topGroups = isPeriodic
    ? groupBy(contextualSegments, (segment) => `${segment.span.rel_path}\0${JSON.stringify(segment.sectionPath)}`)
    : groupBy(contextualSegments, (segment) => segment.span.rel_path);
  const topParents = [];
  const topType = isPeriodic
    ? "SECTION_PARENT"
    : document.doc_group === "holding" ? "HOLDING_STATUS_PARENT" : "EVENT_PARENT";
  for (const group of topGroups.values()) {
    for (const packed of packSegments(group, config.parent_max_tokens, config.parent_max_source_segments)) {
      const chunk = finalizer.add({
        chunkType: topType,
        ...packed,
        metadata: { index_role: "CONTEXT_ONLY" },
      });
      if (chunk) topParents.push(chunk);
    }
  }

  const paragraphGroups = groupBy(
    segments.filter((segment) => segment.kind === "paragraph"),
    (segment) => `${segment.span.rel_path}\0${JSON.stringify(segment.sectionPath)}`,
  );
  for (const group of paragraphGroups.values()) {
    for (const packed of packSegments(group, config.child_max_tokens, config.paragraph_group_max_nodes)) {
      const parent = findParent(topParents, packed.segments);
      finalizer.add({
        chunkType: document.doc_group === "periodic" ? "PARAGRAPH_CHILD" : "FIELD_GROUP_CHILD",
        ...packed,
        parentChunkId: parent?.chunk_id ?? null,
        metadata: { index_role: "RETRIEVAL" },
      });
    }
  }

  const tableGroups = groupBy(
    segments.filter((segment) => segment.kind === "table-row"),
    (segment) => segment.tableNodeId,
  );
  for (const rows of tableGroups.values()) {
    const tableParents = [];
    for (const packed of packSegments(rows, config.parent_max_tokens, config.parent_max_source_segments)) {
      const topParent = findParent(topParents, packed.segments);
      const chunk = finalizer.add({
        chunkType: "TABLE_WHOLE",
        ...packed,
        parentChunkId: topParent?.chunk_id ?? null,
        metadata: {
          index_role: "CONTEXT_ONLY",
          table_node_id: rows[0].tableNodeId,
          table_metadata: rows[0].tableMetadata ?? {},
        },
      });
      if (chunk) tableParents.push(chunk);
    }
    for (const packed of packSegments(rows, config.table_row_child_max_tokens, config.table_row_child_max_rows)) {
      const tableParent = findParent(tableParents, packed.segments);
      const auxiliary = isAuxiliaryTableText(packed.rawText);
      finalizer.add({
        chunkType: "TABLE_ROW",
        ...packed,
        parentChunkId: tableParent?.chunk_id ?? null,
        metadata: {
          index_role: auxiliary ? "CONTEXT_ONLY" : "RETRIEVAL",
          auxiliary_table_metadata: auxiliary,
          table_node_id: rows[0].tableNodeId,
          table_metadata: rows[0].tableMetadata ?? {},
        },
      });
    }
  }
  return finalizer.chunks;
}

export function chunkDocument(record, document, config, provenance) {
  if (record.doc_id !== document.document_id) throw new Error("DocumentIR and manifest document IDs do not match");
  if ((record.nodes?.length ?? 0) === 0) return [];
  if (record.parse_quality?.tier === "fallback") {
    const segments = sourceSegments(record);
    const finalizer = makeFinalizer(record, document, config, provenance);
    for (const window of tokenWindowsFromSegments(segments, 512, 0)) {
      finalizer.add({
        chunkType: "DOCUMENT_FALLBACK",
        ...window,
        metadata: { index_role: "AUDIT_ONLY" },
      });
    }
    return finalizer.chunks;
  }
  if (config.strategy_name === "fixed-token") return chunkFixed(record, document, config, provenance);
  if (config.strategy_name === "section-aware-flat") return chunkSectionFlat(record, document, config, provenance);
  if (config.strategy_name === "document-type-hierarchical-parent-child") {
    return chunkHierarchical(record, document, config, provenance);
  }
  throw new Error(`Unsupported chunk strategy: ${config.strategy_name}`);
}
