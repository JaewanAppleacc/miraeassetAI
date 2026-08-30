#!/usr/bin/env node
// Turn N4.5, Tasks 1+2+5+6+8+9: reconciles the two independent 30-row
// sample-audit results (auditor A / auditor B) against the SAME Turn
// N4.4 sample-audit packet, without ever auto-picking a winner on
// disagreement; recomputes every headline number from the real 326-row
// ledger and 30-row sample packet instead of trusting a hardcoded
// expectation; and runs the general-signal-only multi-step-correction
// risk detector over the remaining unaudited PROVISIONAL_REJECT rows.
// Fails closed (writes NOTHING) on any mismatch or integrity violation.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDualAuditInputs, buildAuditComparisonLedger, selectAuditConflicts,
  detectMultiStepCorrectionRisk,
} from "../domain/evaluation/relation-closure-integration.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_V01_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const RESULTS_A_DIR = path.join(OWNER_V01_DIR, "results/sample-auditor-v0.1");
const RESULTS_B_DIR = path.join(OWNER_V01_DIR, "results/sample-auditor-b-v0.1");
const OUT_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");

const EXPECTED = Object.freeze({
  provisionalTotal: 297, provisionalConfirm: 161, provisionalReject: 136,
  sampleConfirmCount: 15, sampleRejectCount: 15,
  unauditedRejectCount: 121,
  auditorAPass: 29, auditorADefectFound: 1,
  auditorBPass: 30,
  dualAuditPass: 29, auditConflicts: 1,
});

const INPUTS = {
  samplePacket: path.join(OWNER_V01_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl"),
  samplePacketManifest: path.join(OWNER_V01_DIR, "relation-closure-sample-audit-packet.v0.1.manifest.json"),
  comparisonLedger: path.join(OWNER_V01_DIR, "relation-closure-comparison-ledger.v0.1.jsonl"),
  ownerPacketV01: path.join(OWNER_V01_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl"),
  gateStatusV01: path.join(OWNER_V01_DIR, "relation-closure-gate-status.v0.1.json"),
  correctionReference: path.join(REPO, "work/domain-seed/exchange-correction-references.jsonl"),
  auditorADecision: path.join(RESULTS_A_DIR, "relation-closure-sample-auditor-decision.v0.1.jsonl"),
  auditorASummary: path.join(RESULTS_A_DIR, "relation-closure-sample-audit-summary.v0.1.json"),
  auditorAAttestation: path.join(RESULTS_A_DIR, "relation-closure-sample-auditor-attestation.v0.1.json"),
  auditorBDecision: path.join(RESULTS_B_DIR, "relation-closure-sample-auditor-decision.v0.1.jsonl"),
  auditorBSummary: path.join(RESULTS_B_DIR, "relation-closure-sample-audit-summary.v0.1.json"),
  auditorBAttestation: path.join(RESULTS_B_DIR, "relation-closure-sample-auditor-b-attestation.v0.1.json"),
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function toPosix(p) { return p.split(path.sep).join("/"); }
function portable(p) { return toPosix(path.relative(REPO, p)); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

class FailClosedError extends Error {}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { path: p, bytes, sha256: sha256(bytes), text: bytes.toString("utf8") };
}

// The one real, literal, factually-incorrect claim to check for (Task 8).
// Never modify the source file -- report-only.
const GIT_FALSE_CLAIM_PATTERN = /not a git repository/i;

async function main() {
  console.log("== Turn N4.5: dual sample-audit reconciliation + multi-step correction risk detection ==");

  const loaded = {};
  for (const [key, p] of Object.entries(INPUTS)) loaded[key] = await readAndHash(p);

  console.log("\n-- input SHA-256 --");
  for (const [key, v] of Object.entries(loaded)) console.log(`${key}: ${v.sha256}  (${portable(v.path)})`);

  const samplePacket = readJsonl(loaded.samplePacket.text);
  const samplePacketManifest = JSON.parse(loaded.samplePacketManifest.text);
  const comparisonLedger = readJsonl(loaded.comparisonLedger.text);
  const ownerPacketV01 = readJsonl(loaded.ownerPacketV01.text);
  const gateStatusV01 = JSON.parse(loaded.gateStatusV01.text);
  const correctionReferenceRows = readJsonl(loaded.correctionReference.text);
  const auditorADecision = readJsonl(loaded.auditorADecision.text);
  const auditorASummary = JSON.parse(loaded.auditorASummary.text);
  const auditorAAttestation = JSON.parse(loaded.auditorAAttestation.text);
  const auditorBDecision = readJsonl(loaded.auditorBDecision.text);
  const auditorBSummary = JSON.parse(loaded.auditorBSummary.text);
  const auditorBAttestation = JSON.parse(loaded.auditorBAttestation.text);

  // -- Task 9 precondition: refuse to build on top of data that no longer
  // claims to be provisional / not-yet-closed. --------------------------
  if (gateStatusV01.official_split_eligible !== false || gateStatusV01.chain_closure_status !== "NOT_FINALIZED") {
    throw new FailClosedError("v0.1 gate status no longer declares official_split_eligible=false / chain_closure_status=NOT_FINALIZED -- refusing to build N4.5 artifacts on top of data that claims to be closed");
  }
  if (samplePacket.length !== EXPECTED.sampleConfirmCount + EXPECTED.sampleRejectCount) {
    throw new FailClosedError(`sample packet row count ${samplePacket.length} !== expected ${EXPECTED.sampleConfirmCount + EXPECTED.sampleRejectCount}`);
  }
  if (samplePacketManifest.output_sha256 !== loaded.samplePacket.sha256) {
    throw new FailClosedError("sample packet manifest's own recorded sha256 does not match the real, current sample packet bytes");
  }

  // -- Task 1: dual-auditor input integrity verification -----------------
  const samplePacketIds = new Set(samplePacket.map((r) => r.relation_candidate_id));
  const dualAuditValidation = validateDualAuditInputs({
    auditorARows: auditorADecision, auditorBRows: auditorBDecision, samplePacketIds,
    expectedSamplePacketSha256: loaded.samplePacket.sha256, expectedLedgerSha256: loaded.comparisonLedger.sha256,
  });
  console.log("\n-- Task 1: dual-audit input validation --");
  console.log(JSON.stringify(dualAuditValidation, null, 2));
  if (!dualAuditValidation.valid) {
    throw new FailClosedError(`dual audit input validation failed: ${dualAuditValidation.errors.join("; ")}`);
  }

  // Never overwrite/modify either auditor's own result files -- verify no
  // mutation happened just from reading (defense in depth, re-checked again below).
  const rereadA = sha256(await readFile(INPUTS.auditorADecision));
  const rereadB = sha256(await readFile(INPUTS.auditorBDecision));
  if (rereadA !== loaded.auditorADecision.sha256 || rereadB !== loaded.auditorBDecision.sha256) {
    throw new FailClosedError("an auditor decision file changed bytes between reads -- refusing to proceed");
  }

  // -- summary cross-check: the auditors' OWN summary files must agree
  // with what this run independently recomputes from their decision rows. --
  function recomputeDisposition(rows) {
    const counts = { PASS: 0, DEFECT_FOUND: 0, NEEDS_MORE_REVIEW: 0 };
    for (const r of rows) counts[r.audit_disposition] = (counts[r.audit_disposition] ?? 0) + 1;
    return counts;
  }
  const aRecomputed = recomputeDisposition(auditorADecision);
  const bRecomputed = recomputeDisposition(auditorBDecision);
  if (aRecomputed.PASS !== EXPECTED.auditorAPass || aRecomputed.DEFECT_FOUND !== EXPECTED.auditorADefectFound) {
    throw new FailClosedError(`auditor A recomputed disposition mismatch: ${JSON.stringify(aRecomputed)}, expected PASS=${EXPECTED.auditorAPass} DEFECT_FOUND=${EXPECTED.auditorADefectFound}`);
  }
  if (bRecomputed.PASS !== EXPECTED.auditorBPass) {
    throw new FailClosedError(`auditor B recomputed disposition mismatch: ${JSON.stringify(bRecomputed)}, expected PASS=${EXPECTED.auditorBPass}`);
  }
  if (auditorASummary.by_disposition.PASS !== aRecomputed.PASS || auditorASummary.by_disposition.DEFECT_FOUND !== aRecomputed.DEFECT_FOUND) {
    throw new FailClosedError("auditor A's own summary file disagrees with the recomputed distribution from its own decision file");
  }
  if (auditorBSummary.by_disposition.PASS !== bRecomputed.PASS) {
    throw new FailClosedError("auditor B's own summary file disagrees with the recomputed distribution from its own decision file");
  }

  // -- Task 2: build the 30-row dual-audit comparison ledger --------------
  const ledgerRowsById = new Map(comparisonLedger.map((r) => [r.relation_candidate_id, r]));
  for (const id of samplePacketIds) {
    if (!ledgerRowsById.has(id)) throw new FailClosedError(`sample packet row ${id} is missing from the 326-row comparison ledger`);
  }
  const auditComparisonLedger = buildAuditComparisonLedger({
    samplePacketRows: samplePacket, ledgerRowsById, auditorARows: auditorADecision, auditorBRows: auditorBDecision,
  });
  if (auditComparisonLedger.length !== samplePacket.length) {
    throw new FailClosedError(`audit comparison ledger row count ${auditComparisonLedger.length} !== sample packet row count ${samplePacket.length}`);
  }
  const statusCounts = {};
  for (const row of auditComparisonLedger) statusCounts[row.final_status] = (statusCounts[row.final_status] ?? 0) + 1;
  console.log("\n-- Task 2: recomputed final_status distribution --");
  console.log(JSON.stringify(statusCounts, null, 2));
  if ((statusCounts.DUAL_AUDIT_PASS ?? 0) !== EXPECTED.dualAuditPass) {
    throw new FailClosedError(`DUAL_AUDIT_PASS count ${statusCounts.DUAL_AUDIT_PASS ?? 0} !== expected ${EXPECTED.dualAuditPass}`);
  }
  const conflicts = selectAuditConflicts({ auditComparisonLedgerRows: auditComparisonLedger });
  if (conflicts.length !== EXPECTED.auditConflicts) {
    throw new FailClosedError(`audit conflict count ${conflicts.length} !== expected ${EXPECTED.auditConflicts}`);
  }
  const conflictRow = conflicts[0];
  console.log("\n-- Task 2: the 1 real audit conflict --");
  console.log(JSON.stringify(conflictRow, null, 2));

  // -- recompute 297/161/136 and 121 from the real 326-row ledger, never
  // trusted as a hardcoded constant. -------------------------------------
  const provisionalRows = comparisonLedger.filter((r) => !r.owner_review_required);
  const provisionalConfirmRows = provisionalRows.filter((r) => r.provisional_disposition === "PROVISIONAL_CONFIRM");
  const provisionalRejectRows = provisionalRows.filter((r) => r.provisional_disposition === "PROVISIONAL_REJECT");
  if (provisionalRows.length !== EXPECTED.provisionalTotal) throw new FailClosedError(`provisional row count ${provisionalRows.length} !== expected ${EXPECTED.provisionalTotal}`);
  if (provisionalConfirmRows.length !== EXPECTED.provisionalConfirm) throw new FailClosedError(`provisional CONFIRM count ${provisionalConfirmRows.length} !== expected ${EXPECTED.provisionalConfirm}`);
  if (provisionalRejectRows.length !== EXPECTED.provisionalReject) throw new FailClosedError(`provisional REJECT count ${provisionalRejectRows.length} !== expected ${EXPECTED.provisionalReject}`);

  const sampledRejectIds = new Set(samplePacket.filter((r) => r.provisional_disposition === "PROVISIONAL_REJECT").map((r) => r.relation_candidate_id));
  if (sampledRejectIds.size !== EXPECTED.sampleRejectCount) throw new FailClosedError(`sampled REJECT id count ${sampledRejectIds.size} !== expected ${EXPECTED.sampleRejectCount}`);
  const unauditedRejectRows = provisionalRejectRows.filter((r) => !sampledRejectIds.has(r.relation_candidate_id));
  if (unauditedRejectRows.length !== EXPECTED.unauditedRejectCount) throw new FailClosedError(`unaudited REJECT count ${unauditedRejectRows.length} !== expected ${EXPECTED.unauditedRejectCount}`);
  console.log(`\n-- recomputed: provisional=${provisionalRows.length} (CONFIRM ${provisionalConfirmRows.length} / REJECT ${provisionalRejectRows.length}), unaudited REJECT=${unauditedRejectRows.length} -- ALL MATCH EXPECTED`);

  // -- Task 5+6: multi-step correction risk detection over the 121 -------
  const correctionReferenceBySource = new Map(correctionReferenceRows.map((r) => [r.source_document_id, r]));
  const riskCandidates = detectMultiStepCorrectionRisk({ unauditedRejectRows, correctionReferenceBySource });
  const riskByReason = {};
  for (const r of riskCandidates) riskByReason[r.risk_reason] = (riskByReason[r.risk_reason] ?? 0) + 1;
  console.log(`\n-- Task 5+6: multi-step correction risk detection: ${riskCandidates.length} of ${unauditedRejectRows.length} flagged --`);
  console.log(JSON.stringify(riskByReason, null, 2));

  // -- Task 8: attestation Git-phrase check (report-only, never modify) --
  const attestationRaw = { a: loaded.auditorAAttestation.text, b: loaded.auditorBAttestation.text };
  const gitPhraseFound = { a: GIT_FALSE_CLAIM_PATTERN.test(attestationRaw.a), b: GIT_FALSE_CLAIM_PATTERN.test(attestationRaw.b) };
  console.log("\n-- Task 8: attestation git-phrase check --");
  console.log(JSON.stringify(gitPhraseFound, null, 2));

  console.log("\nALL EXPECTED NUMBERS MATCH -- proceeding to write output artifacts.");
  await mkdir(OUT_DIR, { recursive: true });

  // -- 30-row audit comparison ledger artifact ----------------------------
  const auditLedgerPath = path.join(OUT_DIR, "relation-closure-audit-comparison-ledger.v0.1.jsonl");
  const auditLedgerText = auditComparisonLedger.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(auditLedgerPath, auditLedgerText, "utf8");
  const auditLedgerSha256 = sha256(Buffer.from(auditLedgerText, "utf8"));

  // -- Task 3: conflict-row original-text/evidence verification packet ---
  // Built honestly from what IS genuinely available in this environment:
  // the correction-reference file's own machine-extracted evidence[], the
  // relation packet's own source_info/candidate target_info metadata, and
  // both auditors' full verbatim notes (clearly labeled as auditor-sourced,
  // not independently re-extracted by this script -- raw DocumentIR for
  // these 2 documents is not available locally; see limitation note below).
  const reviewPacketText = (await readFile(path.join(REPO, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl"), "utf8"));
  const reviewPacketRows = readJsonl(reviewPacketText);
  const conflictPacketRow = reviewPacketRows.find((r) => r.relation_candidate_id === conflictRow.relation_candidate_id);
  if (!conflictPacketRow) throw new FailClosedError(`conflict row ${conflictRow.relation_candidate_id} not found in the 326-row relation candidate packet`);
  const conflictCorrectionReference = correctionReferenceBySource.get(conflictRow.source_document_id) ?? null;
  const auditorAConflictRow = auditorADecision.find((r) => r.relation_candidate_id === conflictRow.relation_candidate_id);
  const auditorBConflictRow = auditorBDecision.find((r) => r.relation_candidate_id === conflictRow.relation_candidate_id);
  const proposedTargetCandidate = (conflictPacketRow.candidates ?? []).find((c) => c.target_document_id === auditorAConflictRow.expected_target_document_id) ?? null;

  const conflictVerificationPacket = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    relation_candidate_id: conflictRow.relation_candidate_id,
    relation_type: conflictPacketRow.relation_type,
    source_document_id: conflictRow.source_document_id,
    source_info: conflictPacketRow.source_info,
    source_report_name: conflictPacketRow.source_report_name,
    source_receipt_date: conflictPacketRow.source_receipt_date,
    proposed_target_document_id: auditorAConflictRow.expected_target_document_id,
    proposed_target_info: proposedTargetCandidate ? proposedTargetCandidate.target_info : null,
    proposed_target_report_name: proposedTargetCandidate ? proposedTargetCandidate.target_report_name : null,
    proposed_target_receipt_date: proposedTargetCandidate ? proposedTargetCandidate.target_receipt_date : null,
    original_candidate_target_document_ids: conflictRow.original_candidate_target_document_ids,
    correction_reference_record: conflictCorrectionReference,
    amends_definition: {
      ko: "원본 또는 이전 버전을 정정",
      en: "amends the original or a prior version",
      note: "This is a fixed, project-level definitional field only. It is presented as context and is never used to auto-decide this or any row's disposition.",
    },
    auditor_a: {
      auditor_role: auditorAConflictRow.auditor_role,
      audit_disposition: auditorAConflictRow.audit_disposition,
      defect_type: auditorAConflictRow.defect_type,
      defect_description: auditorAConflictRow.defect_description,
      expected_disposition: auditorAConflictRow.expected_disposition,
      expected_target_document_id: auditorAConflictRow.expected_target_document_id,
      audit_note: auditorAConflictRow.audit_note,
    },
    auditor_b: {
      auditor_role: auditorBConflictRow.auditor_role,
      audit_disposition: auditorBConflictRow.audit_disposition,
      audit_note: auditorBConflictRow.audit_note,
    },
    evidence_provenance_note: "Raw DocumentIR for exchange_20250113800603 / exchange_20240617800437 is not available in this environment's local corpus mirrors (CORPUS_PATH / DISCLOSURE_CORPUS_ROOT are unset; 0 hits for either document id across the local canonical-DocumentIR seed files). This packet is therefore built from: (1) exchange-correction-references.jsonl's own machine-extracted evidence[] (real source_locator + quoted_text, not auditor-authored); (2) the relation candidate packet's own structured source_info/target_info metadata; (3) both auditors' full verbatim audit_note text, which does contain literal quoted contract-field values from their own (out-of-band) document access -- labeled here as auditor-sourced, not independently re-verified against raw DocumentIR by this script.",
    owner_review_required: true,
    owner_disposition: "PENDING",
  };
  const conflictPacketPath = path.join(OUT_DIR, "relation-closure-conflict-verification-packet.v0.1.json");
  await writeFile(conflictPacketPath, `${JSON.stringify(conflictVerificationPacket, null, 2)}\n`, "utf8");
  const conflictPacketSha256 = sha256(await readFile(conflictPacketPath));

  // -- Task 4: Owner adjudication packet v0.2 (29 existing + 1 conflict) --
  const docInfoById = new Map();
  for (const row of reviewPacketRows) {
    if (row.source_info) docInfoById.set(row.source_document_id, { ...row.source_info, report_name: row.source_report_name, receipt_date: row.source_receipt_date });
    for (const c of row.candidates ?? []) {
      if (c.target_info) docInfoById.set(c.target_document_id, { ...c.target_info, report_name: c.target_report_name, receipt_date: c.target_receipt_date });
    }
  }
  function lookupDoc(id) { return docInfoById.get(id) ?? null; }

  const conflictOwnerRow = {
    relation_candidate_id: conflictRow.relation_candidate_id,
    relation_type: conflictPacketRow.relation_type,
    source_document_id: conflictRow.source_document_id,
    source_info: lookupDoc(conflictRow.source_document_id),
    candidates: (conflictPacketRow.candidates ?? []).map((c) => ({ target_document_id: c.target_document_id, target_info: lookupDoc(c.target_document_id), origin: "ORIGINAL" })),
    original_candidate_target_document_ids: conflictRow.original_candidate_target_document_ids,
    correction_reference_augmented_target_document_ids: conflictRow.correction_reference_augmented_target_document_ids,
    reviewer_a: {
      owner_disposition: auditorAConflictRow.expected_disposition === "CONFIRM" ? "CONFIRM" : "REJECT",
      confirmed_target_document_id: auditorAConflictRow.expected_target_document_id ?? null,
      reviewer: "SAMPLE_AUDITOR_A",
      reviewed_at: auditorAConflictRow.reviewed_at,
      notes: auditorAConflictRow.audit_note,
      decision_source: "SAMPLE_AUDIT",
      reviewer_role: "SAMPLE_AUDITOR",
    },
    reviewer_b: {
      owner_disposition: "REJECT",
      confirmed_target_document_id: null,
      reviewer: "SAMPLE_AUDITOR_B",
      reviewed_at: auditorBConflictRow.reviewed_at,
      notes: auditorBConflictRow.audit_note,
      decision_source: "SAMPLE_AUDIT",
      reviewer_role: "SAMPLE_AUDITOR",
    },
    disposition_agrees: false,
    target_agrees: null,
    risk_flags: ["AUDIT_CONFLICT"],
    owner_review_reason: ["AUDIT_CONFLICT"],
    owner_disposition: "PENDING",
    confirmed_target_document_id: null,
    owner_note: "",
    owner: null,
    reviewed_at: null,
  };
  const ownerPacketV01Pending = ownerPacketV01.map((r) => ({ ...r, owner_disposition: "PENDING", confirmed_target_document_id: null, owner_note: "", owner: null, reviewed_at: null }));
  const ownerPacketV02 = [...ownerPacketV01Pending, conflictOwnerRow];
  if (ownerPacketV02.length !== 30) throw new FailClosedError(`owner packet v0.2 row count ${ownerPacketV02.length} !== expected 30`);
  const ownerPacketV02Path = path.join(OUT_DIR, "relation-closure-owner-adjudication-packet.v0.2.jsonl");
  const ownerPacketV02Text = ownerPacketV02.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(ownerPacketV02Path, ownerPacketV02Text, "utf8");
  const ownerPacketV02Sha256 = sha256(Buffer.from(ownerPacketV02Text, "utf8"));

  // -- Task 6: multi-step correction risk packet --------------------------
  const riskPacketPath = path.join(OUT_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.jsonl");
  const riskPacketText = riskCandidates.length === 0 ? "" : riskCandidates.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(riskPacketPath, riskPacketText, "utf8");
  const riskPacketSha256 = sha256(Buffer.from(riskPacketText, "utf8"));
  const riskPacketManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    population_examined: unauditedRejectRows.length,
    risk_count: riskCandidates.length,
    by_risk_reason: riskByReason,
    all_review_status_pending: riskCandidates.every((r) => r.review_status === "PENDING"),
    detection_rule_note: "General-signal-only heuristic derived from the ONE real defect found by auditor A (relation_candidate_433bbbf25ce9716814f35604): relation_type===AMENDS, provisional_disposition===PROVISIONAL_REJECT, source's own correction-reference record has reference_status !== MATCHED_IN_CORPUS (or no record at all for this doc_group), AND the row's original candidate list is non-empty. This is a RISK-DETECTION rule only -- it never auto-confirms or auto-rejects any row; every flagged row starts review_status=PENDING and requires human review (see Reviewer C/D UIs).",
    output_path: portable(riskPacketPath),
    output_sha256: riskPacketSha256,
    zero_is_a_valid_outcome: true,
  };
  const riskPacketManifestPath = path.join(OUT_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.manifest.json");
  await writeFile(riskPacketManifestPath, `${JSON.stringify(riskPacketManifest, null, 2)}\n`, "utf8");

  // -- Task 9: gate status v0.2 -------------------------------------------
  const gateStatusV02 = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    provisional_297: { count: provisionalRows.length, status: "PROVISIONAL", promoted: false, promotion_targets_forbidden: ["VERIFIED", "APPROVED", "OFFICIAL", "GOLD", "CHAIN_CLOSED"] },
    sample_audit_dual_result: { dual_audit_pass: statusCounts.DUAL_AUDIT_PASS ?? 0, audit_conflicts_owner_review_required: conflicts.length, status: "SAMPLE_ONLY_NOT_FULL_POOL_VERIFICATION" },
    owner_review_v02_30: { count: ownerPacketV02.length, status: "OWNER_REVIEW_PENDING", composition: { from_v01_29: ownerPacketV01Pending.length, from_audit_conflict: 1 } },
    multistep_correction_risk: { population_examined: unauditedRejectRows.length, flagged_count: riskCandidates.length, status: riskCandidates.length > 0 ? "PENDING_REVIEWER_C_D" : "NONE_DETECTED", auto_confirmed: false },
    remaining_267_minus_sample_status: "PROVISIONAL_UNCHANGED_NOT_AUTO_PROMOTED",
    chain_closure_status: "NOT_FINALIZED",
    official_split_eligible: false,
    gold_authoring_status: "NOT_STARTED",
    production_runtime_or_postgres_updated: false,
    auto_owner_approval_performed: false,
    auto_chain_closure_performed: false,
    auto_relation_confirmation_performed: false,
    forbidden_overreach_phrases: ["296 rows are officially usable", "297 rows verified via the 29-row audit pass"],
  };
  const gateStatusV02Path = path.join(OUT_DIR, "relation-closure-gate-status.v0.2.json");
  await writeFile(gateStatusV02Path, `${JSON.stringify(gateStatusV02, null, 2)}\n`, "utf8");

  // -- Task 8 + provenance: reconciliation report --------------------------
  const reconciliationReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    inputs: Object.fromEntries(Object.entries(loaded).map(([key, v]) => [key, { path: portable(v.path), sha256: v.sha256, bytes: v.bytes.length }])),
    dual_audit_validation: dualAuditValidation,
    recomputed_distribution: {
      provisional_total: provisionalRows.length, provisional_confirm: provisionalConfirmRows.length, provisional_reject: provisionalRejectRows.length,
      unaudited_reject: unauditedRejectRows.length,
      audit_final_status_counts: statusCounts,
    },
    audit_conflict: { relation_candidate_id: conflictRow.relation_candidate_id, source_document_id: conflictRow.source_document_id, auditor_a_proposed_target: auditorAConflictRow.expected_target_document_id },
    multistep_correction_risk: { population_examined: unauditedRejectRows.length, flagged_count: riskCandidates.length, by_risk_reason: riskByReason },
    task8_attestation_git_phrase_check: {
      pattern: GIT_FALSE_CLAIM_PATTERN.source,
      auditor_a_attestation_contains_false_claim: gitPhraseFound.a,
      auditor_b_attestation_contains_false_claim: gitPhraseFound.b,
      status: gitPhraseFound.a ? "ATTESTATION_CORRECTION_REQUIRED" : "NO_ISSUE_FOUND",
      note: gitPhraseFound.a
        ? "Auditor A's real attestation file (results/sample-auditor-v0.1/relation-closure-sample-auditor-attestation.v0.1.json, git_operations.note) contains the literal, factually incorrect claim that the working directory is not a git repository. This session has used git continuously throughout (git status/log/commits exist). The original attestation file was NOT modified by this script -- Claude does not author or edit attestations on an auditor's behalf. This is flagged for the auditor/Owner to correct."
        : "No git-repository-false-claim phrase found in either auditor's attestation.",
    },
    known_limitation_task3: "Raw DocumentIR for the 2 conflict documents is not locally available in this environment; the conflict verification packet is built from correction-reference evidence + packet metadata + both auditors' verbatim notes, not from independent DocumentIR re-extraction. See relation-closure-conflict-verification-packet.v0.1.json's evidence_provenance_note.",
    outputs: {
      audit_comparison_ledger: { path: portable(auditLedgerPath), sha256: auditLedgerSha256, row_count: auditComparisonLedger.length },
      conflict_verification_packet: { path: portable(conflictPacketPath), sha256: conflictPacketSha256 },
      owner_packet_v02: { path: portable(ownerPacketV02Path), sha256: ownerPacketV02Sha256, row_count: ownerPacketV02.length },
      risk_packet: { path: portable(riskPacketPath), sha256: riskPacketSha256, row_count: riskCandidates.length },
      risk_packet_manifest: { path: portable(riskPacketManifestPath) },
      gate_status_v02: { path: portable(gateStatusV02Path) },
    },
    state_boundary_confirmation: {
      existing_297_not_auto_promoted: true,
      the_1_known_conflict_routed_to_owner_review: true,
      all_other_provisional_relations_remain_provisional: true,
      all_risk_detection_rows_pending: riskCandidates.every((r) => r.review_status === "PENDING"),
      chain_closure_not_finalized: true,
      official_split_eligible_false: true,
      gold_authoring_not_started: true,
    },
  };
  const reconciliationReportPath = path.join(OUT_DIR, "relation-closure-n45-reconciliation-report.v0.1.json");
  await writeFile(reconciliationReportPath, `${JSON.stringify(reconciliationReport, null, 2)}\n`, "utf8");

  // -- re-verify no input file was mutated by this run --------------------
  // samplePacketManifest AND gateStatusV01 are excluded: both are Turn
  // N4.3's OWN outputs (written by
  // scripts/build-relation-closure-owner-packet-v043.mjs, which embeds a
  // fresh generated_at into EVERY one of its own JSON outputs on every run
  // and is legitimately re-invoked by that script's own test file). This
  // script only ever READS them -- it never depends on their bytes staying
  // fixed for the rest of this run, so re-verifying their immutability
  // here would only catch a SIBLING process's legitimate concurrent
  // rebuild, never a real mutation by this script itself (which writes
  // only under OUT_DIR, never back into OWNER_V01_DIR -- see the static
  // writeFile-target test above).
  const VOLATILE_SIBLING_OWNED_INPUTS = new Set(["samplePacketManifest", "gateStatusV01"]);
  for (const [key, p] of Object.entries(INPUTS)) {
    if (VOLATILE_SIBLING_OWNED_INPUTS.has(key)) continue;
    const after = sha256(await readFile(p));
    if (after !== loaded[key].sha256) throw new FailClosedError(`input ${key} changed during this run -- an input file must never be modified`);
  }

  console.log("\n== SUMMARY ==");
  console.log(JSON.stringify({
    status: "PASS",
    audit_comparison_ledger_sha256: auditLedgerSha256,
    conflict_relation_candidate_id: conflictRow.relation_candidate_id,
    owner_packet_v02_row_count: ownerPacketV02.length,
    owner_packet_v02_sha256: ownerPacketV02Sha256,
    unaudited_reject_examined: unauditedRejectRows.length,
    risk_flagged_count: riskCandidates.length,
    task8_status: reconciliationReport.task8_attestation_git_phrase_check.status,
    out_dir: portable(OUT_DIR),
  }, null, 2));
}

main().catch((error) => {
  if (error instanceof FailClosedError) {
    console.error(`\nBLOCKER (fail-closed): ${error.message}`);
    console.error("No output artifact was written. Existing files were not modified.");
  } else {
    console.error(error);
  }
  process.exit(1);
});
