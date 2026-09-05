// Read-only verification of the real scratch full-population import.
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const SUCCESSOR = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e";
const SOURCE = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const INDEX = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
let client;
test.before(async () => { client = new Client({ connectionString: databaseUrl }); await client.connect(); });
test.after(async () => { await client.end(); });

test("migration 013 is recorded exactly once", async () => {
  const r = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.schema_migrations WHERE migration_id='013_reference_fixed_kure_precomputed_embeddings_v0.1'");
  assert.equal(r.rows[0].n, 1);
});

test("terminal discovery source remains immutable and unembedded", async () => {
  const r = await client.query(`SELECT status, discovered_search_eligible_count, discovered_unique_text_count,
    embedded_unique_text_count, materialized_chunk_count, updated_at
    FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id=$1`, [SOURCE]);
  assert.equal(r.rows[0].status, "INVALID_DISCOVERY_CANONICAL_SCOPE");
  assert.equal(r.rows[0].discovered_search_eligible_count, 442549);
  assert.equal(r.rows[0].discovered_unique_text_count, 447225);
  assert.equal(r.rows[0].embedded_unique_text_count, 0);
  assert.equal(r.rows[0].materialized_chunk_count, 0);
  assert.equal(new Date(r.rows[0].updated_at).toISOString(), "2026-09-03T16:08:22.850Z");
});

test("successor is READY with exact inherited and imported counts", async () => {
  const r = await client.query(`SELECT status, discovery_source_load_session_id,
    expected_unique_embeddable_count, embedded_unique_text_count,
    expected_search_eligible_count, materialized_chunk_count
    FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id=$1`, [SUCCESSOR]);
  assert.equal(r.rows[0].status, "READY");
  assert.equal(r.rows[0].discovery_source_load_session_id, SOURCE);
  assert.equal(r.rows[0].expected_unique_embeddable_count, 441879);
  assert.equal(r.rows[0].embedded_unique_text_count, 441879);
  assert.equal(r.rows[0].expected_search_eligible_count, 442549);
  assert.equal(r.rows[0].materialized_chunk_count, 442549);
});

test("all eight imported shards cover exactly 441879 unique inputs", async () => {
  const r = await client.query(`SELECT count(*)::int AS n,
    count(DISTINCT embed_text_sha256)::int AS hashes,
    count(DISTINCT embedding_input_id)::int AS ids,
    count(DISTINCT global_eligible_index)::int AS indices,
    min(global_eligible_index)::int AS min_index,
    max(global_eligible_index)::int AS max_index,
    count(*) FILTER (WHERE vector_dims(embedding) <> 1024)::int AS bad_dimensions
    FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings WHERE load_session_id=$1`, [SUCCESSOR]);
  assert.deepEqual(r.rows[0], { n: 441879, hashes: 441879, ids: 441879, indices: 441879, min_index: 0, max_index: 441878, bad_dimensions: 0 });
  const shards = await client.query("SELECT shard_index,row_count FROM disclosure_reference.reference_fixed_kure_precomputed_embedding_shards WHERE load_session_id=$1 ORDER BY shard_index", [SUCCESSOR]);
  assert.deepEqual(shards.rows.map((x) => x.shard_index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(shards.rows.reduce((sum, x) => sum + x.row_count, 0), 441879);
});

test("every imported hash belongs to an eligible source chunk", async () => {
  const r = await client.query(`SELECT count(*)::int AS n
    FROM disclosure_reference.reference_fixed_kure_precomputed_embeddings p
    WHERE p.load_session_id=$1 AND NOT EXISTS (
      SELECT 1 FROM disclosure_reference.reference_fixed_kure_chunk_staging c
      WHERE c.load_session_id=$2 AND c.retrieval_eligible AND c.embed_text_sha256=p.embed_text_sha256
    )`, [SUCCESSOR, SOURCE]);
  assert.equal(r.rows[0].n, 0);
});

test("retrieval index has exactly 442549 unique, 1024-dimensional chunks", async () => {
  const index = await client.query("SELECT index_status,record_count FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id=$1", [INDEX]);
  assert.deepEqual(index.rows[0], { index_status: "READY", record_count: 442549 });
  const chunks = await client.query(`SELECT count(*)::int AS n, count(DISTINCT chunk_id)::int AS unique_chunks,
    count(*) FILTER (WHERE vector_dims(embedding) <> 1024)::int AS bad_dimensions
    FROM disclosure_reference.reference_retrieval_chunks WHERE retrieval_index_id=$1`, [INDEX]);
  assert.deepEqual(chunks.rows[0], { n: 442549, unique_chunks: 442549, bad_dimensions: 0 });
});

test("dense self-match returns its own chunk at rank one", async () => {
  const r = await client.query(`WITH q AS (
      SELECT chunk_id,embedding FROM disclosure_reference.reference_retrieval_chunks
      WHERE retrieval_index_id=$1 ORDER BY chunk_id LIMIT 1
    )
    SELECT c.chunk_id,q.chunk_id AS expected
    FROM disclosure_reference.reference_retrieval_chunks c CROSS JOIN q
    WHERE c.retrieval_index_id=$1
    ORDER BY c.embedding <=> q.embedding, c.chunk_id LIMIT 1`, [INDEX]);
  assert.equal(r.rows[0].chunk_id, r.rows[0].expected);
});
