// Promotes the 6 CANDIDATE Facts/Evidence built by
// scripts/build-seed-fact-batch-v06-candidates.mjs to VERIFIED -- but ONLY
// given a real, externally authored Owner decision artifact (a hand-edited
// copy of work/domain-seed/seed-structured-owner-decision.v0.6-batch.template.jsonl
// with every owner_disposition changed from "PENDING" to "APPROVE"/"REJECT"
// and reviewer/reviewed_at filled in by an actual person).
//
// P0/P1 AUDIT FIX (v0.17 review): promotion used to be fused into the same
// script that authored the candidates, which is what let that script mint
// its own "approval". This script is now the ONLY place promotion can
// happen, it NEVER writes to the decision artifact it reads (read-only
// input), and it fails closed -- before writing ANY output -- unless ALL
// of the following hold:
//   - the decision file exists and is readable JSONL
//   - (optional --expected-sha256) its raw bytes hash to the caller-pinned
//     value, so a decision reviewed-and-handed-off earlier cannot be
//     silently swapped before promotion runs
//   - its fact_id/evidence_id pairs are EXACTLY the 6 candidate items --
//     no missing item, no extra item, no duplicate
//   - every item's owner_disposition is exactly "APPROVE" (a single
//     non-APPROVE entry, including "PENDING" or "REJECT", blocks the
//     WHOLE batch -- promotion is all-or-nothing, never partial)
//   - every item has a non-empty string reviewer and a valid ISO
//     reviewed_at
// On success, the VERIFIED records are built by taking the CANDIDATE
// records unchanged and re-stamping verification_status/review fields --
// owner_approved_by/owner_approved_at are copied from the decision's own
// reviewer/reviewed_at fields, never a literal in this script.
//
// New output revisions only (v0.9 evidence / v0.7 facts / v0.6 coverage) --
// this script never opens work/domain-seed/seed-evidence-verified.v0.7.jsonl,
// seed-facts-verified.v0.5.jsonl, seed-fact-coverage-verified.v0.5.json, or
// seed-structured-owner-decision.v0.5-batch.jsonl (the prior, self-approved
// batch) for writing, and it never touches any release manifest or
// domain/runtime/configured-seed-runtime.mjs.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidenceRecord, validateFactRecord, validateFactCoverageSnapshot } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Default candidate paths point at the LATEST corrected candidate revision
// (scripts/build-seed-fact-batch-v07-candidates.mjs's output -- fixes a
// period-semantics defect in the two Q10 facts vs the v0.6 candidates this
// script originally defaulted to; see seed-fact-batch-v07-candidates.mjs's
// header comment). The matching decision template is
// seed-structured-owner-decision.v0.7-batch.template.jsonl. v0.8/v0.6 are
// preserved untouched on disk as the superseded, flawed-period predecessor.
const DEFAULT_PATHS = Object.freeze({
  evidenceCandidatesPath: path.join(REPO, "work/domain-seed/seed-evidence-candidates.v0.9.delta.jsonl"),
  factCandidatesPath: path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.7.delta.jsonl"),
  baselineEvidencePath: path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.6.jsonl"),
  baselineFactsPath: path.join(REPO, "work/domain-seed/seed-facts-verified.v0.4.jsonl"),
  baselineCoveragePath: path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.4.json"),
  outputEvidencePath: path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl"),
  outputFactsPath: path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl"),
  outputCoveragePath: path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.6.json"),
  receiptPath: path.join(REPO, "work/domain-seed/seed-fact-batch-v06-promotion-receipt.json"),
});

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function jsonl(records) { return records.map((r) => JSON.stringify(r)).join("\n") + "\n"; }

export class PromotionBlockedError extends Error {
  constructor(reasons) {
    super(`PROMOTION_BLOCKED: ${reasons.join("; ")}`);
    this.name = "PromotionBlockedError";
    this.code = "PROMOTION_BLOCKED";
    this.reasons = Object.freeze([...reasons]);
  }
}

async function readJsonlAbs(p) {
  const text = (await readFile(p, "utf8")).trim();
  return text.length ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateDecisionShape(decisionItems, expectedIdPairs, reasons) {
  const seenReviewItemIds = new Set();
  const seenFactIds = new Set();
  const seenEvidenceIds = new Set();
  const actualIdPairs = new Set();

  for (const [i, item] of decisionItems.entries()) {
    const label = `decision[${i}]`;
    if (!item || typeof item !== "object") { reasons.push(`${label}: not an object`); continue; }
    if (typeof item.review_item_id !== "string" || item.review_item_id === "") reasons.push(`${label}: missing review_item_id`);
    else if (seenReviewItemIds.has(item.review_item_id)) reasons.push(`${label}: duplicate review_item_id ${item.review_item_id}`);
    else seenReviewItemIds.add(item.review_item_id);

    if (typeof item.fact_id !== "string" || item.fact_id === "") reasons.push(`${label}: missing fact_id`);
    else if (seenFactIds.has(item.fact_id)) reasons.push(`${label}: duplicate fact_id ${item.fact_id}`);
    else seenFactIds.add(item.fact_id);

    if (typeof item.evidence_id !== "string" || item.evidence_id === "") reasons.push(`${label}: missing evidence_id`);
    else if (seenEvidenceIds.has(item.evidence_id)) reasons.push(`${label}: duplicate evidence_id ${item.evidence_id}`);
    else seenEvidenceIds.add(item.evidence_id);

    if (item.owner_disposition !== "APPROVE") {
      reasons.push(`${label}: owner_disposition is "${item.owner_disposition}", not "APPROVE" -- promotion is all-or-nothing, one non-APPROVE item blocks the whole batch`);
    }
    if (typeof item.reviewer !== "string" || item.reviewer.trim() === "") {
      reasons.push(`${label}: reviewer must be a non-empty string, got ${JSON.stringify(item.reviewer)}`);
    }
    if (typeof item.reviewed_at !== "string" || !ISO_DATETIME.test(item.reviewed_at)) {
      reasons.push(`${label}: reviewed_at must be a valid ISO date-time string, got ${JSON.stringify(item.reviewed_at)}`);
    }

    if (typeof item.fact_id === "string" && typeof item.evidence_id === "string") {
      actualIdPairs.add(`${item.fact_id}::${item.evidence_id}`);
    }
  }

  if (decisionItems.length !== expectedIdPairs.size) {
    reasons.push(`decision has ${decisionItems.length} item(s), expected exactly ${expectedIdPairs.size}`);
  }
  for (const expected of expectedIdPairs) {
    if (!actualIdPairs.has(expected)) reasons.push(`decision is missing an entry for ${expected}`);
  }
  for (const actual of actualIdPairs) {
    if (!expectedIdPairs.has(actual)) reasons.push(`decision declares an entry not among the 6 candidate items: ${actual}`);
  }
}

export async function promoteSeedFactBatch(options = {}) {
  const paths = { ...DEFAULT_PATHS, ...options };
  const { decisionPath, expectedSha256 } = options;
  if (typeof decisionPath !== "string" || decisionPath === "") throw new Error("decisionPath is required");

  const reasons = [];

  let decisionBytes;
  try { decisionBytes = await readFile(decisionPath); }
  catch (error) { throw new PromotionBlockedError([`decision artifact could not be read at ${decisionPath}: ${error.message}`]); }
  const actualSha256 = sha256(decisionBytes);
  if (expectedSha256 && expectedSha256 !== actualSha256) {
    throw new PromotionBlockedError([`decision artifact sha256 mismatch: expected ${expectedSha256}, actual ${actualSha256} (path ${decisionPath})`]);
  }

  let decisionItems;
  try {
    const text = decisionBytes.toString("utf8").trim();
    decisionItems = text.length ? text.split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    throw new PromotionBlockedError([`decision artifact at ${decisionPath} is not valid JSONL: ${error.message}`]);
  }

  const [candidateEvidence, candidateFacts] = await Promise.all([
    readJsonlAbs(paths.evidenceCandidatesPath),
    readJsonlAbs(paths.factCandidatesPath),
  ]);
  const evidenceById = new Map(candidateEvidence.map((e) => [e.evidence_id, e]));
  const factById = new Map(candidateFacts.map((f) => [f.fact_id, f]));
  const expectedIdPairs = new Set(candidateFacts.map((f) => `${f.fact_id}::${f.evidence_ids[0]}`));

  validateDecisionShape(decisionItems, expectedIdPairs, reasons);
  if (reasons.length) throw new PromotionBlockedError(reasons);

  const promotedEvidence = [];
  const promotedFacts = [];
  const newSlots = [];
  for (const item of decisionItems) {
    const candidateEvidenceRecord = evidenceById.get(item.evidence_id);
    const candidateFactRecord = factById.get(item.fact_id);
    if (!candidateEvidenceRecord || !candidateFactRecord) {
      // Already covered by expectedIdPairs check above, but guards against
      // a TOCTOU-style logic error rather than assuming the earlier check
      // is exhaustive.
      throw new PromotionBlockedError([`internal: no candidate record for ${item.fact_id}/${item.evidence_id}`]);
    }

    const verifiedEvidence = {
      ...candidateEvidenceRecord,
      verification_status: "VERIFIED",
      metadata: {
        ...candidateEvidenceRecord.metadata,
        review_status: "OWNER_ACCEPTED",
        verification_provenance: {
          ...candidateEvidenceRecord.metadata.verification_provenance,
          review_method: "OWNER_DIRECT_APPROVAL",
          owner_approved_by: item.reviewer,
          owner_approved_at: item.reviewed_at,
        },
      },
    };
    const verifiedFact = {
      ...candidateFactRecord,
      verification_status: "VERIFIED",
      attributes: {
        ...candidateFactRecord.attributes,
        review_provenance: {
          ...candidateFactRecord.attributes.review_provenance,
          review_method: "OWNER_DIRECT_APPROVAL",
          owner_disposition: "ACCEPTED",
          owner_approved_by: item.reviewer,
          owner_approved_at: item.reviewed_at,
        },
      },
    };

    const evErrors = validateEvidenceRecord(verifiedEvidence);
    if (evErrors.length) reasons.push(`evidence ${verifiedEvidence.evidence_id}: ${evErrors.join("; ")}`);
    const factErrors = validateFactRecord(verifiedFact);
    if (factErrors.length) reasons.push(`fact ${verifiedFact.fact_id}: ${factErrors.join("; ")}`);

    promotedEvidence.push(verifiedEvidence);
    promotedFacts.push(verifiedFact);
    newSlots.push({
      slot_key: `${item.question_id}::${item.slot_name}`,
      corp_code: verifiedFact.corp_code,
      metric_code: verifiedFact.metric_code,
      period_key: `as_of:${verifiedFact.as_of_date}`,
      scope: verifiedFact.scope,
      coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
      verification_status: "VERIFIED",
      fact_ids: [verifiedFact.fact_id],
      evidence_ids: [verifiedEvidence.evidence_id],
      reason_code: null,
    });
  }
  if (reasons.length) throw new PromotionBlockedError(reasons);

  const [baselineEvidence, baselineFacts, baselineCoverageText] = await Promise.all([
    readJsonlAbs(paths.baselineEvidencePath),
    readJsonlAbs(paths.baselineFactsPath),
    readFile(paths.baselineCoveragePath, "utf8"),
  ]);
  const baselineCoverage = JSON.parse(baselineCoverageText);

  const outputEvidence = [...baselineEvidence, ...promotedEvidence].sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
  const outputFacts = [...baselineFacts, ...promotedFacts];
  const outputSlots = [...baselineCoverage.slots, ...newSlots];
  const factCoverageSnapshotId = `fact_coverage_snapshot_${sha256(Buffer.from(JSON.stringify(outputSlots))).slice(0, 24)}`;
  const promotedAt = options.promotedAt ?? new Date().toISOString();
  const outputCoverage = {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: factCoverageSnapshotId,
    corpus_snapshot_id: baselineCoverage.corpus_snapshot_id,
    semantic_bundle_schema_version: baselineCoverage.semantic_bundle_schema_version,
    producer_version: "seed-v06-metric-gap-closure-batch-promotion",
    created_at: promotedAt,
    slots: outputSlots,
  };
  const covErrors = validateFactCoverageSnapshot(outputCoverage);
  if (covErrors.length) throw new PromotionBlockedError(covErrors.map((e) => `coverage: ${e}`));

  if (paths.outputEvidencePath) await writeFile(paths.outputEvidencePath, jsonl(outputEvidence), "utf8");
  if (paths.outputFactsPath) await writeFile(paths.outputFactsPath, jsonl(outputFacts), "utf8");
  if (paths.outputCoveragePath) await writeFile(paths.outputCoveragePath, `${JSON.stringify(outputCoverage, null, 2)}\n`, "utf8");

  const receipt = {
    promoted_at: promotedAt,
    decision_artifact_path: decisionPath,
    decision_artifact_sha256: actualSha256,
    promoted_items: decisionItems.map((item) => ({
      fact_id: item.fact_id, evidence_id: item.evidence_id, reviewer: item.reviewer, reviewed_at: item.reviewed_at,
    })),
    output_evidence_path: paths.outputEvidencePath, output_evidence_count: outputEvidence.length,
    output_facts_path: paths.outputFactsPath, output_facts_count: outputFacts.length,
    output_coverage_path: paths.outputCoveragePath, output_coverage_slot_count: outputSlots.length,
    fact_coverage_snapshot_id: factCoverageSnapshotId,
  };
  if (paths.receiptPath) await writeFile(paths.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--decision") args.decisionPath = argv[++i];
    else if (argv[i] === "--expected-sha256") args.expectedSha256 = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.decisionPath) {
    console.error("usage: node scripts/promote-seed-fact-batch-v06.mjs --decision <path-to-owner-decision.jsonl> [--expected-sha256 <hex>]");
    process.exit(1);
  }
  const receipt = await promoteSeedFactBatch(args);
  console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
