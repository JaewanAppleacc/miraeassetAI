#!/usr/bin/env node
// Turn P8, Section H: child-process worker used by
// tests/reference-dedup-resumable-loader-bounded-memory-postgres16-integration.test.mjs.
// Runs DISCOVERY ONLY against a given fixture file, in its own isolated
// process (so each measurement starts from a fresh heap, uncontaminated by
// whatever the parent test process itself has already allocated), sampling
// process.memoryUsage().rss every 20ms and reporting the peak observed.
//
// Not meant to be run standalone for anything other than this one
// measurement -- env vars: DATABASE_URL, CHUNKS_FILE_PATH, SNAPSHOT_ID.
import pg from "pg";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createOrResumeLoadSession, runDiscoveryPhase } from "../domain/postgres/reference-dedup-resumable-loader.mjs";
import { createDedupLoadSessionRepository } from "../domain/postgres/reference-dedup-load-session-repository.mjs";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const existingSchema = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'");
  if (existingSchema.rows.length === 0) {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await applyReferenceReleaseMigration({ client, root: ROOT });
    await client.query(await readFile(path.join(ROOT, "domain/postgres/004_reference_dedup_retrieval_index.sql"), "utf8"));
    await client.query(await readFile(path.join(ROOT, "domain/postgres/005_reference_dedup_load_sessions.sql"), "utf8"));
    await importReferenceRelease({
      client, root: ROOT,
      bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
      bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
      finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
      finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
      expectedReleaseId: "seed-release-v0.20",
    });
  }

  const { session } = await createOrResumeLoadSession({
    client, releaseId: "seed-release-v0.20", snapshotId: process.env.SNAPSHOT_ID,
    snapshotManifestSha256: "a".repeat(64), documentChunksSha256: "b".repeat(64),
    embeddingConfig: { provider: "test-fixture", model: "deterministic-fake-embedding-v1", revision: "v1", dimension: 8 },
    distanceMetric: "cosine", chunkingPolicyId: "document-node-first-v0.1",
    chunkingPolicySha256: "c930bdb99ac087287772037ad315f640725d5be7331ede56562dd9a1f95365fd",
    batchSize: 500, discoveryBatchSize: 500, maxRetryAttempts: 3, leaseDurationMs: 60000,
    codeRevision: "memory-test",
  });

  let peakRssBytes = 0;
  const sampler = setInterval(() => {
    if (global.gc) global.gc();
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 20);

  let reachedEnd = false;
  while (!reachedEnd) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath: process.env.CHUNKS_FILE_PATH, maxBatches: 20 });
    reachedEnd = result.reachedEnd;
  }
  clearInterval(sampler);

  const repo = createDedupLoadSessionRepository({ client });
  const finalSession = await repo.getSession(session.load_session_id);
  await client.end();

  console.log(JSON.stringify({
    discoveredOccurrenceCount: finalSession.discovered_occurrence_count,
    discoveredCanonicalCount: finalSession.discovered_canonical_count,
    peakRssMb: peakRssBytes / 1024 / 1024,
  }));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
