// Turn M3 items 4/5: authors NEW CANDIDATE Facts for the 3 of the 7
// STRUCTURED_DATA_GAP items (Q09/Q17/Q25) that the ontology audit
// confirmed can be closed via REUSE_EXISTING_ONTOLOGY_NEW_RECORD -- every
// metric_code used below (CONTRACT_COUNTERPARTY, LATEST_CONTRACT_AMOUNT,
// CONTRACT_RESERVATION_DEADLINE) is a REAL, already-established token in
// the current VERIFIED ontology (see seed-response-structured-gap-
// ontology-audit.v0.1.json); none is invented. Every Evidence referenced
// below is ALREADY VERIFIED (not authored here) -- each was independently
// prepared and grounding-checked in an earlier pass (automated_checks all
// true) and already carries linked_question_ids/linked_slot_names
// metadata pointing at exactly the gap this batch closes; this script
// only builds the missing FACT record that references it. No new
// Evidence is created (Turn M3 item 5's "기존 Evidence를 참조할 수 있으면
//새 Evidence를 중복 생성하지 마" rule).
//
// Q06 (investment purpose/target), Q09's remaining "예정수량" role, and
// Q20 (correction reason with no accompanying terminal value in the same
// document) are NOT included here -- see the ontology audit's
// ONTOLOGY_PROPOSAL_REQUIRED entries for why.
//
// P0 CANDIDATE CONTRACT (same as scripts/build-seed-fact-batch-v07-candidates.mjs):
// verification_status:"CANDIDATE" throughout, owner_disposition:"PENDING",
// no reviewer, no approval literal anywhere in this file's code. A
// SEPARATE promotion script (following the SAME pattern as
// scripts/promote-seed-fact-batch-v06.mjs) is required before anything
// here can ever become VERIFIED, and requires a real, externally
// authored decision artifact.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FACT_CANDIDATES_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const DECISION_TEMPLATE_PATH = path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.8-batch.template.jsonl");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");

function fail(msg) { throw new Error(`CANDIDATE_BUILD_BLOCKED: ${msg}`); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }

async function loadVerifiedEvidenceById() {
  const text = await readFile(EVIDENCE_VERIFIED_PATH, "utf8");
  const byId = new Map();
  for (const line of text.trim().split("\n")) {
    const rec = JSON.parse(line);
    byId.set(rec.evidence_id, rec);
  }
  return byId;
}

// Re-verifies the referenced Evidence really is VERIFIED, really carries
// the expected quoted_text, and really is linked (in its own metadata) to
// the question/slot this batch is closing -- this script's own grounding
// check, independent of whatever prior pass verified the Evidence itself.
function resolveVerifiedEvidence(evidenceById, evidenceId, { expectedText, expectedQuestionId, expectedSlotName }) {
  const evidence = evidenceById.get(evidenceId);
  if (!evidence) fail(`evidence ${evidenceId} not found in VERIFIED evidence artifact`);
  if (evidence.verification_status !== "VERIFIED") fail(`evidence ${evidenceId} is not VERIFIED (found ${evidence.verification_status})`);
  if (evidence.quoted_text !== expectedText) fail(`evidence ${evidenceId} quoted_text mismatch: expected ${JSON.stringify(expectedText)}, actual ${JSON.stringify(evidence.quoted_text)}`);
  const linkedQ = evidence.metadata?.linked_question_ids ?? [];
  const linkedSlot = evidence.metadata?.linked_slot_names ?? [];
  if (!linkedQ.includes(expectedQuestionId)) fail(`evidence ${evidenceId} is not linked to ${expectedQuestionId} (linked: ${linkedQ.join(",")})`);
  if (!linkedSlot.includes(expectedSlotName)) fail(`evidence ${evidenceId} is not linked to slot ${expectedSlotName} (linked: ${linkedSlot.join(",")})`);
  return evidence;
}

function buildCandidateFact({
  corpCode, sourceDocumentId, metricCode, rawLabel, valueType, valueCertainty = "CONFIRMED",
  normalizedValue, rawValueText, unit, currency, scale, scope, periodType,
  periodStart = null, periodEnd = null, asOfDate, knownAt, evidenceId, gapBasis,
}) {
  const factId = ids.fact(corpCode, metricCode, asOfDate ?? "no-period", scope, sourceDocumentId);
  const knownAtDate = knownAt ?? asOfDate;
  const fact = {
    fact_id: factId,
    corp_code: corpCode,
    event_id: null,
    source_document_id: sourceDocumentId,
    metric_code: metricCode,
    raw_label: rawLabel,
    value_type: valueType,
    value_status: "DISCLOSED",
    value_certainty: valueCertainty,
    raw_value_text: rawValueText,
    raw_unit_text: unit,
    normalized_value: normalizedValue,
    unit: valueType === "NUMERIC" ? unit : null,
    currency: currency ?? null,
    scale: scale ?? null,
    scope,
    period_type: periodType,
    period_start: periodStart,
    period_end: periodEnd,
    as_of_date: asOfDate,
    known_at: `${knownAtDate}T00:00:00Z`,
    valid_from: `${knownAtDate}T00:00:00Z`,
    valid_to: null,
    withheld_until: null,
    extraction_method: "DETERMINISTIC",
    confidence: 0.95,
    verification_status: "CANDIDATE",
    evidence_ids: [evidenceId],
    attributes: {
      review_provenance: {
        review_method: "AUTOMATED_GROUNDING_CHECK_PENDING_OWNER_REVIEW",
        owner_disposition: "PENDING",
        audit_basis: gapBasis,
        ontology_reuse_basis: "REUSE_EXISTING_ONTOLOGY_NEW_RECORD -- metric_code already used by other VERIFIED Facts, no new ontology token introduced (see seed-response-structured-gap-ontology-audit.v0.1.json)",
      },
    },
  };
  const errors = validateFactRecord(fact);
  if (errors.length) fail(`fact ${factId} schema errors: ${errors.join("; ")}`);
  return fact;
}

export async function buildCandidates() {
  const evidenceById = await loadVerifiedEvidenceById();
  const facts = [];
  const linkages = [];

  function add(fact, { evidenceId, questionId, slotName, note }) {
    facts.push(fact);
    linkages.push({
      review_item_id: `structured_review_v08_batch_${fact.fact_id.slice(5, 15)}`,
      fact_id: fact.fact_id, evidence_id: evidenceId, metric_code: fact.metric_code,
      slot_name: slotName, question_id: questionId, category: "TURN_M3_STRUCTURED_GAP_CLOSURE",
      claude_review_basis: `evidence ${evidenceId}는 이미 VERIFIED이며 이 스크립트가 quoted_text/linked_question_ids/linked_slot_names를 독립 재확인함. metric_code는 REUSE_EXISTING_ONTOLOGY_NEW_RECORD.`,
      owner_disposition: "PENDING", reviewer: null, reviewed_at: null, notes: note,
    });
  }

  // -- Q09: trust counterparty (CONTRACT_COUNTERPARTY -- already used for
  // Q24's counterparty pair; a clean, existing-role reuse) -------------
  const q09Evidence = resolveVerifiedEvidence(evidenceById, "evidence_4bb201438fab0e23e64ec747", {
    expectedText: "NH투자증권(NH Investment & Securities Co., Ltd.)",
    expectedQuestionId: "question_seed_v07_09", expectedSlotName: "decision_content",
  });
  const factQ09Counterparty = buildCandidateFact({
    corpCode: "00382199", sourceDocumentId: q09Evidence.document_id, metricCode: "CONTRACT_COUNTERPARTY",
    rawLabel: "신탁계약 상대방", valueType: "TEXT", normalizedValue: "NH투자증권(NH Investment & Securities Co., Ltd.)",
    rawValueText: "NH투자증권(NH Investment & Securities Co., Ltd.)", unit: null,
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-02-06",
    evidenceId: q09Evidence.evidence_id,
    gapBasis: "Turn M2 matrix v0.2 Q09 STRUCTURED_DATA_GAP -- counterparty existed only as Evidence, no Fact.",
  });
  add(factQ09Counterparty, { evidenceId: q09Evidence.evidence_id, questionId: "question_seed_v07_09", slotName: "trust_counterparty", note: "Q09 Owner note가 요구한 NH투자증권 상대방 정보. 기존 CONTRACT_COUNTERPARTY metric_code 재사용." });

  // -- Q17: latest known contract amount before termination, per company
  // (LATEST_CONTRACT_AMOUNT -- already used for Q22's temporal-latest
  // role; the correct existing role for "해지 시점 유효 계약금액") ------
  const q17SamsungHeavy = resolveVerifiedEvidence(evidenceById, "evidence_3164630d0f878e59572b470e", {
    expectedText: "114,800,000,000",
    expectedQuestionId: "question_seed_v07_17", expectedSlotName: "samsung_heavy_correction",
  });
  const factQ17SamsungHeavy = buildCandidateFact({
    corpCode: "00126478", sourceDocumentId: q17SamsungHeavy.document_id, metricCode: "LATEST_CONTRACT_AMOUNT",
    rawLabel: "해지 시점 유효 계약금액", valueType: "NUMERIC", normalizedValue: 114_800_000_000,
    rawValueText: "114,800,000,000", unit: "원", currency: "KRW", scale: 1,
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2026-02-03",
    evidenceId: q17SamsungHeavy.evidence_id,
    gapBasis: "Turn M2 matrix v0.2 Q17 STRUCTURED_DATA_GAP -- no Fact for 'contract amount effective at termination time'.",
  });
  add(factQ17SamsungHeavy, { evidenceId: q17SamsungHeavy.evidence_id, questionId: "question_seed_v07_17", slotName: "samsung_heavy_latest_contract_amount", note: "삼성중공업 해지 직전(2026-02-03 정정공시) 유효 계약금액. 기존 LATEST_CONTRACT_AMOUNT metric_code 재사용." });

  const q17Hyosung = resolveVerifiedEvidence(evidenceById, "evidence_e8aa546f991c7e0f7af17099", {
    expectedText: "291,204,288,000",
    expectedQuestionId: "question_seed_v07_17", expectedSlotName: "hyosung_original",
  });
  const factQ17Hyosung = buildCandidateFact({
    corpCode: "01316245", sourceDocumentId: q17Hyosung.document_id, metricCode: "LATEST_CONTRACT_AMOUNT",
    rawLabel: "해지 시점 유효 계약금액", valueType: "NUMERIC", normalizedValue: 291_204_288_000,
    rawValueText: "291,204,288,000", unit: "원", currency: "KRW", scale: 1,
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2024-11-04",
    evidenceId: q17Hyosung.evidence_id,
    gapBasis: "Turn M2 matrix v0.2 Q17 STRUCTURED_DATA_GAP -- no Fact for 'contract amount effective at termination time'.",
  });
  add(factQ17Hyosung, { evidenceId: q17Hyosung.evidence_id, questionId: "question_seed_v07_17", slotName: "hyosung_latest_contract_amount", note: "효성중공업 해지 직전(2024-11-04 공시) 최종 확인 계약금액. 기존 LATEST_CONTRACT_AMOUNT metric_code 재사용." });

  // -- Q25: reservation-deadline correction history (CONTRACT_RESERVATION_DEADLINE
  // -- the SAME metric_code the existing "최초 유보기한" Fact already
  // uses; each correction step + the final confirmed deadline as its own
  // dated record, never compressed into one string) --------------------
  const q25Steps = [
    { evidenceId: "evidence_91a8d0111c99aebb46e596a7", text: "2024-03-30", slot: "reservation_deadline_intermediate", label: "유보기한 정정(1차)", asOf: "2023-12-19", certainty: "PROVISIONAL" },
    { evidenceId: "evidence_23e50c14ae2155eea30e3df0", text: "2024-05-31", slot: "reservation_deadline_intermediate", label: "유보기한 정정(2차)", asOf: "2024-03-20", certainty: "PROVISIONAL" },
    { evidenceId: "evidence_d86330c8b03ff845d876c347", text: "2024-06-30", slot: "reservation_deadline_intermediate", label: "유보기한 정정(3차)", asOf: "2024-05-31", certainty: "PROVISIONAL" },
    { evidenceId: "evidence_b5ef52b48821dfc8e16d5496", text: "2024-07-30", slot: "reservation_deadline_intermediate", label: "유보기한 정정(4차)", asOf: "2024-06-25", certainty: "PROVISIONAL" },
    { evidenceId: "evidence_e9d54831df04d80560129340", text: "2030-12-31", slot: "reservation_deadline_final", label: "최종 유보기한", asOf: "2024-07-02", certainty: "CONFIRMED" },
  ];
  for (const step of q25Steps) {
    const ev = resolveVerifiedEvidence(evidenceById, step.evidenceId, {
      expectedText: step.text, expectedQuestionId: "question_seed_v07_25", expectedSlotName: step.slot,
    });
    const f = buildCandidateFact({
      corpCode: "00877059", sourceDocumentId: ev.document_id, metricCode: "CONTRACT_RESERVATION_DEADLINE",
      rawLabel: step.label, valueType: "DATE", valueCertainty: step.certainty,
      normalizedValue: step.text, rawValueText: step.text, unit: null,
      scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: step.asOf,
      evidenceId: ev.evidence_id,
      gapBasis: "Turn M2 matrix v0.2 Q25 STRUCTURED_DATA_GAP -- only the initial reservation deadline had a Fact; the correction history existed only as Evidence.",
    });
    add(f, { evidenceId: ev.evidence_id, questionId: "question_seed_v07_25", slotName: step.slot, note: `유보기한 변경 이력의 한 단계(${step.text}). 기존 CONTRACT_RESERVATION_DEADLINE metric_code 재사용 (기존 '최초 유보기한' Fact와 동일 metric, 서로 다른 as_of_date/evidence_id로 분리).` });
  }

  return { facts, linkages };
}

async function main() {
  const { facts, linkages } = await buildCandidates();
  await writeFile(FACT_CANDIDATES_PATH, jsonl(facts), "utf8");
  await writeFile(DECISION_TEMPLATE_PATH, jsonl(linkages), "utf8");
  console.log(JSON.stringify({
    fact_candidates: facts.length,
    decision_template_items: linkages.length,
    fact_candidates_path: FACT_CANDIDATES_PATH,
    decision_template_path: DECISION_TEMPLATE_PATH,
    all_dispositions_pending: linkages.every((d) => d.owner_disposition === "PENDING" && d.reviewer === null && d.reviewed_at === null),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
