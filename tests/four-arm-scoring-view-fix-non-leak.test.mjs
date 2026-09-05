import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/results");
const OFFICIAL_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official");
const SCORING_V2_DIR = path.join(RESULTS_DIR, "scoring_v2");
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DB_RE = /postgresql:\/\/|localhost:\d{4,5}|PGPASSWORD|DATABASE_URL\s*=\s*['"]/;
const ABS_PATH_RE = /\/Users\/[a-z0-9_-]+/i;

async function readManifest() {
  return JSON.parse(await readFile(path.join(RESULTS_DIR, "scoring-view-fix-manifest.json"), "utf8"));
}

test("amendment, result report, and manifest carry no emails, DB connection strings, or absolute personal paths", async () => {
  for (const name of ["SCORING_VIEW_FIX_V1_AMENDMENT.md", "SCORING_VIEW_FIX_V1_RESULT.md", "scoring-view-fix-manifest.json"]) {
    const raw = await readFile(path.join(RESULTS_DIR, name), "utf8");
    assert.doesNotMatch(raw, EMAIL_RE, `${name} must not carry an email address`);
    assert.doesNotMatch(raw, DB_RE, `${name} must not carry a DB connection string or credential`);
    assert.doesNotMatch(raw, ABS_PATH_RE, `${name} must not carry an absolute personal path`);
  }
});

test("scoring_v2/ sanitized score reports carry no chunk_text, no raw Gold question/answer fields, and violations are counts-only", async () => {
  const files = await readdir(SCORING_V2_DIR);
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(SCORING_V2_DIR, name), "utf8");
    assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"[^"]/, `${name} must not carry a non-empty chunk_text value`);
    assert.doesNotMatch(raw, /"question"\s*:\s*"|"expected_answer"|"evidence_span"/i, `${name} must not carry raw Gold content`);
  }
  for (const arm of ["A", "B", "C", "D"]) {
    const data = JSON.parse(await readFile(path.join(SCORING_V2_DIR, `score.${arm}.json`), "utf8"));
    const v = data.violations;
    assert.equal(typeof v.critical_count, "number");
    assert.equal(typeof v.minor_count, "number");
    assert.equal(typeof v.unresolved_count, "number");
    assert.equal(Object.prototype.hasOwnProperty.call(v, "items"), false);
  }
});

test("official/unresolved-review-template-v2.json is arm-blind: no arm/score/candidate fields, only vFINAL-legal classification values, all starting UNKNOWN", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "unresolved-review-template-v2.json"), "utf8");
  assert.doesNotMatch(raw, EMAIL_RE);
  assert.doesNotMatch(raw, /"chunk_text"|"doc_id"|"node_index"|"locator"|"arm"\s*:|"score"\s*:|"candidate"/i);
  const entries = JSON.parse(raw);
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const allowedClassifications = new Set(["COMMON_SOURCE", "ARM_SPECIFIC", "UNKNOWN"]);
  for (const [packetId, body] of entries) {
    assert.match(packetId, /^u-[0-9a-f]{12}$/);
    assert.ok(allowedClassifications.has(body.classification), `disallowed classification: ${body.classification}`);
    assert.equal(body.classification, "UNKNOWN", "no packet should be pre-classified -- automatic adjudication is forbidden");
    assert.equal(typeof body._question_id, "string");
    assert.equal(typeof body._slot, "string");
    assert.equal(typeof body._reason, "string");
  }
});

test("manifest: original A/C result/run SHA and frozen scorer code SHA are confirmed unchanged, and B/D score reproduced byte-identical", async () => {
  const manifest = await readManifest();
  const inv = manifest.invariance_reverified;
  assert.equal(inv.original_A_C_result_run_sha_unchanged, true);
  assert.equal(inv.frozen_scorer_code_sha_unchanged, true);
  assert.equal(inv.BD_score_byte_identical_to_prior_frozen, true);
  assert.equal(inv.owner_resolutions_json_unchanged, true);
});

test("manifest: hydration achieved 100% success with zero integrity failures for both A and C", async () => {
  const manifest = await readManifest();
  for (const arm of ["A", "C"]) {
    const c = manifest.hydration[arm];
    assert.equal(c.hydrated_success, c.total_items);
    assert.equal(c.missing, 0);
    assert.equal(c.duplicate, 0);
    assert.equal(c.duplicate_within_question, 0);
    assert.equal(c.hash_mismatch, 0);
    assert.equal(c.document_mismatch, 0);
  }
  assert.equal(manifest.hydration.A_invariance_ok, true);
  assert.equal(manifest.hydration.C_invariance_ok, true);
  assert.equal(manifest.hydration.status, "HYDRATION_COMPLETE");
});

test("manifest: judgement is honestly PENDING_UNRESOLVED (mapped BLOCKED), never a fabricated PROVISIONAL_WINNER, since A/C unresolved counts are not zero", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.judgement_status_raw, "PENDING_UNRESOLVED");
  assert.equal(manifest.judgement_status_mapped, "BLOCKED");
  assert.notEqual(manifest.judgement_status_mapped, "PROVISIONAL_WINNER");
  assert.ok(manifest.violations.A.unresolved > 0);
  assert.ok(manifest.violations.C.unresolved > 0);
});

test("manifest: C's new critical finding flips its hard-gate status to failed, and only A remains hard-safe", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.violations.C.critical, 1);
  assert.deepEqual(manifest.hard_gate.hard_safe, ["A"]);
  assert.ok(manifest.hard_gate.failed.includes("C"));
  assert.ok(manifest.hard_gate.failed.includes("B"));
  assert.ok(manifest.hard_gate.failed.includes("D"));
});

test("manifest: owner packet prep matches the committed template count and excludes already-adjudicated packets", async () => {
  const manifest = await readManifest();
  const p = manifest.owner_packet_prep;
  const template = JSON.parse(await readFile(path.join(OFFICIAL_DIR, "unresolved-review-template-v2.json"), "utf8"));
  assert.equal(p.new_packets_prepared_for_owner_review, template.length);
  assert.equal(p.already_adjudicated_overlap, 0);
  assert.match(p.combined_sha256_of_raw_packet_files, /^[0-9a-f]{64}$/);
});

test("SCORING_VIEW_FIX_V1_RESULT.md never declares PROVISIONAL_WINNER as an actual verdict, and documents the amendment was committed before any score was viewed", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "SCORING_VIEW_FIX_V1_RESULT.md"), "utf8");
  assert.doesNotMatch(raw, /^#.*PROVISIONAL_WINNER/m);
  assert.ok(raw.includes("does not") && raw.includes("PROVISIONAL_WINNER=A"));
  assert.ok(raw.toLowerCase().includes("amendment"));
});
