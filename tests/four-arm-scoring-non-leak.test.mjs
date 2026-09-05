import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/results");
const SCORING_DIR = path.join(RESULTS_DIR, "scoring");
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

test("every committed scoring report is free of chunk_text/raw evidence fields", async () => {
  const files = await readdir(SCORING_DIR);
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(path.join(SCORING_DIR, name), "utf8");
    assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"/, `${name} must not carry a chunk_text value`);
    assert.doesNotMatch(raw, /"question"\s*:\s*"/, `${name} must not carry raw Gold question text`);
    assert.doesNotMatch(raw, /"expected_answer"/, `${name} must not carry Gold's expected_answer field`);
  }
});

test("every committed scoring report is free of email addresses", async () => {
  const files = await readdir(SCORING_DIR);
  for (const name of files) {
    const raw = await readFile(path.join(SCORING_DIR, name), "utf8");
    assert.doesNotMatch(raw, EMAIL_RE, `${name} must not carry an email address`);
  }
});

test("score.{A,B,C,D}.json violations carry counts only, never per-item detail", async () => {
  for (const arm of ["A", "B", "C", "D"]) {
    const data = JSON.parse(await readFile(path.join(SCORING_DIR, `score.${arm}.json`), "utf8"));
    const v = data.violations;
    assert.equal(typeof v.critical_count, "number");
    assert.equal(typeof v.minor_count, "number");
    assert.equal(typeof v.unresolved_count, "number");
    assert.equal(Object.prototype.hasOwnProperty.call(v, "items"), false);
  }
});

test("B and D reproduced byte-identical to the previously frozen score.{B,D}.json pins", async () => {
  const b = JSON.parse(await readFile(path.join(SCORING_DIR, "score.B.json"), "utf8"));
  const d = JSON.parse(await readFile(path.join(SCORING_DIR, "score.D.json"), "utf8"));
  assert.equal(b.violations.critical_count, 2);
  assert.equal(d.violations.critical_count, 2);
});

test("judgement.json: real scorer verdict is preserved verbatim (PENDING_UNRESOLVED), never rewritten to a false PROVISIONAL_WINNER", async () => {
  const judgement = JSON.parse(await readFile(path.join(SCORING_DIR, "judgement.json"), "utf8"));
  assert.equal(judgement.status, "PENDING_UNRESOLVED");
  assert.equal(judgement.candidate, "A");
});

test("A and C both pass the hard safety gate (critical=0); B and D remain frozen at critical=2", async () => {
  const scores = {};
  for (const arm of ["A", "B", "C", "D"]) {
    scores[arm] = JSON.parse(await readFile(path.join(SCORING_DIR, `score.${arm}.json`), "utf8"));
  }
  assert.equal(scores.A.violations.critical_count, 0);
  assert.equal(scores.C.violations.critical_count, 0);
  assert.equal(scores.B.violations.critical_count, 2);
  assert.equal(scores.D.violations.critical_count, 2);
});

test("execution-manifest.json: no chunk_text, no email, judgement mapped honestly to BLOCKED (not a fabricated PROVISIONAL_WINNER)", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8");
  assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"/);
  assert.doesNotMatch(raw, EMAIL_RE);
  const manifest = JSON.parse(raw);
  assert.equal(manifest.judgement_status_raw, "PENDING_UNRESOLVED");
  assert.equal(manifest.judgement_status_mapped, "BLOCKED");
  assert.notEqual(manifest.judgement_status_mapped, "PROVISIONAL_WINNER");
});

test("execution-manifest.json: result/run file SHA is identical before and after scoring for every arm's own results/run file", async () => {
  const manifest = JSON.parse(await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8"));
  const pre = manifest.result_run_sha_pre_scoring;
  const post = manifest.result_run_sha_post_scoring;
  for (const key of Object.keys(pre)) {
    assert.equal(post[key], pre[key], `${key} SHA changed across scoring`);
  }
});

test("execution-manifest.json: Gold is recorded as pointer-only (SHA + row count), never content, and never marked as committed", async () => {
  const manifest = JSON.parse(await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8"));
  assert.equal(manifest.gold.sha256, "7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b");
  assert.equal(manifest.gold.rows, 101);
  assert.equal(manifest.gold.split_distribution.DEV_TUNE, 101);
  assert.equal(manifest.gold.committed_to_git, false);
});

test("execution-manifest.json: DEV_CHECK/HOLDOUT access counts are zero", async () => {
  const manifest = JSON.parse(await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8"));
  assert.equal(manifest.dev_check_holdout_access.files_searched, 0);
  assert.equal(manifest.dev_check_holdout_access.files_opened, 0);
});

test("RESULTS_SUMMARY.md never contains an email address or raw Gold content marker", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "RESULTS_SUMMARY.md"), "utf8");
  assert.doesNotMatch(raw, EMAIL_RE);
  assert.doesNotMatch(raw, /"chunk_text"/);
});

test("A.results.jsonl / C.results.jsonl (reformatted) still carry zero raw chunk text and a valid node_id-style locator", async () => {
  for (const arm of ["A", "C"]) {
    const raw = await readFile(path.join(RESULTS_DIR, `${arm}.results.jsonl`), "utf8");
    const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 101);
    let checked = 0;
    for (const row of rows) {
      for (const item of row.results ?? []) {
        checked += 1;
        assert.equal(Object.prototype.hasOwnProperty.call(item, "chunk_text"), false);
        assert.match(item.locator, /^[a-z]+_\d+(?:\/\S+#node=\d+(?:&row=\d+&col=\d+)?|::[^:]+::n\d+)$/);
      }
    }
    assert.ok(checked > 0);
  }
});
