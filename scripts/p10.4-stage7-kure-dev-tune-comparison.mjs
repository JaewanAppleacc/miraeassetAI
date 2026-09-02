#!/usr/bin/env node
// Turn P10.4 / Stage 7: real KURE-v1 embedding comparison, DEV_TUNE-101
// bounded 372-doc corpus ONLY -- exactly 2 combinations: KURE-v1 x Fixed-
// 512+o64, KURE-v1 x Adaptive. Section-Aware-Flat and Hierarchical are NOT
// re-run. One model server spawned, concurrency 1, reused across both
// combinations (never two servers at once). Adapts P10.1's proven BM25-
// funnel-then-dense-rerank pattern (scripts/p10.1-run-dev-tune-comparison.mjs),
// unmodified in its metric/BM25/RRF logic -- only the chunk source differs.
//
// Turn P10.4-R additions (never touching the BM25/dense/RRF core logic
// above): (Section F) late parent-context expansion is wired in for the
// adaptive combination's already-finalized Top-K, with real truncation and
// an invariant check that expansion never changes rank/score/source_locator
// or the result slot count; (Section I) each combination's full result is
// checkpointed atomically immediately after it finishes; (Section J)
// cell-level / row-header-aware / period-column-aware / explicit-unit-aware
// / multi-cell-complete-evidence Recall@10 sub-metrics are added for table
// items, using the same resolveAuthoritativeCellV2 ground-truth resolver
// Stage 6 uses, evaluated against each combination's ACTUAL top-10 result.
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { chunkFixed } from "../domain/chunking/chunker.mjs";
import { chunkAdaptive, resolveTableContext, resolveUnit } from "../domain/chunking/adaptive-table-chunker.mjs";
import { ADAPTIVE_POLICY_ID, BASE_FIXED_CONFIG_ID, TABLE_ROW_CHILD_MAX_TOKENS, CONTEXT_STATE, PARENT_EXPANSION_POLICY } from "../domain/chunking/adaptive-chunking-policy.mjs";
import { buildContextByTableNodeId, expandWithParentContext, expandWithMultiRowContext } from "../domain/chunking/adaptive-parent-expansion.mjs";
import { toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { buildBm25Index, bm25Search } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { computeItemMetrics, aggregateStrategyMetrics } from "../domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs";
import { getFrozenCandidateById, prepareTextForMode } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { classifyGoldItemForTablesV2 } from "../domain/agent-comparison/chunking-comparison/table-item-classifier-v2.mjs";
import { resolveAuthoritativeCellV2, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority-v2.mjs";
import strategyConfigs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const TASK_CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "ai-festival-embedding-calibration-v01");
const HF_CACHE_DIR = path.join(TASK_CACHE_ROOT, "huggingface");
const VENV_PYTHON = path.join(TASK_CACHE_ROOT, "venv", "bin", "python3");
const BM25_CANDIDATES_PER_ITEM = 30; // identical to P10.1
const RETURN_TOP_K = 20; // identical to P10.1
const PROVENANCE = Object.freeze({ targetCorpusSnapshotId: "corpus_04750795e1a2d5c3", parserCodeRevision: "0".repeat(40), parserConfigHash: "0".repeat(64) });
const FIXED_STRATEGY_CONFIG = strategyConfigs.strategies.find((s) => s.chunking_config_id === BASE_FIXED_CONFIG_ID);
const ADAPTIVE_CONFIG = Object.freeze({ chunking_config_id: ADAPTIVE_POLICY_ID, strategy_name: "adaptive-table-aware", strategy_version: "0.1.0", max_tokens: 512, overlap_tokens: 64, table_row_child_max_tokens: TABLE_ROW_CHILD_MAX_TOKENS });
const KURE = getFrozenCandidateById("kure_v1");

function normalize(text) { return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(); }
function sha256Hex(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex"); }
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}
function mean(values) { const f = values.filter((v) => v !== null && v !== undefined); return f.length > 0 ? f.reduce((a, b) => a + b, 0) / f.length : null; }

// Turn P10.4-R / Section I: atomic per-combination checkpoint write --
// write-to-temp-then-rename so a killed process never leaves a partial/
// corrupt checkpoint that a later run could mistake for COMPLETE.
async function writeAtomicJson(filePath, value) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmpPath, filePath);
}

async function loadEvaluationCorpus() {
  const rawCacheText = await readFile(RAW_CACHE_PATH, "utf8");
  const goldText = await readFile(GOLD_JSONL_PATH, "utf8");
  const cacheLines = rawCacheText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const goldItems = goldText.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  // Turn P10.4-R / Section I: input pin -- sha256 of the two source files'
  // actual content, not just their paths, so a checkpoint can be verified
  // to have run against exactly this input.
  const inputPinSha256 = sha256Hex(`${sha256Hex(rawCacheText)}|${sha256Hex(goldText)}`);
  return { rawCache: cacheLines, goldItems, inputPinSha256 };
}

function chunkAllDocuments(kind, rawCache) {
  const allChunks = [];
  for (const entry of rawCache) {
    const document = toChunkerDocument(entry.metadata);
    const chunks = kind === "fixed"
      ? chunkFixed(entry.raw_record, document, FIXED_STRATEGY_CONFIG, PROVENANCE)
      : chunkAdaptive(entry.raw_record, document, ADAPTIVE_CONFIG, PROVENANCE);
    allChunks.push(...chunks);
  }
  return allChunks;
}

// Composite cache key IDENTICAL in shape to P10.2's contract (repository/
// revision/dimension/role/prefix/normalizedTextSha/chunkingConfigId) --
// per this Turn's explicit instruction, cross-strategy reuse is honored
// ONLY when the FULL key matches. Since Fixed's and Adaptive's
// chunking_config_id always differ, this key never accidentally reuses a
// vector across strategies even for byte-identical text -- safe by
// construction, matching P10.2's established no-contamination guarantee,
// not a special-cased shortcut.
function createEmbeddingCache(adapter, chunkingConfigId) {
  const cache = new Map();
  let hits = 0, misses = 0;
  const keyFor = (text) => `${KURE.repository_id}|${KURE.immutable_revision}|${KURE.embedding_dimension}|document|${KURE.document_prefix}|${text}|${chunkingConfigId}`;
  return {
    async embedManyCached(texts) {
      const uncached = [...new Set(texts.filter((t) => !cache.has(keyFor(t))))];
      if (uncached.length > 0) {
        const batchSize = 16;
        for (let start = 0; start < uncached.length; start += batchSize) {
          const batch = uncached.slice(start, start + batchSize);
          // eslint-disable-next-line no-await-in-loop
          const vectors = await adapter.embedDocuments(batch.map((t) => prepareTextForMode(KURE, t, "document")));
          batch.forEach((t, i) => cache.set(keyFor(t), vectors[i]));
        }
        misses += uncached.length;
      }
      hits += texts.length - uncached.length;
      return texts.map((t) => cache.get(keyFor(t)));
    },
    async embedOneCached(text) {
      const key = `${KURE.repository_id}|${KURE.immutable_revision}|${KURE.embedding_dimension}|query|${KURE.query_prefix}|${text}|${chunkingConfigId}`;
      if (!cache.has(key)) {
        const [vector] = await adapter.embedDocuments([prepareTextForMode(KURE, text, "query")]);
        cache.set(key, vector);
        misses += 1;
      } else hits += 1;
      return cache.get(key);
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

// Turn P10.4-R / Section J: resolves a table item's Gold evidence slots to
// concrete (document, node, row_index) ground-truth cells via the SAME
// resolver Stage 6 uses (resolveAuthoritativeCellV2) -- excludes the 4
// pinned parse-limited sources exactly like Stage 6 does, never force-
// resolved. Never reads item.question or item.expected_answer.
function resolveTableItemCells(item, rawRecordByDocId) {
  const cells = [];
  for (const slot of item.required_evidence_slots ?? []) {
    for (const source of slot.acceptable_sources ?? []) {
      const raw = rawRecordByDocId.get(source.document_id);
      const resolved = resolveAuthoritativeCellV2({ rawRecord: raw, locator: source.source_locator, evidenceSpanText: source.evidence_span, extensions: item.extensions });
      if (resolved.root_cause === ROOT_CAUSE.SOURCE_PARSE_LIMITATION || resolved.root_cause === ROOT_CAUSE.GOLD_LOCATOR_UNRESOLVABLE) continue;
      if (resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_EXACT && resolved.root_cause !== ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS) continue;
      const rowIndices = resolved.matched_row_indices ?? [resolved.row_index];
      for (const rowIndex of rowIndices) {
        if (rowIndex === null || rowIndex === undefined) continue;
        cells.push({ documentId: source.document_id, node: resolved.node, rowIndex });
      }
    }
  }
  return cells;
}

// A chunk "covers" a ground-truth cell when some source_span names the
// same document/node and row_start<=rowIndex<=row_end -- with the Turn
// P10.4-R / Section D per-row-span fix, this is now cell-precise for
// packed TABLE_ROW_WITH_HEADERS chunks (each row has its OWN accurate
// span), not a coarse row-range approximation.
function findCoveringChunk(top10Chunks, documentId, node, rowIndex) {
  const claiming = top10Chunks.filter((c) => c.document_id === documentId && c.source_spans.some((s) => s.node_id === node.node_id && s.row_start !== null && s.row_start <= rowIndex && rowIndex <= s.row_end));
  if (claiming.length === 0) return null;
  const rowText = normalize((node.normalized_rows?.[rowIndex] ?? []).join(" | "));
  return claiming.find((c) => rowText.length > 0 && normalize(c.raw_text).includes(rowText)) ?? claiming[0];
}

// Per-item cell-level metrics against a combination's ACTUAL top-10 result
// (never the raw Gold locator's own node-only granularity). Returns null
// for a non-table item (nothing to evaluate).
function computeCellLevelMetrics({ item, top10Chunks, rawRecordByDocId, isMultiCellItem, tableGroundTruthCache }) {
  const cells = resolveTableItemCells(item, rawRecordByDocId);
  if (cells.length === 0) return null;

  let coveredCount = 0;
  let rowHeaderApplicable = 0, rowHeaderCovered = 0;
  let periodApplicable = 0, periodCovered = 0;
  let unitApplicable = 0, unitCovered = 0;
  let allCovered = true;

  for (const cell of cells) {
    const covering = findCoveringChunk(top10Chunks, cell.documentId, cell.node, cell.rowIndex);
    const covered = !!covering;
    if (covered) coveredCount += 1; else allCovered = false;

    const rowCells = (cell.node.normalized_rows?.[cell.rowIndex] ?? []).map((c) => normalize(c));
    if (rowCells.length > 1 && rowCells[0].length > 0) {
      rowHeaderApplicable += 1;
      if (covered && normalize(covering.raw_text).includes(rowCells[0])) rowHeaderCovered += 1;
    }
    const headerRowIndices = cell.node.header_row_indices ?? [];
    if (headerRowIndices.length > 0 && !headerRowIndices.includes(cell.rowIndex)) {
      periodApplicable += 1;
      const headerRowText = normalize((cell.node.normalized_rows?.[headerRowIndices[0]] ?? []).join(" | "));
      if (covered && normalize(covering.raw_text).includes(headerRowText)) periodCovered += 1;
    }

    const cacheKey = cell.node.node_id;
    let tableCtx = tableGroundTruthCache.get(cacheKey);
    if (!tableCtx) {
      tableCtx = resolveTableContext(cell.node, []); // segment sample only affects title/section, not the unit row scan -- irrelevant here since only unitRowIndex is used
      tableGroundTruthCache.set(cacheKey, tableCtx);
    }
    const rowUnit = resolveUnit(rowCells, cell.node, tableCtx.unitRowIndex);
    if (rowUnit.context_state !== CONTEXT_STATE.ABSENT_IN_SOURCE) {
      unitApplicable += 1;
      const unitOk = rowUnit.context_state === CONTEXT_STATE.EXPLICIT_IN_SOURCE ? covered : (covered && /단위:/.test(covering.raw_text));
      if (unitOk) unitCovered += 1;
    }
  }

  return {
    cell_level_recall: coveredCount / cells.length,
    row_header_aware_recall: rowHeaderApplicable > 0 ? rowHeaderCovered / rowHeaderApplicable : null,
    period_column_aware_recall: periodApplicable > 0 ? periodCovered / periodApplicable : null,
    explicit_unit_aware_recall: unitApplicable > 0 ? unitCovered / unitApplicable : null,
    multi_cell_complete_evidence: isMultiCellItem ? (allCovered ? 1 : 0) : null,
  };
}

async function runCombination({ kind, rawCache, goldItems, adapter, rawRecordByDocId, itemTagsById }) {
  const startedAt = Date.now();
  const allChunks = chunkAllDocuments(kind, rawCache);
  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const chunkById = new Map(searchEligible.map((c) => [c.chunk_id, c]));

  // Turn P10.4-R / Section F: built once per combination from the FULL
  // chunk list (including CONTEXT_ONLY ones) -- a structural no-op for
  // "fixed" (no chunk carries a table_node_id), real for "adaptive".
  const contextByTableNodeId = buildContextByTableNodeId(allChunks);
  const tableGroundTruthCache = new Map();

  const embeddingCache = createEmbeddingCache(adapter, kind === "fixed" ? BASE_FIXED_CONFIG_ID : ADAPTIVE_POLICY_ID);
  const perItemResults = [];
  const bm25LatenciesMs = [];
  const denseLatenciesMs = [];
  let truncationCount = 0;
  let retryCount = 0;
  let failureCount = 0;

  // Turn P10.4-R / Section F: late-expansion bookkeeping, real numbers not
  // hardcoded literals -- only meaningful for kind === "adaptive" (Fixed
  // chunks carry no table_node_id, expansion is a structural no-op there).
  let selectedChildCount = 0;
  let parentAttachedCount = 0;
  let parentMissingCount = 0;
  let parentBudgetExhaustedCount = 0;
  let multiRowAttachedCount = 0;
  let multiRowMissingCount = 0;
  const parentContextTokenCounts = [];
  let parentTruncationCount = 0;
  let rankSlotInvariantViolations = 0;
  let resultSlotCountMismatches = 0;
  // Real, measured check (never hardcoded) that CONTEXT_ONLY chunks
  // (TABLE_PARENT_CONTEXT/MULTI_ROW_CONTEXT) never occupy a base search
  // result slot -- structurally guaranteed by construction (rrfChunks are
  // built only from searchEligible, which filters on
  // metadata.retrieval_eligible before BM25/dense ever run), verified here
  // rather than merely assumed.
  let contextOnlyChunksInResultsCount = 0;

  let itemIndex = 0;
  for (const item of goldItems) {
    itemIndex += 1;
    if (itemIndex % 20 === 0 || itemIndex === goldItems.length) {
      console.error(`[p10.4-stage7]   ${kind}: item ${itemIndex}/${goldItems.length} (embed cache: ${JSON.stringify(embeddingCache.stats())})`);
    }
    const corpCodes = new Set(item.corp_codes);
    const docGroups = new Set(item.doc_groups);
    const filteredChunks = searchEligible.filter((c) => corpCodes.has(c.metadata.corp_code) && docGroups.has(c.metadata.doc_group));

    if (filteredChunks.length === 0) {
      perItemResults.push({ question_id: item.question_id, skipped_no_candidates: true, ...computeItemMetrics(item, []), cell_level_metrics: null });
      continue;
    }

    const bm25StartedAt = Date.now();
    const bm25Index = buildBm25Index(filteredChunks.map((c) => ({ id: c.chunk_id, text: c.embed_text })));
    const bm25Ranked = bm25Search(bm25Index, item.question, { topK: BM25_CANDIDATES_PER_ITEM });
    bm25LatenciesMs.push(Date.now() - bm25StartedAt);

    const candidateIds = bm25Ranked.map((r) => r.id);
    const denseStartedAt = Date.now();
    let queryVector, candidateVectors;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        queryVector = await embeddingCache.embedOneCached(item.question);
        // eslint-disable-next-line no-await-in-loop
        candidateVectors = await embeddingCache.embedManyCached(candidateIds.map((id) => chunkById.get(id).embed_text));
        break;
      } catch (error) {
        if (attempt === 4) { failureCount += 1; throw error; }
        retryCount += 1;
        const delay = [2000, 5000, 10000][attempt - 1] ?? 10000;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const denseScored = candidateIds.map((id, index) => ({ id, score: cosineSimilarity(queryVector, candidateVectors[index]) }));
    denseScored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    denseLatenciesMs.push(Date.now() - denseStartedAt);

    const rrfRanked = reciprocalRankFusion([bm25Ranked, denseScored], { topK: RETURN_TOP_K });
    const rrfChunks = rrfRanked.slice(0, RETURN_TOP_K).map((r) => chunkById.get(r.id));
    if (rrfChunks.some((c) => c.chunk_type === "TABLE_PARENT_CONTEXT" || c.chunk_type === "MULTI_ROW_CONTEXT" || c.metadata.retrieval_eligible !== true)) {
      contextOnlyChunksInResultsCount += 1;
    }

    const itemMetrics = computeItemMetrics(item, rrfChunks);
    const tags = itemTagsById.get(item.question_id) ?? [];
    const isMultiCellItem = tags.includes("MULTI_ROW_CALCULATION") || tags.includes("MULTI_COLUMN_COMPARISON");
    const cellLevelMetrics = computeCellLevelMetrics({ item, top10Chunks: rrfChunks.slice(0, 10), rawRecordByDocId, isMultiCellItem, tableGroundTruthCache });

    // Turn P10.4-R / Section F: late parent-context expansion over the
    // ALREADY-FINALIZED top-10 -- rank/score/source_locator are asserted
    // unchanged; expansion never adds/removes a result slot. Only
    // meaningful when kind === "adaptive" (a table_node_id is only ever
    // present on Adaptive chunks), but run unconditionally for both kinds
    // so the invariant check itself is exercised identically either way.
    const top10 = rrfChunks.slice(0, 10);
    const rankedWithScore = top10.map((chunk, i) => ({ ...chunk, score: rrfRanked[i]?.score ?? null }));
    const expansion = expandWithParentContext(rankedWithScore, contextByTableNodeId, PARENT_EXPANSION_POLICY);
    if (expansion.result_count !== top10.length) resultSlotCountMismatches += 1;
    expansion.results.forEach((r, i) => {
      const original = top10[i];
      if (!original || r.rank !== i || r.chunk_id !== original.chunk_id || r.score !== rankedWithScore[i].score || r.source_locator !== original.source_locator) {
        rankSlotInvariantViolations += 1;
      }
      if (r.chunk.chunk_type !== "FIXED_WINDOW" && r.chunk.metadata?.table_node_id) selectedChildCount += 1;
      if (r.expansion_reason === "ATTACHED") {
        parentAttachedCount += 1;
        parentContextTokenCounts.push(r.parent_context.token_count);
        if (r.parent_context.truncated) parentTruncationCount += 1;
      } else if (r.expansion_reason === "NO_PARENT_CONTEXT_AVAILABLE") {
        parentMissingCount += 1;
      } else if (r.expansion_reason === "TOTAL_EXPANSION_BUDGET_EXHAUSTED") {
        parentBudgetExhaustedCount += 1;
      }
    });
    if (isMultiCellItem && top10[0]?.metadata?.table_node_id) {
      const multiRow = expandWithMultiRowContext(top10[0], contextByTableNodeId, PARENT_EXPANSION_POLICY);
      if (multiRow.multi_row_context) {
        multiRowAttachedCount += 1;
        parentContextTokenCounts.push(multiRow.multi_row_context.token_count);
        if (multiRow.multi_row_context.truncated) parentTruncationCount += 1;
      } else if (multiRow.reason === "NO_MULTI_ROW_CONTEXT_AVAILABLE") {
        multiRowMissingCount += 1;
      }
    }

    perItemResults.push({ ...itemMetrics, skipped_no_candidates: false, candidate_pool_size: filteredChunks.length, cell_level_metrics: cellLevelMetrics });
  }

  const aggregate = aggregateStrategyMetrics(perItemResults);
  const embedTextsForStorage = new Set(searchEligible.map((c) => c.embed_text));
  const sortedTokenCounts = [...parentContextTokenCounts].sort((a, b) => a - b);

  return {
    kind,
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    total_unique_embed_texts_corpus_wide: embedTextsForStorage.size,
    embedding_cache: embeddingCache.stats(),
    truncation_count: truncationCount,
    retry_count: retryCount,
    failure_count: failureCount,
    ...aggregate,
    latency_ms: {
      bm25_p50: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.5), bm25_p95: percentile([...bm25LatenciesMs].sort((a, b) => a - b), 0.95),
      dense_p50: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.5), dense_p95: percentile([...denseLatenciesMs].sort((a, b) => a - b), 0.95),
      dense_max: [...denseLatenciesMs].sort((a, b) => a - b).at(-1) ?? null,
    },
    peak_rss_bytes: process.memoryUsage().rss,
    wall_time_ms: Date.now() - startedAt,
    late_parent_expansion: {
      selected_child_count: selectedChildCount,
      parent_attached_count: parentAttachedCount,
      parent_missing_count: parentMissingCount,
      parent_budget_exhausted_count: parentBudgetExhaustedCount,
      multi_row_attached_count: multiRowAttachedCount,
      multi_row_missing_count: multiRowMissingCount,
      context_tokens: { p50: percentile(sortedTokenCounts, 0.5), p95: percentile(sortedTokenCounts, 0.95), max: sortedTokenCounts.at(-1) ?? null, total: sortedTokenCounts.reduce((a, b) => a + b, 0) },
      truncation_count: parentTruncationCount,
      rank_slot_invariant_violations: rankSlotInvariantViolations,
      result_slot_count_mismatches: resultSlotCountMismatches,
      context_only_chunks_in_results_count: contextOnlyChunksInResultsCount,
    },
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
  if (!existsSync(RAW_CACHE_PATH)) throw new Error("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first");
  if (KURE.competition_status !== "ELIGIBLE_FOR_BOUNDED_CALIBRATION") throw new Error(`FAIL-CLOSED: kure_v1 is not ELIGIBLE_FOR_BOUNDED_CALIBRATION: ${KURE.competition_status}`);
  if (!existsSync(VENV_PYTHON)) throw new Error(`FAIL-CLOSED: task-owned venv not found at ${VENV_PYTHON}`);

  console.error("[p10.4-stage7] loading evaluation corpus (372 docs, 101 DEV_TUNE items)...");
  const { rawCache, goldItems, inputPinSha256 } = await loadEvaluationCorpus();
  console.error(`[p10.4-stage7] ${rawCache.length} documents, ${goldItems.length} DEV_TUNE items, input_pin=${inputPinSha256.slice(0, 16)}...`);

  const rawRecordByDocId = new Map(rawCache.map((e) => [e.document_id, e.raw_record]));
  const classifications = goldItems.map((item) => classifyGoldItemForTablesV2(item, rawRecordByDocId));
  const tableQuestionIds = new Set(classifications.filter((c) => c.is_table_item).map((c) => c.question_id));
  const itemTagsById = new Map(classifications.map((c) => [c.question_id, c.tags ?? []]));

  console.error("[p10.4-stage7] starting ONE local KURE-v1 server (reusing task-owned model cache, no redownload)...");
  const serverChild = spawn(VENV_PYTHON, [
    path.join(ROOT, "scripts/embedding-calibration-real/local_embedding_server.py"),
    "--repository-id", KURE.repository_id, "--revision", KURE.immutable_revision, "--cache-dir", HF_CACHE_DIR,
    "--expected-dimension", String(KURE.embedding_dimension), "--expected-max-input-length", String(KURE.max_input_length), "--port", "0",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  const results = [];
  try {
    const port = await waitForServerReady(serverChild);
    const baseUrl = `http://127.0.0.1:${port}`;
    const infoResponse = await fetch(`${baseUrl}/info`).then((r) => r.json());
    if (infoResponse.repository_id !== KURE.repository_id || infoResponse.model_revision !== KURE.immutable_revision || infoResponse.embedding_dimension !== KURE.embedding_dimension) {
      throw new Error(`FAIL-CLOSED: server identity mismatch: ${JSON.stringify(infoResponse)}`);
    }
    if (infoResponse.device !== "mps") throw new Error(`FAIL-CLOSED: MPS device policy violated -- server reports device="${infoResponse.device}"`);
    console.error(`[p10.4-stage7] server ready on ${baseUrl}, device=${infoResponse.device}`);

    const adapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "local-task-cache", model: KURE.repository_id,
      revision: KURE.immutable_revision, dimension: KURE.embedding_dimension, endpoint_url: `${baseUrl}/v1/embeddings`, auth_mode: "NONE", timeout_ms: 120000,
    });

    await mkdir(OUT_DIR, { recursive: true });
    for (const kind of ["fixed", "adaptive"]) {
      // Turn P10.4-R / Section I: reuse a checkpoint ONLY if its input pin
      // AND config/model revision match current -- otherwise recompute.
      // This run starts clean (superseded-before-correction/ holds the
      // only prior artifact, and it is never a valid checkpoint), so both
      // combinations run fresh.
      const checkpointPath = path.join(OUT_DIR, `stage7-checkpoint-${kind}.v0.1.json`);
      let reused = null;
      if (existsSync(checkpointPath)) {
        try {
          const existing = JSON.parse(await readFile(checkpointPath, "utf8"));
          if (existing.status === "COMPLETE" && existing.input_pin_sha256 === inputPinSha256
            && existing.kure_repository_id === KURE.repository_id && existing.kure_revision === KURE.immutable_revision
            && existing.chunking_config_id === (kind === "fixed" ? BASE_FIXED_CONFIG_ID : ADAPTIVE_POLICY_ID)) {
            reused = existing.result;
          }
        } catch { /* corrupt/partial checkpoint -- fall through to recompute */ }
      }

      let result;
      if (reused) {
        console.error(`[p10.4-stage7] combination KURE-v1 x ${kind}: reusing matching checkpoint (input_pin + config/revision match)`);
        result = reused;
      } else {
        console.error(`[p10.4-stage7] combination KURE-v1 x ${kind}: BM25/Dense/RRF over ${goldItems.length} items (concurrency 1)...`);
        // eslint-disable-next-line no-await-in-loop
        result = await runCombination({ kind, rawCache, goldItems, adapter, rawRecordByDocId, itemTagsById });
        console.error(`[p10.4-stage7] ${kind}: done in ${result.wall_time_ms}ms, macro_recall@10=${result.macro_evidence_recall_at_k[10]}`);
        // eslint-disable-next-line no-await-in-loop
        await writeAtomicJson(checkpointPath, {
          schema_version: "0.1.0",
          status: "COMPLETE",
          input_pin_sha256: inputPinSha256,
          kure_repository_id: KURE.repository_id,
          kure_revision: KURE.immutable_revision,
          chunking_config_id: kind === "fixed" ? BASE_FIXED_CONFIG_ID : ADAPTIVE_POLICY_ID,
          result_sha256: sha256Hex(result),
          generated_at: new Date().toISOString(),
          result,
        });
      }
      results.push(result);
      // eslint-disable-next-line no-await-in-loop
      await writeFile(path.join(OUT_DIR, "stage7-kure-dev-tune.IN_PROGRESS.v0.1.json"), `${JSON.stringify({ completed: results.map((r) => r.kind) }, null, 2)}\n`);
    }
  } finally {
    await stopServer(serverChild);
  }

  const [fixedResult, adaptiveResult] = results;

  // Non-table item comparison: do Fixed and Adaptive produce the SAME
  // ranking for non-table items (they should -- non-table chunks are
  // byte-identical, and their embed_text is identical, so BM25/dense/RRF
  // over the SAME candidate set must agree exactly). NOTE (Turn P10.4-R /
  // Section J): for TABLE items, Fixed's and Adaptive's candidate sets
  // legitimately differ (Adaptive introduces new table-aware child chunk
  // types) -- exact-ranking equality is never expected or checked there.
  const nonTableComparison = [];
  for (const item of goldItems) {
    if (tableQuestionIds.has(item.question_id)) continue;
    const fixedItem = fixedResult.per_item_results.find((r) => r.question_id === item.question_id);
    const adaptiveItem = adaptiveResult.per_item_results.find((r) => r.question_id === item.question_id);
    const identical = fixedItem && adaptiveItem
      && JSON.stringify(fixedItem.evidence_slot_coverage_fraction_at_k) === JSON.stringify(adaptiveItem.evidence_slot_coverage_fraction_at_k)
      && fixedItem.reciprocal_rank === adaptiveItem.reciprocal_rank;
    nonTableComparison.push({ question_id: item.question_id, identical });
  }
  const nonTableRegressionDetected = nonTableComparison.some((c) => !c.identical);

  // Table-only sub-metrics (macro over table question_ids).
  function tableMacro(result) {
    const rows = result.per_item_results.filter((r) => tableQuestionIds.has(r.question_id));
    const withSlots = rows.filter((r) => r.has_required_slots);
    return {
      table_item_count: rows.length,
      table_recall_at_5: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["5"])),
      table_recall_at_10: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["10"])),
      table_recall_at_20: mean(rows.map((r) => r.evidence_slot_coverage_fraction_at_k?.["20"])),
      table_mrr: mean(withSlots.map((r) => r.reciprocal_rank)),
      table_ndcg_at_10: mean(withSlots.map((r) => r.ndcg_at_10)),
    };
  }

  // Turn P10.4-R / Section J: cell-level sub-metrics, macro-averaged over
  // table items that actually resolved at least one ground-truth cell
  // (items entirely excluded via the 4 pinned parse-limited sources
  // contribute null and are excluded from the mean, never scored as 0).
  function tableCellLevelMacro(result) {
    const rows = result.per_item_results.filter((r) => r.cell_level_metrics !== null && r.cell_level_metrics !== undefined);
    const multiCellRows = rows.filter((r) => r.cell_level_metrics.multi_cell_complete_evidence !== null);
    return {
      items_with_resolved_cells: rows.length,
      cell_level_recall_at_10: mean(rows.map((r) => r.cell_level_metrics.cell_level_recall)),
      row_header_aware_recall_at_10: mean(rows.map((r) => r.cell_level_metrics.row_header_aware_recall)),
      period_column_aware_recall_at_10: mean(rows.map((r) => r.cell_level_metrics.period_column_aware_recall)),
      explicit_unit_aware_recall_at_10: mean(rows.map((r) => r.cell_level_metrics.explicit_unit_aware_recall)),
      multi_cell_complete_evidence_recall_at_10: multiCellRows.length > 0 ? mean(multiCellRows.map((r) => r.cell_level_metrics.multi_cell_complete_evidence)) : null,
      multi_cell_item_count: multiCellRows.length,
    };
  }

  const perItemLines = [];
  const combosForFile = results.map((r) => {
    const { per_item_results: perItem, ...rest } = r;
    for (const item of perItem) perItemLines.push(JSON.stringify({ kind: r.kind, ...item }));
    return rest;
  });

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    kure_repository_id: KURE.repository_id, kure_revision: KURE.immutable_revision, kure_dimension: KURE.embedding_dimension,
    query_prefix: KURE.query_prefix, document_prefix: KURE.document_prefix,
    input_pin_sha256: inputPinSha256,
    common_conditions: { dev_tune_item_count: goldItems.length, document_count: rawCache.length, bm25_candidates_per_item: BM25_CANDIDATES_PER_ITEM, return_top_k: RETURN_TOP_K, rrf_k_constant: 60, concurrency: 1, model_servers_at_once: 1 },
    table_evaluation_item_count: tableQuestionIds.size,
    combinations: combosForFile,
    combinations_table_only: results.map((r) => ({ kind: r.kind, ...tableMacro(r) })),
    combinations_table_cell_level: results.map((r) => ({ kind: r.kind, ...tableCellLevelMacro(r) })),
    non_table_comparison: {
      items_compared: nonTableComparison.length, identical_count: nonTableComparison.filter((c) => c.identical).length,
      regression_detected: nonTableRegressionDetected, mismatches: nonTableComparison.filter((c) => !c.identical),
      note: "Fixed/Adaptive candidate sets for TABLE items may legitimately differ (Adaptive introduces new table-aware child chunk types) -- exact-ranking equality is checked here ONLY for non-table items, never for table items.",
    },
  };
  await writeFile(path.join(OUT_DIR, "adaptive-kure-dev-tune-comparison.v0.1.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "stage7-per-item-results.v0.1.jsonl"), `${perItemLines.join("\n")}\n`);

  // Turn P10.4-R / Section F: late-parent-expansion report, real measured
  // numbers only -- no raw Gold text, counts/stats only.
  const adaptiveExpansion = adaptiveResult.late_parent_expansion;
  const expansionReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    policy: PARENT_EXPANSION_POLICY,
    adaptive: adaptiveExpansion,
    fixed_structural_no_op_check: fixedResult.late_parent_expansion, // Fixed carries no table_node_id -- expected all-zero/no-op, checked not just assumed
    invariants: {
      rank_slot_invariant_violations_total: adaptiveExpansion.rank_slot_invariant_violations + fixedResult.late_parent_expansion.rank_slot_invariant_violations,
      result_slot_count_mismatches_total: adaptiveExpansion.result_slot_count_mismatches + fixedResult.late_parent_expansion.result_slot_count_mismatches,
      context_only_chunks_in_results_count_total: adaptiveExpansion.context_only_chunks_in_results_count + fixedResult.late_parent_expansion.context_only_chunks_in_results_count,
    },
  };
  await writeFile(path.join(OUT_DIR, "adaptive-late-parent-expansion-report.v0.1.json"), `${JSON.stringify(expansionReport, null, 2)}\n`);

  console.log(JSON.stringify({
    status: "OK",
    fixed_recall_at_10: fixedResult.macro_evidence_recall_at_k[10], adaptive_recall_at_10: adaptiveResult.macro_evidence_recall_at_k[10],
    fixed_table_recall_at_10: tableMacro(fixedResult).table_recall_at_10, adaptive_table_recall_at_10: tableMacro(adaptiveResult).table_recall_at_10,
    non_table_regression_detected: nonTableRegressionDetected,
    late_parent_expansion_rank_slot_invariant_violations: expansionReport.invariants.rank_slot_invariant_violations_total,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.4-stage7-kure-dev-tune-comparison] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
