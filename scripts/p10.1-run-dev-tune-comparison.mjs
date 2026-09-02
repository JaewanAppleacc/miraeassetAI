#!/usr/bin/env node
// Turn P10.1: final DEV_TUNE-101 chunking comparison. Reuses
// scripts/p10.1-build-evaluation-corpus.mjs's output (must be run first) --
// this script only READS work/p10.1-chunking-dev-tune/evaluation-corpus-
// manifest.v0.1.json and .raw-corpus-cache.v0.1.jsonl, it never re-reads
// Gold/DEV_CHECK/HOLDOUT files or the raw corpus directly.
//
// Query text is ALWAYS item.question alone -- expected_answer and
// evidence_span text are NEVER read by this script (dev-tune-metrics.mjs
// only ever touches document_id/source_locator structural fields).
//
// Dense is computed over a BM25 top-30-per-item candidate funnel (not the
// full per-strategy corpus -- corpus-wide unique embed_text counts reach
// ~78k for the hierarchical strategy, which would take many hours to
// embed for real; this reuses the same funnel-then-dense-rerank design
// already validated in Turn P10's E2 bounded smoke, just with a wider
// funnel since each item's own corp_code+doc_group candidate pool is much
// smaller here than P10's shared 45-document pool).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { computeItemMetrics, aggregateStrategyMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";
import { selectChunkingStrategy } from "../domain/agent-comparison/chunking-comparison/chunking-selection-rule.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const BM25_CANDIDATES_PER_ITEM = 30;
const RETURN_TOP_K = 20; // "query당 반환 개수는 top_k 이하로 강제" -- hard cap; 5/10 metrics are prefix slices of this
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_1_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

async function loadEvaluationCorpus() {
  const manifest = JSON.parse(await readFile(path.join(OUT_DIR, "evaluation-corpus-manifest.v0.1.json"), "utf8"));
  const cacheLines = (await readFile(path.join(OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean);
  const rawCache = cacheLines.map((line) => JSON.parse(line));
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { manifest, rawCache, goldItems };
}

function checkChunkInvariants(chunks, expectedCorpCode, documentId) {
  const violations = [];
  const idPattern = /^chunk_[0-9a-f]{24}$/;
  for (const chunk of chunks) {
    if (!idPattern.test(chunk.chunk_id)) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "MALFORMED_CHUNK_ID" });
    if (chunk.metadata.corp_code !== expectedCorpCode) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CORP_CODE_MISMATCH" });
    if (chunk.document_id !== documentId) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "DOCUMENT_ID_MISMATCH" });
    if (chunk.source_locator.startsWith("/") || chunk.source_locator.includes("..")) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "UNSAFE_SOURCE_LOCATOR" });
    for (const span of chunk.source_spans) {
      if (span.rel_path.startsWith("/") || span.rel_path.includes("..")) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "UNSAFE_SPAN_REL_PATH" });
    }
    if (chunk.raw_text.trim() === "") violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "EMPTY_CHUNK" });
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

function createEmbeddingCache(adapter) {
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    async embedManyCached(texts) {
      const uncached = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (uncached.length > 0) {
        const batchSize = 16;
        for (let start = 0; start < uncached.length; start += batchSize) {
          const batch = uncached.slice(start, start + batchSize);
          // eslint-disable-next-line no-await-in-loop
          const vectors = await adapter.embedDocuments(batch);
          batch.forEach((t, i) => cache.set(t, vectors[i]));
        }
        misses += uncached.length;
      }
      hits += texts.length - uncached.length;
      return texts.map((t) => cache.get(t));
    },
    async embedOneCached(text) {
      if (!cache.has(text)) {
        const [vector] = await adapter.embedDocuments([text]);
        cache.set(text, vector);
        misses += 1;
      } else hits += 1;
      return cache.get(text);
    },
    stats: () => ({ cache_hits: hits, cache_misses: misses, unique_texts_cached: cache.size }),
  };
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function runStrategy({ strategyConfig, rawCache, goldItems, adapter }) {
  const strategyStartedAt = Date.now();
  const { allChunks, violations } = chunkAllDocuments(strategyConfig, rawCache);
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));
  const contentShaSet = new Set(allChunks.map((c) => c.content_sha256));

  const embeddingCache = createEmbeddingCache(adapter);
  const perItemResults = [];
  const bm25LatenciesMs = [];
  const denseLatenciesMs = [];

  let itemIndex = 0;
  for (const item of goldItems) {
    itemIndex += 1;
    if (itemIndex % 20 === 0 || itemIndex === goldItems.length) {
      console.error(`[p10.1-comparison]   ${strategyConfig.chunking_config_id}: item ${itemIndex}/${goldItems.length} (embed cache: ${JSON.stringify(embeddingCache.stats())})`);
    }
    const corpCodes = new Set(item.corp_codes);
    const docGroups = new Set(item.doc_groups);
    // metadata filter applied BEFORE top_k / BM25 scoring
    const filteredChunks = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));

    if (filteredChunks.length === 0) {
      perItemResults.push({ question_id: item.question_id, skipped_no_candidates: true, ...computeItemMetrics(item, []) });
      continue;
    }

    const bm25StartedAt = Date.now();
    const bm25Index = buildBm25Index(filteredChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
    const bm25Ranked = bm25Search(bm25Index, item.question, { topK: BM25_CANDIDATES_PER_ITEM });
    bm25LatenciesMs.push(Date.now() - bm25StartedAt);

    const candidateIds = bm25Ranked.map((r) => r.id);
    const denseStartedAt = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const queryVector = await embeddingCache.embedOneCached(item.question);
    // eslint-disable-next-line no-await-in-loop
    const candidateVectors = await embeddingCache.embedManyCached(candidateIds.map((id) => chunkById.get(id).embed_text));
    const denseScored = candidateIds.map((id, index) => ({ id, score: cosineSimilarity(queryVector, candidateVectors[index]) }));
    denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    denseLatenciesMs.push(Date.now() - denseStartedAt);

    const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { topK: RETURN_TOP_K });
    const rrfChunks = rrfRanked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));

    const itemMetrics = computeItemMetrics(item, rrfChunks);
    perItemResults.push({ ...itemMetrics, skipped_no_candidates: false, candidate_pool_size: filteredChunks.length, returned_count: rrfChunks.length });
  }

  const aggregate = aggregateStrategyMetrics(perItemResults);
  const embedTextsForStorage = new Set(searchEligible.map((c) => c.embed_text));

  return {
    chunking_config_id: strategyConfig.chunking_config_id,
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    unique_content_sha256: contentShaSet.size,
    total_unique_embed_texts_corpus_wide: embedTextsForStorage.size,
    total_unique_embed_texts: embeddingCache.stats().unique_texts_cached, // ACTUALLY embedded this run (BM25-funneled), used by the selection rule's cost tie-break
    embedding_cache: embeddingCache.stats(),
    locator_provenance_violations: violations.length,
    locator_provenance_violation_samples: violations.slice(0, 5),
    ...aggregate,
    latency_ms: {
      bm25_p50: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.5),
      bm25_p95: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.95),
      dense_p50: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.5),
      dense_p95: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.95),
    },
    latency_dense_p50_ms: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.5),
    peak_rss_bytes: process.memoryUsage().rss,
    estimated_storage_bytes: embedTextsForStorage.size * P10_EMBEDDING_CANDIDATE.embedding_dimension * 4,
    wall_time_ms: Date.now() - strategyStartedAt,
    per_item_results: perItemResults,
  };
}

function waitForServerReady(child, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("timed out waiting for LISTENING line")); } }, timeoutMs);
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
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  if (!existsSync(path.join(OUT_DIR, "evaluation-corpus-manifest.v0.1.json"))) {
    throw new Error("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first");
  }
  console.error("[p10.1-comparison] loading evaluation corpus (gate already validated by the build step)...");
  const { rawCache, goldItems } = await loadEvaluationCorpus();
  console.error(`[p10.1-comparison] ${rawCache.length} documents, ${goldItems.length} DEV_TUNE items`);

  if (!existsSync(VENV_PYTHON)) throw new Error(`FAIL-CLOSED: task-owned venv not found at ${VENV_PYTHON}`);

  console.error("[p10.1-comparison] starting local BGE-M3 server (reusing task-owned model cache, no redownload)...");
  const serverChild = spawn(VENV_PYTHON, [
    path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
    "--repository-id", P10_EMBEDDING_CANDIDATE.repository_id,
    "--revision", P10_EMBEDDING_CANDIDATE.immutable_revision,
    "--cache-dir", HF_CACHE_DIR,
    "--expected-dimension", String(P10_EMBEDDING_CANDIDATE.embedding_dimension),
    "--expected-max-input-length", "8192",
    "--port", "0",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  const results = [];
  try {
    const port = await waitForServerReady(serverChild);
    const baseUrl = `http://127.0.0.1:${port}`;
    const infoResponse = await fetch(`${baseUrl}/info`).then((r) => r.json());
    if (infoResponse.repository_id !== P10_EMBEDDING_CANDIDATE.repository_id || infoResponse.model_revision !== P10_EMBEDDING_CANDIDATE.immutable_revision) {
      throw new Error(`server identity mismatch: ${JSON.stringify(infoResponse)}`);
    }
    console.error(`[p10.1-comparison] server ready on ${baseUrl}, device=${infoResponse.device}`);

    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: P10_EMBEDDING_CANDIDATE.repository_id,
      revision: P10_EMBEDDING_CANDIDATE.immutable_revision, dimension: P10_EMBEDDING_CANDIDATE.embedding_dimension,
      endpoint_url: `${baseUrl}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 120000,
    });

    await mkdir(OUT_DIR, { recursive: true });
    const checkpointPath = path.join(OUT_DIR, "strategy-metrics.IN_PROGRESS.v0.1.json");
    for (const strategyConfig of P10_STRATEGIES) {
      console.error(`[p10.1-comparison] strategy ${strategyConfig.chunking_config_id}: chunking + BM25/Dense/RRF over ${goldItems.length} items...`);
      // eslint-disable-next-line no-await-in-loop
      const result = await runStrategy({ strategyConfig, rawCache, goldItems, adapter });
      console.error(`[p10.1-comparison] strategy ${strategyConfig.chunking_config_id}: done in ${result.wall_time_ms}ms, macro_evidence_recall@10=${result.macro_evidence_recall_at_k[10]}, violations=${result.locator_provenance_violations}`);
      results.push(result);
      // eslint-disable-next-line no-await-in-loop
      await writeFile(checkpointPath, `${JSON.stringify({ completed: results.map((r) => r.chunking_config_id) }, null, 2)}\n`);
    }
  } finally {
    await stopServer(serverChild);
  }

  // Strip per-item raw results (which reference expected_answerability/
  // question_type but never question/answer text) out of the aggregate
  // strategy-metrics file -- they go to their OWN per-item-results.v0.1.jsonl
  // instead, per this Turn's output layout.
  const perItemLines = [];
  const strategyMetricsForFile = results.map((r) => {
    const { per_item_results: perItem, ...rest } = r;
    for (const item of perItem) perItemLines.push(JSON.stringify({ chunking_config_id: r.chunking_config_id, ...item }));
    return rest;
  });

  const selection = selectChunkingStrategy(
    results.map((r) => ({
      chunking_config_id: r.chunking_config_id,
      locator_provenance_violations: r.locator_provenance_violations,
      macro_evidence_recall_at_k: r.macro_evidence_recall_at_k,
      macro_mrr: r.macro_mrr,
      total_unique_embed_texts: r.total_unique_embed_texts,
      latency_dense_p50_ms: r.latency_dense_p50_ms,
      total_chunks: r.total_chunks,
    })),
  );

  await writeFile(path.join(OUT_DIR, "strategy-metrics.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", generated_at: new Date().toISOString(), bm25_candidates_per_item: BM25_CANDIDATES_PER_ITEM, return_top_k: RETURN_TOP_K, embedding_candidate: P10_EMBEDDING_CANDIDATE, strategies: strategyMetricsForFile }, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "per-item-results.v0.1.jsonl"), `${perItemLines.join("\n")}\n`);
  await writeFile(path.join(OUT_DIR, "chunking-selection-report.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", generated_at: new Date().toISOString(), ...selection }, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "OK",
    selection_status: selection.status,
    winner: selection.winner,
    strategies: strategyMetricsForFile.map((r) => ({ chunking_config_id: r.chunking_config_id, macro_evidence_recall_at_10: r.macro_evidence_recall_at_k[10], macro_mrr: r.macro_mrr, violations: r.locator_provenance_violations })),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.1-comparison] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
