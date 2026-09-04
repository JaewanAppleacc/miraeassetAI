#!/usr/bin/env node
// Turn AC-COLAB-BENCH-V1, section G: importer/verifier for a GPU benchmark
// result PACKAGE (a directory of 4 files -- see
// p11f0-colab-benchmark-local-reference-run.mjs's own header for the exact
// format, which this verifier also expects from a Colab/Kaggle run):
//
//   <prefix>-vectors.npy                 -- float32 [N, 1024], C-order
//   <prefix>-row-mapping.jsonl            -- one {input_index, embedding_input_id, embed_text_sha256} per row, npy row order
//   <prefix>-runtime-manifest.json        -- model/device/versions/timings/input_ordering_sha256/vector_output_sha256
//   <prefix>-file-integrity-manifest.json -- sha256 of the other 3 files
//
// This Turn's own instructions (section G) require the local/Colab
// compatibility bar to be fixed in code BEFORE any result is looked at --
// COSINE_MEAN_MIN and COSINE_MIN_MIN below are exactly that: written once,
// in this Turn, before any Colab run exists, and never loosened after
// seeing a result (a failing run reports COLAB_EMBEDDING_INCOMPATIBLE
// verbatim, not a suggestion to relax the threshold).
//
// Never uploads, never calls a GPU/embedding service -- reads local files
// only. Never logs raw chunk/document text -- only ids, hashes, counts,
// and numeric comparison statistics.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const COSINE_MEAN_MIN = 0.9999;
export const COSINE_MIN_MIN = 0.999;
const EXPECTED_MODEL_REPOSITORY = "nlpai-lab/KURE-v1";
const EXPECTED_MODEL_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";
const EXPECTED_DIMENSION = 1024;
const ALLOWED_RUNTIME_MANIFEST_FILENAMES = new Set([
  "local-reference-runtime-manifest.json", "colab-cuda-runtime-manifest.json", "kaggle-p100-runtime-manifest.json",
]);

function sha256HexOfBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Parses a float32 .npy (v1.0/v2.0 header, C-order, '<f4' or '=f4' descr
// only -- anything else is rejected, never silently coerced) into a plain
// Float32Array plus its declared [rows, cols] shape.
export function parseNpyFloat32Matrix(buffer) {
  if (buffer.length < 10 || buffer.toString("ascii", 1, 6) !== "NUMPY") throw new Error("NPY_BAD_MAGIC");
  const major = buffer.readUInt8(6);
  let headerLen; let headerStart;
  if (major === 1) { headerLen = buffer.readUInt16LE(8); headerStart = 10; }
  else { headerLen = buffer.readUInt32LE(8); headerStart = 12; }
  const header = buffer.toString("ascii", headerStart, headerStart + headerLen);
  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  const orderMatch = header.match(/'fortran_order':\s*(True|False)/);
  const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
  if (!descrMatch || !orderMatch || !shapeMatch) throw new Error("NPY_UNPARSEABLE_HEADER");
  if (descrMatch[1] !== "<f4" && descrMatch[1] !== "=f4") throw new Error(`NPY_UNSUPPORTED_DESCR: ${descrMatch[1]} (only float32 little-endian accepted)`);
  if (orderMatch[1] !== "False") throw new Error("NPY_FORTRAN_ORDER_UNSUPPORTED");
  const shape = shapeMatch[1].split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
  if (shape.length !== 2) throw new Error(`NPY_UNSUPPORTED_SHAPE: expected 2-D, got ${JSON.stringify(shape)}`);
  const [rows, cols] = shape;
  const dataStart = headerStart + headerLen;
  const expectedBytes = rows * cols * 4;
  if (buffer.length - dataStart !== expectedBytes) throw new Error(`NPY_DATA_LENGTH_MISMATCH: expected ${expectedBytes} bytes, found ${buffer.length - dataStart}`);
  const data = new Float32Array(buffer.buffer, buffer.byteOffset + dataStart, rows * cols);
  return { rows, cols, data };
}

function cosineSimilarity(a, b, offsetA, offsetB, dim) {
  let dot = 0; let normA = 0; let normB = 0;
  for (let i = 0; i < dim; i += 1) {
    const va = a[offsetA + i]; const vb = b[offsetB + i];
    dot += va * vb; normA += va * va; normB += vb * vb;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function loadPackage(dir, prefix) {
  const vectorPath = `${dir}/${prefix}-vectors.npy`;
  const mappingPath = `${dir}/${prefix}-row-mapping.jsonl`;
  const runtimePath = `${dir}/${prefix}-runtime-manifest.json`;
  const integrityPath = `${dir}/${prefix}-file-integrity-manifest.json`;

  const [vectorBuf, mappingRaw, runtimeRaw, integrityRaw] = await Promise.all([
    readFile(vectorPath), readFile(mappingPath, "utf8"), readFile(runtimePath, "utf8"), readFile(integrityPath, "utf8"),
  ]);
  const runtime = JSON.parse(runtimeRaw);
  const integrity = JSON.parse(integrityRaw);
  const mapping = mappingRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const { rows, cols, data } = parseNpyFloat32Matrix(vectorBuf);
  return {
    dir, prefix, vectorBuf, mappingRaw, runtimeRaw, runtime, integrity, mapping, rows, cols, data,
    files: {
      [`${prefix}-vectors.npy`]: vectorBuf,
      [`${prefix}-row-mapping.jsonl`]: Buffer.from(mappingRaw, "utf8"),
      [`${prefix}-runtime-manifest.json`]: Buffer.from(runtimeRaw, "utf8"),
    },
  };
}

function verifyPackageIntegrity(pkg, errors) {
  for (const [filename, buf] of Object.entries(pkg.files)) {
    const expected = pkg.integrity.files?.[filename];
    if (!expected) { errors.push(`${pkg.prefix}: integrity manifest missing entry for ${filename}`); continue; }
    const actual = sha256HexOfBuffer(buf);
    if (actual !== expected) errors.push(`${pkg.prefix}: FILE_SHA_MISMATCH ${filename}: manifest says ${expected}, actual ${actual}`);
  }
  const extraKeys = Object.keys(pkg.integrity.files ?? {}).filter((k) => !(k in pkg.files));
  for (const k of extraKeys) errors.push(`${pkg.prefix}: integrity manifest references unexpected file ${k}`);
}

function verifyPins(pkg, errors) {
  if (pkg.runtime.model?.repository !== EXPECTED_MODEL_REPOSITORY) errors.push(`${pkg.prefix}: WRONG_MODEL_REPOSITORY: ${pkg.runtime.model?.repository}`);
  if (pkg.runtime.model?.revision !== EXPECTED_MODEL_REVISION) errors.push(`${pkg.prefix}: WRONG_MODEL_REVISION: ${pkg.runtime.model?.revision}`);
  if (pkg.runtime.model?.dimension !== EXPECTED_DIMENSION) errors.push(`${pkg.prefix}: WRONG_DIMENSION: ${pkg.runtime.model?.dimension}`);
  if (pkg.cols !== EXPECTED_DIMENSION) errors.push(`${pkg.prefix}: WRONG_NPY_COLS: ${pkg.cols}`);
  if (pkg.rows !== pkg.mapping.length) errors.push(`${pkg.prefix}: ROW_COUNT_MAPPING_MISMATCH: npy has ${pkg.rows} rows, mapping has ${pkg.mapping.length}`);
}

function verifyMembershipAndOrdering(pkg, expectedIds, expectedInputOrderingSha256, errors) {
  const ids = pkg.mapping.map((m) => m.embedding_input_id);
  const seen = new Set();
  const duplicates = [];
  const outOfSample = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
    if (!expectedIds.has(id)) outOfSample.push(id);
  }
  const missing = [...expectedIds].filter((id) => !seen.has(id));
  if (duplicates.length > 0) errors.push(`${pkg.prefix}: DUPLICATE_ROWS: ${duplicates.length} (e.g. ${duplicates.slice(0, 3).join(", ")})`);
  if (outOfSample.length > 0) errors.push(`${pkg.prefix}: OUT_OF_SAMPLE_ROWS: ${outOfSample.length} (e.g. ${outOfSample.slice(0, 3).join(", ")})`);
  if (missing.length > 0) errors.push(`${pkg.prefix}: MISSING_ROWS: ${missing.length} (e.g. ${missing.slice(0, 3).join(", ")})`);
  if (ids.length !== expectedIds.size) errors.push(`${pkg.prefix}: ROW_COUNT: expected ${expectedIds.size}, got ${ids.length}`);

  const actualOrderingSha256 = createHash("sha256").update(ids.join("\n"), "utf8").digest("hex");
  if (actualOrderingSha256 !== expectedInputOrderingSha256) {
    errors.push(`${pkg.prefix}: INPUT_ORDERING_SHA_MISMATCH: expected ${expectedInputOrderingSha256}, got ${actualOrderingSha256}`);
  }
  if (pkg.runtime.input_ordering_sha256 && pkg.runtime.input_ordering_sha256 !== expectedInputOrderingSha256) {
    errors.push(`${pkg.prefix}: RUNTIME_MANIFEST_INPUT_ORDERING_SHA_MISMATCH: ${pkg.runtime.input_ordering_sha256}`);
  }
}

function verifyFiniteAndNormalization(pkg, errors) {
  let nonFiniteCount = 0;
  let worstNormDeviation = 0;
  for (let r = 0; r < pkg.rows; r += 1) {
    let sumSq = 0;
    for (let c = 0; c < pkg.cols; c += 1) {
      const v = pkg.data[r * pkg.cols + c];
      if (!Number.isFinite(v)) { nonFiniteCount += 1; continue; }
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq);
    worstNormDeviation = Math.max(worstNormDeviation, Math.abs(norm - 1));
  }
  if (nonFiniteCount > 0) errors.push(`${pkg.prefix}: NON_FINITE_COMPONENTS: ${nonFiniteCount}`);
  if (worstNormDeviation > 0.01) errors.push(`${pkg.prefix}: NORMALIZATION_MISMATCH: worst |L2 norm - 1| = ${worstNormDeviation.toFixed(6)} (expected L2-unit-norm vectors)`);
  return { nonFiniteCount, worstNormDeviation };
}

// Cross-package comparison by embed_text_sha256 (never by row position --
// two packages need not share row order). Every summary statistic is
// reported even when the gate fails, so a failure is diagnosable, not just
// a bare COLAB_EMBEDDING_INCOMPATIBLE.
function compareCosine(local, remote, errors) {
  // Uses the packages' OWN (matching) column count, never a hardcoded
  // EXPECTED_DIMENSION -- if local.cols and remote.cols actually differ,
  // reading EXPECTED_DIMENSION floats per row would silently walk past a
  // shorter row's real data into the next row (or past the buffer, where a
  // Float32Array read returns `undefined`, so dot/normA/normB become NaN
  // and every `NaN < threshold` comparison is silently false --  the gate
  // would pass nothing but ALSO flag nothing as a cosine failure). Refuse
  // outright instead: a dimension mismatch is already reported by
  // verifyPins' WRONG_NPY_COLS, and no meaningful cosine number exists to
  // report here.
  if (local.cols !== remote.cols) {
    errors.push(`COSINE_COMPARE: local.cols=${local.cols} != remote.cols=${remote.cols} -- cannot compute a meaningful cosine similarity across mismatched dimensions`);
    return { compared_count: 0, mean_cosine: null, min_cosine: null, cosine_mean_min_threshold: COSINE_MEAN_MIN, cosine_min_min_threshold: COSINE_MIN_MIN };
  }
  const dim = local.cols;
  const localByHash = new Map(local.mapping.map((m, i) => [m.embed_text_sha256, i]));
  const cosines = [];
  let comparedCount = 0;
  for (let i = 0; i < remote.mapping.length; i += 1) {
    const hash = remote.mapping[i].embed_text_sha256;
    const localIdx = localByHash.get(hash);
    if (localIdx === undefined) continue;
    const c = cosineSimilarity(local.data, remote.data, localIdx * local.cols, i * remote.cols, dim);
    cosines.push(c);
    comparedCount += 1;
  }
  const mean = cosines.length > 0 ? cosines.reduce((a, b) => a + b, 0) / cosines.length : null;
  const min = cosines.length > 0 ? Math.min(...cosines) : null;
  const result = { compared_count: comparedCount, mean_cosine: mean, min_cosine: min, cosine_mean_min_threshold: COSINE_MEAN_MIN, cosine_min_min_threshold: COSINE_MIN_MIN };
  if (comparedCount === 0) { errors.push("COSINE_COMPARE: zero overlapping embed_text_sha256 between local and remote packages"); return result; }
  if (mean < COSINE_MEAN_MIN) errors.push(`COSINE_MEAN_BELOW_THRESHOLD: ${mean} < ${COSINE_MEAN_MIN}`);
  if (min < COSINE_MIN_MIN) errors.push(`COSINE_MIN_BELOW_THRESHOLD: ${min} < ${COSINE_MIN_MIN}`);
  return result;
}

export async function verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir, remoteDir, remotePrefix }) {
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const expectedIds = new Set(summary.benchmark_sample.sample_ids);
  const sampleFulltextRaw = await readFile(sampleFulltextPath, "utf8");
  const sampleRows = sampleFulltextRaw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const expectedInputOrderingSha256 = createHash("sha256").update(sampleRows.map((r) => r.embedding_input_id).join("\n"), "utf8").digest("hex");

  const errors = [];
  const local = await loadPackage(localDir, "local-reference");
  verifyPackageIntegrity(local, errors);
  verifyPins(local, errors);
  verifyMembershipAndOrdering(local, expectedIds, expectedInputOrderingSha256, errors);
  const localFiniteNorm = verifyFiniteAndNormalization(local, errors);

  let remote = null;
  let remoteFiniteNorm = null;
  let cosineResult = null;
  if (remoteDir) {
    if (!ALLOWED_RUNTIME_MANIFEST_FILENAMES.has(`${remotePrefix}-runtime-manifest.json`)) {
      errors.push(`DISALLOWED_RESULT_PREFIX: ${remotePrefix}`);
    } else {
      remote = await loadPackage(remoteDir, remotePrefix);
      verifyPackageIntegrity(remote, errors);
      verifyPins(remote, errors);
      verifyMembershipAndOrdering(remote, expectedIds, expectedInputOrderingSha256, errors);
      remoteFiniteNorm = verifyFiniteAndNormalization(remote, errors);
      cosineResult = compareCosine(local, remote, errors);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    local_summary: { row_count: local.rows, ...localFiniteNorm },
    remote_summary: remote ? { row_count: remote.rows, ...remoteFiniteNorm } : null,
    cosine: cosineResult,
    verdict: errors.length === 0
      ? (remote ? "COLAB_BENCHMARK_VERIFIED" : "LOCAL_REFERENCE_VALID_NO_REMOTE_YET")
      : (remote && cosineResult && cosineResult.compared_count > 0 && (cosineResult.mean_cosine < COSINE_MEAN_MIN || cosineResult.min_cosine < COSINE_MIN_MIN) ? "COLAB_EMBEDDING_INCOMPATIBLE" : "INPUT_INTEGRITY_BLOCKED"),
  };
}

async function main() {
  const [summaryPath, sampleFulltextPath, localDir, remoteDir, remotePrefix] = process.argv.slice(2);
  if (!summaryPath || !sampleFulltextPath || !localDir) {
    console.error("usage: node p11f0-colab-benchmark-verify.mjs <summary.json> <sample-fulltext.jsonl> <local-dir> [remote-dir] [remote-prefix]");
    process.exitCode = 1;
    return;
  }
  const report = await verifyGpuBenchmarkPackage({ summaryPath, sampleFulltextPath, localDir, remoteDir: remoteDir || null, remotePrefix: remotePrefix || null });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[colab-benchmark-verify] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
