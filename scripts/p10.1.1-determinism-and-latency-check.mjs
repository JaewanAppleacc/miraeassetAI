#!/usr/bin/env node
// Turn P10.1.1: determinism proof (10-item fixed sample, per this Turn's
// brief: "결정론은 고정 10개 query만 1회 반복") PLUS a bounded, real-
// embedding latency measurement for configs A/C/D -- the main diagnostic
// run (scripts/p10.1.1-hierarchical-diagnostic.mjs) never separately
// timed the Hierarchical-1024 configs' BM25/dense stages, which
// hierarchical-retention-rule.mjs's cost-dimension check (rule 3) needs.
// This bounded companion run (10 items, real local BGE-M3, same server
// reuse pattern) supplies that data without repeating the full 101-item
// real-embedding pass.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { FROZEN_HIERARCHICAL_CONFIG } from "../domain/agent-comparison/chunking-comparison/frozen-hierarchical-config.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { filterToLeafCandidates } from "../domain/agent-comparison/chunking-comparison/leaf-candidate-filter.mjs";
import { collapseSiblings } from "../domain/agent-comparison/chunking-comparison/sibling-collapse.mjs";
import { applyDocumentDiversityCap } from "../domain/agent-comparison/chunking-comparison/document-diversity-cap.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const P101_OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const OUT_DIR = path.join(ROOT, "work", "p10.1.1-hierarchical-diagnostic");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const REPEATABILITY_COSINE_TOLERANCE = 0.999999;
const OFFICIAL_TOP_K_CANDIDATES = 100;
const SAMPLE_SIZE = 10; // fixed 10-item deterministic prefix sample, per this Turn's brief
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });

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

function chunkAllDocuments(strategyConfig, rawCache) {
  const allChunks = [];
  for (const entry of rawCache) allChunks.push(...chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE));
  return allChunks;
}

function canonicalChunkListSha256(chunks) {
  return sha256Hex([...chunks].map((c) => c.chunk_id).sort());
}

async function checkChunkingDeterminism(rawCache) {
  const results = [];
  for (const strategyConfig of [P10_STRATEGIES[0], FROZEN_HIERARCHICAL_CONFIG]) {
    const first = canonicalChunkListSha256(chunkAllDocuments(strategyConfig, rawCache));
    const second = canonicalChunkListSha256(chunkAllDocuments(strategyConfig, rawCache));
    results.push({ chunking_config_id: strategyConfig.chunking_config_id, first_sha256: first, second_sha256: second, deterministic: first === second });
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMBED_MAX_ATTEMPTS = 4;
const EMBED_RETRY_DELAYS_MS = [2000, 5000, 10000];

async function embedDocumentsWithRetry(adapter, texts) {
  let lastError;
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await adapter.embedDocuments(texts);
    } catch (error) {
      lastError = error;
      const retryable = error?.code === "EMBEDDING_CALL_TIMEOUT" || error?.code === "EMBEDDING_CALL_HTTP_ERROR" || error?.code === "EMBEDDING_CALL_UNKNOWN_ERROR";
      if (!retryable || attempt === EMBED_MAX_ATTEMPTS) throw error;
      const delay = EMBED_RETRY_DELAYS_MS[attempt - 1] ?? EMBED_RETRY_DELAYS_MS.at(-1);
      console.error(`[p10.1.1-determinism]   embedding call failed (attempt ${attempt}/${EMBED_MAX_ATTEMPTS}, code=${error?.code}), retrying in ${delay}ms...`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
  throw lastError;
}

async function timedRetrieve(item, candidateChunks, chunkById, adapter) {
  if (candidateChunks.length === 0) return { rrfRanked: [], bm25Ms: 0, denseMs: 0 };
  const bm25StartedAt = Date.now();
  const bm25Index = buildBm25Index(candidateChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
  const bm25Ranked = bm25Search(bm25Index, item.question, { topK: OFFICIAL_TOP_K_CANDIDATES });
  const bm25Ms = Date.now() - bm25StartedAt;

  const denseStartedAt = Date.now();
  const [queryVector] = await embedDocumentsWithRetry(adapter, [item.question]);
  const candidateTexts = bm25Ranked.map((r) => chunkById.get(r.id).embed_text);
  const candidateVectors = [];
  const batchSize = 8;
  for (let start = 0; start < candidateTexts.length; start += batchSize) {
    // eslint-disable-next-line no-await-in-loop
    const vectors = await embedDocumentsWithRetry(adapter, candidateTexts.slice(start, start + batchSize));
    candidateVectors.push(...vectors);
  }
  const denseMs = Date.now() - denseStartedAt;
  const denseScored = bm25Ranked.map((r, i) => ({ id: r.id, score: cosineSimilarity(queryVector, candidateVectors[i]) }));
  denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { topK: OFFICIAL_TOP_K_CANDIDATES });
  return { bm25Ranked, denseScored, rrfRanked, bm25Ms, denseMs };
}

function checkRankingDeterminism(rawCache, sampleItems) {
  const results = [];
  for (const strategyConfig of [P10_STRATEGIES[0], FROZEN_HIERARCHICAL_CONFIG]) {
    const allChunks = chunkAllDocuments(strategyConfig, rawCache);
    const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
    for (const item of sampleItems) {
      const corpCodes = new Set(item.corp_codes);
      const docGroups = new Set(item.doc_groups);
      const filtered = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
      if (filtered.length === 0) continue;
      const runOnce = () => {
        const index = buildBm25Index(filtered.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
        const ranked = bm25Search(index, item.question, { topK: OFFICIAL_TOP_K_CANDIDATES });
        const fused = reciprocalRankFusion([ranked, ranked], { topK: 20 });
        return sha256Hex(fused.map((r) => r.id));
      };
      const first = runOnce();
      const second = runOnce();
      results.push({ chunking_config_id: strategyConfig.chunking_config_id, question_id: item.question_id, deterministic: first === second });
    }
  }
  return results;
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
  const rawCache = (await readFile(path.join(P101_OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const sampleItems = goldItems.slice(0, SAMPLE_SIZE);

  console.error("[p10.1.1-determinism] chunking determinism (2x rebuild, A + Hierarchical-1024)...");
  const chunkingResults = await checkChunkingDeterminism(rawCache);
  console.error("[p10.1.1-determinism] BM25+RRF ranking determinism (2x, 10-item sample)...");
  const rankingResults = checkRankingDeterminism(rawCache, sampleItems);

  if (!existsSync(VENV_PYTHON)) throw new Error(`FAIL-CLOSED: venv not found at ${VENV_PYTHON}`);
  const serverChild = spawn(VENV_PYTHON, [
    path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
    "--repository-id", P10_EMBEDDING_CANDIDATE.repository_id, "--revision", P10_EMBEDDING_CANDIDATE.immutable_revision,
    "--cache-dir", HF_CACHE_DIR, "--expected-dimension", String(P10_EMBEDDING_CANDIDATE.embedding_dimension),
    "--expected-max-input-length", "8192", "--port", "0",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  let embeddingResults;
  const latencyByConfig = {};
  let peakRssByConfig = {};
  try {
    const port = await waitForServerReady(serverChild);
    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: P10_EMBEDDING_CANDIDATE.repository_id,
      revision: P10_EMBEDDING_CANDIDATE.immutable_revision, dimension: P10_EMBEDDING_CANDIDATE.embedding_dimension,
      endpoint_url: `http://127.0.0.1:${port}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 180000,
    });
    console.error("[p10.1.1-determinism] embedding numerical repeatability (2 real calls)...");
    const sampleTexts = [sampleItems[0].question, sampleItems[1].question];
    const first = await adapter.embedDocuments(sampleTexts);
    const second = await adapter.embedDocuments(sampleTexts);
    embeddingResults = sampleTexts.map((t, i) => ({ sample_index: i, cosine_similarity: cosineSimilarity(first[i], second[i]), meets_tolerance: cosineSimilarity(first[i], second[i]) >= REPEATABILITY_COSINE_TOLERANCE }));

    console.error("[p10.1.1-determinism] bounded latency measurement (A / C-raw-flat / D-parent-aware, 10-item sample)...");
    // A: Fixed
    {
      const allChunks = chunkAllDocuments(P10_STRATEGIES[0], rawCache);
      const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
      const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));
      const bm25Ms = []; const denseMs = [];
      for (const item of sampleItems) {
        const corpCodes = new Set(item.corp_codes); const docGroups = new Set(item.doc_groups);
        const filtered = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
        // eslint-disable-next-line no-await-in-loop
        const r = await timedRetrieve(item, filtered, chunkById, adapter);
        bm25Ms.push(r.bm25Ms); denseMs.push(r.denseMs);
      }
      latencyByConfig.A_FIXED = { bm25_p50_ms: percentile([...bm25Ms].sort((a, b) => a - b), 0.5), dense_p50_ms: percentile([...denseMs].sort((a, b) => a - b), 0.5) };
      peakRssByConfig.A_FIXED = process.memoryUsage().rss;
    }
    // C (raw-flat) + D (parent-aware): same underlying pool per item (already proven identical in the main run)
    {
      const allChunks = chunkAllDocuments(FROZEN_HIERARCHICAL_CONFIG, rawCache);
      const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
      const chunkById = new Map(allChunks.map((c) => [c.chunk_id, c]));
      const leafEligible = filterToLeafCandidates(searchEligible);
      const cBm25Ms = []; const cDenseMs = []; const dCollapseMs = [];
      for (const item of sampleItems) {
        const corpCodes = new Set(item.corp_codes); const docGroups = new Set(item.doc_groups);
        const cFiltered = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
        // eslint-disable-next-line no-await-in-loop
        const r = await timedRetrieve(item, cFiltered, chunkById, adapter);
        cBm25Ms.push(r.bm25Ms); cDenseMs.push(r.denseMs);
        const collapseStartedAt = Date.now();
        const dFiltered = leafEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
        const poolsIdentical = dFiltered.length === cFiltered.length && dFiltered.every((c) => cFiltered.some((cc) => cc.chunk_id === c.chunk_id));
        const rrfForCollapse = poolsIdentical ? r.rrfRanked : null;
        if (rrfForCollapse) {
          const collapsed = collapseSiblings(rrfForCollapse, chunkById);
          applyDocumentDiversityCap(collapsed, chunkById);
        }
        dCollapseMs.push(Date.now() - collapseStartedAt);
      }
      latencyByConfig.C_HIER1024_RAW_FLAT = { bm25_p50_ms: percentile([...cBm25Ms].sort((a, b) => a - b), 0.5), dense_p50_ms: percentile([...cDenseMs].sort((a, b) => a - b), 0.5) };
      // D's own total latency = C's retrieval (reused pool) + the collapse/cap post-processing step, timed separately above.
      latencyByConfig.D_HIER1024_PARENT_AWARE = {
        bm25_p50_ms: latencyByConfig.C_HIER1024_RAW_FLAT.bm25_p50_ms,
        dense_p50_ms: latencyByConfig.C_HIER1024_RAW_FLAT.dense_p50_ms + (percentile([...dCollapseMs].sort((a, b) => a - b), 0.5) ?? 0),
        collapse_and_cap_p50_ms: percentile([...dCollapseMs].sort((a, b) => a - b), 0.5),
      };
      peakRssByConfig.C_HIER1024_RAW_FLAT = process.memoryUsage().rss;
      peakRssByConfig.D_HIER1024_PARENT_AWARE = process.memoryUsage().rss;
    }
  } finally {
    await stopServer(serverChild);
  }

  const allDeterministic = chunkingResults.every((r) => r.deterministic) && rankingResults.every((r) => r.deterministic) && embeddingResults.every((r) => r.meets_tolerance);

  const report = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(),
    sample_size: SAMPLE_SIZE,
    overall_deterministic: allDeterministic,
    chunking_determinism: chunkingResults,
    ranking_determinism_sample: rankingResults,
    embedding_repeatability_tolerance: REPEATABILITY_COSINE_TOLERANCE,
    embedding_repeatability_sample: embeddingResults,
    bounded_latency_measurement_note: `Measured on the same fixed ${SAMPLE_SIZE}-item prefix sample, real local BGE-M3 -- supplies the latency figures the main diagnostic run (scripts/p10.1.1-hierarchical-diagnostic.mjs) did not separately capture for the Hierarchical-1024 configs.`,
    latency_by_config: latencyByConfig,
    peak_rss_by_config: peakRssByConfig,
  };
  await writeFile(path.join(OUT_DIR, "determinism-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: "OK", overall_deterministic: allDeterministic, latency_by_config: latencyByConfig }, null, 2));
}

main().catch((error) => {
  console.error("[p10.1.1-determinism] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
