#!/usr/bin/env node
// Turn AC-COLAB-FULL-SHARDS-V1, remaining item 1: read-only verifier for
// the 8 deterministic gzip input shards produced by
// p11f0-colab-full-shard-export.mjs, plus (once a shard has been embedded
// on Colab and its result package downloaded) a verifier for that per-shard
// RESULT package (vectors.npy + row-mapping.jsonl + result-manifest.json,
// as written by gpu-full-shard-colab-cuda-runner-v1.ipynb's Cell 6).
//
// Never calls an embedding model, never uploads/downloads anything, never
// writes to the database, never mutates the shard files it reads --
// read-only end to end. Never logs raw chunk text -- only ids, hashes,
// counts, and indices.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSafe } from "../domain/adapters/deterministic-gzip.mjs";
import { parseNpyFloat32Matrix } from "./p11f0-colab-benchmark-verify.mjs";

export const EXPECTED_MODEL_REPOSITORY = "nlpai-lab/KURE-v1";
export const EXPECTED_MODEL_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";
export const EXPECTED_DIMENSION = 1024;
const EXPORT_MANIFEST_SCHEMA = "p11f0-colab-full-shard-export.v1";
const RESULT_MANIFEST_SCHEMA = "p11f0-colab-full-shard-result-manifest.v1";
// Conservative decompression-bomb bounds for this population's own known
// shape (~44MB compressed / ~168MB uncompressed per shard, ratio ~3.8x) --
// generous headroom without being unbounded.
const MAX_ENCODED_BYTES = 300 * 1024 * 1024;
const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 30;

function sha256HexOfBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readShardRows(gzPath) {
  const compressed = await readFile(gzPath);
  const compressedSha256 = sha256HexOfBuffer(compressed);
  const { decoded } = gunzipSafe(compressed, {
    maxEncodedBytes: MAX_ENCODED_BYTES, maxDecodedBytes: MAX_DECODED_BYTES, maxCompressionRatio: MAX_COMPRESSION_RATIO,
  });
  const uncompressedSha256 = sha256HexOfBuffer(decoded);
  const lines = decoded.toString("utf8").split("\n").filter((l) => l.trim() !== "");
  const rows = lines.map((l) => JSON.parse(l));
  return { rows, compressedSha256, uncompressedSha256, uncompressedBytes: decoded.length };
}

// Re-verifies the ENTIRE on-disk shard set against the export manifest's
// own recorded facts -- never trusts the manifest's numbers alone, always
// recomputes from the actual gzip bytes on disk. Accumulates errors (does
// not stop at the first one) so a failing run is fully diagnosable.
export async function verifyLocalShardSet({ exportManifestPath, shardsDir, expectedTotal = null, expectedShardCount = null }) {
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const errors = [];
  if (manifest.schema_version !== EXPORT_MANIFEST_SCHEMA) {
    errors.push(`WRONG_MANIFEST_SCHEMA: ${manifest.schema_version}`);
  }
  const total = expectedTotal ?? manifest.total_population;
  const shardCount = expectedShardCount ?? manifest.shard_count;
  if (manifest.total_population !== total) errors.push(`MANIFEST_TOTAL_POPULATION_MISMATCH: ${manifest.total_population} != ${total}`);
  if (manifest.shard_count !== shardCount) errors.push(`MANIFEST_SHARD_COUNT_MISMATCH: ${manifest.shard_count} != ${shardCount}`);
  if (!Array.isArray(manifest.shards) || manifest.shards.length !== shardCount) {
    errors.push(`MANIFEST_SHARDS_ARRAY_LENGTH_MISMATCH: ${manifest.shards?.length}`);
    return { ok: false, errors, shards: [], total_rows_verified: 0, membership_sha256: null, ordering_sha256: null };
  }
  if (manifest.model?.repository !== EXPECTED_MODEL_REPOSITORY || manifest.model?.revision !== EXPECTED_MODEL_REVISION || manifest.model?.dimension !== EXPECTED_DIMENSION) {
    errors.push(`MANIFEST_MODEL_PIN_MISMATCH: ${JSON.stringify(manifest.model)}`);
  }

  const shardReports = [];
  const allIdsInOrder = [];
  let expectedNextIndex = 0;
  let overlapCount = 0;
  let missingGlobalIndexCount = 0;
  let totalRowsVerified = 0;

  const sortedShards = [...manifest.shards].sort((a, b) => a.shard_index - b.shard_index);
  for (const shardMeta of sortedShards) {
    const shardErrors = [];
    const gzPath = path.join(shardsDir, shardMeta.file_name);
    let readOutcome;
    try {
      readOutcome = await readShardRows(gzPath);
    } catch (error) {
      errors.push(`${shardMeta.shard_id}: UNREADABLE_SHARD_FILE: ${error.message}`);
      shardReports.push({ shard_id: shardMeta.shard_id, shard_index: shardMeta.shard_index, ok: false, errors: [`UNREADABLE_SHARD_FILE: ${error.message}`] });
      continue;
    }
    const { rows, compressedSha256, uncompressedSha256, uncompressedBytes } = readOutcome;

    if (compressedSha256 !== shardMeta.compressed_file_sha256) shardErrors.push(`COMPRESSED_FILE_SHA_MISMATCH: manifest ${shardMeta.compressed_file_sha256}, actual ${compressedSha256}`);
    if (uncompressedSha256 !== shardMeta.uncompressed_content_sha256) shardErrors.push(`UNCOMPRESSED_CONTENT_SHA_MISMATCH: manifest ${shardMeta.uncompressed_content_sha256}, actual ${uncompressedSha256}`);
    if (uncompressedBytes !== shardMeta.uncompressed_bytes) shardErrors.push(`UNCOMPRESSED_BYTES_MISMATCH: manifest ${shardMeta.uncompressed_bytes}, actual ${uncompressedBytes}`);
    if (rows.length !== shardMeta.row_count) shardErrors.push(`ROW_COUNT_MISMATCH: manifest ${shardMeta.row_count}, actual ${rows.length}`);

    const expectedIndices = [];
    for (let i = shardMeta.global_start_index; i <= shardMeta.global_end_index; i += 1) expectedIndices.push(i);
    const actualIndices = rows.map((r) => r.global_eligible_index);
    if (JSON.stringify(actualIndices) !== JSON.stringify(expectedIndices)) {
      shardErrors.push(`GLOBAL_INDEX_RANGE_MISMATCH: expected ${expectedIndices[0]}..${expectedIndices[expectedIndices.length - 1]}, got ${actualIndices.length ? `${actualIndices[0]}..${actualIndices[actualIndices.length - 1]}` : "empty"}`);
    }

    let textShaMismatchCount = 0;
    for (const row of rows) {
      const keys = Object.keys(row).sort();
      if (keys.join(",") !== "embed_text_sha256,embedding_input_id,global_eligible_index,text") {
        shardErrors.push(`UNEXPECTED_ROW_FIELDS: ${keys.join(",")}`);
        break;
      }
      if (sha256Hex(row.text) !== row.embed_text_sha256) textShaMismatchCount += 1;
      allIdsInOrder.push(row.embedding_input_id);
    }
    if (textShaMismatchCount > 0) shardErrors.push(`EMBED_TEXT_SHA256_MISMATCH: ${textShaMismatchCount} row(s)`);

    if (shardMeta.global_start_index < expectedNextIndex) overlapCount += 1;
    if (shardMeta.global_start_index > expectedNextIndex) missingGlobalIndexCount += shardMeta.global_start_index - expectedNextIndex;
    expectedNextIndex = shardMeta.global_end_index + 1;

    if (shardMeta.model?.repository !== EXPECTED_MODEL_REPOSITORY || shardMeta.model?.revision !== EXPECTED_MODEL_REVISION || shardMeta.model?.dimension !== EXPECTED_DIMENSION) {
      shardErrors.push(`SHARD_MODEL_PIN_MISMATCH: ${JSON.stringify(shardMeta.model)}`);
    }

    totalRowsVerified += rows.length;
    for (const e of shardErrors) errors.push(`${shardMeta.shard_id}: ${e}`);
    shardReports.push({ shard_id: shardMeta.shard_id, shard_index: shardMeta.shard_index, ok: shardErrors.length === 0, errors: shardErrors, row_count_verified: rows.length });
  }
  if (expectedNextIndex !== total) missingGlobalIndexCount += total - expectedNextIndex;
  if (overlapCount > 0) errors.push(`SHARD_BOUNDARY_OVERLAP: ${overlapCount}`);
  if (missingGlobalIndexCount > 0) errors.push(`SHARD_BOUNDARY_GAP: ${missingGlobalIndexCount} missing global index slot(s)`);

  const membershipSha256 = sha256Hex([...allIdsInOrder].sort().join("\n"));
  const orderingSha256 = sha256Hex(allIdsInOrder.join("\n"));
  const duplicateIdCount = allIdsInOrder.length - new Set(allIdsInOrder).size;
  if (duplicateIdCount > 0) errors.push(`DUPLICATE_EMBEDDING_INPUT_ID_ACROSS_SHARDS: ${duplicateIdCount}`);
  if (membershipSha256 !== manifest.input_membership_sha256) errors.push(`INPUT_MEMBERSHIP_SHA_MISMATCH: manifest ${manifest.input_membership_sha256}, actual ${membershipSha256}`);
  if (orderingSha256 !== manifest.input_ordering_sha256) errors.push(`INPUT_ORDERING_SHA_MISMATCH: manifest ${manifest.input_ordering_sha256}, actual ${orderingSha256}`);
  if (totalRowsVerified !== total) errors.push(`TOTAL_ROWS_VERIFIED_MISMATCH: expected ${total}, verified ${totalRowsVerified}`);

  return {
    ok: errors.length === 0, errors, shards: shardReports,
    total_rows_verified: totalRowsVerified, membership_sha256: membershipSha256, ordering_sha256: orderingSha256,
    overlap_count: overlapCount, missing_global_index_count: missingGlobalIndexCount,
  };
}

// Verifies ONE shard's downloaded Colab RESULT package (single-file
// finalize mode only, per Cell 6 of gpu-full-shard-colab-cuda-runner-v1.ipynb)
// against the LOCAL shard's own gz content (re-read and re-hashed here, not
// merely trusted from the export manifest) and the result-manifest's own
// claims. Fails closed on any pin/shape/hash/coverage mismatch.
export async function verifyShardResultPackage({ exportManifestPath, shardsDir, shardIndex, resultDir }) {
  const manifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  const shardMeta = manifest.shards.find((s) => s.shard_index === shardIndex);
  const errors = [];
  if (!shardMeta) {
    return { ok: false, errors: [`SHARD_NOT_IN_EXPORT_MANIFEST: ${shardIndex}`] };
  }

  const { rows, compressedSha256 } = await readShardRows(path.join(shardsDir, shardMeta.file_name));
  if (compressedSha256 !== shardMeta.compressed_file_sha256) errors.push(`LOCAL_SHARD_FILE_SHA_MISMATCH: manifest ${shardMeta.compressed_file_sha256}, actual ${compressedSha256}`);
  const localIds = new Set(rows.map((r) => r.embedding_input_id));
  const localOrderedIds = [...rows].sort((a, b) => a.global_eligible_index - b.global_eligible_index).map((r) => r.embedding_input_id);

  const shardStr = String(shardIndex).padStart(3, "0");
  const resultManifestPath = path.join(resultDir, `shard-${shardStr}-result-manifest.json`);
  const vectorsPath = path.join(resultDir, `shard-${shardStr}-vectors.npy`);
  const mappingPath = path.join(resultDir, `shard-${shardStr}-row-mapping.jsonl`);

  const resultManifest = JSON.parse(await readFile(resultManifestPath, "utf8"));
  if (resultManifest.schema_version !== RESULT_MANIFEST_SCHEMA) errors.push(`WRONG_RESULT_MANIFEST_SCHEMA: ${resultManifest.schema_version}`);
  if (resultManifest.shard_id !== shardIndex) errors.push(`RESULT_MANIFEST_SHARD_ID_MISMATCH: ${resultManifest.shard_id} != ${shardIndex}`);
  if (resultManifest.shard_gz_sha256 !== shardMeta.compressed_file_sha256) errors.push(`RESULT_MANIFEST_SHARD_GZ_SHA_MISMATCH: ${resultManifest.shard_gz_sha256}`);
  if (resultManifest.row_count !== shardMeta.row_count) errors.push(`RESULT_MANIFEST_ROW_COUNT_MISMATCH: ${resultManifest.row_count} != ${shardMeta.row_count}`);
  if (resultManifest.global_start_index !== shardMeta.global_start_index || resultManifest.global_end_index !== shardMeta.global_end_index) {
    errors.push(`RESULT_MANIFEST_GLOBAL_RANGE_MISMATCH: [${resultManifest.global_start_index},${resultManifest.global_end_index}] != [${shardMeta.global_start_index},${shardMeta.global_end_index}]`);
  }
  if (resultManifest.model?.repository !== EXPECTED_MODEL_REPOSITORY || resultManifest.model?.revision !== EXPECTED_MODEL_REVISION || resultManifest.model?.dimension !== EXPECTED_DIMENSION || resultManifest.model?.dtype !== "float32") {
    errors.push(`RESULT_MANIFEST_MODEL_PIN_MISMATCH: ${JSON.stringify(resultManifest.model)}`);
  }
  if (resultManifest.finalize_mode !== "SINGLE_FILE") {
    errors.push(`UNSUPPORTED_FINALIZE_MODE: ${resultManifest.finalize_mode} (only SINGLE_FILE is verified by this tool)`);
    return { ok: false, errors, shard_index: shardIndex };
  }

  const [vectorBuf, mappingRaw] = await Promise.all([readFile(vectorsPath), readFile(mappingPath, "utf8")]);
  if (sha256HexOfBuffer(vectorBuf) !== resultManifest.single_file_vectors_sha256) errors.push("VECTORS_FILE_SHA_MISMATCH");
  if (sha256Hex(mappingRaw) !== resultManifest.single_file_mapping_sha256) errors.push("MAPPING_FILE_SHA_MISMATCH");

  let parsed;
  try {
    parsed = parseNpyFloat32Matrix(vectorBuf);
  } catch (error) {
    errors.push(`NPY_PARSE_FAILED: ${error.message}`);
    return { ok: false, errors, shard_index: shardIndex };
  }
  if (parsed.cols !== EXPECTED_DIMENSION) errors.push(`WRONG_NPY_COLS: ${parsed.cols}`);
  if (parsed.rows !== shardMeta.row_count) errors.push(`WRONG_NPY_ROWS: ${parsed.rows} != ${shardMeta.row_count}`);

  const mappingRows = mappingRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  if (mappingRows.length !== parsed.rows) errors.push(`MAPPING_ROW_COUNT_MISMATCH: ${mappingRows.length} != ${parsed.rows}`);
  const mappingIds = mappingRows.map((r) => r.embedding_input_id);
  const duplicateInMapping = mappingIds.length - new Set(mappingIds).size;
  if (duplicateInMapping > 0) errors.push(`DUPLICATE_ROWS_IN_MAPPING: ${duplicateInMapping}`);
  const outOfSample = mappingIds.filter((id) => !localIds.has(id));
  if (outOfSample.length > 0) errors.push(`OUT_OF_SAMPLE_ROWS: ${outOfSample.length} (e.g. ${outOfSample.slice(0, 3).join(", ")})`);
  const missingFromResult = [...localIds].filter((id) => !new Set(mappingIds).has(id));
  if (missingFromResult.length > 0) errors.push(`MISSING_ROWS_IN_RESULT: ${missingFromResult.length} (e.g. ${missingFromResult.slice(0, 3).join(", ")})`);
  if (JSON.stringify(mappingIds) !== JSON.stringify(localOrderedIds)) errors.push("MAPPING_ORDER_MISMATCH: row-mapping.jsonl order does not match global_eligible_index ascending order of the local shard");
  for (const row of mappingRows) {
    if (typeof row.global_eligible_index !== "number" || row.global_eligible_index < shardMeta.global_start_index || row.global_eligible_index > shardMeta.global_end_index) {
      errors.push(`MAPPING_GLOBAL_INDEX_OUT_OF_RANGE: ${row.global_eligible_index}`);
      break;
    }
  }

  let nonFiniteCount = 0;
  let worstNormDeviation = 0;
  for (let r = 0; r < parsed.rows; r += 1) {
    let sumSq = 0;
    for (let c = 0; c < parsed.cols; c += 1) {
      const v = parsed.data[r * parsed.cols + c];
      if (!Number.isFinite(v)) { nonFiniteCount += 1; continue; }
      sumSq += v * v;
    }
    worstNormDeviation = Math.max(worstNormDeviation, Math.abs(Math.sqrt(sumSq) - 1));
  }
  if (nonFiniteCount > 0) errors.push(`NON_FINITE_COMPONENTS: ${nonFiniteCount}`);
  if (worstNormDeviation > 0.01) errors.push(`NORMALIZATION_MISMATCH: worst |L2 norm - 1| = ${worstNormDeviation.toFixed(6)}`);

  return {
    ok: errors.length === 0, errors, shard_index: shardIndex, row_count: parsed.rows,
    non_finite_count: nonFiniteCount, worst_norm_deviation: worstNormDeviation,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === "local") {
    const [, shardsDir, exportManifestPath = path.join(shardsDir, "full-shard-export-manifest.json")] = process.argv.slice(2);
    if (!shardsDir) {
      console.error("usage: node p11f0-colab-full-shard-verify.mjs local <shardsDir> [exportManifestPath]");
      process.exitCode = 1;
      return;
    }
    const report = await verifyLocalShardSet({ exportManifestPath, shardsDir });
    console.log(JSON.stringify({ ...report, shards: report.shards.map(({ shard_id, ok, errors, row_count_verified }) => ({ shard_id, ok, errors, row_count_verified })) }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (mode === "result") {
    const [, , , shardsDir, exportManifestPath, shardIndexRaw, resultDir] = process.argv;
    if (!shardsDir || !exportManifestPath || shardIndexRaw === undefined || !resultDir) {
      console.error("usage: node p11f0-colab-full-shard-verify.mjs result <shardsDir> <exportManifestPath> <shardIndex> <resultDir>");
      process.exitCode = 1;
      return;
    }
    const report = await verifyShardResultPackage({ exportManifestPath, shardsDir, shardIndex: Number(shardIndexRaw), resultDir });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  console.error("usage: node p11f0-colab-full-shard-verify.mjs <local|result> ...");
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[full-shard-verify] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
