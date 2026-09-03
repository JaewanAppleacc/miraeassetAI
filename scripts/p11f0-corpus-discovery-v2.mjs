#!/usr/bin/env node
// Turn AC-FULL-LOAD-V2: v2-identity full-corpus DISCOVERY entrypoint.
//
// Behaviorally IDENTICAL streaming/chunking/hashing to
// scripts/p11f0-corpus-discovery.mjs (v1) -- this script imports that
// file's runDiscoveryPass/verifyCorpusPin/loadFixedChunkingPolicy/
// canonicalSha256 and every corpus/expected-count constant UNCHANGED,
// rather than re-implementing them, so pass1/pass2 chunk-stream digests
// are guaranteed comparable across v1 and v2 runs of the same corpus.
//
// The ONLY thing this script does differently from v1: session identity.
// v1's createOrGetSession computes load_session_id from logical pins alone
// (corpus/chunking/embedding), which is exactly why the pre-existing
// zero-progress session (fixed_kure_session_8fe19...,
// code_revision=536a69e...) could not simply be resumed under this
// worktree's own code_revision -- CODE_REVISION_MISMATCH, by design. This
// script instead calls createOrGetAttempt (Turn AC-FULL-LOAD-V2, same
// repository module), which folds loaderContractVersion + codeRevision
// into the id, so this run gets its OWN row/PK
// (execution_attempt_id/load_session_id), linked via
// supersedes_load_session_id to whichever prior zero-progress attempt (if
// any) was explicitly superseded first via supersedeZeroProgressSession --
// this script does NOT supersede anything itself; that must have already
// happened (see work/turn-ac-full-load-v2/supersede-session-b.mjs for how
// it was done for this Turn's specific prior attempt).
import pg from "pg";
import { loadDocumentMetadataIndex } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { createFixedKureLoadSessionRepository } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";
import {
  runDiscoveryPass, verifyCorpusPin, loadFixedChunkingPolicy, canonicalSha256,
  CORPUS_SNAPSHOT_ID, getDocumentsJsonlPath,
} from "./p11f0-corpus-discovery.mjs";

const { Client } = pg;

async function main() {
  const maxDocuments = process.argv.includes("--max-documents")
    ? Number(process.argv[process.argv.indexOf("--max-documents") + 1])
    : Infinity;
  const isShardRun = Number.isFinite(maxDocuments);
  const effectiveCorpusSnapshotId = isShardRun ? `${CORPUS_SNAPSHOT_ID}_shard_val_${maxDocuments}` : CORPUS_SNAPSHOT_ID;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const codeRevision = process.env.P11F0_CODE_REVISION;
  if (!codeRevision) throw new Error("P11F0_CODE_REVISION is required");
  const loaderContractVersion = process.env.P11F0_LOADER_CONTRACT_VERSION ?? "fixed-kure-loader-contract-v2.0";
  const supersedesLoadSessionId = process.env.P11F0_SUPERSEDES_LOAD_SESSION_ID || null;
  // See runDiscoveryPass's own comment (p11f0-corpus-discovery.mjs): the
  // real corpus's periodic-001.jsonl is heavily size-skewed (documents up
  // to ~40MB observed, several clustered together), so a 200-DOCUMENT batch
  // can aggregate an unsafe amount of text before its one flush. Smaller,
  // still document-count-based batches flush (and release memory) more
  // often; this changes only checkpoint cadence, never chunking/hashing
  // output.
  const discoveryBatchSize = Number(process.env.P11F0_DISCOVERY_BATCH_SIZE ?? 10);

  console.error("[discovery-v2] verifying corpus pin (live stat/scan)...");
  const { fileStats, totalBytes, documentCount: liveDocCount, corpusManifestSha256 } = await verifyCorpusPin();
  console.error(`[discovery-v2] corpus pin OK: ${liveDocCount} documents, ${totalBytes} bytes, manifest_sha256=${corpusManifestSha256}`);

  const policy = loadFixedChunkingPolicy();
  const chunkingPolicySha256 = canonicalSha256(policy);
  console.error(`[discovery-v2] chunking policy pinned: ${policy.chunking_config_id} sha256=${chunkingPolicySha256}`);

  const metadataIndex = await loadDocumentMetadataIndex(getDocumentsJsonlPath());

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
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
      discoveryBatchSize,
      maxRetryAttempts: 3,
      leaseDurationMs: 120000,
      codeRevision,
      loaderContractVersion,
      supersedesLoadSessionId,
    };

    const { session, created } = await repo.createOrGetAttempt(pins);
    console.error(`[discovery-v2] attempt ${session.load_session_id} (logical=${session.logical_load_id}) created=${created} status=${session.status}`);

    if (session.status !== "CREATED" && session.status !== "DISCOVERING") {
      console.error(`[discovery-v2] attempt already past DISCOVERY (status=${session.status}) -- nothing to do`);
      return;
    }
    if (session.status === "CREATED") await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");

    const provenance = { targetCorpusSnapshotId: effectiveCorpusSnapshotId, parserCodeRevision: process.env.P11F0_PARSER_CODE_REVISION ?? "0".repeat(40), parserConfigHash: "0".repeat(64) };

    const startedAt = Date.now();
    let lastReport = Date.now();
    console.error("[discovery-v2] PASS 1 (write) starting...");
    const pass1 = await runDiscoveryPass({
      policy, metadataIndex, provenance, maxDocuments, discoveryBatchSize,
      sink: { mode: "write", repo, loadSessionId: session.load_session_id },
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastReport >= 30000) {
          console.error(`[discovery-v2][pass1] documents=${p.documentCount} chunks=${p.chunkCount} search_eligible=${p.searchEligibleCount} unique_texts=${p.uniqueTextCount} elapsed_ms=${now - startedAt}`);
          lastReport = now;
        }
      },
    });
    console.error(`[discovery-v2] PASS 1 complete: documents=${pass1.documentCount} chunks=${pass1.chunkCount} search_eligible=${pass1.searchEligibleCount} unique_texts=${pass1.uniqueTextCount} stream_sha256=${pass1.streamSha256} elapsed_ms=${Date.now() - startedAt}`);
    await repo.recordPassStreamSha256(session.load_session_id, 1, pass1.streamSha256);

    console.error("[discovery-v2] PASS 2 (verify-only, no DB writes) starting...");
    const pass2StartedAt = Date.now();
    lastReport = Date.now();
    const pass2 = await runDiscoveryPass({
      policy, metadataIndex, provenance, maxDocuments, discoveryBatchSize,
      sink: { mode: "verify-only" },
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastReport >= 30000) {
          console.error(`[discovery-v2][pass2] documents=${p.documentCount} chunks=${p.chunkCount} elapsed_ms=${now - pass2StartedAt}`);
          lastReport = now;
        }
      },
    });
    console.error(`[discovery-v2] PASS 2 complete: stream_sha256=${pass2.streamSha256} elapsed_ms=${Date.now() - pass2StartedAt}`);
    await repo.recordPassStreamSha256(session.load_session_id, 2, pass2.streamSha256);

    if (pass1.streamSha256 !== pass2.streamSha256 || pass1.chunkCount !== pass2.chunkCount) {
      await repo.transitionStatus(session.load_session_id, ["DISCOVERING"], "FAILED", { last_error_code: "DOUBLE_PASS_DETERMINISM_MISMATCH" });
      throw new Error(`DOUBLE_PASS_DETERMINISM_MISMATCH: pass1 sha256=${pass1.streamSha256} count=${pass1.chunkCount}; pass2 sha256=${pass2.streamSha256} count=${pass2.chunkCount}`);
    }

    const completed = await repo.completeDiscovery(session.load_session_id);
    console.error(`[discovery-v2] DISCOVERY_COMPLETE: load_session_id=${completed.load_session_id} expected_total_chunk_count=${completed.expected_total_chunk_count} expected_search_eligible_count=${completed.expected_search_eligible_count} expected_unique_embeddable_count=${completed.expected_unique_embeddable_count} total_elapsed_ms=${Date.now() - startedAt}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[discovery-v2] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
