// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section H/O/P: offline tests for
// the GPU benchmark result schema + local verifier. Never calls a GPU
// service -- exercises the verifier against small, hand-built fixture
// files only.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../domain/agent-comparison/four-arm-ac/gpu-benchmark-result.schema.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "p11f0-gpu-benchmark-result-verify.mjs");

function validRecord(id, overrides = {}) {
  return {
    embedding_input_id: id,
    embed_text_sha256: "a".repeat(64),
    model_repository: "nlpai-lab/KURE-v1",
    model_revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
    dimension: 1024,
    dtype: "float32",
    normalization: "l2",
    vector: Array(1024).fill(0.001),
    runner: "KAGGLE_P100",
    elapsed_ms: 12.5,
    ...overrides,
  };
}

test("gpu-benchmark-result.schema.json accepts a well-formed record", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(validRecord("embin_000000000000000000000001")), true);
});

test("gpu-benchmark-result.schema.json rejects a wrong model_revision (pin violation)", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(validRecord("embin_000000000000000000000001", { model_revision: "wrong-revision" })), false);
});

test("gpu-benchmark-result.schema.json rejects a vector with the wrong dimension count", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(validRecord("embin_000000000000000000000001", { vector: Array(512).fill(0.001) })), false);
});

test("gpu-benchmark-result.schema.json rejects an unknown runner value", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(validRecord("embin_000000000000000000000001", { runner: "LOCAL_CPU" })), false);
});

let tmpDir;
test.beforeEach(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), "gpu-verify-test-")); });
test.afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function runVerify(resultPath, summaryPath) {
  try {
    const stdout = execFileSync("node", [VERIFY_SCRIPT, resultPath, summaryPath], { encoding: "utf8" });
    return { status: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { status: error.status, report: JSON.parse(error.stdout) };
  }
}

test("verifier accepts a result file that exactly matches the pinned 2-id sample set", async () => {
  const summaryPath = path.join(tmpDir, "summary.json");
  const resultPath = path.join(tmpDir, "result.jsonl");
  await writeFile(summaryPath, JSON.stringify({ unique_input_count: 100, benchmark_sample: { sample_ids: ["embin_000000000000000000000001", "embin_000000000000000000000002"] } }));
  const lines = [
    JSON.stringify(validRecord("embin_000000000000000000000001")),
    JSON.stringify(validRecord("embin_000000000000000000000002")),
  ].join("\n");
  await writeFile(resultPath, lines);
  const { status, report } = runVerify(resultPath, summaryPath);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.missing_count, 0);
  assert.equal(report.error_count, 0);
  assert.ok(report.throughput);
});

test("verifier rejects a result file with a missing sample id", async () => {
  const summaryPath = path.join(tmpDir, "summary.json");
  const resultPath = path.join(tmpDir, "result.jsonl");
  await writeFile(summaryPath, JSON.stringify({ unique_input_count: 100, benchmark_sample: { sample_ids: ["embin_000000000000000000000001", "embin_000000000000000000000002"] } }));
  await writeFile(resultPath, JSON.stringify(validRecord("embin_000000000000000000000001")));
  const { status, report } = runVerify(resultPath, summaryPath);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.equal(report.missing_count, 1);
});

test("verifier rejects a result file with an id NOT in the pinned sample set", async () => {
  const summaryPath = path.join(tmpDir, "summary.json");
  const resultPath = path.join(tmpDir, "result.jsonl");
  await writeFile(summaryPath, JSON.stringify({ unique_input_count: 100, benchmark_sample: { sample_ids: ["embin_000000000000000000000001"] } }));
  await writeFile(resultPath, [
    JSON.stringify(validRecord("embin_000000000000000000000001")),
    JSON.stringify(validRecord("embin_ffffffffffffffffffffffff")), // not in the pinned set
  ].join("\n"));
  const { status, report } = runVerify(resultPath, summaryPath);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("UNEXPECTED_EMBEDDING_INPUT_ID")));
});

test("verifier rejects a duplicate embedding_input_id within the same result file", async () => {
  const summaryPath = path.join(tmpDir, "summary.json");
  const resultPath = path.join(tmpDir, "result.jsonl");
  await writeFile(summaryPath, JSON.stringify({ unique_input_count: 100, benchmark_sample: { sample_ids: ["embin_000000000000000000000001"] } }));
  await writeFile(resultPath, [
    JSON.stringify(validRecord("embin_000000000000000000000001")),
    JSON.stringify(validRecord("embin_000000000000000000000001")),
  ].join("\n"));
  const { status, report } = runVerify(resultPath, summaryPath);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("DUPLICATE_EMBEDDING_INPUT_ID")));
});

test("verifier rejects malformed JSON lines and schema violations without crashing", async () => {
  const summaryPath = path.join(tmpDir, "summary.json");
  const resultPath = path.join(tmpDir, "result.jsonl");
  await writeFile(summaryPath, JSON.stringify({ unique_input_count: 100, benchmark_sample: { sample_ids: ["embin_000000000000000000000001"] } }));
  await writeFile(resultPath, [
    "{not valid json",
    JSON.stringify(validRecord("embin_000000000000000000000001", { dimension: 999, vector: Array(999).fill(0) })),
  ].join("\n"));
  const { status, report } = runVerify(resultPath, summaryPath);
  assert.equal(status, 1);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("MALFORMED_JSON")));
  assert.ok(report.errors.some((e) => e.includes("SCHEMA_VIOLATION")));
});
