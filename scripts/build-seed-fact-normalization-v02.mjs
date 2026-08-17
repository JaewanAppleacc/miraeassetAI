import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = "2026-08-13T03:00:00.000Z";
const PATHS = Object.freeze({
  facts: "work/domain-seed/seed-facts-verified.v0.1.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.1.json",
  delta: "work/domain-seed/seed-fact-normalization-v0.2.delta.jsonl",
  review: "work/domain-seed/seed-fact-normalization-v0.2.review-queue.jsonl",
  report: "work/domain-seed/seed-fact-normalization-v0.2.report.md",
});

const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
const serializeJsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function isScaleMigrationCandidate(fact) {
  return fact.value_type === "NUMERIC" && fact.unit === "KRW" && fact.currency === "KRW" &&
    typeof fact.normalized_value === "number" && Number.isFinite(fact.normalized_value) &&
    typeof fact.scale === "number" && Number.isFinite(fact.scale) && fact.scale !== 1;
}

export async function buildSeedFactNormalizationV02({ root = rootDefault, paths = PATHS, writeOutputs = true, generatedAt = GENERATED_AT } = {}) {
  const resolved = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [factBytes, coverageBytes] = await Promise.all([readFile(resolved.facts), readFile(resolved.coverage)]);
  const facts = parseJsonl(new TextDecoder("utf-8", { fatal: true }).decode(factBytes));
  const coverage = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(coverageBytes));
  const slotsByFact = new Map();
  for (const slot of coverage.slots ?? []) for (const factId of slot.fact_ids ?? []) {
    const slots = slotsByFact.get(factId) ?? [];
    slots.push(slot.slot_key); slotsByFact.set(factId, slots);
  }

  const delta = [];
  const review = [];
  for (const source of facts.filter(isScaleMigrationCandidate)) {
    const canonicalValue = source.normalized_value * source.scale;
    if (!Number.isSafeInteger(canonicalValue)) throw new Error(`${source.fact_id}: canonical KRW value is not a safe integer`);
    const candidate = structuredClone(source);
    candidate.normalized_value = canonicalValue;
    candidate.scale = 1;
    candidate.verification_status = "CANDIDATE";
    candidate.attributes = {
      ...candidate.attributes,
      normalization_migration: {
        status: "PENDING_HUMAN_REVIEW",
        migration: "DISCLOSED_SCALE_TO_CANONICAL_KRW",
        generated_at: generatedAt,
        source_artifact: paths.facts,
        previous_normalized_value: source.normalized_value,
        previous_scale: source.scale,
        canonical_formula: "previous_normalized_value * previous_scale",
        evidence_ids_unchanged: true,
      },
    };
    const schemaErrors = validateFactRecord(candidate);
    if (schemaErrors.length) throw new Error(`${source.fact_id}: ${schemaErrors.join("; ")}`);
    delta.push(candidate);
    review.push({
      fact_id: source.fact_id,
      corp_code: source.corp_code,
      metric_code: source.metric_code,
      source_document_id: source.source_document_id,
      raw_label: source.raw_label,
      raw_value_text: source.raw_value_text,
      raw_unit_text: source.raw_unit_text,
      previous_normalized_value: source.normalized_value,
      previous_scale: source.scale,
      proposed_normalized_value_krw: canonicalValue,
      proposed_scale: 1,
      affected_slot_keys: [...(slotsByFact.get(source.fact_id) ?? [])].sort(),
      evidence_ids: [...source.evidence_ids],
      review_status: "PENDING_HUMAN_REVIEW",
      required_checks: [
        "RAW_TABLE_UNIT_MATCHES_PREVIOUS_SCALE",
        "MULTIPLICATION_IS_EXACT",
        "PROPOSED_VALUE_IS_CANONICAL_KRW",
        "EVIDENCE_STILL_SUPPORTS_THE_SAME_FACT",
      ],
    });
  }
  delta.sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  review.sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  if (delta.length !== 16 || review.length !== 16) throw new Error("expected exactly 16 scale-normalization candidates");
  if (new Set(delta.map((item) => item.fact_id)).size !== delta.length) throw new Error("duplicate Fact ID in normalization delta");
  const questionIds = [...new Set(review.flatMap((item) => item.affected_slot_keys.map((key) => key.split("::", 1)[0])))].sort();
  const deltaText = serializeJsonl(delta);
  const reviewText = serializeJsonl(review);
  const report = `# Seed Fact normalization v0.2 CANDIDATE\n\n- Source VERIFIED Facts: 54 (immutable)\n- Proposed scale migrations: 16\n- scale 1,000: ${review.filter((item) => item.previous_scale === 1_000).length}\n- scale 1,000,000: ${review.filter((item) => item.previous_scale === 1_000_000).length}\n- Affected questions: ${questionIds.join(", ")}\n- Candidate status: PENDING_HUMAN_REVIEW\n- Runtime connected: NO\n- Source SHA-256: ${sha256(factBytes)}\n- Delta SHA-256: ${sha256(deltaText)}\n\nThe existing VERIFIED artifact and Coverage Snapshot are unchanged. Promotion requires a new Fact artifact, Coverage Snapshot, manifests, and Harness rerun.\n`;
  if (writeOutputs) {
    await mkdir(path.dirname(resolved.delta), { recursive: true });
    await Promise.all([writeFile(resolved.delta, deltaText), writeFile(resolved.review, reviewText), writeFile(resolved.report, report)]);
  }
  return Object.freeze({ delta, review, deltaText, reviewText, report, sourceFactSha256: sha256(factBytes), sourceCoverageSha256: sha256(coverageBytes), questionIds });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedFactNormalizationV02();
  console.log(JSON.stringify({ candidates: result.delta.length, affected_questions: result.questionIds.length }));
}
