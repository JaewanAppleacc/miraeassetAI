// Authors 6 new CANDIDATE Facts (+ their grounding CANDIDATE Evidence)
// closing the tractable Harness metric gaps found in Q02/Q04/Q05/Q10 (see
// work/domain-seed/seed-thin-flow-harness-v04.v0.1 Codex 독립 검수 metric_fail
// 원인 분석). Every quoted_text below is copied verbatim from the real
// canonical DocumentIR raw table cell at the stated locator -- re-verified
// against bytes by this script itself (resolveCell + a hard fail() check)
// before anything is written.
//
// P0 AUDIT FIX (v0.17 review): this script used to ALSO decide and record
// Owner approval for these 6 items itself (owner_disposition:"APPROVE",
// reviewer:"최재완", verification_status:"VERIFIED") -- an automated
// script minting its own approval record, which is exactly the failure
// mode Owner sign-off exists to prevent. This script now does ONLY
// candidate authoring: every record it writes carries
// verification_status:"CANDIDATE", and the accompanying decision artifact
// is a TEMPLATE with every owner_disposition:"PENDING", reviewer:null,
// reviewed_at:null -- there is no code path in this file that can produce
// an APPROVE/VERIFIED/reviewer value. See scripts/promote-seed-fact-batch-v06.mjs
// for the SEPARATE promotion script that requires a real, externally
// authored (hand-edited-by-a-human) decision artifact before anything is
// promoted to VERIFIED.
//
// New files only, all CANDIDATE/PENDING: seed-evidence-candidates.v0.8.delta.jsonl,
// seed-facts-candidates.v0.6.delta.jsonl, seed-structured-owner-decision.v0.6-batch.template.jsonl.
// Nothing under this script ever writes a VERIFIED artifact, and nothing
// here reads or writes seed-evidence-verified.v0.7.jsonl / seed-facts-verified.v0.5.jsonl
// / seed-fact-coverage-verified.v0.5.json / seed-structured-owner-decision.v0.5-batch.jsonl
// (the prior, self-approved batch -- preserved untouched as audit history,
// see domain/releases/seed-release.v0.17.BLOCKED.audit-report.json).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { validateEvidenceRecord, validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const EVIDENCE_CANDIDATES_PATH = path.join(REPO, "work/domain-seed/seed-evidence-candidates.v0.8.delta.jsonl");
const FACT_CANDIDATES_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.6.delta.jsonl");
const DECISION_TEMPLATE_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.6-batch.template.jsonl");

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }
function fail(msg) { throw new Error(`CANDIDATE_BUILD_BLOCKED: ${msg}`); }

// Locates a canonical DocumentIR raw table cell and returns its exact text
// -- this IS the grounding check: if the cell doesn't exist or its text
// doesn't match what we're about to author, construction fails loudly
// rather than silently trusting a hand-typed quote.
async function resolveCell(documentId, blockSuffix, row, col) {
  const shard = path.join(REPO, "work/domain-seed/seed-canonical-document-ir.v0.6.jsonl");
  const text = (await readFile(shard, "utf8"));
  for (const line of text.split("\n")) {
    if (!line.includes(documentId)) continue;
    const rec = JSON.parse(line);
    if (rec.document_id !== documentId) continue;
    for (const block of rec.blocks) {
      if (!block.block_id.endsWith(blockSuffix)) continue;
      for (const cellRow of block.table?.raw_rows ?? []) {
        for (const cell of cellRow) {
          if (cell.row === row && cell.col === col) return { fileId: block.file_id, text: cell.text, blockLocator: block.source_locator };
        }
      }
    }
  }
  return null;
}

async function buildCandidateEvidence({ documentId, blockSuffix, row, col, expectedText, corpCode, linkedQuestionId, linkedSlotName, generatedAt }) {
  const cell = await resolveCell(documentId, blockSuffix, row, col);
  if (!cell) fail(`cell not found: ${documentId} ${blockSuffix} row=${row} col=${col}`);
  if (cell.text !== expectedText) fail(`cell text mismatch at ${documentId} ${blockSuffix} row=${row} col=${col}: expected ${JSON.stringify(expectedText)}, actual ${JSON.stringify(cell.text)}`);
  const sourceLocator = `${cell.blockLocator}&row=${row}&col=${col}`;
  const evidenceId = ids.evidence(documentId, sourceLocator, cell.text);
  const evidence = {
    evidence_id: evidenceId,
    document_id: documentId,
    file_id: cell.fileId,
    chunk_id: null,
    source_locator: sourceLocator,
    quoted_text: cell.text,
    quote_sha256: sha256(Buffer.from(cell.text, "utf8")),
    extraction_method: "DETERMINISTIC",
    confidence: 1,
    verification_status: "CANDIDATE",
    metadata: {
      review_status: "PENDING_HUMAN_REVIEW",
      corp_code: corpCode,
      source_node_id: `${documentId}::${documentId.split("_")[1]}.xml::${blockSuffix.slice(2)}`,
      row, column: col,
      linked_question_ids: [linkedQuestionId],
      linked_slot_names: [linkedSlotName],
      verification_provenance: {
        review_method: "AUTOMATED_GROUNDING_CHECK_PENDING_OWNER_REVIEW",
        audit_basis: "seed-thin-flow-harness-v04.v0.1 Codex 독립 검수 metric_fail 원인 분석",
        identity_basis: "CELL_QUALIFIED_SOURCE_LOCATOR",
        corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
        generated_at: generatedAt,
      },
    },
  };
  const errors = validateEvidenceRecord(evidence);
  if (errors.length) fail(`evidence ${evidenceId} schema errors: ${errors.join("; ")}`);
  return evidence;
}

function buildCandidateFact({ corpCode, sourceDocumentId, metricCode, rawLabel, valueType, normalizedValue, rawValueText, unit, scale, scope, periodType, periodStart, periodEnd, asOfDate, evidenceId, generatedAt }) {
  const factId = ids.fact(corpCode, metricCode, asOfDate ?? "no-period", scope, sourceDocumentId);
  const fact = {
    fact_id: factId,
    corp_code: corpCode,
    event_id: null,
    source_document_id: sourceDocumentId,
    metric_code: metricCode,
    raw_label: rawLabel,
    value_type: valueType,
    value_status: "DISCLOSED",
    value_certainty: "CONFIRMED",
    raw_value_text: rawValueText,
    raw_unit_text: unit,
    normalized_value: normalizedValue,
    unit: valueType === "NUMERIC" ? unit : null,
    currency: unit === "원" || unit === "KRW" ? "KRW" : null,
    scale: scale ?? null,
    scope,
    period_type: periodType,
    period_start: periodStart ?? null,
    period_end: periodEnd ?? null,
    as_of_date: asOfDate ?? null,
    known_at: `${asOfDate ?? generatedAt.slice(0, 10)}T00:00:00Z`,
    valid_from: `${asOfDate ?? generatedAt.slice(0, 10)}T00:00:00Z`,
    valid_to: null,
    withheld_until: null,
    extraction_method: "DETERMINISTIC",
    confidence: 1,
    verification_status: "CANDIDATE",
    evidence_ids: [evidenceId],
    attributes: {
      review_provenance: {
        review_method: "AUTOMATED_GROUNDING_CHECK_PENDING_OWNER_REVIEW",
        owner_disposition: "PENDING",
        audit_basis: "seed-thin-flow-harness-v04.v0.1 Codex 독립 검수 metric_fail 원인 분석 -- 6건 신규 Fact 배치, Owner 검수 대기",
      },
    },
  };
  const errors = validateFactRecord(fact);
  if (errors.length) fail(`fact ${factId} schema errors: ${errors.join("; ")}`);
  return fact;
}

// Exported so tests can build the exact same records in-memory without
// writing to the real repo paths, and can assert on their shape directly
// (no APPROVE/VERIFIED/reviewer value anywhere in the output).
export async function buildCandidates({ generatedAt = new Date().toISOString() } = {}) {
  const evQ02 = await buildCandidateEvidence({
    documentId: "exchange_20250428800409", blockSuffix: "::n0", row: 4, col: 1, expectedText: "5.5",
    corpCode: "00111704", linkedQuestionId: "question_seed_v07_02", linkedSlotName: "equity_ratio_percent", generatedAt,
  });
  const factQ02 = buildCandidateFact({
    corpCode: "00111704", sourceDocumentId: "exchange_20250428800409", metricCode: "EQUITY_RATIO_PERCENT",
    rawLabel: "자기자본대비(%)", valueType: "NUMERIC", normalizedValue: 5.5, rawValueText: "5.5", unit: "%",
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-04-28", evidenceId: evQ02.evidence_id, generatedAt,
  });

  const evQ04 = await buildCandidateEvidence({
    documentId: "holding_20250124000900", blockSuffix: "::n19", row: 4, col: 1, expectedText: "-38,791",
    corpCode: "00126380", linkedQuestionId: "question_seed_v07_04", linkedSlotName: "change_vs_previous_shares", generatedAt,
  });
  const factQ04 = buildCandidateFact({
    corpCode: "00126380", sourceDocumentId: "holding_20250124000900", metricCode: "HOLDING_SHARES_CHANGE",
    rawLabel: "증감 (주식등의 수)", valueType: "NUMERIC", normalizedValue: -38791, rawValueText: "-38,791", unit: "주",
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-01-24", evidenceId: evQ04.evidence_id, generatedAt,
  });

  const evQ05Amount = await buildCandidateEvidence({
    documentId: "major_20260120000144", blockSuffix: "::n3", row: 4, col: 2, expectedText: "74,128,800",
    corpCode: "00190321", linkedQuestionId: "question_seed_v07_05", linkedSlotName: "planned_amount_krw", generatedAt,
  });
  const factQ05Amount = buildCandidateFact({
    corpCode: "00190321", sourceDocumentId: "major_20260120000144", metricCode: "DISPOSAL_PLANNED_AMOUNT",
    rawLabel: "3. 처분예정금액(원)·보통주식", valueType: "NUMERIC", normalizedValue: 74128800, rawValueText: "74,128,800", unit: "원",
    scale: 1, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2026-01-20", evidenceId: evQ05Amount.evidence_id, generatedAt,
  });
  const evQ05Price = await buildCandidateEvidence({
    documentId: "major_20260120000144", blockSuffix: "::n3", row: 2, col: 2, expectedText: "53,600",
    corpCode: "00190321", linkedQuestionId: "question_seed_v07_05", linkedSlotName: "context_reference_price_krw", generatedAt,
  });
  const factQ05Price = buildCandidateFact({
    corpCode: "00190321", sourceDocumentId: "major_20260120000144", metricCode: "DISPOSAL_REFERENCE_PRICE",
    rawLabel: "2. 처분 대상 주식가격(원)·보통주식", valueType: "NUMERIC", normalizedValue: 53600, rawValueText: "53,600", unit: "원",
    scale: 1, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2026-01-20", evidenceId: evQ05Price.evidence_id, generatedAt,
  });

  const evQ10Before = await buildCandidateEvidence({
    documentId: "periodic_20230814001827", blockSuffix: "::n137", row: 27, col: 1, expectedText: "10",
    corpCode: "00302926", linkedQuestionId: "question_seed_v07_10", linkedSlotName: "consolidation_entity_count_2023", generatedAt,
  });
  const factQ10Before = buildCandidateFact({
    corpCode: "00302926", sourceDocumentId: "periodic_20230814001827", metricCode: "CONSOLIDATION_ENTITY_COUNT",
    rawLabel: "연결에 포함된 회사수", valueType: "NUMERIC", normalizedValue: 10, rawValueText: "10", unit: "개",
    scope: "CONSOLIDATED", periodType: "CUMULATIVE", periodStart: "2023-01-01", periodEnd: "2023-06-30", asOfDate: "2023-08-14",
    evidenceId: evQ10Before.evidence_id, generatedAt,
  });
  const evQ10After = await buildCandidateEvidence({
    documentId: "periodic_20250814004080", blockSuffix: "::n151", row: 27, col: 1, expectedText: "16",
    corpCode: "00302926", linkedQuestionId: "question_seed_v07_10", linkedSlotName: "consolidation_entity_count_2025", generatedAt,
  });
  const factQ10After = buildCandidateFact({
    corpCode: "00302926", sourceDocumentId: "periodic_20250814004080", metricCode: "CONSOLIDATION_ENTITY_COUNT",
    rawLabel: "연결에 포함된 회사수", valueType: "NUMERIC", normalizedValue: 16, rawValueText: "16", unit: "개",
    scope: "CONSOLIDATED", periodType: "CUMULATIVE", periodStart: "2025-01-01", periodEnd: "2025-06-30", asOfDate: "2025-08-14",
    evidenceId: evQ10After.evidence_id, generatedAt,
  });

  const evidence = [evQ02, evQ04, evQ05Amount, evQ05Price, evQ10Before, evQ10After];
  const facts = [factQ02, factQ04, factQ05Amount, factQ05Price, factQ10Before, factQ10After];

  // The decision TEMPLATE: a human Owner must open this, change each
  // owner_disposition from "PENDING" to "APPROVE" (or "REJECT"), and fill
  // reviewer/reviewed_at, before scripts/promote-seed-fact-batch-v06.mjs
  // will accept it. This script itself never writes anything but "PENDING"/
  // null here.
  const decisionTemplate = facts.map((f, i) => ({
    review_item_id: `structured_review_v06_batch_${f.fact_id.slice(5, 15)}`,
    fact_id: f.fact_id,
    evidence_id: evidence[i].evidence_id,
    metric_code: f.metric_code,
    slot_name: evidence[i].metadata.linked_slot_names[0],
    question_id: evidence[i].metadata.linked_question_ids[0],
    category: "NEW_METRIC_GAP_CLOSURE",
    claude_review_basis: `canonical DocumentIR raw table cell (${evidence[i].source_locator})에서 직접 재조회, quoted_text가 셀 원문과 정확히 일치함을 이 스크립트가 기계적으로 재확인함.`,
    owner_disposition: "PENDING",
    reviewer: null,
    reviewed_at: null,
    notes: "Codex 독립 검수(v0.17 감사)에서 발견된 metric_fail 원인 조사 중 식별된 신규 Fact 후보. 이 템플릿은 코드가 생성했으며 owner_disposition/reviewer/reviewed_at은 사람이 직접 채워야 한다.",
  }));

  return { evidence, facts, decisionTemplate };
}

async function main() {
  const { evidence, facts, decisionTemplate } = await buildCandidates();
  await writeFile(EVIDENCE_CANDIDATES_PATH, jsonl(evidence), "utf8");
  await writeFile(FACT_CANDIDATES_PATH, jsonl(facts), "utf8");
  await writeFile(DECISION_TEMPLATE_PATH, jsonl(decisionTemplate), "utf8");
  console.log(JSON.stringify({
    evidence_candidates: evidence.length,
    fact_candidates: facts.length,
    decision_template_items: decisionTemplate.length,
    evidence_candidates_path: EVIDENCE_CANDIDATES_PATH,
    fact_candidates_path: FACT_CANDIDATES_PATH,
    decision_template_path: DECISION_TEMPLATE_PATH,
    all_dispositions_pending: decisionTemplate.every((d) => d.owner_disposition === "PENDING" && d.reviewer === null && d.reviewed_at === null),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
