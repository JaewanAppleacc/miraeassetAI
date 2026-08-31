#!/usr/bin/env node
// Turn P9.3: real, bounded, Gold-blind local embedding calibration for the
// 3 frozen candidates. Downloads real model weights (pinned revision only)
// into a TASK-OWNED cache, runs a real local Python embedding server (one
// model in memory at a time), and drives it through the SAME
// runEmbeddingCalibration() runner.mjs already uses for the mock server in
// Turn P9.2 -- no new client-side embedding logic, only a new (real)
// server to point it at.
//
// NEVER: calls a real external embedding API, downloads/uses a 4th model,
// reads Gold/HOLDOUT, calls HCX, or performs a full 723,875-record
// production load. A failure on any ONE model is recorded honestly and
// does NOT block or fake the other two.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import process from "node:process";

import {
  getFrozenCandidateById, toCalibrationConfig, prepareTextForMode,
  computeFrozenCandidateRegistrySha256,
} from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import { collectVerifiedCalibrationCandidates, selectCalibrationDataset, buildCalibrationDatasetManifest } from "../domain/agent-comparison/embedding-calibration/dataset.mjs";
import { runEmbeddingCalibration } from "../domain/agent-comparison/embedding-calibration/runner.mjs";
import { buildCalibrationRunManifest, computePrefixPolicySha256 } from "../domain/agent-comparison/embedding-calibration/report.mjs";
import { cosineSimilarity } from "../domain/agent-comparison/embedding-calibration/metrics.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { toEmbeddingConfig } from "../domain/agent-comparison/embedding-calibration/contracts.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "domain-seed", "embedding-calibration-real-v0.1");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const VENV_DIR = path.join(TASK_CACHE_ROOT, "venv");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const RUN_DIR = path.join(TASK_CACHE_ROOT, "run");
const VENV_PYTHON = path.join(VENV_DIR, "bin", "python3");
const CACHE_LIMIT_BYTES = 12 * 1024 * 1024 * 1024;
const EXPECTED_DATASET_SHA256 = "9848b30c8704b647eeab6820cd0f89473f2d659da9aae72c5a4eb9f58f0b28b0";

const BUNDLE_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});

const CANDIDATE_ORDER = ["kure_v1", "bge_m3", "pixie_rune"];

async function sha256File(filePath) {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function dirSizeBytes(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

async function ensureVenv() {
  const { existsSync } = await import("node:fs");
  if (existsSync(VENV_PYTHON)) {
    console.error("[real-calibration] venv already exists, reusing");
    return;
  }
  console.error("[real-calibration] creating isolated task-owned venv (system Python is never modified)...");
  await mkdir(TASK_CACHE_ROOT, { recursive: true });
  await run("/usr/bin/python3", ["-m", "venv", VENV_DIR]);
  await run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"]);
  await run(VENV_PYTHON, ["-m", "pip", "install", "-r", path.join(ROOT, "scripts/embedding-calibration-real/requirements.in")]);
  const frozen = await new Promise((resolve, reject) => {
    const child = spawn(VENV_PYTHON, ["-m", "pip", "freeze"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error("pip freeze failed"))));
  });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(TASK_CACHE_ROOT, "requirements-frozen.txt"), frozen);
}

function waitForServerReady(child, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("timed out waiting for LISTENING line from local_embedding_server.py")); }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/LISTENING 127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server process exited early with code ${code}`)); }
    });
    child.on("error", (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

// Section F: real tokenizer-backed truncation check, run against the SAME
// server that will actually embed these texts -- both document-mode and
// query-mode prepared strings, per item.
async function checkTokenLengths(baseUrl, candidate, datasetItems) {
  const documentTexts = datasetItems.map((item) => prepareTextForMode(candidate, item.textContent, "document"));
  const queryTexts = datasetItems.map((item) => prepareTextForMode(candidate, item.textContent, "query"));
  const [documentResp, queryResp] = await Promise.all([
    fetch(`${baseUrl}/tokenize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: documentTexts }) }).then((r) => r.json()),
    fetch(`${baseUrl}/tokenize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: queryTexts }) }).then((r) => r.json()),
  ]);
  const allLengths = [...documentResp.lengths, ...queryResp.lengths].sort((a, b) => a - b);
  const maxAllowed = documentResp.max_input_length;
  const overLength = [];
  datasetItems.forEach((item, i) => {
    if (documentResp.lengths[i] > maxAllowed) overLength.push({ calibration_item_id: item.calibrationItemId, mode: "document", token_count: documentResp.lengths[i] });
    if (queryResp.lengths[i] > maxAllowed) overLength.push({ calibration_item_id: item.calibrationItemId, mode: "query", token_count: queryResp.lengths[i] });
  });
  return {
    max_input_length: maxAllowed,
    token_count_p50: percentile(allLengths, 0.5),
    token_count_p95: percentile(allLengths, 0.95),
    token_count_max: allLengths.length > 0 ? allLengths[allLengths.length - 1] : null,
    over_length_items: overLength,
    truncation_would_occur: overLength.length > 0,
  };
}

async function runStage({ label, calibrationConfig, datasetItems, candidate, isMockServer }) {
  console.error(`[real-calibration] ${label}: ${datasetItems.length} item(s)...`);
  const result = await runEmbeddingCalibration({
    calibrationConfig, datasetItems, isMockServer,
    prepareText: (text, mode) => prepareTextForMode(candidate, text, mode),
  });
  console.error(`[real-calibration] ${label}: run_status=${result.run_status} recall@1=${result.quality?.self_match_recall_at_1}`);
  return result;
}

function repositoryToHfCacheDirName(repositoryId) {
  return `models--${repositoryId.replace(/\//g, "--")}`;
}

// Section D: proves the downloaded snapshot really resolves to the pinned
// revision (HF's own cache layout symlinks a `snapshots/<revision>/` dir),
// and records every file's size + a SHA256 for config/weight files.
async function buildDownloadManifestEntry(candidate) {
  // NOTE: because local_embedding_server.py passes cache_folder=<HF_CACHE_DIR>
  // directly to SentenceTransformer (rather than relying on the default
  // ~/.cache/huggingface/hub/ layout), huggingface_hub places snapshots
  // directly under HF_CACHE_DIR/models--org--name/... -- there is NO "hub/"
  // path segment in THIS task-owned cache (unlike a default HF_HOME cache).
  const snapshotDir = path.join(HF_CACHE_DIR, repositoryToHfCacheDirName(candidate.repository_id), "snapshots", candidate.immutable_revision);
  const { existsSync } = await import("node:fs");
  if (!existsSync(snapshotDir)) {
    return { snapshot_dir: snapshotDir, snapshot_dir_exists: false, files: [] };
  }
  const entries = await readdir(snapshotDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(snapshotDir, entry.name);
    // eslint-disable-next-line no-await-in-loop
    const size = (await stat(filePath)).size;
    const isCoreFile = /\.(safetensors|bin|json)$/.test(entry.name);
    let sha256 = null;
    if (isCoreFile) {
      // eslint-disable-next-line no-await-in-loop
      sha256 = await sha256File(filePath);
    }
    files.push({ name: entry.name, size_bytes: size, sha256 });
  }
  return { snapshot_dir: snapshotDir, snapshot_dir_exists: true, files };
}

async function runOneCandidate(frozenCandidateId, allCandidateItems) {
  const candidate = getFrozenCandidateById(frozenCandidateId);
  console.error(`\n=== ${candidate.frozen_candidate_id} (${candidate.repository_id}@${candidate.immutable_revision}) ===`);

  const beforeCacheBytes = await dirSizeBytes(HF_CACHE_DIR);

  let serverChild = null;
  const record = {
    frozen_candidate_id: candidate.frozen_candidate_id,
    repository_id: candidate.repository_id,
    immutable_revision: candidate.immutable_revision,
    status: null,
    failure_reason: null,
    stages: {},
  };

  try {
    const downloadStartedAt = Date.now();
    serverChild = spawn(VENV_PYTHON, [
      path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
      "--repository-id", candidate.repository_id,
      "--revision", candidate.immutable_revision,
      "--cache-dir", HF_CACHE_DIR,
      "--expected-dimension", String(candidate.embedding_dimension),
      "--expected-max-input-length", String(candidate.max_input_length),
      "--port", "0",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    let port;
    try {
      port = await waitForServerReady(serverChild);
    } catch (error) {
      const exitCode = serverChild.exitCode;
      if (exitCode === 42) {
        record.status = "RUNTIME_REQUIRES_REMOTE_CODE";
      } else {
        record.status = String(error.message).includes("download") ? "DOWNLOAD_FAILED" : "MODEL_LOAD_FAILED";
      }
      record.failure_reason = error.message;
      return record;
    }
    const loadElapsedMs = Date.now() - downloadStartedAt;

    const afterCacheBytes = await dirSizeBytes(HF_CACHE_DIR);
    record.download_size_bytes = Math.max(0, afterCacheBytes - beforeCacheBytes);
    record.cache_total_bytes_after = afterCacheBytes;
    record.load_elapsed_ms = loadElapsedMs;

    const baseUrl = `http://127.0.0.1:${port}`;
    const infoResponse = await fetch(`${baseUrl}/info`).then((r) => r.json());
    record.device = infoResponse.device;
    record.mps_attempted = infoResponse.mps_attempted;
    record.mps_failure_reason = infoResponse.mps_failure_reason;
    record.runtime_versions = infoResponse.runtime_versions;

    if (infoResponse.repository_id !== candidate.repository_id || infoResponse.model_revision !== candidate.immutable_revision
      || infoResponse.embedding_dimension !== candidate.embedding_dimension || infoResponse.max_input_length < candidate.max_input_length) {
      record.status = "SERVER_IDENTITY_FAILED";
      record.failure_reason = `server /info did not match the pinned identity: ${JSON.stringify(infoResponse)}`;
      return record;
    }

    record.download_manifest = await buildDownloadManifestEntry(candidate);

    const configFor = (overrides = {}) => toCalibrationConfig(candidate, {
      datasetManifestSha256: EXPECTED_DATASET_SHA256, sampleSalt: "turn-p9-fake-smoke-v01", codeRevision: "turn-p9.3",
      maximumItemCount: 100, maximumRequestCount: 50, maximumTotalInputUnits: 2_000_000,
      batchSize: 10, requestTimeoutMs: 120000, endpointOverride: `${baseUrl}/v1/embeddings`,
      authMode: "NONE", serverInfoUrlOverride: `${baseUrl}/info`, callerRequestsAuthorization: true,
      ...overrides,
    });

    // --- Stage 0: tokenizer / truncation check (real tokenizer, all 98 items) ---
    record.tokenizer_check = await checkTokenLengths(baseUrl, candidate, allCandidateItems);
    console.error(`[real-calibration] tokenizer check: p50=${record.tokenizer_check.token_count_p50} p95=${record.tokenizer_check.token_count_p95} max=${record.tokenizer_check.token_count_max} over_length=${record.tokenizer_check.over_length_items.length}`);
    if (record.tokenizer_check.truncation_would_occur) {
      record.status = "TOKEN_LIMIT_FAILED";
      record.failure_reason = `${record.tokenizer_check.over_length_items.length} item(s) exceed max_input_length=${record.tokenizer_check.max_input_length}`;
      return record;
    }

    // --- Stage 1: load smoke ---
    const stage1Items = allCandidateItems.slice(0, 1);
    record.stages.stage1_load_smoke = await runStage({ label: "stage1", calibrationConfig: configFor({ maximumItemCount: 5 }), datasetItems: stage1Items, candidate, isMockServer: false });
    if (record.stages.stage1_load_smoke.run_status !== "SUCCESS") {
      record.status = "EMBEDDING_FAILED";
      record.failure_reason = `stage1 failed: ${record.stages.stage1_load_smoke.failure_code}`;
      return record;
    }

    // --- Stage 2: bounded smoke ---
    const stage2Items = allCandidateItems.slice(0, 8);
    record.stages.stage2_bounded_smoke = await runStage({ label: "stage2", calibrationConfig: configFor({ maximumItemCount: 20 }), datasetItems: stage2Items, candidate, isMockServer: false });
    if (record.stages.stage2_bounded_smoke.run_status !== "SUCCESS") {
      record.status = "EMBEDDING_FAILED";
      record.failure_reason = `stage2 failed: ${record.stages.stage2_bounded_smoke.failure_code}`;
      return record;
    }

    // --- Stage 3: full 98-item calibration ---
    record.stages.stage3_full_calibration = await runStage({ label: "stage3", calibrationConfig: configFor({ maximumItemCount: 100 }), datasetItems: allCandidateItems, candidate, isMockServer: false });
    if (record.stages.stage3_full_calibration.run_status !== "SUCCESS") {
      record.status = "EMBEDDING_FAILED";
      record.failure_reason = `stage3 failed: ${record.stages.stage3_full_calibration.failure_code}`;
      return record;
    }

    // --- Stage 4: repeatability (>=10 items, embedded twice, cosine-similarity + ranking tolerance) ---
    const stage4Items = allCandidateItems.slice(0, 10);
    record.stages.stage4_repeatability = await measureRepeatability(configFor(), candidate, stage4Items);

    record.registry_sha256 = computeFrozenCandidateRegistrySha256();
    record.prefix_policy_sha256 = computePrefixPolicySha256({ queryPrefix: candidate.query_prefix, documentPrefix: candidate.document_prefix });
    record.run_manifest = buildCalibrationRunManifest({
      calibrationConfig: configFor(), datasetManifest: { item_count: allCandidateItems.length, distinct_evidence_count: new Set(allCandidateItems.map((i) => i.evidenceId)).size },
      codeRevision: "turn-p9.3", frozenCandidate: candidate, registrySha256: record.registry_sha256, runResult: record.stages.stage3_full_calibration,
    });

    record.status = "CALIBRATION_COMPLETED";
    return record;
  } catch (error) {
    record.status = record.status ?? "EMBEDDING_FAILED";
    record.failure_reason = error.stack ?? error.message;
    return record;
  } finally {
    await stopServer(serverChild);
  }
}

// Calls the SAME adapter contract directly (bypassing runEmbeddingCalibration,
// which deliberately never returns raw vectors) to compute a REAL
// item-by-item cosine similarity between two independent embedding calls
// of the identical (prepared) text. Vectors are held ONLY in this
// function's own local scope and are NEVER written to any file or
// returned on the result object -- only the aggregated p50/min/max cosine
// similarity and a tolerance-based verdict are persisted. Hardware
// floating-point non-determinism means byte-identical vectors are never
// required; TOLERANCE is intentionally generous (>= 0.999999 cosine
// similarity, i.e. effectively identical direction) while still catching a
// genuine non-determinism regression.
const REPEATABILITY_COSINE_TOLERANCE = 0.999999;

async function measureRepeatability(calibrationConfig, candidate, items) {
  const adapter = createEmbeddingAdapter(toEmbeddingConfig(calibrationConfig));
  const documentTexts = items.map((item) => prepareTextForMode(candidate, item.textContent, "document"));
  const queryTexts = items.map((item) => prepareTextForMode(candidate, item.textContent, "query"));

  let firstDoc;
  let secondDoc;
  let firstQuery;
  let secondQuery;
  try {
    firstDoc = await adapter.embedDocuments(documentTexts, toEmbeddingConfig(calibrationConfig));
    secondDoc = await adapter.embedDocuments(documentTexts, toEmbeddingConfig(calibrationConfig));
    firstQuery = await adapter.embedDocuments(queryTexts, toEmbeddingConfig(calibrationConfig));
    secondQuery = await adapter.embedDocuments(queryTexts, toEmbeddingConfig(calibrationConfig));
  } catch (error) {
    return { assessed: false, reason: `repeatability embedding calls failed: ${error.message}` };
  }

  const allPairs = [...firstDoc.map((v, i) => [v, secondDoc[i]]), ...firstQuery.map((v, i) => [v, secondQuery[i]])];
  const similarities = allPairs.map(([a, b]) => cosineSimilarity(a, b)).sort((a, b) => a - b);
  const withinTolerance = similarities.every((s) => s >= REPEATABILITY_COSINE_TOLERANCE);

  return {
    assessed: true,
    item_count: items.length,
    pair_count: allPairs.length,
    cosine_similarity_min: similarities[0],
    cosine_similarity_p50: similarities[Math.floor(similarities.length / 2)],
    cosine_similarity_max: similarities[similarities.length - 1],
    tolerance: REPEATABILITY_COSINE_TOLERANCE,
    within_tolerance: withinTolerance,
    note: "byte-identical vectors are NOT required -- only cosine-similarity stability within tolerance is assessed; no raw vector is persisted anywhere",
  };
}

async function main() {
  console.error("[real-calibration] collecting the SAME 98-item non-Gold dataset P9 pinned...");
  const candidates = await collectVerifiedCalibrationCandidates(BUNDLE_OPTIONS);
  const datasetItems = selectCalibrationDataset({ candidates, maximumItemCount: Math.min(200, candidates.length), sampleSalt: "turn-p9-fake-smoke-v01" });
  const datasetManifest = buildCalibrationDatasetManifest({ datasetId: "calibration_dataset_fake_smoke_v01", sampleSalt: "turn-p9-fake-smoke-v01", datasetItems, candidatePoolSize: candidates.length });
  if (datasetManifest.calibration_dataset_sha256 !== EXPECTED_DATASET_SHA256) {
    throw new Error(`dataset drift detected: expected ${EXPECTED_DATASET_SHA256}, got ${datasetManifest.calibration_dataset_sha256} -- refusing to run real calibration against a different dataset than the one pinned`);
  }
  console.error(`[real-calibration] dataset confirmed: ${datasetManifest.item_count} items, sha256=${datasetManifest.calibration_dataset_sha256}`);

  await ensureVenv();
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(RUN_DIR, { recursive: true });

  const results = {};
  for (const frozenCandidateId of CANDIDATE_ORDER) {
    // eslint-disable-next-line no-await-in-loop
    const record = await runOneCandidate(frozenCandidateId, datasetItems);
    results[frozenCandidateId] = record;
    // eslint-disable-next-line no-await-in-loop
    await writeFile(path.join(OUT_DIR, `${frozenCandidateId.replace(/_/g, "-")}-calibration-result.v0.1.json`), JSON.stringify(record, null, 2));

    // eslint-disable-next-line no-await-in-loop
    const cacheBytes = await dirSizeBytes(HF_CACHE_DIR);
    console.error(`[real-calibration] cache total after ${frozenCandidateId}: ${(cacheBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
    if (cacheBytes > CACHE_LIMIT_BYTES) {
      console.error(`[real-calibration] cache limit (12GB) exceeded -- halting before the next model download`);
      break;
    }
  }

  const finalCacheBytes = await dirSizeBytes(HF_CACHE_DIR);

  const downloadManifest = {
    schema_version: "0.1.0",
    task_owned_cache_dir: HF_CACHE_DIR,
    cache_total_bytes: finalCacheBytes,
    cache_total_gb: finalCacheBytes / 1024 / 1024 / 1024,
    cache_limit_gb: CACHE_LIMIT_BYTES / 1024 / 1024 / 1024,
    candidates: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, {
      repository_id: r.repository_id, immutable_revision: r.immutable_revision,
      status: r.status, download_size_bytes: r.download_size_bytes ?? null,
      download_manifest: r.download_manifest ?? null,
    }])),
    created_at: new Date().toISOString(),
  };
  await writeFile(path.join(OUT_DIR, "frozen-model-download-manifest.v0.1.json"), JSON.stringify(downloadManifest, null, 2));

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const frozenRequirements = await readFileAsync(path.join(TASK_CACHE_ROOT, "requirements-frozen.txt"), "utf8").catch(() => null);
  const runtimeManifest = {
    schema_version: "0.1.0",
    venv_dir: VENV_DIR,
    node_version: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    python_frozen_requirements: frozenRequirements,
    per_candidate_runtime_versions: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.runtime_versions ?? null])),
    per_candidate_device: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { device: r.device ?? null, mps_attempted: r.mps_attempted ?? null, mps_failure_reason: r.mps_failure_reason ?? null }])),
    created_at: new Date().toISOString(),
  };
  await writeFile(path.join(OUT_DIR, "runtime-environment-manifest.v0.1.json"), JSON.stringify(runtimeManifest, null, 2));

  await writeFile(path.join(OUT_DIR, "three-model-comparison-report.v0.1.json"), JSON.stringify(results, null, 2));
  await writeFile(path.join(OUT_DIR, "three-model-comparison-report.v0.1.md"), renderMarkdownReport(results));

  const gateStatus = {
    schema_version: "0.1.0",
    gate: "REAL_EMBEDDING_CALIBRATION_READY_FOR_OWNER_CONFIGURATION",
    final_embedding_model_selected: false,
    production_index_modified: false,
    real_embedding_full_load_started: false,
    agent_ranking_performed: false,
    dev_gold_accessed: false,
    holdout_accessed: false,
    per_candidate_status: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, r.status])),
    evaluated_at: new Date().toISOString(),
  };
  await writeFile(path.join(OUT_DIR, "calibration-gate-status.v0.1.json"), JSON.stringify(gateStatus, null, 2));

  const cleanupReport = {
    schema_version: "0.1.0",
    servers_stopped: true,
    cache_dir: HF_CACHE_DIR,
    cache_preserved: true,
    cache_total_gb: finalCacheBytes / 1024 / 1024 / 1024,
    note: "task-owned cache is intentionally preserved (not deleted) -- only its size/path is reported. Other HuggingFace caches and Python environments were never touched.",
    created_at: new Date().toISOString(),
  };
  await writeFile(path.join(OUT_DIR, "cleanup-report.v0.1.json"), JSON.stringify(cleanupReport, null, 2));

  console.error(`[real-calibration] wrote reports to ${OUT_DIR}`);
  console.error(`[real-calibration] per-candidate status: ${JSON.stringify(gateStatus.per_candidate_status)}`);
}

function renderMarkdownReport(results) {
  const rows = Object.values(results).map((r) => {
    const q = r.stages?.stage3_full_calibration?.quality;
    const op = r.stages?.stage3_full_calibration?.operational;
    return `| ${r.frozen_candidate_id} | ${r.status} | ${r.device ?? "-"} | ${q ? q.self_match_recall_at_1.toFixed(3) : "-"} | ${q ? q.self_match_recall_at_5.toFixed(3) : "-"} | ${q ? q.self_match_recall_at_10.toFixed(3) : "-"} | ${q ? q.mrr.toFixed(3) : "-"} | ${q ? q.corp_code_filter.accuracy.toFixed(3) : "-"} | ${op ? op.latency_ms_p50 : "-"} | ${op ? op.throughput_items_per_sec?.toFixed(1) : "-"} | ${op ? op.peak_rss_mb?.toFixed(0) : "-"} |`;
  }).join("\n");
  return `# Turn P9.3 Real Local Embedding Calibration -- 3-Model Comparison

**This is a bounded calibration result, not a final model selection.**
final_embedding_model_selected=false, production_index_modified=false,
real_embedding_full_load_started=false, agent_ranking_performed=false,
dev_gold_accessed=false, holdout_accessed=false.

Same 98-item non-Gold dataset, same top-k, same cosine distance metric,
same metadata filter, same tie-break, same metric implementation, run
sequentially on the same hardware, one model in memory at a time.

| Candidate | Status | Device | Recall@1 | Recall@5 | Recall@10 | MRR | corp_code filter | Latency p50 (ms) | Throughput (items/s) | Peak RSS (MB) |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

## Failures (if any)

${Object.values(results).filter((r) => r.status !== "CALIBRATION_COMPLETED").map((r) => `- **${r.frozen_candidate_id}**: ${r.status} -- ${r.failure_reason ?? "(no reason recorded)"}`).join("\n") || "(none -- all 3 candidates completed)"}

## Provisional recommendation

See the per-model JSON results for full stage-by-stage detail (tokenizer
check, load smoke, bounded smoke, full 98-item calibration, repeatability).
Any recommendation drawn from this table is provisional and Owner-facing
only -- it is not a final model selection, and this Turn does not remove
any candidate from the registry or modify any production wiring.
`;
}

// Exported for Turn P9.3 unit tests (orchestration-logic tests only -- none
// of these require a real model or network access; see
// tests/agent-embedding-real-local-calibration.test.mjs).
export {
  waitForServerReady, stopServer, checkTokenLengths, repositoryToHfCacheDirName,
  buildDownloadManifestEntry, measureRepeatability, dirSizeBytes, renderMarkdownReport,
  CACHE_LIMIT_BYTES, CANDIDATE_ORDER, TASK_CACHE_ROOT, HF_CACHE_DIR, VENV_PYTHON, EXPECTED_DATASET_SHA256,
};

// Only run the real pipeline when this file is executed directly (`node
// scripts/run-real-embedding-calibration-v01.mjs`), never when imported by
// a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[real-calibration] FAILED: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
