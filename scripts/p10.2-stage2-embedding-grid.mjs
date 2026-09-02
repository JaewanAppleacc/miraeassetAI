#!/usr/bin/env node
// Turn P10.2 / Stage 2: exactly 6 real combinations (Fixed/Section-Flat x
// KURE-v1/BGE-M3/PIXIE-Rune-v1.5) over the SAME DEV_TUNE-101 items and the
// SAME 372-document evaluation corpus P10.1/P10.1.1 already built and
// validated (reused via scripts/p10.1-build-evaluation-corpus.mjs,
// unmodified, must be run first).
//
// Model loop is OUTER (one model loaded into memory at a time, one server
// process per model, task-owned venv/HF cache reused -- no redownload);
// chunking loop is INNER, reusing the one loaded server for both Fixed and
// Section-Flat before that model is torn down. Both chunkings are built
// ONCE up front (chunking is model-independent) and reused across all 3
// models.
//
// Query text is always item.question alone, with each candidate's OWN
// verified query_prefix/document_prefix applied via prepareTextForMode()
// (the single chokepoint that makes a prefix/role mixup structurally
// impossible) -- expected_answer/evidence_span text is never read.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { computeItemMetrics, aggregateStrategyMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";
import { createModelScopedEmbeddingCache } from "../domain/agent-comparison/chunking-comparison/model-scoped-embedding-cache.mjs";
import { getFrozenCandidateById, prepareTextForMode } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const P101_OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const OUT_DIR = path.join(ROOT, "work", "p10.2-chunking-embedding-grid");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const BM25_TOP_K = 100; // same funnel for every combination
const RETURN_TOP_K = 20; // same dense/RRF top_k for every combination
const RRF_K_CONSTANT = 60; // reciprocal-rank-fusion.mjs's own fixed constant, unchanged
const DETERMINISM_SAMPLE_SIZE = 10;
const MODEL_ORDER = Object.freeze(["kure_v1", "bge_m3", "pixie_rune"]); // fixed order, never re-ordered based on results
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_2_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const EMBED_MAX_ATTEMPTS = 4;
const EMBED_RETRY_DELAYS_MS = [2000, 5000, 10000];
let retryCountTotal = 0;
let failureCountTotal = 0;

async function embedWithRetry(adapter, texts) {
  let lastError;
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await adapter.embedDocuments(texts);
    } catch (error) {
      lastError = error;
      const retryable = error?.code === "EMBEDDING_CALL_TIMEOUT" || error?.code === "EMBEDDING_CALL_HTTP_ERROR" || error?.code === "EMBEDDING_CALL_UNKNOWN_ERROR";
      if (!retryable || attempt === EMBED_MAX_ATTEMPTS) { failureCountTotal += 1; throw error; }
      retryCountTotal += 1;
      const delay = EMBED_RETRY_DELAYS_MS[attempt - 1] ?? EMBED_RETRY_DELAYS_MS.at(-1);
      console.error(`[p10.2-stage2]     embedding call failed (attempt ${attempt}/${EMBED_MAX_ATTEMPTS}, code=${error?.code}), retrying in ${delay}ms...`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
  throw lastError;
}

function checkChunkInvariants(chunks, expectedCorpCode, documentId) {
  const violations = [];
  const idPattern = /^chunk_[0-9a-f]{24}$/;
  for (const chunk of chunks) {
    if (!idPattern.test(chunk.chunk_id)) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "MALFORMED_CHUNK_ID" });
    if (chunk.metadata.corp_code !== expectedCorpCode) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CORP_CODE_MISMATCH" });
    if (chunk.document_id !== documentId) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "DOCUMENT_ID_MISMATCH" });
    if (sha256Hex(chunk.raw_text) !== chunk.content_sha256) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CONTENT_SHA_MISMATCH" });
  }
  return violations;
}

function chunkAllDocuments(strategyConfig, rawCache) {
  const allChunks = [];
  const violations = [];
  for (const entry of rawCache) {
    const chunks = chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE);
    allChunks.push(...chunks);
    violations.push(...checkChunkInvariants(chunks, entry.metadata.corp_code, entry.document_id));
  }
  return { allChunks, violations };
}

async function embedRoleCached(cache, adapter, candidate, chunkingConfigId, role, texts) {
  const preparedTexts = texts.map((t) => prepareTextForMode(candidate, t, role));
  const results = new Array(texts.length);
  const missingIndices = [];
  const missingTexts = [];
  texts.forEach((text, i) => {
    const keyParts = { repositoryId: candidate.repository_id, revision: candidate.immutable_revision, dimension: candidate.embedding_dimension, role, prefix: role === "query" ? candidate.query_prefix : candidate.document_prefix, text, chunkingConfigId };
    if (cache.has(keyParts)) { results[i] = cache.get(keyParts); cache.recordHit(); }
    else { missingIndices.push(i); missingTexts.push(preparedTexts[i]); }
  });
  if (missingTexts.length > 0) {
    const batchSize = 8;
    for (let start = 0; start < missingTexts.length; start += batchSize) {
      const batchPrepared = missingTexts.slice(start, start + batchSize);
      const batchOriginalIdx = missingIndices.slice(start, start + batchSize);
      // eslint-disable-next-line no-await-in-loop
      const vectors = await embedWithRetry(adapter, batchPrepared);
      batchOriginalIdx.forEach((origIdx, j) => {
        results[origIdx] = vectors[j];
        const keyParts = { repositoryId: candidate.repository_id, revision: candidate.immutable_revision, dimension: candidate.embedding_dimension, role, prefix: role === "query" ? candidate.query_prefix : candidate.document_prefix, text: texts[origIdx], chunkingConfigId };
        cache.set(keyParts, vectors[j]);
        cache.recordMiss();
      });
    }
  }
  return results;
}

async function runCombination({ candidate, strategyConfig, rawCache, goldItems, cache, adapter }) {
  const { allChunks, violations } = chunkAllDocuments(strategyConfig, rawCache);
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));

  const perItemResults = [];
  const bm25Ms = []; const denseMs = [];
  let itemIndex = 0;
  for (const item of goldItems) {
    itemIndex += 1;
    if (itemIndex % 25 === 0 || itemIndex === goldItems.length) console.error(`[p10.2-stage2]     item ${itemIndex}/${goldItems.length} (${JSON.stringify(cache.stats())})`);
    const corpCodes = new Set(item.corp_codes);
    const docGroups = new Set(item.doc_groups);
    const filtered = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
    if (filtered.length === 0) {
      perItemResults.push({ question_id: item.question_id, skipped_no_candidates: true, ...computeItemMetrics(item, []), bm25_only: computeItemMetrics(item, []), dense_only: computeItemMetrics(item, []) });
      continue;
    }

    const bm25StartedAt = Date.now();
    const bm25Index = buildBm25Index(filtered.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
    const bm25Ranked = bm25Search(bm25Index, item.question, { topK: BM25_TOP_K });
    bm25Ms.push(Date.now() - bm25StartedAt);

    const denseStartedAt = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const [queryVector] = await embedRoleCached(cache, adapter, candidate, strategyConfig.chunking_config_id, "query", [item.question]);
    const candidateTexts = bm25Ranked.map((r) => chunkById.get(r.id).embed_text);
    // eslint-disable-next-line no-await-in-loop
    const candidateVectors = await embedRoleCached(cache, adapter, candidate, strategyConfig.chunking_config_id, "document", candidateTexts);
    denseMs.push(Date.now() - denseStartedAt);

    const denseScored = bm25Ranked.map((r, i) => ({ id: r.id, score: cosineSimilarity(queryVector, candidateVectors[i]) }));
    denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { k: RRF_K_CONSTANT, topK: RETURN_TOP_K });

    const rrfChunks = rrfRanked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    const bm25Chunks = bm25Ranked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    const denseChunks = denseScored.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));

    perItemResults.push({
      question_id: item.question_id,
      ...computeItemMetrics(item, rrfChunks),
      bm25_only: computeItemMetrics(item, bm25Chunks),
      dense_only: computeItemMetrics(item, denseChunks),
      skipped_no_candidates: false,
      candidate_pool_size: filtered.length,
    });
  }

  const aggregate = aggregateStrategyMetrics(perItemResults);
  const bm25OnlyAggregate = aggregateStrategyMetrics(perItemResults.map((r) => ({ question_id: r.question_id, ...r.bm25_only })));
  const denseOnlyAggregate = aggregateStrategyMetrics(perItemResults.map((r) => ({ question_id: r.question_id, ...r.dense_only })));

  return {
    frozen_candidate_id: candidate.frozen_candidate_id,
    chunking_config_id: strategyConfig.chunking_config_id,
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    locator_provenance_violations: violations.length,
    rrf: aggregate,
    bm25_only: bm25OnlyAggregate,
    dense_only: denseOnlyAggregate,
    latency_ms: {
      bm25_p50: percentile([...bm25Ms].sort((a, b) => a - b), 0.5), bm25_p95: percentile([...bm25Ms].sort((a, b) => a - b), 0.95), bm25_max: bm25Ms.length ? Math.max(...bm25Ms) : null,
      dense_p50: percentile([...denseMs].sort((a, b) => a - b), 0.5), dense_p95: percentile([...denseMs].sort((a, b) => a - b), 0.95), dense_max: denseMs.length ? Math.max(...denseMs) : null,
    },
    throughput_items_per_sec: denseMs.length > 0 ? 1000 / (denseMs.reduce((a, b) => a + b, 0) / denseMs.length) : null,
    peak_rss_bytes: process.memoryUsage().rss,
    per_item_results: perItemResults,
  };
}

function waitForServerReady(child, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let buffer = ""; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("timed out")); } }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/LISTENING 127\.0\.0\.1:(\d+)/);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on("exit", (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited early with code ${code}`)); } });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => { const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); });
}

async function main() {
  if (!existsSync(path.join(P101_OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"))) throw new Error("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first");
  const rawCache = (await readFile(path.join(P101_OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  console.error(`[p10.2-stage2] ${rawCache.length} documents, ${goldItems.length} DEV_TUNE items (reused from P10.1)`);

  const strategies = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
  if (strategies.length !== 2) throw new Error(`FAIL-CLOSED: expected exactly 2 non-hierarchical strategies, got ${strategies.length}`);
  console.error(`[p10.2-stage2] chunking strategies: ${strategies.map((s) => s.chunking_config_id).join(", ")}`);

  const candidates = MODEL_ORDER.map((id) => getFrozenCandidateById(id));
  if (candidates.length !== 3) throw new Error(`FAIL-CLOSED: expected exactly 3 frozen candidates, got ${candidates.length}`);
  for (const c of candidates) {
    if (c.competition_status !== "ELIGIBLE_FOR_BOUNDED_CALIBRATION") throw new Error(`FAIL-CLOSED: candidate ${c.frozen_candidate_id} is not ELIGIBLE_FOR_BOUNDED_CALIBRATION`);
  }
  console.error(`[p10.2-stage2] embedding candidates (exact pins): ${candidates.map((c) => `${c.frozen_candidate_id}=${c.repository_id}@${c.immutable_revision}`).join(", ")}`);

  if (!existsSync(VENV_PYTHON)) throw new Error(`FAIL-CLOSED: task-owned venv not found at ${VENV_PYTHON}`);

  await mkdir(OUT_DIR, { recursive: true });
  const cache = createModelScopedEmbeddingCache();
  const combinationResults = [];
  const checkpointPath = path.join(OUT_DIR, "stage2-grid.IN_PROGRESS.v0.1.json");

  for (const candidate of candidates) {
    console.error(`\n[p10.2-stage2] === ${candidate.frozen_candidate_id} (${candidate.repository_id}@${candidate.immutable_revision}) ===`);
    const serverChild = spawn(VENV_PYTHON, [
      path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
      "--repository-id", candidate.repository_id,
      "--revision", candidate.immutable_revision,
      "--cache-dir", HF_CACHE_DIR,
      "--expected-dimension", String(candidate.embedding_dimension),
      "--expected-max-input-length", String(candidate.max_input_length),
      "--port", "0",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    try {
      const port = await waitForServerReady(serverChild);
      const infoResponse = await fetch(`http://127.0.0.1:${port}/info`).then((r) => r.json());
      if (infoResponse.repository_id !== candidate.repository_id || infoResponse.model_revision !== candidate.immutable_revision || infoResponse.embedding_dimension !== candidate.embedding_dimension) {
        throw new Error(`FAIL-CLOSED: server identity mismatch for ${candidate.frozen_candidate_id}: ${JSON.stringify(infoResponse)}`);
      }
      // "CPU fallback을 조용히 수행하지 않는다" -- a non-MPS device is a hard,
      // loud failure, never a silent continuation.
      if (infoResponse.device !== "mps") {
        throw new Error(`FAIL-CLOSED: MPS device policy violated for ${candidate.frozen_candidate_id} -- server reports device="${infoResponse.device}" (mps_attempted=${infoResponse.mps_attempted}, mps_failure_reason=${infoResponse.mps_failure_reason}). Refusing a silent CPU fallback.`);
      }
      console.error(`[p10.2-stage2] server ready, device=${infoResponse.device}`);

      const adapter = createEmbeddingAdapter({
        schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: candidate.repository_id,
        revision: candidate.immutable_revision, dimension: candidate.embedding_dimension,
        endpoint_url: `http://127.0.0.1:${port}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 180000,
      });

      for (const strategyConfig of strategies) {
        console.error(`[p10.2-stage2]   combo ${candidate.frozen_candidate_id} x ${strategyConfig.chunking_config_id}...`);
        const startedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const result = await runCombination({ candidate, strategyConfig, rawCache, goldItems, cache, adapter });
        result.wall_time_ms = Date.now() - startedAt;
        console.error(`[p10.2-stage2]   combo done in ${result.wall_time_ms}ms, rrf.recall@10=${result.rrf.macro_evidence_recall_at_k[10]}, violations=${result.locator_provenance_violations}`);
        combinationResults.push(result);
        // eslint-disable-next-line no-await-in-loop
        await writeFile(checkpointPath, `${JSON.stringify({ completed: combinationResults.map((r) => `${r.frozen_candidate_id}x${r.chunking_config_id}`) }, null, 2)}\n`);
      }
    } finally {
      await stopServer(serverChild);
    }
  }

  if (combinationResults.length !== 6) {
    console.error(`[p10.2-stage2] FAIL-CLOSED: expected exactly 6 combinations, got ${combinationResults.length} -- refusing to select a final winner`);
  }

  const perItemLines = [];
  const combinationSummaries = combinationResults.map((r) => {
    const { per_item_results: perItem, ...rest } = r;
    for (const item of perItem) perItemLines.push(JSON.stringify({ frozen_candidate_id: r.frozen_candidate_id, chunking_config_id: r.chunking_config_id, ...item }));
    return { ...rest, cache_stats_cumulative: cache.stats() };
  });

  await writeFile(path.join(OUT_DIR, "stage2-grid-results.v0.1.json"), `${JSON.stringify({
    schema_version: "0.1.0", generated_at: new Date().toISOString(),
    bm25_top_k: BM25_TOP_K, return_top_k: RETURN_TOP_K, rrf_k_constant: RRF_K_CONSTANT,
    embedding_candidates: candidates,
    retry_count_total: retryCountTotal, failure_count_total: failureCountTotal,
    combinations_completed: combinationResults.length,
    combinations: combinationSummaries,
    final_embedding_cache_stats: cache.stats(),
  }, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "stage2-per-item-results.v0.1.jsonl"), `${perItemLines.join("\n")}\n`);

  console.log(JSON.stringify({
    status: combinationResults.length === 6 ? "OK" : "INCOMPLETE",
    combinations_completed: combinationResults.length,
    summary: combinationResults.map((r) => ({ combo: `${r.frozen_candidate_id}x${r.chunking_config_id}`, recall_at_10: r.rrf.macro_evidence_recall_at_k[10], mrr: r.rrf.macro_mrr, violations: r.locator_provenance_violations })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.2-stage2] FAILED (fail-closed):", error.stack ?? error.message);
  process.exitCode = 1;
});
