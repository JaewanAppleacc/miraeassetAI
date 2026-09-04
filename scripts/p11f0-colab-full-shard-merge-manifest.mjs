#!/usr/bin/env node
// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 2: logical merge manifest
// builder. Combines the local full-shard-export-manifest.json (the
// authoritative boundary/hash record for all 8 input shards) with however
// many per-shard RESULT manifests (produced by
// gpu-full-shard-colab-cuda-runner-v1.ipynb's Cell 6, one per completed
// shard, 0..8 of them) into a single top-level view of embedding progress.
//
// "Logical" merge: this NEVER reads or concatenates the actual vector
// (.npy) bytes -- only each shard's own small JSON result-manifest. No
// vectors are materialized, no database write happens, and a caller with
// zero completed shards gets a well-formed (not-yet-complete) merge
// manifest rather than an error.
import { readFile, writeFile, rename } from "node:fs/promises";

const EXPORT_MANIFEST_SCHEMA = "p11f0-colab-full-shard-export.v1";
const RESULT_MANIFEST_SCHEMA = "p11f0-colab-full-shard-result-manifest.v1";
export const LOGICAL_MERGE_MANIFEST_SCHEMA = "p11f0-colab-full-shard-logical-merge.v1";
export const EXPECTED_MODEL_REPOSITORY = "nlpai-lab/KURE-v1";
export const EXPECTED_MODEL_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";
export const EXPECTED_DIMENSION = 1024;

export async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(partialPath, finalPath);
}

// resultManifests: array of already-parsed result-manifest.json objects
// (one per completed shard) -- never re-reads the vectors/mapping bytes,
// that is verifyShardResultPackage's job (scripts/p11f0-colab-full-shard-verify.mjs).
export function buildLogicalMergeManifest({ exportManifest, resultManifests }) {
  const errors = [];
  if (exportManifest.schema_version !== EXPORT_MANIFEST_SCHEMA) errors.push(`WRONG_EXPORT_MANIFEST_SCHEMA: ${exportManifest.schema_version}`);
  const byShardIndex = new Map(exportManifest.shards.map((s) => [s.shard_index, s]));
  const totalPopulation = exportManifest.total_population;
  const shardCount = exportManifest.shard_count;

  const seenShardIndices = new Set();
  const perShard = [];
  for (const rm of resultManifests) {
    const shardIndex = rm.shard_id;
    const entryErrors = [];
    if (rm.schema_version !== RESULT_MANIFEST_SCHEMA) entryErrors.push(`WRONG_RESULT_MANIFEST_SCHEMA: ${rm.schema_version}`);
    if (seenShardIndices.has(shardIndex)) entryErrors.push(`DUPLICATE_RESULT_MANIFEST_FOR_SHARD: ${shardIndex}`);
    seenShardIndices.add(shardIndex);

    const exportShard = byShardIndex.get(shardIndex);
    if (!exportShard) {
      entryErrors.push(`SHARD_NOT_IN_EXPORT_MANIFEST: ${shardIndex}`);
    } else {
      if (rm.shard_gz_sha256 !== exportShard.compressed_file_sha256) entryErrors.push(`SHARD_GZ_SHA_MISMATCH: result=${rm.shard_gz_sha256} export=${exportShard.compressed_file_sha256}`);
      if (rm.row_count !== exportShard.row_count) entryErrors.push(`ROW_COUNT_MISMATCH: result=${rm.row_count} export=${exportShard.row_count}`);
      if (rm.global_start_index !== exportShard.global_start_index || rm.global_end_index !== exportShard.global_end_index) {
        entryErrors.push(`GLOBAL_RANGE_MISMATCH: result=[${rm.global_start_index},${rm.global_end_index}] export=[${exportShard.global_start_index},${exportShard.global_end_index}]`);
      }
    }
    if (rm.model?.repository !== EXPECTED_MODEL_REPOSITORY || rm.model?.revision !== EXPECTED_MODEL_REVISION || rm.model?.dimension !== EXPECTED_DIMENSION || rm.model?.dtype !== "float32") {
      entryErrors.push(`MODEL_PIN_MISMATCH: ${JSON.stringify(rm.model)}`);
    }
    if (rm.finalize_mode !== "SINGLE_FILE" && rm.finalize_mode !== "BLOCK_SET_AUTHORITATIVE") {
      entryErrors.push(`UNKNOWN_FINALIZE_MODE: ${rm.finalize_mode}`);
    }

    for (const e of entryErrors) errors.push(`shard ${shardIndex}: ${e}`);
    perShard.push({
      shard_index: shardIndex,
      row_count: rm.row_count,
      global_start_index: rm.global_start_index,
      global_end_index: rm.global_end_index,
      finalize_mode: rm.finalize_mode,
      shard_gz_sha256: rm.shard_gz_sha256,
      ok: entryErrors.length === 0,
      errors: entryErrors,
    });
  }
  perShard.sort((a, b) => a.shard_index - b.shard_index);

  // Coverage over the FULL expected shard_count set, independent of how
  // many result manifests were actually supplied -- a partial run (e.g.
  // 3 of 8 shards done) reports missing_shard_indices rather than treating
  // absence as an error.
  const missingShardIndices = [];
  for (let i = 0; i < shardCount; i += 1) if (!seenShardIndices.has(i)) missingShardIndices.push(i);

  let overlapCount = 0;
  let missingGlobalIndexCount = 0;
  let expectedNextIndex = 0;
  let totalRowsCoveredSoFar = 0;
  for (const entry of perShard) {
    if (!entry.ok) continue;
    if (entry.global_start_index < expectedNextIndex) overlapCount += 1;
    if (entry.global_start_index > expectedNextIndex) missingGlobalIndexCount += entry.global_start_index - expectedNextIndex;
    expectedNextIndex = entry.global_end_index + 1;
    totalRowsCoveredSoFar += entry.row_count;
  }

  const isComplete = missingShardIndices.length === 0 && perShard.every((s) => s.ok) && errors.length === 0
    && totalRowsCoveredSoFar === totalPopulation && overlapCount === 0;

  return {
    schema_version: LOGICAL_MERGE_MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    source_export_manifest_input_membership_sha256: exportManifest.input_membership_sha256,
    source_export_manifest_input_ordering_sha256: exportManifest.input_ordering_sha256,
    total_population: totalPopulation,
    shard_count: shardCount,
    model: { repository: EXPECTED_MODEL_REPOSITORY, revision: EXPECTED_MODEL_REVISION, dimension: EXPECTED_DIMENSION, dtype: "float32" },
    shards_present: perShard.map((s) => s.shard_index),
    shards_missing: missingShardIndices,
    shards: perShard,
    total_rows_covered_so_far: totalRowsCoveredSoFar,
    overlap_count: overlapCount,
    missing_global_index_count: missingGlobalIndexCount,
    is_complete: isComplete,
    ok: errors.length === 0,
    errors,
    vectors_merged: false,
    external_upload_performed: false,
    real_embedding_calls_performed: 0,
  };
}

async function main() {
  const [exportManifestPath, outPath, ...resultManifestPaths] = process.argv.slice(2);
  if (!exportManifestPath || !outPath) {
    console.error("usage: node p11f0-colab-full-shard-merge-manifest.mjs <full-shard-export-manifest.json> <out-logical-merge-manifest.json> [shard-NNN-result-manifest.json ...]");
    process.exitCode = 1;
    return;
  }
  const exportManifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const resultManifests = await Promise.all(resultManifestPaths.map(async (p) => JSON.parse(await readFile(p, "utf8"))));
  const merged = buildLogicalMergeManifest({ exportManifest, resultManifests });
  await writeJsonAtomic(outPath, merged);
  console.log(JSON.stringify({ ...merged, shards: undefined }, null, 2));
  process.exitCode = merged.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[full-shard-merge-manifest] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
