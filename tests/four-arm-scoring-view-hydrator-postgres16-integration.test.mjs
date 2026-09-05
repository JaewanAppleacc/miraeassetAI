// Turn FOURARM-AC-SCORING-VIEW-FIX-V1: REAL, read-only PostgreSQL 16
// integration test for scripts/p11f0-fourarm-scoring-view-hydrator.mjs.
// Exercises the hydrator against the SAME READY retrieval index
// (fixed_kure_index_8fe191342205848d1d6a6123f38a54e7) that produced the
// original A/C retrieval, using A/C's own already-committed
// results.jsonl as input. Confirms: read-only (no writes to the index
// tables -- verified by row-count before/after), 100% hydration success
// with zero missing/duplicate/hash-mismatch/document-mismatch, and
// byte-level invariance of every non-`text` field.
//
// Excluded from `npm run test:domain`/`verify:contracts` (same discipline
// as the other *-postgres16-integration.test.mjs files in this repo).
// Fails CLOSED (never a silent skip) if DATABASE_URL is not set. Zero
// DEV_TUNE/DEV_CHECK/HOLDOUT/Gold access -- reads only the retrieval
// index's own already-materialized chunk text, keyed by A/C's own
// already-retrieved chunk_id, never Gold. Invoke explicitly:
//
//   DATABASE_URL='postgresql://user@host:port/scratch_db' \
//     node --test tests/four-arm-scoring-view-hydrator-postgres16-integration.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, readFile as readFileAgain } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { assertReadyIndex, fetchChunkRows, hydrateArm, RETRIEVAL_INDEX_ID, KURE_EXPECTED_PINS } from "../scripts/p11f0-fourarm-scoring-view-hydrator.mjs";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`FOUR_ARM_SCORING_VIEW_HYDRATOR_POSTGRESQL_16_INTEGRATION_NOT_RUN: ${name} is required to run tests/four-arm-scoring-view-hydrator-postgres16-integration.test.mjs`);
  }
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const RESULTS_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../domain/agent-comparison/four-arm-ac/results");

let client;
let tmpDir;

test.before(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  tmpDir = await mkdtemp(path.join(tmpdir(), "fourarm-hydrator-it-"));
});

test.after(async () => {
  await client?.end();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

test("the READY retrieval index exists with the expected KURE pins", async () => {
  const index = await assertReadyIndex(client);
  assert.equal(index.retrieval_index_id, RETRIEVAL_INDEX_ID);
  assert.equal(index.index_status, "READY");
  for (const [key, expected] of Object.entries(KURE_EXPECTED_PINS)) {
    assert.equal(String(index[key]), String(expected), `pin mismatch on ${key}`);
  }
});

test("a real chunk_id from A's own committed results.jsonl resolves to a row whose own SHA-256 matches chunk_text_sha256", async () => {
  const raw = await readFile(path.join(RESULTS_DIR, "A.results.jsonl"), "utf8");
  const row = JSON.parse(raw.split("\n").find((l) => l.trim().length > 0));
  const item = row.results[0];
  const { byChunkId, dupCount } = await fetchChunkRows(client, [item.chunk_id]);
  const dbRow = byChunkId.get(item.chunk_id);
  assert.ok(dbRow, "chunk_id must exist in the READY retrieval index");
  assert.equal(dupCount.get(item.chunk_id), 1, "chunk_id must be unique in the index");
  assert.equal(dbRow.source_document_id, item.doc_id);
  const actualSha = createHash("sha256").update(dbRow.text_content, "utf8").digest("hex");
  assert.equal(actualSha, item.chunk_text_sha256);
});

test("full hydrateArm pass on A and C's real committed results.jsonl: 100% success, zero integrity failures, and the read-only transaction leaves the index tables' row counts unchanged", async () => {
  const before = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id = $1",
    [RETRIEVAL_INDEX_ID],
  );

  await client.query("BEGIN TRANSACTION READ ONLY");
  const results = {};
  try {
    for (const arm of ["A", "C"]) {
      results[arm] = await hydrateArm(client, arm, path.join(RESULTS_DIR, `${arm}.results.jsonl`));
    }
  } finally {
    await client.query("ROLLBACK");
  }

  const after = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id = $1",
    [RETRIEVAL_INDEX_ID],
  );
  assert.equal(after.rows[0].n, before.rows[0].n, "hydration must never write to the retrieval index tables");

  for (const arm of ["A", "C"]) {
    const r = results[arm];
    assert.equal(r.counts.missing, 0);
    assert.equal(r.counts.duplicate, 0);
    assert.equal(r.counts.duplicate_within_question, 0);
    assert.equal(r.counts.hash_mismatch, 0);
    assert.equal(r.counts.document_mismatch, 0);
    assert.equal(r.counts.hydrated_success, r.counts.total_items);
    assert.equal(r.invarianceOk, true);
    assert.equal(r.invarianceMismatches.length, 0);
    assert.equal(r.anyFailure, false);
  }
});

test("hydrateArm never mutates the original results.jsonl file on disk", async () => {
  const armPath = path.join(RESULTS_DIR, "A.results.jsonl");
  const before = await readFileAgain(armPath, "utf8");
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await hydrateArm(client, "A", armPath);
  } finally {
    await client.query("ROLLBACK");
  }
  const after = await readFileAgain(armPath, "utf8");
  assert.equal(after, before);
});
