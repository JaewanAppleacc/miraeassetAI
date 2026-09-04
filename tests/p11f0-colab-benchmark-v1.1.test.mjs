// Turn AC-COLAB-COMPAT-V1.1. Offline/synthetic tests for:
//   (a) the deterministic length-stratified 500-row local-subset selector
//   (b) the local runner's mkdir / fail-fast / no-incomplete-output fixes
//       (against a fake local HTTP server -- never the real KURE server)
//   (c) the verifier's new localSampleFulltextPath subset-vs-full comparison
// See domain/agent-comparison/four-arm-ac/AC_COLAB_BENCH_V1.1_AMENDMENT.md
// for the amendment this implements. Zero Gold/DEV_CHECK/HOLDOUT content;
// all fixture text is invented lorem-ipsum-style filler.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { selectLengthStratifiedSubset } from "../scripts/p11f0-colab-benchmark-select-local-subset.mjs";
import { encodeNpyFloat32Matrix } from "../scripts/p11f0-colab-benchmark-local-reference-run.mjs";
import { verifyGpuBenchmarkPackage } from "../scripts/p11f0-colab-benchmark-verify.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const EXPECTED_DIMENSION = 1024;

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "p11f0-colab-bench-v11-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureRow(i, charLength) {
  const sha = sha256Hex(`fixture-row-${i}`);
  return {
    embedding_input_id: `embin_${sha.slice(0, 24)}`,
    embed_text_sha256: sha,
    text: "x".repeat(charLength),
  };
}

// ---------------------------------------------------------------------
// (a) length-stratified selector
// ---------------------------------------------------------------------

test("length-stratified selector: selects exactly strataCount*perStratum rows, one contiguous length-rank block per stratum", () => {
  const n = 500;
  const rows = Array.from({ length: n }, (_, i) => fixtureRow(i, 1 + (i % 200))); // varied lengths 1..200
  const { selected, strataBoundaries, population } = selectLengthStratifiedSubset(rows, { strataCount: 10, perStratum: 5 });
  assert.equal(population, n);
  assert.equal(selected.length, 50);
  assert.equal(strataBoundaries.length, 10);
  // Strata must be non-decreasing in length range and cover the full range.
  for (let i = 1; i < strataBoundaries.length; i += 1) {
    assert.ok(strataBoundaries[i].char_length_min >= strataBoundaries[i - 1].char_length_min);
  }
  // No duplicate ids in the selection.
  const ids = selected.map((r) => r.embedding_input_id);
  assert.equal(new Set(ids).size, ids.length);
});

test("length-stratified selector: spans the full length distribution, not concentrated in one region", () => {
  const n = 500;
  const rows = Array.from({ length: n }, (_, i) => fixtureRow(i, 1 + i)); // lengths 1..500, strictly increasing
  const { selected } = selectLengthStratifiedSubset(rows, { strataCount: 10, perStratum: 5 });
  const lengths = selected.map((r) => r.char_length).sort((a, b) => a - b);
  // With strictly increasing lengths 1..500 split into 10 equal-rank
  // deciles of 50 each, the selection must include rows from both the
  // shortest and longest decile.
  assert.ok(lengths[0] <= 50, `shortest selected row should come from the first decile, got ${lengths[0]}`);
  assert.ok(lengths[lengths.length - 1] > 450, `longest selected row should come from the last decile, got ${lengths[lengths.length - 1]}`);
});

test("length-stratified selector: deterministic re-run on the same input reproduces byte-identical selection", () => {
  const n = 500;
  const rows = Array.from({ length: n }, (_, i) => fixtureRow(i, 1 + (i % 200)));
  const run1 = selectLengthStratifiedSubset(rows, { strataCount: 10, perStratum: 5 });
  const run2 = selectLengthStratifiedSubset([...rows].reverse(), { strataCount: 10, perStratum: 5 }); // order-independent input
  assert.deepEqual(run1.selected.map((r) => r.embedding_input_id), run2.selected.map((r) => r.embedding_input_id));
});

test("length-stratified selector: fails closed on population size mismatch", () => {
  const rows = Array.from({ length: 10 }, (_, i) => fixtureRow(i, 5));
  assert.throws(() => selectLengthStratifiedSubset(rows, { strataCount: 10, perStratum: 5, expectedPopulation: 5000 }), /POPULATION_SIZE_MISMATCH/);
});

test("length-stratified selector: fails closed when a stratum is too small to supply perStratum rows", () => {
  const rows = Array.from({ length: 20 }, (_, i) => fixtureRow(i, 5)); // 20 rows / 10 strata = 2 each, asking for 5
  assert.throws(() => selectLengthStratifiedSubset(rows, { strataCount: 10, perStratum: 5 }), /STRATUM_TOO_SMALL/);
});

test("select-local-subset CLI: writes the expected row count and a stable sample_manifest_sha256", async () => {
  await withTmpDir(async (dir) => {
    const n = 200;
    const rows = Array.from({ length: n }, (_, i) => fixtureRow(i, 1 + (i % 100)));
    const fullTextPath = path.join(dir, "fulltext.jsonl");
    await writeFile(fullTextPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    const outPath = path.join(dir, "subset.jsonl");

    const { stdout } = await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-select-local-subset.mjs"), fullTextPath, outPath], {
      env: { ...process.env, P11F0_SUBSET_STRATA_COUNT: "10", P11F0_SUBSET_PER_STRATUM: "2", P11F0_SUBSET_EXPECTED_POPULATION: "200" },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.selected_count, 20);

    const outLines = (await readFile(outPath, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.equal(outLines.length, 20);
    // Every selected row's id/sha must be present in the original population.
    const originalIds = new Set(rows.map((r) => r.embedding_input_id));
    for (const row of outLines) assert.ok(originalIds.has(row.embedding_input_id));

    // Re-running reproduces the exact same sample_manifest_sha256.
    const outPath2 = path.join(dir, "subset2.jsonl");
    const { stdout: stdout2 } = await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-select-local-subset.mjs"), fullTextPath, outPath2], {
      env: { ...process.env, P11F0_SUBSET_STRATA_COUNT: "10", P11F0_SUBSET_PER_STRATUM: "2", P11F0_SUBSET_EXPECTED_POPULATION: "200" },
    });
    const result2 = JSON.parse(stdout2);
    assert.equal(result.sample_manifest_sha256, result2.sample_manifest_sha256);
  });
});

// ---------------------------------------------------------------------
// (b) local runner: mkdir / fail-fast / no-incomplete-output
// ---------------------------------------------------------------------

function fakeVector(seed) {
  return Array.from({ length: EXPECTED_DIMENSION }, (_, d) => Math.sin(seed + d) + 2); // never all-zero, never exactly unit-norm pre-normalize
}

async function startFakeKureServer({ infoOverrides = {}, onEmbeddingsBatch }) {
  const infoResponse = {
    repository_id: "nlpai-lab/KURE-v1",
    model_revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
    embedding_dimension: EXPECTED_DIMENSION,
    device: "cpu",
    mps_attempted: false,
    mps_failure_reason: null,
    runtime_versions: { python: "3.9.6" },
    ...infoOverrides,
  };
  let batchIndex = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(infoResponse));
      return;
    }
    if (req.url === "/v1/embeddings" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const thisBatch = batchIndex;
        batchIndex += 1;
        onEmbeddingsBatch(thisBatch, parsed, res);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/v1/embeddings` };
}

test("local runner: creates a not-yet-existing nested outDir and writes a complete 4-file package on an all-success run", async () => {
  await withTmpDir(async (dir) => {
    const rows = [0, 1].map((i) => fixtureRow(i, 10));
    const fullTextPath = path.join(dir, "sample.jsonl");
    await writeFile(fullTextPath, `${rows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.embedding_input_id, embed_text_sha256: r.embed_text_sha256, text: r.text })).join("\n")}\n`, "utf8");
    const outDir = path.join(dir, "nested", "does", "not", "exist", "yet");

    const { server, url } = await startFakeKureServer({
      onEmbeddingsBatch: (batchIndex, parsed, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: parsed.input.map((_, i) => ({ embedding: fakeVector(batchIndex * 10 + i) })) }));
      },
    });
    try {
      const { stdout } = await execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-local-reference-run.mjs"), fullTextPath, outDir], {
        env: { ...process.env, P11F0_KURE_SERVER_URL: url, P11F0_LOCAL_RUN_BATCH_SIZE: "2" },
      });
      const manifest = JSON.parse(stdout);
      assert.equal(manifest.row_count_succeeded, 2);
      assert.equal(manifest.row_count_failed, 0);

      const files = (await readdir(outDir)).sort();
      assert.deepEqual(files, [
        "local-reference-file-integrity-manifest.json",
        "local-reference-row-mapping.jsonl",
        "local-reference-runtime-manifest.json",
        "local-reference-vectors.npy",
      ]);
    } finally {
      server.close();
    }
  });
});

test("local runner: fail-fast aborts the whole run on the first batch failure and writes NO output files (no incomplete package)", async () => {
  await withTmpDir(async (dir) => {
    const rows = [0, 1, 2, 3].map((i) => fixtureRow(i, 10));
    const fullTextPath = path.join(dir, "sample.jsonl");
    await writeFile(fullTextPath, `${rows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.embedding_input_id, embed_text_sha256: r.embed_text_sha256, text: r.text })).join("\n")}\n`, "utf8");
    const outDir = path.join(dir, "out");

    const { server, url } = await startFakeKureServer({
      onEmbeddingsBatch: (batchIndex, parsed, res) => {
        if (batchIndex === 0) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: parsed.input.map((_, i) => ({ embedding: fakeVector(i) })) }));
          return;
        }
        // Second batch fails -- the run must abort here, never reach a third.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "simulated failure" }));
      },
    });
    try {
      await assert.rejects(
        execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-local-reference-run.mjs"), fullTextPath, outDir], {
          env: { ...process.env, P11F0_KURE_SERVER_URL: url, P11F0_LOCAL_RUN_BATCH_SIZE: "2" },
        }),
        /LOCAL_RUN_ABORTED_ON_BATCH_FAILURE/,
      );
      // mkdir still happened (outDir exists), but it must be EMPTY -- no
      // partial/incomplete package pretending to be a real result.
      const files = await readdir(outDir);
      assert.deepEqual(files, []);
    } finally {
      server.close();
    }
  });
});

test("local runner: fails closed on a KURE server pin mismatch before writing anything, outDir left as found", async () => {
  await withTmpDir(async (dir) => {
    const rows = [0].map((i) => fixtureRow(i, 10));
    const fullTextPath = path.join(dir, "sample.jsonl");
    await writeFile(fullTextPath, `${rows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.embedding_input_id, embed_text_sha256: r.embed_text_sha256, text: r.text })).join("\n")}\n`, "utf8");
    const outDir = path.join(dir, "out-pin-mismatch");
    await mkdir(outDir, { recursive: true });

    const { server, url } = await startFakeKureServer({
      infoOverrides: { model_revision: "SOME_OTHER_REVISION" },
      onEmbeddingsBatch: () => { throw new Error("must not be called"); },
    });
    try {
      await assert.rejects(
        execFileAsync("node", [path.join(ROOT, "scripts/p11f0-colab-benchmark-local-reference-run.mjs"), fullTextPath, outDir], {
          env: { ...process.env, P11F0_KURE_SERVER_URL: url },
        }),
        /KURE_SERVER_PIN_MISMATCH/,
      );
      assert.deepEqual(await readdir(outDir), []);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------
// (c) verifier: localSampleFulltextPath subset-vs-full comparison
// ---------------------------------------------------------------------

async function writePackage(dir, prefix, rowsWithVectors) {
  const dim = rowsWithVectors[0].vector.length;
  const flat = new Float32Array(rowsWithVectors.length * dim);
  rowsWithVectors.forEach((r, i) => flat.set(r.vector, i * dim));
  const npyBuf = encodeNpyFloat32Matrix(rowsWithVectors.length, dim, flat);
  await writeFile(path.join(dir, `${prefix}-vectors.npy`), npyBuf);

  const mappingLines = rowsWithVectors.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha }));
  await writeFile(path.join(dir, `${prefix}-row-mapping.jsonl`), `${mappingLines.join("\n")}\n`, "utf8");

  const runtime = {
    model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: dim },
    input_ordering_sha256: sha256Hex(rowsWithVectors.map((r) => r.id).join("\n")),
  };
  const runtimeStr = `${JSON.stringify(runtime, null, 2)}\n`;
  await writeFile(path.join(dir, `${prefix}-runtime-manifest.json`), runtimeStr, "utf8");

  const integrity = {
    files: {
      [`${prefix}-vectors.npy`]: createHash("sha256").update(npyBuf).digest("hex"),
      [`${prefix}-row-mapping.jsonl`]: sha256Hex(`${mappingLines.join("\n")}\n`),
      [`${prefix}-runtime-manifest.json`]: sha256Hex(runtimeStr),
    },
  };
  await writeFile(path.join(dir, `${prefix}-file-integrity-manifest.json`), `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
}

function fixtureRowsWithVectors(n, dim, seedOffset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const sha = sha256Hex(`v11-fixture-${i}-seed${seedOffset}`);
    const vector = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) vector[d] = Math.fround(Math.sin(i + d + seedOffset));
    let norm = 0; for (const v of vector) norm += v * v; norm = Math.sqrt(norm);
    for (let d = 0; d < dim; d += 1) vector[d] = Math.fround(vector[d] / norm);
    return { id: `embin_${sha.slice(0, 24)}`, sha, vector };
  });
}

test("verifier: local subset (2 rows) verified against a remote package covering a larger population (6 rows) via localSampleFulltextPath", async () => {
  await withTmpDir(async (dir) => {
    const allRows = fixtureRowsWithVectors(6, EXPECTED_DIMENSION);
    const subsetRows = [allRows[1], allRows[4]]; // arbitrary 2-of-6 subset

    const summaryPath = path.join(dir, "summary.json");
    await writeFile(summaryPath, JSON.stringify({ benchmark_sample: { sample_ids: allRows.map((r) => r.id), actual_size: allRows.length } }), "utf8");
    const sampleFulltextPath = path.join(dir, "sample-fulltext.jsonl");
    await writeFile(sampleFulltextPath, `${allRows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha, text: `filler ${i}` })).join("\n")}\n`, "utf8");
    const localSampleFulltextPath = path.join(dir, "local-subset-fulltext.jsonl");
    await writeFile(localSampleFulltextPath, `${subsetRows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha, text: `filler ${i}` })).join("\n")}\n`, "utf8");

    await writePackage(dir, "local-reference", subsetRows);
    await writePackage(dir, "colab-cuda", allRows);

    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localSampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.verdict, "COLAB_BENCHMARK_VERIFIED");
    assert.equal(report.cosine.compared_count, 2);
    assert.ok(report.cosine.mean_cosine > 0.999999);
  });
});

test("verifier: local subset checked against the FULL population (no localSampleFulltextPath) correctly reports MISSING_ROWS -- old behavior unchanged", async () => {
  await withTmpDir(async (dir) => {
    const allRows = fixtureRowsWithVectors(6, 32);
    const subsetRows = [allRows[1], allRows[4]];

    const summaryPath = path.join(dir, "summary.json");
    await writeFile(summaryPath, JSON.stringify({ benchmark_sample: { sample_ids: allRows.map((r) => r.id), actual_size: allRows.length } }), "utf8");
    const sampleFulltextPath = path.join(dir, "sample-fulltext.jsonl");
    await writeFile(sampleFulltextPath, `${allRows.map((r, i) => JSON.stringify({ input_index: i, embedding_input_id: r.id, embed_text_sha256: r.sha, text: `filler ${i}` })).join("\n")}\n`, "utf8");

    await writePackage(dir, "local-reference", subsetRows);
    await writePackage(dir, "colab-cuda", allRows);

    // No localSampleFulltextPath passed -- local is checked against the
    // full 6-row population, same as before this parameter existed.
    const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir: dir, remoteDir: dir, remotePrefix: "colab-cuda" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("MISSING_ROWS")));
  });
});
