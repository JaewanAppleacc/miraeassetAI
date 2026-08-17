import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ids } from "../domain/contracts.mjs";
import {
  SEMANTIC_BUNDLE_SCHEMA_VERSION,
  validateEventRecord,
  validateEvidenceRecord,
  validateFactCoverageSnapshot,
  validateFactRecord,
} from "../domain/adapters/seed-artifact-schema-validators.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_AT = "2026-08-13T01:00:30Z";
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const SOURCE_MANIFEST_SHA256 = "04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364";

const PATHS = Object.freeze({
  evidenceBase: "work/domain-seed/seed-evidence-verified.v0.3.jsonl",
  evidenceDelta: "work/domain-seed/seed-event-evidence-candidates.v0.2.delta.jsonl",
  factCandidates: "work/domain-seed/seed-fact-candidates.v0.1.jsonl",
  eventCandidates: "work/domain-seed/seed-event-candidates.v0.2.jsonl",
  coverageCandidates: "work/domain-seed/seed-fact-coverage-candidates.v0.2.json",
  relations: "work/domain-seed/seed-relation-gold.v0.1.jsonl",
  chains: "work/domain-seed/seed-chain-manifest.v0.1.jsonl",
  evidenceVerified: "work/domain-seed/seed-evidence-verified.v0.4.jsonl",
  evidenceManifest: "work/domain-seed/seed-evidence-verified.v0.4.manifest.json",
  factsVerified: "work/domain-seed/seed-facts-verified.v0.1.jsonl",
  eventsVerified: "work/domain-seed/seed-events-verified.v0.1.jsonl",
  coverageVerified: "work/domain-seed/seed-fact-coverage-verified.v0.1.json",
  decision: "work/domain-seed/seed-structured-owner-decision.v0.1.json",
  manifest: "work/domain-seed/seed-structured-artifacts.v0.1.manifest.json",
  report: "work/domain-seed/seed-structured-promotion-report.v0.1.md",
});

function parseJsonLines(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${source}:${index + 1}: ${error.message}`); }
  });
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const serializeJsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

function assertSchema(records, validate, label) {
  records.forEach((record, index) => {
    const errors = validate(record);
    if (errors.length) throw new Error(`${label}:${index + 1}: ${errors.join("; ")}`);
  });
}

function approveEvidence(record, approvedAt) {
  return {
    ...structuredClone(record),
    verification_status: "VERIFIED",
    metadata: {
      ...structuredClone(record.metadata),
      review_status: "OWNER_ACCEPTED",
      verification_provenance: {
        review_method: "CODEX_INDEPENDENT_REVIEW_OWNER_ACCEPTED",
        owner_disposition: "ACCEPTED",
        approval_basis: "SEED_EVENT_PROVENANCE_V02_CODEX_REVIEW",
        secondary_ai_review: "SKIPPED_BY_OWNER_INSTRUCTION",
        corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
        source_candidate_artifact: "work/domain-seed/seed-event-evidence-candidates.v0.2.delta.jsonl",
        decision_record: "work/domain-seed/seed-structured-owner-decision.v0.1.json",
        verified_at: approvedAt,
      },
    },
  };
}

function approveStructuredRecord(record, approvedAt, sourceArtifact) {
  return {
    ...structuredClone(record),
    verification_status: "VERIFIED",
    attributes: {
      ...structuredClone(record.attributes),
      review_provenance: {
        review_method: "CODEX_INDEPENDENT_REVIEW_OWNER_ACCEPTED",
        owner_disposition: "ACCEPTED",
        secondary_ai_review: "SKIPPED_BY_OWNER_INSTRUCTION",
        source_candidate_artifact: sourceArtifact,
        decision_record: "work/domain-seed/seed-structured-owner-decision.v0.1.json",
        verified_at: approvedAt,
      },
    },
  };
}

function artifactEntry(role, artifactPath, content, recordCount) {
  return { role, path: artifactPath, sha256: sha256(content), bytes: Buffer.byteLength(content), record_count: recordCount };
}

function report(summary) {
  return `# Seed structured artifact promotion v0.1\n\n- Evidence VERIFIED: ${summary.evidence_count}\n- Fact VERIFIED: ${summary.fact_count}\n- Event VERIFIED: ${summary.event_count}\n- Coverage VERIFIED slots: ${summary.coverage_slot_count}\n- Coverage state: ${JSON.stringify(summary.coverage_states)}\n- Owner acceptance: recorded\n- Secondary Claude review: skipped by Owner instruction\n- Q3/Q22: excluded and not represented in Fact/Event/Coverage\n- Whole Seed release: still DRAFT until the two excluded questions and Flow/API E2E are resolved\n`;
}

export async function promoteSeedStructuredArtifacts({ root = rootDefault, paths = PATHS, writeOutputs = true, approvedAt = APPROVED_AT } = {}) {
  const p = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [evidenceBaseText, evidenceDeltaText, factText, eventText, coverageText, relationText, chainText] = await Promise.all([
    readFile(p.evidenceBase, "utf8"), readFile(p.evidenceDelta, "utf8"), readFile(p.factCandidates, "utf8"),
    readFile(p.eventCandidates, "utf8"), readFile(p.coverageCandidates, "utf8"), readFile(p.relations, "utf8"), readFile(p.chains, "utf8"),
  ]);
  const baseEvidence = parseJsonLines(evidenceBaseText, paths.evidenceBase);
  const deltaEvidence = parseJsonLines(evidenceDeltaText, paths.evidenceDelta);
  const factCandidates = parseJsonLines(factText, paths.factCandidates);
  const eventCandidates = parseJsonLines(eventText, paths.eventCandidates);
  const coverageCandidate = JSON.parse(coverageText);
  const relations = parseJsonLines(relationText, paths.relations);
  const chains = parseJsonLines(chainText, paths.chains);

  if (baseEvidence.length !== 136 || deltaEvidence.length !== 24 || factCandidates.length !== 54 || eventCandidates.length !== 24 || coverageCandidate.slots?.length !== 69) {
    throw new Error("unexpected Candidate artifact counts");
  }
  if (deltaEvidence.some((record) => record.verification_status !== "CANDIDATE") || factCandidates.some((record) => record.verification_status !== "CANDIDATE") || eventCandidates.some((record) => record.verification_status !== "CANDIDATE")) {
    throw new Error("source Candidate was already promoted");
  }
  if (coverageCandidate.slots.some((slot) => slot.verification_status !== "PENDING_HUMAN_REVIEW")) throw new Error("Coverage source is not pending-only");

  const promotedDelta = deltaEvidence.map((record) => approveEvidence(record, approvedAt));
  const evidenceVerified = [...baseEvidence.map((record) => structuredClone(record)), ...promotedDelta];
  const factsVerified = factCandidates.map((record) => approveStructuredRecord(record, approvedAt, paths.factCandidates));
  const eventsVerified = eventCandidates.map((record) => approveStructuredRecord(record, approvedAt, paths.eventCandidates));
  const evidenceIds = new Set(evidenceVerified.map((record) => record.evidence_id));
  const factIds = new Set(factsVerified.map((record) => record.fact_id));
  const eventIds = new Set(eventsVerified.map((record) => record.event_id));
  const chainIds = new Set(chains.map((record) => record.chain_id));
  if (evidenceIds.size !== evidenceVerified.length || factIds.size !== factsVerified.length || eventIds.size !== eventsVerified.length) throw new Error("duplicate ID in promoted artifacts");

  for (const fact of factsVerified) {
    if (fact.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${fact.fact_id}: unresolved Evidence`);
    if (fact.event_id && !eventIds.has(fact.event_id)) throw new Error(`${fact.fact_id}: unresolved Event`);
  }
  for (const event of eventsVerified) {
    if (event.evidence_ids.length === 0 || event.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${event.event_id}: unresolved Evidence`);
    if (!chainIds.has(event.chain_id)) throw new Error(`${event.event_id}: unresolved Chain`);
  }
  if (relations.length !== 40 || relations.some((relation) => relation.verification_status !== "VERIFIED" || !chainIds.has(relation.chain_id))) {
    throw new Error("Relation Gold is not a complete VERIFIED/Chain-bound set");
  }
  for (const relation of relations) if (relation.event_id && !eventIds.has(relation.event_id)) throw new Error(`${relation.relation_id}: unresolved Event`);

  const coverageCreatedAt = approvedAt;
  const coverageVerified = {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: ids.factCoverageSnapshot(CORPUS_SNAPSHOT_ID, SEMANTIC_BUNDLE_SCHEMA_VERSION, coverageCreatedAt),
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    semantic_bundle_schema_version: SEMANTIC_BUNDLE_SCHEMA_VERSION,
    producer_version: "seed-structured-verified-v0.1",
    created_at: coverageCreatedAt,
    slots: coverageCandidate.slots.map((slot) => ({
      slot_key: slot.slot_key, corp_code: slot.corp_code, metric_code: slot.metric_code,
      period_key: slot.period_key ?? null, scope: slot.scope ?? null,
      coverage_state: slot.candidate_status === "NOT_APPLICABLE" ? "FACT_SLOT_VERIFIED_NOT_APPLICABLE" : "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
      verification_status: "VERIFIED", fact_ids: [...slot.fact_ids], evidence_ids: [...slot.evidence_ids],
      reason_code: slot.candidate_status === "NOT_APPLICABLE" ? "FINANCIAL_HOLDING_COMPANY_NO_REVENUE_LINE_ITEM" : (slot.reason_code ?? null),
    })),
  };
  for (const slot of coverageVerified.slots) {
    if (slot.fact_ids.some((id) => !factIds.has(id))) throw new Error(`${slot.slot_key}: unresolved Fact`);
    if (slot.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${slot.slot_key}: unresolved Evidence`);
  }

  assertSchema(evidenceVerified, validateEvidenceRecord, "Evidence");
  assertSchema(factsVerified, validateFactRecord, "Fact");
  assertSchema(eventsVerified, validateEventRecord, "Event");
  const coverageErrors = validateFactCoverageSnapshot(coverageVerified);
  if (coverageErrors.length) throw new Error(`Coverage: ${coverageErrors.join("; ")}`);

  const evidenceContent = serializeJsonl(evidenceVerified);
  const factContent = serializeJsonl(factsVerified);
  const eventContent = serializeJsonl(eventsVerified);
  const coverageContent = `${JSON.stringify(coverageVerified, null, 2)}\n`;
  const decision = {
    schema_version: "0.1.0", decision_id: "seed-structured-owner-decision-v0.1", decided_at: approvedAt,
    owner_disposition: "ACCEPTED", review_basis: "CODEX_INDEPENDENT_REVIEW_ACCEPTED_BY_OWNER",
    secondary_ai_review: "SKIPPED_BY_OWNER_INSTRUCTION",
    accepted_inputs: [paths.evidenceDelta, paths.factCandidates, paths.eventCandidates, paths.coverageCandidates],
    safeguards: ["SOURCE_CANDIDATES_IMMUTABLE", "NO_Q3_Q22", "ALL_CROSS_REFERENCES_RESOLVE", "SCHEMA_VALIDATION_REQUIRED"],
    limitations: ["TABLE_ROW_COMPOSITE_EVENT_EVIDENCE_REQUIRES_MULTIPLE_CELLS", "NO_SECOND_CLAUDE_REVIEW"],
  };
  const decisionContent = `${JSON.stringify(decision, null, 2)}\n`;

  const evidenceManifest = {
    schema_version: "0.1.0", artifact: path.basename(paths.evidenceVerified), artifact_sha256: sha256(evidenceContent),
    generated_at: approvedAt, corpus_snapshot_id: CORPUS_SNAPSHOT_ID, authored_against_manifest_sha256: SOURCE_MANIFEST_SHA256,
    source_v03_artifact: paths.evidenceBase, source_event_delta: paths.evidenceDelta,
    supersedes: "seed-evidence-verified.v0.3 (source preserved)", record_count: evidenceVerified.length,
    new_record_count: promotedDelta.length, evidence_ids: [...evidenceIds].sort(), decision_record: paths.decision,
  };
  const evidenceManifestContent = `${JSON.stringify(evidenceManifest, null, 2)}\n`;
  const artifacts = [
    artifactEntry("VERIFIED_EVIDENCE", paths.evidenceVerified, evidenceContent, evidenceVerified.length),
    artifactEntry("VERIFIED_EVIDENCE_MANIFEST", paths.evidenceManifest, evidenceManifestContent, null),
    artifactEntry("VERIFIED_FACT", paths.factsVerified, factContent, factsVerified.length),
    artifactEntry("VERIFIED_EVENT", paths.eventsVerified, eventContent, eventsVerified.length),
    artifactEntry("VERIFIED_RELATION", paths.relations, relationText, relations.length),
    artifactEntry("FACT_COVERAGE_SNAPSHOT", paths.coverageVerified, coverageContent, coverageVerified.slots.length),
    artifactEntry("OWNER_DECISION", paths.decision, decisionContent, null),
  ];
  const manifest = {
    schema_version: "0.1.0", artifact_set_id: "seed-structured-artifacts-v0.1", status: "VERIFIED_SEED_SUBSET",
    generated_at: approvedAt, corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: coverageVerified.fact_coverage_snapshot_id, semantic_bundle_schema_version: SEMANTIC_BUNDLE_SCHEMA_VERSION,
    artifacts, excluded_question_ids: ["question_seed_v07_03", "question_seed_v07_22"],
    release_status: "DRAFT_UNTIL_FLOW_API_E2E_AND_EXCLUDED_QUESTIONS_RESOLVED",
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const coverageStates = Object.fromEntries([...new Set(coverageVerified.slots.map((slot) => slot.coverage_state))].sort().map((state) => [state, coverageVerified.slots.filter((slot) => slot.coverage_state === state).length]));
  const summary = { evidence_count: evidenceVerified.length, fact_count: factsVerified.length, event_count: eventsVerified.length,
    coverage_slot_count: coverageVerified.slots.length, coverage_states: coverageStates,
    fact_coverage_snapshot_id: coverageVerified.fact_coverage_snapshot_id, excluded_question_ids: manifest.excluded_question_ids,
    secondary_ai_review: decision.secondary_ai_review, promotion_complete: true, full_release_ready: false };

  if (writeOutputs) {
    await mkdir(path.dirname(p.evidenceVerified), { recursive: true });
    await Promise.all([
      writeFile(p.evidenceVerified, evidenceContent), writeFile(p.evidenceManifest, evidenceManifestContent),
      writeFile(p.factsVerified, factContent), writeFile(p.eventsVerified, eventContent), writeFile(p.coverageVerified, coverageContent),
      writeFile(p.decision, decisionContent), writeFile(p.manifest, manifestContent), writeFile(p.report, report(summary)),
    ]);
  }
  return { evidenceVerified, factsVerified, eventsVerified, coverageVerified, decision, manifest, summary, contents: { evidenceContent, factContent, eventContent, coverageContent, evidenceManifestContent, decisionContent, manifestContent } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { summary } = await promoteSeedStructuredArtifacts();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
