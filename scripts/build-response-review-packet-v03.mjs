// Turn I §10: a versioned human review packet, mechanically selected from
// the LATEST 25-question SANDBOX wire capture -- never re-using an old
// question ordinal grouping. This NEVER overwrites the existing
// work/handoff/seed-final-response-owner-review/{results,packages}/
// A_Q17_*/C_Q22_* artifacts; it is a new, separate revision with explicit
// supersedes/source_wire_revision provenance so the audit trail stays
// intact. Owner disposition fields are all PENDING/null -- this script
// never self-approves.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire");
const WIRE_INDEX_PATH = path.join(WIRE_DIR, "index.json");
const HARNESS_RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.v0.1.jsonl");
const OWNER_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-response-owner-decision.v0.2.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PACKET_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.3.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-review-packet.v0.3.manifest.json");

// Turn H2/I audit trail (not Runtime code -- a data-selection list for
// building THIS review artifact, exactly the same class as v0.8's
// per-question authoring table): these 3 questions are where this
// session found and fixed a real internal-key/qualifier exposure defect,
// so they are mechanically flagged for "previously exposed" review
// regardless of the OTHER selection criteria below.
const PREVIOUSLY_EXPOSED_INTERNAL_KEY_QIDS = new Set(["question_seed_v07_17", "question_seed_v07_20", "question_seed_v07_22"]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  const [wireIndex, harnessLines, ownerDecisions] = await Promise.all([
    readFile(WIRE_INDEX_PATH, "utf8").then(JSON.parse),
    readFile(HARNESS_RESULT_PATH, "utf8").then((t) => t.trim().split("\n").map(JSON.parse)),
    readFile(OWNER_DECISION_PATH, "utf8").then((t) => t.trim().split("\n").map(JSON.parse)),
  ]);

  const reviewRequiredByQid = new Map();
  for (const record of harnessLines) {
    const names = Object.entries(record.metric_results).filter(([, m]) => m.status === "REVIEW_REQUIRED").map(([name]) => name);
    if (names.length) reviewRequiredByQid.set(record.question_id, names);
  }

  const packetLines = [];
  const selectionSummary = [];
  for (const entry of wireIndex.entries) {
    const raw = await readFile(path.join(REPO, entry.path), "utf8");
    const wire = JSON.parse(raw);
    const thinkTrace = typeof wire.think_trace === "string" ? JSON.parse(wire.think_trace) : wire.think_trace;
    const synthesis = thinkTrace?.validation?.synthesis ?? {};
    const applied = synthesis.applied_capabilities ?? [];

    const hasCalculationRegistryLine = applied.includes("COMPARATIVE_CONCLUSION");
    const hasEventTimeline = applied.includes("TEMPORAL_EVENT_SYNTHESIS");
    const hasQualifierOrAttribution = applied.includes("QUALIFIER_PRESERVATION") || applied.includes("ATTRIBUTION_PRESERVATION");
    const hasReviewRequired = reviewRequiredByQid.has(entry.question_id);
    const wasPreviouslyExposed = PREVIOUSLY_EXPOSED_INTERNAL_KEY_QIDS.has(entry.question_id);

    const selected = hasCalculationRegistryLine || hasEventTimeline || hasQualifierOrAttribution || hasReviewRequired || wasPreviouslyExposed;
    selectionSummary.push({
      question_id: entry.question_id, selected,
      reasons: [
        ...(wasPreviouslyExposed ? ["PREVIOUSLY_EXPOSED_INTERNAL_KEY"] : []),
        ...(hasCalculationRegistryLine ? ["HAS_CALCULATION_REGISTRY_LINE"] : []),
        ...(hasEventTimeline ? ["HAS_EVENT_TIMELINE"] : []),
        ...(hasQualifierOrAttribution ? ["HAS_QUALIFIER_OR_ATTRIBUTION"] : []),
        ...(hasReviewRequired ? ["LATEST_REVIEW_REQUIRED"] : []),
      ],
    });
    if (!selected) continue;

    const relatedOwnerItems = ownerDecisions.filter((d) => d.question_id === entry.question_id);
    packetLines.push({
      schema_version: "0.1.0",
      question_id: entry.question_id,
      question: wire.question,
      answer: wire.answer,
      applied_capabilities: applied,
      qualifier_scope: synthesis.qualifier_scope ?? null,
      synthesis_status: synthesis.status ?? null,
      review_required_metric_names: reviewRequiredByQid.get(entry.question_id) ?? [],
      selection_reasons: selectionSummary.at(-1).reasons,
      related_owner_decision_v02_items: relatedOwnerItems.map((d) => d.review_item_id),
      review_checklist: {
        no_internal_key_exposed: null,
        natural_korean: null,
        units_and_precision_correct: null,
        no_duplicate_sentences: null,
        qualifier_attribution_preserved: null,
        event_scope_limitation_disclosed: null,
        no_missed_sub_request: null,
      },
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
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-review-packet.v0.3.jsonl",
    artifact_sha256: sha256(packetBytes),
    generated_at: new Date().toISOString(),
    total_questions: wireIndex.entries.length,
    selected_count: packetLines.length,
    selection_summary: selectionSummary,
    // This is a NEW, separate revision -- it never overwrites the
    // existing A_Q17_*/C_Q22_* packets or seed-response-owner-decision.v0.2.
    supersedes: null,
    updates_from: {
      seed_response_owner_decision_v02_path: "work/domain-seed/seed-response-owner-decision.v0.2.jsonl",
      seed_response_owner_decision_v02_sha256: sha256(await readFile(OWNER_DECISION_PATH)),
    },
    source_wire_revision: {
      wire_index_path: "work/domain-seed/seed-harness-v07-wire/index.json",
      wire_index_sha256: sha256(wireIndexBytes),
      wire_generated_at: wireIndex.generated_at,
    },
    release_eligible: false,
    release_eligible_reason: "SANDBOX_EXPLORATION run against an intentionally dirty worktree, never a Release Gate input",
    owner_approval_status_of_all_records: "PENDING",
  };

  await writeFile(OUT_PACKET_PATH, packetText, "utf8");
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ selected_count: packetLines.length, total: wireIndex.entries.length, manifest_path: OUT_MANIFEST_PATH }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
