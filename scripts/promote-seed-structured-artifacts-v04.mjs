// v0.4-specific promotion: Candidate Fact (67) / Coverage (82 slots) / one
// relinked Evidence delta -> new VERIFIED revisions, gated on the final
// Owner decision (82/82 APPROVE) actually on disk. Deliberately NOT a
// reuse of scripts/promote-seed-structured-artifacts.mjs, which hardcodes
// 54 Fact / 69 Coverage / a Q3+Q22 exclusion list from an earlier, smaller
// generation -- none of that generalizes to this 67/82/no-exclusion set.
//
// Every output is a NEW, separately-versioned file. v0.15/v0.3/v0.5 and
// the v0.16/v0.4/v0.6 Candidate inputs are only ever read here, never
// opened for writing. Event (v0.1) and Relation/Chain (v0.2) are already
// VERIFIED and unchanged by this promotion -- they are carried forward by
// reference (byte-identical, same file) in the new structured-artifacts
// manifest, not duplicated.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateEvidenceRecord, validateFactRecord, validateEventRecord, validateFactCoverageSnapshot,
} from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTED_AT = new Date().toISOString();
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

const DECISION_PATH = "work/domain-seed/seed-structured-owner-decision.v0.4.jsonl";
const IN = {
  goldV16: "work/domain-seed/seed-gold-promotion-candidates.v0.16.jsonl",
  evidenceV05: "work/domain-seed/seed-evidence-verified.v0.5.jsonl",
  evidenceV05Manifest: "work/domain-seed/seed-evidence-verified.v0.5.manifest.json",
  evidenceV06Delta: "work/domain-seed/seed-evidence-candidates.v0.6.delta.jsonl",
  factsV04Candidate: "work/domain-seed/seed-facts-candidates.v0.4.jsonl",
  coverageV04Candidate: "work/domain-seed/seed-fact-coverage-candidates.v0.4.json",
  eventsV01: "work/domain-seed/seed-events-verified.v0.1.jsonl",
  relationV02: "work/domain-seed/seed-relation-gold.v0.2.jsonl",
};
const OUT = {
  goldV17: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  goldV17Mapping: "work/domain-seed/seed-v16-to-v17-mapping.jsonl",
  evidenceV06: "work/domain-seed/seed-evidence-verified.v0.6.jsonl",
  evidenceV06Manifest: "work/domain-seed/seed-evidence-verified.v0.6.manifest.json",
  factsV04Verified: "work/domain-seed/seed-facts-verified.v0.4.jsonl",
  coverageV04Verified: "work/domain-seed/seed-fact-coverage-verified.v0.4.json",
  structuredManifestV04: "work/domain-seed/seed-structured-artifacts.v0.4.manifest.json",
  promotionReport: "work/domain-seed/seed-structured-promotion.v0.4.report.md",
  promotionManifest: "work/domain-seed/seed-structured-promotion.v0.4.manifest.json",
};

const BAD_ROW16_EVIDENCE_ID = "evidence_3af676a53066446432eb71f4";
const NEW_ROW17_EVIDENCE_ID = "evidence_c0b7c71ea8a833271c28a498";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
async function readAbs(relPath) {
  return readFile(path.join(REPO, relPath));
}
async function readJsonlAbs(relPath) {
  const text = (await readAbs(relPath)).toString("utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l));
}
async function readJsonAbs(relPath) {
  return JSON.parse((await readAbs(relPath)).toString("utf8"));
}
async function sha256OfFile(relPath) {
  return sha256(await readAbs(relPath));
}
function jsonl(records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
function fail(message) {
  throw new Error(`PROMOTION_BLOCKED: ${message}`);
}

async function main() {
  // ---------------------------------------------------------------------
  // 0. Gate: the final Owner decision must show 82/82 APPROVE right now.
  // ---------------------------------------------------------------------
  const decision = await readJsonlAbs(DECISION_PATH);
  if (decision.length !== 82) fail(`expected 82 decision items, found ${decision.length}`);
  const notApproved = decision.filter((d) => d.owner_disposition !== "APPROVE");
  if (notApproved.length > 0) {
    fail(`${notApproved.length} decision item(s) are not APPROVE (${notApproved.map((d) => `${d.slot_key}:${d.owner_disposition}`).join(", ")}) -- promotion refuses to run`);
  }
  const decisionByFactId = new Map();
  for (const item of decision) for (const factId of item.fact_ids) decisionByFactId.set(factId, item);
  const decisionSha256 = await sha256OfFile(DECISION_PATH);

  // ---------------------------------------------------------------------
  // 1. Evidence: v0.5 (213) minus the bad row=16 quote, plus the row=17
  //    replacement, both re-validated against the official schema.
  // ---------------------------------------------------------------------
  const evidenceV05 = await readJsonlAbs(IN.evidenceV05);
  const evidenceV06Delta = await readJsonlAbs(IN.evidenceV06Delta);
  if (evidenceV06Delta.length !== 1 || evidenceV06Delta[0].evidence_id !== NEW_ROW17_EVIDENCE_ID) {
    fail(`unexpected evidence delta shape in ${IN.evidenceV06Delta}`);
  }
  const hasBadEvidence = evidenceV05.some((e) => e.evidence_id === BAD_ROW16_EVIDENCE_ID);
  if (!hasBadEvidence) fail(`${BAD_ROW16_EVIDENCE_ID} not found in ${IN.evidenceV05} -- nothing to remove, refusing to proceed blind`);

  const promotedRow17 = {
    ...evidenceV06Delta[0],
    verification_status: "VERIFIED",
    metadata: {
      ...evidenceV06Delta[0].metadata,
      review_status: "OWNER_ACCEPTED",
      verification_provenance: {
        ...evidenceV06Delta[0].metadata?.verification_provenance,
        promoted_by_decision_id: "seed-structured-owner-decision-v0.4",
        promoted_by_decision_path: DECISION_PATH,
        promoted_by_decision_sha256: decisionSha256,
        promoted_at: PROMOTED_AT,
      },
    },
  };
  const evidenceV06 = [...evidenceV05.filter((e) => e.evidence_id !== BAD_ROW16_EVIDENCE_ID), promotedRow17]
    .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
  if (evidenceV06.length !== evidenceV05.length) fail(`evidence v0.6 count ${evidenceV06.length} != v0.5 count ${evidenceV05.length} (expected same total: -1 bad +1 replacement)`);
  if (evidenceV06.some((e) => e.evidence_id === BAD_ROW16_EVIDENCE_ID)) fail("bad row=16 evidence still present in v0.6 -- refusing to write");
  if (!evidenceV06.some((e) => e.evidence_id === NEW_ROW17_EVIDENCE_ID)) fail("row=17 replacement evidence missing from v0.6 -- refusing to write");

  const evidenceErrors = evidenceV06.flatMap((record, i) => validateEvidenceRecord(record).map((e) => `evidence[${i}] ${record.evidence_id}: ${e}`));
  if (evidenceErrors.length) fail(`Evidence schema validation failed:\n${evidenceErrors.join("\n")}`);

  await writeFile(path.join(REPO, OUT.evidenceV06), jsonl(evidenceV06), "utf8");
  const evidenceV06Bytes = await readAbs(OUT.evidenceV06);
  const v05Manifest = await readJsonAbs(IN.evidenceV05Manifest);
  const evidenceV06Manifest = {
    schema_version: "0.1.0",
    artifact: "seed-evidence-verified.v0.6.jsonl",
    artifact_sha256: sha256(evidenceV06Bytes),
    generated_at: PROMOTED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    authored_against_manifest_sha256: v05Manifest.authored_against_manifest_sha256,
    supersedes: IN.evidenceV05,
    supersession_note:
      `${BAD_ROW16_EVIDENCE_ID} (row=16, section-heading-only quote, does not support LATEST_EQUITY_SHARES/LATEST_PACKAGE_TERMS) removed; `
      + `${NEW_ROW17_EVIDENCE_ID} (row=17, independently re-verified against canonical DocumentIR raw table cell) promoted from Candidate. `
      + `Promotion decision: seed-structured-owner-decision-v0.4 (${decisionSha256}).`,
    record_count: evidenceV06.length,
    evidence_ids: evidenceV06.map((e) => e.evidence_id).sort(),
  };
  await writeFile(path.join(REPO, OUT.evidenceV06Manifest), JSON.stringify(evidenceV06Manifest, null, 2) + "\n", "utf8");

  // ---------------------------------------------------------------------
  // 2. Fact: 67 Candidate -> VERIFIED, evidence_ids re-checked against the
  //    NEW evidence v0.6 set only.
  // ---------------------------------------------------------------------
  const factsCandidate = await readJsonlAbs(IN.factsV04Candidate);
  if (factsCandidate.length !== 67) fail(`expected 67 Candidate facts, found ${factsCandidate.length}`);
  const evidenceV06ById = new Map(evidenceV06.map((e) => [e.evidence_id, e]));

  const factsVerified = factsCandidate.map((fact) => {
    const decisionItem = decisionByFactId.get(fact.fact_id);
    if (!decisionItem) fail(`fact ${fact.fact_id} has no corresponding APPROVE decision item -- refusing to promote`);
    for (const evidenceId of fact.evidence_ids) {
      if (!evidenceV06ById.has(evidenceId)) fail(`fact ${fact.fact_id} references evidence ${evidenceId} not present in the new VERIFIED evidence v0.6 set`);
    }
    const priorProvenance = { ...(fact.attributes?.review_provenance ?? {}) };
    delete priorProvenance.v04_candidate_status;
    delete priorProvenance.v04_generated_at;
    delete priorProvenance.v04_basis;
    return {
      ...fact,
      verification_status: "VERIFIED",
      attributes: {
        ...fact.attributes,
        review_provenance: {
          ...priorProvenance,
          promoted_by_decision_id: "seed-structured-owner-decision-v0.4",
          promoted_by_decision_path: DECISION_PATH,
          promoted_by_decision_sha256: decisionSha256,
          promoted_by_review_item_id: decisionItem.review_item_id,
          promoted_by_category: decisionItem.category,
          promoted_at: PROMOTED_AT,
        },
      },
    };
  });

  const factErrors = factsVerified.flatMap((record, i) => validateFactRecord(record).map((e) => `fact[${i}] ${record.fact_id}: ${e}`));
  if (factErrors.length) fail(`Fact schema validation failed:\n${factErrors.join("\n")}`);
  await writeFile(path.join(REPO, OUT.factsV04Verified), jsonl(factsVerified), "utf8");
  const factsV04VerifiedBytes = await readAbs(OUT.factsV04Verified);

  // ---------------------------------------------------------------------
  // 3. Coverage: 82 Candidate slots -> official VERIFIED shape
  //    (candidate_status -> coverage_state, verification_status VERIFIED,
  //    strip the CANDIDATE-only top-level fields the official schema
  //    forbids via additionalProperties:false).
  // ---------------------------------------------------------------------
  const coverageCandidateDoc = await readJsonAbs(IN.coverageV04Candidate);
  if (coverageCandidateDoc.slots.length !== 82) fail(`expected 82 Candidate coverage slots, found ${coverageCandidateDoc.slots.length}`);
  const factsVerifiedById = new Map(factsVerified.map((f) => [f.fact_id, f]));

  const slotsVerified = coverageCandidateDoc.slots.map((slot) => {
    for (const factId of slot.fact_ids) {
      if (!factsVerifiedById.has(factId)) fail(`coverage slot ${slot.slot_key} references fact ${factId} not present in the new VERIFIED fact set`);
    }
    for (const evidenceId of slot.evidence_ids) {
      if (!evidenceV06ById.has(evidenceId)) fail(`coverage slot ${slot.slot_key} references evidence ${evidenceId} not present in the new VERIFIED evidence v0.6 set`);
    }
    const coverageState = slot.candidate_status === "FACT_CANDIDATE_AVAILABLE" ? "ALL_REQUIRED_FACT_SLOTS_VERIFIED" : slot.candidate_status;
    return {
      slot_key: slot.slot_key,
      corp_code: slot.corp_code,
      metric_code: slot.metric_code,
      period_key: slot.period_key,
      scope: slot.scope,
      coverage_state: coverageState,
      verification_status: "VERIFIED",
      fact_ids: slot.fact_ids,
      evidence_ids: slot.evidence_ids,
      reason_code: slot.reason_code ?? null,
    };
  });

  const factCoverageSnapshotId = `fact_coverage_snapshot_${sha256(Buffer.from(JSON.stringify(slotsVerified))).slice(0, 24)}`;
  const coverageV04Verified = {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    semantic_bundle_schema_version: coverageCandidateDoc.semantic_bundle_schema_version,
    producer_version: "seed-v04-owner-approved-promotion",
    created_at: PROMOTED_AT,
    slots: slotsVerified,
  };
  const coverageErrors = validateFactCoverageSnapshot(coverageV04Verified);
  if (coverageErrors.length) fail(`Fact Coverage Snapshot schema validation failed:\n${coverageErrors.join("\n")}`);
  await writeFile(path.join(REPO, OUT.coverageV04Verified), JSON.stringify(coverageV04Verified, null, 2) + "\n", "utf8");
  const coverageV04VerifiedBytes = await readAbs(OUT.coverageV04Verified);

  // ---------------------------------------------------------------------
  // 4. Event (v0.1, 24) and Relation/Chain (v0.2, 40): byte-identical
  //    carryover -- re-validated fresh (Event only; no relation validator
  //    is exported/required), never rewritten.
  // ---------------------------------------------------------------------
  const events = await readJsonlAbs(IN.eventsV01);
  if (events.length !== 24) fail(`expected 24 Events, found ${events.length}`);
  const eventErrors = events.flatMap((record, i) => validateEventRecord(record).map((e) => `event[${i}] ${record.event_id}: ${e}`));
  if (eventErrors.length) fail(`Event schema validation failed:\n${eventErrors.join("\n")}`);
  const eventsSha256 = await sha256OfFile(IN.eventsV01);
  const relationSha256 = await sha256OfFile(IN.relationV02);
  const relationRecords = await readJsonlAbs(IN.relationV02);
  if (relationRecords.length !== 40) fail(`expected 40 Relation records, found ${relationRecords.length}`);

  // ---------------------------------------------------------------------
  // 5. Gold: v0.16 (DRAFT) -> v0.17 (approved revision), content
  //    byte-for-byte identical except administrative gold_revision/
  //    created_at and the decision-reference extension.
  // ---------------------------------------------------------------------
  const goldV16 = await readJsonlAbs(IN.goldV16);
  if (goldV16.length !== 25) fail(`expected 25 Gold v0.16 records, found ${goldV16.length}`);
  const goldV17 = goldV16.map((g) => ({
    ...g,
    authored_against: { ...g.authored_against, gold_revision: "gold-seed-v0.17-owner-approved" },
    created_at: PROMOTED_AT,
    extensions: {
      ...g.extensions,
      promotion_provenance: {
        decision_id: "seed-structured-owner-decision-v0.4",
        decision_path: DECISION_PATH,
        decision_sha256: decisionSha256,
        promoted_at: PROMOTED_AT,
      },
    },
  }));
  await writeFile(path.join(REPO, OUT.goldV17), jsonl(goldV17), "utf8");
  const goldV17Bytes = await readAbs(OUT.goldV17);
  const mapping = goldV17.map((g17) => ({
    question_id: g17.question_id,
    changed: false,
    change_summary: "v0.16 대비 값 변경 없음 -- gold_revision/created_at/promotion_provenance만 갱신됨 (새 revision 승격)",
  }));
  await writeFile(path.join(REPO, OUT.goldV17Mapping), jsonl(mapping), "utf8");

  // ---------------------------------------------------------------------
  // 6. Structured artifact manifest v0.4: pins the new VERIFIED bundle.
  //    excluded_question_ids is empty -- Q3/Q22 are no longer excluded.
  // ---------------------------------------------------------------------
  const structuredManifest = {
    schema_version: "0.1.0",
    artifact_set_id: "seed-structured-artifacts-v0.4",
    status: "VERIFIED_SEED_SUBSET",
    generated_at: PROMOTED_AT,
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    semantic_bundle_schema_version: coverageCandidateDoc.semantic_bundle_schema_version,
    artifacts: [
      { role: "VERIFIED_EVIDENCE", path: OUT.evidenceV06, sha256: sha256(evidenceV06Bytes), bytes: evidenceV06Bytes.length, record_count: evidenceV06.length },
      { role: "VERIFIED_EVIDENCE_MANIFEST", path: OUT.evidenceV06Manifest, sha256: sha256(await readAbs(OUT.evidenceV06Manifest)), bytes: (await readAbs(OUT.evidenceV06Manifest)).length, record_count: null },
      { role: "VERIFIED_EVENT", path: IN.eventsV01, sha256: eventsSha256, bytes: (await readAbs(IN.eventsV01)).length, record_count: events.length },
      { role: "VERIFIED_RELATION", path: IN.relationV02, sha256: relationSha256, bytes: (await readAbs(IN.relationV02)).length, record_count: relationRecords.length },
      { role: "VERIFIED_FACT", path: OUT.factsV04Verified, sha256: sha256(factsV04VerifiedBytes), bytes: factsV04VerifiedBytes.length, record_count: factsVerified.length },
      { role: "FACT_COVERAGE_SNAPSHOT", path: OUT.coverageV04Verified, sha256: sha256(coverageV04VerifiedBytes), bytes: coverageV04VerifiedBytes.length, record_count: slotsVerified.length },
      { role: "OWNER_DECISION", path: DECISION_PATH, sha256: decisionSha256, bytes: (await readAbs(DECISION_PATH)).length, record_count: decision.length },
    ],
    excluded_question_ids: [],
    release_status: "APPROVED_PENDING_RELEASE_AUTHORIZATION",
  };
  await writeFile(path.join(REPO, OUT.structuredManifestV04), JSON.stringify(structuredManifest, null, 2) + "\n", "utf8");

  // ---------------------------------------------------------------------
  // 7. Cross-reference closure: Gold <-> Fact <-> Coverage <-> Evidence.
  // ---------------------------------------------------------------------
  const goldEvidenceIds = new Set(goldV17.flatMap((g) => g.extensions?.evidence_ids ?? []));
  const coverageEvidenceIds = new Set(slotsVerified.flatMap((s) => s.evidence_ids));
  const coverageFactIds = new Set(slotsVerified.flatMap((s) => s.fact_ids));
  const factEvidenceIds = new Set(factsVerified.flatMap((f) => f.evidence_ids));
  const verifiedEvidenceIds = new Set(evidenceV06.map((e) => e.evidence_id));
  const verifiedFactIds = new Set(factsVerified.map((f) => f.fact_id));

  const closure = {
    gold_evidence_ids_subset_of_verified: [...goldEvidenceIds].every((id) => verifiedEvidenceIds.has(id)),
    coverage_evidence_ids_subset_of_verified: [...coverageEvidenceIds].every((id) => verifiedEvidenceIds.has(id)),
    fact_evidence_ids_subset_of_verified: [...factEvidenceIds].every((id) => verifiedEvidenceIds.has(id)),
    coverage_fact_ids_subset_of_verified: [...coverageFactIds].every((id) => verifiedFactIds.has(id)),
    bad_row16_evidence_absent: !verifiedEvidenceIds.has(BAD_ROW16_EVIDENCE_ID)
      && !goldEvidenceIds.has(BAD_ROW16_EVIDENCE_ID) && !coverageEvidenceIds.has(BAD_ROW16_EVIDENCE_ID) && !factEvidenceIds.has(BAD_ROW16_EVIDENCE_ID),
    row17_evidence_present_and_referenced: verifiedEvidenceIds.has(NEW_ROW17_EVIDENCE_ID)
      && (coverageEvidenceIds.has(NEW_ROW17_EVIDENCE_ID) || factEvidenceIds.has(NEW_ROW17_EVIDENCE_ID)),
  };
  const closureFailed = Object.entries(closure).filter(([, v]) => v !== true);
  if (closureFailed.length) fail(`referential closure check failed: ${JSON.stringify(closureFailed)}`);

  // ---------------------------------------------------------------------
  // 8. Promotion report + manifest.
  // ---------------------------------------------------------------------
  const promotionManifest = {
    schema_version: "0.1.0",
    promotion_id: "seed-structured-promotion-v0.4",
    promoted_at: PROMOTED_AT,
    decision: { path: DECISION_PATH, sha256: decisionSha256 },
    inputs: Object.fromEntries(await Promise.all(Object.entries(IN).map(async ([k, p]) => [k, { path: p, sha256: await sha256OfFile(p) }]))),
    outputs: {
      gold_v0_17: { path: OUT.goldV17, sha256: sha256(goldV17Bytes), record_count: goldV17.length },
      gold_v16_to_v17_mapping: { path: OUT.goldV17Mapping, sha256: await sha256OfFile(OUT.goldV17Mapping) },
      evidence_v0_6: { path: OUT.evidenceV06, sha256: sha256(evidenceV06Bytes), record_count: evidenceV06.length },
      evidence_v0_6_manifest: { path: OUT.evidenceV06Manifest, sha256: await sha256OfFile(OUT.evidenceV06Manifest) },
      facts_v0_4_verified: { path: OUT.factsV04Verified, sha256: sha256(factsV04VerifiedBytes), record_count: factsVerified.length },
      coverage_v0_4_verified: { path: OUT.coverageV04Verified, sha256: sha256(coverageV04VerifiedBytes), record_count: slotsVerified.length },
      structured_manifest_v0_4: { path: OUT.structuredManifestV04, sha256: await sha256OfFile(OUT.structuredManifestV04) },
    },
    carried_forward_byte_identical: {
      events_v0_1: { path: IN.eventsV01, sha256: eventsSha256, record_count: events.length },
      relation_v0_2: { path: IN.relationV02, sha256: relationSha256, record_count: relationRecords.length },
    },
    referential_closure: closure,
    removed_evidence: { evidence_id: BAD_ROW16_EVIDENCE_ID, reason: "row=16 section-heading-only quote does not support LATEST_EQUITY_SHARES/LATEST_PACKAGE_TERMS values" },
    promoted_evidence: { evidence_id: NEW_ROW17_EVIDENCE_ID, reason: "row=17 independently re-verified against canonical DocumentIR raw table cell" },
    excluded_question_ids: [],
    invariants: {
      fact_count: 67, coverage_slot_count: 82, event_count: 24, relation_count: 40, evidence_count: evidenceV06.length,
      candidate_inputs_not_modified: true, verified_v0_3_v0_5_v0_15_not_modified: true,
    },
  };
  await writeFile(path.join(REPO, OUT.promotionManifest), JSON.stringify(promotionManifest, null, 2) + "\n", "utf8");

  const md = [];
  md.push("# Seed Structured Promotion v0.4 — Report");
  md.push("");
  md.push(`- 승격 시각: ${PROMOTED_AT}`);
  md.push(`- 승인 근거: \`${DECISION_PATH}\` (sha256 \`${decisionSha256}\`, 82/82 APPROVE)`);
  md.push("");
  md.push("## 산출물");
  md.push("");
  for (const [k, v] of Object.entries(promotionManifest.outputs)) md.push(`- \`${v.path}\` — sha256 \`${v.sha256}\`${v.record_count !== undefined ? ` (${v.record_count}건)` : ""}`);
  md.push("");
  md.push("## Byte-identical 승계");
  md.push("");
  for (const [k, v] of Object.entries(promotionManifest.carried_forward_byte_identical)) md.push(`- \`${v.path}\` — sha256 \`${v.sha256}\` (${v.record_count}건, 수정 없음)`);
  md.push("");
  md.push("## Evidence 변경");
  md.push("");
  md.push(`- 제거: \`${BAD_ROW16_EVIDENCE_ID}\` (row=16, 섹션 제목만 담은 quote)`);
  md.push(`- 승격: \`${NEW_ROW17_EVIDENCE_ID}\` (row=17, 실제 값 포함, 원문 재검증 완료)`);
  md.push("");
  md.push("## 참조 무결성");
  md.push("");
  for (const [k, v] of Object.entries(closure)) md.push(`- ${k}: ${v ? "✅" : "❌"}`);
  md.push("");
  await writeFile(path.join(REPO, OUT.promotionReport), md.join("\n"), "utf8");

  console.log(JSON.stringify({
    fact_count: factsVerified.length,
    coverage_slot_count: slotsVerified.length,
    evidence_count: evidenceV06.length,
    event_count: events.length,
    relation_count: relationRecords.length,
    excluded_question_ids: [],
    referential_closure: closure,
    outputs: [...Object.values(OUT)],
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
