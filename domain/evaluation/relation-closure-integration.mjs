// Turn N4.3: pure logic for integrating Reviewer A/B's independent 326-row
// relation-closure decisions (plus each reviewer's 29-row remediation
// delta) into one comparison ledger, selecting the Owner-review union, and
// drawing a deterministic stratified low-risk sample. No filesystem
// access anywhere in this module -- every function takes plain data in
// and returns plain data out, so it can be unit-tested without touching
// the real corpus/decision files (see scripts/build-relation-closure-owner-packet-v043.mjs
// for the fail-closed orchestration that actually reads/writes files).
import { createHash } from "node:crypto";

export const OWNER_REVIEW_REASONS = Object.freeze({
  DISAGREEMENT: "DISAGREEMENT",
  BOTH_NEEDS_MORE_REVIEW: "BOTH_NEEDS_MORE_REVIEW",
  TERMINATES: "TERMINATES",
});

export const PROVISIONAL_DISPOSITIONS = Object.freeze({
  PROVISIONAL_CONFIRM: "PROVISIONAL_CONFIRM",
  PROVISIONAL_REJECT: "PROVISIONAL_REJECT",
  OWNER_REVIEW_REQUIRED: "OWNER_REVIEW_REQUIRED",
  NEEDS_MORE_REVIEW: "NEEDS_MORE_REVIEW",
});

const VALID_DISPOSITIONS = new Set(["CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"]);

// Overlays a reviewer's 29-row remediation delta on top of their own
// 326-row base decisions, keyed by relation_candidate_id. Rows with no
// remediation entry keep their base decision exactly. Never reads the
// OTHER reviewer's files -- the caller must pass base/remediation from
// the SAME reviewer, and packetIds establishes the only universe a
// remediation id is allowed to reference.
export function applyRemediationOverlay({ baseDecisions, remediationDecisions, packetIds }) {
  const errors = [];
  const baseIds = baseDecisions.map((r) => r.relation_candidate_id);
  const baseDupCount = baseIds.length - new Set(baseIds).size;
  if (baseDupCount > 0) errors.push(`base decisions contain ${baseDupCount} duplicate relation_candidate_id value(s)`);

  const remIds = remediationDecisions.map((r) => r.relation_candidate_id);
  const remDupCount = remIds.length - new Set(remIds).size;
  if (remDupCount > 0) errors.push(`remediation decisions contain ${remDupCount} duplicate relation_candidate_id value(s)`);

  const baseIdSet = new Set(baseIds);
  const missingFromBase = remediationDecisions.filter((r) => !baseIdSet.has(r.relation_candidate_id));
  if (missingFromBase.length > 0) {
    errors.push(`${missingFromBase.length} remediation row(s) reference a relation_candidate_id not present in this reviewer's own base decisions: ${missingFromBase.slice(0, 5).map((r) => r.relation_candidate_id).join(", ")}`);
  }

  const notInPacket = remediationDecisions.filter((r) => !packetIds.has(r.relation_candidate_id));
  if (notInPacket.length > 0) {
    errors.push(`${notInPacket.length} remediation row(s) reference a relation_candidate_id not present in the source packet: ${notInPacket.slice(0, 5).map((r) => r.relation_candidate_id).join(", ")}`);
  }

  for (const r of baseDecisions) {
    if (!VALID_DISPOSITIONS.has(r.owner_disposition)) errors.push(`base decision ${r.relation_candidate_id} has invalid owner_disposition: ${JSON.stringify(r.owner_disposition)}`);
  }
  for (const r of remediationDecisions) {
    if (!VALID_DISPOSITIONS.has(r.owner_disposition)) errors.push(`remediation decision ${r.relation_candidate_id} has invalid owner_disposition: ${JSON.stringify(r.owner_disposition)}`);
  }

  if (errors.length > 0) return { ok: false, errors, finalById: null };

  const remBysId = new Map(remediationDecisions.map((r) => [r.relation_candidate_id, r]));
  const finalById = new Map();
  for (const base of baseDecisions) {
    const rem = remBysId.get(base.relation_candidate_id);
    if (rem) {
      finalById.set(base.relation_candidate_id, {
        owner_disposition: rem.owner_disposition,
        confirmed_target_document_id: rem.confirmed_target_document_id,
        reviewer: rem.reviewer,
        reviewed_at: rem.reviewed_at,
        notes: rem.notes,
        source: "REMEDIATION",
        considered_target_document_ids: rem.considered_target_document_ids ?? [],
      });
    } else {
      finalById.set(base.relation_candidate_id, {
        owner_disposition: base.owner_disposition,
        confirmed_target_document_id: base.confirmed_target_document_id,
        reviewer: base.reviewer,
        reviewed_at: base.reviewed_at,
        notes: base.notes,
        source: "BASE",
        considered_target_document_ids: [],
      });
    }
  }
  return { ok: true, errors: [], finalById };
}

function classifyRow({ relationType, a, b }) {
  const dispositionAgrees = a.owner_disposition === b.owner_disposition;
  const targetAgrees = dispositionAgrees && a.owner_disposition === "CONFIRM"
    ? a.confirmed_target_document_id === b.confirmed_target_document_id
    : null;
  const isDisagreement = !dispositionAgrees || (dispositionAgrees && a.owner_disposition === "CONFIRM" && targetAgrees === false);
  const isBothNeedsMoreReview = dispositionAgrees && a.owner_disposition === "NEEDS_MORE_REVIEW";
  const isTerminates = relationType === "TERMINATES";

  const reasons = [];
  if (isTerminates) reasons.push(OWNER_REVIEW_REASONS.TERMINATES);
  if (isBothNeedsMoreReview) reasons.push(OWNER_REVIEW_REASONS.BOTH_NEEDS_MORE_REVIEW);
  if (isDisagreement) reasons.push(OWNER_REVIEW_REASONS.DISAGREEMENT);

  const ownerReviewRequired = reasons.length > 0;

  let consensus = null;
  if (dispositionAgrees && !isDisagreement) {
    consensus = { owner_disposition: a.owner_disposition, confirmed_target_document_id: a.owner_disposition === "CONFIRM" ? a.confirmed_target_document_id : null };
  }

  let provisionalDisposition;
  if (isBothNeedsMoreReview) provisionalDisposition = PROVISIONAL_DISPOSITIONS.NEEDS_MORE_REVIEW;
  else if (ownerReviewRequired) provisionalDisposition = PROVISIONAL_DISPOSITIONS.OWNER_REVIEW_REQUIRED;
  else if (consensus.owner_disposition === "CONFIRM") provisionalDisposition = PROVISIONAL_DISPOSITIONS.PROVISIONAL_CONFIRM;
  else provisionalDisposition = PROVISIONAL_DISPOSITIONS.PROVISIONAL_REJECT;

  return {
    dispositionAgrees, targetAgrees, consensus, ownerReviewRequired,
    ownerReviewReason: reasons.length > 0 ? reasons : null,
    provisionalDisposition,
  };
}

// Builds the 326-row comparison ledger. `correctionReferenceBySource` maps
// source_document_id -> correction-reference record (or is absent/empty --
// only rows with a remediation entry ever surface an augmented candidate
// set, since that IS what remediation means: the packet's original
// candidates[] was incomplete relative to the correction-reference).
export function buildComparisonLedger({ packetRows, aFinalById, bFinalById }) {
  return packetRows.map((row) => {
    const a = aFinalById.get(row.relation_candidate_id);
    const b = bFinalById.get(row.relation_candidate_id);
    const originalTargetIds = row.candidates.map((c) => c.target_document_id);
    const augmentedIds = new Set();
    for (const considered of [a.considered_target_document_ids, b.considered_target_document_ids]) {
      for (const id of considered ?? []) if (!originalTargetIds.includes(id)) augmentedIds.add(id);
    }
    const classification = classifyRow({ relationType: row.relation_type, a, b });
    return {
      relation_candidate_id: row.relation_candidate_id,
      relation_type: row.relation_type,
      source_document_id: row.source_document_id,
      original_candidate_target_document_ids: originalTargetIds,
      correction_reference_augmented_target_document_ids: augmentedIds.size > 0 ? [...augmentedIds] : null,
      reviewer_a: {
        owner_disposition: a.owner_disposition,
        confirmed_target_document_id: a.confirmed_target_document_id,
        reviewer: a.reviewer,
        reviewed_at: a.reviewed_at,
        notes: a.notes,
        decision_source: a.source,
      },
      reviewer_b: {
        owner_disposition: b.owner_disposition,
        confirmed_target_document_id: b.confirmed_target_document_id,
        reviewer: b.reviewer,
        reviewed_at: b.reviewed_at,
        notes: b.notes,
        decision_source: b.source,
      },
      disposition_agrees: classification.dispositionAgrees,
      target_agrees: classification.targetAgrees,
      consensus: classification.consensus,
      risk_flags: [
        row.relation_type === "TERMINATES" ? "TERMINATES" : null,
        row.candidates.some((c) => c.would_cross_author_boundary) ? "CROSS_AUTHOR_BOUNDARY_CANDIDATE" : null,
      ].filter(Boolean),
      provisional_disposition: classification.provisionalDisposition,
      owner_review_required: classification.ownerReviewRequired,
      owner_review_reason: classification.ownerReviewReason,
    };
  });
}

export function selectOwnerReviewSet({ ledgerRows }) {
  const ownerRows = ledgerRows.filter((r) => r.owner_review_required);
  const byReason = { DISAGREEMENT: 0, BOTH_NEEDS_MORE_REVIEW: 0, TERMINATES: 0 };
  for (const row of ownerRows) for (const reason of row.owner_review_reason) byReason[reason]++;
  const multiReasonRows = ownerRows.filter((r) => r.owner_review_reason.length > 1);
  return {
    ids: ownerRows.map((r) => r.relation_candidate_id),
    count: ownerRows.length,
    byReason,
    multiReasonRows: multiReasonRows.map((r) => ({ relation_candidate_id: r.relation_candidate_id, reasons: r.owner_review_reason })),
  };
}

export function selectProvisionalSet({ ledgerRows }) {
  const rows = ledgerRows.filter((r) => !r.owner_review_required);
  const byDisposition = { PROVISIONAL_CONFIRM: 0, PROVISIONAL_REJECT: 0 };
  for (const row of rows) byDisposition[row.provisional_disposition]++;
  return { ids: rows.map((r) => r.relation_candidate_id), count: rows.length, byDisposition };
}

function stableDigest(value, salt) {
  return createHash("sha256").update(salt).update(JSON.stringify(value)).digest("hex");
}

// Deterministic, reproducible stratified sample of the 297 low-risk
// provisional rows: exactly `perBucket` PROVISIONAL_CONFIRM and
// `perBucket` PROVISIONAL_REJECT, walked in stable-hash order so re-
// running against byte-identical input always reproduces the identical
// sample. Diversifies across relation_type / company (corp_code) / doc
// subtype / correction-reference-augmentation usage by tracking how many
// times each stratum key has already been picked within a bucket and
// preferring the least-used stratum at each step (never by inspecting the
// review CONTENT -- only structural/provenance fields already on the row).
// Exported so the CLI orchestrator that builds the sample-audit UI can
// show the SAME stratum key on each card (Section 2: "표본 선정
// stratum과 선정 사유") that selectStratifiedSample() itself used to pick
// it -- one formula, never two copies that could silently drift apart.
export function computeAuditStratumKey(row, packetInfoById) {
  const info = packetInfoById.get(row.relation_candidate_id) ?? {};
  const usedCorrectionRef = row.correction_reference_augmented_target_document_ids !== null;
  return [row.relation_type, info.corp_code ?? "UNKNOWN", info.doc_subtype ?? "UNKNOWN", usedCorrectionRef ? "AUGMENTED" : "ORIGINAL"].join("|");
}

export function selectStratifiedSample({ ledgerRows, packetInfoById, perBucket = 15, salt = "n4.3-sample-audit" }) {
  const provisional = ledgerRows.filter((r) => !r.owner_review_required);
  const buckets = { PROVISIONAL_CONFIRM: [], PROVISIONAL_REJECT: [] };
  for (const row of provisional) buckets[row.provisional_disposition].push(row);

  function strataKey(row) { return computeAuditStratumKey(row, packetInfoById); }

  function pick(rowsInBucket, n) {
    const ordered = rowsInBucket
      .map((row) => ({ row, digest: stableDigest(row.relation_candidate_id, salt) }))
      .sort((x, y) => (x.digest < y.digest ? -1 : x.digest > y.digest ? 1 : 0));
    const strataCount = new Map();
    const selected = [];
    const remaining = ordered.slice();
    while (selected.length < n && remaining.length > 0) {
      let bestIndex = 0; let bestCount = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const key = strataKey(remaining[i].row);
        const count = strataCount.get(key) ?? 0;
        if (count < bestCount) { bestCount = count; bestIndex = i; if (bestCount === 0) break; }
      }
      const [chosen] = remaining.splice(bestIndex, 1);
      const key = strataKey(chosen.row);
      strataCount.set(key, (strataCount.get(key) ?? 0) + 1);
      selected.push(chosen.row);
    }
    return selected;
  }

  const confirmSample = pick(buckets.PROVISIONAL_CONFIRM, perBucket);
  const rejectSample = pick(buckets.PROVISIONAL_REJECT, perBucket);
  return {
    ids: [...confirmSample, ...rejectSample].map((r) => r.relation_candidate_id),
    confirmIds: confirmSample.map((r) => r.relation_candidate_id),
    rejectIds: rejectSample.map((r) => r.relation_candidate_id),
    strataDistribution: Object.fromEntries(
      [...confirmSample, ...rejectSample].reduce((map, row) => {
        const key = strataKey(row);
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map()),
    ),
  };
}

export const SAMPLE_AUDIT_DISPOSITIONS = Object.freeze(["PASS", "DEFECT_FOUND", "NEEDS_MORE_REVIEW"]);

// Validates one completed sample-audit row (the 30-row low-risk sample --
// deliberately a SEPARATE vocabulary from the Owner's own
// CONFIRM/REJECT/NEEDS_MORE_REVIEW, since a sample audit is checking
// whether the ALREADY-PROVISIONAL disposition looks correct, not casting
// a fresh vote). A DEFECT_FOUND row must record what kind of defect and
// how far its impact might reach; this function never decides whether a
// defect auto-approves/auto-rejects anything else -- callers must not
// treat a single DEFECT_FOUND as license to touch the other 267 rows.
export function validateSampleAuditRow({ sample_disposition, defect_type, defect_possible_impact_scope, auditor_note }) {
  if (!SAMPLE_AUDIT_DISPOSITIONS.includes(sample_disposition)) {
    return { valid: false, reason: `sample_disposition must be one of ${SAMPLE_AUDIT_DISPOSITIONS.join("/")}, got ${JSON.stringify(sample_disposition)}` };
  }
  if (!auditor_note || auditor_note.trim() === "") {
    return { valid: false, reason: "auditor_note is required" };
  }
  if (sample_disposition === "DEFECT_FOUND") {
    if (!defect_type || defect_type.trim() === "") return { valid: false, reason: "DEFECT_FOUND requires a defect_type" };
    if (!defect_possible_impact_scope || defect_possible_impact_scope.trim() === "") return { valid: false, reason: "DEFECT_FOUND requires defect_possible_impact_scope" };
  } else if (defect_type || defect_possible_impact_scope) {
    return { valid: false, reason: `${sample_disposition} must not carry defect_type/defect_possible_impact_scope` };
  }
  return { valid: true, reason: null };
}

// Turn N4.4: the sample AUDIT UI's own richer decision schema (distinct
// from validateSampleAuditRow's simpler N4.3 packet-template shape --
// this is what the UI itself actually collects and exports).
export const DEFECT_TYPES = Object.freeze([
  "WRONG_TARGET", "WRONG_RELATION_TYPE", "FALSE_CONFIRM", "FALSE_REJECT",
  "MISSING_CANDIDATE", "CROSS_COMPANY_ATTRIBUTION", "CROSS_CONTRACT_ATTRIBUTION",
  "DATE_ONLY_MATCH_ERROR", "INSUFFICIENT_EVIDENCE", "OTHER",
]);
const EXPECTED_DISPOSITIONS = Object.freeze(["CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"]);

export function validateSampleAuditorDecision({
  audit_disposition, audit_note, defect_type, defect_description,
  expected_disposition, expected_target_document_id, affected_scope_estimate,
  candidateIds,
}) {
  if (!SAMPLE_AUDIT_DISPOSITIONS.includes(audit_disposition)) {
    return { valid: false, reason: `audit_disposition must be one of ${SAMPLE_AUDIT_DISPOSITIONS.join("/")}, got ${JSON.stringify(audit_disposition)}` };
  }
  if (!audit_note || audit_note.trim() === "") return { valid: false, reason: "audit_note is required" };

  if (audit_disposition === "DEFECT_FOUND") {
    if (!DEFECT_TYPES.includes(defect_type)) return { valid: false, reason: `defect_type must be one of ${DEFECT_TYPES.join("/")}, got ${JSON.stringify(defect_type)}` };
    if (!defect_description || defect_description.trim() === "") return { valid: false, reason: "defect_description is required" };
    if (!EXPECTED_DISPOSITIONS.includes(expected_disposition)) return { valid: false, reason: `expected_disposition must be one of ${EXPECTED_DISPOSITIONS.join("/")}` };
    if (expected_disposition === "CONFIRM") {
      if (!expected_target_document_id) return { valid: false, reason: "expected_disposition CONFIRM requires expected_target_document_id" };
      if (candidateIds && !candidateIds.includes(expected_target_document_id)) return { valid: false, reason: "expected_target_document_id must be one of this row's own candidates" };
    } else if (expected_target_document_id) {
      return { valid: false, reason: `expected_disposition ${expected_disposition} must not carry expected_target_document_id` };
    }
    if (!affected_scope_estimate || affected_scope_estimate.trim() === "") return { valid: false, reason: "affected_scope_estimate is required" };
  } else if (defect_type || defect_description || expected_disposition || expected_target_document_id || affected_scope_estimate) {
    return { valid: false, reason: `${audit_disposition} must not carry defect fields (defect_type/defect_description/expected_disposition/expected_target_document_id/affected_scope_estimate)` };
  }
  return { valid: true, reason: null };
}

export const SAMPLE_AUDIT_GATE_STATUSES = Object.freeze({
  COMPLETED_NO_DEFECT: "SAMPLE_AUDIT_COMPLETED_NO_DEFECT",
  DEFECT_FOUND: "SAMPLE_AUDIT_DEFECT_FOUND",
  ADDITIONAL_REVIEW_REQUIRED: "SAMPLE_AUDIT_ADDITIONAL_REVIEW_REQUIRED",
});

// DEFECT_FOUND is the most conservative outcome, then NEEDS_MORE_REVIEW,
// then (only if every one of the 30 is PASS) completed-clean. Never
// promotes/auto-approves the other 267 rows regardless of outcome -- this
// function only classifies the GATE, it never touches any other data.
export function computeSampleAuditGateStatus(decisions) {
  if (decisions.some((d) => d.audit_disposition === "DEFECT_FOUND")) return SAMPLE_AUDIT_GATE_STATUSES.DEFECT_FOUND;
  if (decisions.some((d) => d.audit_disposition === "NEEDS_MORE_REVIEW")) return SAMPLE_AUDIT_GATE_STATUSES.ADDITIONAL_REVIEW_REQUIRED;
  return SAMPLE_AUDIT_GATE_STATUSES.COMPLETED_NO_DEFECT;
}

// Turn N4.4 Section "입력 검증": validates the 7 preconditions before ANY
// sample-audit UI artifact may be built. Pure -- takes plain data, never
// touches the filesystem (the CLI orchestrator does the fail-closed
// halt-and-report on top of this).
export function validateSampleAuditInputs({ samplePacketRows, ledgerRows, ownerPacketIds, expectedConfirmCount = 15, expectedRejectCount = 15, expectedTotal = 30 }) {
  const errors = [];
  if (samplePacketRows.length !== expectedTotal) errors.push(`sample packet has ${samplePacketRows.length} rows, expected exactly ${expectedTotal}`);

  const ids = samplePacketRows.map((r) => r.relation_candidate_id);
  const dupCount = ids.length - new Set(ids).size;
  if (dupCount > 0) errors.push(`sample packet contains ${dupCount} duplicate relation_candidate_id value(s)`);

  const confirmCount = samplePacketRows.filter((r) => r.expected_disposition_family === "PROVISIONAL_CONFIRM").length;
  const rejectCount = samplePacketRows.filter((r) => r.expected_disposition_family === "PROVISIONAL_REJECT").length;
  if (confirmCount !== expectedConfirmCount) errors.push(`PROVISIONAL_CONFIRM count is ${confirmCount}, expected ${expectedConfirmCount}`);
  if (rejectCount !== expectedRejectCount) errors.push(`PROVISIONAL_REJECT count is ${rejectCount}, expected ${expectedRejectCount}`);

  const ledgerIds = new Set(ledgerRows.map((r) => r.relation_candidate_id));
  const missingFromLedger = ids.filter((id) => !ledgerIds.has(id));
  if (missingFromLedger.length > 0) errors.push(`${missingFromLedger.length} sample row id(s) not present in the 326-row ledger: ${missingFromLedger.slice(0, 5).join(", ")}`);

  const ownerOverlap = ids.filter((id) => ownerPacketIds.has(id));
  if (ownerOverlap.length > 0) errors.push(`${ownerOverlap.length} sample row id(s) overlap with the 29-row Owner review set: ${ownerOverlap.slice(0, 5).join(", ")}`);

  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// Turn N4.5: dual sample-auditor comparison, conflict selection, and a
// pure, general-signal-only detector for the "multi-step correction chain"
// defect pattern found by the real dual-audit run (auditor A found source
// exchange_20250113800603's own "정정관련 공시서류제출일" pointed at the
// ORIGINAL 2021-07-30 disclosure -- outside the corpus -- while the actual
// immediately-prior document in the correction chain, already present in
// the row's own candidate list, was never selected). Nothing here decides
// a relation; every function only classifies/flags for a human.
// ===========================================================================

const VALID_SAMPLE_AUDIT_ROW_KEYS = Object.freeze([
  "audit_item_id", "relation_candidate_id", "auditor_role", "original_provisional_disposition",
  "original_confirmed_target_document_id", "audit_disposition", "audit_note", "defect_type",
  "defect_description", "expected_disposition", "expected_target_document_id",
  "affected_scope_estimate", "source_document_id", "sample_packet_sha256",
  "comparison_ledger_sha256", "reviewed_at",
]);

function validateOneAuditorResult({ label, rows, samplePacketIds, expectedSamplePacketSha256, expectedLedgerSha256, expectedAuditorRole }) {
  const errors = [];
  if (rows.length !== 30) errors.push(`${label}: expected exactly 30 rows, got ${rows.length}`);
  const ids = rows.map((r) => r.relation_candidate_id);
  const dupCount = ids.length - new Set(ids).size;
  if (dupCount > 0) errors.push(`${label}: ${dupCount} duplicate relation_candidate_id`);
  const idSet = new Set(ids);
  const missing = [...samplePacketIds].filter((id) => !idSet.has(id));
  if (missing.length > 0) errors.push(`${label}: missing ${missing.length} of the 30 sample packet ids: ${missing.slice(0, 3).join(", ")}`);
  const extra = ids.filter((id) => !samplePacketIds.has(id));
  if (extra.length > 0) errors.push(`${label}: ${extra.length} row id(s) not part of the 30-row sample packet: ${extra.slice(0, 3).join(", ")}`);

  for (const row of rows) {
    if (row.sample_packet_sha256 !== expectedSamplePacketSha256) { errors.push(`${label}: row ${row.relation_candidate_id} cites sample_packet_sha256 ${row.sample_packet_sha256}, expected ${expectedSamplePacketSha256}`); break; }
  }
  for (const row of rows) {
    if (row.comparison_ledger_sha256 !== expectedLedgerSha256) { errors.push(`${label}: row ${row.relation_candidate_id} cites comparison_ledger_sha256 ${row.comparison_ledger_sha256}, expected ${expectedLedgerSha256}`); break; }
  }
  const roleValues = new Set(rows.map((r) => r.auditor_role));
  if (!(roleValues.size === 1 && roleValues.has(expectedAuditorRole))) errors.push(`${label}: auditor_role must be uniformly ${expectedAuditorRole}, found ${JSON.stringify([...roleValues])}`);

  for (const row of rows) {
    if (!SAMPLE_AUDIT_DISPOSITIONS.includes(row.audit_disposition)) errors.push(`${label}: row ${row.relation_candidate_id} has invalid audit_disposition ${JSON.stringify(row.audit_disposition)}`);
    if (!row.audit_note || row.audit_note.trim() === "") errors.push(`${label}: row ${row.relation_candidate_id} has an empty audit_note`);
    if (row.audit_disposition === "DEFECT_FOUND") {
      if (!DEFECT_TYPES.includes(row.defect_type)) errors.push(`${label}: DEFECT_FOUND row ${row.relation_candidate_id} has invalid/missing defect_type`);
      if (!row.defect_description) errors.push(`${label}: DEFECT_FOUND row ${row.relation_candidate_id} missing defect_description`);
      if (!EXPECTED_DISPOSITIONS.includes(row.expected_disposition)) errors.push(`${label}: DEFECT_FOUND row ${row.relation_candidate_id} missing/invalid expected_disposition`);
      if (row.expected_disposition === "CONFIRM" && !row.expected_target_document_id) errors.push(`${label}: DEFECT_FOUND row ${row.relation_candidate_id} expected_disposition CONFIRM missing expected_target_document_id`);
      if (!row.affected_scope_estimate) errors.push(`${label}: DEFECT_FOUND row ${row.relation_candidate_id} missing affected_scope_estimate`);
    }
    for (const key of Object.keys(row)) {
      if (!VALID_SAMPLE_AUDIT_ROW_KEYS.includes(key)) errors.push(`${label}: row ${row.relation_candidate_id} has an unexpected field ${key}`);
    }
  }
  return errors;
}

// Checks 1 (row counts/dup/coverage), auditor_role contract, empty-note,
// disposition vocabulary, DEFECT_FOUND completeness, and packet/ledger SHA
// binding -- for EACH auditor independently. Never compares A against B
// here (that is buildAuditComparisonLedger's job) and never mutates
// either input.
export function validateDualAuditInputs({ auditorARows, auditorBRows, samplePacketIds, expectedSamplePacketSha256, expectedLedgerSha256 }) {
  const errors = [
    ...validateOneAuditorResult({ label: "auditor A", rows: auditorARows, samplePacketIds, expectedSamplePacketSha256, expectedLedgerSha256, expectedAuditorRole: "SAMPLE_AUDITOR" }),
    ...validateOneAuditorResult({ label: "auditor B", rows: auditorBRows, samplePacketIds, expectedSamplePacketSha256, expectedLedgerSha256, expectedAuditorRole: "SAMPLE_AUDITOR" }),
  ];
  return { valid: errors.length === 0, errors };
}

export const AUDIT_FINAL_STATUSES = Object.freeze({
  DUAL_AUDIT_PASS: "DUAL_AUDIT_PASS",
  AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED: "AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED",
  DUAL_AUDIT_DEFECT_AGREEMENT: "DUAL_AUDIT_DEFECT_AGREEMENT",
  ADDITIONAL_REVIEW_REQUIRED: "ADDITIONAL_REVIEW_REQUIRED",
});

function classifyAuditRow(a, b) {
  const bothPass = a.audit_disposition === "PASS" && b.audit_disposition === "PASS";
  const bothDefect = a.audit_disposition === "DEFECT_FOUND" && b.audit_disposition === "DEFECT_FOUND";
  const bothNeedsMore = a.audit_disposition === "NEEDS_MORE_REVIEW" && b.audit_disposition === "NEEDS_MORE_REVIEW";
  const dispositionAgrees = a.audit_disposition === b.audit_disposition;

  if (bothPass) return { finalStatus: AUDIT_FINAL_STATUSES.DUAL_AUDIT_PASS, ownerReviewRequired: false, reason: null, agreement: true };
  if (bothDefect) {
    // Both found a defect -- agreement that something is wrong, but the
    // two EXPECTED corrections could still differ; never auto-pick one.
    const sameExpectedTarget = a.expected_disposition === b.expected_disposition
      && a.expected_target_document_id === b.expected_target_document_id;
    if (sameExpectedTarget) return { finalStatus: AUDIT_FINAL_STATUSES.DUAL_AUDIT_DEFECT_AGREEMENT, ownerReviewRequired: true, reason: "BOTH_DEFECT_AGREEMENT", agreement: true };
    return { finalStatus: AUDIT_FINAL_STATUSES.AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED, ownerReviewRequired: true, reason: "BOTH_DEFECT_DIFFERENT_EXPECTED_TARGET", agreement: false };
  }
  if (bothNeedsMore) return { finalStatus: AUDIT_FINAL_STATUSES.ADDITIONAL_REVIEW_REQUIRED, ownerReviewRequired: true, reason: "BOTH_NEEDS_MORE_REVIEW", agreement: true };
  if (!dispositionAgrees) return { finalStatus: AUDIT_FINAL_STATUSES.AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED, ownerReviewRequired: true, reason: "DISPOSITION_DISAGREEMENT", agreement: false };
  // dispositionAgrees but neither bothPass/bothDefect/bothNeedsMore is
  // logically unreachable given the 3-value vocabulary, kept only as a
  // safe fallback that still asks for a human rather than guessing.
  return { finalStatus: AUDIT_FINAL_STATUSES.ADDITIONAL_REVIEW_REQUIRED, ownerReviewRequired: true, reason: "UNCLASSIFIED", agreement: dispositionAgrees };
}

// Builds the 30-row dual-audit comparison ledger (Task 2). Never picks a
// winner when the two auditors conflict -- every conflicting row is
// simply marked owner_review_required.
export function buildAuditComparisonLedger({ samplePacketRows, ledgerRowsById, auditorARows, auditorBRows }) {
  const aById = new Map(auditorARows.map((r) => [r.relation_candidate_id, r]));
  const bById = new Map(auditorBRows.map((r) => [r.relation_candidate_id, r]));
  return samplePacketRows.map((sampleRow) => {
    const id = sampleRow.relation_candidate_id;
    const a = aById.get(id);
    const b = bById.get(id);
    const ledgerRow = ledgerRowsById.get(id);
    const classification = classifyAuditRow(a, b);
    return {
      relation_candidate_id: id,
      source_document_id: sampleRow.source_document_id,
      relation_type: sampleRow.relation_type,
      provisional_disposition: sampleRow.provisional_disposition,
      provisional_target: sampleRow.consensus ? sampleRow.consensus.confirmed_target_document_id : null,
      auditor_a_disposition: a.audit_disposition,
      auditor_a_expected_disposition: a.expected_disposition,
      auditor_a_expected_target: a.expected_target_document_id,
      auditor_b_disposition: b.audit_disposition,
      auditor_b_expected_disposition: b.expected_disposition,
      auditor_b_expected_target: b.expected_target_document_id,
      audit_agreement: classification.agreement,
      audit_conflict_reason: classification.reason,
      owner_review_required: classification.ownerReviewRequired,
      owner_review_reason: classification.ownerReviewRequired ? classification.reason : null,
      final_status: classification.finalStatus,
      original_candidate_target_document_ids: ledgerRow ? ledgerRow.original_candidate_target_document_ids : [],
      correction_reference_augmented_target_document_ids: ledgerRow ? ledgerRow.correction_reference_augmented_target_document_ids : null,
    };
  });
}

export function selectAuditConflicts({ auditComparisonLedgerRows }) {
  return auditComparisonLedgerRows.filter((r) => r.owner_review_required);
}

// -- Turn N4.5 Task 5: multi-step correction risk detection over the
// UNAUDITED PROVISIONAL_REJECT rows. Uses ONLY general, already-available
// structural signals -- never a specific company/document/amount. A row
// is flagged when:
//   (1) relation_type === 'AMENDS' (checked, not assumed)
//   (2) provisional_disposition === 'PROVISIONAL_REJECT' (checked)
//   (3) the source's correction-reference record shows reference_status
//       !== 'MATCHED_IN_CORPUS' (its own "정정관련 공시서류제출일" did not
//       resolve to a real corpus document)
//   (4+5) the row's own ORIGINAL candidate list (built independently by
//       the chain-component packet pipeline, not by the correction-
//       reference extractor) is non-empty -- i.e. a same-company/same-
//       subtype candidate already exists structurally, exactly the
//       pattern of the one PROVEN real defect (a real candidate existed
//       but was never selected because the literal date-string match
//       failed).
// Rows with NO correction-reference-equivalent record at all (this
// environment only has one for doc_group=exchange) are NOT silently
// dropped -- they are flagged PARSER_UNCERTAIN per the explicit
// instruction to never exclude what cannot be confidently parsed.
// continuity_signals (contract-field-level before/after matching) is
// always PARSER_UNCERTAIN here: computing it for real would require raw
// DocumentIR text this environment does not have locally for the bulk
// population (confirmed: 0 of the needed document ids are covered by the
// local canonical-DocumentIR seed store). This function NEVER concludes a
// relation is real -- it only marks candidates for human review.
export function detectMultiStepCorrectionRisk({ unauditedRejectRows, correctionReferenceBySource }) {
  const flagged = [];
  for (const row of unauditedRejectRows) {
    if (row.relation_type !== "AMENDS") continue;
    if (row.provisional_disposition !== "PROVISIONAL_REJECT") continue;

    const corrRef = correctionReferenceBySource.get(row.source_document_id);
    if (!corrRef) {
      flagged.push({
        relation_candidate_id: row.relation_candidate_id,
        source_document_id: row.source_document_id,
        relation_type: row.relation_type,
        provisional_disposition: row.provisional_disposition,
        explicit_original_reference_date: null,
        related_disclosure_dates: [],
        corpus_internal_related_document_ids: [],
        candidate_target_document_ids: row.original_candidate_target_document_ids,
        continuity_signals: ["PARSER_UNCERTAIN"],
        source_before_values: null,
        candidate_after_values: null,
        risk_reason: "NO_CORRECTION_REFERENCE_RECORD_AVAILABLE_FOR_THIS_DOC_GROUP",
        review_status: "PENDING",
      });
      continue;
    }
    const condition3 = corrRef.reference_status !== "MATCHED_IN_CORPUS";
    const condition45 = (row.original_candidate_target_document_ids ?? []).length > 0;
    if (condition3 && condition45) {
      flagged.push({
        relation_candidate_id: row.relation_candidate_id,
        source_document_id: row.source_document_id,
        relation_type: row.relation_type,
        provisional_disposition: row.provisional_disposition,
        explicit_original_reference_date: corrRef.referenced_receipt_date ?? null,
        related_disclosure_dates: corrRef.referenced_receipt_date ? [corrRef.referenced_receipt_date] : [],
        corpus_internal_related_document_ids: row.original_candidate_target_document_ids,
        candidate_target_document_ids: row.original_candidate_target_document_ids,
        continuity_signals: ["PARSER_UNCERTAIN"],
        source_before_values: null,
        candidate_after_values: null,
        risk_reason: `CORRECTION_REFERENCE_STATUS_${corrRef.reference_status}_WITH_EXISTING_CANDIDATES`,
        review_status: "PENDING",
      });
    }
  }
  return flagged;
}
