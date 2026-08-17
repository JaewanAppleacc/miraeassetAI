// Turn M5 Section 5: builds the 8 ontology-DEPENDENT Candidate previews
// (the exact records that would be authored if each ontology packet v0.2
// card is approved) so the Owner can judge the ontology token and its
// real resulting record on one screen. These are PREVIEWS ONLY --
// verification_status is left at the schema's real "CANDIDATE" value
// (there is no "preview" value in the closed verificationStatus enum),
// but every record is wrapped with an explicit outer `preview_status:
// "PROPOSAL_DEPENDENT_CANDIDATE"` marker so nothing here can ever be
// mistaken for an official Candidate/VERIFIED record before its ontology
// card is approved. Every value is independently re-verified against
// VERIFIED Evidence/Facts -- never hardcoded from memory.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const FACTS_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl");
const ONTOLOGY_PACKET_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256hex(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`CANDIDATE_PREVIEW_BLOCKED: ${msg}`); }

function resolveVerifiedEvidence(evidenceById, evidenceId, { expectedText, expectedQuestionId }) {
  const evidence = evidenceById.get(evidenceId);
  if (!evidence) fail(`evidence ${evidenceId} not found`);
  if (evidence.verification_status !== "VERIFIED") fail(`evidence ${evidenceId} is not VERIFIED`);
  if (evidence.quoted_text !== expectedText) fail(`evidence ${evidenceId} quoted_text mismatch: expected ${JSON.stringify(expectedText)}, actual ${JSON.stringify(evidence.quoted_text)}`);
  const linkedQ = evidence.metadata?.linked_question_ids ?? [];
  if (expectedQuestionId && !linkedQ.includes(expectedQuestionId)) fail(`evidence ${evidenceId} not linked to ${expectedQuestionId} (linked: ${linkedQ.join(",")})`);
  return evidence;
}

function buildPreviewFact({
  cardId, corpCode, sourceDocumentId, metricCode, rawLabel, valueType, valueCertainty = "CONFIRMED",
  normalizedValue, rawValueText, unit, currency, scale, scope, periodType,
  asOfDate, knownAt, evidenceId, linkedFactId, linkedEventId, gapBasis, previousDecisionNote,
}) {
  const factId = ids.fact(corpCode, metricCode, asOfDate ?? "no-period", scope, sourceDocumentId);
  const knownAtDate = knownAt ?? asOfDate;
  const fact = {
    fact_id: factId,
    corp_code: corpCode,
    event_id: linkedEventId ?? null,
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
    period_start: null,
    period_end: null,
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
        review_method: "AUTOMATED_GROUNDING_CHECK_PENDING_ONTOLOGY_APPROVAL",
        owner_disposition: "PENDING",
        audit_basis: gapBasis,
        ontology_reuse_basis: `NEW_TOKEN_PENDING_APPROVAL -- see ontology proposal card_id ${cardId} in seed-response-ontology-proposal-decision-packet.v0.2.json`,
      },
    },
  };
  const errors = validateFactRecord(fact);
  if (errors.length) fail(`preview fact ${factId} schema errors: ${errors.join("; ")}`);
  return {
    preview_status: "PROPOSAL_DEPENDENT_CANDIDATE",
    ontology_proposal_card_id: cardId,
    linked_existing_fact_id: linkedFactId ?? null,
    linked_existing_event_id: linkedEventId ?? null,
    previous_decision_note: previousDecisionNote ?? null,
    evidence_id: evidenceId,
    source_locator: null, // filled by caller from the resolved evidence record
    quoted_text: rawValueText,
    quote_sha256: null, // filled by caller
    owner_disposition: "PENDING",
    fact,
  };
}

async function main() {
  const evidenceRows = jsonl((await readFile(EVIDENCE_VERIFIED_PATH)).toString("utf8"));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const factRows = jsonl((await readFile(FACTS_VERIFIED_PATH)).toString("utf8"));
  const factById = new Map(factRows.map((f) => [f.fact_id, f]));
  const ontologyPacketBytes = await readFile(ONTOLOGY_PACKET_V02_PATH);
  const ontologyPacket = JSON.parse(ontologyPacketBytes.toString("utf8"));
  if (ontologyPacket.card_count !== 5) fail(`expected ontology packet v0.2 to have 5 cards, found ${ontologyPacket.card_count}`);

  const previews = [];

  function push(cardId, evidenceId, expectedText, expectedQuestionId, buildArgs, linkedFactId, previousDecisionNote) {
    const evidence = resolveVerifiedEvidence(evidenceById, evidenceId, { expectedText, expectedQuestionId });
    const preview = buildPreviewFact({ cardId, evidenceId, ...buildArgs, linkedFactId, previousDecisionNote });
    preview.source_locator = evidence.source_locator;
    preview.quote_sha256 = evidence.quote_sha256;
    if (sha256hex(evidence.quoted_text) !== evidence.quote_sha256) fail(`evidence ${evidenceId} quote_sha256 mismatch`);
    previews.push(preview);
  }

  // -- Card 1 (Q06): INVESTMENT_PURPOSE / INVESTMENT_TARGET_ASSET x 2 investments = 4 records --
  const craneAmountFact = factById.get("fact_5f6fa474ce3099876b32e4c5");
  const dockAmountFact = factById.get("fact_7c4d7fb184e153896c1c44af");
  if (!craneAmountFact || !dockAmountFact) fail("Q06 paired INVESTMENT_AMOUNT facts not found in VERIFIED facts");

  push(1, "evidence_1a8e753b5c667abbf2a60d73", "건조 효율성 증대", "question_seed_v07_06", {
    corpCode: "00111704", sourceDocumentId: craneAmountFact.source_document_id, metricCode: "INVESTMENT_PURPOSE",
    rawLabel: "3. 투자목적", valueType: "TEXT", normalizedValue: "건조 효율성 증대", rawValueText: "건조 효율성 증대",
    unit: null, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: craneAmountFact.as_of_date,
    gapBasis: "Turn M3/M4 ontology audit Q06 ONTOLOGY_PROPOSAL_REQUIRED -- investment purpose has no existing metric_code.",
  }, craneAmountFact.fact_id);

  push(1, "evidence_441902d5bf9434beed4da64d", "6,500ton급 Floating Crane", "question_seed_v07_06", {
    corpCode: "00111704", sourceDocumentId: craneAmountFact.source_document_id, metricCode: "INVESTMENT_TARGET_ASSET",
    rawLabel: "- 투자대상", valueType: "TEXT", normalizedValue: "6,500ton급 Floating Crane", rawValueText: "6,500ton급 Floating Crane",
    unit: null, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: craneAmountFact.as_of_date,
    gapBasis: "Turn M3/M4 ontology audit Q06 ONTOLOGY_PROPOSAL_REQUIRED -- investment target asset has no existing metric_code.",
  }, craneAmountFact.fact_id);

  push(1, "evidence_ab530df40bc10feff4d8f7e7", "생산량 증대", "question_seed_v07_06", {
    corpCode: "00111704", sourceDocumentId: dockAmountFact.source_document_id, metricCode: "INVESTMENT_PURPOSE",
    rawLabel: "3. 투자목적", valueType: "TEXT", normalizedValue: "생산량 증대", rawValueText: "생산량 증대",
    unit: null, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: dockAmountFact.as_of_date,
    gapBasis: "Turn M3/M4 ontology audit Q06 ONTOLOGY_PROPOSAL_REQUIRED -- investment purpose has no existing metric_code.",
  }, dockAmountFact.fact_id);

  push(1, "evidence_ee0081fbf5f0e705b2989ef1", "Floating Dock 확장", "question_seed_v07_06", {
    corpCode: "00111704", sourceDocumentId: dockAmountFact.source_document_id, metricCode: "INVESTMENT_TARGET_ASSET",
    rawLabel: "- 투자대상", valueType: "TEXT", normalizedValue: "Floating Dock 확장", rawValueText: "Floating Dock 확장",
    unit: null, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: dockAmountFact.as_of_date,
    gapBasis: "Turn M3/M4 ontology audit Q06 ONTOLOGY_PROPOSAL_REQUIRED -- investment target asset has no existing metric_code.",
  }, dockAmountFact.fact_id);

  // -- Card 2 (Q09): ACQUISITION_PLANNED_SHARES x 1 -----------------------
  push(2, "evidence_b673a282e3406174077c7456", "9,861,932", "question_seed_v07_09", {
    corpCode: "00382199", sourceDocumentId: "major_20250206000192", metricCode: "ACQUISITION_PLANNED_SHARES",
    rawLabel: "9. 취득예정주식(주)·보통주식", valueType: "NUMERIC", normalizedValue: 9_861_932, rawValueText: "9,861,932",
    unit: "주", scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-02-06",
    gapBasis: "Turn M3/M4 ontology audit Q09 ONTOLOGY_PROPOSAL_REQUIRED -- planned trust-acquisition share count; DISPOSAL_SHARES reuse rejected (opposite direction).",
  }, null);

  // -- Card 3 (Q09): TRUST_CONTRACT_INSTITUTION x 1 -- reuses the SAME
  // evidence as the Owner-rejected fact_74a2b743fee3b410295be924 -------
  push(3, "evidence_4bb201438fab0e23e64ec747", "NH투자증권(NH Investment & Securities Co., Ltd.)", "question_seed_v07_09", {
    corpCode: "00382199", sourceDocumentId: "major_20250206000192", metricCode: "TRUST_CONTRACT_INSTITUTION",
    rawLabel: "4. 계약체결기관", valueType: "TEXT", normalizedValue: "NH투자증권(NH Investment & Securities Co., Ltd.)",
    rawValueText: "NH투자증권(NH Investment & Securities Co., Ltd.)", unit: null,
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2025-02-06",
    gapBasis: "Owner FIX_REQUIRED on fact_74a2b743fee3b410295be924 (CONTRACT_COUNTERPARTY reuse rejected as semantically wrong role) -- see seed-structured-gap-candidate-owner-decision.v0.2.jsonl.",
  }, null, "Supersedes the intent of fact_74a2b743fee3b410295be924 (v0.9, CONTRACT_COUNTERPARTY) -- that Candidate is NOT promoted; this is a fresh metric_code, not a correction of the old fact_id.");

  // -- Card 4 (Q20): CORRECTION_REASON x 1 --------------------------------
  push(4, "evidence_fb63f3d8238a3177b7ecef68", "변경계약 체결 지연으로 인한 계약종료일 정정", "question_seed_v07_20", {
    corpCode: "01261644", sourceDocumentId: "exchange_20241129900159", metricCode: "CORRECTION_REASON",
    rawLabel: "3. 정정사유", valueType: "TEXT", normalizedValue: "변경계약 체결 지연으로 인한 계약종료일 정정",
    rawValueText: "변경계약 체결 지연으로 인한 계약종료일 정정", unit: null,
    scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2024-11-29",
    gapBasis: "Turn M3/M4 ontology audit Q20 ONTOLOGY_PROPOSAL_REQUIRED -- correction-reason document carries no terminal value of its own in the same document; standalone Fact preserves its own provenance.",
  }, null);

  // -- Card 5 (Q18): ISSUANCE_AMOUNT x 1 ----------------------------------
  const q18SharesFact = factById.get("fact_4b5dc7b1e4bb34969ad7a51e");
  if (!q18SharesFact) fail("Q18 corrected shares/price fact not found in VERIFIED facts");
  const shares = q18SharesFact.attributes?.corrected_actual_shares;
  const pricePerShare = q18SharesFact.attributes?.issue_price_per_share_krw;
  if (shares * pricePerShare !== 2_198_873_250) fail(`Q18 cross-check failed: ${shares} x ${pricePerShare} != 2,198,873,250`);
  push(5, "evidence_ce757058c68b8932b0b7c7e0", "2,198,873,250", "question_seed_v07_18", {
    corpCode: "00111704", sourceDocumentId: "major_20240710000577", metricCode: "ISSUANCE_AMOUNT",
    rawLabel: "정 정 신 고 (보고)", valueType: "NUMERIC", normalizedValue: 2_198_873_250, rawValueText: "2,198,873,250",
    unit: "원", currency: "KRW", scale: 1, scope: "COMPANY", periodType: "POINT_IN_TIME", asOfDate: "2024-07-10",
    gapBasis: "Turn M4/M5 Section 2C -- narrative states shares and price_per_share separately but never their product; evidence_ce757058c68b8932b0b7c7e0 already states the total verbatim.",
  }, q18SharesFact.fact_id);

  if (previews.length !== 8) fail(`expected 8 ontology-dependent previews, built ${previews.length}`);

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  const jsonlText = previews.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: previews.length,
    by_card_id: previews.reduce((acc, p) => { acc[p.ontology_proposal_card_id] = (acc[p.ontology_proposal_card_id] ?? 0) + 1; return acc; }, {}),
    ontology_packet_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json",
    ontology_packet_v02_sha256: sha256(ontologyPacketBytes),
    all_owner_disposition_pending: previews.every((p) => p.owner_disposition === "PENDING"),
    all_preview_status_proposal_dependent: previews.every((p) => p.preview_status === "PROPOSAL_DEPENDENT_CANDIDATE"),
    all_verification_status_candidate: previews.every((p) => p.fact.verification_status === "CANDIDATE"),
    promotion_status: "NOT_PROMOTED",
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: previews.length, by_card_id: manifest.by_card_id }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
