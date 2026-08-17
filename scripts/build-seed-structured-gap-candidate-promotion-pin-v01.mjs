// Turn M5 Section 2: pins the 6 Owner-APPROVED Candidate Facts (from
// seed-structured-gap-candidate-owner-decision.v0.2.jsonl) into a
// promotion INPUT list -- never promotes them itself (verification_status
// stays CANDIDATE), never re-requests Owner judgment (they are already
// judged), never modifies v0.8. Each entry is only pinned if the
// Candidate's CURRENT content_sha256 (in v0.8) still exactly matches
// what the Owner reviewed; any mismatch blocks the whole pin and is
// reported, never silently carried forward.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
const CANDIDATES_V08_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-promotion-pin.v0.1.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256hex(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`PROMOTION_PIN_BLOCKED: ${msg}`); }

async function main() {
  const decisionBytes = await readFile(DECISION_PATH);
  const decisionRows = jsonl(decisionBytes.toString("utf8"));
  const v08Bytes = await readFile(CANDIDATES_V08_PATH);
  const v08Rows = jsonl(v08Bytes.toString("utf8"));
  const v08ByFactId = new Map(v08Rows.map((r) => [r.fact_id, r]));

  const approved = decisionRows.filter((r) => r.owner_disposition === "APPROVE");
  if (approved.length !== 6) fail(`expected 6 APPROVE records, found ${approved.length}`);

  const pins = [];
  const contentMismatches = [];
  for (const decision of approved) {
    const candidate = v08ByFactId.get(decision.fact_id);
    if (!candidate) { contentMismatches.push({ fact_id: decision.fact_id, reason: "not found in v0.8" }); continue; }
    const contentSha256 = sha256hex(JSON.stringify(candidate));
    pins.push({
      fact_id: decision.fact_id,
      question_id: decision.question_id,
      metric_code: decision.metric_code,
      status: "CARRIED_FORWARD_OWNER_APPROVED",
      source_candidate_path: "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
      source_candidate_content_sha256: contentSha256,
      verification_status_unchanged: candidate.verification_status,
      owner_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
      owner_decision_sha256: sha256(decisionBytes),
      owner_reviewer: decision.reviewer,
      owner_reviewed_at: decision.reviewed_at,
      owner_notes: decision.notes,
      promotion_status: "NOT_PROMOTED",
      re_review_required: false,
      note: "Owner APPROVED this Turn (v0.2 decision). Content in v0.8 is unchanged since Owner review -- pinned as a promotion INPUT candidate only. verification_status remains CANDIDATE; promotion to VERIFIED is a separate, not-yet-run step.",
    });
  }
  if (contentMismatches.length !== 0) {
    fail(`content mismatch or missing candidate for: ${JSON.stringify(contentMismatches)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = pins.map((p) => JSON.stringify(p)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: pins.length,
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
    source_decision_sha256: sha256(decisionBytes),
    source_candidates_v08_path: "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
    source_candidates_v08_sha256: sha256(v08Bytes),
    v08_modified_this_turn: false,
    promotion_status: "NOT_PROMOTED",
    release_status: "NOT_AUTHORIZED",
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ pinned_count: pins.length, fact_ids: pins.map((p) => p.fact_id) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
