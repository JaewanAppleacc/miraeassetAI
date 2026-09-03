#!/usr/bin/env node
// Turn P11-F0: EMBEDDING phase (Stage 4/9) of the Resumable Fixed-512-o64 x
// KURE-v1 Hybrid Retrieval Loader. Leases bounded batches of PENDING
// unique-embed_text rows from the SAME load_session_id DISCOVERY already
// populated, calls the LOCAL KURE-v1 embedding server (never a paid API --
// see scripts/embedding-calibration-real/local_embedding_server.py,
// unmodified) via the existing embedding-adapter.mjs HTTP_EMBEDDINGS
// contract, and writes vectors back. Crash-safe by construction: a killed
// process simply leaves its leases to expire (lease_duration_ms), and a
// fresh invocation of this SAME script re-derives the SAME load_session_id
// from the SAME pins and resumes leasing PENDING/expired rows -- it never
// creates a new session and never re-embeds an already-EMBEDDED row.
//
// NEVER calls a paid/external embedding API, NEVER reads DEV_TUNE/
// DEV_CHECK/HOLDOUT, NEVER calls HCX.
import pg from "pg";
import path from "node:path";
import process from "node:process";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { createFixedKureLoadSessionRepository, computeFixedKureLoadSessionId } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const { Client } = pg;
const LEASE_OWNER = `embed-worker-${process.pid}`;
const LEASE_DURATION_MS = 120000;
const BATCH_SIZE = 8;
const MAX_RETRY_ATTEMPTS = 3;

// Milestone percentages this Turn's brief requires progress reports at --
// never a fixed 60s interval.
const MILESTONES = [10, 25, 50, 75, 90];

function formatEta(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining < 0) return "unknown";
  const totalSeconds = Math.round(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h${minutes}m`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const embeddingServerUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!embeddingServerUrl) throw new Error("P11F0_KURE_SERVER_URL is required (e.g. http://127.0.0.1:58411/v1/embeddings)");

  // Isolation from a shard-validation run: this script never derives its
  // own session identity -- it takes the EXACT pins the discovery phase
  // already used (so it resumes the same session), read from CLI args so
  // a caller can point it at either the shard-validation session or the
  // real full-corpus session, but never invents a third identity.
  const corpusSnapshotId = process.argv[process.argv.indexOf("--corpus-snapshot-id") + 1];
  if (!corpusSnapshotId) throw new Error("--corpus-snapshot-id is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // try/finally around everything after connect: this phase runs for
  // hours against a live embedding server -- any uncaught error (a DB
  // hiccup outside the per-batch try/catch below, a bad session lookup)
  // must still close the connection so the process actually exits instead
  // of hanging silently and burning wall-clock time undetected. Same class
  // of bug already fixed in p11f0-shard-integration-smoke.mjs and
  // p11f0-corpus-discovery.mjs.
  try {
  const repo = createFixedKureLoadSessionRepository({ client });

  const loadSessionId = computeFixedKureLoadSessionId({
    releaseId: "seed-release-v0.20", corpusSnapshotId,
    embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
    embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
    chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
  });
  let session = await repo.getSession(loadSessionId);
  if (!session) throw new Error(`no load session found for corpus_snapshot_id=${corpusSnapshotId} -- run discovery first`);
  console.error(`[embedding] resuming load_session_id=${loadSessionId} status=${session.status}`);

  if (session.status === "DISCOVERY_COMPLETE") {
    session = await repo.transitionStatus(loadSessionId, ["DISCOVERY_COMPLETE"], "EMBEDDING");
  } else if (session.status !== "EMBEDDING") {
    console.error(`[embedding] session status is ${session.status}, not DISCOVERY_COMPLETE/EMBEDDING -- nothing to do`);
    return;
  }

  const embeddingConfig = {
    schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
    revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024,
    endpoint_url: embeddingServerUrl, timeout_ms: 120000, auth_mode: "NONE",
  };
  const adapter = createEmbeddingAdapter(embeddingConfig);

  const total = session.expected_unique_embeddable_count;
  const startedAt = Date.now();
  let embeddedSoFar = session.embedded_unique_text_count;
  let retryCount = 0;
  let permanentFailureCount = 0;
  let nextMilestoneIdx = MILESTONES.findIndex((m) => (embeddedSoFar / total) * 100 < m);
  if (nextMilestoneIdx === -1) nextMilestoneIdx = MILESTONES.length;

  function report(label) {
    const elapsedMs = Date.now() - startedAt;
    const rate = elapsedMs > 0 ? embeddedSoFar / (elapsedMs / 1000) : 0; // texts/sec this run (not counting pre-existing progress time)
    const remaining = total - embeddedSoFar;
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : Infinity;
    console.error(JSON.stringify({
      report: label, load_session_id: loadSessionId,
      embedded: embeddedSoFar, total, materialized: session.materialized_chunk_count ?? 0,
      elapsed_s: Math.round(elapsedMs / 1000), eta: formatEta(etaMs), throughput_per_sec: Number(rate.toFixed(2)),
      peak_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      retry_count: retryCount, permanent_failure_count: permanentFailureCount,
      checkpoint_status: "DB_PERSISTED",
    }));
  }

  while (true) {
    const leased = await repo.leaseCanonicalBatch(loadSessionId, { limit: BATCH_SIZE, leaseOwner: LEASE_OWNER, leaseDurationMs: LEASE_DURATION_MS });
    if (leased.length === 0) {
      const counts = await repo.queueStatusCounts(loadSessionId);
      if (counts.PENDING === 0 && counts.LEASED === 0) break; // done (everything EMBEDDED or permanently FAILED)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 2000); }); // another worker's lease may still be active -- wait and re-check (single-worker use here, but harmless if ever run with >1)
      continue;
    }
    const texts = leased.map((r) => r.embed_text);
    try {
      // eslint-disable-next-line no-await-in-loop
      const vectors = await adapter.embedDocuments(texts);
      // eslint-disable-next-line no-await-in-loop
      await repo.markEmbedded(loadSessionId, leased.map((r, i) => ({ embedTextSha256: r.embed_text_sha256, embedding: vectors[i] })));
      embeddedSoFar += leased.length;
    } catch (error) {
      const errorCode = typeof error?.code === "string" ? error.code : "EMBEDDING_CALL_UNKNOWN_ERROR";
      // eslint-disable-next-line no-await-in-loop
      const { permanentlyFailed, requeued } = await repo.markEmbeddingBatchFailed(
        loadSessionId, leased.map((r) => r.embed_text_sha256), { maxRetryAttempts: MAX_RETRY_ATTEMPTS, errorCode },
      );
      retryCount += requeued.length;
      permanentFailureCount += permanentlyFailed.length;
      console.error(`[embedding] batch error ${errorCode}: ${requeued.length} requeued, ${permanentlyFailed.length} permanently failed`);
    }

    const progressPct = (embeddedSoFar / total) * 100;
    if (nextMilestoneIdx < MILESTONES.length && progressPct >= MILESTONES[nextMilestoneIdx]) {
      report(`${MILESTONES[nextMilestoneIdx]}%`);
      nextMilestoneIdx += 1;
    }
  }

  report("embedding_complete");
  if (permanentFailureCount > 0) {
    await repo.transitionStatus(loadSessionId, ["EMBEDDING"], "FAILED", { last_error_code: "EMBEDDING_PERMANENT_FAILURES" });
    throw new Error(`EMBEDDING phase ended with ${permanentFailureCount} permanently failed unique text(s) -- refusing to proceed to MATERIALIZING`);
  }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[embedding] FAILED: ${error.message}`);
  process.exitCode = 1;
});
