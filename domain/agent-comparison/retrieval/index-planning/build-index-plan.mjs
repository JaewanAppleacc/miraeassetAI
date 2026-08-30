// Turn P5.1: orchestrates one streaming pass over Turn P5's already-built
// document-chunks.v0.1.jsonl (+ a small read of document-records.v0.1.jsonl)
// to produce a retrieval-index SIZING/DEDUP/BOILERPLATE PLAN. This module
// NEVER writes to the Turn P5 snapshot directory, never calls a real
// embedding API, and never opens a database connection.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./contracts.mjs";
import { createLengthAnalysisAccumulator } from "./length-analysis.mjs";
import { createDuplicateAnalysisAccumulator } from "./duplicate-analysis.mjs";
import { buildBoilerplateCandidateAnalysis, DEFAULT_THRESHOLDS } from "./boilerplate-rules.mjs";
import { buildStrategyComparison } from "./strategy-comparison.mjs";
import { embeddingCostRangeFormula } from "./embedding-size-model.mjs";
import { createAtomicJsonlWriter, writeJsonFileAtomic } from "../document-snapshot/snapshot-writer.mjs";

export class IndexPlanBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndexPlanBuildError";
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Fail-closed pin verification, run BEFORE the expensive streaming pass:
// the small, already-computed manifest's own declared pins must match the
// caller-supplied expected pins EXACTLY. This does not yet re-hash the 2.9GB
// chunk file (that would double the I/O cost of this Turn) -- the
// streaming pass below recomputes that hash incrementally and asserts it
// again at the very end, so a corrupted/modified file is still caught,
// just after (not before) the one pass this Turn needs anyway.
async function verifyDeclaredPins(snapshotDir, expectedPins) {
  const manifest = await readJson(join(snapshotDir, "document-snapshot-manifest.v0.1.json"));
  const parseStatusReport = await readJson(join(snapshotDir, "parse-status-report.v0.1.json"));
  const gateStatus = await readJson(join(snapshotDir, "gate-status.v0.1.json"));
  const portabilityReport = await readJson(join(snapshotDir, "portability-report.v0.1.json"));
  const determinismReport = await readJson(join(snapshotDir, "determinism-rebuild-report.v0.1.json"));
  const p4CompatReport = await readJson(join(snapshotDir, "p4-document-chunk-compatibility-report.v0.1.json"));

  const checks = [
    ["snapshot_id", manifest.snapshot_id, expectedPins.snapshotId],
    ["total_documents", manifest.total_documents, expectedPins.totalDocuments],
    ["total_chunks", manifest.total_chunks, expectedPins.totalChunks],
    ["document_chunks_file.sha256", manifest.document_chunks_file.sha256, expectedPins.documentChunksSha256],
    ["document_records_file.sha256", manifest.document_records_file.sha256, expectedPins.documentRecordsSha256],
    ["coverage_state_counts.PRESENT", manifest.coverage_state_counts.PRESENT, expectedPins.coverageStateCounts.PRESENT],
    ["coverage_state_counts.PARTIAL_PARSE_FAILURE", manifest.coverage_state_counts.PARTIAL_PARSE_FAILURE, expectedPins.coverageStateCounts.PARTIAL_PARSE_FAILURE],
    ["coverage_state_counts.PARSE_FAILED", manifest.coverage_state_counts.PARSE_FAILED, expectedPins.coverageStateCounts.PARSE_FAILED],
    ["gate-status.overall_status", gateStatus.overall_status, "GATE_PASSED"],
    ["portability-report.status", portabilityReport.status, "PASS"],
    ["determinism-rebuild-report.status", determinismReport.status, "PASS"],
    ["p4-document-chunk-compatibility-report.status", p4CompatReport.status, "PASS"],
  ];
  const failures = checks.filter(([, actual, expected]) => actual !== expected);
  if (failures.length > 0) {
    throw new IndexPlanBuildError(
      `input pin verification failed -- fail-closed: ${failures.map(([label, actual, expected]) => `${label} expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`).join("; ")}`,
    );
  }
  if (parseStatusReport.total_documents !== expectedPins.totalDocuments) {
    throw new IndexPlanBuildError(`parse-status-report.v0.1.json total_documents mismatch: expected ${expectedPins.totalDocuments}, found ${parseStatusReport.total_documents}`);
  }
  return { manifest, parseStatusReport };
}

async function loadDocumentRecords(snapshotDir) {
  const byId = new Map();
  const rl = createInterface({ input: createReadStream(join(snapshotDir, "document-records.v0.1.jsonl")), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (byId.has(record.source_document_id)) {
      throw new IndexPlanBuildError(`document-records.v0.1.jsonl: duplicate source_document_id ${record.source_document_id}`);
    }
    byId.set(record.source_document_id, record);
  }
  return byId;
}

// A deterministic sample: the top-K hashes by occurrence count from pass 1
// (the highest-value case to prove safe -- these are exactly the hashes
// Strategy B's dedup would collapse the most).
function selectSampleHashes(duplicateAccumulator, sampleSize) {
  return [...duplicateAccumulator.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, sampleSize)
    .map(([hash]) => hash);
}

// A SECOND, targeted streaming pass collecting full occurrence lists ONLY
// for the pre-selected sample hashes (bounded memory: a fixed, small set of
// hashes, each capped at maxOccurrencesStored actual entries plus an exact
// running count beyond the cap).
async function verifySampleOccurrenceReconstruction(chunksPath, sampleHashes, duplicateAccumulator, { maxOccurrencesStored = 500 } = {}) {
  const sampleSet = new Set(sampleHashes);
  const collected = new Map(sampleHashes.map((hash) => [hash, { count: 0, occurrences: [] }]));

  const rl = createInterface({ input: createReadStream(chunksPath), crlfDelay: Infinity, highWaterMark: 1024 * 1024 });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (!sampleSet.has(chunk.text_sha256)) continue;
    const bucket = collected.get(chunk.text_sha256);
    bucket.count += 1;
    if (bucket.occurrences.length < maxOccurrencesStored) {
      bucket.occurrences.push({ chunk_id: chunk.chunk_id, source_document_id: chunk.source_document_id, source_locator: chunk.source_locator });
    }
  }

  const results = [];
  for (const hash of sampleHashes) {
    const bucket = collected.get(hash);
    const expected = duplicateAccumulator.get(hash);
    const uniqueChunkIds = new Set(bucket.occurrences.map((o) => o.chunk_id));
    results.push({
      text_sha256: hash,
      expected_count_from_pass1: expected.count,
      reconstructed_count_from_pass2: bucket.count,
      counts_match: expected.count === bucket.count,
      occurrences_sampled: bucket.occurrences.length,
      sampled_occurrence_chunk_ids_all_unique: uniqueChunkIds.size === bucket.occurrences.length,
      sample_occurrences: bucket.occurrences.slice(0, 5),
    });
  }
  return results;
}

export async function buildRetrievalIndexPlan({
  snapshotDir,
  outputDir,
  expectedPins,
  completedAt = new Date().toISOString(),
  toolVersion = "0.1.0",
  sampleSize = 20,
}) {
  const { manifest } = await verifyDeclaredPins(snapshotDir, expectedPins);
  const documentRecords = await loadDocumentRecords(snapshotDir);
  if (documentRecords.size !== expectedPins.totalDocuments) {
    throw new IndexPlanBuildError(`document-records.v0.1.jsonl has ${documentRecords.size} rows, expected ${expectedPins.totalDocuments}`);
  }

  const chunksPath = join(snapshotDir, "document-chunks.v0.1.jsonl");
  const lengthAnalysis = createLengthAnalysisAccumulator({ tableMaxChunkChars: 1200 });
  const duplicateAnalysis = createDuplicateAnalysisAccumulator();
  const runningHash = createHash("sha256");
  const seenChunkIds = new Set();
  let duplicateChunkIdCount = 0;
  let unknownDocumentIdCount = 0;
  let totalChunksStreamed = 0;

  const rl = createInterface({ input: createReadStream(chunksPath), crlfDelay: Infinity, highWaterMark: 1024 * 1024 });
  for await (const rawLine of rl) {
    if (!rawLine.trim()) continue;
    runningHash.update(rawLine, "utf8");
    runningHash.update("\n");
    const chunk = JSON.parse(rawLine);
    totalChunksStreamed += 1;
    if (seenChunkIds.has(chunk.chunk_id)) duplicateChunkIdCount += 1;
    seenChunkIds.add(chunk.chunk_id);
    if (!documentRecords.has(chunk.source_document_id)) unknownDocumentIdCount += 1;
    lengthAnalysis.add(chunk);
    duplicateAnalysis.add(chunk);
  }

  const recomputedChunksSha256 = runningHash.digest("hex");
  if (recomputedChunksSha256 !== expectedPins.documentChunksSha256) {
    throw new IndexPlanBuildError(
      `document-chunks.v0.1.jsonl recomputed sha256 (${recomputedChunksSha256}) does not match the expected pin (${expectedPins.documentChunksSha256}) -- fail-closed, the Turn P5 snapshot may have been modified`,
    );
  }
  if (totalChunksStreamed !== expectedPins.totalChunks) {
    throw new IndexPlanBuildError(`streamed ${totalChunksStreamed} chunks, expected ${expectedPins.totalChunks}`);
  }
  if (duplicateChunkIdCount > 0) {
    throw new IndexPlanBuildError(`found ${duplicateChunkIdCount} duplicate chunk_id values in document-chunks.v0.1.jsonl -- the Turn P5 snapshot's own uniqueness invariant is violated`);
  }
  if (unknownDocumentIdCount > 0) {
    throw new IndexPlanBuildError(`found ${unknownDocumentIdCount} chunks referencing a source_document_id absent from document-records.v0.1.jsonl`);
  }

  const lengthAnalysisJson = lengthAnalysis.toJSON();
  const duplicateAnalysisJson = duplicateAnalysis.toJSON({ topN: 50 });
  if (!duplicateAnalysisJson.occurrences_match_total_chunks) {
    throw new IndexPlanBuildError("exact-duplicate accumulator's sum of occurrences does not match total chunks streamed -- fail-closed");
  }

  const boilerplateAnalysisJson = buildBoilerplateCandidateAnalysis(duplicateAnalysis, { totalDocuments: expectedPins.totalDocuments, thresholds: DEFAULT_THRESHOLDS, topN: 50 });

  const sampleHashes = selectSampleHashes(duplicateAnalysis, sampleSize);
  const reconstructionResults = await verifySampleOccurrenceReconstruction(chunksPath, sampleHashes, duplicateAnalysis);
  const reconstructionAllMatch = reconstructionResults.every((r) => r.counts_match && r.sampled_occurrence_chunk_ids_all_unique);
  if (!reconstructionAllMatch) {
    throw new IndexPlanBuildError("occurrence reconstruction sample verification failed -- dedup provenance is not safely reconstructible for at least one sampled hash");
  }

  const strategyComparison = buildStrategyComparison({
    lengthAnalysis: lengthAnalysisJson,
    duplicateAnalysis: duplicateAnalysisJson,
    boilerplateAnalysis: boilerplateAnalysisJson,
    totalDocuments: expectedPins.totalDocuments,
  });

  // --- write outputs (atomic, additive-only, never touching the P5 snapshot) ---
  // Deliberately no path fields (local/absolute) are persisted here -- this
  // Turn's outputs must stay portable exactly like Turn P5's own snapshot.
  const inputPinManifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: completedAt,
    tool_version: toolVersion,
    expected_pins: expectedPins,
    verified_manifest_snapshot_id: manifest.snapshot_id,
    recomputed_document_chunks_sha256: recomputedChunksSha256,
    total_chunks_streamed: totalChunksStreamed,
  };
  await writeJsonFileAtomic(join(outputDir, "input-pin-manifest.v0.1.json"), inputPinManifest);
  await writeJsonFileAtomic(join(outputDir, "chunk-length-analysis.v0.1.json"), { schema_version: SCHEMA_VERSION, generated_at: completedAt, ...lengthAnalysisJson });
  await writeJsonFileAtomic(join(outputDir, "exact-duplicate-analysis.v0.1.json"), { schema_version: SCHEMA_VERSION, generated_at: completedAt, ...duplicateAnalysisJson });
  await writeJsonFileAtomic(join(outputDir, "boilerplate-candidate-analysis.v0.1.json"), { schema_version: SCHEMA_VERSION, generated_at: completedAt, ...boilerplateAnalysisJson });
  await writeJsonFileAtomic(join(outputDir, "embedding-size-scenarios.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    generated_at: completedAt,
    cost_formula: embeddingCostRangeFormula(),
    cost_formula_note: "No provider/model price is hard-coded anywhere in this Turn. Evaluate the formula yourself with your own price_per_million_tokens.",
    strategies: strategyComparison,
  });
  await writeJsonFileAtomic(join(outputDir, "retrieval-index-strategy-comparison.v0.1.json"), { schema_version: SCHEMA_VERSION, generated_at: completedAt, strategies: strategyComparison });

  const recommendedPlan = buildRecommendedPlan({ strategyComparison, duplicateAnalysisJson, boilerplateAnalysisJson });
  await writeJsonFileAtomic(join(outputDir, "recommended-index-plan.v0.1.json"), { schema_version: SCHEMA_VERSION, generated_at: completedAt, ...recommendedPlan });

  const provenanceReport = {
    schema_version: SCHEMA_VERSION,
    generated_at: completedAt,
    sum_of_occurrences_equals_total_chunks: duplicateAnalysisJson.occurrences_match_total_chunks,
    total_chunks: totalChunksStreamed,
    unique_text_count: duplicateAnalysisJson.unique_text_count,
    sample_hashes_verified: reconstructionResults.length,
    sample_reconstruction_all_match: reconstructionAllMatch,
    sample_reconstruction_results: reconstructionResults,
    status: reconstructionAllMatch && duplicateAnalysisJson.occurrences_match_total_chunks ? "PASS" : "FAIL",
    note: "Every original chunk_id/source_document_id/source_locator remains individually recoverable under a dedup strategy -- this is verified for a deterministic top-occurrence sample by an independent second pass over the real corpus, plus an exact whole-corpus occurrence-count conservation check.",
  };
  await writeJsonFileAtomic(join(outputDir, "provenance-preservation-report.v0.1.json"), provenanceReport);

  return {
    lengthAnalysisJson,
    duplicateAnalysisJson,
    boilerplateAnalysisJson,
    strategyComparison,
    recommendedPlan,
    provenanceReport,
    totalChunksStreamed,
    recomputedChunksSha256,
  };
}

function buildRecommendedPlan({ strategyComparison, duplicateAnalysisJson, boilerplateAnalysisJson }) {
  const dedupSavingsPercent = duplicateAnalysisJson.total_chunks_seen === 0
    ? 0
    : Math.round((duplicateAnalysisJson.embedding_calls_avoidable / duplicateAnalysisJson.total_chunks_seen) * 1000) / 10;
  return {
    primary_recommendation: "EXACT_TEXT_DEDUP_INDEX",
    primary_recommendation_rationale: [
      "Zero provenance loss: every chunk_id/source_document_id/source_locator remains individually recoverable via the occurrence map (see provenance-preservation-report.v0.1.json).",
      `Meaningfully reduces embedding calls without any content exclusion: ${duplicateAnalysisJson.embedding_calls_avoidable} of ${duplicateAnalysisJson.total_chunks_seen} chunk embeddings (${dedupSavingsPercent}%) are avoidable purely because the text is byte-identical.`,
      "Requires no change to HYBRID_RETRIEVAL/DOCUMENT_FIRST_RAG's existing retrieval semantics or the frozen retrieval-result.schema.json -- only an additional occurrence-resolution step inside the Retriever adapter.",
      "Fully deterministic: text_sha256 is already this snapshot's own stable hash.",
      "Does not require any recall claim -- deduplicating identical text changes nothing about which distinct pieces of information are searchable.",
    ],
    secondary_candidate_pending_evaluation: "PRIMARY_PLUS_COLD_FALLBACK",
    secondary_candidate_rationale: `Could further reduce embedding volume by excluding the ${boilerplateAnalysisJson.boilerplate_candidate_occurrence_count} BOILERPLATE_CANDIDATE occurrences from the primary vector index, but its recall impact is NOT evaluated against Gold in this Turn -- recommended only as the next evaluation target, not for immediate adoption.`,
    not_recommended_yet: {
      HIERARCHICAL_INDEX: "Representative-text granularity is an undecided design parameter and two-tier retrieval has not been de-risked against either existing Agent variant's semantics.",
      FULL_CHUNK_INDEX: "Safe baseline, but strictly dominated by EXACT_TEXT_DEDUP_INDEX on embedding-call and storage cost with identical provenance guarantees -- recommended only as a fallback if the dedup occurrence-mapping layer is not ready in time.",
    },
    uncertainties: [
      "No Gold-based recall evaluation was performed for any strategy in this Turn (explicitly out of scope).",
      "Token counts are a heuristic character-count-derived proxy, not a real tokenizer's output.",
      "Embedding cost and build-time figures are formulas/assumption-based ranges, not measurements from a real embedding API call.",
      "Index storage overhead ranges assume either Turn P4's current no-ANN-index design or a hypothetical future ivfflat/hnsw addition -- the actual number depends on a choice not made in this Turn.",
    ],
    decision_owner_action_required: "An Owner must select a strategy (or request a Gold-based recall evaluation of EXACT_TEXT_DEDUP_INDEX/PRIMARY_PLUS_COLD_FALLBACK first) before any real embedding or PostgreSQL load Turn begins.",
  };
}
