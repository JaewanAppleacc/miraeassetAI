#!/usr/bin/env node
// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section I/J: the no-DB discovery
// entrypoint. Zero Node `pg` network I/O anywhere in this script (it never
// imports the `pg` package) -- real-corpus reproduction (this Turn's own
// prior investigation) proved sustained Node `pg`<->PostgreSQL traffic,
// not chunking or any particular query/serialization strategy, is what
// OOMs the real corpus. chunkDocument/streamAllDocuments/runDiscoveryPass
// are imported UNCHANGED from p11f0-corpus-discovery.mjs -- this script
// only supplies a NEW sink (mode: "spool") that writes bounded, COPY-format
// shard files to local disk instead of issuing DB writes.
//
// PASS 1 (write): streams the corpus once, chunks every document, writes
// canonical (unique embed_text) and chunk (occurrence) rows to shard files,
// and computes the SAME chunk-stream sha256 the DB-backed pass1 always did
// (createChunkStreamDigestAccumulator, unchanged). Writes an aggregate
// manifest.json when done.
//
// PASS 2 (verify-only): re-streams the corpus from scratch -- NOT from the
// spool -- re-chunks, and recomputes the stream sha256/counts completely
// independently. Compared against pass 1's recorded values; any mismatch
// is DOUBLE_PASS_DETERMINISM_MISMATCH, exactly as the DB-backed path always
// treated it.
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  runDiscoveryPass, verifyCorpusPin, loadFixedChunkingPolicy, canonicalSha256,
  CORPUS_SNAPSHOT_ID, getDocumentsJsonlPath,
} from "./p11f0-corpus-discovery.mjs";
import { loadDocumentMetadataIndex } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { createSpoolShardSet } from "../domain/agent-comparison/chunking-comparison/discovery-file-spool.mjs";
import { computeFixedKureLogicalLoadId, computeFixedKureExecutionAttemptId } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const CANONICAL_COLUMNS = ["load_session_id", "embed_text_sha256", "embed_text", "char_length"];
const CHUNK_COLUMNS = [
  "load_session_id", "chunk_id", "document_id", "chunk_index", "chunk_type", "parent_chunk_id", "content_sha256",
  "raw_text", "embed_text_sha256", "token_count",
  "corp_code", "doc_group", "receipt_date", "section_path", "source_locator", "source_spans",
  "chunking_policy_id", "chunking_policy_version", "retrieval_eligible", "metadata",
];

async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(partialPath, finalPath);
}

async function main() {
  const spoolDir = process.env.P11F0_SPOOL_DIR;
  if (!spoolDir) throw new Error("P11F0_SPOOL_DIR is required -- no default path (never a personal absolute path baked into code)");
  const releaseId = "seed-release-v0.20";
  const embeddingProvider = "nlpai-lab";
  const embeddingModel = "KURE-v1";
  const embeddingRevision = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";
  const codeRevision = process.env.P11F0_CODE_REVISION;
  if (!codeRevision) throw new Error("P11F0_CODE_REVISION is required (the immutable commit SHA the spool/COPY code was committed at)");
  const loaderContractVersion = process.env.P11F0_LOADER_CONTRACT_VERSION ?? "fixed-kure-spool-loader-contract-v1.0";
  const discoveryBatchSize = Number(process.env.P11F0_DISCOVERY_BATCH_SIZE ?? 10);
  const maxDocuments = process.argv.includes("--max-documents")
    ? Number(process.argv[process.argv.indexOf("--max-documents") + 1])
    : Infinity;
  const isShardRun = Number.isFinite(maxDocuments);
  const effectiveCorpusSnapshotId = isShardRun ? `${CORPUS_SNAPSHOT_ID}_shard_val_${maxDocuments}` : CORPUS_SNAPSHOT_ID;

  console.error("[discovery-spool] verifying corpus pin (live stat/scan)...");
  const { corpusManifestSha256 } = await verifyCorpusPin();
  const policy = loadFixedChunkingPolicy();
  const chunkingPolicySha256 = canonicalSha256(policy);
  const metadataIndex = await loadDocumentMetadataIndex(getDocumentsJsonlPath());

  const logicalLoadId = computeFixedKureLogicalLoadId({
    releaseId, corpusSnapshotId: effectiveCorpusSnapshotId, embeddingProvider, embeddingModel, embeddingRevision,
    chunkingPolicyId: policy.chunking_config_id,
  });
  const executionAttemptId = computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion, codeRevision });
  console.error(`[discovery-spool] logical_load_id=${logicalLoadId} execution_attempt_id=${executionAttemptId}`);

  await mkdir(spoolDir, { recursive: true });

  const canonicalShardSet = createSpoolShardSet({ spoolDir, namePrefix: "canonical", columns: CANONICAL_COLUMNS });
  const chunkShardSet = createSpoolShardSet({ spoolDir, namePrefix: "chunk", columns: CHUNK_COLUMNS });

  let lastCheckpoint = null;
  let lastReport = Date.now();
  const startedAt = Date.now();
  console.error("[discovery-spool] PASS 1 (spool write, zero DB I/O) starting...");
  const pass1 = await runDiscoveryPass({
    policy, metadataIndex, maxDocuments, discoveryBatchSize,
    provenance: { targetCorpusSnapshotId: effectiveCorpusSnapshotId, parserCodeRevision: process.env.P11F0_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) },
    sink: {
      mode: "spool", loadSessionId: executionAttemptId, canonicalShardSet, chunkShardSet,
      onCheckpoint: (p) => { lastCheckpoint = p; },
    },
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastReport >= 30000) {
        console.error(`[discovery-spool][pass1] documents=${p.documentCount} chunks=${p.chunkCount} search_eligible=${p.searchEligibleCount} unique_texts=${p.uniqueTextCount} elapsed_ms=${now - startedAt}`);
        lastReport = now;
      }
    },
  });
  const canonicalShards = await canonicalShardSet.finalize();
  const chunkShards = await chunkShardSet.finalize();
  console.error(`[discovery-spool] PASS 1 complete: documents=${pass1.documentCount} chunks=${pass1.chunkCount} search_eligible=${pass1.searchEligibleCount} unique_texts=${pass1.uniqueTextCount} stream_sha256=${pass1.streamSha256} canonical_shards=${canonicalShards.length} chunk_shards=${chunkShards.length} elapsed_ms=${Date.now() - startedAt}`);

  console.error("[discovery-spool] PASS 2 (verify-only, no spool, no DB) starting...");
  const pass2StartedAt = Date.now();
  lastReport = Date.now();
  const pass2 = await runDiscoveryPass({
    policy, metadataIndex, maxDocuments, discoveryBatchSize,
    provenance: { targetCorpusSnapshotId: effectiveCorpusSnapshotId, parserCodeRevision: process.env.P11F0_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) },
    sink: { mode: "verify-only" },
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastReport >= 30000) {
        console.error(`[discovery-spool][pass2] documents=${p.documentCount} chunks=${p.chunkCount} elapsed_ms=${now - pass2StartedAt}`);
        lastReport = now;
      }
    },
  });
  console.error(`[discovery-spool] PASS 2 complete: stream_sha256=${pass2.streamSha256} elapsed_ms=${Date.now() - pass2StartedAt}`);

  const shaMatch = pass1.streamSha256 === pass2.streamSha256 && pass1.chunkCount === pass2.chunkCount;
  const canonicalTotalRows = canonicalShards.reduce((sum, s) => sum + s.rowCount, 0);
  const chunkTotalRows = chunkShards.reduce((sum, s) => sum + s.rowCount, 0);

  const manifest = {
    schema_version: "p11f0-spool-manifest.v1",
    logical_load_id: logicalLoadId,
    execution_attempt_id: executionAttemptId,
    loader_contract_version: loaderContractVersion,
    code_revision: codeRevision,
    corpus_snapshot_id: effectiveCorpusSnapshotId,
    corpus_manifest_sha256: corpusManifestSha256,
    chunking_policy_id: policy.chunking_config_id,
    chunking_policy_sha256: chunkingPolicySha256,
    embedding: { provider: embeddingProvider, model: embeddingModel, revision: embeddingRevision },
    pass1: {
      document_count: pass1.documentCount, chunk_count: pass1.chunkCount,
      search_eligible_count: pass1.searchEligibleCount, unique_text_count: pass1.uniqueTextCount,
      stream_sha256: pass1.streamSha256, source_files_progress: pass1.sourceFilesProgress,
    },
    pass2: { document_count: pass2.documentCount, chunk_count: pass2.chunkCount, stream_sha256: pass2.streamSha256 },
    double_pass_match: shaMatch,
    spool: {
      canonical_shard_count: canonicalShards.length, canonical_total_rows: canonicalTotalRows,
      chunk_shard_count: chunkShards.length, chunk_total_rows: chunkTotalRows,
      canonical_shards: canonicalShards.map(({ filename, rowCount, byteCount, sha256 }) => ({ filename, row_count: rowCount, byte_count: byteCount, sha256 })),
      chunk_shards: chunkShards.map(({ filename, rowCount, byteCount, sha256 }) => ({ filename, row_count: rowCount, byte_count: byteCount, sha256 })),
    },
    generated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(spoolDir, "manifest.json"), manifest);
  console.error(`[discovery-spool] manifest written: ${path.join(spoolDir, "manifest.json")}`);

  if (!shaMatch) {
    console.error(`[discovery-spool] FAILED: DOUBLE_PASS_DETERMINISM_MISMATCH pass1 sha256=${pass1.streamSha256} count=${pass1.chunkCount}; pass2 sha256=${pass2.streamSha256} count=${pass2.chunkCount}`);
    process.exitCode = 1;
    return;
  }
  console.error("[discovery-spool] DISCOVERY_SPOOL_COMPLETE: pass1/pass2 stream_sha256 match.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[discovery-spool] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
