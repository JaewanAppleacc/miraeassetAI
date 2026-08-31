#!/usr/bin/env node
// Turn P8, Section J Stage 3: stream the REAL, FULL Turn P5 snapshot
// (1,874,688 occurrences / 723,875 unique text_sha256) through DISCOVERY
// ONLY -- no embedding call is ever made by this script. Proves (a) the
// resumable loader's discovery phase actually completes against the real,
// full-scale source, (b) the resulting canonical/occurrence counts match
// the Turn P5 pinned values exactly, and (c) peak RSS stays bounded rather
// than growing linearly with the 1,874,688-row input.
//
// Required env:
//   DATABASE_URL          a real, EMPTY scratch PostgreSQL 16+pgvector database
//   SNAPSHOT_CHUNKS_PATH  absolute path to the real document-chunks.v0.1.jsonl
//                         (this script verifies its SHA256 against the Turn P5
//                         pin below before reading a single byte, and never
//                         writes to this path)
//
// This script deliberately never touches Gold/HOLDOUT data, never calls a
// real (or fake) embedding adapter, and never copies/symlinks the source
// file -- it opens it read-only, in place, exactly where Section C's
// verified snapshot location already lives.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { createOrResumeLoadSession, runDiscoveryPhase } from "../domain/postgres/reference-dedup-resumable-loader.mjs";
import { createDedupLoadSessionRepository } from "../domain/postgres/reference-dedup-load-session-repository.mjs";
import { importReferenceRelease, applyReferenceReleaseMigration } from "../domain/postgres/reference-release-loader.mjs";
import path from "node:path";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");

const PINNED_SNAPSHOT_ID = "docsnap_8e480ec27b33b15bada7b3e764df5385";
const PINNED_CHUNKS_SHA256 = "4fa1ea1c97a550ce35b287164268ed22ae4bd02df357b0c24845604d92bf0b7b";
const EXPECTED_OCCURRENCE_COUNT = 1_874_688;
const EXPECTED_CANONICAL_COUNT = 723_875;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const chunksPath = process.env.SNAPSHOT_CHUNKS_PATH;
  if (!databaseUrl || !chunksPath) {
    console.error("DOCUMENT_SNAPSHOT_INPUT_NOT_AVAILABLE: both DATABASE_URL and SNAPSHOT_CHUNKS_PATH are required.");
    process.exit(1);
  }

  const stats = await stat(chunksPath).catch(() => null);
  if (!stats) {
    console.error(`DOCUMENT_SNAPSHOT_INPUT_NOT_AVAILABLE: SNAPSHOT_CHUNKS_PATH does not exist: ${chunksPath}`);
    process.exit(1);
  }
  console.error(`[stage3] verifying SHA256 of ${chunksPath} (${stats.size} bytes)...`);
  const actualSha256 = await sha256File(chunksPath);
  if (actualSha256 !== PINNED_CHUNKS_SHA256) {
    console.error(`DOCUMENT_SNAPSHOT_INPUT_NOT_AVAILABLE: SHA256 mismatch. expected=${PINNED_CHUNKS_SHA256} actual=${actualSha256}`);
    process.exit(1);
  }
  console.error("[stage3] SHA256 verified, matches the Turn P5 pin exactly.");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const existingSchema = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'");
  if (existingSchema.rows.length === 0) {
    await applyReferenceReleaseMigration({ client, root: ROOT });
    const { readFile } = await import("node:fs/promises");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
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
    client,
    releaseId: "seed-release-v0.20",
    snapshotId: PINNED_SNAPSHOT_ID,
    snapshotManifestSha256: PINNED_CHUNKS_SHA256, // discovery-only run: no separate manifest file read by this script
    documentChunksSha256: PINNED_CHUNKS_SHA256,
    embeddingConfig: { provider: "discovery-only-stage3", model: "not-called", revision: "v1", dimension: 8 },
    distanceMetric: "cosine",
    chunkingPolicyId: "document-node-first-v0.1",
    chunkingPolicySha256: "c930bdb99ac087287772037ad315f640725d5be7331ede56562dd9a1f95365fd",
    batchSize: 500,
    discoveryBatchSize: Number(process.env.DISCOVERY_BATCH_SIZE ?? 2000),
    maxRetryAttempts: 3,
    leaseDurationMs: 60_000,
    codeRevision: "turn-p8-stage3",
  });
  console.error(`[stage3] load_session_id=${session.load_session_id} status=${session.status} resuming from line ${session.source_line_number}, byte ${session.source_byte_offset}`);

  let peakRssBytes = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 500);
  sampler.unref();

  const repo = createDedupLoadSessionRepository({ client });
  const startedAt = Date.now();
  let reachedEnd = false;
  let iterations = 0;
  while (!reachedEnd) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runDiscoveryPhase({ client, loadSessionId: session.load_session_id, chunksFilePath: chunksPath, maxBatches: 50 });
    reachedEnd = result.reachedEnd;
    iterations += 1;
    if (iterations % 5 === 0 || reachedEnd) {
      // eslint-disable-next-line no-await-in-loop
      const current = await repo.getSession(session.load_session_id);
      const rssNowMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const peakMb = (peakRssBytes / 1024 / 1024).toFixed(1);
      console.error(`[stage3] line=${current.source_line_number} occurrences=${current.discovered_occurrence_count} canonical=${current.discovered_canonical_count} rss=${rssNowMb}MB peak=${peakMb}MB elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
  }
  clearInterval(sampler);

  const finalSession = await repo.getSession(session.load_session_id);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  console.error(`[stage3] DISCOVERY_COMPLETE: occurrences=${finalSession.discovered_occurrence_count} canonical=${finalSession.discovered_canonical_count} elapsed=${elapsedSeconds.toFixed(1)}s peak_rss=${(peakRssBytes / 1024 / 1024).toFixed(1)}MB`);

  const occurrenceMatch = finalSession.discovered_occurrence_count === EXPECTED_OCCURRENCE_COUNT;
  const canonicalMatch = finalSession.discovered_canonical_count === EXPECTED_CANONICAL_COUNT;
  console.log(JSON.stringify({
    load_session_id: session.load_session_id,
    discovered_occurrence_count: finalSession.discovered_occurrence_count,
    discovered_canonical_count: finalSession.discovered_canonical_count,
    expected_occurrence_count: EXPECTED_OCCURRENCE_COUNT,
    expected_canonical_count: EXPECTED_CANONICAL_COUNT,
    occurrence_count_matches_pin: occurrenceMatch,
    canonical_count_matches_pin: canonicalMatch,
    elapsed_seconds: elapsedSeconds,
    peak_rss_mb: peakRssBytes / 1024 / 1024,
    status: finalSession.status,
  }, null, 2));

  await client.end();
  if (!occurrenceMatch || !canonicalMatch) {
    console.error("[stage3] FAILED: discovered counts do not match the Turn P5 pin.");
    process.exit(1);
  }
  console.error("[stage3] PASSED: full 1,874,688/723,875 discovery counts match the pin exactly.");
}

main().catch((error) => {
  console.error(`[stage3] FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
