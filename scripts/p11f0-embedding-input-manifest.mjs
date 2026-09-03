#!/usr/bin/env node
// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section O: builds the
// unique-embedding-input manifest, 2-shard/4-shard plans, and a
// deterministic 5,000-sample GPU benchmark selection -- from the REAL,
// already-discovered reference_fixed_kure_canonical_queue rows for a
// GREEN (DISCOVERY_COMPLETE) attempt. Runs ONLY after Discovery is GREEN
// (the caller is expected to have already verified this -- see
// scripts/p11f0-spool-native-copy-load.mjs's own SPOOL_LOAD_COMPLETE and
// completeDiscovery()).
//
// NEVER calls the embedding model, NEVER uploads anything -- this Turn's
// own instructions forbid both. Large per-row text content is written
// ONLY under a task-owned, git-ignored `work/` directory; the git-tracked
// output (embedding-input-manifest.summary.json) carries aggregate
// counts and SHA-256 pins only, never raw text.
import { writeFile, mkdir, rename } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(partialPath, finalPath);
}

// Deterministic shard assignment: shard = first 4 hex chars of
// embed_text_sha256, interpreted as an integer, mod shardCount --
// reproducible from the hash alone, no ordering/RNG dependency.
function shardIndexFor(embedTextSha256, shardCount) {
  const prefix = parseInt(embedTextSha256.slice(0, 8), 16);
  return prefix % shardCount;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const executionAttemptId = process.env.P11F0_EXECUTION_ATTEMPT_ID;
  if (!executionAttemptId) throw new Error("P11F0_EXECUTION_ATTEMPT_ID is required");
  const outDir = process.env.P11F0_MANIFEST_OUT_DIR;
  if (!outDir) throw new Error("P11F0_MANIFEST_OUT_DIR is required -- no default path");
  const summaryOutPath = process.env.P11F0_MANIFEST_SUMMARY_PATH;
  if (!summaryOutPath) throw new Error("P11F0_MANIFEST_SUMMARY_PATH is required -- no default path");
  const benchmarkSampleSize = Number(process.env.P11F0_BENCHMARK_SAMPLE_SIZE ?? 5000);

  await mkdir(outDir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const session = (await client.query(
      `SELECT status, discovered_unique_text_count, corpus_snapshot_id, chunking_policy_id, chunking_policy_sha256,
              code_revision, pass1_chunk_stream_sha256, pass2_chunk_stream_sha256
       FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = $1`,
      [executionAttemptId],
    )).rows[0];
    if (!session) throw new Error(`ATTEMPT_NOT_FOUND: ${executionAttemptId}`);
    // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction): a row
    // marked INVALID_DISCOVERY_CANONICAL_SCOPE (its OWN
    // discovered_unique_text_count/expected_unique_embeddable_count are
    // wrong -- see markInvalidDiscoveryCanonicalScope's header) is exactly
    // the case this corrected manifest generator exists for: its
    // chunk_staging/canonical_queue rows are NOT deleted or altered, only
    // read here as a read-only source, properly scoped this time (see the
    // EXISTS-against-chunk_staging filter below).
    if (session.status !== "DISCOVERY_COMPLETE" && session.status !== "INVALID_DISCOVERY_CANONICAL_SCOPE") {
      throw new Error(`DISCOVERY_NOT_GREEN: execution_attempt_id ${executionAttemptId} has status=${session.status}, not DISCOVERY_COMPLETE or INVALID_DISCOVERY_CANONICAL_SCOPE -- refusing to build an embedding-input manifest`);
    }

    console.error("[embedding-manifest] streaming canonical_queue rows referenced by >=1 retrieval_eligible occurrence (embed_text_sha256, char_length only for the manifest; full text saved to task-owned storage)...");
    // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY: this Turn's own root-cause
    // investigation found "Invalid string length" comes from exactly this
    // pattern -- naively `+=`-accumulating hundreds of thousands of rows
    // into ONE JS string before a single write. Fixed the same way
    // discovery-file-spool.mjs's shard writer is: bounded per-page
    // synchronous writes to an open file descriptor, hashed incrementally,
    // never one giant string held in memory.
    const PAGE_SIZE = 5000;
    let lastHash = "";
    const rows = []; // { embed_text_sha256, char_length } only -- kept for shard assignment/aggregate stats
    const fullTextOutPath = path.join(outDir, "embedding-input-fulltext.jsonl");
    const fullTextHash = createHash("sha256");
    const fd = openSync(fullTextOutPath, "w");
    let fullTextByteCount = 0;
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction): the
        // embedding target is "distinct embed_text_sha256 referenced by
        // >=1 retrieval_eligible=true occurrence", NOT "every row in
        // canonical_queue" -- v1's pre-existing unique-text tracking adds
        // a hash to canonical_queue regardless of the chunk's own
        // eligibility, so an "orphan" hash referenced by NO eligible chunk
        // (only by fallback-tier/AUDIT_ONLY chunks, which chunk_staging
        // never stores) must be excluded here. This EXISTS filter also
        // correctly handles a hash whose FIRST-seen occurrence was
        // ineligible but a LATER occurrence was eligible -- it is included
        // because chunk_staging has >=1 row for it, independent of
        // discovery order.
        const page = await client.query(
          `SELECT c.embed_text_sha256, c.embed_text, c.char_length
           FROM disclosure_reference.reference_fixed_kure_canonical_queue c
           WHERE c.load_session_id = $1 AND c.embed_text_sha256 > $2
             AND EXISTS (
               SELECT 1 FROM disclosure_reference.reference_fixed_kure_chunk_staging s
               WHERE s.load_session_id = c.load_session_id AND s.embed_text_sha256 = c.embed_text_sha256
             )
           ORDER BY c.embed_text_sha256 LIMIT $3`,
          [executionAttemptId, lastHash, PAGE_SIZE],
        );
        if (page.rows.length === 0) break;
        let pageText = "";
        for (const row of page.rows) {
          rows.push({ embed_text_sha256: row.embed_text_sha256, char_length: row.char_length });
          pageText += `${JSON.stringify({ embedding_input_id: `embin_${row.embed_text_sha256.slice(0, 24)}`, embed_text_sha256: row.embed_text_sha256, char_length: row.char_length, text: row.embed_text })}\n`;
        }
        const pageBuf = Buffer.from(pageText, "utf8");
        writeSync(fd, pageBuf);
        fullTextHash.update(pageBuf);
        fullTextByteCount += pageBuf.byteLength;
        lastHash = page.rows[page.rows.length - 1].embed_text_sha256;
        if (rows.length % 50000 === 0) console.error(`[embedding-manifest] streamed ${rows.length} rows so far...`);
      }
    } finally {
      closeSync(fd);
    }
    const fullTextSha256 = fullTextHash.digest("hex");
    console.error(`[embedding-manifest] streamed ${rows.length} total unique embedding inputs; full-text file written to ${fullTextOutPath} (task-owned, never committed)`);

    // Duplicate/missing checks BEFORE building shard plans.
    const seenHashes = new Set();
    let duplicateCount = 0;
    for (const r of rows) {
      if (seenHashes.has(r.embed_text_sha256)) duplicateCount += 1;
      seenHashes.add(r.embed_text_sha256);
    }
    if (duplicateCount > 0) throw new Error(`MANIFEST_DUPLICATE_ROWS: ${duplicateCount} duplicate embed_text_sha256 rows found -- refusing to build a manifest`);
    if (seenHashes.size !== rows.length) throw new Error("MANIFEST_ROW_COUNT_MISMATCH");
    // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction):
    // session.discovered_unique_text_count is NOT used as the reference
    // here -- for an INVALID_DISCOVERY_CANONICAL_SCOPE row it is, by
    // definition, the WRONG (orphan-inflated) number, deliberately left
    // unchanged on that row as a historical record. The independent
    // cross-check instead re-derives the true eligible-referenced-distinct
    // count directly from chunk_staging and compares it against what this
    // script itself streamed -- both computed independently, neither
    // trusting the (possibly stale) summary field.
    const eligibleDistinctCount = (await client.query(
      `SELECT count(DISTINCT embed_text_sha256)::int AS n FROM disclosure_reference.reference_fixed_kure_chunk_staging WHERE load_session_id = $1`,
      [executionAttemptId],
    )).rows[0].n;
    if (seenHashes.size !== eligibleDistinctCount) {
      throw new Error(`MANIFEST_COUNT_MISMATCH: streamed ${seenHashes.size} eligible-referenced rows != independently-recounted chunk_staging distinct count ${eligibleDistinctCount}`);
    }
    const allEmbeddingInputIds = new Set([...seenHashes].map((h) => `embin_${h.slice(0, 24)}`));

    // 2-shard and 4-shard plans -- deterministic, SHA-prefix-based.
    function buildShardPlan(shardCount) {
      const shards = Array.from({ length: shardCount }, () => ({ count: 0, embedding_input_ids: [] }));
      for (const r of rows) {
        const idx = shardIndexFor(r.embed_text_sha256, shardCount);
        shards[idx].count += 1;
        shards[idx].embedding_input_ids.push(`embin_${r.embed_text_sha256.slice(0, 24)}`);
      }
      const shardHashes = shards.map((s) => sha256Hex(s.embedding_input_ids.slice().sort()));
      const totalAssigned = shards.reduce((sum, s) => sum + s.count, 0);
      // Intersection check: every id appears in exactly one shard (structurally guaranteed by
      // shardIndexFor being a pure function of the hash -- verified explicitly anyway).
      const seenInShards = new Set();
      let overlapCount = 0;
      for (const s of shards) {
        for (const id of s.embedding_input_ids) {
          if (seenInShards.has(id)) overlapCount += 1;
          seenInShards.add(id);
        }
      }
      return {
        shard_count: shardCount,
        shards: shards.map((s, i) => ({ shard_index: i, row_count: s.count, shard_sha256: shardHashes[i] })),
        total_assigned: totalAssigned,
        total_expected: rows.length,
        overlap_count: overlapCount,
        complete: totalAssigned === rows.length && overlapCount === 0,
      };
    }
    const shardPlan2 = buildShardPlan(2);
    const shardPlan4 = buildShardPlan(4);

    // Deterministic 5,000-sample benchmark selection: sort by
    // embed_text_sha256 (already the manifest's own canonical ordering),
    // take a SHA-evenly-spaced selection so the sample isn't just "the
    // first N insertion-order rows" -- reproducible from the sorted hash
    // list alone, no RNG.
    const sortedHashes = rows.map((r) => r.embed_text_sha256).sort();
    const sampleSize = Math.min(benchmarkSampleSize, sortedHashes.length);
    const step = sortedHashes.length / sampleSize;
    const sampleIndices = new Set();
    for (let i = 0; i < sampleSize; i += 1) sampleIndices.add(Math.floor(i * step));
    const benchmarkSampleHashes = [...sampleIndices].sort((a, b) => a - b).map((i) => sortedHashes[i]);
    const benchmarkSampleIds = benchmarkSampleHashes.map((h) => `embin_${h.slice(0, 24)}`);
    const benchmarkSampleSha256 = sha256Hex(benchmarkSampleIds);

    const rawCanonicalCount = (await client.query(
      `SELECT count(*)::int AS n FROM disclosure_reference.reference_fixed_kure_canonical_queue WHERE load_session_id = $1`,
      [executionAttemptId],
    )).rows[0].n;
    const orphanCount = rawCanonicalCount - rows.length;

    const summary = {
      schema_version: "p11f0-embedding-input-manifest.v1",
      execution_attempt_id: executionAttemptId,
      corpus_snapshot_id: session.corpus_snapshot_id,
      chunking_policy_id: session.chunking_policy_id,
      chunking_policy_sha256: session.chunking_policy_sha256,
      // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY (post-hoc correction):
      // pins the parent attempt's identity/original stream SHA/code
      // revision this corrected manifest was built from, and reports the
      // scope correction explicitly (raw canonical_queue row count vs. the
      // corrected, eligible-referenced-only unique_input_count below).
      scope_correction: {
        parent_execution_attempt_id: executionAttemptId,
        parent_status_at_generation: session.status,
        original_pass1_chunk_stream_sha256: session.pass1_chunk_stream_sha256,
        original_pass2_chunk_stream_sha256: session.pass2_chunk_stream_sha256,
        original_code_revision: session.code_revision,
        raw_canonical_queue_row_count: rawCanonicalCount,
        orphan_canonical_row_count: orphanCount,
        note: "unique_input_count below is scoped to distinct embed_text_sha256 referenced by >=1 retrieval_eligible=true chunk_staging occurrence (an EXISTS filter against chunk_staging, independently re-verified against a fresh count(DISTINCT ...) query) -- raw_canonical_queue_row_count includes orphan_canonical_row_count unique texts referenced by NO eligible occurrence (only by fallback-tier/AUDIT_ONLY chunks), which are correctly excluded from the embedding target.",
      },
      model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024, dtype: "float32" },
      normalization: "l2 (unit-norm, matches KURE-v1's own published usage -- applied by the runner, never by this manifest)",
      unique_input_count: rows.length,
      full_text_file: {
        note: "task-owned storage only -- never committed to git; deterministic JSONL, one embedding input per line, ordered by embed_text_sha256",
        sha256: fullTextSha256,
        line_count: rows.length,
      },
      shard_plan_2: shardPlan2,
      shard_plan_4: shardPlan4,
      benchmark_sample: {
        requested_size: benchmarkSampleSize,
        actual_size: benchmarkSampleIds.length,
        selection_method: "deterministic SHA-evenly-spaced (sorted embed_text_sha256, step = total/sample_size, floor-indexed)",
        sample_manifest_sha256: benchmarkSampleSha256,
        duplicate_count: benchmarkSampleIds.length - new Set(benchmarkSampleIds).size,
        missing_from_full_set: benchmarkSampleIds.filter((id) => !allEmbeddingInputIds.has(id)).length,
        // Kept in the git-tracked summary (small: ~5,000 short id strings,
        // not raw text) so scripts/p11f0-gpu-benchmark-result-verify.mjs
        // can check a downloaded result file's id set for 0 missing/0
        // unexpected without needing the full (task-owned-only) manifest.
        sample_ids: benchmarkSampleIds,
      },
      external_upload_performed: false,
      real_embedding_calls_performed: 0,
      generated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(summaryOutPath, summary);
    console.error(`[embedding-manifest] summary written to ${summaryOutPath}`);
    console.error(`[embedding-manifest] unique_input_count=${rows.length} shard_plan_2.complete=${shardPlan2.complete} shard_plan_4.complete=${shardPlan4.complete} benchmark_sample.actual_size=${summary.benchmark_sample.actual_size}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[embedding-manifest] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
