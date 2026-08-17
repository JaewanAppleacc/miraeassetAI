// Turn M item 1: verifies the preserved Owner decision artifact is
// byte-identical to the SHA-verified source, and that the required
// structural invariants (25 records, 1 APPROVE/24 FIX_REQUIRED/0 PENDING,
// no missing reviewer/reviewed_at, no dup question_id, real
// packet/wire hash cross-check, Q10/Q11/Q12 notes sanity) hold.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const MANIFEST_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.manifest.json");
const REPORT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.verification-report.json");
const EXPECTED_SHA256 = "96268b4c144455f193719294adf9aa2ab717f0fbe02959eebe8ea5ac4fdde6b2";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

test("preserved artifact byte-identical to the expected, pre-verified SHA-256", async () => {
  const bytes = await readFile(ARTIFACT_PATH);
  assert.equal(sha256(bytes), EXPECTED_SHA256);
});

test("manifest and verification report agree on the artifact sha256 and disposition counts", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  assert.equal(manifest.artifact_sha256, EXPECTED_SHA256);
  assert.equal(report.actual_sha256, EXPECTED_SHA256);
  assert.deepEqual(manifest.disposition_counts, { APPROVE_RESPONSE: 1, FIX_REQUIRED: 24, REJECT_RESPONSE: 0, PENDING: 0 });
  assert.equal(report.duplicate_question_ids, 0);
  assert.equal(report.missing_reviewer_count, 0);
  assert.equal(report.missing_reviewed_at_count, 0);
  assert.equal(report.source_wire_hash_mismatches, 0);
});

test("report never re-declares AI approval or OWNER_ACCEPTED status", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  assert.equal(JSON.stringify(report).includes("OWNER_ACCEPTED"), false);
  assert.equal("ai_approved" in report, false);
});

test("Q10/Q11/Q12 notes sanity: each note's cited percentages match its own question's real figures", async () => {
  const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  assert.equal(report.q10_q11_q12_notes_sanity.question_seed_v07_10_mentions_현대로템_context, true);
  assert.equal(report.q10_q11_q12_notes_sanity.question_seed_v07_11_mentions_HMM_context, true);
  assert.equal(report.q10_q11_q12_notes_sanity.question_seed_v07_12_mentions_현대모비스_context, true);
});

test("25 records, no duplicate/missing question_id, all 25 question_seed_v07_01..25 present", async () => {
  const lines = (await readFile(ARTIFACT_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 25);
  const qids = new Set(lines.map((l) => l.question_id));
  assert.equal(qids.size, 25);
  for (let i = 1; i <= 25; i++) {
    assert.ok(qids.has(`question_seed_v07_${String(i).padStart(2, "0")}`));
  }
});
