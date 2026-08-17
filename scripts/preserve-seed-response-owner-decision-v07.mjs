// Turn M item 1: verifies an externally supplied Owner decision v0.7 JSONL
// (the Owner's real 25-question response review decision) against its
// expected raw-byte SHA-256, then preserves it BYTE-IDENTICAL as a new
// artifact under work/handoff/ -- never modifying or rewriting its
// content, never re-declaring AI approval/OWNER_ACCEPTED. Cross-checks
// every declared source_packet/source_wire path+sha256 against the real
// files already on disk (never trusted from the decision file alone).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = process.env.SEED_RESPONSE_OWNER_DECISION_V07_PATH ?? process.argv[2];
const EXPECTED_SHA256 = "96268b4c144455f193719294adf9aa2ab717f0fbe02959eebe8ea5ac4fdde6b2";
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_ARTIFACT_PATH = path.join(OUT_DIR, "seed-response-owner-decision.v0.7.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-owner-decision.v0.7.manifest.json");
const OUT_REPORT_PATH = path.join(OUT_DIR, "seed-response-owner-decision.v0.7.verification-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  if (!SOURCE_PATH) throw new Error("BLOCKER: provide SEED_RESPONSE_OWNER_DECISION_V07_PATH or the source path as argv[2]");
  const sourceBytes = await readFile(SOURCE_PATH);
  const actualSha256 = sha256(sourceBytes);
  if (actualSha256 !== EXPECTED_SHA256) {
    throw new Error(`BLOCKER: ${SOURCE_PATH} sha256 (${actualSha256}) does not match expected ${EXPECTED_SHA256} -- refusing to preserve an unverified file`);
  }

  const lines = sourceBytes.toString("utf8").trim().split("\n").map((line, i) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`BLOCKER: line ${i + 1} is not valid JSON: ${error.message}`); }
  });
  if (lines.length !== 25) throw new Error(`BLOCKER: expected 25 records, found ${lines.length}`);

  const seenQids = new Set();
  const dispositionCounts = { APPROVE_RESPONSE: 0, FIX_REQUIRED: 0, REJECT_RESPONSE: 0, PENDING: 0 };
  const missingReviewer = []; const missingReviewedAt = [];
  const packetPaths = new Set(); const packetShas = new Set();
  const wireHashMismatches = [];

  for (const record of lines) {
    if (seenQids.has(record.question_id)) throw new Error(`BLOCKER: duplicate question_id ${record.question_id}`);
    seenQids.add(record.question_id);
    if (!(record.owner_disposition in dispositionCounts)) throw new Error(`BLOCKER: unrecognized owner_disposition "${record.owner_disposition}" for ${record.question_id}`);
    dispositionCounts[record.owner_disposition]++;
    if (!record.reviewer) missingReviewer.push(record.question_id);
    if (!record.reviewed_at) missingReviewedAt.push(record.question_id);
    packetPaths.add(record.source_packet_path);
    packetShas.add(record.source_packet_sha256);

    const wireAbsPath = path.join(REPO, record.source_wire_path);
    const wireBytes = await readFile(wireAbsPath).catch(() => null);
    if (!wireBytes) { wireHashMismatches.push({ question_id: record.question_id, reason: "wire file not found", path: record.source_wire_path }); continue; }
    const actualWireSha = sha256(wireBytes);
    if (actualWireSha !== record.source_wire_sha256) {
      wireHashMismatches.push({ question_id: record.question_id, reason: "sha256 mismatch", declared: record.source_wire_sha256, actual: actualWireSha });
    }
  }

  if (seenQids.size !== 25) throw new Error(`BLOCKER: expected 25 distinct question_id, found ${seenQids.size}`);
  if (missingReviewer.length > 0) throw new Error(`BLOCKER: missing reviewer for: ${missingReviewer.join(", ")}`);
  if (missingReviewedAt.length > 0) throw new Error(`BLOCKER: missing reviewed_at for: ${missingReviewedAt.join(", ")}`);
  if (packetPaths.size !== 1) throw new Error(`BLOCKER: expected exactly one distinct source_packet_path, found ${packetPaths.size}`);
  if (packetShas.size !== 1) throw new Error(`BLOCKER: expected exactly one distinct source_packet_sha256, found ${packetShas.size}`);
  if (wireHashMismatches.length > 0) throw new Error(`BLOCKER: ${wireHashMismatches.length} wire hash mismatch(es): ${JSON.stringify(wireHashMismatches)}`);

  const realPacketBytes = await readFile(path.join(REPO, [...packetPaths][0]));
  const realPacketSha = sha256(realPacketBytes);
  if (realPacketSha !== [...packetShas][0]) {
    throw new Error(`BLOCKER: declared source_packet_sha256 (${[...packetShas][0]}) does not match the real packet file's actual sha256 (${realPacketSha})`);
  }

  const q10 = lines.find((l) => l.question_id === "question_seed_v07_10");
  const q11 = lines.find((l) => l.question_id === "question_seed_v07_11");
  const q12 = lines.find((l) => l.question_id === "question_seed_v07_12");
  const notesSanity = {
    question_seed_v07_10_mentions_현대로템_context: /55\.1994|364\.3890|10개에서 16개/.test(q10?.notes ?? ""),
    question_seed_v07_11_mentions_HMM_context: /29\.6451|149\.8764/.test(q11?.notes ?? ""),
    question_seed_v07_12_mentions_현대모비스_context: /3\.1454|46\.2763/.test(q12?.notes ?? ""),
  };
  if (!Object.values(notesSanity).every(Boolean)) {
    throw new Error(`BLOCKER: Q10/Q11/Q12 notes sanity check failed: ${JSON.stringify(notesSanity)}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_ARTIFACT_PATH, sourceBytes); // byte-identical, never re-serialized
  const writtenBytes = await readFile(OUT_ARTIFACT_PATH);
  if (!writtenBytes.equals(sourceBytes)) throw new Error("BLOCKER: preserved artifact is not byte-identical to the source");

  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    artifact_sha256: actualSha256,
    source_path_note: "Copied byte-identical from a local Owner-provided file outside the repo -- see verification-report for the exact provenance check performed. Content was NOT modified, re-serialized, or re-approved by this script.",
    record_count: 25,
    disposition_counts: dispositionCounts,
    source_packet_path: [...packetPaths][0],
    source_packet_sha256: [...packetShas][0],
    generated_at: new Date().toISOString(),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const report = {
    schema_version: "0.1.0",
    verified_at: new Date().toISOString(),
    expected_sha256: EXPECTED_SHA256,
    actual_sha256: actualSha256,
    sha256_match: true,
    record_count: lines.length,
    disposition_counts: dispositionCounts,
    duplicate_question_ids: 0,
    missing_question_ids: 0,
    missing_reviewer_count: missingReviewer.length,
    missing_reviewed_at_count: missingReviewedAt.length,
    source_packet_path: [...packetPaths][0],
    source_packet_sha256_verified_against_real_file: true,
    source_wire_hash_mismatches: wireHashMismatches.length,
    q10_q11_q12_notes_sanity: notesSanity,
    preserved_artifact_path: manifest.artifact,
    preserved_artifact_sha256: actualSha256,
    note: "This report only verifies and preserves the Owner's original decision bytes -- it never adds a new approval status of any kind, and never modifies the decision's own content.",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ artifact_sha256: actualSha256, disposition_counts: dispositionCounts, notesSanity }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
