#!/usr/bin/env node
// Turn P10 / E2: bounded retrieval smoke across the 3 chunking strategies,
// using the EXISTING 98-item v0.20-r3 VERIFIED-evidence calibration set
// (domain/agent-comparison/embedding-calibration/dataset.mjs, unmodified)
// and the REAL, pinned local BGE-M3 server this repo already built for
// Turn P9 (scripts/embedding-calibration-real/local_embedding_server.py,
// reusing its task-owned venv/model cache -- never re-downloaded here).
//
// THIS IS A WIRING/REGRESSION SMOKE, NOT A CHUNKING-QUALITY MEASUREMENT:
// the same 98 items were also used to SELECT which documents this
// worktree's DocumentIR sample even contains evidence for (self-selection
// risk, matching this Turn's own brief). No final_selection/winner is ever
// written by this script.
//
// BOUNDING STRATEGY (never "전량 embedding"): BM25 is run first, over the
// corp_code-filtered candidate pool, per query (metadata filter applied
// BEFORE top_k, matching domain/retrieval/README.md's contract). Only the
// UNION of each query's own top-50 BM25 candidates is ever sent to the
// embedding server -- never the full chunk index. This mirrors this
// repo's own documented BM25-first funnel (domain/chunking/
// FULL_CORPUS_BUDGET_DECISION.md's "다음 실험 순서").
//
// NEVER: calls HCX, writes to PostgreSQL, touches DEV_TUNE/DEV_CHECK/
// HOLDOUT, or downloads a 4th model.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE, P10_EXPERIMENT_ID, P10_COMPARISON_CONDITIONS } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { collectResolvableBundleCorpus, resolvableDocumentEntries, P10_BUNDLE_OPTIONS_FACTORY } from "../domain/agent-comparison/chunking-comparison/resolvable-bundle-corpus.mjs";
import { adaptCanonicalRecordToChunkerInput } from "../domain/agent-comparison/chunking-comparison/b-canonical-to-chunker-input.mjs";
import { collectEvidenceNodeGrounding } from "../domain/agent-comparison/chunking-comparison/evidence-node-grounding.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { collectVerifiedCalibrationCandidates, selectCalibrationDataset, buildCalibrationDatasetManifest } from "../domain/agent-comparison/embedding-calibration/dataset.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { cosineSimilarity } from "../domain/agent-comparison/embedding-calibration/metrics.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10-chunking-comparison");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const SAMPLE_SALT = "turn-p9-fake-smoke-v01";
const EXPECTED_DATASET_SHA256 = "9848b30c8704b647eeab6820cd0f89473f2d659da9aae72c5a4eb9f58f0b28b0";
const BM25_CANDIDATES_PER_QUERY = 20;
const TOP_K_VALUES = P10_COMPARISON_CONDITIONS.top_k_values;

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
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

async function embedAllBatched(adapter, texts, { batchSize = 16 } = {}) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const batchVectors = await adapter.embedDocuments(batch);
    vectors.push(...batchVectors);
  }
  return vectors;
}

// Turn P10 boundedness fix: many BM25 candidate chunks recur across
// queries sharing the same corp_code -- without a cache, each recurrence
// re-embeds the identical text, which is what made the first, uncached
// run of this script take >29 minutes per strategy with no completion.
// Cache key = exact embed_text (content-addressed, per strategy run) --
// never persisted across strategies (chunk sets differ), never persisted
// to disk (in-memory only, for this one process run).
function createEmbeddingCache(adapter) {
  const cache = new Map(); // text -> vector
  let cacheHits = 0;
  let cacheMisses = 0;
  return {
    async embedManyCached(texts) {
      const uncached = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (uncached.length > 0) {
        const vectors = await embedAllBatched(adapter, uncached);
        uncached.forEach((text, index) => cache.set(text, vectors[index]));
        cacheMisses += uncached.length;
      }
      cacheHits += texts.length - uncached.length;
      return texts.map((t) => cache.get(t));
    },
    async embedOneCached(text) {
      if (!cache.has(text)) {
        const [vector] = await adapter.embedDocuments([text]);
        cache.set(text, vector);
        cacheMisses += 1;
      } else {
        cacheHits += 1;
      }
      return cache.get(text);
    },
    stats: () => ({ cache_hits: cacheHits, cache_misses: cacheMisses, unique_texts_cached: cache.size }),
  };
}

function isRelevant(chunk, item, grounding) {
  if (chunk.document_id !== item.sourceDocumentId) return false;
  const ground = grounding.get(item.evidenceId);
  if (ground?.sourceNodeId) return chunk.source_node_ids.includes(ground.sourceNodeId);
  return true; // document-level fallback -- only reached when no node-level grounding is resolvable for this evidence_id
}

function computeRankMetrics(rankedIds, chunkById, item, grounding) {
  const relevantAt = (k) => rankedIds.slice(0, k).some((id) => isRelevant(chunkById.get(id), item, grounding));
  let reciprocalRank = 0;
  for (const [index, id] of rankedIds.entries()) {
    if (isRelevant(chunkById.get(id), item, grounding)) { reciprocalRank = 1 / (index + 1); break; }
  }
  return {
    recall_at_1: relevantAt(1), recall_at_5: relevantAt(5), recall_at_10: relevantAt(10), recall_at_20: relevantAt(20),
    reciprocal_rank: reciprocalRank,
  };
}

function aggregateBoolean(values) {
  return values.length > 0 ? values.filter(Boolean).length / values.length : null;
}

async function runStrategy({ strategyConfig, boundedEntries, provenance, datasetItems, grounding, adapter }) {
  const embeddingCache = createEmbeddingCache(adapter);
  const allChunks = [];
  for (const entry of boundedEntries) {
    const { record, document } = adaptCanonicalRecordToChunkerInput(entry.canonicalRecord, { corpCode: entry.corpCode, corpName: entry.corpName, listedName: entry.listedName });
    allChunks.push(...chunkDocument(record, document, strategyConfig, provenance));
  }
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));

  const metricsByMethod = { bm25: [], dense: [], rrf: [] };
  const corpFilterAccuracySamples = [];
  const bm25LatenciesMs = [];
  const denseLatenciesMs = [];
  let embeddedChunkCount = 0;
  const uniqueEmbedTextsSeen = new Set();

  let queryIndex = 0;
  for (const item of datasetItems) {
    queryIndex += 1;
    if (queryIndex % 10 === 0 || queryIndex === datasetItems.length) {
      console.error(`[p10-bounded-smoke]   ${strategyConfig.chunking_config_id}: query ${queryIndex}/${datasetItems.length} (cache: ${JSON.stringify(embeddingCache.stats())})`);
    }
    // corp_code metadata filter applied BEFORE top_k / BM25 scoring.
    const filteredChunks = searchEligible.filter((c) => c.metadata.corp_code === item.corpCode);
    if (filteredChunks.length === 0) continue; // no candidate chunks for this query under this strategy+corp filter -- skip, not scored as a false negative

    const bm25StartedAt = Date.now();
    const bm25Index = buildBm25Index(filteredChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
    const bm25Ranked = bm25Search(bm25Index, item.textContent, { topK: BM25_CANDIDATES_PER_QUERY });
    bm25LatenciesMs.push(Date.now() - bm25StartedAt);

    corpFilterAccuracySamples.push(bm25Ranked.every(({ id }) => chunkById.get(id).metadata.corp_code === item.corpCode));

    const candidateIds = bm25Ranked.map((r) => r.id);
    for (const id of candidateIds) uniqueEmbedTextsSeen.add(chunkById.get(id).embed_text);

    const denseStartedAt = Date.now();
    const queryVector = await embeddingCache.embedOneCached(item.textContent);
    const candidateVectors = await embeddingCache.embedManyCached(candidateIds.map((id) => chunkById.get(id).embed_text));
    embeddedChunkCount += candidateIds.length;
    const denseScored = candidateIds.map((id, index) => ({ id, score: cosineSimilarity(queryVector, candidateVectors[index]) }));
    denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    denseLatenciesMs.push(Date.now() - denseStartedAt);

    const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { topK: BM25_CANDIDATES_PER_QUERY });

    metricsByMethod.bm25.push(computeRankMetrics(bm25Ranked.map((r) => r.id), chunkById, item, grounding));
    metricsByMethod.dense.push(computeRankMetrics(denseScored.map((r) => r.id), chunkById, item, grounding));
    metricsByMethod.rrf.push(computeRankMetrics(rrfRanked.map((r) => r.id), chunkById, item, grounding));
  }

  function summarize(methodResults) {
    return {
      recall_at_1: aggregateBoolean(methodResults.map((r) => r.recall_at_1)),
      recall_at_5: aggregateBoolean(methodResults.map((r) => r.recall_at_5)),
      recall_at_10: aggregateBoolean(methodResults.map((r) => r.recall_at_10)),
      recall_at_20: aggregateBoolean(methodResults.map((r) => r.recall_at_20)),
      mrr: methodResults.length > 0 ? methodResults.reduce((sum, r) => sum + r.reciprocal_rank, 0) / methodResults.length : null,
      queries_scored: methodResults.length,
    };
  }

  return {
    chunking_config_id: strategyConfig.chunking_config_id,
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    queries_evaluated: metricsByMethod.bm25.length,
    queries_skipped_no_candidates: datasetItems.length - metricsByMethod.bm25.length,
    bm25: summarize(metricsByMethod.bm25),
    dense: summarize(metricsByMethod.dense),
    rrf: summarize(metricsByMethod.rrf),
    corp_code_filter_accuracy: aggregateBoolean(corpFilterAccuracySamples),
    latency_ms: {
      bm25_p50: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.5),
      bm25_p95: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.95),
      dense_p50: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.5),
      dense_p95: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.95),
    },
    index_size: {
      full_search_eligible_chunk_count: searchEligible.length,
      full_potential_index_bytes: searchEligible.length * P10_EMBEDDING_CANDIDATE.embedding_dimension * 4,
      smoke_embedded_chunk_calls: embeddedChunkCount,
      smoke_unique_embed_texts: uniqueEmbedTextsSeen.size,
      note: `full_potential_index_bytes is a hypothetical estimate if every search-eligible chunk were embedded; smoke_embedded_chunk_calls is what this bounded smoke would send with NO cache (BM25 top-${BM25_CANDIDATES_PER_QUERY}-per-query candidates only); embedding_cache below shows how many of those were actually deduplicated into real HTTP calls`,
    },
    embedding_cache: embeddingCache.stats(),
  };
}

async function main() {
  console.error("[p10-bounded-smoke] reconstructing the 98-item v0.20-r3 calibration dataset (Gold-blind, dataset.mjs unmodified)...");
  const bundleOptions = P10_BUNDLE_OPTIONS_FACTORY(ROOT);
  const candidates = await collectVerifiedCalibrationCandidates(bundleOptions);
  const datasetItems = selectCalibrationDataset({ candidates, maximumItemCount: Math.min(200, candidates.length), sampleSalt: SAMPLE_SALT });
  const datasetManifest = buildCalibrationDatasetManifest({ datasetId: "calibration_dataset_fake_smoke_v01", sampleSalt: SAMPLE_SALT, datasetItems, candidatePoolSize: candidates.length });
  if (datasetManifest.calibration_dataset_sha256 !== EXPECTED_DATASET_SHA256) {
    console.error(`[p10-bounded-smoke] FAIL-CLOSED: dataset drift detected -- expected ${EXPECTED_DATASET_SHA256}, got ${datasetManifest.calibration_dataset_sha256}`);
    process.exitCode = 1;
    return;
  }
  console.error(`[p10-bounded-smoke] dataset confirmed: ${datasetItems.length} items, sha256 matches pinned value`);

  const corpus = await collectResolvableBundleCorpus(bundleOptions);
  const entries = resolvableDocumentEntries(corpus);
  const entryByDocId = new Map(entries.map((e) => [e.documentId, e]));
  const boundedDocIds = new Set(datasetItems.map((i) => i.sourceDocumentId).filter((id) => entryByDocId.has(id)));
  const boundedEntries = [...boundedDocIds].map((id) => entryByDocId.get(id)).sort((a, b) => a.documentId.localeCompare(b.documentId));
  const grounding = await collectEvidenceNodeGrounding(bundleOptions);

  console.error(`[p10-bounded-smoke] bounded document universe: ${boundedEntries.length} document(s) (documents referenced by the 98 calibration items, intersected with the resolvable corpus)`);

  if (!existsSync(VENV_PYTHON)) {
    console.error(`[p10-bounded-smoke] FAIL-CLOSED: task-owned venv not found at ${VENV_PYTHON} -- run scripts/run-real-embedding-calibration-v01.mjs once first (it builds this venv), or this Turn cannot make real embedding calls`);
    process.exitCode = 1;
    return;
  }

  const provenance = { targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) };

  console.error("[p10-bounded-smoke] starting local BGE-M3 server (reusing task-owned model cache)...");
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
    console.error(`[p10-bounded-smoke] server ready on ${baseUrl}, device=${infoResponse.device}`);

    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: P10_EMBEDDING_CANDIDATE.repository_id,
      revision: P10_EMBEDDING_CANDIDATE.immutable_revision, dimension: P10_EMBEDDING_CANDIDATE.embedding_dimension,
      endpoint_url: `${baseUrl}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 120000,
    });

    await mkdir(OUT_DIR, { recursive: true });
    const checkpointPath = path.join(OUT_DIR, "bounded-retrieval-smoke.IN_PROGRESS.v01.json");
    for (const strategyConfig of P10_STRATEGIES) {
      console.error(`[p10-bounded-smoke] strategy ${strategyConfig.chunking_config_id}: chunking + BM25-funneled dense/RRF over ${datasetItems.length} queries...`);
      const strategyStartedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const result = await runStrategy({ strategyConfig, boundedEntries, provenance, datasetItems, grounding, adapter });
      result.wall_time_ms = Date.now() - strategyStartedAt;
      console.error(`[p10-bounded-smoke] strategy ${strategyConfig.chunking_config_id}: done in ${result.wall_time_ms}ms, rrf.recall_at_10=${result.rrf.recall_at_10}`);
      results.push(result);
      // Incremental checkpoint: a kill/timeout after this point never loses
      // an already-completed strategy's results. Overwritten each strategy.
      // eslint-disable-next-line no-await-in-loop
      await writeFile(checkpointPath, `${JSON.stringify({ completed_strategies: results.map((r) => r.chunking_config_id), strategies: results }, null, 2)}\n`);
    }
  } finally {
    await stopServer(serverChild);
  }

  const report = {
    schema_version: "0.1.0",
    experiment_id: P10_EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    smoke_disclosure: "This is a wiring/regression smoke over the SAME 98-item VERIFIED-evidence calibration set already used to build this worktree's DocumentIR sample selection -- self-selection risk noted per this Turn's own brief. NOT a final chunking-quality measurement. No final_selection or winner is recorded here.",
    bm25_candidate_funnel_size_per_query: BM25_CANDIDATES_PER_QUERY,
    dataset_item_count: datasetItems.length,
    dataset_sha256: datasetManifest.calibration_dataset_sha256,
    bounded_document_count: boundedEntries.length,
    embedding_candidate: P10_EMBEDDING_CANDIDATE,
    top_k_values_reference: TOP_K_VALUES,
    strategies: results,
    // Question text / citation quotes are NEVER written to this report --
    // only calibration_item_id-scoped aggregate booleans/ranks above.
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "bounded-retrieval-smoke.v01.json");
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[p10-bounded-smoke] wrote ${outPath}`);
  console.log(JSON.stringify({
    status: "OK",
    dataset_item_count: datasetItems.length,
    bounded_document_count: boundedEntries.length,
    strategies: results.map((r) => ({
      chunking_config_id: r.chunking_config_id,
      queries_evaluated: r.queries_evaluated,
      bm25_recall_at_10: r.bm25.recall_at_10, dense_recall_at_10: r.dense.recall_at_10, rrf_recall_at_10: r.rrf.recall_at_10,
      rrf_mrr: r.rrf.mrr, corp_code_filter_accuracy: r.corp_code_filter_accuracy, wall_time_ms: r.wall_time_ms,
    })),
    report_path: path.relative(ROOT, outPath),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10-bounded-smoke] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
