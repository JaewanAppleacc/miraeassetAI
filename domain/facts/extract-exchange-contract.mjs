import { createHash } from "node:crypto";
import { ids } from "../contracts.mjs";

const METRIC_RULES = [
  { metricCode: "CONTRACT_NAME", valueType: "TEXT", matches: (label) => /(?:체결)?계약명|계약내용|세부내용/.test(label) },
  { metricCode: "CONTRACT_COUNTERPARTY", valueType: "TEXT", matches: (label) => /계약상대(?:방)?$/.test(label) },
  { metricCode: "CONTRACT_AMOUNT", valueType: "NUMERIC", matches: (label) => /(?:계약|해지)금액(?:원)?$/.test(label) },
  { metricCode: "CONTRACT_SALES_RATIO", valueType: "NUMERIC", matches: (label) => /매출액대비%?$/.test(label) },
  {
    metricCode: "CONTRACT_START_DATE",
    valueType: "DATE",
    matches: (label) => /시작일$/.test(label),
  },
  {
    metricCode: "CONTRACT_END_DATE",
    valueType: "DATE",
    matches: (label) => /종료일$/.test(label),
  },
  { metricCode: "WITHHELD_REASON", valueType: "TEXT", matches: (label) => /(?:공시)?유보사유$/.test(label) },
  { metricCode: "WITHHELD_UNTIL", valueType: "DATE", matches: (label) => /(?:공시)?유보기한$/.test(label) },
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeLabel(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/^\s*[-–—]?\s*\d+(?:\.\d+)*\.?\s*/, "")
    .replace(/[\sㆍ·:：()（）]/g, "")
    .toLowerCase();
}

function rowDescriptor(row, index) {
  const cells = row.map((cell) => String(cell ?? "").trim());
  const value = cells.at(-1) ?? "";
  const labelCells = cells.slice(0, -1);
  const combinedLabel = normalizeLabel(labelCells.join(" "));
  const candidateLabels = [...labelCells].reverse();
  return { index, cells, value, labelCells, combinedLabel, candidateLabels };
}

function matchRule(descriptor, rule) {
  if (rule.matches(descriptor.combinedLabel)) return true;
  return descriptor.candidateLabels.some((label) => rule.matches(normalizeLabel(label)));
}

function bestRawLabel(descriptor, rule) {
  return descriptor.candidateLabels.find((label) => rule.matches(normalizeLabel(label)))
    ?? descriptor.labelCells.join(" / ");
}

function analyzeTable(node) {
  const rows = (node.normalized_rows ?? []).map(rowDescriptor);
  const matches = new Map();
  for (const rule of METRIC_RULES) {
    const candidates = rows.filter((row) => matchRule(row, rule));
    if (candidates.length > 0) matches.set(rule.metricCode, candidates);
  }
  return { node, rows, matches, score: matches.size };
}

function parseNumber(raw) {
  const normalized = String(raw).trim().replace(/,/g, "").replace(/\s/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseDate(raw) {
  const value = String(raw).trim();
  let match = value.match(/^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})(?:일)?$/);
  if (!match) return null;
  const result = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : result;
}

function classifyRawValue(rawValue, valueType, withheldReason, withheldUntil, metricCode) {
  const raw = String(rawValue ?? "").trim();
  const planned = /(?:예정|잠정|계획)/.test(raw);
  const cleaned = raw.replace(/\((?:예정|잠정|계획)\)/g, "").trim();
  const isDash = cleaned === "" || /^[-–—]$/.test(cleaned);
  const isNotApplicable = /^(?:해당없음|해당사항없음|비해당|n\/?a)$/i.test(cleaned);
  const isWithholdable = !metricCode.startsWith("WITHHELD_");

  if (isNotApplicable) {
    return { valueStatus: "NOT_APPLICABLE", certainty: "NOT_RELEVANT", normalizedValue: null };
  }
  if (isDash && withheldReason && isWithholdable) {
    return {
      valueStatus: "WITHHELD",
      certainty: "NOT_RELEVANT",
      normalizedValue: null,
      withheldUntil,
    };
  }
  if (isDash) {
    return { valueStatus: "MISSING", certainty: "NOT_RELEVANT", normalizedValue: null };
  }

  let normalizedValue = cleaned;
  if (valueType === "NUMERIC") normalizedValue = parseNumber(cleaned);
  if (valueType === "DATE") normalizedValue = parseDate(cleaned);
  if (normalizedValue === null) {
    return { valueStatus: "MISSING", certainty: planned ? "PLANNED" : "CONFIRMED", normalizedValue: null };
  }
  return {
    valueStatus: "DISCLOSED",
    certainty: planned ? "PLANNED" : "CONFIRMED",
    normalizedValue,
    withheldUntil: null,
  };
}

function metricUnit(metricCode) {
  if (metricCode === "CONTRACT_AMOUNT") return { unit: "KRW", currency: "KRW", rawUnit: "원", scale: 1 };
  if (metricCode === "CONTRACT_SALES_RATIO") return { unit: "PERCENT", currency: null, rawUnit: "%", scale: 1 };
  return { unit: null, currency: null, rawUnit: null, scale: null };
}

function knownAt(document) {
  return `${document.receipt_date}T00:00:00+09:00`;
}

function rowLocator(documentId, node, rowIndex) {
  return `${documentId}/${node.source.rel_path}#node=${node.source.order_index};row=${rowIndex}`;
}

export function extractExchangeContractBundle(sourceRecord, document, metricOntology, options = {}) {
  if (!['단일판매공급계약체결', '단일판매공급계약해지'].includes(document.doc_subtype)) return null;
  const tableCandidates = sourceRecord.nodes
    .filter((node) => node.kind === "table")
    .map(analyzeTable)
    .filter((table) => table.score > 0)
    .sort((left, right) => right.score - left.score || right.rows.length - left.rows.length);
  const table = tableCandidates[0];
  if (!table) {
    return {
      schema_version: "0.2.0",
      corpus_snapshot_id: options.targetCorpusSnapshotId ?? sourceRecord.corpus_snapshot_id,
      producer: {
        name: "exchange-contract-fact-extractor",
        version: options.extractorVersion ?? "0.1.0",
        created_at: options.createdAt ?? new Date().toISOString(),
      },
      facts: [], events: [], relations: [], evidence: [],
    };
  }

  const latest = (metricCode) => table.matches.get(metricCode)?.at(-1) ?? null;
  const withheldReasonRow = latest("WITHHELD_REASON");
  const withheldUntilRow = latest("WITHHELD_UNTIL");
  const withheldReason = withheldReasonRow && !/^[-–—]$/.test(withheldReasonRow.value)
    ? withheldReasonRow.value
    : null;
  const withheldUntil = withheldUntilRow ? parseDate(withheldUntilRow.value) : null;
  const evidence = [];
  const facts = [];

  for (const rule of METRIC_RULES) {
    const row = latest(rule.metricCode);
    if (!row) continue;
    const rawLabel = bestRawLabel(row, rule);
    const quote = row.cells.join(" | ");
    const quoteHash = sha256(quote);
    const locator = rowLocator(document.document_id, table.node, row.index);
    const evidenceId = ids.evidence(document.document_id, locator, quoteHash);
    const status = classifyRawValue(row.value, rule.valueType, withheldReason, withheldUntil, rule.metricCode);
    const units = metricUnit(rule.metricCode);
    const evidenceRecord = {
      evidence_id: evidenceId,
      document_id: document.document_id,
      file_id: ids.file(document.document_id, table.node.source.rel_path),
      chunk_id: null,
      source_locator: locator,
      quoted_text: quote,
      quote_sha256: quoteHash,
      extraction_method: "RULE",
      confidence: table.score >= 6 ? 0.98 : 0.9,
      verification_status: "CANDIDATE",
      metadata: {
        source_node_id: table.node.node_id,
        row_index: row.index,
        table_rule_score: table.score,
      },
    };
    evidence.push(evidenceRecord);

    const factId = ids.fact(
      document.document_id,
      rule.metricCode,
      "event",
      "COMPANY",
      document.document_id,
    );
    const ontology = metricOntology.get(rule.metricCode);
    facts.push({
      fact_id: factId,
      corp_code: document.corp_code,
      event_id: null,
      source_document_id: document.document_id,
      metric_code: rule.metricCode,
      raw_label: rawLabel,
      value_type: rule.valueType,
      value_status: status.valueStatus,
      value_certainty: status.certainty,
      raw_value_text: row.value || "-",
      raw_unit_text: units.rawUnit,
      normalized_value: status.normalizedValue,
      unit: units.unit,
      currency: units.currency,
      scale: units.scale,
      scope: "COMPANY",
      period_type: "EVENT_PERIOD",
      period_start: null,
      period_end: null,
      as_of_date: null,
      known_at: knownAt(document),
      valid_from: knownAt(document),
      valid_to: null,
      withheld_until: status.valueStatus === "WITHHELD" ? status.withheldUntil ?? null : null,
      extraction_method: "RULE",
      confidence: table.score >= 6 ? 0.98 : 0.9,
      verification_status: "CANDIDATE",
      evidence_ids: [evidenceId],
      attributes: {
        metric_name_ko: ontology?.metric_name_ko ?? null,
        rule_version: "exchange-contract-v0.1.0",
        source_is_correction: document.is_correction,
        table_rule_score: table.score,
        duplicate_metric_rows: table.matches.get(rule.metricCode)?.length ?? 1,
      },
    });
  }

  return {
    schema_version: "0.2.0",
    corpus_snapshot_id: options.targetCorpusSnapshotId ?? sourceRecord.corpus_snapshot_id,
    producer: {
      name: "exchange-contract-fact-extractor",
      version: options.extractorVersion ?? "0.1.0",
      created_at: options.createdAt ?? new Date().toISOString(),
    },
    facts,
    events: [],
    relations: [],
    evidence,
  };
}
