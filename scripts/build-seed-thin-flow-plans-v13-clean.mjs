// Turn M10 Section 7: builds Plan v0.13 clean candidate directly from
// Plan v0.12 clean candidate (Turn M8's own clean, Plan-v0.6-lineage
// baseline) -- the ONLY change is adding Q18's existing VERIFIED
// correction Event's own real Evidence id
// (evidence_027901c5fc28cf428810b88e, already VERIFIED, already the
// correction Event's own evidence_ids[0]) to Q18's Plan-level
// `evidence_ids` array. This makes an ALREADY-EXISTING VERIFIED Event
// (event_407a5f1c9f81db32e0cbe668, RIGHTS_ISSUE_DECISION_CORRECTION,
// 2024-07-10) reachable by the Flow's own generic, pre-existing
// evidence_ids-keyed EVENT query (thin-structured-flow.mjs queries
// events by evidence_ids -- see domain/adapters/seed-structured-query-
// adapter.mjs's EVENT matcher, which matches when the event's OWN
// evidence_ids overlaps the query's evidence_ids predicate). No new
// Fact, no new Event, no new Evidence, no new ontology token, no
// Sub-request revival -- purely a missing-connection fix within the
// EXISTING VERIFIED universe.
//
// All other 24 records must be byte-for-byte identical to Plan v0.12.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PLAN_PATH = "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl";
const BASE_PLAN_MANIFEST_PATH = "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json";
const OUT_PLAN_PATH = "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.jsonl";
const OUT_MANIFEST_PATH = "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.manifest.json";
const Q18_QUESTION_ID = "question_seed_v07_18";
const CORRECTION_EVENT_EVIDENCE_ID = "evidence_027901c5fc28cf428810b88e";
const CORRECTION_EVENT_ID = "event_407a5f1c9f81db32e0cbe668";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M10_PLAN_V13_BUILD_BLOCKED: ${msg}`); }
async function readAbs(rel) { return readFile(path.join(REPO, rel)); }

export async function buildCleanPlanV13() {
  const baseBytes = await readAbs(BASE_PLAN_PATH);
  const baseSha256 = sha256(baseBytes);
  const baseRows = baseBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (baseRows.length !== 25) fail(`Plan v0.12 clean candidate does not have 25 records (found ${baseRows.length})`);

  // Independently re-verify the target Event is real, VERIFIED, and
  // genuinely carries the evidence_id we're about to wire in -- never
  // trust the header comment's own claim.
  const eventsBytes = await readAbs("work/domain-seed/seed-events-verified.v0.1.jsonl");
  const events = eventsBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const correctionEvent = events.find((e) => e.event_id === CORRECTION_EVENT_ID);
  if (!correctionEvent) fail(`${CORRECTION_EVENT_ID} not found in VERIFIED Event store`);
  if (correctionEvent.verification_status !== "VERIFIED") fail(`${CORRECTION_EVENT_ID} is not VERIFIED`);
  if (!Array.isArray(correctionEvent.evidence_ids) || !correctionEvent.evidence_ids.includes(CORRECTION_EVENT_EVIDENCE_ID)) {
    fail(`${CORRECTION_EVENT_ID}.evidence_ids does not include ${CORRECTION_EVENT_EVIDENCE_ID}`);
  }
  const evidenceBytes = await readAbs("work/domain-seed/seed-evidence-verified.v0.9.jsonl");
  const evidenceRows = evidenceBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const correctionEvidence = evidenceRows.find((e) => e.evidence_id === CORRECTION_EVENT_EVIDENCE_ID);
  if (!correctionEvidence) fail(`${CORRECTION_EVENT_EVIDENCE_ID} not found in VERIFIED Evidence store`);
  if (correctionEvidence.verification_status !== "VERIFIED") fail(`${CORRECTION_EVENT_EVIDENCE_ID} is not VERIFIED`);

  const outRows = [];
  const changedQuestionIds = [];
  for (const baseRow of baseRows) {
    if (baseRow.question_id !== Q18_QUESTION_ID) {
      outRows.push(baseRow);
      continue;
    }
    if (baseRow.evidence_ids.includes(CORRECTION_EVENT_EVIDENCE_ID)) fail("Q18 base row already carries the correction evidence_id -- base assumption violated");
    const newRow = { ...baseRow, evidence_ids: [...baseRow.evidence_ids, CORRECTION_EVENT_EVIDENCE_ID].sort() };
    if (JSON.stringify(newRow) === JSON.stringify(baseRow)) fail("Q18 row did not actually change");
    outRows.push(newRow);
    changedQuestionIds.push(baseRow.question_id);
  }
  if (outRows.length !== 25) fail(`expected 25 output rows, built ${outRows.length}`);
  if (changedQuestionIds.length !== 1 || changedQuestionIds[0] !== Q18_QUESTION_ID) fail(`expected exactly Q18 to change, got ${JSON.stringify(changedQuestionIds)}`);

  // Every non-Q18 row must be byte-for-byte identical to its v0.12 base row.
  for (let i = 0; i < baseRows.length; i++) {
    if (baseRows[i].question_id === Q18_QUESTION_ID) continue;
    if (JSON.stringify(outRows[i]) !== JSON.stringify(baseRows[i])) fail(`${baseRows[i].question_id}: unexpectedly changed vs Plan v0.12`);
    if (Object.hasOwn(outRows[i], "sub_requests")) fail(`${baseRows[i].question_id}: unexpectedly carries sub_requests`);
  }

  const outputText = `${outRows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const outputBytes = Buffer.from(outputText, "utf8");

  const baseManifest = JSON.parse((await readAbs(BASE_PLAN_MANIFEST_PATH)).toString("utf8"));
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    based_on: { path: BASE_PLAN_PATH, sha256: baseSha256 },
    explicitly_not_based_on: {
      note: "This is a pure, single-question addition on top of Plan v0.12 clean candidate (itself based on Plan v0.6, not the v0.7-v0.11 Candidate research lineage). No sub_request_authority, no new ontology token, no new Fact/Event.",
    },
    changed_question_ids: changedQuestionIds,
    unchanged_question_ids: outRows.filter((r) => r.question_id !== Q18_QUESTION_ID).map((r) => r.question_id),
    per_question_diff: [{
      question_id: Q18_QUESTION_ID,
      change: "added_top_level_evidence_id",
      added_evidence_id: CORRECTION_EVENT_EVIDENCE_ID,
      reason: "makes the already-existing VERIFIED correction Event reachable via the Flow's existing evidence_ids-keyed EVENT query -- no new Fact/Event/Evidence authored",
      target_event_id: CORRECTION_EVENT_ID,
    }],
    sub_request_authority_present: false,
    corpus_snapshot_id: baseManifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: baseManifest.fact_coverage_snapshot_id,
    source_gold: baseManifest.source_gold,
    source_gold_sha256: baseManifest.source_gold_sha256,
    source_coverage: baseManifest.source_coverage,
    source_coverage_sha256: baseManifest.source_coverage_sha256,
    record_count: outRows.length,
    artifact_sha256: sha256(outputBytes),
    base_plan_v012_sha256: baseSha256,
  };

  return { outputBytes, manifest };
}

async function main() {
  const { outputBytes, manifest } = await buildCleanPlanV13();
  await mkdir(path.join(REPO, path.dirname(OUT_PLAN_PATH)), { recursive: true });
  await writeFile(path.join(REPO, OUT_PLAN_PATH), outputBytes);
  await writeFile(path.join(REPO, OUT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    output_plan_path: OUT_PLAN_PATH, output_plan_sha256: manifest.artifact_sha256,
    manifest_path: OUT_MANIFEST_PATH, changed_question_ids: manifest.changed_question_ids,
    base_sha256: manifest.base_plan_v012_sha256, record_count: manifest.record_count,
  }, null, 2));
}

// Guarded: buildCleanPlanV13 is imported directly by tests (a pure,
// read-only function) -- main() must only run when this file is executed
// as a script, never as a side effect of being imported, or every test
// run would silently rewrite the on-disk plan/manifest with a fresh
// generated_at timestamp and invalidate any already-built sandbox release
// pin.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
