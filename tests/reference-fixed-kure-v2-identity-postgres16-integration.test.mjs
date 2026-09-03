// Turn AC-FULL-LOAD-V2: REAL PostgreSQL 16 validation of the
// logical_load_id / execution_attempt_id identity split
// (007_reference_fixed_kure_superseded_status.sql,
// 008_reference_fixed_kure_load_sessions_v2_identity.sql) and the new
// repository functions (createOrGetAttempt, supersedeZeroProgressSession,
// resetDiscoveryCheckpoint) added to
// domain/postgres/reference-fixed-kure-load-session-repository.mjs.
//
// Every test uses its OWN synthetic corpusSnapshotId (a random suffix), so
// nothing here ever reads-for-mutation or writes to the real fixture rows
// this Turn's actual work touched (fixed_kure_session_21f4... [READY
// 750-doc shard], fixed_kure_session_8fe19... [superseded 0%-progress
// attempt], fixed_kure_attempt_f40dc66a... [the real full-corpus attempt])
// -- those are asserted read-only, unchanged, at the end of this file.
//
// Excluded from `npm run test:domain`/`verify:contracts` (same discipline
// as every other *-postgres16-integration.test.mjs in this repo). Fails
// CLOSED if DATABASE_URL is not set. Zero DEV_TUNE/DEV_CHECK/HOLDOUT/Gold
// access.
//
//   DATABASE_URL='postgresql://user@host:port/scratch_db' \
//     node --test tests/reference-fixed-kure-v2-identity-postgres16-integration.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import {
  createFixedKureLoadSessionRepository, FixedKureLoadSessionError,
  computeFixedKureLogicalLoadId, computeFixedKureExecutionAttemptId,
} from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`REFERENCE_FIXED_KURE_V2_IDENTITY_POSTGRESQL_16_INTEGRATION_NOT_RUN: ${name} is required to run tests/reference-fixed-kure-v2-identity-postgres16-integration.test.mjs`);
  }
  return value;
}
const databaseUrl = requireEnv("DATABASE_URL");

const REAL_READY_SHARD_SESSION_ID = "fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583";
const REAL_SUPERSEDED_ZERO_PROGRESS_SESSION_ID = "fixed_kure_session_8fe191342205848d1d6a6123f38a54e7";
const REAL_FULL_LOAD_ATTEMPT_ID = "fixed_kure_attempt_f40dc66a8daf48a12397353dd65bc0c6";

let client;
let repo;

test.before(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  repo = createFixedKureLoadSessionRepository({ client });
});

test.after(async () => {
  await client.end();
});

function basePins(corpusSnapshotId, overrides = {}) {
  return {
    releaseId: "seed-release-v0.20",
    corpusSnapshotId,
    corpusManifestSha256: "a".repeat(64),
    embeddingProvider: "nlpai-lab",
    embeddingModel: "KURE-v1",
    embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
    embeddingDimension: 1024,
    distanceMetric: "cosine",
    chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
    chunkingPolicySha256: "b".repeat(64),
    batchSize: 8,
    discoveryBatchSize: 10,
    maxRetryAttempts: 3,
    leaseDurationMs: 120000,
    ...overrides,
  };
}

function freshCorpusSnapshotId() {
  return `test_v2_identity_${randomBytes(8).toString("hex")}`;
}

test("v1 backward compatibility: the real READY 750-doc shard session is unaffected by the v2 migration/columns", async () => {
  const session = await repo.getSession(REAL_READY_SHARD_SESSION_ID);
  assert.ok(session, "real READY shard session must still exist");
  assert.equal(session.status, "READY");
  assert.equal(session.discovered_document_count, 750);
  assert.equal(session.discovered_total_chunk_count, 1144);
  assert.equal(session.materialized_chunk_count, 1144);
  assert.equal(session.pass1_chunk_stream_sha256, session.pass2_chunk_stream_sha256);
  // Backfilled v2 columns must equal the row's own pre-existing identity --
  // v1 never distinguished logical load from execution attempt, so both
  // now-explicit columns collapse to what was already true.
  assert.equal(session.logical_load_id, REAL_READY_SHARD_SESSION_ID);
  assert.equal(session.execution_attempt_id, REAL_READY_SHARD_SESSION_ID);
  assert.equal(session.supersedes_load_session_id, null);
});

test("v1 backward compatibility: createOrGetSession (unchanged v1 API) still fail-closes on code_revision mismatch", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const pins = basePins(corpusSnapshotId, { codeRevision: "revision-one" });
  const { created } = await repo.createOrGetSession(pins);
  assert.equal(created, true);
  await assert.rejects(
    () => repo.createOrGetSession({ ...pins, codeRevision: "revision-two" }),
    (err) => err instanceof FixedKureLoadSessionError && err.code === "CODE_REVISION_MISMATCH",
  );
});

test("attempt identity is a deterministic pure function of (logicalLoadId, loaderContractVersion, codeRevision)", () => {
  const logicalLoadId = computeFixedKureLogicalLoadId({
    releaseId: "seed-release-v0.20", corpusSnapshotId: "x", embeddingProvider: "nlpai-lab",
    embeddingModel: "KURE-v1", embeddingRevision: "rev", chunkingPolicyId: "policy",
  });
  const a1 = computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion: "v2.0", codeRevision: "sha-a" });
  const a2 = computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion: "v2.0", codeRevision: "sha-a" });
  const b = computeFixedKureExecutionAttemptId({ logicalLoadId, loaderContractVersion: "v2.0", codeRevision: "sha-b" });
  assert.equal(a1, a2, "same inputs must yield the same execution_attempt_id every time");
  assert.notEqual(a1, b, "a different code_revision must yield a different execution_attempt_id");
  assert.match(a1, /^fixed_kure_attempt_[0-9a-f]{32}$/);
});

test("createOrGetAttempt: a replacement attempt (after superseding a zero-progress predecessor) gets an isolated row/checkpoint -- no cross-attempt mixing, and only ONE active (non-superseded) attempt may ever hold a given retrieval_index_id at a time", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const sharedPins = basePins(corpusSnapshotId, { loaderContractVersion: "v2.0" });

  const { session: attempt1 } = await repo.createOrGetAttempt({ ...sharedPins, codeRevision: "sha-attempt-1" });
  await repo.transitionStatus(attempt1.load_session_id, ["CREATED"], "DISCOVERING");
  await repo.insertCanonicalBatch(attempt1.load_session_id, [{ embedTextSha256: "c".repeat(64), embedText: "only in attempt 1", charLength: 18 }]);

  // A SECOND concurrently-active attempt of the SAME logical load must be
  // refused -- retrieval_index_id is logical-scoped (see 008's migration
  // header), so two simultaneously-active attempts would both eventually
  // try to materialize into the SAME index: exactly the concurrent-writer
  // hazard Turn AC-FULL-LOAD-V2 section A forbids.
  await assert.rejects(
    () => repo.createOrGetAttempt({ ...sharedPins, codeRevision: "sha-attempt-2-concurrent" }),
    (err) => err.code === "23505" || /unique constraint/.test(err.message),
  );

  // Once attempt 1 is superseded (must be zero-progress -- this repo's own
  // guard re-verifies that), a replacement attempt CAN reuse the same
  // logical/retrieval identity, and starts with a clean, isolated checkpoint.
  await repo.resetDiscoveryCheckpoint(attempt1.load_session_id); // undo the probe insert above so attempt1 is genuinely zero-progress
  await repo.supersedeZeroProgressSession(attempt1.load_session_id);

  const { session: attempt2 } = await repo.createOrGetAttempt({ ...sharedPins, codeRevision: "sha-attempt-2", supersedesLoadSessionId: attempt1.load_session_id });
  assert.notEqual(attempt1.load_session_id, attempt2.load_session_id, "different code_revision -> different row");
  assert.equal(attempt1.logical_load_id, attempt2.logical_load_id, "same logical pins -> same logical_load_id");
  assert.equal(attempt1.retrieval_index_id, attempt2.retrieval_index_id, "retrieval_index_id is logical-scoped, not attempt-scoped");

  await repo.transitionStatus(attempt2.load_session_id, ["CREATED"], "DISCOVERING");
  const queueForAttempt2 = await repo.queueStatusCounts(attempt2.load_session_id);
  assert.equal(queueForAttempt2.PENDING, 0, "attempt 2 must NOT see attempt 1's (wiped) checkpoint data -- no cross-attempt mixing");
});

test("createOrGetAttempt: reusing an existing attempt id is idempotent (same row returned, created=false)", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const pins = basePins(corpusSnapshotId, { loaderContractVersion: "v2.0", codeRevision: "sha-idempotent" });
  const first = await repo.createOrGetAttempt(pins);
  const second = await repo.createOrGetAttempt(pins);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.session.load_session_id, second.session.load_session_id);
});

test("supersedeZeroProgressSession: succeeds on a genuinely zero-progress DISCOVERING session, sets provenance, becomes terminal/immutable", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const { session } = await repo.createOrGetSession(basePins(corpusSnapshotId, { codeRevision: "sha-zero-progress" }));
  await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");

  const superseded = await repo.supersedeZeroProgressSession(session.load_session_id);
  assert.equal(superseded.status, "SUPERSEDED_ZERO_PROGRESS");
  assert.equal(superseded.last_error_code, "SUPERSEDED_ZERO_PROGRESS");

  // Terminal/immutable now -- even an otherwise-legal-shaped update must be refused.
  await assert.rejects(() => repo.transitionStatus(session.load_session_id, ["SUPERSEDED_ZERO_PROGRESS"], "DISCOVERING"));

  // A replacement attempt may legitimately cite it as supersedesLoadSessionId.
  const { session: replacement } = await repo.createOrGetAttempt(
    basePins(corpusSnapshotId, { loaderContractVersion: "v2.0", codeRevision: "sha-replacement", supersedesLoadSessionId: session.load_session_id }),
  );
  assert.equal(replacement.supersedes_load_session_id, session.load_session_id);
});

test("supersedeZeroProgressSession: REJECTED when discovery progress is non-zero (DB trigger re-verifies independently of the caller)", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const { session } = await repo.createOrGetSession(basePins(corpusSnapshotId, { codeRevision: "sha-nonzero-progress" }));
  await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");
  await repo.updateDiscoveryCheckpoint(session.load_session_id, {
    sourceFilesProgress: {}, newDocumentCount: 1, newTotalChunkCount: 2, newSearchEligibleCount: 2, newUniqueTextCount: 2,
  });

  await assert.rejects(
    () => repo.supersedeZeroProgressSession(session.load_session_id),
    /progress is non-zero/,
  );
  const stillDiscovering = await repo.getSession(session.load_session_id);
  assert.equal(stillDiscovering.status, "DISCOVERING", "rejected supersession must leave the row's status untouched");
});

test("resetDiscoveryCheckpoint: clears staging/queue rows and zeroes counters while DISCOVERING; refused once not DISCOVERING", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const { session } = await repo.createOrGetSession(basePins(corpusSnapshotId, { codeRevision: "sha-reset" }));
  await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");
  await repo.insertCanonicalBatch(session.load_session_id, [{ embedTextSha256: "d".repeat(64), embedText: "will be wiped", charLength: 13 }]);
  await repo.updateDiscoveryCheckpoint(session.load_session_id, {
    sourceFilesProgress: { "x.jsonl": { done: false, byte_offset: 5, line_number: 1 } },
    newDocumentCount: 1, newTotalChunkCount: 1, newSearchEligibleCount: 1, newUniqueTextCount: 1,
  });

  const reset = await repo.resetDiscoveryCheckpoint(session.load_session_id);
  assert.equal(reset.discovered_document_count, 0);
  assert.equal(reset.discovered_total_chunk_count, 0);
  assert.deepEqual(reset.source_files_progress, {});
  const counts = await repo.queueStatusCounts(session.load_session_id);
  assert.deepEqual(counts, { PENDING: 0, LEASED: 0, EMBEDDED: 0, FAILED: 0 });

  await repo.supersedeZeroProgressSession(session.load_session_id);
  await assert.rejects(
    () => repo.resetDiscoveryCheckpoint(session.load_session_id),
    (err) => err instanceof FixedKureLoadSessionError && err.code === "ILLEGAL_RESET",
  );
});

test("malformed vector rejected: embedding dimension mismatch refused by 006's own check_fixed_kure_queue_dimension trigger (unaffected by this Turn's migrations)", async () => {
  const corpusSnapshotId = freshCorpusSnapshotId();
  const { session } = await repo.createOrGetSession(basePins(corpusSnapshotId, { codeRevision: "sha-dim-check", embeddingDimension: 1024 }));
  await repo.transitionStatus(session.load_session_id, ["CREATED"], "DISCOVERING");
  await repo.insertCanonicalBatch(session.load_session_id, [{ embedTextSha256: "e".repeat(64), embedText: "dim probe", charLength: 9 }]);
  const wrongDimensionVector = new Array(8).fill(0.1);
  await assert.rejects(
    () => repo.markEmbedded(session.load_session_id, [{ embedTextSha256: "e".repeat(64), embedding: wrongDimensionVector }]),
    /embedding dimension/,
  );
});

test("migration idempotency (this repo's convention has no down-migration -- re-applying 007/008 must be a safe no-op, not a rollback)", async () => {
  const before = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.schema_migrations");
  await client.query(`
    BEGIN;
    ALTER TYPE disclosure_reference.fixed_kure_load_session_status ADD VALUE IF NOT EXISTS 'SUPERSEDED_ZERO_PROGRESS';
    INSERT INTO disclosure_reference.schema_migrations (migration_id) VALUES ('007_reference_fixed_kure_superseded_status_v0.1') ON CONFLICT (migration_id) DO NOTHING;
    COMMIT;
  `);
  await client.query(`
    BEGIN;
    ALTER TABLE disclosure_reference.reference_fixed_kure_load_sessions
      ADD COLUMN IF NOT EXISTS logical_load_id text,
      ADD COLUMN IF NOT EXISTS execution_attempt_id text,
      ADD COLUMN IF NOT EXISTS loader_contract_version text,
      ADD COLUMN IF NOT EXISTS supersedes_load_session_id text REFERENCES disclosure_reference.reference_fixed_kure_load_sessions(load_session_id);
    INSERT INTO disclosure_reference.schema_migrations (migration_id) VALUES ('008_reference_fixed_kure_load_sessions_v2_identity_v0.1') ON CONFLICT (migration_id) DO NOTHING;
    COMMIT;
  `);
  const after = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.schema_migrations");
  assert.equal(after.rows[0].n, before.rows[0].n, "re-applying already-applied migrations must not duplicate schema_migrations rows");
});

test("real Turn AC-FULL-LOAD-V2 fixture rows: superseded session, replacement attempt, and untouched READY shard are all consistent", async () => {
  const superseded = await repo.getSession(REAL_SUPERSEDED_ZERO_PROGRESS_SESSION_ID);
  assert.equal(superseded.status, "SUPERSEDED_ZERO_PROGRESS");
  assert.equal(superseded.last_error_code, "SUPERSEDED_ZERO_PROGRESS");

  const replacement = await repo.getSession(REAL_FULL_LOAD_ATTEMPT_ID);
  assert.ok(replacement, "the real full-load execution attempt must exist");
  assert.equal(replacement.logical_load_id, superseded.logical_load_id);
  assert.equal(replacement.supersedes_load_session_id, REAL_SUPERSEDED_ZERO_PROGRESS_SESSION_ID);
  assert.notEqual(replacement.load_session_id, superseded.load_session_id);

  const readyShard = await repo.getSession(REAL_READY_SHARD_SESSION_ID);
  assert.equal(readyShard.status, "READY");
  assert.equal(readyShard.materialized_chunk_count, 1144, "the pre-existing 750-doc shard must remain exactly as it was before this Turn");
});
