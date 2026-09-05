import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeNpyFloat32Matrix } from "../scripts/p11f0-colab-benchmark-local-reference-run.mjs";
import {
  buildBinaryCopyShard,
  encodeBinaryCopyRow,
  encodePgVectorBinaryFromNpyRow,
  readNpyFloat32Header,
} from "../scripts/p11f0-precomputed-vector-import.mjs";

const DIM = 1024;

function unitVector(seed = 0) {
  const vector = new Float32Array(DIM);
  vector[seed % DIM] = 1;
  return vector;
}

test("streaming NPY header reader accepts pinned C-order little-endian float32 shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p11f0-npy-header-"));
  try {
    const file = path.join(dir, "vectors.npy");
    await writeFile(file, encodeNpyFloat32Matrix(2, DIM, Float32Array.from([...unitVector(1), ...unitVector(2)])));
    const header = await readNpyFloat32Header(file);
    assert.equal(header.rows, 2);
    assert.equal(header.cols, DIM);
    assert.equal(header.byteLength - header.dataOffset, 2 * DIM * 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pgvector binary encoder writes dimension and big-endian float components", () => {
  const row = Buffer.from(unitVector(3).buffer);
  const encoded = encodePgVectorBinaryFromNpyRow(row, DIM);
  assert.equal(encoded.buffer.readInt16BE(0), DIM);
  assert.equal(encoded.buffer.readInt16BE(2), 0);
  assert.equal(encoded.buffer.readFloatBE(4 + 3 * 4), 1);
  assert.equal(encoded.normDeviation, 0);
});

test("pgvector binary encoder rejects non-finite and denormalized vectors", () => {
  const nonFinite = unitVector(); nonFinite[5] = Number.NaN;
  assert.throws(() => encodePgVectorBinaryFromNpyRow(Buffer.from(nonFinite.buffer), DIM), /NON_FINITE/);
  const denormalized = unitVector(); denormalized[0] = 2;
  assert.throws(() => encodePgVectorBinaryFromNpyRow(Buffer.from(denormalized.buffer), DIM), /NORMALIZATION/);
});

test("binary COPY row has seven fields and preserves fixed-width integer/vector payloads", () => {
  const vector = encodePgVectorBinaryFromNpyRow(Buffer.from(unitVector().buffer), DIM).buffer;
  const row = encodeBinaryCopyRow({
    loadSessionId: "fixed_kure_attempt_test",
    embeddingInputId: `embin_${"a".repeat(24)}`,
    globalEligibleIndex: 42,
    embedTextSha256: "a".repeat(64),
    vectorBinary: vector,
    shardIndex: 3,
    resultManifestSha256: "b".repeat(64),
  });
  assert.equal(row.readInt16BE(0), 7);
  assert.ok(row.length > DIM * 4);
});

test("binary COPY shard is deterministic and rejects mapping/hash identity drift", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p11f0-copy-shard-"));
  try {
    const vectorsPath = path.join(dir, "vectors.npy");
    const mappingPath = path.join(dir, "mapping.jsonl");
    const outputA = path.join(dir, "a.copybin");
    const outputB = path.join(dir, "b.copybin");
    const hashes = ["a".repeat(64), "b".repeat(64)];
    await writeFile(vectorsPath, encodeNpyFloat32Matrix(2, DIM, Float32Array.from([...unitVector(1), ...unitVector(2)])));
    await writeFile(mappingPath, `${hashes.map((sha, i) => JSON.stringify({ global_eligible_index: 10 + i, embedding_input_id: `embin_${sha.slice(0, 24)}`, embed_text_sha256: sha })).join("\n")}\n`);
    const args = {
      mappingPath, vectorsPath,
      shardMeta: { shard_index: 0, row_count: 2, global_start_index: 10, global_end_index: 11 },
      resultManifest: {}, resultManifestSha256: "c".repeat(64), loadSessionId: "fixed_kure_attempt_test",
    };
    await buildBinaryCopyShard({ ...args, outputPath: outputA });
    await buildBinaryCopyShard({ ...args, outputPath: outputB });
    assert.deepEqual(await readFile(outputA), await readFile(outputB));

    await writeFile(mappingPath, `${JSON.stringify({ global_eligible_index: 10, embedding_input_id: `embin_${"f".repeat(24)}`, embed_text_sha256: "a".repeat(64) })}\n`);
    await assert.rejects(() => buildBinaryCopyShard({ ...args, outputPath: path.join(dir, "bad.copybin") }), /EMBEDDING_INPUT_ID_MISMATCH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration is additive, source-linked, dimension-checked, and records immutable shard provenance", async () => {
  const sql = await readFile(new URL("../domain/postgres/013_reference_fixed_kure_precomputed_embeddings.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS discovery_source_load_session_id/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS .*reference_fixed_kure_precomputed_embeddings/s);
  assert.match(sql, /vector_dims\(NEW\.embedding\)/);
  assert.match(sql, /INVALID_DISCOVERY_CANONICAL_SCOPE/);
  assert.match(sql, /count\(DISTINCT embed_text_sha256\)/);
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE|DROP TABLE/);
});
