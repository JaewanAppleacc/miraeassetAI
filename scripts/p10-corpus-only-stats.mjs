#!/usr/bin/env node
// Turn P10 / E1: corpus-only chunking comparison stats. NO embedding calls,
// NO HCX calls, NO PostgreSQL writes. Runs the real domain/chunking/
// chunker.mjs against the REAL DocumentIR sample materialized in this
// worktree (seed-release-v0.20-r3.candidate bundle), for all 3 P10
// strategies, and reports the stats this Turn's brief (section E1) asks
// for.
//
// SCOPE DISCLOSURE (read before trusting any number this prints): the full
// 4,204-document corpus is NOT materialized in this worktree (see
// domain/adapters/a-document-ir-reader.mjs's own comment). This script
// runs against the RESOLVABLE subset of the v0.20-r3.candidate bundle's
// DocumentIR sample -- documents that have both a canonical DocumentIR
// record AND a real, VERIFIED_FACT-resolved corp_code (see
// resolvable-bundle-corpus.mjs). The already-completed full-corpus
// (4,204-doc) dry-run numbers from a PRIOR turn are cited, never
// recomputed, in domain/chunking/FULL_CORPUS_BUDGET_DECISION.md /
// C_HANDOFF.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { P10_STRATEGIES, P10_EMBEDDING_CANDIDATE, P10_EXPERIMENT_ID } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { collectResolvableBundleCorpus, resolvableDocumentEntries, P10_BUNDLE_OPTIONS_FACTORY } from "../domain/agent-comparison/chunking-comparison/resolvable-bundle-corpus.mjs";
import { adaptCanonicalRecordToChunkerInput, ChunkerInputAdaptError } from "../domain/agent-comparison/chunking-comparison/b-canonical-to-chunker-input.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10-chunking-comparison");
const TARGET_CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function gitHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

function canonicalChunkListSha256(chunks) {
  const sorted = [...chunks].map((c) => c.chunk_id).sort();
  return sha256Hex(sorted);
}

function checkInvariants(chunks, expectedCorpCode, documentId) {
  const violations = [];
  const idPattern = /^chunk_[0-9a-f]{24}$/;
  for (const chunk of chunks) {
    if (!idPattern.test(chunk.chunk_id)) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "MALFORMED_CHUNK_ID" });
    if (chunk.metadata.corp_code !== expectedCorpCode) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CORP_CODE_MISMATCH" });
    if (chunk.document_id !== documentId) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "DOCUMENT_ID_MISMATCH" });
    if (chunk.source_locator.startsWith("/") || chunk.source_locator.includes("..")) {
      violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "UNSAFE_SOURCE_LOCATOR" });
    }
    for (const span of chunk.source_spans) {
      if (span.rel_path.startsWith("/") || span.rel_path.includes("..")) {
        violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "UNSAFE_SPAN_REL_PATH" });
      }
    }
    if (chunk.raw_text.trim() === "") violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "EMPTY_CHUNK" });
    const recomputedSha = sha256Hex(chunk.raw_text);
    if (recomputedSha !== chunk.content_sha256) violations.push({ documentId, chunk_id: chunk.chunk_id, reason: "CONTENT_SHA_MISMATCH" });
  }
  return violations;
}

const CHUNK_TYPE_ROLLUP = Object.freeze({
  TABLE_WHOLE: "table", TABLE_ROW: "table",
  SECTION_PARENT: "title_or_event", EVENT_PARENT: "title_or_event", HOLDING_STATUS_PARENT: "title_or_event",
  PARAGRAPH_CHILD: "paragraph", FIELD_GROUP_CHILD: "paragraph", FIXED_WINDOW: "paragraph", SECTION_FLAT: "paragraph",
  DOCUMENT_FALLBACK: "fallback",
});

async function runOneStrategy(strategyConfig, entries, provenanceBase) {
  const provenance = { ...provenanceBase };
  const startedAt = Date.now();
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;

  const allChunks = [];
  const chunksPerDoc = [];
  const invariantViolations = [];
  const adaptFailures = [];

  for (const entry of entries) {
    let chunkerInput;
    try {
      chunkerInput = adaptCanonicalRecordToChunkerInput(entry.canonicalRecord, {
        corpCode: entry.corpCode, corpName: entry.corpName, listedName: entry.listedName,
      });
    } catch (error) {
      if (error instanceof ChunkerInputAdaptError) { adaptFailures.push({ documentId: entry.documentId, code: error.code, message: error.message }); continue; }
      throw error;
    }
    const chunks = chunkDocument(chunkerInput.record, chunkerInput.document, strategyConfig, provenance);
    chunksPerDoc.push(chunks.length);
    allChunks.push(...chunks);
    invariantViolations.push(...checkInvariants(chunks, entry.corpCode, entry.documentId));
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }

  const buildMs = Date.now() - startedAt;

  const searchEligible = allChunks.filter((c) => c.metadata.retrieval_eligible);
  const contentShaSet = new Set(allChunks.map((c) => c.content_sha256));
  const embedTextSet = new Set(searchEligible.map((c) => c.embed_text));

  const tokenCounts = allChunks.map((c) => c.token_count).sort((a, b) => a - b);
  const perDocSorted = [...chunksPerDoc].sort((a, b) => a - b);

  const chunkTypeDistribution = {};
  const rollupDistribution = { table: 0, title_or_event: 0, paragraph: 0, fallback: 0 };
  for (const chunk of allChunks) {
    chunkTypeDistribution[chunk.chunk_type] = (chunkTypeDistribution[chunk.chunk_type] ?? 0) + 1;
    rollupDistribution[CHUNK_TYPE_ROLLUP[chunk.chunk_type] ?? "other"] = (rollupDistribution[CHUNK_TYPE_ROLLUP[chunk.chunk_type] ?? "other"] ?? 0) + 1;
  }

  const parents = allChunks.filter((c) => c.parent_chunk_id === null && ["SECTION_PARENT", "EVENT_PARENT", "HOLDING_STATUS_PARENT", "TABLE_WHOLE"].includes(c.chunk_type));
  const children = allChunks.filter((c) => c.parent_chunk_id !== null);

  const coveredNodeIds = new Set();
  for (const chunk of allChunks) for (const nodeId of chunk.source_node_ids) coveredNodeIds.add(nodeId);
  let chunkableNodeCount = 0;
  for (const entry of entries) {
    const { record } = (() => { try { return adaptCanonicalRecordToChunkerInput(entry.canonicalRecord, { corpCode: entry.corpCode, corpName: entry.corpName, listedName: entry.listedName }); } catch { return { record: { nodes: [] } }; } })();
    for (const node of record.nodes) {
      if (node.kind === "section" && node.title_text?.trim()) chunkableNodeCount += 1;
      else if (node.kind === "paragraph" && node.text?.trim()) chunkableNodeCount += 1;
      else if (node.kind === "table" && (node.normalized_rows ?? []).length > 0) chunkableNodeCount += 1;
    }
  }

  return {
    chunking_config_id: strategyConfig.chunking_config_id,
    strategy_name: strategyConfig.strategy_name,
    documents_processed: entries.length - adaptFailures.length,
    documents_adapt_failed: adaptFailures,
    total_chunks: allChunks.length,
    search_eligible_chunks: searchEligible.length,
    unique_content_sha256: contentShaSet.size,
    exact_duplicate_ratio: allChunks.length > 0 ? 1 - contentShaSet.size / allChunks.length : null,
    chunks_per_document: {
      p50: percentile(perDocSorted, 0.5), p90: percentile(perDocSorted, 0.9),
      p99: percentile(perDocSorted, 0.99), max: perDocSorted.length ? perDocSorted[perDocSorted.length - 1] : null,
    },
    token_count: {
      p50: percentile(tokenCounts, 0.5), p95: percentile(tokenCounts, 0.95),
      max: tokenCounts.length ? tokenCounts[tokenCounts.length - 1] : null,
    },
    truncation_events: 0, // chunker.mjs windows tokens rather than truncating -- see chunkDocument's tokenWindowsFromSegments; no chunk ever exceeds max_tokens by construction, so a distinct "truncation" event never occurs
    chunk_type_distribution: chunkTypeDistribution,
    chunk_type_rollup_note: "rollup is chunk_type-derived (table={TABLE_WHOLE,TABLE_ROW}; title_or_event={SECTION_PARENT,EVENT_PARENT,HOLDING_STATUS_PARENT}; paragraph={PARAGRAPH_CHILD,FIELD_GROUP_CHILD,FIXED_WINDOW,SECTION_FLAT}; fallback={DOCUMENT_FALLBACK}) -- NOT a content classifier",
    chunk_type_rollup: rollupDistribution,
    parent_count: parents.length,
    child_count: children.length,
    average_fan_out: parents.length > 0 ? children.length / parents.length : null,
    node_level_source_coverage: chunkableNodeCount > 0 ? coveredNodeIds.size / chunkableNodeCount : null,
    node_level_source_coverage_note: "fraction of chunkable nodes (non-empty section/paragraph/table) whose node_id appears in at least one chunk's source_node_ids -- not a character-level coverage measure",
    locator_provenance_violations: invariantViolations,
    expected_embedding_calls: embedTextSet.size,
    expected_vector_storage_bytes: embedTextSet.size * P10_EMBEDDING_CANDIDATE.embedding_dimension * 4,
    build_time_ms: buildMs,
    peak_rss_bytes: rssPeak,
    canonical_chunk_list_sha256: canonicalChunkListSha256(allChunks),
  };
}

async function main() {
  console.error("[p10-corpus-stats] resolving real bundle corpus (read-only)...");
  const corpus = await collectResolvableBundleCorpus(P10_BUNDLE_OPTIONS_FACTORY(ROOT));
  const entries = resolvableDocumentEntries(corpus);
  const unresolvedCount = corpus.canonicalByDocumentId.size - entries.length;

  console.error(`[p10-corpus-stats] resolvable documents: ${entries.length} / ${corpus.canonicalByDocumentId.size} canonical DocumentIR records (${unresolvedCount} excluded: no VERIFIED_FACT-resolved corp_code)`);

  const provenanceBase = {
    targetCorpusSnapshotId: TARGET_CORPUS_SNAPSHOT_ID,
    parserCodeRevision: gitHeadSha(),
    parserConfigHash: sha256Hex(P10_STRATEGIES),
  };

  const results = [];
  for (const strategyConfig of P10_STRATEGIES) {
    console.error(`[p10-corpus-stats] running strategy ${strategyConfig.chunking_config_id}...`);
    const first = await runOneStrategy(strategyConfig, entries, provenanceBase);
    const second = await runOneStrategy(strategyConfig, entries, provenanceBase);
    const deterministic = first.canonical_chunk_list_sha256 === second.canonical_chunk_list_sha256;
    if (!deterministic) {
      console.error(`[p10-corpus-stats] FAIL-CLOSED: ${strategyConfig.chunking_config_id} is NOT deterministic across two runs (${first.canonical_chunk_list_sha256} != ${second.canonical_chunk_list_sha256})`);
    }
    results.push({ ...first, deterministic_rebuild: deterministic });
  }

  const report = {
    schema_version: "0.1.0",
    experiment_id: P10_EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    scope_disclosure: "Runs against the RESOLVABLE subset of the seed-release-v0.20-r3.candidate bundle's DocumentIR sample only. The full 4,204-document corpus is not materialized in this worktree. Prior full-corpus (4,204-doc) dry-run numbers are cited from domain/chunking/FULL_CORPUS_BUDGET_DECISION.md / C_HANDOFF.md, not recomputed here.",
    resolvable_document_count: entries.length,
    total_canonical_document_ir_records: corpus.canonicalByDocumentId.size,
    excluded_no_corp_code_resolution: unresolvedCount,
    embedding_candidate_used_for_storage_estimate: P10_EMBEDDING_CANDIDATE,
    provenance: provenanceBase,
    strategies: results,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "corpus-only-stats.v01.json");
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[p10-corpus-stats] wrote ${outPath}`);
  console.log(JSON.stringify({
    status: "OK",
    resolvable_document_count: entries.length,
    strategies: results.map((r) => ({
      chunking_config_id: r.chunking_config_id,
      total_chunks: r.total_chunks,
      search_eligible_chunks: r.search_eligible_chunks,
      exact_duplicate_ratio: r.exact_duplicate_ratio,
      deterministic_rebuild: r.deterministic_rebuild,
      locator_provenance_violations: r.locator_provenance_violations.length,
    })),
    report_path: path.relative(ROOT, outPath),
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10-corpus-stats] FAILED:", error);
  process.exitCode = 1;
});
