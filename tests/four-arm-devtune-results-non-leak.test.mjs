import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/results");

async function loadResults(arm) {
  const raw = await readFile(path.join(RESULTS_DIR, `${arm}.results.jsonl`), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

for (const arm of ["A", "C"]) {
  test(`${arm}.results.jsonl: every result item carries a chunk_text_sha256, never raw chunk text`, async () => {
    const rows = await loadResults(arm);
    let checked = 0;
    for (const row of rows) {
      for (const r of row.results ?? []) {
        checked += 1;
        assert.equal(typeof r.chunk_text_sha256, "string");
        assert.match(r.chunk_text_sha256, /^[0-9a-f]{64}$/);
        assert.equal(Object.prototype.hasOwnProperty.call(r, "chunk_text"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(r, "text"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(r, "text_content"), false);
      }
    }
    assert.ok(checked > 0);
  });

  test(`${arm}.results.jsonl: provenance candidates carry locator identity only, never text`, async () => {
    const rows = await loadResults(arm);
    for (const row of rows) {
      for (const r of row.results ?? []) {
        for (const candidate of r.provenance?.candidates ?? []) {
          for (const key of Object.keys(candidate)) {
            assert.doesNotMatch(key, /text|chunk_text|content/i);
          }
        }
      }
    }
  });

  test(`${arm}.results.jsonl: no line contains an email address or Gold-shaped field name`, async () => {
    const raw = await readFile(path.join(RESULTS_DIR, `${arm}.results.jsonl`), "utf8");
    assert.equal(raw.includes("@"), false);
    assert.doesNotMatch(raw, /"gold"|"expected_answer"|"required_evidence"|"answer"\s*:/i);
  });

  test(`${arm}.run.json: no DEV_CHECK/HOLDOUT reference`, async () => {
    const raw = await readFile(path.join(RESULTS_DIR, `${arm}.run.json`), "utf8");
    assert.doesNotMatch(raw, /DEV_CHECK|HOLDOUT/);
  });
}

test("execution-manifest.json never contains an email address or raw Gold content, only a pointer-only gold object", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8");
  // "Recall@5/10/20" is legitimate prose in this file -- only an email-
  // shaped "@" (word characters immediately on both sides, with a dot
  // somewhere after) is actually disallowed.
  assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[\w.-]+/);
  assert.doesNotMatch(raw, /"expected_answer"|"required_evidence"|"chunk_text"\s*:/i);
  // A top-level "gold" object is allowed for this Turn (DEV_TUNE-101 is a
  // permitted evaluation input), but it must stay pointer-only: SHA/rows/
  // split distribution/access note, never a question, answer, or evidence field.
  const manifest = JSON.parse(raw);
  const goldKeys = Object.keys(manifest.gold);
  const allowedGoldKeys = new Set(["sha256", "rows", "split_distribution", "accessed_by", "committed_to_git"]);
  for (const key of goldKeys) {
    assert.ok(allowedGoldKeys.has(key), `unexpected gold.${key} field -- must stay pointer-only`);
  }
  assert.equal(manifest.gold.committed_to_git, false);
});

test("execution-manifest.json honestly maps the scorer's own PENDING_UNRESOLVED verdict to BLOCKED, never a fabricated PROVISIONAL_WINNER", async () => {
  const manifest = JSON.parse(await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8"));
  assert.equal(manifest.judgement_status_raw, "PENDING_UNRESOLVED");
  assert.equal(manifest.judgement_status_mapped, "BLOCKED");
  assert.notEqual(manifest.judgement_status_mapped, "PROVISIONAL_WINNER");
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "provisional_winner"), false);
});

test("execution-manifest.json reports both A and C as checkpoint-complete with zero errors and a real, verified results_sha256", async () => {
  const manifest = JSON.parse(await readFile(path.join(RESULTS_DIR, "execution-manifest.json"), "utf8"));
  const completeness = manifest.judgement_chain.find((s) => s.step === "0 per-arm completeness");
  assert.deepEqual(completeness.missing_or_error, {});
  const locatorChecked = manifest.judgement_chain.find((s) => s.step === "14 locator checked");
  assert.deepEqual(locatorChecked.unchecked, []);
  for (const arm of ["A", "C"]) {
    assert.equal(manifest.arm_segments[arm].segments.ALL.questions, 100);
    assert.match(manifest.result_run_sha_post_scoring[`results/fourarm/${arm}.results.jsonl`], /^[0-9a-f]{64}$/);
  }
});

test("RESULTS_SUMMARY.md never contains an email address, raw chunk text, or a fabricated PROVISIONAL_WINNER verdict", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "RESULTS_SUMMARY.md"), "utf8");
  assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[\w.-]+/);
  assert.doesNotMatch(raw, /"chunk_text"\s*:\s*"/);
  // PROVISIONAL_WINNER may appear only inside an explicit disclaimer that it was NOT declared.
  assert.doesNotMatch(raw, /^#.*PROVISIONAL_WINNER/m);
  assert.ok(raw.includes("does not declare `PROVISIONAL_WINNER=A`"));
  assert.ok(raw.includes("supersedes the prior `BLOCKED_CONTRACT` report"));
});

test("execution-manifest.json: A and C ran at the identical code_sha256 (same batch, no drift)", async () => {
  const armAJson = JSON.parse(await readFile(path.join(RESULTS_DIR, "A.run.json"), "utf8"));
  const armCJson = JSON.parse(await readFile(path.join(RESULTS_DIR, "C.run.json"), "utf8"));
  assert.equal(armAJson.code_sha256, armCJson.code_sha256);
  assert.equal(armAJson.batch_id, armCJson.batch_id);
});
