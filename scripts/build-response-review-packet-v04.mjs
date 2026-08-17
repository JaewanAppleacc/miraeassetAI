// Split review packet (this turn): DETAILED review for the 6 questions
// directly implicated in this turn's corp_code-exposure blocker and its
// fixes (Q13/Q16: entity-label resolution; Q17/Q19/Q21: Owner-policy
// timeline items already flagged in prior turns; Q22: parser-removal
// rendering sufficiency) -- everyone else gets a lighter SENTENCE_QUALITY
// pass only. This does NOT re-run Gold/Evidence fact-checking (already
// done in prior turns' Owner decision v0.2 / structured review) -- it
// only re-checks what THIS turn's Runtime changes could plausibly have
// affected: entity labels, no corp_code leak, dedup, unit/precision,
// qualifier/attribution preservation, Event scope honesty.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r2");
const WIRE_INDEX_PATH = path.join(WIRE_DIR, "index.json");
const HARNESS_RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r2.jsonl");
const PRIOR_PACKET_MANIFEST_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.3.manifest.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PACKET_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.4.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.4.manifest.json");

const DETAILED_REVIEW_QIDS = new Set([
  "question_seed_v07_13", "question_seed_v07_16", "question_seed_v07_17",
  "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_22",
]);

const DETAILED_CHECKLIST = Object.freeze({
  no_corp_code_exposed_as_name: null,
  entity_label_resolution_honest: null,
  no_internal_key_exposed: null,
  natural_korean: null,
  units_and_precision_correct: null,
  no_duplicate_sentences: null,
  qualifier_attribution_preserved: null,
  event_scope_limitation_disclosed: null,
  no_missed_sub_request: null,
});
const SENTENCE_QUALITY_CHECKLIST = Object.freeze({
  natural_korean: null,
  no_internal_key_or_corp_code_exposed: null,
  no_duplicate_sentences: null,
});

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  const [wireIndex, harnessLines, priorManifestBytes] = await Promise.all([
    readFile(WIRE_INDEX_PATH, "utf8").then(JSON.parse),
    readFile(HARNESS_RESULT_PATH, "utf8").then((t) => t.trim().split("\n").map(JSON.parse)),
    readFile(PRIOR_PACKET_MANIFEST_PATH),
  ]);
  const reviewRequiredByQid = new Map();
  for (const record of harnessLines) {
    const names = Object.entries(record.metric_results).filter(([, m]) => m.status === "REVIEW_REQUIRED").map(([name]) => name);
    if (names.length) reviewRequiredByQid.set(record.question_id, names);
  }

  const packetLines = [];
  for (const entry of wireIndex.entries) {
    const raw = await readFile(path.join(REPO, entry.path), "utf8");
    const wire = JSON.parse(raw);
    const thinkTrace = typeof wire.think_trace === "string" ? JSON.parse(wire.think_trace) : wire.think_trace;
    const synthesis = thinkTrace?.validation?.synthesis ?? {};
    const isDetailed = DETAILED_REVIEW_QIDS.has(entry.question_id);
    packetLines.push({
      schema_version: "0.1.0",
      review_tier: isDetailed ? "DETAILED" : "SENTENCE_QUALITY",
      question_id: entry.question_id,
      question: wire.question,
      answer: wire.answer,
      applied_capabilities: synthesis.applied_capabilities ?? [],
      missing_capabilities: synthesis.missing_capabilities ?? [],
      qualifier_scope: synthesis.qualifier_scope ?? null,
      synthesis_status: synthesis.status ?? null,
      review_required_metric_names: reviewRequiredByQid.get(entry.question_id) ?? [],
      review_checklist: isDetailed ? { ...DETAILED_CHECKLIST } : { ...SENTENCE_QUALITY_CHECKLIST },
      note: isDetailed
        ? "DETAILED tier: this question is directly implicated in this turn's corp_code-exposure fix or an open Owner-policy item -- full checklist required."
        : "SENTENCE_QUALITY tier: not directly implicated this turn -- prose/formatting spot-check only, no re-review of underlying Gold/Evidence facts.",
      owner_disposition: "PENDING",
      reviewer: null,
      reviewed_at: null,
      notes: null,
    });
  }

  const packetText = packetLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const packetBytes = Buffer.from(packetText, "utf8");
  const wireIndexBytes = await readFile(WIRE_INDEX_PATH);

  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.4.jsonl",
    artifact_sha256: sha256(packetBytes),
    generated_at: new Date().toISOString(),
    total_questions: wireIndex.entries.length,
    detailed_review_count: DETAILED_REVIEW_QIDS.size,
    sentence_quality_count: wireIndex.entries.length - DETAILED_REVIEW_QIDS.size,
    detailed_review_question_ids: [...DETAILED_REVIEW_QIDS],
    supersedes: null,
    updates_from: {
      prior_packet_manifest_path: "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.3.manifest.json",
      prior_packet_manifest_sha256: sha256(priorManifestBytes),
    },
    source_wire_revision: {
      wire_index_path: "work/domain-seed/seed-harness-v07-wire.r2/index.json",
      wire_index_sha256: sha256(wireIndexBytes),
      wire_generated_at: wireIndex.generated_at,
      wire_revision: wireIndex.revision,
    },
    release_eligible: false,
    release_eligible_reason: "SANDBOX_EXPLORATION run against an intentionally dirty worktree, never a Release Gate input",
    owner_approval_status_of_all_records: "PENDING",
  };

  await writeFile(OUT_PACKET_PATH, packetText, "utf8");
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ total: wireIndex.entries.length, detailed: DETAILED_REVIEW_QIDS.size, sentence_quality: wireIndex.entries.length - DETAILED_REVIEW_QIDS.size, manifest_path: OUT_MANIFEST_PATH }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
