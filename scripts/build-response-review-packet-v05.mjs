// Turn J §5: same DETAILED(6)/SENTENCE_QUALITY(19) split as v0.4, rebuilt
// from the r3 wire (post: real CompanyResolver binding + timeline policy
// decision). Never re-runs Gold/Evidence fact-checking. Checklist items
// per Turn J's exact spec:
//   - 질문의 모든 하위 요구사항에 답했는가
//   - 기업·기간·단위 라벨이 자연스러운가
//   - 내부 key/corp_code가 노출되지 않는가
//   - 회사 주장·정보한계·한정표현이 보존됐는가
//   - 중복 문장이 없는가
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r3");
const WIRE_INDEX_PATH = path.join(WIRE_DIR, "index.json");
const HARNESS_RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r3.jsonl");
const PRIOR_PACKET_MANIFEST_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.4.manifest.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PACKET_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.5.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.5.manifest.json");

const DETAILED_REVIEW_QIDS = new Set([
  "question_seed_v07_13", "question_seed_v07_16", "question_seed_v07_17",
  "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_22",
]);

const CHECKLIST = Object.freeze({
  answers_every_sub_request: null,
  entity_period_unit_labels_natural: null,
  no_internal_key_or_corp_code_exposed: null,
  company_claims_information_limits_qualifiers_preserved: null,
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
      review_checklist: { ...CHECKLIST },
      note: isDetailed
        ? "DETAILED tier: implicated in Turn J's corp_code-exposure fix, CompanyResolver release binding, or the timeline Fact-narrative policy -- full checklist required."
        : "SENTENCE_QUALITY tier: lighter prose/formatting spot-check -- no re-review of underlying Gold/Evidence facts.",
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
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.5.jsonl",
    artifact_sha256: sha256(packetBytes),
    generated_at: new Date().toISOString(),
    total_questions: wireIndex.entries.length,
    detailed_review_count: DETAILED_REVIEW_QIDS.size,
    sentence_quality_count: wireIndex.entries.length - DETAILED_REVIEW_QIDS.size,
    detailed_review_question_ids: [...DETAILED_REVIEW_QIDS],
    supersedes: null,
    updates_from: {
      prior_packet_manifest_path: "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.4.manifest.json",
      prior_packet_manifest_sha256: sha256(priorManifestBytes),
    },
    source_wire_revision: {
      wire_index_path: "work/domain-seed/seed-harness-v07-wire.r3/index.json",
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
