#!/usr/bin/env node
// Turn AC-COLAB-BENCH-V1, section F: LOCAL reference embedding run over the
// pinned 5,000-sample benchmark set, using the SAME running KURE-v1 server
// this Turn already independently confirmed (nlpai-lab/KURE-v1, revision
// 4ed4540949c70b7da2c74004a915e1f2d5e46e4f, dimension 1024) -- fails closed
// if the server's /info reports a different repository/revision/dimension
// rather than silently trusting the caller's own assumption.
//
// Vectors are written as a raw float32 .npy binary (never as JSON numbers
// -- JSON round-tripping loses float32 precision and is wildly larger for
// 5,000x1024 floats), alongside a row-mapping manifest (JSONL, one line per
// row, input_index/embedding_input_id/embed_text_sha256 in the SAME order
// as the .npy rows), a runtime manifest (device/versions/timings/
// throughput), and a file-integrity manifest (sha256 of every output
// file). No prompt/Gold/secret content is ever logged -- only counts,
// timings, and sha256 hex digests.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXPECTED_MODEL_REPOSITORY = "nlpai-lab/KURE-v1";
const EXPECTED_MODEL_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";
const EXPECTED_DIMENSION = 1024;

function sha256HexOfBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256HexOfString(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function writeFileAtomic(finalPath, buffer) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, buffer);
  await rename(partialPath, finalPath);
}

// Minimal NPY v1.0 writer for a 2-D float32 array, C-contiguous. See
// https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html
// -- implemented by hand (no numpy/python dependency in this Node script)
// because the format is small and fully specified; verified round-trip
// against numpy.load in this Turn's own tests.
export function encodeNpyFloat32Matrix(rows, cols, flatFloat32Array) {
  const headerDict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]); // \x93NUMPY
  const version = Buffer.from([1, 0]);
  const preHeaderLen = magic.length + version.length + 2; // +2 for the uint16 header-length field itself
  const unpaddedHeader = `${headerDict}\n`;
  const totalLen = preHeaderLen + unpaddedHeader.length;
  const padding = (64 - (totalLen % 64)) % 64;
  const header = Buffer.from(headerDict + " ".repeat(padding) + "\n", "ascii");
  const headerLenBuf = Buffer.alloc(2);
  headerLenBuf.writeUInt16LE(header.length, 0);
  const dataBuf = Buffer.from(flatFloat32Array.buffer, flatFloat32Array.byteOffset, flatFloat32Array.byteLength);
  return Buffer.concat([magic, version, headerLenBuf, header, dataBuf]);
}

export function l2Normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) throw new Error("ZERO_OR_NON_FINITE_NORM");
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[idx];
}

async function samplePythonServerRss(pidHint) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pidHint)]);
    const kb = parseInt(stdout.trim(), 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

async function findEmbeddingServerPid() {
  try {
    const { stdout } = await execFileAsync("bash", ["-c", "ps aux | grep local_embedding_server.py | grep -v grep | awk '{print $2}'"]);
    const pid = parseInt(stdout.trim().split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function main() {
  const sampleFulltextPath = process.argv[2];
  const outDir = process.argv[3];
  const kureUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!sampleFulltextPath || !outDir) {
    console.error("usage: node p11f0-colab-benchmark-local-reference-run.mjs <benchmark-sample-fulltext.jsonl> <out-dir>");
    process.exitCode = 1;
    return;
  }
  if (!kureUrl) throw new Error("P11F0_KURE_SERVER_URL is required");
  const batchSize = Number(process.env.P11F0_LOCAL_RUN_BATCH_SIZE ?? 25);

  const infoUrl = kureUrl.replace(/\/v1\/embeddings\/?$/, "/info");
  const infoResp = await fetch(infoUrl);
  if (!infoResp.ok) throw new Error(`KURE_SERVER_INFO_UNREACHABLE: ${infoResp.status}`);
  const info = await infoResp.json();
  if (info.repository_id !== EXPECTED_MODEL_REPOSITORY || info.model_revision !== EXPECTED_MODEL_REVISION || info.embedding_dimension !== EXPECTED_DIMENSION) {
    throw new Error(`KURE_SERVER_PIN_MISMATCH: server reports repository=${info.repository_id} revision=${info.model_revision} dimension=${info.embedding_dimension}, expected ${EXPECTED_MODEL_REPOSITORY}/${EXPECTED_MODEL_REVISION}/${EXPECTED_DIMENSION}`);
  }

  const raw = await readFile(sampleFulltextPath, "utf8");
  const rows = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const n = rows.length;
  const flat = new Float32Array(n * EXPECTED_DIMENSION);
  const rowMappingLines = [];
  const batchLatenciesMs = [];
  let failedCount = 0;

  const serverPid = await findEmbeddingServerPid();
  const rssSamplesBytes = [];
  const rssSampler = serverPid
    ? setInterval(async () => {
        const rss = await samplePythonServerRss(serverPid);
        if (rss !== null) rssSamplesBytes.push(rss);
      }, 1000)
    : null;

  const perBatchTimeoutMs = Number(process.env.P11F0_LOCAL_RUN_BATCH_TIMEOUT_MS ?? 120000);
  const startedAt = Date.now();
  for (let start = 0; start < n; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const batchStarted = Date.now();
    console.error(`[local-ref-run] batch start=${start} size=${batch.length} requesting...`);
    let resp;
    try {
      resp = await fetch(kureUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: batch.map((r) => r.text) }),
        signal: AbortSignal.timeout(perBatchTimeoutMs),
      });
    } catch (error) {
      failedCount += batch.length;
      console.error(`[local-ref-run] batch starting at ${start}: REQUEST_FAILED_OR_TIMED_OUT after ${Date.now() - batchStarted}ms (${error.name}: ${error.message}) -- ${batch.length} inputs marked failed`);
      batchLatenciesMs.push(Date.now() - batchStarted);
      continue;
    }
    const batchElapsedMs = Date.now() - batchStarted;
    batchLatenciesMs.push(batchElapsedMs);
    console.error(`[local-ref-run] batch start=${start} responded in ${batchElapsedMs}ms status=${resp.status}`);
    if (!resp.ok) {
      failedCount += batch.length;
      console.error(`[local-ref-run] batch starting at ${start}: HTTP ${resp.status} -- ${batch.length} inputs marked failed`);
      continue;
    }
    const body = await resp.json();
    const embeddings = body.data.map((d) => d.embedding);
    for (let i = 0; i < batch.length; i += 1) {
      const row = batch[i];
      const globalIdx = start + i;
      let vec;
      try {
        if (embeddings[i].length !== EXPECTED_DIMENSION) throw new Error(`DIMENSION_MISMATCH: got ${embeddings[i].length}`);
        vec = l2Normalize(Float32Array.from(embeddings[i]));
        for (const v of vec) if (!Number.isFinite(v)) throw new Error("NON_FINITE_COMPONENT");
      } catch (error) {
        failedCount += 1;
        console.error(`[local-ref-run] row ${globalIdx} (${row.embedding_input_id}): ${error.message}`);
        continue;
      }
      flat.set(vec, globalIdx * EXPECTED_DIMENSION);
      rowMappingLines.push(JSON.stringify({ input_index: globalIdx, embedding_input_id: row.embedding_input_id, embed_text_sha256: row.embed_text_sha256 }));
    }
    if ((start / batchSize) % 20 === 0) console.error(`[local-ref-run] progress: ${Math.min(start + batchSize, n)}/${n}`);
  }
  const totalElapsedMs = Date.now() - startedAt;
  if (rssSampler) clearInterval(rssSampler);

  const successCount = n - failedCount;
  const sortedLatencies = [...batchLatenciesMs].sort((a, b) => a - b);

  const npyBuffer = encodeNpyFloat32Matrix(n, EXPECTED_DIMENSION, flat);
  const vectorPath = `${outDir}/local-reference-vectors.npy`;
  await writeFileAtomic(vectorPath, npyBuffer);

  const rowMappingPath = `${outDir}/local-reference-row-mapping.jsonl`;
  await writeFileAtomic(rowMappingPath, Buffer.from(`${rowMappingLines.join("\n")}\n`, "utf8"));

  const inputOrderingSha256 = sha256HexOfString(rows.map((r) => r.embedding_input_id).join("\n"));

  const runtimeManifest = {
    schema_version: "p11f0-colab-benchmark-local-reference-run.v1",
    model: { repository: info.repository_id, revision: info.model_revision, dimension: info.embedding_dimension },
    device: info.device,
    mps_attempted: info.mps_attempted,
    mps_failure_reason: info.mps_failure_reason,
    runtime_versions: info.runtime_versions,
    batch_size: batchSize,
    row_count_requested: n,
    row_count_succeeded: successCount,
    row_count_failed: failedCount,
    elapsed_ms_total: totalElapsedMs,
    texts_per_sec: successCount / (totalElapsedMs / 1000),
    batch_latency_ms: {
      p50: percentile(sortedLatencies, 0.5),
      p95: percentile(sortedLatencies, 0.95),
      min: sortedLatencies[0] ?? null,
      max: sortedLatencies[sortedLatencies.length - 1] ?? null,
      count: sortedLatencies.length,
    },
    peak_server_rss_bytes: rssSamplesBytes.length > 0 ? Math.max(...rssSamplesBytes) : null,
    server_rss_sample_count: rssSamplesBytes.length,
    input_ordering_sha256: inputOrderingSha256,
    vector_output_sha256: sha256HexOfBuffer(npyBuffer),
    normalization: "l2 (unit-norm, applied client-side after the server's raw encode -- the server itself never normalizes)",
    generated_at: new Date().toISOString(),
  };
  const runtimeManifestPath = `${outDir}/local-reference-runtime-manifest.json`;
  await writeFileAtomic(runtimeManifestPath, Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`, "utf8"));

  const integrityManifest = {
    schema_version: "p11f0-colab-benchmark-file-integrity.v1",
    files: {
      "local-reference-vectors.npy": sha256HexOfBuffer(npyBuffer),
      "local-reference-row-mapping.jsonl": sha256HexOfString(`${rowMappingLines.join("\n")}\n`),
      "local-reference-runtime-manifest.json": sha256HexOfString(`${JSON.stringify(runtimeManifest, null, 2)}\n`),
    },
  };
  await writeFileAtomic(`${outDir}/local-reference-file-integrity-manifest.json`, Buffer.from(`${JSON.stringify(integrityManifest, null, 2)}\n`, "utf8"));

  console.log(JSON.stringify({ ...runtimeManifest, integrity: integrityManifest.files }, null, 2));
  if (failedCount > 0) {
    console.error(`[local-ref-run] ${failedCount}/${n} rows failed -- see stderr above for per-row reasons`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[local-ref-run] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
