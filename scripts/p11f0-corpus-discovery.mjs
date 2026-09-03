#!/usr/bin/env node
// Turn P11-F0: DISCOVERY phase (Stage 3/9) of the Resumable Fixed-512-o64 x
// KURE-v1 Hybrid Retrieval Loader. Streams the real, full DocumentIR corpus
// (domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs,
// unmodified), re-chunks every document with the UNCHANGED
// fixed-token-512-o64.v0.1.0 policy read live from
// domain/chunking/strategy-configs.v0.1.json, and writes canonical
// per-chunk digests + unique-embed_text queue rows into Postgres
// (006_reference_fixed_kure_load_sessions.sql's staging tables) in bounded
// batches, checkpointed per batch.
//
// TWO INDEPENDENT PASSES, never one pass compared against itself: pass 1
// WRITES to Postgres (the actual staging data this loader needs); pass 2
// is a pure, DB-write-free re-stream + re-chunk + re-digest that only
// verifies the resulting chunk-stream sha256 is IDENTICAL to pass 1's --
// CLAUDE.md Turn P11-F0 section C's own double-pass determinism
// requirement, satisfied without paying Postgres-write cost twice.
//
// NEVER reads dev-tune-gold.v0.1.jsonl, DEV_CHECK, HOLDOUT, or any Gold
// expected-answer content -- only the raw DocumentIR corpus and
// work/domain-seed/documents.jsonl's own document_id metadata (neither is
// Gold).
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import strategyConfigs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };
import { chunkDocument } from "../domain/chunking/chunker.mjs";
import { loadDocumentMetadataIndex, toChunkerDocument } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { corpusSourceFileStats, streamAllDocuments, CORPUS_SOURCE_FILES } from "../domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs";
import { toChunkDigestRecord, createChunkStreamDigestAccumulator } from "../domain/agent-comparison/chunking-comparison/canonical-chunk-digest.mjs";
import { createFixedKureLoadSessionRepository } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN_CHECKOUT_ROOT = "/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai";
export const RAW_SOURCE_DIR = path.join(MAIN_CHECKOUT_ROOT, "work/a-document-ir/source");
export const DOCUMENTS_JSONL_PATH = path.join(MAIN_CHECKOUT_ROOT, "work/domain-seed/documents.jsonl");

// Canonical, already-established corpus snapshot id (domain/HANDOFF.md,
// domain/adapters/a-snapshot-contract.mjs's own A_TO_B_SNAPSHOT_MAP) --
// reused, never invented fresh, so this loader's index shares identity
// with every other adapter that already refers to this exact corpus.
export const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
export const EXPECTED_DOCUMENT_COUNT = 4204;
export const EXPECTED_TOTAL_BYTES = 8615531403;

export const DISCOVERY_BATCH_SIZE = 200; // documents per checkpoint batch

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalize(value[k])]));
  return value;
}
export function canonicalSha256(value) {
  return sha256Hex(JSON.stringify(canonicalize(value)));
}

export async function verifyCorpusPin() {
  const fileStats = await corpusSourceFileStats(RAW_SOURCE_DIR);
  const totalBytes = fileStats.reduce((sum, f) => sum + f.bytes, 0);
  const docsRaw = await readFile(DOCUMENTS_JSONL_PATH, "utf8");
  const documentCount = docsRaw.split("\n").filter((l) => l.trim() !== "").length;

  if (totalBytes !== EXPECTED_TOTAL_BYTES) {
    throw new Error(`CORPUS_PIN_MISMATCH: total bytes ${totalBytes} != expected ${EXPECTED_TOTAL_BYTES}`);
  }
  if (documentCount !== EXPECTED_DOCUMENT_COUNT) {
    throw new Error(`CORPUS_PIN_MISMATCH: document count ${documentCount} != expected ${EXPECTED_DOCUMENT_COUNT}`);
  }
  // Never embed the absolute path itself in the manifest -- filename + byte
  // size + relative doc_group only.
  const relativeFileStats = fileStats.map((f) => ({ doc_group: f.docGroup, filename: f.filename, bytes: f.bytes }));
  const corpusManifestSha256 = canonicalSha256({ files: relativeFileStats, document_count: documentCount });
  return { fileStats: relativeFileStats, totalBytes, documentCount, corpusManifestSha256 };
}

export function loadFixedChunkingPolicy() {
  const policy = strategyConfigs.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
  if (!policy) throw new Error("fixed-token-512-o64.v0.1.0 not found in strategy-configs.v0.1.json");
  return policy;
}

// One discovery pass over the whole corpus. `sink` is either
// { mode: "write", repo, loadSessionId } (pass 1, writes batches to
// Postgres) or { mode: "verify-only" } (pass 2, hashes only). Returns
// { streamSha256, chunkCount, searchEligibleCount, uniqueTextCount, documentCount, sourceFilesProgress }.
// Turn AC-FULL-LOAD-V2: discoveryBatchSize is an OPTIONAL parameter,
// defaulting to the module's own DISCOVERY_BATCH_SIZE constant -- v1's own
// CLI (main(), below) never passes it, so its flush cadence and therefore
// its behavior/output are byte-for-byte unchanged. Added because the real
// full corpus's periodic-001.jsonl is heavily size-skewed (observed up to
// ~40MB for a single document, vs a corpus-wide per-document average under
// 2MB) -- a fixed 200-DOCUMENT batch (not byte-bounded) landed enough
// large documents in one flush to exhaust the V8 heap and then hit V8's
// hard max-string-length limit ("Invalid string length") when building one
// pg array-parameter string from an oversized batch. A caller processing
// this specific corpus can pass a smaller discoveryBatchSize to flush
// (and release the batch's memory) more often; this changes ONLY flush
// cadence, never chunking/hashing/dedup semantics -- the double-pass
// stream_sha256 this function returns is unaffected by batch size.
export async function runDiscoveryPass({ policy, metadataIndex, sink, provenance, onProgress, maxDocuments = Infinity, discoveryBatchSize = DISCOVERY_BATCH_SIZE }) {
  const accumulator = createChunkStreamDigestAccumulator();
  const seenUniqueTextHashes = new Set(); // O(unique_text_count) memory for the RUNNING count only -- not the text itself beyond the current batch write
  let documentCount = 0;
  let chunkCount = 0;
  let searchEligibleCount = 0;
  let pendingCanonicalRows = [];
  let pendingChunkRows = [];
  let batchDocCount = 0;
  const sourceFilesProgress = Object.fromEntries(CORPUS_SOURCE_FILES.map((f) => [f.filename, { byte_offset: 0, line_number: 0, done: false }]));
  let currentFile = null;
  let lineInFile = 0;

  async function flushBatch() {
    if (sink.mode === "write" && (pendingCanonicalRows.length > 0 || pendingChunkRows.length > 0)) {
      await sink.repo.insertCanonicalBatch(sink.loadSessionId, pendingCanonicalRows);
      await sink.repo.insertChunkBatch(sink.loadSessionId, pendingChunkRows);
      await sink.repo.updateDiscoveryCheckpoint(sink.loadSessionId, {
        sourceFilesProgress,
        newDocumentCount: batchDocCount,
        newTotalChunkCount: pendingChunkRows.length,
        newSearchEligibleCount: pendingChunkRows.filter((r) => r.retrievalEligible).length,
        newUniqueTextCount: pendingCanonicalRows.length,
      });
    }
    pendingCanonicalRows = [];
    pendingChunkRows = [];
    batchDocCount = 0;
  }

  for await (const { documentId, docGroup, rawRecord } of streamAllDocuments(RAW_SOURCE_DIR)) {
    if (documentCount >= maxDocuments) break;
    if (currentFile !== docGroup) { currentFile = docGroup; lineInFile = 0; }
    lineInFile += 1;

    const metadataRecord = metadataIndex.byDocumentId.get(documentId);
    if (!metadataRecord) throw new Error(`DISCOVERY: document_id ${documentId} (docGroup=${docGroup}) has no entry in documents.jsonl metadata index`);
    const chunkerDocument = toChunkerDocument(metadataRecord);
    const chunks = chunkDocument(rawRecord, chunkerDocument, policy, provenance);

    for (const chunk of chunks) {
      const digest = toChunkDigestRecord(chunk);
      accumulator.update(digest);
      chunkCount += 1;
      if (digest.retrieval_eligible) searchEligibleCount += 1;
      if (!seenUniqueTextHashes.has(digest.embed_text_sha256)) {
        seenUniqueTextHashes.add(digest.embed_text_sha256);
        pendingCanonicalRows.push({ embedTextSha256: digest.embed_text_sha256, embedText: digest.embed_text, charLength: digest.embed_text.length });
      }
      if (digest.retrieval_eligible) {
        pendingChunkRows.push({
          chunkId: digest.chunk_id, documentId: digest.document_id, chunkIndex: digest.chunk_index,
          chunkType: digest.chunk_type, parentChunkId: digest.parent_chunk_id,
          contentSha256: digest.content_sha256, rawText: digest.raw_text,
          embedTextSha256: digest.embed_text_sha256, tokenCount: digest.token_count,
          corpCode: digest.corp_code, docGroup: digest.doc_group, receiptDate: digest.receipt_date,
          sectionPath: digest.section_path, sourceLocator: digest.source_locator, sourceSpans: digest.source_spans,
          chunkingPolicyId: digest.chunking_policy_id, chunkingPolicyVersion: digest.chunking_policy_version,
          retrievalEligible: digest.retrieval_eligible, metadata: digest.metadata,
        });
      }
    }
    documentCount += 1;
    batchDocCount += 1;
    const fileEntry = CORPUS_SOURCE_FILES.find((f) => f.docGroup === docGroup);
    sourceFilesProgress[fileEntry.filename] = { byte_offset: -1, line_number: lineInFile, done: false };

    if (batchDocCount >= discoveryBatchSize) {
      await flushBatch();
      if (onProgress) onProgress({ documentCount, chunkCount, searchEligibleCount, uniqueTextCount: seenUniqueTextHashes.size });
    }
  }
  for (const entry of Object.values(sourceFilesProgress)) entry.done = true;
  await flushBatch();

  const { streamSha256 } = accumulator.finalize();
  return { streamSha256, chunkCount, searchEligibleCount, uniqueTextCount: seenUniqueTextHashes.size, documentCount, sourceFilesProgress };
}

async function main() {
  const maxDocuments = process.argv.includes("--max-documents")
    ? Number(process.argv[process.argv.indexOf("--max-documents") + 1])
    : Infinity;
  // Turn P11-F0: a shard validation run (--max-documents set) MUST use a
  // DIFFERENT corpus_snapshot_id than the real full-corpus run -- since
  // load_session_id/retrieval_index_id are deterministic functions of
  // (corpus_snapshot_id, ...), reusing the canonical id for a partial-doc
  // shard would make the eventual full run "resume" into an already
  // DISCOVERY_COMPLETE session pinned to the shard's own (wrong, partial)
  // expected counts. Shard runs get their own isolated session identity;
  // only an unbounded (no --max-documents) run ever touches the real,
  // canonical CORPUS_SNAPSHOT_ID.
  const isShardRun = Number.isFinite(maxDocuments);
  const effectiveCorpusSnapshotId = isShardRun ? `${CORPUS_SNAPSHOT_ID}_shard_val_${maxDocuments}` : CORPUS_SNAPSHOT_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  console.error("[discovery] verifying corpus pin (live stat/scan)...");
  const { fileStats, totalBytes, documentCount: liveDocCount, corpusManifestSha256 } = await verifyCorpusPin();
  console.error(`[discovery] corpus pin OK: ${liveDocCount} documents, ${totalBytes} bytes, manifest_sha256=${corpusManifestSha256}`);

  const policy = loadFixedChunkingPolicy();
  const chunkingPolicySha256 = canonicalSha256(policy);
  console.error(`[discovery] chunking policy pinned: ${policy.chunking_config_id} sha256=${chunkingPolicySha256}`);

  const metadataIndex = await loadDocumentMetadataIndex(DOCUMENTS_JSONL_PATH);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // try/finally around everything after connect: a thrown error mid-stream
  // (e.g. a filesystem permission error reading the raw corpus) must still
  // close the connection, or the process hangs forever holding it open
  // instead of exiting -- same class of bug already fixed in
  // p11f0-shard-integration-smoke.mjs.
  try {
    const repo = createFixedKureLoadSessionRepository({ client });

    const pins = {
      releaseId: "seed-release-v0.20",
      corpusSnapshotId: effectiveCorpusSnapshotId,
      corpusManifestSha256,
      embeddingProvider: "nlpai-lab",
      embeddingModel: "KURE-v1",
      embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
      embeddingDimension: 1024,
      distanceMetric: "cosine",
      chunkingPolicyId: policy.chunking_config_id,
      chunkingPolicySha256,
      batchSize: 8,
      discoveryBatchSize: DISCOVERY_BATCH_SIZE,
      maxRetryAttempts: 3,
      leaseDurationMs: 120000,
      codeRevision: process.env.P11F0_CODE_REVISION ?? "unknown",
    };

    const { session, created } = await repo.createOrGetSession(pins);
    console.error(`[discovery] session ${session.load_session_id} created=${created} status=${session.status}`);

    if (session.status !== "CREATED" && session.status !== "DISCOVERING") {
      console.error(`[discovery] session already past DISCOVERY (status=${session.status}) -- nothing to do`);
      return;
    }
    if (session.status === "CREATED") await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");

    const provenance = { targetCorpusSnapshotId: effectiveCorpusSnapshotId, parserCodeRevision: process.env.P11F0_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) };

    let lastReport = Date.now();
    console.error("[discovery] PASS 1 (write) starting...");
    const pass1 = await runDiscoveryPass({
      policy, metadataIndex, provenance, maxDocuments,
      sink: { mode: "write", repo, loadSessionId: session.load_session_id },
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastReport >= 30000) {
          console.error(`[discovery][pass1] documents=${p.documentCount} chunks=${p.chunkCount} search_eligible=${p.searchEligibleCount} unique_texts=${p.uniqueTextCount}`);
          lastReport = now;
        }
      },
    });
    console.error(`[discovery] PASS 1 complete: documents=${pass1.documentCount} chunks=${pass1.chunkCount} search_eligible=${pass1.searchEligibleCount} unique_texts=${pass1.uniqueTextCount} stream_sha256=${pass1.streamSha256}`);
    await repo.recordPassStreamSha256(session.load_session_id, 1, pass1.streamSha256);

    console.error("[discovery] PASS 2 (verify-only, no DB writes) starting...");
    lastReport = Date.now();
    const pass2 = await runDiscoveryPass({
      policy, metadataIndex, provenance, maxDocuments,
      sink: { mode: "verify-only" },
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastReport >= 30000) {
          console.error(`[discovery][pass2] documents=${p.documentCount} chunks=${p.chunkCount}`);
          lastReport = now;
        }
      },
    });
    console.error(`[discovery] PASS 2 complete: stream_sha256=${pass2.streamSha256}`);
    await repo.recordPassStreamSha256(session.load_session_id, 2, pass2.streamSha256);

    if (pass1.streamSha256 !== pass2.streamSha256 || pass1.chunkCount !== pass2.chunkCount) {
      await repo.transitionStatus(session.load_session_id, ["DISCOVERING"], "FAILED", { last_error_code: "DOUBLE_PASS_DETERMINISM_MISMATCH" });
      throw new Error(`DOUBLE_PASS_DETERMINISM_MISMATCH: pass1 sha256=${pass1.streamSha256} count=${pass1.chunkCount}; pass2 sha256=${pass2.streamSha256} count=${pass2.chunkCount}`);
    }

    const completed = await repo.completeDiscovery(session.load_session_id);
    console.error(`[discovery] DISCOVERY_COMPLETE: load_session_id=${completed.load_session_id} expected_total_chunk_count=${completed.expected_total_chunk_count} expected_search_eligible_count=${completed.expected_search_eligible_count} expected_unique_embeddable_count=${completed.expected_unique_embeddable_count}`);
  } finally {
    await client.end();
  }
}

// Turn AC-FULL-LOAD-V2: guarded so scripts/p11f0-corpus-discovery-v2.mjs (and
// tests) can `import` this module's helpers (runDiscoveryPass,
// verifyCorpusPin, loadFixedChunkingPolicy, canonicalSha256, the CORPUS_*/
// EXPECTED_*/RAW_SOURCE_DIR/DOCUMENTS_JSONL_PATH constants) without also
// triggering this v1 CLI's own main() -- behavior when this file is run
// directly (`node scripts/p11f0-corpus-discovery.mjs`) is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[discovery] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
