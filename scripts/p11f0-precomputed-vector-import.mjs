#!/usr/bin/env node
// Streams verified per-shard float32 NPY files into PostgreSQL using native
// binary COPY. At most one vector row and one temporary COPY shard are held
// in process/disk at a time; source discovery rows remain read-only.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { parsePgConnectionParts } from "./p11f0-spool-native-copy-load.mjs";
import { createFixedKurePrecomputedRepository } from "../domain/postgres/reference-fixed-kure-precomputed-repository.mjs";

const { Client } = pg;
export const EXPECTED_MODEL = Object.freeze({
  repository: "nlpai-lab/KURE-v1",
  revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
  dimension: 1024,
  dtype: "float32",
});
const COPY_HEADER = Buffer.concat([
  Buffer.from("PGCOPY\n\xff\r\n\0", "binary"),
  Buffer.alloc(8),
]);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireSafeId(value, name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${name} is not a safe identifier`);
  return value;
}

function requireSha(value, name) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is not a SHA-256 hex digest`);
  return value;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function readNpyFloat32Header(filePath) {
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead < 10 || prefix.toString("ascii", 1, 6) !== "NUMPY") throw new Error("NPY_BAD_MAGIC");
    const major = prefix.readUInt8(6);
    const headerStart = major === 1 ? 10 : 12;
    const headerLength = major === 1 ? prefix.readUInt16LE(8) : prefix.readUInt32LE(8);
    const headerBuffer = Buffer.alloc(headerLength);
    await handle.read(headerBuffer, 0, headerLength, headerStart);
    const header = headerBuffer.toString("ascii");
    const descr = header.match(/'descr':\s*'([^']+)'/)?.[1];
    const fortran = header.match(/'fortran_order':\s*(True|False)/)?.[1];
    const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1];
    if (!descr || !fortran || !shapeText) throw new Error("NPY_UNPARSEABLE_HEADER");
    if (descr !== "<f4" && descr !== "=f4") throw new Error(`NPY_UNSUPPORTED_DESCR: ${descr}`);
    if (fortran !== "False") throw new Error("NPY_FORTRAN_ORDER_UNSUPPORTED");
    const shape = shapeText.split(",").map((v) => v.trim()).filter(Boolean).map(Number);
    if (shape.length !== 2 || shape.some((v) => !Number.isInteger(v) || v < 1)) throw new Error("NPY_UNSUPPORTED_SHAPE");
    const [rows, cols] = shape;
    const dataOffset = headerStart + headerLength;
    const info = await stat(filePath);
    const expectedSize = dataOffset + rows * cols * 4;
    if (info.size !== expectedSize) throw new Error(`NPY_DATA_LENGTH_MISMATCH: expected ${expectedSize}, got ${info.size}`);
    return { rows, cols, dataOffset, byteLength: info.size };
  } finally {
    await handle.close();
  }
}

function binaryField(buffer) {
  const len = Buffer.alloc(4);
  len.writeInt32BE(buffer.length);
  return [len, buffer];
}

export function encodePgVectorBinaryFromNpyRow(npyLittleEndianRow, dimension) {
  if (npyLittleEndianRow.length !== dimension * 4) throw new Error("VECTOR_ROW_BYTE_LENGTH_MISMATCH");
  const output = Buffer.alloc(4 + dimension * 4);
  output.writeInt16BE(dimension, 0);
  output.writeInt16BE(0, 2);
  let sumSquares = 0;
  for (let i = 0; i < dimension; i += 1) {
    const value = npyLittleEndianRow.readFloatLE(i * 4);
    if (!Number.isFinite(value)) throw new Error(`NON_FINITE_VECTOR_COMPONENT_AT_${i}`);
    sumSquares += value * value;
    output.writeFloatBE(value, 4 + i * 4);
  }
  const normDeviation = Math.abs(Math.sqrt(sumSquares) - 1);
  if (normDeviation > 0.01) throw new Error(`VECTOR_NORMALIZATION_MISMATCH: ${normDeviation}`);
  return { buffer: output, normDeviation };
}

export function encodeBinaryCopyRow({ loadSessionId, embeddingInputId, globalEligibleIndex, embedTextSha256, vectorBinary, shardIndex, resultManifestSha256 }) {
  const fieldCount = Buffer.alloc(2); fieldCount.writeInt16BE(7);
  const globalIndex = Buffer.alloc(8); globalIndex.writeBigInt64BE(BigInt(globalEligibleIndex));
  const shard = Buffer.alloc(4); shard.writeInt32BE(shardIndex);
  const fields = [
    Buffer.from(loadSessionId), Buffer.from(embeddingInputId), globalIndex,
    Buffer.from(embedTextSha256), vectorBinary, shard, Buffer.from(resultManifestSha256),
  ];
  return Buffer.concat([fieldCount, ...fields.flatMap(binaryField)]);
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

export async function buildBinaryCopyShard({ mappingPath, vectorsPath, outputPath, shardMeta, resultManifest, resultManifestSha256, loadSessionId }) {
  const npy = await readNpyFloat32Header(vectorsPath);
  if (npy.rows !== shardMeta.row_count || npy.cols !== EXPECTED_MODEL.dimension) throw new Error("NPY_SHAPE_PIN_MISMATCH");
  const vectorHandle = await open(vectorsPath, "r");
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const mapping = readline.createInterface({ input: createReadStream(mappingPath), crlfDelay: Infinity });
  let rowIndex = 0;
  let worstNormDeviation = 0;
  try {
    await writeChunk(output, COPY_HEADER);
    for await (const line of mapping) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const expectedGlobalIndex = shardMeta.global_start_index + rowIndex;
      if (row.global_eligible_index !== expectedGlobalIndex) throw new Error(`MAPPING_GLOBAL_INDEX_MISMATCH_AT_ROW_${rowIndex}`);
      requireSha(row.embed_text_sha256, "embed_text_sha256");
      if (row.embedding_input_id !== `embin_${row.embed_text_sha256.slice(0, 24)}`) throw new Error(`EMBEDDING_INPUT_ID_MISMATCH_AT_ROW_${rowIndex}`);
      const npyRow = Buffer.allocUnsafe(EXPECTED_MODEL.dimension * 4);
      const position = npy.dataOffset + rowIndex * npyRow.length;
      const read = await vectorHandle.read(npyRow, 0, npyRow.length, position);
      if (read.bytesRead !== npyRow.length) throw new Error(`NPY_SHORT_READ_AT_ROW_${rowIndex}`);
      const vector = encodePgVectorBinaryFromNpyRow(npyRow, EXPECTED_MODEL.dimension);
      worstNormDeviation = Math.max(worstNormDeviation, vector.normDeviation);
      await writeChunk(output, encodeBinaryCopyRow({
        loadSessionId,
        embeddingInputId: row.embedding_input_id,
        globalEligibleIndex: row.global_eligible_index,
        embedTextSha256: row.embed_text_sha256,
        vectorBinary: vector.buffer,
        shardIndex: shardMeta.shard_index,
        resultManifestSha256,
      }));
      rowIndex += 1;
    }
    if (rowIndex !== shardMeta.row_count) throw new Error(`MAPPING_ROW_COUNT_MISMATCH: ${rowIndex} != ${shardMeta.row_count}`);
    const trailer = Buffer.alloc(2); trailer.writeInt16BE(-1);
    await writeChunk(output, trailer);
    output.end();
    await once(output, "close");
    return { rowCount: rowIndex, worstNormDeviation };
  } catch (error) {
    output.destroy();
    throw error;
  } finally {
    mapping.close();
    await vectorHandle.close();
  }
}

function psqlArgs(databaseUrl) {
  const conn = parsePgConnectionParts(databaseUrl);
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1"];
  if (conn.host) args.push("-h", conn.host);
  if (conn.port) args.push("-p", conn.port);
  if (conn.user) args.push("-U", conn.user);
  if (conn.database) args.push("-d", conn.database);
  const env = { ...process.env };
  if (conn.password) env.PGPASSWORD = conn.password; else delete env.PGPASSWORD;
  return { args, env };
}

function sqlLiteral(value) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(String(value))) throw new Error("unsafe SQL literal input");
  return `'${value}'`;
}

export function loadBinaryShardWithPsql({ psqlBin, databaseUrl, copyPath, loadSessionId, sourceLoadSessionId, shardMeta, resultManifest, resultManifestSha256 }) {
  if (copyPath.includes("'")) throw new Error("unsafe COPY path");
  const table = "disclosure_reference.reference_fixed_kure_precomputed_embeddings";
  const columns = "load_session_id,embedding_input_id,global_eligible_index,embed_text_sha256,embedding,source_shard_index,source_result_manifest_sha256";
  const validationSql = `
DO $verify$
DECLARE actual_count bigint; unsupported_count bigint;
BEGIN
  SELECT count(*) INTO actual_count FROM ${table}
  WHERE load_session_id=${sqlLiteral(loadSessionId)} AND source_shard_index=${shardMeta.shard_index};
  IF actual_count <> ${shardMeta.row_count} THEN
    RAISE EXCEPTION 'IMPORTED_SHARD_COUNT_MISMATCH: %', actual_count;
  END IF;
  SELECT count(*) INTO unsupported_count FROM ${table} p
  WHERE p.load_session_id=${sqlLiteral(loadSessionId)} AND p.source_shard_index=${shardMeta.shard_index}
    AND NOT EXISTS (
      SELECT 1 FROM disclosure_reference.reference_fixed_kure_chunk_staging c
      WHERE c.load_session_id=${sqlLiteral(sourceLoadSessionId)} AND c.retrieval_eligible
        AND c.embed_text_sha256=p.embed_text_sha256
    );
  IF unsupported_count <> 0 THEN
    RAISE EXCEPTION 'IMPORTED_SHARD_HAS_UNSUPPORTED_HASHES: %', unsupported_count;
  END IF;
END
$verify$;
INSERT INTO disclosure_reference.reference_fixed_kure_precomputed_embedding_shards
  (load_session_id,shard_index,row_count,global_start_index,global_end_index,result_manifest_sha256,vectors_sha256,mapping_sha256)
VALUES (${sqlLiteral(loadSessionId)},${shardMeta.shard_index},${shardMeta.row_count},${shardMeta.global_start_index},${shardMeta.global_end_index},
        ${sqlLiteral(resultManifestSha256)},${sqlLiteral(resultManifest.single_file_vectors_sha256)},${sqlLiteral(resultManifest.single_file_mapping_sha256)});`;
  const { args, env } = psqlArgs(databaseUrl);
  args.push(
    "-c", `\\copy ${table} (${columns}) FROM '${copyPath}' WITH (FORMAT binary)`,
    "-c", validationSql,
  );
  const result = spawnSync(psqlBin, args, { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`PSQL_BINARY_COPY_FAILED: ${result.stderr || result.stdout}`);
}

async function prepareShard({ resultRoot, exportManifest, shardMeta }) {
  const shardStr = String(shardMeta.shard_index).padStart(3, "0");
  const dir = path.join(resultRoot, `shard-${shardStr}`);
  const resultManifestPath = path.join(dir, `shard-${shardStr}-result-manifest.json`);
  const vectorsPath = path.join(dir, `shard-${shardStr}-vectors.npy`);
  const mappingPath = path.join(dir, `shard-${shardStr}-row-mapping.jsonl`);
  const resultManifestRaw = await readFile(resultManifestPath);
  const resultManifest = JSON.parse(resultManifestRaw.toString("utf8"));
  const resultManifestSha256 = createHash("sha256").update(resultManifestRaw).digest("hex");
  if (resultManifest.shard_id !== shardMeta.shard_index || resultManifest.row_count !== shardMeta.row_count) throw new Error(`RESULT_MANIFEST_SHARD_MISMATCH_${shardMeta.shard_index}`);
  if (resultManifest.global_start_index !== shardMeta.global_start_index || resultManifest.global_end_index !== shardMeta.global_end_index) throw new Error(`RESULT_MANIFEST_RANGE_MISMATCH_${shardMeta.shard_index}`);
  if (JSON.stringify(resultManifest.model) !== JSON.stringify(EXPECTED_MODEL)) throw new Error(`RESULT_MANIFEST_MODEL_MISMATCH_${shardMeta.shard_index}`);
  if (resultManifest.finalize_mode !== "SINGLE_FILE") throw new Error(`RESULT_MANIFEST_NOT_SINGLE_FILE_${shardMeta.shard_index}`);
  const [vectorsSha, mappingSha] = await Promise.all([sha256File(vectorsPath), sha256File(mappingPath)]);
  if (vectorsSha !== resultManifest.single_file_vectors_sha256) throw new Error(`VECTOR_SHA_MISMATCH_${shardMeta.shard_index}`);
  if (mappingSha !== resultManifest.single_file_mapping_sha256) throw new Error(`MAPPING_SHA_MISMATCH_${shardMeta.shard_index}`);
  const npy = await readNpyFloat32Header(vectorsPath);
  if (npy.rows !== shardMeta.row_count || npy.cols !== EXPECTED_MODEL.dimension) throw new Error(`NPY_SHAPE_MISMATCH_${shardMeta.shard_index}`);
  return { shardMeta, resultManifest, resultManifestSha256, vectorsPath, mappingPath };
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const psqlBin = requireEnv("P11F0_PSQL_BIN");
  const resultRoot = requireEnv("P11F0_RESULT_ROOT");
  const exportManifestPath = requireEnv("P11F0_EXPORT_MANIFEST");
  const loadSessionId = requireSafeId(requireEnv("P11F0_SUCCESSOR_ATTEMPT_ID"), "P11F0_SUCCESSOR_ATTEMPT_ID");
  const sourceLoadSessionId = requireSafeId(requireEnv("P11F0_DISCOVERY_SOURCE_ATTEMPT_ID"), "P11F0_DISCOVERY_SOURCE_ATTEMPT_ID");
  const exportManifest = JSON.parse(await readFile(exportManifestPath, "utf8"));
  if (exportManifest.total_population !== 441879 || exportManifest.shard_count !== 8) throw new Error("EXPORT_MANIFEST_POPULATION_PIN_MISMATCH");
  if (exportManifest.model?.repository !== EXPECTED_MODEL.repository
      || exportManifest.model?.revision !== EXPECTED_MODEL.revision
      || exportManifest.model?.dimension !== EXPECTED_MODEL.dimension
      || exportManifest.model?.dtype !== EXPECTED_MODEL.dtype
      || exportManifest.model?.normalization !== "l2") {
    throw new Error("EXPORT_MANIFEST_MODEL_PIN_MISMATCH");
  }

  console.error("[precomputed-import] preflighting all 8 result packages before DB state changes...");
  const prepared = [];
  for (const shardMeta of exportManifest.shards) {
    // eslint-disable-next-line no-await-in-loop
    prepared.push(await prepareShard({ resultRoot, exportManifest, shardMeta }));
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const repo = createFixedKurePrecomputedRepository({ client });
  const tempDir = await mkdtemp(path.join(tmpdir(), "p11f0-vector-import-"));
  try {
    let state = await repo.getImportState(loadSessionId);
    if (!state) throw new Error(`SUCCESSOR_ATTEMPT_NOT_FOUND: ${loadSessionId}`);
    if (state.status === "CREATED") state = await repo.inheritDiscovery({ successorLoadSessionId: loadSessionId, sourceLoadSessionId });
    if (state.discovery_source_load_session_id !== sourceLoadSessionId) throw new Error("DISCOVERY_SOURCE_PIN_MISMATCH");
    state = await repo.beginEmbeddingImport(loadSessionId);
    console.error(`[precomputed-import] successor=${loadSessionId} status=${state.status}`);

    for (const item of prepared) {
      const { shardMeta, resultManifest, resultManifestSha256, vectorsPath, mappingPath } = item;
      // eslint-disable-next-line no-await-in-loop
      const prior = await repo.getImportedShard(loadSessionId, shardMeta.shard_index);
      if (prior) {
        const exact = prior.row_count === shardMeta.row_count
          && Number(prior.global_start_index) === shardMeta.global_start_index
          && Number(prior.global_end_index) === shardMeta.global_end_index
          && prior.result_manifest_sha256 === resultManifestSha256
          && prior.vectors_sha256 === resultManifest.single_file_vectors_sha256
          && prior.mapping_sha256 === resultManifest.single_file_mapping_sha256;
        if (!exact) throw new Error(`IMPORTED_SHARD_PIN_MISMATCH_${shardMeta.shard_index}`);
        console.error(`[precomputed-import] shard ${shardMeta.shard_index}: already imported and pin-identical, skipping`);
        continue;
      }
      const copyPath = path.join(tempDir, `shard-${String(shardMeta.shard_index).padStart(3, "0")}.copybin`);
      console.error(`[precomputed-import] shard ${shardMeta.shard_index}: building bounded binary COPY spool...`);
      // eslint-disable-next-line no-await-in-loop
      const built = await buildBinaryCopyShard({ mappingPath, vectorsPath, outputPath: copyPath, shardMeta, resultManifest, resultManifestSha256, loadSessionId });
      console.error(`[precomputed-import] shard ${shardMeta.shard_index}: loading ${built.rowCount} vectors (worst_norm_deviation=${built.worstNormDeviation})...`);
      loadBinaryShardWithPsql({ psqlBin, databaseUrl, copyPath, loadSessionId, sourceLoadSessionId, shardMeta, resultManifest, resultManifestSha256 });
      // eslint-disable-next-line no-await-in-loop
      await rm(copyPath, { force: true });
    }

    const completed = await repo.completeEmbeddingImport(loadSessionId, { expectedShardCount: 8, expectedRowCount: 441879 });
    console.log(JSON.stringify({ gate_status: "PRECOMPUTED_EMBEDDING_IMPORT_COMPLETE", ...completed }, null, 2));
  } finally {
    await client.end();
    await rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[precomputed-import] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
