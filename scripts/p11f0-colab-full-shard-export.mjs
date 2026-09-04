#!/usr/bin/env node
// Turn AC-COLAB-FULL-SHARDS-V1, section D/E/F: materializes the 8
// deterministic, contiguous, gzip-JSONL input shards for the full
// 441,879-row eligible KURE-v1 embedding population, from the ALREADY
// verified full-text file (embedding-input-fulltext.jsonl, sha256
// d56afd3f9ddbd97d922c9b578862ef117e64e4f1d17b629e5365434642144ac2,
// produced and independently re-verified by Turn AC-COLAB-BENCH-V1 --
// see AC_COLAB_BENCH_V1_HANDOFF.md section B/D) and the pre-existing
// shard-plan.json's shard_plan_8_contiguous boundaries (produced by
// p11f0-colab-benchmark-shard-plan.mjs) -- this script does NOT invent a
// new ordering, it reuses the already-fixed authoritative one.
//
// NEVER calls an embedding model, NEVER uploads anything, NEVER writes
// to the database. Only 4 fields are ever written per row:
// global_eligible_index, embedding_input_id, embed_text_sha256, text --
// no char_length, no question_id/expected_answer/DEV_CHECK/HOLDOUT/Owner
// decision/DB URL/API key/raw DocumentIR content (the source file itself
// never carried any of those fields to begin with).
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir, statfs } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { gzipDeterministic } from "../domain/adapters/deterministic-gzip.mjs";

export const EXPECTED_TOTAL = 441879;
export const EXPECTED_SHARD_COUNT = 8;
export const MIN_FREE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB safety floor, section F

export const EXPECTED_BOUNDARIES = [
  { shard_index: 0, start_input_index: 0, end_input_index: 55234, row_count: 55235 },
  { shard_index: 1, start_input_index: 55235, end_input_index: 110469, row_count: 55235 },
  { shard_index: 2, start_input_index: 110470, end_input_index: 165704, row_count: 55235 },
  { shard_index: 3, start_input_index: 165705, end_input_index: 220939, row_count: 55235 },
  { shard_index: 4, start_input_index: 220940, end_input_index: 276174, row_count: 55235 },
  { shard_index: 5, start_input_index: 276175, end_input_index: 331409, row_count: 55235 },
  { shard_index: 6, start_input_index: 331410, end_input_index: 386644, row_count: 55235 },
  { shard_index: 7, start_input_index: 386645, end_input_index: 441878, row_count: 55234 },
];

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function sha256HexOfBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(partialPath, finalPath);
}

async function writeBufferAtomic(finalPath, buffer) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, buffer, { flag: "w" });
  await rename(partialPath, finalPath);
}

export async function freeBytes(dirPath) {
  const stats = await statfs(dirPath);
  return stats.bavail * stats.bsize;
}

export function shardFileName(shardIndex) {
  return `kure-full-input-shard-${String(shardIndex).padStart(3, "0")}.jsonl.gz`;
}

// Loads and validates shard-plan.json's shard_plan_8_contiguous section
// against the literal, task-fixed boundaries (expectedBoundaries) --
// refuses (fail-closed, never silently re-derives a different partition)
// if the pre-existing plan disagrees with the boundaries this Turn was
// given.
export async function loadAndVerifyShardPlan(shardPlanPath, expectedBoundaries = EXPECTED_BOUNDARIES, expectedTotal = EXPECTED_TOTAL, expectedShardCount = EXPECTED_SHARD_COUNT) {
  const plan = JSON.parse(await readFile(shardPlanPath, "utf8"));
  const key = `shard_plan_${expectedShardCount}_contiguous`;
  const section = plan[key];
  if (!section) throw new Error(`SHARD_PLAN_MISSING_SECTION: shard-plan.json has no ${key} section`);
  if (!section.complete) throw new Error(`SHARD_PLAN_INCOMPLETE: ${key}.complete is not true`);
  if (section.total_expected !== expectedTotal || section.total_assigned !== expectedTotal) {
    throw new Error(`SHARD_PLAN_TOTAL_MISMATCH: expected ${expectedTotal}, plan has total_expected=${section.total_expected} total_assigned=${section.total_assigned}`);
  }
  if (section.shards.length !== expectedShardCount) throw new Error(`SHARD_PLAN_COUNT_MISMATCH: expected ${expectedShardCount} shards, got ${section.shards.length}`);
  for (let i = 0; i < expectedShardCount; i += 1) {
    const actual = section.shards[i];
    const expected = expectedBoundaries[i];
    if (actual.shard_index !== expected.shard_index || actual.start_input_index !== expected.start_input_index
      || actual.end_input_index !== expected.end_input_index || actual.row_count !== expected.row_count) {
      throw new Error(`SHARD_PLAN_BOUNDARY_MISMATCH at shard ${i}: plan has ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
  return section.shards.map((s) => ({ ...s, shard_plan_shard_sha256: s.shard_sha256 }));
}

// Core exporter, importable for tests. opts:
//   fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath (required)
//   stagingOnlyShardIndex (number|null) -- process only this one shard
//   forceStagingMode (bool) -- force ONE_SHARD_STAGING_REQUIRED regardless of measured disk
//   expectedTotal/expectedShardCount/expectedBoundaries/minFreeBytes -- override for tests only
export async function exportFullShards(opts) {
  const {
    fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath,
    stagingOnlyShardIndex = null, forceStagingMode = false,
    expectedTotal = EXPECTED_TOTAL, expectedShardCount = EXPECTED_SHARD_COUNT,
    expectedBoundaries = EXPECTED_BOUNDARIES, minFreeBytes = MIN_FREE_BYTES,
  } = opts;
  if (!fullTextPath || !shardPlanPath || !outDir || !manifestSourceSummaryPath) {
    throw new Error("exportFullShards: fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath are all required");
  }

  const sourceSummary = JSON.parse(await readFile(manifestSourceSummaryPath, "utf8"));
  if (sourceSummary.unique_input_count !== expectedTotal) {
    throw new Error(`SOURCE_SUMMARY_COUNT_MISMATCH: expected ${expectedTotal}, summary has unique_input_count=${sourceSummary.unique_input_count}`);
  }
  if (sourceSummary.model?.repository !== "nlpai-lab/KURE-v1" || sourceSummary.model?.revision !== "4ed4540949c70b7da2c74004a915e1f2d5e46e4f"
    || sourceSummary.model?.dimension !== 1024 || sourceSummary.model?.dtype !== "float32") {
    throw new Error(`SOURCE_SUMMARY_MODEL_PIN_MISMATCH: ${JSON.stringify(sourceSummary.model)}`);
  }

  const shardBoundaries = await loadAndVerifyShardPlan(shardPlanPath, expectedBoundaries, expectedTotal, expectedShardCount);

  await mkdir(outDir, { recursive: true });

  // F. Disk safety gate -- measured, not assumed. Upper-bound the
  // required NEW bytes by the source file's own size (gzip output can
  // only be smaller than the raw JSONL we're compressing; using the
  // uncompressed upper bound keeps this gate conservative rather than
  // optimistic). The already-existing source file itself is NOT double
  // counted -- it is not deleted or copied, only streamed.
  const sourceBytes = statSync(fullTextPath).size;
  const startFreeBytes = await freeBytes(outDir);
  const projectedFreeAfter = startFreeBytes - sourceBytes;
  let storageMode;
  if (forceStagingMode) {
    storageMode = "ONE_SHARD_STAGING_REQUIRED";
  } else if (projectedFreeAfter >= minFreeBytes) {
    storageMode = "ALL_8_SHARDS_LOCAL_READY";
  } else if (startFreeBytes - Math.ceil(sourceBytes / expectedShardCount) >= minFreeBytes) {
    storageMode = "ONE_SHARD_STAGING_REQUIRED";
  } else {
    storageMode = "STORAGE_CAPACITY_BLOCKED";
  }

  console.error(`[full-shard-export] disk: start_free_bytes=${startFreeBytes} source_bytes=${sourceBytes} projected_free_after=${projectedFreeAfter} min_floor=${minFreeBytes} mode=${storageMode}`);

  if (storageMode === "STORAGE_CAPACITY_BLOCKED") {
    return {
      schema_version: "p11f0-colab-full-shard-export.v1", storage_mode: storageMode,
      shards: [], disk: { start_free_bytes: startFreeBytes, min_free_bytes_during_run: startFreeBytes, end_free_bytes: startFreeBytes, min_floor_bytes: minFreeBytes },
      external_upload_performed: false, real_embedding_calls_performed: 0,
    };
  }

  const shardsToProcess = stagingOnlyShardIndex !== null
    ? shardBoundaries.filter((s) => s.shard_index === stagingOnlyShardIndex)
    : shardBoundaries;
  if (stagingOnlyShardIndex !== null && shardsToProcess.length === 0) {
    throw new Error(`ONLY_SHARD_NOT_FOUND: --only-shard=${stagingOnlyShardIndex}`);
  }

  const allIds = [];
  const perShardLines = new Map(shardsToProcess.map((s) => [s.shard_index, []]));
  const seenIds = new Set();
  const seenTextShas = new Set();
  let duplicateIdCount = 0;
  let duplicateTextShaCount = 0;
  let globalIndex = 0;
  let minFreeDuringRun = startFreeBytes;

  const rl = createInterface({ input: createReadStream(fullTextPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    allIds.push(row.embedding_input_id);
    if (seenIds.has(row.embedding_input_id)) duplicateIdCount += 1;
    seenIds.add(row.embedding_input_id);
    if (seenTextShas.has(row.embed_text_sha256)) duplicateTextShaCount += 1;
    seenTextShas.add(row.embed_text_sha256);

    const shard = shardBoundaries.find((s) => globalIndex >= s.start_input_index && globalIndex <= s.end_input_index);
    if (!shard) throw new Error(`GLOBAL_INDEX_OUT_OF_RANGE: ${globalIndex}`);
    if (perShardLines.has(shard.shard_index)) {
      const outRow = {
        global_eligible_index: globalIndex,
        embedding_input_id: row.embedding_input_id,
        embed_text_sha256: row.embed_text_sha256,
        text: row.text,
      };
      perShardLines.get(shard.shard_index).push(JSON.stringify(outRow));
    }
    globalIndex += 1;
  }

  if (globalIndex !== expectedTotal) throw new Error(`TOTAL_ROW_COUNT_MISMATCH: streamed ${globalIndex} rows, expected ${expectedTotal}`);
  if (allIds.length !== expectedTotal) throw new Error(`ID_COUNT_MISMATCH: ${allIds.length}`);
  if (duplicateIdCount > 0) throw new Error(`DUPLICATE_EMBEDDING_INPUT_ID: ${duplicateIdCount} duplicate(s) found -- refusing to export`);
  if (duplicateTextShaCount > 0) throw new Error(`DUPLICATE_EMBED_TEXT_SHA256: ${duplicateTextShaCount} duplicate(s) found -- refusing to export`);

  // Global membership SHA (order-independent: sorted id set) and ordering
  // SHA (order-dependent: file-order id sequence, matching the established
  // input_ordering_sha256 convention used throughout this repo's Colab
  // benchmark tooling -- see scripts/p11f0-colab-benchmark-verify.mjs).
  const membershipSha256 = sha256Hex([...allIds].sort().join("\n"));
  const orderingSha256 = sha256Hex(allIds.join("\n"));

  const modelPins = { repository: sourceSummary.model.repository, revision: sourceSummary.model.revision, dimension: sourceSummary.model.dimension, dtype: sourceSummary.model.dtype, normalization: "l2" };

  const shardManifests = [];
  for (const shard of shardsToProcess) {
    const lines = perShardLines.get(shard.shard_index);
    if (lines.length !== shard.row_count) throw new Error(`SHARD_ROW_COUNT_MISMATCH: shard ${shard.shard_index} collected ${lines.length}, expected ${shard.row_count}`);
    const uncompressedText = `${lines.join("\n")}\n`;
    const uncompressedBuffer = Buffer.from(uncompressedText, "utf8");
    const compressedBuffer = gzipDeterministic(uncompressedBuffer);
    const fileName = shardFileName(shard.shard_index);
    const finalPath = path.join(outDir, fileName);
    await writeBufferAtomic(finalPath, compressedBuffer);

    const nowFree = await freeBytes(outDir);
    if (nowFree < minFreeDuringRun) minFreeDuringRun = nowFree;
    if (nowFree < minFreeBytes) {
      throw new Error(`DISK_FLOOR_BREACHED_MID_EXPORT: free_bytes=${nowFree} < floor=${minFreeBytes} after writing shard ${shard.shard_index} -- stopping, no further shards written`);
    }

    shardManifests.push({
      shard_id: `kure-full-input-shard-${String(shard.shard_index).padStart(3, "0")}`,
      shard_index: shard.shard_index,
      file_name: fileName,
      global_start_index: shard.start_input_index,
      global_end_index: shard.end_input_index,
      row_count: shard.row_count,
      compressed_bytes: compressedBuffer.length,
      uncompressed_bytes: uncompressedBuffer.length,
      input_membership_sha256: membershipSha256,
      input_ordering_sha256: orderingSha256,
      compressed_file_sha256: sha256HexOfBuffer(compressedBuffer),
      uncompressed_content_sha256: sha256HexOfBuffer(uncompressedBuffer),
      shard_plan_shard_sha256: shard.shard_plan_shard_sha256,
      model: modelPins,
      source_eligible_manifest_sha256: sourceSummary.full_text_file.sha256,
    });
    console.error(`[full-shard-export] wrote ${fileName}: rows=${shard.row_count} compressed_bytes=${compressedBuffer.length} uncompressed_bytes=${uncompressedBuffer.length} free_after=${nowFree}`);
  }

  const endFreeBytes = await freeBytes(outDir);

  // Global coverage checks over the FULL shard-boundary set (always
  // meaningful, even for a one-shard-staging run -- it verifies the PLAN
  // itself has no gap/overlap, independent of how many shards this run
  // actually wrote).
  let overlapCount = 0;
  let missingGlobalIndexCount = 0;
  {
    let expectedNext = 0;
    for (const s of shardBoundaries) {
      if (s.start_input_index < expectedNext) overlapCount += 1;
      if (s.start_input_index > expectedNext) missingGlobalIndexCount += s.start_input_index - expectedNext;
      expectedNext = s.end_input_index + 1;
    }
    if (expectedNext !== expectedTotal) missingGlobalIndexCount += expectedTotal - expectedNext;
  }
  const totalRowsAcrossShards = shardManifests.reduce((sum, s) => sum + s.row_count, 0);

  const exportManifest = {
    schema_version: "p11f0-colab-full-shard-export.v1",
    generated_at: new Date().toISOString(),
    source_eligible_manifest_sha256: sourceSummary.full_text_file.sha256,
    source_eligible_manifest_line_count: sourceSummary.full_text_file.line_count,
    model: modelPins,
    input_membership_sha256: membershipSha256,
    input_ordering_sha256: orderingSha256,
    total_population: expectedTotal,
    total_rows_exported_this_run: totalRowsAcrossShards,
    shard_count: expectedShardCount,
    shards_processed_this_run: shardsToProcess.map((s) => s.shard_index),
    shards: shardManifests,
    duplicate_id_count: duplicateIdCount,
    duplicate_text_sha_count: duplicateTextShaCount,
    overlap_count: overlapCount,
    missing_global_index_count: missingGlobalIndexCount,
    disk: { start_free_bytes: startFreeBytes, min_free_bytes_during_run: minFreeDuringRun, end_free_bytes: endFreeBytes, min_floor_bytes: minFreeBytes },
    storage_mode: storageMode,
    external_upload_performed: false,
    real_embedding_calls_performed: 0,
  };
  if (stagingOnlyShardIndex === null) {
    await writeJsonAtomic(path.join(outDir, "full-shard-export-manifest.json"), exportManifest);
  }

  console.error(`[full-shard-export] DONE mode=${storageMode} shards_written=${shardManifests.length} total_rows=${totalRowsAcrossShards} overlap=${overlapCount} missing=${missingGlobalIndexCount}`);
  return exportManifest;
}

async function main() {
  const fullTextPath = process.argv[2];
  const shardPlanPath = process.argv[3];
  const outDir = process.argv[4];
  const manifestSourceSummaryPath = process.argv[5];
  const forceStagingMode = process.argv.includes("--one-shard-staging");
  const stagingOnlyShardIndex = (() => {
    const flag = process.argv.find((a) => a.startsWith("--only-shard="));
    return flag ? Number(flag.split("=")[1]) : null;
  })();

  if (!fullTextPath || !shardPlanPath || !outDir || !manifestSourceSummaryPath) {
    console.error("usage: node p11f0-colab-full-shard-export.mjs <embedding-input-fulltext.jsonl> <shard-plan.json> <out-dir> <embedding-input-manifest.summary.json> [--one-shard-staging --only-shard=N]");
    process.exitCode = 1;
    return;
  }

  const result = await exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath, forceStagingMode, stagingOnlyShardIndex });
  console.log(JSON.stringify({ ...result, shards: result.shards.map(({ shard_id, row_count, compressed_bytes }) => ({ shard_id, row_count, compressed_bytes })) }, null, 2));
  process.exitCode = result.storage_mode === "STORAGE_CAPACITY_BLOCKED" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[full-shard-export] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
