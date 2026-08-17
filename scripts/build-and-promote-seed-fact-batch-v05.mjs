// Authors and promotes 6 new Facts (+ their grounding Evidence) closing the
// tractable Harness metric gaps found in Q02/Q04/Q05/Q10 (see the Owner-
// approval turn: "Approve all 6" -- Owner: 최재완, approved via this
// session's conversation, same governance gate as
// seed-structured-owner-decision.v0.4.jsonl, scaled to a 6-item batch).
// Every quoted_text below is copied verbatim from the real canonical
// DocumentIR raw table cell at the stated locator -- re-verified against
// bytes by this script itself (quoteResolvesAtLocator-equivalent) before
// anything is written. Q07/Q21/Q24's much larger gaps are NOT touched here
// -- see the promotion report's "unresolved" section.
//
// New files only: seed-evidence-candidates.v0.7.delta.jsonl (raw candidate
// record, for audit trail) + seed-evidence-verified.v0.7.jsonl (v0.6's 213
// + 6 new = 219) + seed-facts-verified.v0.5.jsonl (v0.4's 67 + 6 new = 73)
// + seed-fact-coverage-verified.v0.5.json (v0.4's 82 + 6 new slots = 88).
// v0.6/v0.4-verified and all Candidate v0.16/v0.4/v0.6 inputs from the
// prior promotion are never opened for writing.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { validateEvidenceRecord, validateFactRecord, validateFactCoverageSnapshot } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTED_AT = new Date().toISOString();
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const REVIEWER = "최재완";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function readJsonlAbs(p) { return (await readAbs(p)).toString("utf8").trim().split("\n").map(JSON.parse); }
async function readJsonAbs(p) { return JSON.parse((await readAbs(p)).toString("utf8")); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }
function fail(msg) { throw new Error(`BATCH_BLOCKED: ${msg}`); }

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

async function buildEvidence({ documentId, blockSuffix, row, col, expectedText, corpCode, linkedQuestionId, linkedSlotName }) {
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
    verification_status: "VERIFIED",
    metadata: {
      review_status: "OWNER_ACCEPTED",
      corp_code: corpCode,
      source_node_id: `${documentId}::${documentId.split("_")[1]}.xml::${blockSuffix.slice(2)}`,
      row, column: col,
      linked_question_ids: [linkedQuestionId],
      linked_slot_names: [linkedSlotName],
      verification_provenance: {
        review_method: "OWNER_DIRECT_APPROVAL_CLAUDE_GROUNDING_CHECK",
        audit_basis: "seed-thin-flow-harness-v04.v0.1 Codex 독립 검수 metric_fail 원인 분석",
        identity_basis: "CELL_QUALIFIED_SOURCE_LOCATOR",
        corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
        generated_at: PROMOTED_AT,
        owner_approved_by: REVIEWER,
        owner_approved_at: PROMOTED_AT,
      },
    },
  };
  const errors = validateEvidenceRecord(evidence);
  if (errors.length) fail(`evidence ${evidenceId} schema errors: ${errors.join("; ")}`);
  return evidence;
}

function buildFact({ corpCode, sourceDocumentId, metricCode, rawLabel, valueType, normalizedValue, rawValueText, unit, scale, scope, periodType, periodStart, periodEnd, asOfDate, evidenceId }) {
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
    known_at: `${asOfDate ?? PROMOTED_AT.slice(0, 10)}T00:00:00Z`,
    valid_from: `${asOfDate ?? PROMOTED_AT.slice(0, 10)}T00:00:00Z`,
    valid_to: null,
    withheld_until: null,
    extraction_method: "DETERMINISTIC",
    confidence: 1,
    verification_status: "VERIFIED",
    evidence_ids: [evidenceId],
    attributes: {
      review_provenance: {
        review_method: "OWNER_DIRECT_APPROVAL_CLAUDE_GROUNDING_CHECK",
        owner_disposition: "ACCEPTED",
        owner_approved_by: REVIEWER,
        owner_approved_at: PROMOTED_AT,
        audit_basis: "seed-thin-flow-harness-v04.v0.1 Codex 독립 검수 metric_fail 원인 분석 -- 6건 신규 Fact 배치 승인",
      },
    },
  };
  const errors = validateFactRecord(fact);
  if (errors.length) fail(`fact ${factId} schema errors: ${errors.join("; ")}`);
  return fact;
}

async function main() {
  // --- Q02: equity_ratio_percent ------------------------------------
  const evQ02 = await buildEvidence({
    documentId: "exchange_20250428800409", blockSuffix: "::n0", row: 4, col: 1, expectedText: "5.5",
    corpCode: "00111704", linkedQuestionId: "question_seed_v07_02", linkedSlotName: "equity_ratio_percent",
  });
  const factQ02 = buildFact({
    corpCode: "00111704", sourceDocumentId: "exchange_20250428800409", metricCode: "EQUITY_RATIO_PERCENT",
    rawLabel: "자기자본대비(%)", valueType: "NUMERIC", normalizedValue: 5.5, rawValueText: "5.5", unit: "%",
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-04-28", evidenceId: evQ02.evidence_id,
  });

  // --- Q04: change_vs_previous_shares (직접 공시된 "증감" 행) --------
  const evQ04 = await buildEvidence({
    documentId: "holding_20250124000900", blockSuffix: "::n19", row: 4, col: 1, expectedText: "-38,791",
    corpCode: "00126380", linkedQuestionId: "question_seed_v07_04", linkedSlotName: "change_vs_previous_shares",
  });
  const factQ04 = buildFact({
    corpCode: "00126380", sourceDocumentId: "holding_20250124000900", metricCode: "HOLDING_SHARES_CHANGE",
    rawLabel: "증감 (주식등의 수)", valueType: "NUMERIC", normalizedValue: -38791, rawValueText: "-38,791", unit: "주",
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-01-24", evidenceId: evQ04.evidence_id,
  });

  // --- Q05: planned_amount_krw + context.reference_price_krw --------
  const evQ05Amount = await buildEvidence({
    documentId: "major_20260120000144", blockSuffix: "::n3", row: 4, col: 2, expectedText: "74,128,800",
    corpCode: "00190321", linkedQuestionId: "question_seed_v07_05", linkedSlotName: "planned_amount_krw",
  });
  const factQ05Amount = buildFact({
    corpCode: "00190321", sourceDocumentId: "major_20260120000144", metricCode: "DISPOSAL_PLANNED_AMOUNT",
    rawLabel: "3. 처분예정금액(원)·보통주식", valueType: "NUMERIC", normalizedValue: 74128800, rawValueText: "74,128,800", unit: "원",
    scale: 1, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2026-01-20", evidenceId: evQ05Amount.evidence_id,
  });
  const evQ05Price = await buildEvidence({
    documentId: "major_20260120000144", blockSuffix: "::n3", row: 2, col: 2, expectedText: "53,600",
    corpCode: "00190321", linkedQuestionId: "question_seed_v07_05", linkedSlotName: "context_reference_price_krw",
  });
  const factQ05Price = buildFact({
    corpCode: "00190321", sourceDocumentId: "major_20260120000144", metricCode: "DISPOSAL_REFERENCE_PRICE",
    rawLabel: "2. 처분 대상 주식가격(원)·보통주식", valueType: "NUMERIC", normalizedValue: 53600, rawValueText: "53,600", unit: "원",
    scale: 1, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2026-01-20", evidenceId: evQ05Price.evidence_id,
  });

  // --- Q10: consolidation_entity_count 2023/2025 (Thin Flow templates
  // the note text from these two counts -- see thin-structured-flow.mjs) --
  const evQ10Before = await buildEvidence({
    documentId: "periodic_20230814001827", blockSuffix: "::n137", row: 27, col: 1, expectedText: "10",
    corpCode: "00302926", linkedQuestionId: "question_seed_v07_10", linkedSlotName: "consolidation_entity_count_2023",
  });
  const factQ10Before = buildFact({
    corpCode: "00302926", sourceDocumentId: "periodic_20230814001827", metricCode: "CONSOLIDATION_ENTITY_COUNT",
    rawLabel: "연결에 포함된 회사수", valueType: "NUMERIC", normalizedValue: 10, rawValueText: "10", unit: "개",
    scope: "CONSOLIDATED", periodType: "CUMULATIVE", periodStart: "2023-01-01", periodEnd: "2023-06-30", asOfDate: "2023-08-14",
    evidenceId: evQ10Before.evidence_id,
  });
  const evQ10After = await buildEvidence({
    documentId: "periodic_20250814004080", blockSuffix: "::n151", row: 27, col: 1, expectedText: "16",
    corpCode: "00302926", linkedQuestionId: "question_seed_v07_10", linkedSlotName: "consolidation_entity_count_2025",
  });
  const factQ10After = buildFact({
    corpCode: "00302926", sourceDocumentId: "periodic_20250814004080", metricCode: "CONSOLIDATION_ENTITY_COUNT",
    rawLabel: "연결에 포함된 회사수", valueType: "NUMERIC", normalizedValue: 16, rawValueText: "16", unit: "개",
    scope: "CONSOLIDATED", periodType: "CUMULATIVE", periodStart: "2025-01-01", periodEnd: "2025-06-30", asOfDate: "2025-08-14",
    evidenceId: evQ10After.evidence_id,
  });

  const newEvidence = [evQ02, evQ04, evQ05Amount, evQ05Price, evQ10Before, evQ10After];
  const newFacts = [factQ02, factQ04, factQ05Amount, factQ05Price, factQ10Before, factQ10After];

  // --- Candidate delta (audit trail, kept even after promotion) ------
  await writeFile(path.join(REPO, "work/domain-seed/seed-evidence-candidates.v0.7.delta.jsonl"), jsonl(newEvidence), "utf8");
  await writeFile(path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.5.delta.jsonl"), jsonl(newFacts), "utf8");

  // --- Decision record (small batch, same governance shape as v0.4) --
  const decisionItems = newFacts.map((f, i) => ({
    review_item_id: `structured_review_v05_batch_${f.fact_id.slice(5, 15)}`,
    fact_id: f.fact_id,
    evidence_id: newEvidence[i].evidence_id,
    metric_code: f.metric_code,
    slot_name: newEvidence[i].metadata.linked_slot_names[0],
    question_id: newEvidence[i].metadata.linked_question_ids[0],
    category: "NEW_METRIC_GAP_CLOSURE",
    claude_review_basis: `canonical DocumentIR raw table cell (${newEvidence[i].source_locator})에서 직접 재조회, quoted_text가 셀 원문과 정확히 일치함을 이 스크립트가 기계적으로 재확인함.`,
    owner_disposition: "APPROVE",
    reviewer: REVIEWER,
    reviewed_at: PROMOTED_AT,
    notes: "Codex 독립 검수에서 발견된 metric_fail 원인 조사 중 식별된 신규 Fact. Owner가 이 세션 대화에서 6건 일괄 승인함(\"Approve all 6\").",
  }));
  await writeFile(path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl"), jsonl(decisionItems), "utf8");
  const decisionSha256 = sha256(await readAbs("work/domain-seed/seed-structured-owner-decision.v0.5-batch.jsonl"));

  // --- Promote: merge into new VERIFIED revisions --------------------
  const evidenceV06 = await readJsonlAbs("work/domain-seed/seed-evidence-verified.v0.6.jsonl");
  const evidenceV07 = [...evidenceV06, ...newEvidence].sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
  const evErrors = evidenceV07.flatMap((r, i) => validateEvidenceRecord(r).map((e) => `evidence[${i}]: ${e}`));
  if (evErrors.length) fail(evErrors.join("\n"));
  await writeFile(path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.7.jsonl"), jsonl(evidenceV07), "utf8");

  const factsV04 = await readJsonlAbs("work/domain-seed/seed-facts-verified.v0.4.jsonl");
  const factsV05 = [...factsV04, ...newFacts];
  const factErrors = factsV05.flatMap((r, i) => validateFactRecord(r).map((e) => `fact[${i}]: ${e}`));
  if (factErrors.length) fail(factErrors.join("\n"));
  await writeFile(path.join(REPO, "work/domain-seed/seed-facts-verified.v0.5.jsonl"), jsonl(factsV05), "utf8");

  const coverageV04 = await readJsonAbs("work/domain-seed/seed-fact-coverage-verified.v0.4.json");
  const newSlots = [
    { slot_key: "question_seed_v07_02::equity_ratio_percent", corp_code: "00111704", metric_code: "EQUITY_RATIO_PERCENT", period_key: "as_of:2025-04-28", scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ02.fact_id], evidence_ids: [evQ02.evidence_id], reason_code: null },
    { slot_key: "question_seed_v07_04::change_vs_previous_shares", corp_code: "00126380", metric_code: "HOLDING_SHARES_CHANGE", period_key: "as_of:2025-01-24", scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ04.fact_id], evidence_ids: [evQ04.evidence_id], reason_code: null },
    { slot_key: "question_seed_v07_05::planned_amount_krw", corp_code: "00190321", metric_code: "DISPOSAL_PLANNED_AMOUNT", period_key: "as_of:2026-01-20", scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ05Amount.fact_id], evidence_ids: [evQ05Amount.evidence_id], reason_code: null },
    { slot_key: "question_seed_v07_05::context_reference_price_krw", corp_code: "00190321", metric_code: "DISPOSAL_REFERENCE_PRICE", period_key: "as_of:2026-01-20", scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ05Price.fact_id], evidence_ids: [evQ05Price.evidence_id], reason_code: null },
    { slot_key: "question_seed_v07_10::consolidation_entity_count_2023", corp_code: "00302926", metric_code: "CONSOLIDATION_ENTITY_COUNT", period_key: "as_of:2023-08-14", scope: "CONSOLIDATED", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ10Before.fact_id], evidence_ids: [evQ10Before.evidence_id], reason_code: null },
    { slot_key: "question_seed_v07_10::consolidation_entity_count_2025", corp_code: "00302926", metric_code: "CONSOLIDATION_ENTITY_COUNT", period_key: "as_of:2025-08-14", scope: "CONSOLIDATED", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED", fact_ids: [factQ10After.fact_id], evidence_ids: [evQ10After.evidence_id], reason_code: null },
  ];
  const slotsV05 = [...coverageV04.slots, ...newSlots];
  const factCoverageSnapshotId = `fact_coverage_snapshot_${sha256(Buffer.from(JSON.stringify(slotsV05))).slice(0, 24)}`;
  const coverageV05 = {
    schema_version: "0.1.0", fact_coverage_snapshot_id: factCoverageSnapshotId, corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    semantic_bundle_schema_version: coverageV04.semantic_bundle_schema_version,
    producer_version: "seed-v05-metric-gap-closure-batch", created_at: PROMOTED_AT, slots: slotsV05,
  };
  const covErrors = validateFactCoverageSnapshot(coverageV05);
  if (covErrors.length) fail(covErrors.join("\n"));
  await writeFile(path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.5.json"), JSON.stringify(coverageV05, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({
    new_evidence: newEvidence.length, new_facts: newFacts.length, new_slots: newSlots.length,
    evidence_v07_total: evidenceV07.length, facts_v05_total: factsV05.length, coverage_v05_total: slotsV05.length,
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    decision_sha256: decisionSha256,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
