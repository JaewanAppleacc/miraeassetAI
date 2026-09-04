// Turn AC-COLAB-FULL-SHARDS-V1, remaining items 1 and 5: scoped unit tests
// for scripts/p11f0-colab-full-shard-verify.mjs, run against small
// SYNTHETIC fixtures (never the real 441,879-row corpus-derived
// population). The "local shard set" fixture is produced by the ALREADY
// tested exportFullShards() itself (scripts/p11f0-colab-full-shard-export.mjs)
// so this suite verifies the verifier against the exporter's own real
// output shape, not a hand-rolled approximation of it. The "shard result
// package" fixture uses the already-tested encodeNpyFloat32Matrix/
// l2Normalize helpers from scripts/p11f0-colab-benchmark-local-reference-run.mjs.
//
// No DATABASE_URL, no KURE server, no real corpus text, no GPU.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportFullShards } from "../scripts/p11f0-colab-full-shard-export.mjs";
import { encodeNpyFloat32Matrix, l2Normalize } from "../scripts/p11f0-colab-benchmark-local-reference-run.mjs";
import { verifyLocalShardSet, verifyShardResultPackage, EXPECTED_DIMENSION } from "../scripts/p11f0-colab-full-shard-verify.mjs";

function sha256HexStr(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function sha256HexBuf(b) { return createHash("sha256").update(b).digest("hex"); }

const SMALL_TOTAL = 20;
const SMALL_SHARD_COUNT = 4;
const SMALL_BOUNDARIES = [
  { shard_index: 0, start_input_index: 0, end_input_index: 4, row_count: 5 },
  { shard_index: 1, start_input_index: 5, end_input_index: 9, row_count: 5 },
  { shard_index: 2, start_input_index: 10, end_input_index: 14, row_count: 5 },
  { shard_index: 3, start_input_index: 15, end_input_index: 19, row_count: 5 },
];

function makeRows(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const text = `synthetic placeholder text row ${i}`;
    const sha = sha256HexStr(text); // the REAL sha256 of text -- this verifier re-checks that invariant, unlike the exporter's own fixture
    rows.push({ embedding_input_id: `embin_synthetic_${String(i).padStart(4, "0")}`, embed_text_sha256: sha, char_length: text.length, text });
  }
  rows.sort((a, b) => (a.embed_text_sha256 < b.embed_text_sha256 ? -1 : a.embed_text_sha256 > b.embed_text_sha256 ? 1 : 0));
  return rows;
}

async function writeFixtureInputs(dir, rows) {
  const fullTextPath = path.join(dir, "fulltext.jsonl");
  await writeFile(fullTextPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  const fullTextSha256 = createHash("sha256").update(await readFile(fullTextPath)).digest("hex");

  const shardPlanPath = path.join(dir, "shard-plan.json");
  await writeFile(shardPlanPath, JSON.stringify({
    [`shard_plan_${SMALL_SHARD_COUNT}_contiguous`]: {
      shard_count: SMALL_SHARD_COUNT, complete: true, total_expected: SMALL_TOTAL, total_assigned: SMALL_TOTAL,
      shards: SMALL_BOUNDARIES.map((b) => ({ ...b, shard_sha256: `fake-${b.shard_index}` })),
    },
  }), "utf8");

  const summaryPath = path.join(dir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({
    unique_input_count: SMALL_TOTAL,
    model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024, dtype: "float32" },
    full_text_file: { sha256: fullTextSha256, line_count: SMALL_TOTAL },
  }), "utf8");

  return { fullTextPath, shardPlanPath, summaryPath };
}

async function makeVerifiedShardSet(workDir) {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixtureInputs(workDir, rows);
  const outDir = path.join(workDir, "out");
  await exportFullShards({
    fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath,
    expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES,
  });
  return { outDir, exportManifestPath: path.join(outDir, "full-shard-export-manifest.json"), rows };
}

let workDir;
test.beforeEach(async () => { workDir = await mkdtemp(path.join(tmpdir(), "p11f0-full-shard-verify-")); });
test.afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

test("local shard set: a freshly exported, untampered shard set verifies OK with zero overlap/missing", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.total_rows_verified, SMALL_TOTAL);
  assert.equal(report.overlap_count, 0);
  assert.equal(report.missing_global_index_count, 0);
  assert.equal(report.shards.length, SMALL_SHARD_COUNT);
  assert.ok(report.shards.every((s) => s.ok === true));
});

test("local shard set: a single tampered byte in one shard's gz file is caught as a hash mismatch, not silently accepted", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const shardPath = path.join(outDir, "kure-full-input-shard-000.jsonl.gz");
  const buf = await readFile(shardPath);
  buf[buf.length - 1] ^= 0xff;
  await writeFile(shardPath, buf);
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /COMPRESSED_FILE_SHA_MISMATCH|UNREADABLE_SHARD_FILE/.test(e)), JSON.stringify(report.errors));
});

test("local shard set: manifest claiming a different total_population than actual is caught", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  manifest.total_population = SMALL_TOTAL + 1;
  await writeFile(exportManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /TOTAL_ROWS_VERIFIED_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("local shard set: manifest's input_ordering_sha256 tampered is caught even though every individual shard file is untouched", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  manifest.input_ordering_sha256 = "0".repeat(64);
  await writeFile(exportManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /INPUT_ORDERING_SHA_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("local shard set: a shard boundary shrunk to create a gap is caught", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  manifest.shards[1].global_start_index = 6; // was 5 -- creates a 1-row gap
  await writeFile(exportManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /SHARD_BOUNDARY_GAP|GLOBAL_INDEX_RANGE_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("local shard set: wrong model revision in the manifest is caught", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  manifest.model.revision = "wrong-revision";
  await writeFile(exportManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const report = await verifyLocalShardSet({ exportManifestPath, shardsDir: outDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /MANIFEST_MODEL_PIN_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

// ---- shard result package (post-Colab download) ----

function makeResultPackage(rows, { tamper } = {}) {
  const dim = EXPECTED_DIMENSION;
  const flat = new Float32Array(rows.length * dim);
  for (let r = 0; r < rows.length; r += 1) {
    const raw = new Float32Array(dim);
    for (let c = 0; c < dim; c += 1) raw[c] = (r + 1) * (c + 1);
    const unit = l2Normalize(raw);
    flat.set(unit, r * dim);
  }
  if (tamper === "non_finite") flat[0] = NaN;
  if (tamper === "denormalized") flat[0] = 5;
  const vectorsBuf = encodeNpyFloat32Matrix(rows.length, dim, flat);
  const orderedRows = tamper === "shuffled_order" ? [...rows].reverse() : rows;
  const mappingLines = orderedRows.map((r) => JSON.stringify({ global_eligible_index: r.global_eligible_index, embedding_input_id: tamper === "duplicate_row" ? orderedRows[0].embedding_input_id : r.embedding_input_id, embed_text_sha256: r.embed_text_sha256 }));
  const mappingRaw = `${mappingLines.join("\n")}\n`;
  return { vectorsBuf, mappingRaw, dim };
}

async function writeResultPackage(resultDir, shardStr, shardMeta, rows, { modelOverrides = {}, tamper } = {}) {
  const { vectorsBuf, mappingRaw, dim } = makeResultPackage(rows, { tamper });
  await writeFile(path.join(resultDir, `shard-${shardStr}-vectors.npy`), vectorsBuf);
  await writeFile(path.join(resultDir, `shard-${shardStr}-row-mapping.jsonl`), mappingRaw, "utf8");
  const resultManifest = {
    schema_version: "p11f0-colab-full-shard-result-manifest.v1",
    shard_id: shardMeta.shard_index,
    shard_gz_sha256: tamper === "wrong_gz_sha" ? "0".repeat(64) : shardMeta.compressed_file_sha256,
    row_count: shardMeta.row_count,
    global_start_index: shardMeta.global_start_index,
    global_end_index: shardMeta.global_end_index,
    block_size: 1000,
    block_count: 1,
    model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: dim, dtype: "float32", ...modelOverrides },
    runner: "COLAB_CUDA_FULL_SHARD",
    device: "synthetic-test-gpu",
    generated_at: new Date().toISOString(),
    finalize_mode: tamper === "wrong_finalize_mode" ? "BLOCK_SET_AUTHORITATIVE" : "SINGLE_FILE",
    single_file_vectors_sha256: sha256HexBuf(vectorsBuf),
    single_file_mapping_sha256: sha256HexStr(mappingRaw),
  };
  await writeFile(path.join(resultDir, `shard-${shardStr}-result-manifest.json`), JSON.stringify(resultManifest, null, 2), "utf8");
  return resultManifest;
}

test("shard result package: a correctly constructed synthetic package verifies OK", async () => {
  const { outDir, exportManifestPath, rows } = await makeVerifiedShardSet(workDir);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const shardMeta = manifest.shards[0];
  const shardRows = rows.slice(shardMeta.global_start_index, shardMeta.global_end_index + 1).map((r, i) => ({ ...r, global_eligible_index: shardMeta.global_start_index + i }));
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows);
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.row_count, shardMeta.row_count);
  assert.equal(report.non_finite_count, 0);
});

async function writeFileSafeMkdir(dir) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}

async function shardFixtureForResultTests(workDirLocal) {
  const { outDir, exportManifestPath, rows } = await makeVerifiedShardSet(workDirLocal);
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const shardMeta = manifest.shards[0];
  const shardRows = rows.slice(shardMeta.global_start_index, shardMeta.global_end_index + 1).map((r, i) => ({ ...r, global_eligible_index: shardMeta.global_start_index + i }));
  return { outDir, exportManifestPath, shardMeta, shardRows };
}

test("shard result package: wrong shard_gz_sha256 in the result manifest is refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "wrong_gz_sha" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /RESULT_MANIFEST_SHARD_GZ_SHA_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: model revision mismatch is refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { modelOverrides: { revision: "wrong-revision" } });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /RESULT_MANIFEST_MODEL_PIN_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: non-finite vector component is refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "non_finite" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /NON_FINITE_COMPONENTS|VECTORS_FILE_SHA_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: a non-unit-norm vector is refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "denormalized" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /NORMALIZATION_MISMATCH|VECTORS_FILE_SHA_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: a duplicated embedding_input_id inside the mapping is refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "duplicate_row" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /DUPLICATE_ROWS_IN_MAPPING|MISSING_ROWS_IN_RESULT/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: mapping rows out of global_eligible_index order are refused", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "shuffled_order" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /MAPPING_ORDER_MISMATCH/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: BLOCK_SET_AUTHORITATIVE finalize mode (unsupported by this tool) is refused, not silently accepted as valid", async () => {
  const { outDir, exportManifestPath, shardMeta, shardRows } = await shardFixtureForResultTests(workDir);
  const resultDir = path.join(workDir, "result-0");
  await writeFileSafeMkdir(resultDir);
  await writeResultPackage(resultDir, "000", shardMeta, shardRows, { tamper: "wrong_finalize_mode" });
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 0, resultDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /UNSUPPORTED_FINALIZE_MODE/.test(e)), JSON.stringify(report.errors));
});

test("shard result package: shard index absent from the export manifest is refused outright", async () => {
  const { outDir, exportManifestPath } = await makeVerifiedShardSet(workDir);
  const report = await verifyShardResultPackage({ exportManifestPath, shardsDir: outDir, shardIndex: 999, resultDir: workDir });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /SHARD_NOT_IN_EXPORT_MANIFEST/.test(e)));
});

test("EXPECTED_DIMENSION export matches the task-pinned KURE-v1 dimension", () => {
  assert.equal(EXPECTED_DIMENSION, 1024);
});
