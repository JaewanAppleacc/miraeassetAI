import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import { SEMANTIC_BUNDLE_SCHEMA_VERSION, validateFactCoverageSnapshot, validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SEED_FACT_NORMALIZATION_PROMOTION_PATHS = Object.freeze({
  sourceManifest: "work/domain-seed/seed-structured-artifacts.v0.1.manifest.json",
  sourceFacts: "work/domain-seed/seed-facts-verified.v0.1.jsonl",
  sourceCoverage: "work/domain-seed/seed-fact-coverage-verified.v0.1.json",
  candidates: "work/domain-seed/seed-fact-normalization-v0.2.delta.jsonl",
  reviewQueue: "work/domain-seed/seed-fact-normalization-v0.2.review-queue.jsonl",
  ownerDecision: "work/domain-seed/seed-fact-normalization-v0.2.owner-decision.jsonl",
  factsVerified: "work/domain-seed/seed-facts-verified.v0.2.jsonl",
  coverageVerified: "work/domain-seed/seed-fact-coverage-verified.v0.2.json",
  manifest: "work/domain-seed/seed-structured-artifacts.v0.2.manifest.json",
  report: "work/domain-seed/seed-fact-normalization-v0.2.promotion-report.md",
});
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const APPROVED_AT = "2026-08-13T04:00:00.000Z";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const parseJsonl = (text, source) => text.split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch (error) { throw new Error(`${source}:${index + 1}: ${error.message}`); }
});

function validateDecisions(decisions, review) {
  if (decisions.length !== review.length) throw new Error("NORMALIZATION_REVIEW_INCOMPLETE: decision count mismatch");
  const decisionById = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision !== "object" || typeof decision.fact_id !== "string" || decisionById.has(decision.fact_id)) throw new Error("NORMALIZATION_REVIEW_INVALID: duplicate/invalid fact_id");
    if (!['APPROVE', 'REJECT'].includes(decision.disposition)) throw new Error(`${decision.fact_id}: disposition must be APPROVE or REJECT`);
    if (typeof decision.reviewer !== "string" || decision.reviewer.trim() === "") throw new Error(`${decision.fact_id}: reviewer is required`);
    if (typeof decision.decided_at !== "string" || !Number.isFinite(Date.parse(decision.decided_at))) throw new Error(`${decision.fact_id}: decided_at is invalid`);
    if (typeof decision.proposed_normalized_value_krw !== "number" || !Number.isSafeInteger(decision.proposed_normalized_value_krw)) throw new Error(`${decision.fact_id}: proposed value is invalid`);
    decisionById.set(decision.fact_id, decision);
  }
  for (const item of review) {
    const decision = decisionById.get(item.fact_id);
    if (!decision) throw new Error(`NORMALIZATION_REVIEW_INCOMPLETE: ${item.fact_id}`);
    if (decision.proposed_normalized_value_krw !== item.proposed_normalized_value_krw) throw new Error(`${item.fact_id}: decision does not bind the reviewed proposed value`);
  }
  const rejected = decisions.filter((decision) => decision.disposition !== "APPROVE");
  if (rejected.length) throw new Error(`NORMALIZATION_REVIEW_REJECTED: ${rejected.map((item) => item.fact_id).join(",")}`);
  return decisionById;
}

export async function promoteSeedFactNormalizationV02({ root = rootDefault, paths = SEED_FACT_NORMALIZATION_PROMOTION_PATHS, writeOutputs = true, approvedAt = APPROVED_AT, decisionText = null } = {}) {
  const p = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [manifestText, factsText, coverageText, candidatesText, reviewText, decisionsRaw] = await Promise.all([
    readFile(p.sourceManifest, "utf8"), readFile(p.sourceFacts, "utf8"), readFile(p.sourceCoverage, "utf8"),
    readFile(p.candidates, "utf8"), readFile(p.reviewQueue, "utf8"),
    decisionText === null ? readFile(p.ownerDecision, "utf8") : Promise.resolve(decisionText),
  ]);
  const sourceManifest = JSON.parse(manifestText);
  const sourceFacts = parseJsonl(factsText, paths.sourceFacts);
  const sourceCoverage = JSON.parse(coverageText);
  const candidates = parseJsonl(candidatesText, paths.candidates);
  const review = parseJsonl(reviewText, paths.reviewQueue);
  const decisions = parseJsonl(decisionsRaw, paths.ownerDecision);
  if (sourceManifest.artifact_set_id !== "seed-structured-artifacts-v0.1" || sourceManifest.fact_coverage_snapshot_id !== sourceCoverage.fact_coverage_snapshot_id) throw new Error("source manifest/Coverage mismatch");
  if (candidates.length !== 16 || review.length !== 16 || sourceFacts.length !== 54 || sourceCoverage.slots.length !== 69) throw new Error("unexpected normalization artifact counts");
  const decisionById = validateDecisions(decisions, review);
  const candidateById = new Map(candidates.map((record) => [record.fact_id, record]));
  if (candidateById.size !== candidates.length) throw new Error("duplicate normalization candidate Fact ID");

  const factsVerified = sourceFacts.map((source) => {
    const candidate = candidateById.get(source.fact_id);
    if (!candidate) return structuredClone(source);
    const decision = decisionById.get(source.fact_id);
    const promoted = structuredClone(candidate);
    promoted.verification_status = "VERIFIED";
    promoted.attributes.normalization_migration = {
      ...promoted.attributes.normalization_migration,
      status: "OWNER_APPROVED",
      owner_decision_artifact: paths.ownerDecision,
      reviewer: decision.reviewer,
      decided_at: decision.decided_at,
      promoted_at: approvedAt,
    };
    const errors = validateFactRecord(promoted);
    if (errors.length) throw new Error(`${promoted.fact_id}: ${errors.join("; ")}`);
    return promoted;
  });
  if (factsVerified.filter((fact) => fact.attributes?.normalization_migration?.status === "OWNER_APPROVED").length !== 16) throw new Error("not all normalization candidates were promoted");

  const coverageVerified = structuredClone(sourceCoverage);
  coverageVerified.fact_coverage_snapshot_id = ids.factCoverageSnapshot(CORPUS_SNAPSHOT_ID, SEMANTIC_BUNDLE_SCHEMA_VERSION, approvedAt);
  coverageVerified.producer_version = "seed-structured-verified-v0.2-fact-normalization";
  coverageVerified.created_at = approvedAt;
  const coverageErrors = validateFactCoverageSnapshot(coverageVerified);
  if (coverageErrors.length) throw new Error(`Coverage: ${coverageErrors.join("; ")}`);
  const factContent = jsonl(factsVerified);
  const coverageContent = `${JSON.stringify(coverageVerified, null, 2)}\n`;
  const decisionContent = decisionsRaw.endsWith("\n") ? decisionsRaw : `${decisionsRaw}\n`;
  const unchangedRoles = new Set(["VERIFIED_EVIDENCE", "VERIFIED_EVIDENCE_MANIFEST", "VERIFIED_EVENT", "VERIFIED_RELATION", "OWNER_DECISION"]);
  const artifacts = sourceManifest.artifacts.filter((artifact) => unchangedRoles.has(artifact.role)).map((artifact) => structuredClone(artifact));
  artifacts.push(
    { role: "VERIFIED_FACT", path: paths.factsVerified, sha256: sha256(factContent), bytes: Buffer.byteLength(factContent), record_count: 54 },
    { role: "FACT_COVERAGE_SNAPSHOT", path: paths.coverageVerified, sha256: sha256(coverageContent), bytes: Buffer.byteLength(coverageContent), record_count: 69 },
    { role: "FACT_NORMALIZATION_DECISION", path: paths.ownerDecision, sha256: sha256(decisionContent), bytes: Buffer.byteLength(decisionContent), record_count: 16 },
  );
  const manifest = {
    ...structuredClone(sourceManifest),
    artifact_set_id: "seed-structured-artifacts-v0.2",
    generated_at: approvedAt,
    fact_coverage_snapshot_id: coverageVerified.fact_coverage_snapshot_id,
    artifacts,
    release_status: "DRAFT_UNTIL_V02_PLANS_AND_HARNESS_E2E",
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const report = `# Seed Fact normalization v0.2 promotion\n\n- Owner-approved migrations: 16\n- Facts: 54\n- Coverage slots: 69\n- New Coverage Snapshot: ${coverageVerified.fact_coverage_snapshot_id}\n- Runtime connected: NO (v0.2 plan rebuild required)\n- Full release: DRAFT\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(p.factsVerified), { recursive: true });
    await Promise.all([writeFile(p.factsVerified, factContent), writeFile(p.coverageVerified, coverageContent), writeFile(p.manifest, manifestContent), writeFile(p.report, report)]);
  }
  return Object.freeze({ factsVerified, coverageVerified, manifest, report, contents: { factContent, coverageContent, manifestContent } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await promoteSeedFactNormalizationV02();
  console.log(JSON.stringify({ facts: result.factsVerified.length, coverage_slots: result.coverageVerified.slots.length }));
}
