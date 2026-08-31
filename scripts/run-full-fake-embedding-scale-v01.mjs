#!/usr/bin/env node
// Turn P8, Section J Stage 4 (optional): resumes a load session that has
// ALREADY completed real, full-scale DISCOVERY (see
// run-full-snapshot-discovery-v01.mjs / Stage 3) and drives it through
// EMBEDDING -> MATERIALIZATION -> FINALIZATION using ONLY
// createDeterministicFakeEmbeddingAdapter -- zero external API calls, zero
// cost, a small validation dimension. This validates the FULL pipeline's
// behavior at the real 1,874,688-occurrence / 723,875-canonical scale, but
// its result is a scale/mechanics proof, NOT a real-embedding validation:
// report it as FULL_PIPELINE_SCALE_VALIDATED_WITH_FAKE_EMBEDDING, never as
// evidence the real embedding provider/model path has been exercised.
//
// Required env: DATABASE_URL, LOAD_SESSION_ID (from the Stage 3 run).
import pg from "pg";
import { runResumableDedupLoad } from "../domain/postgres/reference-dedup-resumable-loader.mjs";
import { createDedupLoadSessionRepository } from "../domain/postgres/reference-dedup-load-session-repository.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";

const { Client } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const loadSessionId = process.env.LOAD_SESSION_ID;
  if (!databaseUrl || !loadSessionId) {
    console.error("Usage: DATABASE_URL=... LOAD_SESSION_ID=... node scripts/run-full-fake-embedding-scale-v01.mjs");
    process.exit(1);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const repo = createDedupLoadSessionRepository({ client });
  const session = await repo.getSession(loadSessionId);
  if (!session) {
    console.error(`session not found: ${loadSessionId}`);
    process.exit(1);
  }
  console.error(`[stage4] resuming ${loadSessionId} from status=${session.status}, discovered_occurrence_count=${session.discovered_occurrence_count}, discovered_canonical_count=${session.discovered_canonical_count}`);

  const embeddingAdapter = createDeterministicFakeEmbeddingAdapter({ dimension: session.embedding_dimension });
  const chunksFilePath = process.env.SNAPSHOT_CHUNKS_PATH; // only needed if discovery itself must still run

  let peakRssBytes = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 1000);
  sampler.unref();

  const progressTimer = setInterval(async () => {
    try {
      const current = await repo.getSession(loadSessionId);
      console.error(`[stage4] status=${current.status} embedded=${current.embedded_canonical_count}/${current.discovered_canonical_count} materialized_canonical=${current.materialized_canonical_count} materialized_occurrence=${current.materialized_occurrence_count}/${current.discovered_occurrence_count} rss=${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`);
    } catch { /* ignore transient poll error from a second connection race */ }
  }, 5000);
  progressTimer.unref();

  const startedAt = Date.now();
  await runResumableDedupLoad({
    client, loadSessionId, chunksFilePath, embeddingAdapter,
    embeddingConfig: { provider: session.embedding_provider, model: session.embedding_model, revision: "v1", dimension: session.embedding_dimension },
    batchSize: 1000, materializationBatchSize: 1000,
  });
  clearInterval(progressTimer);
  clearInterval(sampler);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const finalSession = await repo.getSession(loadSessionId);
  const canonicalActual = await client.query("SELECT count(*)::int n FROM disclosure_reference.reference_dedup_canonical_texts WHERE retrieval_index_id=$1", [finalSession.retrieval_index_id]);
  const occurrenceActual = await client.query("SELECT count(*)::int n FROM disclosure_reference.reference_dedup_occurrences WHERE retrieval_index_id=$1", [finalSession.retrieval_index_id]);
  await client.end();

  console.log(JSON.stringify({
    label: "FULL_PIPELINE_SCALE_VALIDATED_WITH_FAKE_EMBEDDING",
    load_session_id: loadSessionId,
    status: finalSession.status,
    discovered_occurrence_count: finalSession.discovered_occurrence_count,
    discovered_canonical_count: finalSession.discovered_canonical_count,
    materialized_canonical_count: finalSession.materialized_canonical_count,
    materialized_occurrence_count: finalSession.materialized_occurrence_count,
    actual_canonical_rows: canonicalActual.rows[0].n,
    actual_occurrence_rows: occurrenceActual.rows[0].n,
    elapsed_seconds: elapsedSeconds,
    peak_rss_mb: peakRssBytes / 1024 / 1024,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[stage4] FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
