import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const DEFAULT_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.11.jsonl",
  evidence: "work/domain-seed/seed-evidence-verified.v0.2.jsonl",
  documents: [
    "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl",
    "work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl",
  ],
  outputJsonl: "work/domain-seed/seed-evidence-semantic-link-review.v0.1.jsonl",
  outputSummary: "work/domain-seed/seed-evidence-semantic-link-review.v0.1.summary.json",
  outputMarkdown: "work/domain-seed/seed-evidence-semantic-link-review.v0.1.md",
});

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stableReviewId(questionId, slotName, evidenceId) {
  return `semantic_link_review_${sha256(JSON.stringify([questionId, slotName, evidenceId])).slice(0, 24)}`;
}

function parseJsonLines(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1} invalid JSON: ${error.message}`);
    }
  });
}

async function loadJsonLines(relativePath, root) {
  return parseJsonLines(await readFile(path.resolve(root, relativePath), "utf8"), relativePath);
}

function expectedFactSlot(gold, slotName) {
  return (gold.expected_execution?.required_fact_slots ?? []).find((slot) => slot.slot_name === slotName) ?? null;
}

function requiredOperations(gold) {
  return [...new Set((gold.expected_execution?.route_policy ?? []).flatMap((policy) => policy.required_operations ?? []))].sort();
}

function rawRow(table, rowIndex) {
  return (table?.raw_rows ?? []).find((row) => row.some((cell) => cell.row === rowIndex)) ?? [];
}

function sourceContext(block, link, quote) {
  if (block.table) {
    const row = rawRow(block.table, link.row);
    const cell = row.find((candidate) => candidate.row === link.row && candidate.col === link.column) ?? null;
    if (!cell) throw new Error(`${link.evidence_id} table cell r${link.row}c${link.column} not found`);
    if (!String(cell.text).includes(quote)) {
      throw new Error(`${link.evidence_id} quote does not resolve in declared table cell r${link.row}c${link.column}`);
    }
    return {
      block_type: "TABLE",
      section_path: block.section_path ?? [],
      table_caption: block.table.caption ?? null,
      table_unit_text: block.table.unit_text ?? null,
      row: link.row,
      column: link.column,
      selected_cell_text: String(cell.text),
      raw_row_cells: row.map((item) => ({
        row: item.row,
        column: item.col,
        text: String(item.text ?? ""),
        rowspan: item.rowspan ?? 1,
        colspan: item.colspan ?? 1,
      })),
    };
  }

  const text = String(block.text ?? "");
  if (!text.includes(quote)) throw new Error(`${link.evidence_id} quote does not resolve in declared text block`);
  const quoteIndex = text.indexOf(quote);
  return {
    block_type: block.block_type ?? "TEXT",
    section_path: block.section_path ?? [],
    table_caption: null,
    table_unit_text: null,
    row: null,
    column: null,
    selected_cell_text: null,
    text_excerpt: text.slice(Math.max(0, quoteIndex - 160), Math.min(text.length, quoteIndex + quote.length + 160)),
  };
}

function classifyRisk({ quote, quoteFrequency, operations, context }) {
  const flags = [];
  if (/^[\s\d,.$%+\-:/()]+$/.test(quote)) flags.push("NUMERIC_OR_SYMBOL_ONLY_QUOTE");
  if ([...quote].length <= 8) flags.push("SHORT_QUOTE_LE_8");
  if (quoteFrequency > 1) flags.push("DUPLICATE_QUOTE_TEXT");
  if (operations.includes("calculate")) flags.push("CALCULATION_INPUT_QUESTION");
  if (context.block_type === "TABLE") flags.push("TABLE_CELL_SEMANTICS_REQUIRED");
  const critical = flags.includes("NUMERIC_OR_SYMBOL_ONLY_QUOTE") || flags.includes("CALCULATION_INPUT_QUESTION");
  return { risk_level: critical ? "CRITICAL" : flags.length ? "HIGH" : "MEDIUM", risk_flags: flags };
}

function markdown(records, summary) {
  const lines = [
    "# Seed Evidence semantic-link review v0.1",
    "",
    "> 이 패킷은 Evidence가 원문에 존재하는지를 재검증하는 문서가 아니다. 각 Evidence가 특정 질문의 특정 slot을 의미적으로 증명하는지 검수한다.",
    "",
    `- 고유 검수 연결: ${summary.unique_link_count}`,
    `- Gold 원본 연결 발생 수: ${summary.source_link_occurrences}`,
    `- CRITICAL / HIGH / MEDIUM: ${summary.by_risk.CRITICAL} / ${summary.by_risk.HIGH} / ${summary.by_risk.MEDIUM}`,
    `- 모든 상태: PENDING_HUMAN_REVIEW`,
    "",
    "검수자는 회사·지표·기간·단위·scope·정정 version을 확인하고 `semantic_link_status`를 APPROVED 또는 REJECTED로 별도 결정 파일에 기록해야 한다. 이 원본 패킷은 수정하지 않는다.",
    "",
  ];
  for (const item of records) {
    lines.push(`## ${item.review_id} · ${item.risk.risk_level}`, "");
    lines.push(`- 질문: ${item.question}`);
    lines.push(`- 질문 ID / slot: ${item.question_id} / ${item.slot_name}`);
    lines.push(`- Evidence: ${item.evidence_id}`);
    lines.push(`- 문서 / 위치: ${item.document_id} / ${item.source_locator}`);
    lines.push(`- 인용: ${JSON.stringify(item.quoted_text)}`);
    lines.push(`- 위험 플래그: ${item.risk.risk_flags.join(", ") || "없음"}`);
    if (item.source_context.block_type === "TABLE") {
      const row = item.source_context.raw_row_cells.map((cell) => `[c${cell.column}] ${cell.text}`).join(" | ");
      lines.push(`- 표 좌표: row=${item.source_context.row}, column=${item.source_context.column}`);
      lines.push(`- 원문 행: ${row}`);
    } else {
      lines.push(`- 문맥: ${item.source_context.text_excerpt}`);
    }
    lines.push(`- 기대 회사/기준일/단위: ${item.expected_context.corp_codes.join(", ")} / ${item.expected_context.as_of_date} / ${item.expected_context.expected_answer_unit ?? "미지정"}`);
    lines.push("- 판정: [ ] APPROVED  [ ] REJECTED  [ ] NEEDS_CONTEXT");
    lines.push("- 확인: [ ] company  [ ] metric  [ ] period  [ ] unit  [ ] scope  [ ] version", "");
  }
  return `${lines.join("\n")}\n`;
}

export async function buildSemanticLinkReview({ root = repositoryRoot, paths = DEFAULT_PATHS, writeOutputs = true } = {}) {
  const [gold, evidence, ...documentGroups] = await Promise.all([
    loadJsonLines(paths.gold, root),
    loadJsonLines(paths.evidence, root),
    ...paths.documents.map((documentPath) => loadJsonLines(documentPath, root)),
  ]);
  const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item]));
  const documents = documentGroups.flat();
  const documentById = new Map(documents.map((item) => [item.document_id, item]));
  if (evidenceById.size !== evidence.length) throw new Error("duplicate evidence_id in verified Evidence artifact");
  if (documentById.size !== documents.length) throw new Error("duplicate document_id in canonical DocumentIR artifacts");

  const quoteFrequency = new Map();
  for (const item of evidence) quoteFrequency.set(item.quoted_text, (quoteFrequency.get(item.quoted_text) ?? 0) + 1);

  const occurrences = [];
  for (const item of gold) {
    for (const link of item.extensions?.evidence_verification ?? []) {
      const source = evidenceById.get(link.evidence_id);
      if (!source) throw new Error(`${item.question_id}/${link.slot_name} references missing ${link.evidence_id}`);
      if (source.document_id !== link.document_id || source.source_locator !== link.canonical_source_locator) {
        throw new Error(`${link.evidence_id} Gold/Evidence provenance mismatch`);
      }
      const document = documentById.get(link.document_id);
      const block = document?.blocks?.find(
        (candidate) => candidate.file_id === link.canonical_file_id && candidate.source_locator === link.canonical_source_locator,
      );
      if (!block) throw new Error(`${link.evidence_id} canonical block not found`);
      const context = sourceContext(block, link, source.quoted_text);
      const operations = requiredOperations(item);
      occurrences.push({
        schema_version: "0.1.0",
        review_id: stableReviewId(item.question_id, link.slot_name, link.evidence_id),
        question_id: item.question_id,
        question: item.question,
        slot_name: link.slot_name,
        slot_description: (item.required_evidence_slots ?? []).find((slot) => slot.slot_name === link.slot_name)?.description ?? null,
        evidence_id: link.evidence_id,
        document_id: source.document_id,
        file_id: source.file_id,
        source_locator: source.source_locator,
        quoted_text: source.quoted_text,
        quote_sha256: source.quote_sha256,
        evidence_provenance_status: source.verification_status,
        expected_context: {
          corp_codes: item.corp_codes ?? [],
          as_of_date: item.as_of_date,
          expected_answerability: item.expected_answerability,
          expected_answer_unit: item.expected_answer?.unit ?? null,
          required_fact_slot: expectedFactSlot(item, link.slot_name),
          required_operations: operations,
        },
        source_context: context,
        risk: classifyRisk({ quote: source.quoted_text, quoteFrequency: quoteFrequency.get(source.quoted_text), operations, context }),
        semantic_link_status: "PENDING_HUMAN_REVIEW",
        semantic_dimension_checks: {
          company: null,
          metric: null,
          period: null,
          unit: null,
          scope: null,
          version: null,
        },
        reviewer: null,
        review_note: null,
      });
    }
  }

  const byKey = new Map();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.question_id, occurrence.slot_name, occurrence.evidence_id]);
    if (!byKey.has(key)) byKey.set(key, occurrence);
  }
  const records = [...byKey.values()].sort((left, right) => left.review_id.localeCompare(right.review_id));
  const byRisk = { CRITICAL: 0, HIGH: 0, MEDIUM: 0 };
  for (const record of records) byRisk[record.risk.risk_level] += 1;
  const summary = {
    schema_version: "0.1.0",
    artifact: path.basename(paths.outputJsonl),
    source_gold: paths.gold,
    source_evidence: paths.evidence,
    source_document_ir: paths.documents,
    source_link_occurrences: occurrences.length,
    unique_link_count: records.length,
    duplicate_source_occurrences_collapsed: occurrences.length - records.length,
    by_risk: byRisk,
    semantic_link_status: { PENDING_HUMAN_REVIEW: records.length },
    mutation_policy: "Source Gold, Evidence, and DocumentIR are read-only. Review decisions must be written to a separate artifact.",
  };

  if (writeOutputs) {
    const outputPaths = [paths.outputJsonl, paths.outputSummary, paths.outputMarkdown].map((item) => path.resolve(root, item));
    await Promise.all(outputPaths.map((item) => mkdir(path.dirname(item), { recursive: true })));
    await Promise.all([
      writeFile(outputPaths[0], `${records.map((item) => JSON.stringify(item)).join("\n")}\n`),
      writeFile(outputPaths[1], `${JSON.stringify(summary, null, 2)}\n`),
      writeFile(outputPaths[2], markdown(records, summary)),
    ]);
  }
  return { records, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSemanticLinkReview()
    .then(({ summary }) => console.log(JSON.stringify({ ok: true, ...summary }, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exitCode = 1;
    });
}

