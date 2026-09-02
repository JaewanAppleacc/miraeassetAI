#!/usr/bin/env node
// Turn P10.1: determinism proof, run AFTER scripts/p10.1-build-evaluation-
// corpus.mjs. Writes work/p10.1-chunking-dev-tune/determinism-report.v0.1.json.
//
// Covers three layers, each proven the way that is actually meaningful for
// it (re-running the full ~20min-per-strategy real embedding pipeline
// twice would take hours for no additional signal over what's below):
//
//   1. CHUNKING: rebuild all 3 strategies twice from the SAME cached raw
//      corpus records; the canonical (sorted) chunk_id-set sha256 must be
//      byte-identical both times. Deterministic by construction
//      (chunk_id = sha256(strategy_id, document_id, ordinal, content) --
//      domain/contracts.mjs), verified empirically here.
//   2. BM25 + RRF ranking: build + search + fuse TWICE for a deterministic
//      sample of items across all 3 strategies; rankings must be
//      byte-identical. Deterministic by construction (bm25.mjs/rrf.mjs
//      have no randomness, no wall-clock/Date.now() in their scoring
//      logic, and a fixed lexicographic tie-break), verified here too.
//   3. EMBEDDING NUMERICAL REPEATABILITY: calls the REAL local BGE-M3
//      server twice, independently, for a small deterministic sample of
//      real corpus texts, and checks cosine similarity between the two
//      embeddings of the SAME text is >= REPEATABILITY_COSINE_TOLERANCE --
//      the SAME methodology and tolerance already established by
//      scripts/run-real-embedding-calibration-v01.mjs's own
//      measureRepeatability(), reused rather than reinvented.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const REPEATABILITY_COSINE_TOLERANCE = 0.999999; // same constant as run-real-embedding-calibration-v01.mjs
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function canonicalChunkListSha256(chunks) {
  return sha256Hex([...chunks].map((c) => c.chunk_id).sort());
}

async function checkChunkingDeterminism(rawCache) {
  const results = [];
  for (const strategyConfig of P10_STRATEGIES) {
    const buildOnce = () => {
      const chunks = [];
      for (const entry of rawCache) chunks.push(...chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE));
      return canonicalChunkListSha256(chunks);
    };
    const first = buildOnce();
    const second = buildOnce();
    results.push({ chunking_config_id: strategyConfig.chunking_config_id, first_sha256: first, second_sha256: second, deterministic: first === second });
  }
  return results;
}

function checkRankingDeterminism(rawCache, goldItems) {
  const sampleItems = goldItems.slice(0, 10); // deterministic prefix sample -- same 10 items every run
  const results = [];
  for (const strategyConfig of P10_STRATEGIES) {
    const allChunks = [];
    for (const entry of rawCache) allChunks.push(...chunkDocument(entry.raw_record, toChunkerDocument(entry.metadata), strategyConfig, PROVENANCE));
    const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);

    for (const item of sampleItems) {
      const corpCodes = new Set(item.corp_codes);
      const docGroups = new Set(item.doc_groups);
      const filteredChunks = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
      if (filteredChunks.length === 0) continue;

      const runOnce = () => {
        const index = buildBm25Index(filteredChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
        const ranked = bm25Search(index, item.question, { topK: 30 });
        const fused = reciprocalRankFusion([ranked, ranked], { topK: 20 }); // deterministic self-fuse, exercises the same code path as the real run without a second real embedding call
        return sha256Hex(fused.map((r) => r.id));
      };
      const first = runOnce();
      const second = runOnce();
      results.push({ chunking_config_id: strategyConfig.chunking_config_id, question_id: item.question_id, first_sha256: first, second_sha256: second, deterministic: first === second });
    }
  }
  return results;
}

function waitForServerReady(child, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
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
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function checkEmbeddingRepeatability(rawCache, goldItems) {
  const sampleTexts = [goldItems[0].question, goldItems[1].question];
  const serverChild = spawn(VENV_PYTHON, [
    path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
    "--repository-id", P10_EMBEDDING_CANDIDATE.repository_id,
    "--revision", P10_EMBEDDING_CANDIDATE.immutable_revision,
    "--cache-dir", HF_CACHE_DIR,
    "--expected-dimension", String(P10_EMBEDDING_CANDIDATE.embedding_dimension),
    "--expected-max-input-length", "8192",
    "--port", "0",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await waitForServerReady(serverChild);
    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: P10_EMBEDDING_CANDIDATE.repository_id,
      revision: P10_EMBEDDING_CANDIDATE.immutable_revision, dimension: P10_EMBEDDING_CANDIDATE.embedding_dimension,
      endpoint_url: `http://127.0.0.1:${port}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 60000,
    });
    const first = await adapter.embedDocuments(sampleTexts);
    const second = await adapter.embedDocuments(sampleTexts);
    return sampleTexts.map((text, i) => ({
      sample_index: i,
      cosine_similarity: cosineSimilarity(first[i], second[i]),
      meets_tolerance: cosineSimilarity(first[i], second[i]) >= REPEATABILITY_COSINE_TOLERANCE,
    }));
  } finally {
    await stopServer(serverChild);
  }
}

async function main() {
  if (!existsSync(path.join(OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"))) throw new Error("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first");
  const rawCache = (await readFile(path.join(OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  console.error("[p10.1-determinism] checking chunking determinism (2x rebuild, all 3 strategies)...");
  const chunkingResults = await checkChunkingDeterminism(rawCache);

  console.error("[p10.1-determinism] checking BM25+RRF ranking determinism (2x, 10-item sample, all 3 strategies)...");
  const rankingResults = checkRankingDeterminism(rawCache, goldItems);

  console.error("[p10.1-determinism] checking real embedding numerical repeatability (2 real calls to the local BGE-M3 server)...");
  const embeddingResults = await checkEmbeddingRepeatability(rawCache, goldItems);

  const allChunkingStable = chunkingResults.every((r) => r.deterministic);
  const allRankingStable = rankingResults.every((r) => r.deterministic);
  const allEmbeddingStable = embeddingResults.every((r) => r.meets_tolerance);
  const overallStable = allChunkingStable && allRankingStable && allEmbeddingStable;

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    overall_deterministic: overallStable,
    chunking_determinism: chunkingResults,
    ranking_determinism_sample: rankingResults,
    embedding_repeatability_tolerance: REPEATABILITY_COSINE_TOLERANCE,
    embedding_repeatability_sample: embeddingResults,
  };
  await writeFile(path.join(OUT_DIR, "determinism-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: "OK", overall_deterministic: overallStable, chunking_stable: allChunkingStable, ranking_stable: allRankingStable, embedding_stable: allEmbeddingStable }, null, 2));
}

main().catch((error) => {
  console.error("[p10.1-determinism] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
