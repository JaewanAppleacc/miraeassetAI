#!/usr/bin/env node
// Turn P10.1.1: diagnoses whether Hierarchical's P10.1 underperformance was
// caused by the chunking itself or by flat/raw-search treatment, and
// re-tests it with a corrected, parent-aware retrieval contract.
//
// Reuses (unmodified): scripts/p10.1-build-evaluation-corpus.mjs's output
// (same 372-doc corpus, same DEV_TUNE-101 items), domain/chunking/
// chunker.mjs, domain/agent-comparison/chunking-comparison/{bm25,rrf,
// dev-tune-metrics,dev-tune-evidence-locator,document-metadata-index,
// p10-manifest}.mjs, and P10.1's own committed strategy-metrics.v0.1.json
// / per-item-results.v0.1.jsonl for configurations A (Fixed, top-30
// reference) and B (Hierarchical-1536, reused without rerun).
//
// Query text is always item.question alone. expected_answer/evidence_span
// text are never read here (dev-tune-evidence-locator.mjs only ever
// touches document_id/order_index/row/col).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { FROZEN_HIERARCHICAL_CONFIG } from "../domain/agent-comparison/chunking-comparison/frozen-hierarchical-config.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { computeItemMetrics, aggregateStrategyMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";
import { parseEvidenceLocator, chunkCoversLocator } from "../domain/agent-comparison/chunking-comparison/dev-tune-evidence-locator.mjs";
import { filterToLeafCandidates } from "../domain/agent-comparison/chunking-comparison/leaf-candidate-filter.mjs";
import { collapseSiblings, siblingCrowdingDiagnostics } from "../domain/agent-comparison/chunking-comparison/sibling-collapse.mjs";
import { applyDocumentDiversityCap } from "../domain/agent-comparison/chunking-comparison/document-diversity-cap.mjs";
import { diagnoseHierarchicalCauses } from "../domain/agent-comparison/chunking-comparison/hierarchical-cause-diagnosis.mjs";
import { decideHierarchicalRetention } from "../domain/agent-comparison/chunking-comparison/hierarchical-retention-rule.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const P101_OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const OUT_DIR = path.join(ROOT, "work", "p10.1.1-hierarchical-diagnostic");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const OFFICIAL_TOP_K_CANDIDATES = 100;
const DIAGNOSTIC_TOP_K_CANDIDATES = 30; // matches P10.1's original funnel, for the B-vs-C matched comparison
const RETURN_TOP_K = 20;
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: process.env.P10_1_1_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) });

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

function checkChunkInvariants(chunks, expectedCorpCode, documentId) {
  const violations = [];
  const idPattern = /^chunk_[0-9a-f]{24}$/;
  for (const chunk of chunks) {
    if (!idPattern.test(chunk.chunk_id)) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "MALFORMED_CHUNK_ID" });
    if (chunk.metadata.corp_code !== expectedCorpCode) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CORP_CODE_MISMATCH" });
    if (chunk.document_id !== documentId) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "DOCUMENT_ID_MISMATCH" });
    if (chunk.source_locator.startsWith("/") || chunk.source_locator.includes("..")) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "UNSAFE_SOURCE_LOCATOR" });
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

// Fraction of an item's required_evidence_slots covered by the given
// (unordered) chunk list -- used to measure BM25-STAGE coverage (before
// dense/RRF), reusing the SAME locator-parsing/matching primitives
// dev-tune-metrics.mjs's own (private) slot-coverage logic is built from.
function evidenceSlotCoverage(item, chunks) {
  if (item.required_evidence_slots.length === 0) return null;
  const covered = item.required_evidence_slots.filter((slot) =>
    slot.acceptable_sources.some((source) => {
      const parsed = parseEvidenceLocator(source.source_locator, source.document_id);
      return chunks.some((chunk) => chunkCoversLocator(chunk, parsed));
    }));
  return covered.length / item.required_evidence_slots.length;
}

const EMBED_MAX_ATTEMPTS = 4;
const EMBED_RETRY_DELAYS_MS = [2000, 5000, 10000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single transient timeout must never abort a multi-hour run outright --
// bounded retry with backoff, same RETRYABLE-error philosophy already
// established by this repo's calibration runner (embedding-calibration/
// runner.mjs's RETRYABLE_EMBEDDING_CALL_ERROR_CODES), reimplemented here
// at the cache-wrapper level since this diagnostic calls the adapter
// directly rather than through that runner.
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
      console.error(`[p10.1.1-diagnostic]   embedding call failed (attempt ${attempt}/${EMBED_MAX_ATTEMPTS}, code=${error?.code}), retrying in ${delay}ms...`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
  throw lastError;
}

function createEmbeddingCache(adapter) {
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    async embedManyCached(texts) {
      const uncached = [...new Set(texts.filter((t) => !cache.has(t)))];
      if (uncached.length > 0) {
        const batchSize = 8; // smaller batches reduce the chance any single real-inference call approaches the timeout
        for (let start = 0; start < uncached.length; start += batchSize) {
          const batch = uncached.slice(start, start + batchSize);
          // eslint-disable-next-line no-await-in-loop
          const vectors = await embedDocumentsWithRetry(adapter, batch);
          batch.forEach((t, i) => cache.set(t, vectors[i]));
        }
        misses += uncached.length;
      }
      hits += texts.length - uncached.length;
      return texts.map((t) => cache.get(t));
    },
    async embedOneCached(text) {
      if (!cache.has(text)) {
        const [vector] = await embedDocumentsWithRetry(adapter, [text]);
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

// One BM25+dense+RRF pass over `candidateChunks` (already metadata-
// filtered) for one item. Returns the fused ranking (up to
// OFFICIAL_TOP_K_CANDIDATES entries) plus the raw BM25 candidate id list
// (for coverage-stage diagnostics).
async function retrieveForItem(item, candidateChunks, chunkById, embeddingCache) {
  if (candidateChunks.length === 0) return { bm25Ranked: [], rrfRanked: [] };
  const bm25Index = buildBm25Index(candidateChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
  const bm25Ranked = bm25Search(bm25Index, item.question, { topK: OFFICIAL_TOP_K_CANDIDATES });
  const candidateIds = bm25Ranked.map((r) => r.id);
  const queryVector = await embeddingCache.embedOneCached(item.question);
  const candidateVectors = await embeddingCache.embedManyCached(candidateIds.map((id) => chunkById.get(id).embed_text));
  const denseScored = candidateIds.map((id, index) => ({ id, score: cosineSimilarity(queryVector, candidateVectors[index]) }));
  denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { topK: OFFICIAL_TOP_K_CANDIDATES });
  return { bm25Ranked, denseScored, rrfRanked };
}

// Re-fuses BM25+dense over a SMALLER prefix of an already-computed top-100
// BM25/dense pass -- no new embedding calls, since BM25 top-30 is exactly
// the first 30 of the SAME deterministic top-100 BM25 ordering, and its
// dense scores are already cached.
function refuseAtNarrowerFunnel(bm25Ranked, denseScored, narrowerK) {
  const bm25Narrow = bm25Ranked.slice(0, narrowerK);
  const allowedIds = new Set(bm25Narrow.map((r) => r.id));
  const denseNarrow = denseScored.filter((r) => allowedIds.has(r.id));
  return reciprocalRankFusion([bm25Narrow, denseNarrow], { topK: narrowerK });
}

async function runFixedAtOfficialFunnel(rawCache, goldItems, embeddingCache) {
  const strategyConfig = P10_STRATEGIES[0]; // fixed-token-512-o64.v0.1.0, unmodified
  const { allChunks, violations } = chunkAllDocuments(strategyConfig, rawCache);
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));

  const perItemResults = [];
  const bm25LatenciesMs = [];
  const denseLatenciesMs = [];
  let index = 0;
  for (const item of goldItems) {
    index += 1;
    if (index % 20 === 0 || index === goldItems.length) console.error(`[p10.1.1-diagnostic]   A(Fixed@top100): item ${index}/${goldItems.length} (${JSON.stringify(embeddingCache.stats())})`);
    const corpCodes = new Set(item.corp_codes);
    const docGroups = new Set(item.doc_groups);
    const filteredChunks = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
    const startedAt = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const { rrfRanked } = await retrieveForItem(item, filteredChunks, chunkById, embeddingCache);
    denseLatenciesMs.push(Date.now() - startedAt);
    const rrfChunks = rrfRanked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    perItemResults.push({ question_id: item.question_id, ...computeItemMetrics(item, rrfChunks) });
  }
  const aggregate = aggregateStrategyMetrics(perItemResults);
  return {
    label: "A_FIXED_BASELINE_TOP100",
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    locator_provenance_violations: violations.length,
    ...aggregate,
    dense_latency_p50_ms: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.5),
    dense_latency_p95_ms: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.95),
    peak_rss_bytes: process.memoryUsage().rss,
    per_item_results: perItemResults,
  };
}

async function runHierarchical1024(rawCache, goldItems, embeddingCache) {
  const { allChunks, violations } = chunkAllDocuments(FROZEN_HIERARCHICAL_CONFIG, rawCache);
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(allChunks.map((c) => [c.chunk_id, c])); // includes PARENT chunk_types too, needed for parent-expansion context lookup and group-key resolution
  const leafEligible = filterToLeafCandidates(searchEligible);

  const cTop30Results = [];
  const cTop100Results = [];
  const dTop100Results = [];
  const bm25CoverageAt30 = [];
  const bm25CoverageAt100 = [];
  const siblingCrowdingSamples = [];
  const crowdedMemberChunkTypeCounts = {};
  const documentCapExcludedCounts = [];
  let dPoolReusedFromCCount = 0;
  let dPoolFreshCount = 0;

  let index = 0;
  for (const item of goldItems) {
    index += 1;
    if (index % 20 === 0 || index === goldItems.length) console.error(`[p10.1.1-diagnostic]   Hierarchical-1024: item ${index}/${goldItems.length} (${JSON.stringify(embeddingCache.stats())})`);
    const corpCodes = new Set(item.corp_codes);
    const docGroups = new Set(item.doc_groups);

    // --- C: raw-flat, full search-eligible pool (parents compete too) ---
    const cCandidates = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
    // eslint-disable-next-line no-await-in-loop
    const cPass = await retrieveForItem(item, cCandidates, chunkById, embeddingCache);
    const cTop100Chunks = cPass.rrfRanked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    cTop100Results.push({ question_id: item.question_id, ...computeItemMetrics(item, cTop100Chunks) });

    if (cPass.bm25Ranked.length > 0) {
      const cTop30Fused = refuseAtNarrowerFunnel(cPass.bm25Ranked, cPass.denseScored, DIAGNOSTIC_TOP_K_CANDIDATES);
      const cTop30Chunks = cTop30Fused.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
      cTop30Results.push({ question_id: item.question_id, ...computeItemMetrics(item, cTop30Chunks) });
      bm25CoverageAt30.push(evidenceSlotCoverage(item, cPass.bm25Ranked.slice(0, DIAGNOSTIC_TOP_K_CANDIDATES).map((r) => chunkById.get(r.id))));
    }
    bm25CoverageAt100.push(evidenceSlotCoverage(item, cPass.bm25Ranked.map((r) => chunkById.get(r.id))));

    const crowd = siblingCrowdingDiagnostics(cPass.rrfRanked, chunkById, RETURN_TOP_K);
    siblingCrowdingSamples.push(crowd);
    const groups20 = new Map();
    for (const entry of cPass.rrfRanked.slice(0, RETURN_TOP_K)) {
      const chunk = chunkById.get(entry.id);
      const key = chunk.parent_chunk_id ?? chunk.chunk_id;
      if (!groups20.has(key)) groups20.set(key, []);
      groups20.get(key).push(chunk);
    }
    for (const members of groups20.values()) {
      for (const extra of members.slice(1)) { // everyone beyond the first is "crowded out" within this top-20 slice
        crowdedMemberChunkTypeCounts[extra.chunk_type] = (crowdedMemberChunkTypeCounts[extra.chunk_type] ?? 0) + 1;
      }
    }

    // --- D: parent-aware, leaf-only pool + collapse + document cap ---
    const dCandidates = leafEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));
    // When the leaf-only pool is set-identical to C's full search-eligible
    // pool for this item (verified per-item, not assumed globally --
    // empirically true whenever no parent-role chunk_type happened to be
    // retrieval_eligible for these documents), reuse C's already-computed
    // retrieval pass instead of repeating an identical, expensive real
    // embedding round trip.
    const poolsIdentical = dCandidates.length === cCandidates.length
      && new Set(dCandidates.map((c) => c.chunk_id)).size === new Set(cCandidates.map((c) => c.chunk_id)).size
      && dCandidates.every((c) => cCandidates.some((cc) => cc.chunk_id === c.chunk_id));
    if (poolsIdentical) dPoolReusedFromCCount += 1; else dPoolFreshCount += 1;
    // eslint-disable-next-line no-await-in-loop
    const dPass = poolsIdentical ? cPass : await retrieveForItem(item, dCandidates, chunkById, embeddingCache);
    const collapsed = collapseSiblings(dPass.rrfRanked, chunkById);
    const { kept, excludedCount } = applyDocumentDiversityCap(collapsed, chunkById);
    documentCapExcludedCounts.push(excludedCount);
    const dTop20Chunks = kept.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    dTop100Results.push({ question_id: item.question_id, ...computeItemMetrics(item, dTop20Chunks), document_cap_excluded_count: excludedCount });
  }

  const meanSiblingCrowded = siblingCrowdingSamples.reduce((sum, s) => sum + s.sibling_crowded_slot_count, 0) / (siblingCrowdingSamples.length || 1);

  return {
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    leaf_eligible_chunks: leafEligible.length,
    locator_provenance_violations: violations.length,
    d_pool_reused_from_c_count: dPoolReusedFromCCount,
    d_pool_fresh_retrieval_count: dPoolFreshCount,
    cTop30: { aggregate: aggregateStrategyMetrics(cTop30Results), perItem: cTop30Results },
    cTop100: { aggregate: aggregateStrategyMetrics(cTop100Results), perItem: cTop100Results },
    dTop100: { aggregate: aggregateStrategyMetrics(dTop100Results), perItem: dTop100Results },
    bm25Coverage: {
      at_30: bm25CoverageAt30.filter((v) => v !== null).reduce((a, b) => a + b, 0) / (bm25CoverageAt30.filter((v) => v !== null).length || 1),
      at_100: bm25CoverageAt100.filter((v) => v !== null).reduce((a, b) => a + b, 0) / (bm25CoverageAt100.filter((v) => v !== null).length || 1),
    },
    siblingCrowding: {
      mean_sibling_crowded_slot_count_at_20: meanSiblingCrowded,
      samples: siblingCrowdingSamples,
      crowded_member_chunk_type_counts: crowdedMemberChunkTypeCounts,
    },
    documentCapExcludedCounts,
  };
}

function questionTypeAndDocGroupBreakdown(goldItems, perItemByLabel) {
  const byQuestionType = {};
  const byDocGroup = {};
  for (const item of goldItems) {
    const qType = item.question_type;
    const docGroup = item.doc_groups[0];
    for (const [label, perItem] of Object.entries(perItemByLabel)) {
      const record = perItem.find((r) => r.question_id === item.question_id);
      if (!record || record.evidence_slot_coverage_fraction_at_k?.[10] === null || record.evidence_slot_coverage_fraction_at_k?.[10] === undefined) continue;
      byQuestionType[qType] = byQuestionType[qType] ?? {};
      byQuestionType[qType][label] = byQuestionType[qType][label] ?? [];
      byQuestionType[qType][label].push(record.evidence_slot_coverage_fraction_at_k[10]);
      byDocGroup[docGroup] = byDocGroup[docGroup] ?? {};
      byDocGroup[docGroup][label] = byDocGroup[docGroup][label] ?? [];
      byDocGroup[docGroup][label].push(record.evidence_slot_coverage_fraction_at_k[10]);
    }
  }
  const mean = (values) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const summarize = (groups) => Object.fromEntries(Object.entries(groups).map(([key, byLabel]) => [key, Object.fromEntries(Object.entries(byLabel).map(([label, values]) => [label, { recall_at_10_mean: mean(values), n: values.length }]))]));
  return { by_question_type: summarize(byQuestionType), by_doc_group: summarize(byDocGroup) };
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

async function main() {
  if (!existsSync(path.join(P101_OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"))) {
    throw new Error("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first (reused evaluation corpus)");
  }
  const rawCache = (await readFile(path.join(P101_OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  console.error(`[p10.1.1-diagnostic] ${rawCache.length} documents, ${goldItems.length} DEV_TUNE items (reused from P10.1's evaluation corpus)`);

  const p101StrategyMetrics = JSON.parse(await readFile(path.join(P101_OUT_DIR, "strategy-metrics.v0.1.json"), "utf8"));
  const p101PerItem = (await readFile(path.join(P101_OUT_DIR, "per-item-results.v0.1.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bReference = p101StrategyMetrics.strategies.find((s) => s.chunking_config_id === "doctype-hier-parent-child-table-dual.v0.2.0-p10-parent1536");
  const aReferenceTop30 = p101StrategyMetrics.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
  if (!bReference || !aReferenceTop30) throw new Error("FAIL-CLOSED: could not find P10.1's Fixed/Hierarchical-1536 reference metrics to reuse");

  if (!existsSync(VENV_PYTHON)) throw new Error(`FAIL-CLOSED: task-owned venv not found at ${VENV_PYTHON}`);
  console.error("[p10.1.1-diagnostic] starting local BGE-M3 server (reusing task-owned model cache)...");
  const serverChild = spawn(VENV_PYTHON, [
    path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
    "--repository-id", P10_EMBEDDING_CANDIDATE.repository_id,
    "--revision", P10_EMBEDDING_CANDIDATE.immutable_revision,
    "--cache-dir", HF_CACHE_DIR,
    "--expected-dimension", String(P10_EMBEDDING_CANDIDATE.embedding_dimension),
    "--expected-max-input-length", "8192",
    "--port", "0",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  let aResult;
  let hierResult;
  try {
    const port = await waitForServerReady(serverChild);
    const infoResponse = await fetch(`http://127.0.0.1:${port}/info`).then((r) => r.json());
    if (infoResponse.repository_id !== P10_EMBEDDING_CANDIDATE.repository_id || infoResponse.model_revision !== P10_EMBEDDING_CANDIDATE.immutable_revision) {
      throw new Error(`server identity mismatch: ${JSON.stringify(infoResponse)}`);
    }
    console.error(`[p10.1.1-diagnostic] server ready, device=${infoResponse.device}`);
    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: P10_EMBEDDING_CANDIDATE.repository_id,
      revision: P10_EMBEDDING_CANDIDATE.immutable_revision, dimension: P10_EMBEDDING_CANDIDATE.embedding_dimension,
      endpoint_url: `http://127.0.0.1:${port}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 180000,
    });

    await mkdir(OUT_DIR, { recursive: true });

    console.error("[p10.1.1-diagnostic] A: Fixed baseline @ BM25 top-100...");
    const aCacheStart = createEmbeddingCache(adapter);
    aResult = await runFixedAtOfficialFunnel(rawCache, goldItems, aCacheStart);
    await writeFile(path.join(OUT_DIR, ".checkpoint-A.json"), JSON.stringify({ done: true, macro_recall_10: aResult.macro_evidence_recall_at_k[10] }));

    console.error("[p10.1.1-diagnostic] Hierarchical-1024: C (raw-flat, top-30 + top-100) and D (parent-aware, top-100)...");
    const hierCache = createEmbeddingCache(adapter);
    hierResult = await runHierarchical1024(rawCache, goldItems, hierCache);
    await writeFile(path.join(OUT_DIR, ".checkpoint-hier.json"), JSON.stringify({ done: true, c_top100_recall_10: hierResult.cTop100.aggregate.macro_evidence_recall_at_k[10], d_top100_recall_10: hierResult.dTop100.aggregate.macro_evidence_recall_at_k[10] }));
  } finally {
    await stopServer(serverChild);
  }

  // --- assemble outputs ---
  const fixedForRule = {
    recall_at_10: aResult.macro_evidence_recall_at_k[10], mrr: aResult.macro_mrr, ndcg_at_10: aResult.macro_ndcg_at_10,
    node_hit_rate_at_10: aResult.node_hit_rate_at_10, locator_hit_rate_at_10: aResult.locator_hit_rate_at_10,
    search_eligible_chunks: aResult.search_eligible_chunks, dense_latency_p50_ms: aResult.dense_latency_p50_ms, peak_rss_bytes: aResult.peak_rss_bytes,
  };
  const dForRule = {
    recall_at_10: hierResult.dTop100.aggregate.macro_evidence_recall_at_k[10], mrr: hierResult.dTop100.aggregate.macro_mrr, ndcg_at_10: hierResult.dTop100.aggregate.macro_ndcg_at_10,
    node_hit_rate_at_10: hierResult.dTop100.aggregate.node_hit_rate_at_10, locator_hit_rate_at_10: hierResult.dTop100.aggregate.locator_hit_rate_at_10,
    search_eligible_chunks: hierResult.leaf_eligible_chunks, dense_latency_p50_ms: null, peak_rss_bytes: process.memoryUsage().rss,
  };

  const retention = decideHierarchicalRetention(fixedForRule, dForRule);
  const causes = diagnoseHierarchicalCauses({
    fixedMetrics: fixedForRule,
    hier1536Metrics: { recall_at_10: bReference.macro_evidence_recall_at_k[10] },
    cTop30Metrics: { recall_at_10: hierResult.cTop30.aggregate.macro_evidence_recall_at_k[10] },
    cTop100Metrics: { recall_at_10: hierResult.cTop100.aggregate.macro_evidence_recall_at_k[10] },
    dTop100Metrics: { recall_at_10: hierResult.dTop100.aggregate.macro_evidence_recall_at_k[10], node_hit_rate_at_10: hierResult.dTop100.aggregate.node_hit_rate_at_10, locator_hit_rate_at_10: hierResult.dTop100.aggregate.locator_hit_rate_at_10 },
    bm25CoverageC: hierResult.bm25Coverage,
    siblingCrowdingC: { mean_sibling_crowded_slot_count_at_20: hierResult.siblingCrowding.mean_sibling_crowded_slot_count_at_20, crowded_member_chunk_type_counts: hierResult.siblingCrowding.crowded_member_chunk_type_counts },
  });

  const inputPinManifest = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(),
    dev_tune_gold_sha256_pinned: "7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b",
    owner_decision_sha256_pinned: "00dc07913a3674102fbb341b5bf61c10ad3ea3d6e0bf52206f366157f88a6c8d",
    row_count: goldItems.length, reused_evaluation_corpus_document_count: rawCache.length,
  };
  await writeFile(path.join(OUT_DIR, "input-pin-manifest.v0.1.json"), `${JSON.stringify(inputPinManifest, null, 2)}\n`);

  const diagnosticConfigManifest = {
    schema_version: "0.1.0",
    configurations: {
      A_FIXED_BASELINE: { chunking_config_id: "fixed-token-512-o64.v0.1.0", funnel: OFFICIAL_TOP_K_CANDIDATES },
      B_HIERARCHICAL_1536_RAW_FLAT: { chunking_config_id: "doctype-hier-parent-child-table-dual.v0.2.0-p10-parent1536", funnel: DIAGNOSTIC_TOP_K_CANDIDATES, source: "reused from P10.1 work/p10.1-chunking-dev-tune/strategy-metrics.v0.1.json, not rerun" },
      C_HIERARCHICAL_1024_RAW_FLAT: { chunking_config_id: FROZEN_HIERARCHICAL_CONFIG.chunking_config_id, funnel_diagnostic: DIAGNOSTIC_TOP_K_CANDIDATES, funnel_official: OFFICIAL_TOP_K_CANDIDATES },
      D_HIERARCHICAL_1024_PARENT_AWARE: { chunking_config_id: FROZEN_HIERARCHICAL_CONFIG.chunking_config_id, funnel: OFFICIAL_TOP_K_CANDIDATES, leaf_only_candidate_pool: true, sibling_collapse: true, document_cap: 4 },
    },
    embedding_candidate: P10_EMBEDDING_CANDIDATE,
    return_top_k: RETURN_TOP_K,
  };
  await writeFile(path.join(OUT_DIR, "diagnostic-config-manifest.v0.1.json"), `${JSON.stringify(diagnosticConfigManifest, null, 2)}\n`);

  await writeFile(path.join(OUT_DIR, "candidate-funnel-analysis.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", bm25_evidence_coverage: hierResult.bm25Coverage, note: "fraction of required_evidence_slots covered by the raw BM25 candidate set alone, BEFORE dense/RRF -- config C (raw-flat, full search-eligible pool)" }, null, 2)}\n`);

  await writeFile(path.join(OUT_DIR, "sibling-crowding-analysis.v0.1.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    mean_sibling_crowded_slot_count_at_20: hierResult.siblingCrowding.mean_sibling_crowded_slot_count_at_20,
    crowded_member_chunk_type_counts: hierResult.siblingCrowding.crowded_member_chunk_type_counts,
    document_cap_excluded_counts_summary: { total: hierResult.documentCapExcludedCounts.reduce((a, b) => a + b, 0), mean_per_item: hierResult.documentCapExcludedCounts.reduce((a, b) => a + b, 0) / (hierResult.documentCapExcludedCounts.length || 1) },
  }, null, 2)}\n`);

  const perConfigMetrics = {
    schema_version: "0.1.0",
    A_FIXED_BASELINE_TOP100: { total_chunks: aResult.total_chunks, search_eligible_chunks: aResult.search_eligible_chunks, locator_provenance_violations: aResult.locator_provenance_violations, ...omitPerItem(aResult) },
    A_FIXED_BASELINE_TOP30_REFERENCE_FROM_P101: aReferenceTop30,
    B_HIERARCHICAL_1536_TOP30_REUSED_FROM_P101: bReference,
    C_HIERARCHICAL_1024_TOP30: { total_chunks: hierResult.total_chunks, search_eligible_chunks: hierResult.search_eligible_chunks, locator_provenance_violations: hierResult.locator_provenance_violations, ...hierResult.cTop30.aggregate },
    C_HIERARCHICAL_1024_TOP100: { total_chunks: hierResult.total_chunks, search_eligible_chunks: hierResult.search_eligible_chunks, locator_provenance_violations: hierResult.locator_provenance_violations, ...hierResult.cTop100.aggregate },
    D_HIERARCHICAL_1024_PARENT_AWARE_TOP100: { total_chunks: hierResult.total_chunks, leaf_eligible_chunks: hierResult.leaf_eligible_chunks, locator_provenance_violations: hierResult.locator_provenance_violations, ...hierResult.dTop100.aggregate },
  };
  await writeFile(path.join(OUT_DIR, "per-configuration-metrics.v0.1.json"), `${JSON.stringify(perConfigMetrics, null, 2)}\n`);

  const breakdown = questionTypeAndDocGroupBreakdown(goldItems, {
    A_FIXED_TOP100: aResult.per_item_results,
    C_HIER1024_TOP100: hierResult.cTop100.perItem,
    D_HIER1024_PARENT_AWARE: hierResult.dTop100.perItem,
  });
  await writeFile(path.join(OUT_DIR, "question-type-breakdown.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", ...breakdown }, null, 2)}\n`);

  const report = {
    schema_version: "0.1.0", generated_at: new Date().toISOString(),
    causes,
    retention_decision: retention,
    summary: {
      fixed_recall_at_10: fixedForRule.recall_at_10,
      hier1536_recall_at_10_reused: bReference.macro_evidence_recall_at_k[10],
      hier1024_raw_flat_top30_recall_at_10: hierResult.cTop30.aggregate.macro_evidence_recall_at_k[10],
      hier1024_raw_flat_top100_recall_at_10: hierResult.cTop100.aggregate.macro_evidence_recall_at_k[10],
      hier1024_parent_aware_top100_recall_at_10: dForRule.recall_at_10,
    },
    empirical_note_leaf_pool_vs_full_pool: `In this real corpus, D's leaf-only candidate pool was set-identical to C's full search-eligible pool for ${hierResult.d_pool_reused_from_c_count}/${hierResult.d_pool_reused_from_c_count + hierResult.d_pool_fresh_retrieval_count} items -- domain/chunking/chunker.mjs's own retrieval_eligible rule already excludes SECTION_PARENT/EVENT_PARENT/HOLDING_STATUS_PARENT/TABLE_WHOLE from the searchable index for these documents, so parent-role chunks were never actually competing for top-k slots even in C's "raw-flat" treatment. Any C-vs-D difference in this Turn's results therefore comes from the sibling-collapse + document-diversity-cap step alone, not from candidate-pool composition.`,
  };
  await writeFile(path.join(OUT_DIR, "hierarchical-diagnostic-report.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);

  await writeFile(path.join(OUT_DIR, "gate-status.v0.1.json"), `${JSON.stringify({ schema_version: "0.1.0", generated_at: new Date().toISOString(), gate: "DEV_TUNE_INPUT_GATE_REUSED_FROM_P10.1", status: "GREEN", dev_check_accessed: false, holdout_accessed: false, row_count: goldItems.length }, null, 2)}\n`);

  const perItemLines = [];
  for (const r of aResult.per_item_results) perItemLines.push(JSON.stringify({ config: "A_FIXED_TOP100", ...r }));
  for (const r of hierResult.cTop30.perItem) perItemLines.push(JSON.stringify({ config: "C_HIER1024_TOP30", ...r }));
  for (const r of hierResult.cTop100.perItem) perItemLines.push(JSON.stringify({ config: "C_HIER1024_TOP100", ...r }));
  for (const r of hierResult.dTop100.perItem) perItemLines.push(JSON.stringify({ config: "D_HIER1024_PARENT_AWARE", ...r }));
  await writeFile(path.join(OUT_DIR, "per-item-results.v0.1.jsonl"), `${perItemLines.join("\n")}\n`);

  console.log(JSON.stringify({ status: "OK", retention_decision: retention.status, summary: report.summary }, null, 2));
}

function omitPerItem({ per_item_results: _perItem, ...rest }) {
  return rest;
}

main().catch((error) => {
  console.error("[p10.1.1-diagnostic] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
