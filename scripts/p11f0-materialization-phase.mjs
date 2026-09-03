#!/usr/bin/env node
// Turn P11-F0: MATERIALIZATION phase (Stage 5/9) of the Resumable
// Fixed-512-o64 x KURE-v1 Hybrid Retrieval Loader. Copies staged chunks
// (006's reference_fixed_kure_chunk_staging, once their embed_text is
// EMBEDDED) into 003's EXISTING reference_retrieval_chunks
// (source_kind='DOCUMENT_CHUNK'), then FINALIZES the session -- verifying
// every count matches before ever flipping the parent
// reference_retrieval_indexes row to READY (003's own guard trigger
// additionally re-checks record_count against the real row count,
// independent of this script's own check).
import pg from "pg";
import process from "node:process";
import { createFixedKureLoadSessionRepository, computeFixedKureLoadSessionId } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const { Client } = pg;
const MATERIALIZE_BATCH_SIZE = 500;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const corpusSnapshotId = process.argv[process.argv.indexOf("--corpus-snapshot-id") + 1];
  if (!corpusSnapshotId) throw new Error("--corpus-snapshot-id is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // try/finally: same class of pg-client-leak bug already fixed in
  // p11f0-shard-integration-smoke.mjs, p11f0-corpus-discovery.mjs, and
  // p11f0-embedding-phase.mjs -- an uncaught error here must not leave the
  // process hanging with an open connection.
  try {
    const repo = createFixedKureLoadSessionRepository({ client });

    const loadSessionId = computeFixedKureLoadSessionId({
      releaseId: "seed-release-v0.20", corpusSnapshotId,
      embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
      embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
      chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
    });
    let session = await repo.getSession(loadSessionId);
    if (!session) throw new Error(`no load session found for corpus_snapshot_id=${corpusSnapshotId}`);
    console.error(`[materialize] resuming load_session_id=${loadSessionId} status=${session.status}`);

    if (session.status === "EMBEDDING") {
      const counts = await repo.queueStatusCounts(loadSessionId);
      if (counts.PENDING > 0 || counts.LEASED > 0) throw new Error(`EMBEDDING not complete (PENDING=${counts.PENDING} LEASED=${counts.LEASED}) -- run the embedding phase first`);
      if (counts.FAILED > 0) throw new Error(`EMBEDDING has ${counts.FAILED} permanently failed unique text(s) -- refusing to materialize`);
      session = await repo.transitionStatus(loadSessionId, ["EMBEDDING"], "MATERIALIZING");
    } else if (session.status !== "MATERIALIZING") {
      console.error(`[materialize] session status is ${session.status}, not EMBEDDING/MATERIALIZING -- nothing to do`);
      return;
    }

    await repo.ensureRetrievalIndexRow({
      retrievalIndexId: session.retrieval_index_id, releaseId: "seed-release-v0.20", corpusSnapshotId,
      embeddingProvider: session.embedding_provider, embeddingModel: session.embedding_model, embeddingRevision: session.embedding_revision,
      embeddingDimension: session.embedding_dimension, distanceMetric: session.distance_metric,
      chunkingPolicyId: session.chunking_policy_id, chunkingPolicySha256: session.chunking_policy_sha256,
      manifestSha256: session.corpus_manifest_sha256,
    });

    const startedAt = Date.now();
    let materializedThisRun = 0;
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { materializedCount, done } = await repo.materializeChunkBatch(loadSessionId, session.retrieval_index_id, MATERIALIZE_BATCH_SIZE);
      materializedThisRun += materializedCount;
      if (materializedCount > 0) console.error(`[materialize] +${materializedCount} (total this run: ${materializedThisRun}), elapsed_s=${Math.round((Date.now() - startedAt) / 1000)}`);
      if (done) break;
    }

    const finalSession = await repo.finalize(loadSessionId, session.retrieval_index_id);
    console.error(`[materialize] READY: load_session_id=${loadSessionId} materialized_chunk_count=${finalSession.materialized_chunk_count} elapsed_s=${Math.round((Date.now() - startedAt) / 1000)}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[materialize] FAILED: ${error.message}`);
  process.exitCode = 1;
});
