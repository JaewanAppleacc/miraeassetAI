import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/results");
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

async function loadManifest() {
  return JSON.parse(await readFile(path.join(RESULTS_DIR, "unresolved-audit-manifest.json"), "utf8"));
}

test("unresolved-audit-manifest.json and UNRESOLVED_AUDIT_V1.md carry no emails, no chunk_text values, no Gold answer/evidence fields", async () => {
  for (const name of ["unresolved-audit-manifest.json", "UNRESOLVED_AUDIT_V1.md"]) {
    const raw = await readFile(path.join(RESULTS_DIR, name), "utf8");
    assert.doesNotMatch(raw, EMAIL_RE, `${name} must not carry an email address`);
    assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"[^"]/, `${name} must not carry a non-empty chunk_text value`);
    assert.doesNotMatch(raw, /"expected_answer"|"required_evidence"\s*:\s*\[|"evidence_span"/i, `${name} must not carry raw Gold answer/evidence fields`);
  }
});

test("unresolved-audit-manifest.json exposes at most the one explicitly-required excluded question_id, never a broader Gold question/answer dump", async () => {
  const manifest = await loadManifest();
  const excluded = manifest.section_b_low_denominator.excluded_questions;
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].question_id, /^gold_[a-z0-9_]+$/);
  assert.equal(typeof excluded[0].n_slots, "number");
  // no other question_id should appear anywhere else in the committed manifest
  const raw = JSON.stringify(manifest);
  const qidMatches = raw.match(/"gold_[a-z0-9_]+"/g) || [];
  assert.equal(new Set(qidMatches).size, 1, "no additional question_id should be exposed in the committed aggregate manifest");
});

test("Section A invariance: manifest confirms no retrieval/scoring rerun and zero DEV_CHECK/HOLDOUT access", async () => {
  const manifest = await loadManifest();
  const inv = manifest.invariance_recheck;
  assert.equal(inv.retrieval_or_scoring_rerun, false);
  assert.equal(inv.dev_check_holdout_access.files_searched, 0);
  assert.equal(inv.dev_check_holdout_access.files_opened, 0);
  assert.equal(inv.judgement_status_raw, "PENDING_UNRESOLVED");
});

test("Section E verdict counts sum to the union total and are all non-negative integers", async () => {
  const manifest = await loadManifest();
  const e = manifest.section_e_verdict;
  const sum = e.GENUINE_OWNER_REVIEW_REQUIRED + e.METADATA_CONTRACT_DEFECT + e.FROZEN_SCORER_CONTRACT_GAP;
  assert.equal(sum, e.total);
  assert.equal(e.total, manifest.section_c_unresolved_population.union.total_distinct_packets);
  for (const key of ["GENUINE_OWNER_REVIEW_REQUIRED", "METADATA_CONTRACT_DEFECT", "FROZEN_SCORER_CONTRACT_GAP"]) {
    assert.ok(Number.isInteger(e[key]) && e[key] >= 0);
  }
});

test("Section F: this turn declares zero Owner packets prepared, consistent with a zero GENUINE_OWNER_REVIEW_REQUIRED verdict", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.section_f_owner_packets.packets_prepared, 0);
  assert.equal(manifest.section_e_verdict.GENUINE_OWNER_REVIEW_REQUIRED, 0);
  assert.match(manifest.section_f_owner_packets.combined_sha256_of_empty_set, /^[0-9a-f]{64}$/);
});

test("This turn never declares or implies a winner: no PROVISIONAL_WINNER string, judgement stays PENDING_UNRESOLVED/BLOCKED", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "UNRESOLVED_AUDIT_V1.md"), "utf8");
  assert.doesNotMatch(raw, /PROVISIONAL_WINNER\s*=\s*[AC]\b/);
  assert.ok(raw.includes("PENDING_UNRESOLVED"));
  assert.ok(raw.includes("BLOCKED"));
});

test("The audit report cites the frozen scorer's own source as the basis for its rule/defect claims (fourarm.py line refs), never a modified copy", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "UNRESOLVED_AUDIT_V1.md"), "utf8");
  assert.match(raw, /fourarm\.py:\d+/);
});
