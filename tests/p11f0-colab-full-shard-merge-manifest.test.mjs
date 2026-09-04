// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 2: scoped unit tests for
// scripts/p11f0-colab-full-shard-merge-manifest.mjs, run against small
// SYNTHETIC export/result manifests (never the real 8-shard/441,879-row
// population). Never reads/writes vector bytes, DB, Gold, DEV_CHECK, or
// HOLDOUT.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildLogicalMergeManifest, writeJsonAtomic, LOGICAL_MERGE_MANIFEST_SCHEMA,
  EXPECTED_MODEL_REPOSITORY, EXPECTED_MODEL_REVISION, EXPECTED_DIMENSION,
} from "../scripts/p11f0-colab-full-shard-merge-manifest.mjs";

const MODEL = { repository: EXPECTED_MODEL_REPOSITORY, revision: EXPECTED_MODEL_REVISION, dimension: EXPECTED_DIMENSION, dtype: "float32" };

function makeExportManifest({ shardCount = 4, rowsPerShard = 5 } = {}) {
  const shards = [];
  for (let i = 0; i < shardCount; i += 1) {
    shards.push({
      shard_id: `kure-full-input-shard-${String(i).padStart(3, "0")}`,
      shard_index: i,
      global_start_index: i * rowsPerShard,
      global_end_index: (i + 1) * rowsPerShard - 1,
      row_count: rowsPerShard,
      compressed_file_sha256: `gzsha-${i}`,
      model: MODEL,
    });
  }
  return {
    schema_version: "p11f0-colab-full-shard-export.v1",
    total_population: shardCount * rowsPerShard,
    shard_count: shardCount,
    input_membership_sha256: "membership-sha-fixture",
    input_ordering_sha256: "ordering-sha-fixture",
    shards,
  };
}

function makeResultManifest(exportManifest, shardIndex, overrides = {}) {
  const shard = exportManifest.shards.find((s) => s.shard_index === shardIndex);
  return {
    schema_version: "p11f0-colab-full-shard-result-manifest.v1",
    shard_id: shardIndex,
    shard_gz_sha256: shard.compressed_file_sha256,
    row_count: shard.row_count,
    global_start_index: shard.global_start_index,
    global_end_index: shard.global_end_index,
    model: MODEL,
    finalize_mode: "SINGLE_FILE",
    ...overrides,
  };
}

let workDir;
test.beforeEach(async () => { workDir = await mkdtemp(path.join(tmpdir(), "p11f0-full-shard-merge-")); });
test.afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

test("zero result manifests: well-formed not-yet-complete merge manifest, no error", () => {
  const exportManifest = makeExportManifest();
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests: [] });
  assert.equal(merged.ok, true);
  assert.equal(merged.is_complete, false);
  assert.deepEqual(merged.shards_present, []);
  assert.deepEqual(merged.shards_missing, [0, 1, 2, 3]);
  assert.equal(merged.total_rows_covered_so_far, 0);
  assert.equal(merged.vectors_merged, false);
  assert.equal(merged.schema_version, LOGICAL_MERGE_MANIFEST_SCHEMA);
});

test("partial: 2 of 4 shards present -- reports the correct missing set and partial coverage, still ok", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = [makeResultManifest(exportManifest, 0), makeResultManifest(exportManifest, 2)];
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, true);
  assert.equal(merged.is_complete, false);
  assert.deepEqual(merged.shards_present, [0, 2]);
  assert.deepEqual(merged.shards_missing, [1, 3]);
  assert.equal(merged.total_rows_covered_so_far, 10);
});

test("complete: all shards present and consistent -- is_complete true, zero overlap/missing", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = exportManifest.shards.map((s) => makeResultManifest(exportManifest, s.shard_index));
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, true);
  assert.equal(merged.is_complete, true);
  assert.deepEqual(merged.shards_missing, []);
  assert.equal(merged.total_rows_covered_so_far, exportManifest.total_population);
  assert.equal(merged.overlap_count, 0);
  assert.equal(merged.missing_global_index_count, 0);
});

test("result manifests supplied out of shard-index order are still merged in order and marked complete", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = [3, 1, 0, 2].map((i) => makeResultManifest(exportManifest, i));
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.is_complete, true);
  assert.deepEqual(merged.shards_present, [0, 1, 2, 3]);
});

test("a result manifest whose shard_gz_sha256 disagrees with the export manifest is refused, never silently merged", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = exportManifest.shards.map((s) => makeResultManifest(exportManifest, s.shard_index));
  resultManifests[1].shard_gz_sha256 = "tampered-sha";
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, false);
  assert.equal(merged.is_complete, false);
  assert.ok(merged.errors.some((e) => /SHARD_GZ_SHA_MISMATCH/.test(e)), JSON.stringify(merged.errors));
  assert.equal(merged.shards.find((s) => s.shard_index === 1).ok, false);
});

test("a duplicate result manifest for the same shard index is refused", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = [makeResultManifest(exportManifest, 0), makeResultManifest(exportManifest, 0)];
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, false);
  assert.ok(merged.errors.some((e) => /DUPLICATE_RESULT_MANIFEST_FOR_SHARD/.test(e)), JSON.stringify(merged.errors));
});

test("a shard_id not present in the export manifest at all is refused", () => {
  const exportManifest = makeExportManifest();
  const foreignResultManifest = {
    ...makeResultManifest(exportManifest, 0),
    shard_id: 99, global_start_index: 100, global_end_index: 104,
  };
  const resultManifests = [makeResultManifest(exportManifest, 0), foreignResultManifest];
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, false);
  assert.ok(merged.errors.some((e) => /SHARD_NOT_IN_EXPORT_MANIFEST/.test(e)), JSON.stringify(merged.errors));
});

test("a model pin mismatch on one shard's result manifest is refused, blocking is_complete even when all 4 shards are present", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = exportManifest.shards.map((s) => makeResultManifest(exportManifest, s.shard_index));
  resultManifests[3].model = { ...MODEL, revision: "wrong-revision" };
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, false);
  assert.equal(merged.is_complete, false);
  assert.ok(merged.errors.some((e) => /MODEL_PIN_MISMATCH/.test(e)), JSON.stringify(merged.errors));
});

test("an unknown finalize_mode is refused", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = [makeResultManifest(exportManifest, 0, { finalize_mode: "SOMETHING_ELSE" })];
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.ok, false);
  assert.ok(merged.errors.some((e) => /UNKNOWN_FINALIZE_MODE/.test(e)), JSON.stringify(merged.errors));
});

test("writeJsonAtomic writes valid, re-readable JSON and never leaves a .partial file behind", async () => {
  const exportManifest = makeExportManifest();
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests: [] });
  const outPath = path.join(workDir, "logical-merge-manifest.json");
  await writeJsonAtomic(outPath, merged);
  const readBack = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(readBack.schema_version, LOGICAL_MERGE_MANIFEST_SCHEMA);
  await assert.rejects(readFile(`${outPath}.partial`));
});

test("never merges/materializes actual vector bytes -- vectors_merged is always false, real_embedding_calls_performed is always 0", () => {
  const exportManifest = makeExportManifest();
  const resultManifests = exportManifest.shards.map((s) => makeResultManifest(exportManifest, s.shard_index));
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  assert.equal(merged.vectors_merged, false);
  assert.equal(merged.real_embedding_calls_performed, 0);
  assert.equal(merged.external_upload_performed, false);
});
