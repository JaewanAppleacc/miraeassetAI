#!/usr/bin/env node
// Turn N4.3: integrates Reviewer A/B's independent 326-row relation-closure
// decisions plus each reviewer's 29-row remediation delta into one
// comparison ledger, selects the 29-row Owner-review union, marks the
// remaining 297 rows PROVISIONAL only, and draws a deterministic 30-row
// stratified low-risk sample for a separate audit pass. Fails closed
// before writing ANY output if the recomputed distribution does not
// exactly match the numbers the task was scoped against -- this script
// never trusts a hardcoded expectation over the real input files; it
// treats a mismatch as a stop condition, not something to reconcile.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRemediationOverlay, buildComparisonLedger, selectOwnerReviewSet,
  selectProvisionalSet, selectStratifiedSample,
} from "../domain/evaluation/relation-closure-integration.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_DIR = path.join(REPO, "work/handoff/anchor-dev-tune-v0.1");
const OUT_DIR = path.join(PACKET_DIR, "owner-adjudication-v0.1");

const PINNED_PACKET_SHA256 = "a13fabe71f38868f4068bae1fe2dfd289b6b86190279b2c884fc003434755acd";

const EXPECTED = Object.freeze({
  total: 326, bothConfirm: 170, bothReject: 142, bothNeedsMoreReview: 1,
  disagree: 13, terminates: 16, ownerUnion: 29, provisional: 297,
  remediationRowsPerReviewer: 29,
});

const INPUTS = {
  packet: path.join(PACKET_DIR, "relation-closure-review-packet.v0.1.jsonl"),
  aBase: path.join(PACKET_DIR, "relation-closure-reviewer-a-decision.v0.1.jsonl"),
  bBase: path.join(PACKET_DIR, "relation-closure-reviewer-b-decision.v0.1.jsonl"),
  aRem: path.join(PACKET_DIR, "relation-closure-reviewer-a-remediation-decision.v0.1.jsonl"),
  bRem: path.join(PACKET_DIR, "relation-closure-reviewer-b-remediation-decision.v0.1.jsonl"),
  aAttestation: path.join(PACKET_DIR, "relation-closure-reviewer-a-attestation.v0.1.json"),
  bAttestation: path.join(PACKET_DIR, "relation-closure-reviewer-b-attestation.v0.1.json"),
  correctionReference: path.join(REPO, "work/domain-seed/exchange-correction-references.jsonl"),
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function toPosix(p) { return p.split(path.sep).join("/"); }
function portableRelativeTo(root, target) { return toPosix(path.relative(root, target)); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

class FailClosedError extends Error {}

async function readAndHash(p) {
  const bytes = await readFile(p);
  return { path: p, bytes, sha256: sha256(bytes), text: bytes.toString("utf8") };
}

async function main() {
  console.log("== Turn N4.3: relation closure integration + Owner adjudication packet ==");

  const loaded = {};
  for (const [key, p] of Object.entries(INPUTS)) loaded[key] = await readAndHash(p);

  console.log("\n-- input SHA-256 --");
  for (const [key, v] of Object.entries(loaded)) console.log(`${key}: ${v.sha256}  (${portableRelativeTo(REPO, v.path)})`);

  if (loaded.packet.sha256 !== PINNED_PACKET_SHA256) {
    throw new FailClosedError(`packet sha256 mismatch: actual ${loaded.packet.sha256}, pinned ${PINNED_PACKET_SHA256}`);
  }

  const packet = readJsonl(loaded.packet.text);
  const aBase = readJsonl(loaded.aBase.text);
  const bBase = readJsonl(loaded.bBase.text);
  const aRem = readJsonl(loaded.aRem.text);
  const bRem = readJsonl(loaded.bRem.text);
  const aAttestation = JSON.parse(loaded.aAttestation.text);
  const bAttestation = JSON.parse(loaded.bAttestation.text);

  if (packet.length !== EXPECTED.total) throw new FailClosedError(`packet row count ${packet.length} !== expected ${EXPECTED.total}`);
  if (aBase.length !== EXPECTED.total) throw new FailClosedError(`reviewer A base decision row count ${aBase.length} !== expected ${EXPECTED.total}`);
  if (bBase.length !== EXPECTED.total) throw new FailClosedError(`reviewer B base decision row count ${bBase.length} !== expected ${EXPECTED.total}`);
  if (aRem.length !== EXPECTED.remediationRowsPerReviewer) throw new FailClosedError(`reviewer A remediation row count ${aRem.length} !== expected ${EXPECTED.remediationRowsPerReviewer}`);
  if (bRem.length !== EXPECTED.remediationRowsPerReviewer) throw new FailClosedError(`reviewer B remediation row count ${bRem.length} !== expected ${EXPECTED.remediationRowsPerReviewer}`);

  // Cross-check each attestation/remediation file's OWN cited provenance
  // pins against what this run independently just re-hashed -- this is
  // stronger than trusting the files' internal claims at face value.
  const remCitedSha = { a: new Set(aRem.map((r) => r.source_packet_sha256)), b: new Set(bRem.map((r) => r.source_packet_sha256)) };
  if (remCitedSha.a.size !== 1 || !remCitedSha.a.has(loaded.packet.sha256)) throw new FailClosedError(`reviewer A remediation rows do not uniformly cite the real, current packet sha256 (cited: ${[...remCitedSha.a].join(",")})`);
  if (remCitedSha.b.size !== 1 || !remCitedSha.b.has(loaded.packet.sha256)) throw new FailClosedError(`reviewer B remediation rows do not uniformly cite the real, current packet sha256 (cited: ${[...remCitedSha.b].join(",")})`);
  const remCitedBaseSha = { a: new Set(aRem.map((r) => r.base_decision_sha256)), b: new Set(bRem.map((r) => r.base_decision_sha256)) };
  if (remCitedBaseSha.a.size !== 1 || !remCitedBaseSha.a.has(loaded.aBase.sha256)) throw new FailClosedError(`reviewer A remediation rows do not uniformly cite the real, current A base-decision sha256`);
  if (remCitedBaseSha.b.size !== 1 || !remCitedBaseSha.b.has(loaded.bBase.sha256)) throw new FailClosedError(`reviewer B remediation rows do not uniformly cite the real, current B base-decision sha256`);

  // -- reviewer-identity label check. A KNOWN, user-confirmed anomaly:
  // relation-closure-reviewer-b-decision.v0.1.jsonl's own `reviewer` field
  // says REVIEWER_AGENT_A on every row (a label bug in that one base
  // file -- content/SHA/13-row disagreement already prove it is NOT a
  // copy of A's file). Explicitly allow ONLY this exact known pattern;
  // fail closed on anything else, since that would be a genuinely new,
  // unreviewed anomaly. ------------------------------------------------
  function reviewerLabelValues(rows) { return [...new Set(rows.map((r) => r.reviewer))]; }
  const aBaseLabels = reviewerLabelValues(aBase);
  const bBaseLabels = reviewerLabelValues(bBase);
  const knownAnomaly = { field: "relation-closure-reviewer-b-decision.v0.1.jsonl:reviewer", expected: "REVIEWER_AGENT_B", actual: "REVIEWER_AGENT_A", status: "KNOWN_LABEL_BUG_CONFIRMED_BY_USER_2026-08-23", note: "File content (SHA, size, 13-row disagreement vs A) independently proves this is a genuinely separate review, not a copy of A's file. The reviewer_role is derived in this ledger from the SOURCE FILE PATH, never from this mislabeled field." };
  if (aBaseLabels.length !== 1 || aBaseLabels[0] !== "REVIEWER_AGENT_A") {
    throw new FailClosedError(`reviewer A base decision file has unexpected reviewer label(s): ${JSON.stringify(aBaseLabels)}`);
  }
  if (!(bBaseLabels.length === 1 && bBaseLabels[0] === "REVIEWER_AGENT_A")) {
    throw new FailClosedError(`reviewer B base decision file's reviewer label does not match the one already-reviewed known anomaly (REVIEWER_AGENT_A on every row); found: ${JSON.stringify(bBaseLabels)} -- refusing to proceed on an unreviewed provenance anomaly`);
  }
  console.log("\n-- known anomaly confirmed (and ONLY this exact anomaly) --");
  console.log(JSON.stringify(knownAnomaly, null, 2));

  const packetIds = new Set(packet.map((r) => r.relation_candidate_id));

  const aOverlay = applyRemediationOverlay({ baseDecisions: aBase, remediationDecisions: aRem, packetIds });
  if (!aOverlay.ok) throw new FailClosedError(`reviewer A overlay failed: ${aOverlay.errors.join("; ")}`);
  const bOverlay = applyRemediationOverlay({ baseDecisions: bBase, remediationDecisions: bRem, packetIds });
  if (!bOverlay.ok) throw new FailClosedError(`reviewer B overlay failed: ${bOverlay.errors.join("; ")}`);

  const aRemAppliedCount = [...aOverlay.finalById.values()].filter((v) => v.source === "REMEDIATION").length;
  const bRemAppliedCount = [...bOverlay.finalById.values()].filter((v) => v.source === "REMEDIATION").length;
  if (aRemAppliedCount !== EXPECTED.remediationRowsPerReviewer) throw new FailClosedError(`reviewer A overlay applied ${aRemAppliedCount} remediation rows, expected ${EXPECTED.remediationRowsPerReviewer}`);
  if (bRemAppliedCount !== EXPECTED.remediationRowsPerReviewer) throw new FailClosedError(`reviewer B overlay applied ${bRemAppliedCount} remediation rows, expected ${EXPECTED.remediationRowsPerReviewer}`);

  const ledgerRows = buildComparisonLedger({ packetRows: packet, aFinalById: aOverlay.finalById, bFinalById: bOverlay.finalById });
  if (ledgerRows.length !== EXPECTED.total) throw new FailClosedError(`ledger row count ${ledgerRows.length} !== expected ${EXPECTED.total}`);
  const ledgerIdDupCount = ledgerRows.length - new Set(ledgerRows.map((r) => r.relation_candidate_id)).size;
  if (ledgerIdDupCount > 0) throw new FailClosedError(`ledger contains ${ledgerIdDupCount} duplicate relation_candidate_id`);

  // -- recompute the full distribution independently and compare against
  // EVERY expected number. ANY mismatch halts before writing output. ----
  let bothConfirm = 0; let bothReject = 0; let bothNeedsMoreReview = 0; let disagree = 0; let terminates = 0;
  for (const row of ledgerRows) {
    if (row.relation_type === "TERMINATES") terminates++;
    if (!row.owner_review_required || row.provisional_disposition !== "NEEDS_MORE_REVIEW") {
      if (row.disposition_agrees && row.reviewer_a.owner_disposition === "CONFIRM" && row.target_agrees) bothConfirm++;
      else if (row.disposition_agrees && row.reviewer_a.owner_disposition === "REJECT") bothReject++;
    }
    if (row.disposition_agrees && row.reviewer_a.owner_disposition === "NEEDS_MORE_REVIEW") bothNeedsMoreReview++;
    if (!row.disposition_agrees || (row.disposition_agrees && row.reviewer_a.owner_disposition === "CONFIRM" && row.target_agrees === false)) disagree++;
  }
  const owner = selectOwnerReviewSet({ ledgerRows });
  const provisional = selectProvisionalSet({ ledgerRows });

  const actual = { total: ledgerRows.length, bothConfirm, bothReject, bothNeedsMoreReview, disagree, terminates, ownerUnion: owner.count, provisional: provisional.count };
  console.log("\n-- expected vs actual distribution --");
  const mismatches = [];
  for (const key of Object.keys(EXPECTED)) {
    if (key === "remediationRowsPerReviewer") continue;
    const exp = EXPECTED[key]; const act = actual[key];
    const ok = exp === act;
    console.log(`${key}: expected=${exp} actual=${act} ${ok ? "OK" : "MISMATCH"}`);
    if (!ok) mismatches.push({ key, expected: exp, actual: act });
  }
  if (mismatches.length > 0) {
    throw new FailClosedError(`distribution mismatch on ${mismatches.length} field(s): ${JSON.stringify(mismatches)} -- refusing to write any output artifact`);
  }
  if (bothConfirm + bothReject + bothNeedsMoreReview + disagree !== EXPECTED.total) {
    throw new FailClosedError("internal consistency check failed: bothConfirm+bothReject+bothNeedsMoreReview+disagree does not sum to total");
  }
  if (owner.count + provisional.count !== EXPECTED.total) {
    throw new FailClosedError("internal consistency check failed: ownerUnion+provisional does not sum to total");
  }

  console.log("\nALL EXPECTED NUMBERS MATCH -- proceeding to write output artifacts.");

  // -- packet info for stratified sampling (company/doc-subtype/augmentation) --
  const packetInfoById = new Map(packet.map((r) => [r.relation_candidate_id, {
    corp_code: r.source_info?.corp_code ?? null,
    listed_name: r.source_info?.listed_name ?? null,
    doc_group: r.source_info?.doc_group ?? null,
    doc_subtype: r.source_info?.doc_subtype ?? null,
  }]));

  const sample = selectStratifiedSample({ ledgerRows, packetInfoById, perBucket: 15, salt: "n4.3-sample-audit-v0.1" });
  if (sample.confirmIds.length !== 15 || sample.rejectIds.length !== 15) {
    throw new FailClosedError(`stratified sample did not produce exactly 15+15 (got ${sample.confirmIds.length}+${sample.rejectIds.length})`);
  }

  // -- global document metadata index (for Owner UI display only) -- every
  // document that ever appears as a source_document_id OR a candidate
  // target_document_id anywhere in the 326-row packet gets its info
  // recorded once, so a remediation-augmented candidate (never itself a
  // packet row's own candidates[] entry) can still often be looked up if
  // it happens to appear as a source or candidate elsewhere in the packet.
  const docInfoById = new Map();
  for (const row of packet) {
    if (row.source_info) docInfoById.set(row.source_document_id, { ...row.source_info, report_name: row.source_report_name, receipt_date: row.source_receipt_date });
    for (const c of row.candidates) {
      if (c.target_info) docInfoById.set(c.target_document_id, { ...c.target_info, report_name: c.target_report_name, receipt_date: c.target_receipt_date });
    }
  }
  function lookupDoc(id) { return docInfoById.get(id) ?? null; }

  await mkdir(OUT_DIR, { recursive: true });

  // -- 326-row comparison ledger --------------------------------------
  function withReviewerRole(reviewerBlock, role) {
    return { ...reviewerBlock, reviewer_role: role };
  }
  const ledgerOut = ledgerRows.map((row) => ({
    ...row,
    reviewer_a: withReviewerRole(row.reviewer_a, "REVIEWER_A"),
    reviewer_b: withReviewerRole(row.reviewer_b, "REVIEWER_B"),
  }));
  const ledgerPath = path.join(OUT_DIR, "relation-closure-comparison-ledger.v0.1.jsonl");
  const ledgerText = ledgerOut.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(ledgerPath, ledgerText, "utf8");
  const ledgerSha256 = sha256(Buffer.from(ledgerText, "utf8"));

  // -- 29-row Owner adjudication packet (PENDING template) -------------
  const ownerRowsById = new Map(ledgerOut.filter((r) => r.owner_review_required).map((r) => [r.relation_candidate_id, r]));
  const ownerPacket = owner.ids.map((id) => {
    const row = ownerRowsById.get(id);
    const augmented = row.correction_reference_augmented_target_document_ids ?? [];
    const candidates = [
      ...row.original_candidate_target_document_ids.map((tid) => ({ target_document_id: tid, target_info: lookupDoc(tid), origin: "ORIGINAL" })),
      ...augmented.map((tid) => ({ target_document_id: tid, target_info: lookupDoc(tid), origin: "CORRECTION_REFERENCE_AUGMENTED" })),
    ];
    return {
      relation_candidate_id: row.relation_candidate_id,
      relation_type: row.relation_type,
      source_document_id: row.source_document_id,
      source_info: lookupDoc(row.source_document_id),
      candidates,
      original_candidate_target_document_ids: row.original_candidate_target_document_ids,
      correction_reference_augmented_target_document_ids: row.correction_reference_augmented_target_document_ids,
      reviewer_a: row.reviewer_a,
      reviewer_b: row.reviewer_b,
      disposition_agrees: row.disposition_agrees,
      target_agrees: row.target_agrees,
      risk_flags: row.risk_flags,
      owner_review_reason: row.owner_review_reason,
      owner_disposition: "PENDING",
      confirmed_target_document_id: null,
      owner_note: "",
      owner: null,
      reviewed_at: null,
    };
  });
  const ownerPacketPath = path.join(OUT_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl");
  const ownerPacketText = ownerPacket.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(ownerPacketPath, ownerPacketText, "utf8");
  const ownerPacketSha256 = sha256(Buffer.from(ownerPacketText, "utf8"));

  // -- 30-row stratified sample audit packet (PENDING template) --------
  const ledgerById = new Map(ledgerOut.map((r) => [r.relation_candidate_id, r]));
  function sampleRow(id, expectedDisposition) {
    const row = ledgerById.get(id);
    const info = packetInfoById.get(id);
    return {
      relation_candidate_id: row.relation_candidate_id,
      relation_type: row.relation_type,
      source_document_id: row.source_document_id,
      corp_code: info.corp_code, listed_name: info.listed_name, doc_group: info.doc_group, doc_subtype: info.doc_subtype,
      used_correction_reference: row.correction_reference_augmented_target_document_ids !== null,
      provisional_disposition: row.provisional_disposition,
      expected_disposition_family: expectedDisposition,
      consensus: row.consensus,
      reviewer_a: row.reviewer_a,
      reviewer_b: row.reviewer_b,
      sample_disposition: "PENDING",
      defect_type: null,
      defect_possible_impact_scope: null,
      auditor_note: "",
      auditor: null,
      reviewed_at: null,
    };
  }
  const samplePacket = [
    ...sample.confirmIds.map((id) => sampleRow(id, "PROVISIONAL_CONFIRM")),
    ...sample.rejectIds.map((id) => sampleRow(id, "PROVISIONAL_REJECT")),
  ];
  const samplePacketPath = path.join(OUT_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl");
  const samplePacketText = samplePacket.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(samplePacketPath, samplePacketText, "utf8");
  const samplePacketSha256 = sha256(Buffer.from(samplePacketText, "utf8"));

  const samplePacketManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    sample_size: samplePacket.length,
    confirm_count: sample.confirmIds.length,
    reject_count: sample.rejectIds.length,
    provisional_pool_size: provisional.count,
    selection_rule: {
      description: "Deterministic stratified sample of the 297 low-risk PROVISIONAL rows: exactly 15 PROVISIONAL_CONFIRM + 15 PROVISIONAL_REJECT, walked in SHA-256(salt + relation_candidate_id) order, preferring the least-already-used (relation_type, corp_code, doc_subtype, correction-reference-usage) stratum at each pick so selection spreads across companies/doc types rather than clustering.",
      salt: "n4.3-sample-audit-v0.1",
      per_bucket: 15,
    },
    strata_distribution: sample.strataDistribution,
    sample_ids: sample.ids,
    output_path: portableRelativeTo(REPO, samplePacketPath),
    output_sha256: samplePacketSha256,
    scope_note: "This 30-row sample is an INDEPENDENT AUDIT CHECK on the 297 low-risk provisional rows, not a re-review of all 297 and not merged with the 29-row Owner adjudication packet. A defect found here does NOT auto-approve or auto-reject the remaining 267 rows -- see relation-closure-gate-status.v0.1.json.",
  };
  const samplePacketManifestPath = path.join(OUT_DIR, "relation-closure-sample-audit-packet.v0.1.manifest.json");
  await writeFile(samplePacketManifestPath, `${JSON.stringify(samplePacketManifest, null, 2)}\n`, "utf8");

  // -- overlay provenance report ----------------------------------------
  const provenanceReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    inputs: Object.fromEntries(Object.entries(loaded).map(([key, v]) => [key, { path: portableRelativeTo(REPO, v.path), sha256: v.sha256, bytes: v.bytes.length }])),
    pinned_packet_sha256: PINNED_PACKET_SHA256,
    packet_sha256_matches_pin: loaded.packet.sha256 === PINNED_PACKET_SHA256,
    remediation_cited_packet_sha256_matches_real: { a: [...remCitedSha.a][0] === loaded.packet.sha256, b: [...remCitedSha.b][0] === loaded.packet.sha256 },
    remediation_cited_base_sha256_matches_real: { a: [...remCitedBaseSha.a][0] === loaded.aBase.sha256, b: [...remCitedBaseSha.b][0] === loaded.bBase.sha256 },
    known_provenance_anomaly: knownAnomaly,
    overlay: {
      reviewer_a: { base_rows: aBase.length, remediation_rows_applied: aRemAppliedCount, base_rows_unchanged: aBase.length - aRemAppliedCount },
      reviewer_b: { base_rows: bBase.length, remediation_rows_applied: bRemAppliedCount, base_rows_unchanged: bBase.length - bRemAppliedCount },
      independence_note: "Reviewer A's overlay was computed ONLY from relation-closure-reviewer-a-decision.v0.1.jsonl + relation-closure-reviewer-a-remediation-decision.v0.1.jsonl; Reviewer B's overlay ONLY from the -b- files. applyRemediationOverlay() takes exactly one reviewer's base+remediation pair per call -- there is no code path by which A's remediation could apply to a B row or vice versa.",
    },
    distribution: actual,
    expected_distribution: EXPECTED,
    distribution_matches_expected: mismatches.length === 0,
    attestations_read: {
      a: { attestation_id: aAttestation.attestation_id, reviewer: aAttestation.reviewer, reviewer_role: aAttestation.reviewer_role },
      b: { attestation_id: bAttestation.attestation_id, reviewer: bAttestation.reviewer, reviewer_role: bAttestation.reviewer_role },
    },
    outputs: {}, // filled in below after gate status is written
  };

  // -- ledger manifest / verification report ----------------------------
  const ledgerManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    row_count: ledgerOut.length,
    output_path: portableRelativeTo(REPO, ledgerPath),
    output_sha256: ledgerSha256,
    input_pins: {
      packet_path: portableRelativeTo(REPO, INPUTS.packet), packet_sha256: loaded.packet.sha256,
      reviewer_a_base_path: portableRelativeTo(REPO, INPUTS.aBase), reviewer_a_base_sha256: loaded.aBase.sha256,
      reviewer_b_base_path: portableRelativeTo(REPO, INPUTS.bBase), reviewer_b_base_sha256: loaded.bBase.sha256,
      reviewer_a_remediation_path: portableRelativeTo(REPO, INPUTS.aRem), reviewer_a_remediation_sha256: loaded.aRem.sha256,
      reviewer_b_remediation_path: portableRelativeTo(REPO, INPUTS.bRem), reviewer_b_remediation_sha256: loaded.bRem.sha256,
    },
    verification: { expected: EXPECTED, actual, all_match: mismatches.length === 0 },
    owner_review_selection: { count: owner.count, by_reason: owner.byReason, multi_reason_rows: owner.multiReasonRows },
    provisional_selection: { count: provisional.count, by_disposition: provisional.byDisposition },
  };
  const ledgerManifestPath = path.join(OUT_DIR, "relation-closure-comparison-ledger.v0.1.manifest.json");
  await writeFile(ledgerManifestPath, `${JSON.stringify(ledgerManifest, null, 2)}\n`, "utf8");

  // -- gate status --------------------------------------------------------
  const gateStatus = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    provisional_297: { count: provisional.count, status: "PROVISIONAL", promoted: false, promotion_targets_forbidden: ["VERIFIED", "APPROVED", "OFFICIAL", "GOLD", "CHAIN_CLOSED"] },
    owner_review_29: { count: owner.count, status: "OWNER_REVIEW_PENDING" },
    chain_closure_status: "NOT_FINALIZED",
    official_split_eligible: false,
    gold_authoring_status: "NOT_STARTED",
    production_runtime_or_postgres_updated: false,
    auto_owner_approval_performed: false,
    auto_chain_closure_performed: false,
  };
  const gateStatusPath = path.join(OUT_DIR, "relation-closure-gate-status.v0.1.json");
  await writeFile(gateStatusPath, `${JSON.stringify(gateStatus, null, 2)}\n`, "utf8");

  provenanceReport.outputs = {
    ledger: { path: portableRelativeTo(REPO, ledgerPath), sha256: ledgerSha256, row_count: ledgerOut.length },
    ledger_manifest: { path: portableRelativeTo(REPO, ledgerManifestPath) },
    owner_packet: { path: portableRelativeTo(REPO, ownerPacketPath), sha256: ownerPacketSha256, row_count: ownerPacket.length },
    sample_packet: { path: portableRelativeTo(REPO, samplePacketPath), sha256: samplePacketSha256, row_count: samplePacket.length },
    sample_manifest: { path: portableRelativeTo(REPO, samplePacketManifestPath) },
    gate_status: { path: portableRelativeTo(REPO, gateStatusPath) },
  };
  const provenanceReportPath = path.join(OUT_DIR, "relation-closure-overlay-provenance-report.v0.1.json");
  await writeFile(provenanceReportPath, `${JSON.stringify(provenanceReport, null, 2)}\n`, "utf8");

  // -- re-verify no input file was mutated by this run -------------------
  for (const [key, p] of Object.entries(INPUTS)) {
    const after = sha256(await readFile(p));
    if (after !== loaded[key].sha256) throw new FailClosedError(`input ${key} changed during this run (before ${loaded[key].sha256}, after ${after}) -- an input file must never be modified`);
  }

  console.log("\n== SUMMARY ==");
  console.log(JSON.stringify({
    status: "PASS",
    ledger_row_count: ledgerOut.length,
    ledger_sha256: ledgerSha256,
    owner_packet_row_count: ownerPacket.length,
    owner_packet_sha256: ownerPacketSha256,
    sample_packet_row_count: samplePacket.length,
    sample_packet_sha256: samplePacketSha256,
    distribution: actual,
    out_dir: portableRelativeTo(REPO, OUT_DIR),
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
