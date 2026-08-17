// Turn M7 Section 2: promotes EXACTLY 14 Owner-approved Candidate Facts
// to VERIFIED, in one all-or-nothing write. Follows the same fail-closed
// pattern as scripts/promote-seed-fact-batch-v06.mjs (promotion is
// separate from Candidate authoring, reads externally-authored Owner
// decisions read-only, never partially writes) but is extended to source
// Candidates from THREE different artifacts (ontology-dependent preview
// v0.1, the Q25-correction v0.10 delta, and the ALREADY-approved v0.8
// carried-forward set) and to enforce the additional Turn M7-specific
// boundary checks the Owner asked for (Q06 INVESTMENT_AMOUNT linkage,
// Q09/Q18 exclusion, Q25 corrected label/certainty).
//
// Never touches: seed-facts-verified.v0.7.jsonl (read-only baseline),
// seed-fact-coverage-verified.v0.6.json (read-only baseline),
// seed-facts-candidates.v0.8/v0.9/v0.10.delta.jsonl (read-only sources),
// seed-structured-gap-candidate-preview.v0.1.jsonl (read-only source),
// seed-evidence-verified.v0.9.jsonl (read-only -- reused, no new
// revision needed since every evidence_id used here already resolves
// there as VERIFIED), domain/runtime/configured-seed-runtime.mjs,
// domain/releases/*.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFactRecord, validateFactCoverageSnapshot } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PATHS = Object.freeze({
  ontologyDecisionPath: path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.jsonl"),
  candidateDecisionPath: path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl"),
  carriedForwardPinPath: path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl"),
  previewPath: path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl"),
  candidatesV08Path: path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl"),
  candidatesV10Path: path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl"),
  evidenceVerifiedPath: path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl"),
  baselineFactsPath: path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl"),
  baselineCoveragePath: path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.6.json"),
  outputFactsPath: path.join(REPO, "work/domain-seed/seed-facts-verified.v0.8.jsonl"),
  outputCoveragePath: path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.7.json"),
  outputDecisionPath: path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.9-batch.jsonl"),
  outputDecisionManifestPath: path.join(REPO, "work/domain-seed/seed-structured-owner-decision.v0.9-batch.manifest.json"),
  receiptPath: path.join(REPO, "work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json"),
});

const EXPECTED_ONTOLOGY_SHA256 = "9503cc79b2bd63c2ac6b52e6da1e4ffbb01c72232781ef33b296fa0f840d49ee";
const EXPECTED_CANDIDATE_DECISION_SHA256 = "99a0394b63a2e073c984bcd525fb6c7e78c4d523a07a952743201d662375a8f6";

const EXCLUDED_Q09_COUNTERPARTY_FACT_ID = "fact_74a2b743fee3b410295be924";
const EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID = "fact_f2e453495b94543bbd236303";
const Q25_CORRECTED_FACT_ID = "fact_f82c1de6278abecc5d72436f";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }
async function readJsonl(p) {
  const text = (await readFile(p, "utf8")).trim();
  return text.length ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

export class PromotionBlockedError extends Error {
  constructor(reasons) {
    super(`PROMOTION_BLOCKED: ${reasons.join("; ")}`);
    this.name = "PromotionBlockedError";
    this.code = "PROMOTION_BLOCKED";
    this.reasons = Object.freeze([...reasons]);
  }
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export async function promoteTurnM7Batch(options = {}) {
  const paths = { ...PATHS, ...options };
  const reasons = [];

  // -- 1. Load and byte-verify the two externally-authored decisions ----
  const ontologyBytes = await readFile(paths.ontologyDecisionPath);
  if (sha256(ontologyBytes) !== EXPECTED_ONTOLOGY_SHA256) {
    throw new PromotionBlockedError([`ontology decision sha256 mismatch: expected ${EXPECTED_ONTOLOGY_SHA256}, actual ${sha256(ontologyBytes)}`]);
  }
  const ontologyRows = JSON.parse(`[${ontologyBytes.toString("utf8").trim().split("\n").join(",")}]`);
  const nonApproveOntology = ontologyRows.filter((r) => r.owner_disposition !== "APPROVE");
  if (ontologyRows.length !== 5 || nonApproveOntology.length !== 0) {
    reasons.push(`ontology decision must have exactly 5 APPROVE rows -- found ${ontologyRows.length} rows, ${nonApproveOntology.length} non-APPROVE`);
  }

  const candidateDecisionBytes = await readFile(paths.candidateDecisionPath);
  if (sha256(candidateDecisionBytes) !== EXPECTED_CANDIDATE_DECISION_SHA256) {
    throw new PromotionBlockedError([`candidate decision sha256 mismatch: expected ${EXPECTED_CANDIDATE_DECISION_SHA256}, actual ${sha256(candidateDecisionBytes)}`]);
  }
  const candidateDecisionRows = await readJsonl(paths.candidateDecisionPath);
  const approvedRows = candidateDecisionRows.filter((r) => r.owner_disposition === "APPROVE");
  const fixRequiredRows = candidateDecisionRows.filter((r) => r.owner_disposition === "FIX_REQUIRED");
  if (candidateDecisionRows.length !== 9 || approvedRows.length !== 8 || fixRequiredRows.length !== 1) {
    reasons.push(`candidate decision must be exactly 8 APPROVE + 1 FIX_REQUIRED (9 total) -- found ${candidateDecisionRows.length} rows, ${approvedRows.length} APPROVE, ${fixRequiredRows.length} FIX_REQUIRED`);
  }
  if (fixRequiredRows.length === 1 && fixRequiredRows[0].fact_id !== EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID) {
    reasons.push(`FIX_REQUIRED row must be ${EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID}, found ${fixRequiredRows[0].fact_id}`);
  }
  for (const row of [...ontologyRows, ...candidateDecisionRows]) {
    if (typeof row.reviewer !== "string" || row.reviewer.trim() === "") reasons.push(`reviewer missing on a decision row (${row.card_id ?? row.fact_id})`);
    if (typeof row.reviewed_at !== "string" || !ISO_DATETIME.test(row.reviewed_at)) reasons.push(`invalid reviewed_at on a decision row (${row.card_id ?? row.fact_id})`);
  }

  // -- 2. Load carried-forward 6 (Turn M5, already content-hash-pinned) --
  const carriedForwardRows = await readJsonl(paths.carriedForwardPinPath);
  if (carriedForwardRows.length !== 6) reasons.push(`expected 6 carried-forward rows, found ${carriedForwardRows.length}`);
  if (carriedForwardRows.some((r) => r.status !== "CARRIED_FORWARD_OWNER_APPROVED")) reasons.push("a carried-forward row is not CARRIED_FORWARD_OWNER_APPROVED");

  // -- 3. Build the exact 14-fact promotion set --------------------------
  const approvedPreviewFactIds = approvedRows.filter((r) => r.fact_id !== Q25_CORRECTED_FACT_ID).map((r) => r.fact_id);
  const promotedFactIds = new Set([...approvedPreviewFactIds, Q25_CORRECTED_FACT_ID, ...carriedForwardRows.map((r) => r.fact_id)]);
  if (promotedFactIds.size !== 14) reasons.push(`promotion set must be exactly 14 distinct fact_id, computed ${promotedFactIds.size}: ${[...promotedFactIds].join(",")}`);
  if (promotedFactIds.has(EXCLUDED_Q09_COUNTERPARTY_FACT_ID)) reasons.push(`${EXCLUDED_Q09_COUNTERPARTY_FACT_ID} (Q09 old CONTRACT_COUNTERPARTY) must never be in the promotion set`);
  if (promotedFactIds.has(EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID)) reasons.push(`${EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID} (Q18 ISSUANCE_AMOUNT) must never be in the promotion set`);
  if (reasons.length) throw new PromotionBlockedError(reasons);

  // -- 4. Resolve source content for each of the 14, from its own source-of-truth artifact --
  const previewRows = await readJsonl(paths.previewPath);
  const previewByFactId = new Map(previewRows.map((r) => [r.fact.fact_id, r]));
  const v08Rows = await readJsonl(paths.candidatesV08Path);
  const v08ByFactId = new Map(v08Rows.map((r) => [r.fact_id, r]));
  const v10Rows = await readJsonl(paths.candidatesV10Path);
  const v10ByFactId = new Map(v10Rows.map((r) => [r.fact_id, r]));
  const evidenceRows = await readJsonl(paths.evidenceVerifiedPath);
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const decisionByFactId = new Map(candidateDecisionRows.map((r) => [r.fact_id, r]));
  const carriedByFactId = new Map(carriedForwardRows.map((r) => [r.fact_id, r]));
  const baselineFacts = await readJsonl(paths.baselineFactsPath);
  const baselineFactById = new Map(baselineFacts.map((f) => [f.fact_id, f]));

  const resolvedCandidates = [];
  for (const factId of promotedFactIds) {
    let candidate = null;
    let reviewer = null;
    let reviewedAt = null;
    let sourceArtifact = null;
    if (factId === Q25_CORRECTED_FACT_ID) {
      candidate = v10ByFactId.get(factId);
      sourceArtifact = "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl";
      reviewer = decisionByFactId.get(factId)?.reviewer;
      reviewedAt = decisionByFactId.get(factId)?.reviewed_at;
    } else if (carriedByFactId.has(factId)) {
      candidate = v08ByFactId.get(factId);
      sourceArtifact = "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl";
      reviewer = carriedByFactId.get(factId).owner_reviewer;
      reviewedAt = carriedByFactId.get(factId).owner_reviewed_at;
    } else {
      candidate = previewByFactId.get(factId)?.fact;
      sourceArtifact = "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl";
      reviewer = decisionByFactId.get(factId)?.reviewer;
      reviewedAt = decisionByFactId.get(factId)?.reviewed_at;
    }
    if (!candidate) { reasons.push(`no source Candidate content found for ${factId}`); continue; }
    if (candidate.verification_status !== "CANDIDATE") reasons.push(`${factId}: source verification_status is ${candidate.verification_status}, expected CANDIDATE`);
    if (baselineFactById.has(factId)) reasons.push(`${factId}: already present in baseline VERIFIED facts -- refusing to duplicate`);
    if (!reviewer || !reviewedAt) reasons.push(`${factId}: missing reviewer/reviewed_at from its decision source`);
    for (const evidenceId of candidate.evidence_ids) {
      const ev = evidenceById.get(evidenceId);
      if (!ev) { reasons.push(`${factId}: evidence ${evidenceId} not found in VERIFIED evidence store`); continue; }
      if (ev.verification_status !== "VERIFIED") reasons.push(`${factId}: evidence ${evidenceId} is not VERIFIED`);
    }
    resolvedCandidates.push({ factId, candidate, reviewer, reviewedAt, sourceArtifact });
  }
  if (reasons.length) throw new PromotionBlockedError(reasons);

  // -- 5. Turn M7-specific semantic boundary checks ----------------------
  const q25Candidate = resolvedCandidates.find((c) => c.factId === Q25_CORRECTED_FACT_ID).candidate;
  if (q25Candidate.raw_label !== "본계약 공시 기준 유보기한") reasons.push(`Q25 corrected raw_label must be "본계약 공시 기준 유보기한", found "${q25Candidate.raw_label}"`);
  if (q25Candidate.value_certainty !== "PROVISIONAL") reasons.push(`Q25 corrected value_certainty must be PROVISIONAL, found "${q25Candidate.value_certainty}"`);

  // Q06: each INVESTMENT_PURPOSE/INVESTMENT_TARGET_ASSET preview's own
  // linked_existing_fact_id must resolve to a REAL VERIFIED fact whose
  // source_document_id matches the preview's own source_document_id
  // (never cross-attributed between the two Q06 investments).
  const q06Previews = previewRows.filter((r) => ["INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET"].includes(r.fact.metric_code));
  for (const p of q06Previews) {
    const linked = baselineFactById.get(p.linked_existing_fact_id);
    if (!linked) { reasons.push(`Q06 preview ${p.fact.fact_id}: linked_existing_fact_id ${p.linked_existing_fact_id} not found in baseline VERIFIED facts`); continue; }
    if (linked.source_document_id !== p.fact.source_document_id) {
      reasons.push(`Q06 preview ${p.fact.fact_id}: source_document_id (${p.fact.source_document_id}) does not match its linked INVESTMENT_AMOUNT fact's source_document_id (${linked.source_document_id})`);
    }
  }
  if (reasons.length) throw new PromotionBlockedError(reasons);

  // -- 6. Build VERIFIED records (candidate content unchanged except status/provenance stamp) --
  const promotedAt = options.promotedAt ?? new Date().toISOString();
  const promotedFacts = [];
  const newSlots = [];
  const decisionOutputRows = [];
  for (const { factId, candidate, reviewer, reviewedAt, sourceArtifact } of resolvedCandidates) {
    const verifiedFact = {
      ...candidate,
      verification_status: "VERIFIED",
      attributes: {
        ...candidate.attributes,
        review_provenance: {
          ...candidate.attributes.review_provenance,
          review_method: "OWNER_DIRECT_APPROVAL",
          owner_disposition: "ACCEPTED",
          owner_approved_by: reviewer,
          owner_approved_at: reviewedAt,
          promoted_by_turn: "M7",
          promoted_from_artifact: sourceArtifact,
        },
      },
    };
    const factErrors = validateFactRecord(verifiedFact);
    if (factErrors.length) { reasons.push(`fact ${factId}: ${factErrors.join("; ")}`); continue; }
    promotedFacts.push(verifiedFact);
    newSlots.push({
      // fact_id is included specifically because corp_code+metric_code+
      // as_of_date is NOT always unique -- Q06's two INVESTMENT_PURPOSE
      // facts (crane/dock) share all three (same company, same metric,
      // same announcement date) and only differ by source_document_id/
      // fact_id, which a real production incident (duplicate slot_key
      // crash on createSeedFactArtifactStore) confirmed the hard way.
      slot_key: `${verifiedFact.corp_code}::${verifiedFact.metric_code}::${verifiedFact.as_of_date}::${factId}`,
      corp_code: verifiedFact.corp_code,
      metric_code: verifiedFact.metric_code,
      period_key: `as_of:${verifiedFact.as_of_date}`,
      scope: verifiedFact.scope,
      coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
      verification_status: "VERIFIED",
      fact_ids: [verifiedFact.fact_id],
      evidence_ids: [...verifiedFact.evidence_ids],
      reason_code: null,
    });
    decisionOutputRows.push({
      review_item_id: `structured_review_v09_batch_${factId.slice(5, 15)}`,
      fact_id: factId,
      evidence_id: verifiedFact.evidence_ids[0],
      metric_code: verifiedFact.metric_code,
      source_artifact: sourceArtifact,
      owner_disposition: "APPROVE",
      reviewer, reviewed_at: reviewedAt,
      turn: "M7",
    });
  }
  if (reasons.length) throw new PromotionBlockedError(reasons);
  if (promotedFacts.length !== 14) throw new PromotionBlockedError([`internal: expected 14 promoted facts, built ${promotedFacts.length}`]);

  const baselineCoverageText = await readFile(paths.baselineCoveragePath, "utf8");
  const baselineCoverage = JSON.parse(baselineCoverageText);
  const outputFacts = [...baselineFacts, ...promotedFacts];
  const outputSlots = [...baselineCoverage.slots, ...newSlots];
  const factCoverageSnapshotId = `fact_coverage_snapshot_${sha256(Buffer.from(JSON.stringify(outputSlots))).slice(0, 24)}`;
  const outputCoverage = {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    corpus_snapshot_id: baselineCoverage.corpus_snapshot_id,
    semantic_bundle_schema_version: baselineCoverage.semantic_bundle_schema_version,
    producer_version: "seed-turn-m7-promotion",
    created_at: promotedAt,
    slots: outputSlots,
  };
  const covErrors = validateFactCoverageSnapshot(outputCoverage);
  if (covErrors.length) throw new PromotionBlockedError(covErrors.map((e) => `coverage: ${e}`));

  // -- 7. All-or-nothing write --------------------------------------------
  if (paths.outputFactsPath) await writeFile(paths.outputFactsPath, jsonl(outputFacts), "utf8");
  if (paths.outputCoveragePath) await writeFile(paths.outputCoveragePath, `${JSON.stringify(outputCoverage, null, 2)}\n`, "utf8");
  const decisionJsonlText = jsonl(decisionOutputRows);
  if (paths.outputDecisionPath) await writeFile(paths.outputDecisionPath, decisionJsonlText, "utf8");
  if (paths.outputDecisionManifestPath) {
    const decisionManifest = {
      schema_version: "0.1.0",
      generated_at: promotedAt,
      artifact: path.relative(REPO, paths.outputDecisionPath),
      artifact_sha256: sha256(Buffer.from(decisionJsonlText, "utf8")),
      record_count: decisionOutputRows.length,
      source_ontology_decision_sha256: sha256(ontologyBytes),
      source_candidate_decision_sha256: sha256(candidateDecisionBytes),
      source_carried_forward_pin_sha256: sha256(await readFile(paths.carriedForwardPinPath)),
    };
    await writeFile(paths.outputDecisionManifestPath, `${JSON.stringify(decisionManifest, null, 2)}\n`, "utf8");
  }

  const receipt = {
    promoted_at: promotedAt,
    promoted_fact_count: promotedFacts.length,
    promoted_fact_ids: [...promotedFactIds].sort(),
    excluded_fact_ids: [EXCLUDED_Q09_COUNTERPARTY_FACT_ID, EXCLUDED_Q18_ISSUANCE_AMOUNT_FACT_ID],
    ontology_decision_path: path.relative(REPO, paths.ontologyDecisionPath),
    ontology_decision_sha256: sha256(ontologyBytes),
    candidate_decision_path: path.relative(REPO, paths.candidateDecisionPath),
    candidate_decision_sha256: sha256(candidateDecisionBytes),
    carried_forward_pin_path: path.relative(REPO, paths.carriedForwardPinPath),
    carried_forward_pin_sha256: sha256(await readFile(paths.carriedForwardPinPath)),
    output_facts_path: path.relative(REPO, paths.outputFactsPath), output_facts_count: outputFacts.length,
    output_facts_sha256: sha256(await readFile(paths.outputFactsPath)),
    output_coverage_path: path.relative(REPO, paths.outputCoveragePath), output_coverage_slot_count: outputSlots.length,
    output_coverage_sha256: sha256(await readFile(paths.outputCoveragePath)),
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    output_decision_path: path.relative(REPO, paths.outputDecisionPath),
    output_decision_sha256: sha256(Buffer.from(decisionJsonlText, "utf8")),
    evidence_revision_created: false,
    evidence_revision_reason: "모든 evidence_id가 이미 seed-evidence-verified.v0.9.jsonl에 VERIFIED로 존재하며 재사용되므로 새 Evidence revision이 필요하지 않음.",
  };
  if (paths.receiptPath) await writeFile(paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

async function main() {
  const receipt = await promoteTurnM7Batch();
  console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
