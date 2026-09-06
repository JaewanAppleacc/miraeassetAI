// Turn A-RETRIEVAL-REMEDIATION-V1 (review round 3): the DEV_TUNE runner's
// checkpoint/resume/completion integrity, tested through the pure helpers
// the runner calls (four-arm-run-checkpoint.mjs) -- the runner itself
// imports `pg` and cannot be loaded without node_modules. Synthetic rows
// only; no DB, no Gold.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseCheckpointLines, validateCheckpointIdentity, checkpointState, canonicalizeResults, atomicWriteFileSync,
  CheckpointIdentityMismatchError, CheckpointFormatError, IDENTITY_FIELDS,
} from "../domain/agent-comparison/four-arm-ac/four-arm-run-checkpoint.mjs";

const ID = Object.freeze({ arm: "A", batch_id: "batch1", code_sha256: "c0de", config_sha256: "c0nf", policy_id: null });
const ok = (qid, extra = {}) => ({ question_id: qid, arm: "A", segment: "HIGH", code_sha256: "c0de", config_sha256: "c0nf", batch_id: "batch1", latency_ms: 1, results: [{ rank: 1, chunk_id: `chunk_${qid}` }], ...extra });
const bad = (qid, extra = {}) => ({ question_id: qid, arm: "A", segment: "HIGH", code_sha256: "c0de", config_sha256: "c0nf", batch_id: "batch1", error: "boom", ...extra });
const ndjson = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

test("parseCheckpointLines: blank lines skipped, malformed JSON / missing question_id fail closed with the line number", () => {
  assert.deepEqual(parseCheckpointLines(`${JSON.stringify(ok("q1"))}\n\n${JSON.stringify(ok("q2"))}\n`).map((r) => r.question_id), ["q1", "q2"]);
  assert.deepEqual(parseCheckpointLines(""), []);
  assert.throws(() => parseCheckpointLines(`${JSON.stringify(ok("q1"))}\n{not json\n`), (e) => e instanceof CheckpointFormatError && e.line === 2);
  assert.throws(() => parseCheckpointLines(`{"arm":"A"}\n`), (e) => e instanceof CheckpointFormatError && /question_id/.test(e.message));
});

test("validateCheckpointIdentity: every row must carry the current run identity; frozen rows (no policy_id) match policy_id null and nothing else", () => {
  assert.deepEqual(IDENTITY_FIELDS, ["arm", "batch_id", "code_sha256", "config_sha256", "policy_id"]);
  assert.doesNotThrow(() => validateCheckpointIdentity([ok("q1"), bad("q2")], ID));
  for (const [field, value] of [["batch_id", "batch2"], ["code_sha256", "other"], ["config_sha256", "other"], ["arm", "C"]]) {
    assert.throws(() => validateCheckpointIdentity([ok("q1"), ok("q2", { [field]: value })], ID),
      (e) => e instanceof CheckpointIdentityMismatchError && e.mismatches.length === 1 && e.mismatches[0].field === field && e.mismatches[0].line === 2 && e.mismatches[0].question_id === "q2");
  }
  // a remediation row in a frozen run's directory, and vice versa
  assert.throws(() => validateCheckpointIdentity([ok("q1", { policy_id: "remediation-v1" })], ID), (e) => e.mismatches[0].field === "policy_id");
  assert.throws(() => validateCheckpointIdentity([ok("q1")], { ...ID, policy_id: "remediation-v1" }), (e) => e.mismatches[0].field === "policy_id");
  assert.doesNotThrow(() => validateCheckpointIdentity([ok("q1", { policy_id: "remediation-v1" })], { ...ID, policy_id: "remediation-v1" }));
  assert.doesNotThrow(() => validateCheckpointIdentity([], ID));
});

test("checkpointState: a question is done only with a successful row; an error row is superseded by a later success and a success is never undone by a later error", () => {
  const state = checkpointState([bad("q1"), ok("q1"), ok("q2"), bad("q3"), ok("q4"), bad("q4")]);
  assert.deepEqual([...state.done.keys()].sort(), ["q1", "q2", "q4"]);
  assert.deepEqual([...state.errored.keys()], ["q3"]);
  assert.deepEqual(state.duplicate_success_ids, []);
  assert.equal(state.rows, 6);
  assert.deepEqual(checkpointState([ok("q1"), ok("q1", { latency_ms: 2 })]).duplicate_success_ids, ["q1"]);
  assert.equal(checkpointState([ok("q1"), ok("q1", { latency_ms: 2 })]).done.get("q1").latency_ms, 2);   // the last success wins
});

test("canonicalizeResults: exactly one successful row per batch question in batch order; error/duplicate history dropped; fails closed on missing or foreign questions", () => {
  const rows = [bad("q2"), ok("q3"), ok("q1"), ok("q2"), ok("q1", { latency_ms: 9 })];
  const canonical = canonicalizeResults(checkpointState(rows).done, ["q1", "q2", "q3"]);
  assert.equal(canonical.rows, 3);
  const back = parseCheckpointLines(canonical.text);
  assert.deepEqual(back.map((r) => r.question_id), ["q1", "q2", "q3"]);
  assert.equal(back[0].latency_ms, 9);
  assert.equal(back.some((r) => r.error), false);
  assert.throws(() => canonicalizeResults(checkpointState([ok("q1"), bad("q2")]).done, ["q1", "q2"]), /no successful row/);
  assert.throws(() => canonicalizeResults(checkpointState([ok("q1"), ok("qX")]).done, ["q1"]), /outside this batch/);
  assert.throws(() => canonicalizeResults(new Map([["q1", bad("q1")]]), ["q1"]), /error row/);
});

test("canonicalizeResults: for a clean, unresumed run the canonical text is byte-identical to the appended NDJSON", () => {
  const rows = [ok("q1"), ok("q2", { results: [{ rank: 1, chunk_id: "c", score: 0.028373015873015873, row: null, provenance: { candidates: [] } }] }), ok("q3")];
  const appended = ndjson(rows);
  const canonical = canonicalizeResults(checkpointState(parseCheckpointLines(appended)).done, ["q1", "q2", "q3"]);
  assert.equal(canonical.text, appended);
});

test("atomicWriteFileSync: the final file holds the content and no temp file is left behind", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fourarm-ckpt-"));
  const target = path.join(dir, "A.results.ndjson");
  atomicWriteFileSync(target, "line1\n");
  atomicWriteFileSync(target, "line2\nline3\n");
  assert.equal(readFileSync(target, "utf8"), "line2\nline3\n");
  assert.equal(existsSync(target), true);
  assert.deepEqual(readdirSync(dir), ["A.results.ndjson"]);
});

test("runner source: --overwrite is decided before any run.json check, resume verifies identity, completion canonicalizes atomically", () => {
  const source = readFileSync(new URL("../scripts/p11f0-fourarm-devtune-ac-run.mjs", import.meta.url), "utf8");
  const overwriteAt = source.indexOf('const overwrite = process.argv.includes("--overwrite")');
  const guardAt = source.indexOf("refusing to overwrite the completed run");
  assert.ok(overwriteAt > 0 && guardAt > overwriteAt, "--overwrite must be evaluated before the completed-run guard");
  assert.ok(/if \(overwrite\) \{[\s\S]*unlinkSync\(stale\)/.test(source), "--overwrite removes stale files regardless of run.json");
  assert.ok(source.includes("validateCheckpointIdentity(rows, identity)"), "resume verifies the run identity");
  assert.ok(source.includes("canonicalizeResults(done, questions.map((q) => q.question_id))"), "completion canonicalizes to one row per batch question");
  assert.ok(source.includes("atomicWriteFileSync(resultsPath, canonical.text)"), "canonical rewrite is atomic");
  assert.ok(source.includes('results_sha256: sha256Hex(finalRaw)') && source.includes('Buffer.from(canonical.text, "utf8")'), "results_sha256 pins the canonical content");
  assert.ok(source.includes("if (!resultLine.error) done.set(row.question_id, resultLine)"), "an error row never marks a question done");
});
