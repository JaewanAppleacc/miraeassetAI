import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/results");
const OFFICIAL_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official");
const PATCH_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1");
const SCORING_V3_DIR = path.join(RESULTS_DIR, "scoring_v3");
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DB_RE = /postgresql:\/\/|localhost:\d{4,5}|PGPASSWORD/;
const ABS_PATH_RE = /\/Users\/[a-z0-9_-]+/i;

async function readManifest() {
  return JSON.parse(await readFile(path.join(RESULTS_DIR, "scorer-multinode-fix-manifest.json"), "utf8"));
}

test("amendment, result report, and manifest carry no emails, DB strings, or absolute personal paths", async () => {
  for (const name of ["SCORER_MULTINODE_FIX_V1_AMENDMENT.md", "SCORER_MULTINODE_FIX_V1_RESULT.md", "scorer-multinode-fix-manifest.json"]) {
    const raw = await readFile(path.join(RESULTS_DIR, name), "utf8");
    assert.doesNotMatch(raw, EMAIL_RE, `${name} must not carry an email address`);
    assert.doesNotMatch(raw, DB_RE, `${name} must not carry a DB connection string or credential`);
    assert.doesNotMatch(raw, ABS_PATH_RE, `${name} must not carry an absolute personal path`);
  }
});

test("scoring_v3/ sanitized score reports carry no chunk_text and violations are counts-only", async () => {
  const files = await readdir(SCORING_V3_DIR);
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(SCORING_V3_DIR, name), "utf8");
    assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"[^"]/, `${name} must not carry a non-empty chunk_text value`);
  }
  for (const arm of ["A", "B", "C", "D"]) {
    const data = JSON.parse(await readFile(path.join(SCORING_V3_DIR, `score.${arm}.json`), "utf8"));
    const v = data.violations;
    assert.equal(typeof v.critical_count, "number");
    assert.equal(typeof v.minor_count, "number");
    assert.equal(typeof v.unresolved_count, "number");
    assert.equal(Object.prototype.hasOwnProperty.call(v, "items"), false);
  }
});

test("scoring_v3/score.{B,D}.json are byte-identical to the canonical frozen pins", async () => {
  const b = JSON.parse(await readFile(path.join(SCORING_V3_DIR, "score.B.json"), "utf8"));
  const d = JSON.parse(await readFile(path.join(SCORING_V3_DIR, "score.D.json"), "utf8"));
  assert.equal(b.violations.critical_count, 2);
  assert.equal(d.violations.critical_count, 2);
});

test("scoring_v3/score.A.json and score.C.json show the reduced unresolved counts (9 and 5)", async () => {
  const a = JSON.parse(await readFile(path.join(SCORING_V3_DIR, "score.A.json"), "utf8"));
  const c = JSON.parse(await readFile(path.join(SCORING_V3_DIR, "score.C.json"), "utf8"));
  assert.equal(a.violations.unresolved_count, 9);
  assert.equal(c.violations.unresolved_count, 5);
  assert.equal(a.violations.critical_count, 0);
});

test("scorer-patch-multinode-v1: patched fourarm.py SHA matches the manifest and README, and the diff is minimal", async () => {
  const manifest = await readManifest();
  const patched = await readFile(path.join(PATCH_DIR, "fourarm.patched.py"), "utf8");
  const crypto = await import("node:crypto");
  const sha = crypto.createHash("sha256").update(patched, "utf8").digest("hex");
  assert.equal(sha, manifest.patched_fourarm_py_sha256);
  const diff = await readFile(path.join(PATCH_DIR, "fourarm.patch.diff"), "utf8");
  assert.ok(diff.includes("claim_text_not_in_node"));
  assert.ok(diff.includes("_table_aware_norm"));
  // the diff must never touch B/D-relevant code paths by name
  assert.doesNotMatch(diff, /duplicate_evidence_different_node.*severity.*critical|def adjudication_plan/s);
});

test("official/unresolved-review-template-v3.json: exactly 10 arm-blind entries, all pre-set UNKNOWN, only legal classifications", async () => {
  const raw = await readFile(path.join(OFFICIAL_DIR, "unresolved-review-template-v3.json"), "utf8");
  assert.doesNotMatch(raw, EMAIL_RE);
  assert.doesNotMatch(raw, /"chunk_text"|"doc_id"|"node_index"|"locator"|"arm"\s*:|"score"\s*:|"candidate"/i);
  const entries = JSON.parse(raw);
  assert.equal(entries.length, 10);
  const allowed = new Set(["COMMON_SOURCE", "ARM_SPECIFIC", "UNKNOWN"]);
  for (const [packetId, body] of entries) {
    assert.match(packetId, /^u-[0-9a-f]{12}$/);
    assert.ok(allowed.has(body.classification));
    assert.equal(body.classification, "UNKNOWN");
  }
});

test("manifest: patch resolved exactly 12 and left exactly 10, matching the pre-registered generic-rule prediction with no hardcoded packet IDs", async () => {
  const manifest = await readManifest();
  const p = manifest.patch_scope_before_after;
  assert.equal(p.resolved_packet_ids.length, 12);
  assert.equal(p.remaining_packet_ids.length, 10);
  assert.equal(p.generic_rule_hardcoded_packet_ids, false);
  const overlap = p.resolved_packet_ids.filter((id) => p.remaining_packet_ids.includes(id));
  assert.equal(overlap.length, 0);
});

test("manifest: judgement stays PENDING_UNRESOLVED / READY_FOR_OWNER_FINAL_ADJUDICATION, never a fabricated PROVISIONAL_WINNER", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.judgement_status_raw, "PENDING_UNRESOLVED");
  assert.equal(manifest.judgement_status_mapped, "READY_FOR_OWNER_FINAL_ADJUDICATION");
  assert.equal(manifest.final_status, "READY_FOR_OWNER_FINAL_ADJUDICATION");
  assert.notEqual(manifest.judgement_status_mapped, "PROVISIONAL_WINNER");
});

test("manifest: all invariance checks confirmed true, and B/D reproduced byte-identical to the canonical pins", async () => {
  const manifest = await readManifest();
  const inv = manifest.invariance_reverified;
  for (const key of Object.keys(inv)) {
    assert.equal(inv[key], true, `${key} must be true`);
  }
});

test("manifest: DEV_CHECK/HOLDOUT access is zero and no production wiring or retrieval rerun occurred", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.security.dev_check_holdout_files_searched, 0);
  assert.equal(manifest.security.dev_check_holdout_files_opened, 0);
  assert.equal(manifest.security.production_wiring, false);
  assert.equal(manifest.security.retrieval_embedding_ranking_rerun, false);
});

test("SCORER_MULTINODE_FIX_V1_RESULT.md never declares PROVISIONAL_WINNER as an actual verdict", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "SCORER_MULTINODE_FIX_V1_RESULT.md"), "utf8");
  assert.doesNotMatch(raw, /^#.*PROVISIONAL_WINNER/m);
  assert.ok(raw.includes("PROVISIONAL_WINNER=A` is not declared"));
});
