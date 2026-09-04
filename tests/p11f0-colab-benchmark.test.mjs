// Turn AC-COLAB-BENCH-V1, section K. Offline/synthetic tests for the shard
// planner, sample extractor, npy encode/decode round-trip, and the GPU
// result verifier's checks -- none of these need the real 5,000-row local
// run, the live KURE server, or DATABASE_URL. Zero Gold/DEV_CHECK/HOLDOUT
// content; all fixture text below is invented lorem-ipsum-style filler,
// never real corpus text.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { encodeNpyFloat32Matrix, l2Normalize } from "../scripts/p11f0-colab-benchmark-local-reference-run.mjs";
import { parseNpyFloat32Matrix, verifyGpuBenchmarkPackage, COSINE_MEAN_MIN, COSINE_MIN_MIN } from "../scripts/p11f0-colab-benchmark-verify.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "p11f0-colab-bench-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("npy round-trip: encode then parse recovers the exact float32 matrix and shape", () => {
  const rows = 3; const cols = 5;
  const flat = new Float32Array(rows * cols);
  for (let i = 0; i < flat.length; i += 1) flat[i] = Math.fround(Math.sin(i) * 1000);
  const buf = encodeNpyFloat32Matrix(rows, cols, flat);
  const parsed = parseNpyFloat32Matrix(buf);
  assert.equal(parsed.rows, rows);
  assert.equal(parsed.cols, cols);
  for (let i = 0; i < flat.length; i += 1) assert.equal(parsed.data[i], flat[i]);
});

test("npy round-trip: 1024-dim, 5-row matrix (production shape at small scale) survives intact", () => {
  const rows = 5; const cols = 1024;
  const flat = new Float32Array(rows * cols);
  for (let i = 0; i < flat.length; i += 1) flat[i] = Math.fround((i % 97) / 97 - 0.5);
  const buf = encodeNpyFloat32Matrix(rows, cols, flat);
  const parsed = parseNpyFloat32Matrix(buf);
  assert.equal(parsed.rows, rows);
  assert.equal(parsed.cols, cols);
  assert.deepEqual(Array.from(parsed.data), Array.from(flat));
});

test("l2Normalize: output has unit L2 norm, direction preserved", () => {
  const v = new Float32Array([3, 4, 0]);
  const out = l2Normalize(v);
  const norm = Math.sqrt(out[0] ** 2 + out[1] ** 2 + out[2] ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-6);
  assert.ok(Math.abs(out[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.8) < 1e-6);
});

test("l2Normalize: zero vector throws rather than dividing by zero", () => {
  assert.throws(() => l2Normalize(new Float32Array([0, 0, 0])), /ZERO_OR_NON_FINITE_NORM/);
});

test("shard planner: contiguous 2/4/8-way coverage, zero gap/overlap, deterministic re-run", async () => {
  await withTmpDir(async (dir) => {
    const fullTextPath = path.join(dir, "fulltext.jsonl");
    const n = 97; // deliberately not evenly divisible by 2/4/8
    const rows = Array.from({ length: n }, (_, i) => {
      const sha = sha256Hex(`fixture-row-${i}`);
      return JSON.stringify({ embedding_input_id: `embin_${sha.slice(0, 24)}`, embed_text_sha256: sha, char_length: 10, text: `filler text ${i}` });
    }).sort((a, b) => (JSON.parse(a).embed_text_sha256 < JSON.parse(b).embed_text_sha256 ? -1 : 1));
    await writeFile(fullTextPath, `${rows.join("\n")}\n`, "utf8");

    const outPath = path.join(dir, "shard-plan.json");
    await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-shard-plan.mjs"), fullTextPath, outPath]);
    const plan = JSON.parse(await readFile(outPath, "utf8"));

    for (const count of [2, 4, 8]) {
      const key = `shard_plan_${count}_contiguous`;
      assert.equal(plan[key].complete, true, `${key} must be complete`);
      assert.equal(plan[key].total_assigned, n);
      assert.equal(plan[key].total_expected, n);
      assert.equal(plan[key].overlap_or_gap, false);
      let cursor = 0;
      for (const shard of plan[key].shards) {
        assert.equal(shard.start_input_index, cursor, `${key} shard ${shard.shard_index} must start right after the previous shard ends`);
        cursor = shard.end_input_index + 1;
      }
      assert.equal(cursor, n);
    }

    // Determinism: re-running against the SAME input must reproduce the
    // exact same shard_sha256 values.
    const outPath2 = path.join(dir, "shard-plan-2.json");
    await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-shard-plan.mjs"), fullTextPath, outPath2]);
    const plan2 = JSON.parse(await readFile(outPath2, "utf8"));
    assert.deepEqual(plan.shard_plan_8_contiguous.shards, plan2.shard_plan_8_contiguous.shards);
  });
});

test("shard planner: refuses to plan over a non-sorted input file (fail-closed, not a silent best-effort plan)", async () => {
  await withTmpDir(async (dir) => {
    const fullTextPath = path.join(dir, "unsorted.jsonl");
    const rows = [
      { embedding_input_id: "embin_b", embed_text_sha256: "bbbb", char_length: 1, text: "x" },
      { embedding_input_id: "embin_a", embed_text_sha256: "aaaa", char_length: 1, text: "y" }, // out of order
    ];
    await writeFile(fullTextPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    await assert.rejects(
      execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-shard-plan.mjs"), fullTextPath, path.join(dir, "out.json")]),
      /INPUT_NOT_SORTED/,
    );
  });
});

test("extract-sample: pulls exactly the pinned sample rows, preserving file order, computes a stable input_ordering_sha256", async () => {
  await withTmpDir(async (dir) => {
    const n = 20;
    const allRows = Array.from({ length: n }, (_, i) => {
      const sha = sha256Hex(`row-${i}`);
      return { embedding_input_id: `embin_${sha.slice(0, 24)}`, embed_text_sha256: sha, char_length: 5, text: `t${i}` };
    }).sort((a, b) => (a.embed_text_sha256 < b.embed_text_sha256 ? -1 : 1));
    const fullTextPath = path.join(dir, "fulltext.jsonl");
    await writeFile(fullTextPath, `${allRows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

    const sampleIds = [allRows[2].embedding_input_id, allRows[7].embedding_input_id, allRows[15].embedding_input_id];
    const summaryPath = path.join(dir, "summary.json");
    await writeFile(summaryPath, JSON.stringify({ benchmark_sample: { sample_ids: sampleIds, actual_size: sampleIds.length } }), "utf8");

    const outPath = path.join(dir, "sample.jsonl");
    const { stdout } = await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-extract-sample.mjs"), fullTextPath, summaryPath, outPath]);
    const result = JSON.parse(stdout);
    assert.equal(result.row_count, 3);

    const extracted = (await readFile(outPath, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.deepEqual(extracted.map((r) => r.embedding_input_id), [2, 7, 15].map((i) => allRows[i].embedding_input_id));
  });
});

test("extract-sample: refuses when a sample id is not present in the population (fail-closed)", async () => {
  await withTmpDir(async (dir) => {
    const fullTextPath = path.join(dir, "fulltext.jsonl");
    await writeFile(fullTextPath, `${JSON.stringify({ embedding_input_id: "embin_real", embed_text_sha256: "aaaa", char_length: 1, text: "x" })}\n`, "utf8");
    const summaryPath = path.join(dir, "summary.json");
    await writeFile(summaryPath, JSON.stringify({ benchmark_sample: { sample_ids: ["embin_real", "embin_does_not_exist"], actual_size: 2 } }), "utf8");
    // The script's row-count check fires before its per-id membership
    // check (both are fail-closed; count mismatch is simply detected
    // first whenever ANY sample id is absent from the population).
    await assert.rejects(
      execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-extract-sample.mjs"), fullTextPath, summaryPath, path.join(dir, "out.jsonl")]),
      /SAMPLE_EXTRACTION_INCOMPLETE/,
    );
  });
});

test("verifier: fixed compatibility thresholds are exactly the ones this Turn pinned before any Colab result existed", () => {
  assert.equal(COSINE_MEAN_MIN, 0.9999);
  assert.equal(COSINE_MIN_MIN, 0.999);
});

// Builds a minimal, valid local-reference-style result package directory
// (the exact 4-file shape scripts/p11f0-colab-benchmark-local-reference-run.mjs
// produces) from a small set of {id, sha, vector} rows, for verifier tests.
async function writePackage(dir, prefix, rowsWithVectors, { model } = {}) {
  const dim = rowsWithVectors[0].vector.length;
  const flat = new Float32Array(rowsWithVectors.length * dim);
  rowsWithVectors.forEach((r, i) => flat.set(r.vector, i * dim));
  const npyBuf = encodeNpyFloat32Matrix(rowsWithVectors.length, dim, flat);
  const vectorPath = path.join(dir, `${prefix}-vectors.npy`);
  await writeFile(vectorPath, npyBuf);

  const mappingLines = rowsWithVectors.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha }));
  const mappingPath = path.join(dir, `${prefix}-row-mapping.jsonl`);
  await writeFile(mappingPath, `${mappingLines.join("\n")}\n`, "utf8");

  const runtime = {
    model: model ?? { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: dim },
    input_ordering_sha256: sha256Hex(rowsWithVectors.map((r) => r.id).join("\n")),
  };
  const runtimePath = path.join(dir, `${prefix}-runtime-manifest.json`);
  const runtimeStr = `${JSON.stringify(runtime, null, 2)}\n`;
  await writeFile(runtimePath, runtimeStr, "utf8");

  const integrity = {
    files: {
      [`${prefix}-vectors.npy`]: createHash("sha256").update(npyBuf).digest("hex"),
      [`${prefix}-row-mapping.jsonl`]: sha256Hex(`${mappingLines.join("\n")}\n`),
      [`${prefix}-runtime-manifest.json`]: sha256Hex(runtimeStr),
    },
  };
  await writeFile(path.join(dir, `${prefix}-file-integrity-manifest.json`), `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
  return { runtime, mappingLines, npyBuf };
}

async function writeSummaryAndSampleFulltext(dir, rows) {
  const summaryPath = path.join(dir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({ benchmark_sample: { sample_ids: rows.map((r) => r.id), actual_size: rows.length } }), "utf8");
  const sampleFulltextPath = path.join(dir, "sample-fulltext.jsonl");
  await writeFile(sampleFulltextPath, `${rows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha, text: `filler ${i}` })).join("\n")}\n`, "utf8");
  return { summaryPath, sampleFulltextPath };
}

function fixtureRows(n, dim, seedOffset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const sha = sha256Hex(`fixture-${i}-seed${seedOffset}`);
    const vector = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) vector[d] = Math.fround(Math.sin(i + d + seedOffset));
    let norm = 0; for (const v of vector) norm += v * v; norm = Math.sqrt(norm);
    for (let d = 0; d < dim; d += 1) vector[d] = Math.fround(vector[d] / norm);
    return { id: `embin_${sha.slice(0, 24)}`, sha, vector };
  });
}

test("verifier: identical local/remote packages pass with cosine ~1.0 and verdict COLAB_BENCHMARK_VERIFIED", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(6, 1024);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows, { model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 } });
    await writePackage(dir, "colab-cuda", rows, { model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 } });

    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.verdict, "COLAB_BENCHMARK_VERIFIED");
    assert.ok(report.cosine.mean_cosine > 0.999999);
    assert.ok(report.cosine.min_cosine > 0.999999);
  });
});

test("verifier: wrong model revision on the remote package is rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(4, 16);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows, { model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 16 } });
    await writePackage(dir, "colab-cuda", rows, { model: { repository: "nlpai-lab/KURE-v1", revision: "WRONG_REVISION", dimension: 16 } });
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("WRONG_MODEL_REVISION")));
  });
});

test("verifier: duplicate row in the remote package is rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(4, 16);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    const dupedRows = [...rows, rows[0]];
    await writePackage(dir, "colab-cuda", dupedRows);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("DUPLICATE_ROWS")));
  });
});

test("verifier: out-of-sample row and missing row are both rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(4, 16);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    const stray = fixtureRows(1, 16, 999)[0];
    const swapped = [...rows.slice(0, 3), stray]; // drops rows[3], adds an out-of-sample row
    await writePackage(dir, "colab-cuda", swapped);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("OUT_OF_SAMPLE_ROWS")));
    assert.ok(report.errors.some((e) => e.includes("MISSING_ROWS")));
  });
});

test("verifier: NaN/Inf vector components are rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(3, 8);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    const poisoned = rows.map((r, i) => (i === 1 ? { ...r, vector: Float32Array.from([...r.vector.slice(0, 4), NaN, Infinity, ...r.vector.slice(6)]) } : r));
    await writePackage(dir, "colab-cuda", poisoned);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("NON_FINITE_COMPONENTS")));
  });
});

test("verifier: non-unit-norm vectors (normalization mismatch) are rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(3, 8);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    const unnormalized = rows.map((r) => ({ ...r, vector: Float32Array.from(r.vector.map((v) => v * 5)) })); // norm 5, not 1
    await writePackage(dir, "colab-cuda", unnormalized);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("NORMALIZATION_MISMATCH")));
  });
});

test("verifier: tampered vector file (SHA no longer matches its own integrity manifest) is rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(3, 8);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    await writePackage(dir, "colab-cuda", rows);
    // Tamper the vector file AFTER its integrity manifest was written.
    const vectorPath = path.join(dir, "colab-cuda-vectors.npy");
    const buf = await readFile(vectorPath);
    buf[buf.length - 1] ^= 0xff;
    await writeFile(vectorPath, buf);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("FILE_SHA_MISMATCH")));
  });
});

test("verifier: cosine gate fails closed when remote vectors are simply wrong (orthogonal-ish, not just noisy)", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(5, 1024);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    const wrong = rows.map((r, i) => {
      const v = new Float32Array(1024);
      v[(i * 137) % 1024] = 1; // near-orthogonal one-hot-ish vector, unrelated to the local one
      return { ...r, vector: v };
    });
    await writePackage(dir, "colab-cuda", wrong);
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.equal(report.verdict, "COLAB_EMBEDDING_INCOMPATIBLE");
    assert.ok(report.errors.some((e) => e.includes("COSINE_MEAN_BELOW_THRESHOLD") || e.includes("COSINE_MIN_BELOW_THRESHOLD")));
  });
});

test("verifier: row_count mismatch between npy and row-mapping is rejected", async () => {
  await withTmpDir(async (dir) => {
    const rows = fixtureRows(4, 8);
    const { summaryPath, sampleFulltextPath } = await writeSummaryAndSampleFulltext(dir, rows);
    await writePackage(dir, "local-reference", rows);
    await writePackage(dir, "colab-cuda", rows);
    // Append an extra, unmapped mapping line so mapping.length != npy rows.
    const mappingPath = path.join(dir, "colab-cuda-row-mapping.jsonl");
    const extra = JSON.stringify({ input_index: 999, embedding_input_id: "embin_extra_unmapped_row_x", embed_text_sha256: "f".repeat(64) });
    const original = await readFile(mappingPath, "utf8");
    await writeFile(mappingPath, `${original}${extra}\n`, "utf8");
    // Recompute the integrity manifest so this failure is isolated to the row-count check, not a SHA mismatch.
    const integrityPath = path.join(dir, "colab-cuda-file-integrity-manifest.json");
    const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
    integrity.files["colab-cuda-row-mapping.jsonl"] = createHash("sha256").update(`${original}${extra}\n`, "utf8").digest("hex");
    await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, "utf8");

    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("ROW_COUNT_MAPPING_MISMATCH")));
  });
});
