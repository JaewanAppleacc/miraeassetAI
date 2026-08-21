// Turn N1, Category C: REAL PostgreSQL 16 integration coverage for the
// disclosure_reference reference-release loader.
//
// This file is DELIBERATELY excluded from `npm run test:reference-db` and
// `npm run verify:contracts` -- it requires a real, empty, scratch
// PostgreSQL 16 database and must never silently skip inside the default
// contract-verification path (a hidden skip there would let a red
// integration signal disappear into green noise). Invoke it explicitly:
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:reference-db:postgres16
//
// If DATABASE_URL is not set, this suite FAILS CLOSED with a clear error
// (not a silent pass/skip) -- an operator who explicitly asked for the
// PostgreSQL 16 integration suite and forgot to configure it must see a
// failure, never a misleadingly-green "0 tests ran".
//
// CI service requirements (e.g. GitHub Actions):
//   services:
//     postgres:
//       image: postgres:16
//       env:
//         POSTGRES_USER: disclosure_test
//         POSTGRES_PASSWORD: disclosure_test
//         POSTGRES_DB: disclosure_reference_scratch
//       ports: ["5432:5432"]
//       options: >-
//         --health-cmd pg_isready
//         --health-interval 5s
//         --health-timeout 5s
//         --health-retries 10
//   env:
//     DATABASE_URL: postgresql://disclosure_test:disclosure_test@localhost:5432/disclosure_reference_scratch
//
// The target database MUST be empty/scratch-only: this suite creates the
// disclosure_reference schema, imports the real v0.20-r3 bundle, and
// creates throwaway reader/writer test roles. Never point DATABASE_URL at
// a database holding real data.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration, importReferenceRelease } from "../domain/postgres/reference-release-loader.mjs";
import { applyReferenceReaderGrant, applyReferenceWriterGrant } from "../domain/postgres/reference-release-grants.mjs";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dirname, "..");
const OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
  expectedApprovedRevision: "seed-structured-artifacts-v0.7",
});
const READER_ROLE = "disclosure_reference_test_reader";
const WRITER_ROLE = "disclosure_reference_test_writer";

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url === "") {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-release-postgres16-integration.test.mjs. "
      + "Point it at an EMPTY scratch PostgreSQL 16 database, e.g.: "
      + "DATABASE_URL='postgresql://user:pass@localhost:5432/scratch_db' npm run test:reference-db:postgres16",
    );
  }
  return url;
}

let client;
test.before(async () => {
  client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  // Fail closed early and clearly if the target isn't really empty --
  // this suite must never run against a database holding real data.
  const existing = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'",
  );
  if (existing.rows.length > 0) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: disclosure_reference schema already exists on the target database. "
      + "This suite requires a genuinely empty scratch database (DROP SCHEMA disclosure_reference CASCADE first if this is disposable).",
    );
  }
});
test.after(async () => {
  if (client) {
    await client.query(`DROP ROLE IF EXISTS ${READER_ROLE}`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS ${WRITER_ROLE}`).catch(() => {});
    await client.end();
  }
});

test("Postgres 16: empty-database migration creates the schema and is idempotent to re-run", async () => {
  await applyReferenceReleaseMigration({ client, root: ROOT });
  await applyReferenceReleaseMigration({ client, root: ROOT }); // re-run must not error
  // Turn N1.2: information_schema.tables includes VIEWs too (table_type
  // 'VIEW') -- filtered to BASE TABLE only, since this assertion is
  // specifically about the four landing/bookkeeping tables, not the four
  // verified_* convenience views the same migration also creates.
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'disclosure_reference' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  assert.deepEqual(tables.rows.map((r) => r.table_name), ["artifacts", "records", "releases", "schema_migrations"]);
  const views = await client.query(
    "SELECT table_name FROM information_schema.views WHERE table_schema = 'disclosure_reference' ORDER BY table_name",
  );
  assert.deepEqual(views.rows.map((r) => r.table_name), ["verified_events", "verified_evidence", "verified_facts", "verified_relations"]);
});

test("Postgres 16: a mid-transaction failure rolls back completely, leaving zero rows for that release (run BEFORE the real successful load below, since this release_id can only be freshly attempted once)", async () => {
  // A thin proxy over the real client: every record INSERT beyond the
  // first 5 is intercepted and synthetically thrown, WITHOUT ever being
  // sent to the server -- but the first 5 (and the release/artifact rows
  // before them) genuinely executed against real PostgreSQL inside the
  // still-open transaction. If ROLLBACK works, none of that survives.
  let recordInsertCount = 0;
  const chaosClient = {
    async query(sql, params) {
      const normalized = String(sql).trim();
      if (normalized.startsWith("INSERT INTO disclosure_reference.records")) {
        recordInsertCount += 1;
        if (recordInsertCount > 5) throw new Error("synthetic mid-transaction failure (Turn N1 rollback proof)");
      }
      return client.query(sql, params);
    },
  };
  await assert.rejects(
    importReferenceRelease({ client: chaosClient, ...OPTIONS }),
    /synthetic mid-transaction failure/,
  );
  assert.ok(recordInsertCount > 5, "the chaos proxy must have let real inserts through before failing, to prove rollback (not just a pre-flight rejection)");

  const releaseRows = await client.query("SELECT 1 FROM disclosure_reference.releases WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
  assert.equal(releaseRows.rows.length, 0, "a rolled-back load must leave no releases row at all, not even a stray LOADING row");
  const artifactRows = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.artifacts WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
  assert.equal(artifactRows.rows[0].n, 0);
  const recordRows = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.records WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
  assert.equal(recordRows.rows[0].n, 0);
});

test("Postgres 16: real bundle import reaches READY with 21 artifacts and 792 records", async () => {
  const result = await importReferenceRelease({ client, ...OPTIONS });
  assert.equal(result.status, "LOADED");

  const release = await client.query(
    "SELECT status, bundle_entry_count FROM disclosure_reference.releases WHERE release_id = $1",
    [OPTIONS.expectedReleaseId],
  );
  assert.equal(release.rows[0].status, "READY");
  assert.equal(release.rows[0].bundle_entry_count, 21);

  const artifactCount = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.artifacts WHERE release_id = $1",
    [OPTIONS.expectedReleaseId],
  );
  assert.equal(artifactCount.rows[0].n, 21);

  const recordCount = await client.query(
    "SELECT count(*)::int AS n FROM disclosure_reference.records WHERE release_id = $1",
    [OPTIONS.expectedReleaseId],
  );
  assert.equal(recordCount.rows[0].n, 792);
});

test("Postgres 16: re-loading the identical release is idempotent (ALREADY_LOADED, no new rows)", async () => {
  const before = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.records WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
  const result = await importReferenceRelease({ client, ...OPTIONS });
  assert.deepEqual(result, { status: "ALREADY_LOADED", release_id: OPTIONS.expectedReleaseId });
  const after = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.records WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test("Postgres 16: READY mutation is really rejected by the trigger, at the SQL level, for releases/artifacts/records", async () => {
  await assert.rejects(
    client.query("UPDATE disclosure_reference.releases SET approved_revision = 'tampered' WHERE release_id = $1", [OPTIONS.expectedReleaseId]),
    // Any UPDATE on an already-READY release has OLD.status = NEW.status = 'READY'
    // (a column not mentioned in SET keeps its OLD value), which trips the
    // "only LOADING -> READY" transition-shape check BEFORE the identity/hash
    // immutability check ever runs -- this is a different, earlier RAISE than
    // the "immutable ... across the LOADING -> READY transition" message.
    /only the LOADING -> READY reference release transition is permitted/i,
  );
  await assert.rejects(
    client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [OPTIONS.expectedReleaseId]),
    /cannot be deleted/i,
  );
  await assert.rejects(
    client.query("UPDATE disclosure_reference.artifacts SET loaded_record_count = 0 WHERE release_id = $1 AND role = 'SEED_GOLD'", [OPTIONS.expectedReleaseId]),
    /immutable once READY/i,
  );
  await assert.rejects(
    client.query("DELETE FROM disclosure_reference.records WHERE release_id = $1 AND role = 'SEED_GOLD'", [OPTIONS.expectedReleaseId]),
    /immutable once READY/i,
  );
});

test("Postgres 16: reader role can SELECT but not write; writer role can write but is still bound by the READY trigger", async () => {
  await client.query(`DROP ROLE IF EXISTS ${READER_ROLE}`);
  await client.query(`DROP ROLE IF EXISTS ${WRITER_ROLE}`);
  await client.query(`CREATE ROLE ${READER_ROLE} LOGIN PASSWORD 'test_only_scratch_password'`);
  await client.query(`CREATE ROLE ${WRITER_ROLE} LOGIN PASSWORD 'test_only_scratch_password'`);
  await applyReferenceReaderGrant({ client, roleName: READER_ROLE });
  await applyReferenceWriterGrant({ client, roleName: WRITER_ROLE });

  const baseUrl = new URL(requireDatabaseUrl());
  const readerUrl = new URL(baseUrl); readerUrl.username = READER_ROLE; readerUrl.password = "test_only_scratch_password";
  const readerClient = new Client({ connectionString: readerUrl.toString() });
  await readerClient.connect();
  try {
    const rows = await readerClient.query("SELECT release_id FROM disclosure_reference.releases WHERE release_id = $1", [OPTIONS.expectedReleaseId]);
    assert.equal(rows.rows.length, 1);
    await assert.rejects(
      readerClient.query("DELETE FROM disclosure_reference.records WHERE release_id = $1", [OPTIONS.expectedReleaseId]),
      /permission denied/i,
    );
  } finally {
    await readerClient.end();
  }

  const writerUrl = new URL(baseUrl); writerUrl.username = WRITER_ROLE; writerUrl.password = "test_only_scratch_password";
  const writerClient = new Client({ connectionString: writerUrl.toString() });
  await writerClient.connect();
  try {
    // Turn N1.1: writer's grant on `records` is SELECT+INSERT only (no
    // UPDATE/DELETE) and it is granted NOTHING on schema_migrations --
    // both attempts must fail at the GRANT level (permission denied),
    // never even reaching a trigger.
    await assert.rejects(
      writerClient.query("DELETE FROM disclosure_reference.records WHERE release_id = $1", [OPTIONS.expectedReleaseId]),
      /permission denied/i,
    );
    await assert.rejects(
      writerClient.query("UPDATE disclosure_reference.records SET payload = '{}'::jsonb WHERE release_id = $1", [OPTIONS.expectedReleaseId]),
      /permission denied/i,
    );
    await assert.rejects(
      writerClient.query("SELECT 1 FROM disclosure_reference.schema_migrations LIMIT 1"),
      /permission denied/i,
    );
    // GRANTed UPDATE on `artifacts`, but the immutability trigger still
    // applies -- permission-to-attempt is not permission-to-succeed.
    await assert.rejects(
      writerClient.query(
        "UPDATE disclosure_reference.artifacts SET loaded_record_count = 0 WHERE release_id = $1 AND role = 'SEED_GOLD'",
        [OPTIONS.expectedReleaseId],
      ),
      /immutable once READY/i,
    );
  } finally {
    await writerClient.end();
  }
});

// -- Turn N1.2: a LOADING release (never READY) can be deleted, and its
// children genuinely cascade-delete with it -- this is exactly the
// operation this suite's own cleanup relies on for every "false count"
// fixture above, and was found broken against real PostgreSQL: cascading
// from a releases DELETE made the parent row invisible to the child
// trigger's own lookup, incorrectly raising "immutable once READY" for a
// release that was never READY. A READY release remains fully protected
// (covered by the "READY mutation is really rejected" test above).

test("Postgres 16: a LOADING release (with artifact/record children) can be deleted, cascading cleanly, with zero rows left behind", async () => {
  const releaseId = "n12-loading-cascade-delete-proof";
  await insertMinimalLoadingRelease(releaseId);
  await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]);
  const releaseRows = await client.query("SELECT 1 FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]);
  assert.equal(releaseRows.rows.length, 0);
  const artifactRows = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.artifacts WHERE release_id = $1", [releaseId]);
  assert.equal(artifactRows.rows[0].n, 0);
  const recordRows = await client.query("SELECT count(*)::int AS n FROM disclosure_reference.records WHERE release_id = $1", [releaseId]);
  assert.equal(recordRows.rows[0].n, 0);
});

// -- Turn N1.1 item 3: the DB itself refuses a LOADING -> READY transition
// whose artifact/record counts are internally inconsistent -- proven here
// against REAL PostgreSQL (not a fake client), by hand-crafting a minimal
// synthetic release outside the normal loader API so a deliberately WRONG
// count can be constructed at all. -----------------------------------------

const VALID_SHA = "a".repeat(64);
async function insertMinimalLoadingRelease(releaseId) {
  await client.query(
    `INSERT INTO disclosure_reference.releases
      (release_id, status, approved_revision, corpus_snapshot_id, bundle_manifest_sha256,
       final_manifest_sha256, final_decision_sha256, bundle_entry_count, bundle_manifest, final_manifest, final_decision)
     VALUES ($1, 'LOADING', 'rev', 'snap', $2, $2, $2, 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
    [releaseId, VALID_SHA],
  );
  await client.query(
    `INSERT INTO disclosure_reference.artifacts
      (release_id, role, bundle_path, source_path, compression, decoded_sha256, decoded_bytes, declared_record_count, loaded_record_count)
     VALUES ($1, 'SEED_GOLD', 'a.jsonl', 'a.jsonl', 'none', $2, 10, 1, 1)`,
    [releaseId, VALID_SHA],
  );
  await client.query(
    `INSERT INTO disclosure_reference.records (release_id, role, ordinal, record_key, payload)
     VALUES ($1, 'SEED_GOLD', 0, 'k0', '{}'::jsonb)`,
    [releaseId],
  );
}

test("Postgres 16: READY rejected when artifact row count does not match bundle_entry_count", async () => {
  const releaseId = "n11-false-count-artifact-total";
  await insertMinimalLoadingRelease(releaseId);
  // insertMinimalLoadingRelease's own release+artifact pair is already
  // self-consistent (bundle_entry_count=1, exactly 1 artifact row) -- the
  // actual mismatch this test targets requires a SECOND artifact row
  // under a different role, so the real count (2) disagrees with the
  // release's declared bundle_entry_count (still 1).
  await client.query(
    `INSERT INTO disclosure_reference.artifacts
      (release_id, role, bundle_path, source_path, compression, decoded_sha256, decoded_bytes, loaded_record_count)
     VALUES ($1, 'VERIFIED_FACT', 'b.jsonl', 'b.jsonl', 'none', $2, 10, 0)`,
    [releaseId, VALID_SHA],
  );
  try {
    await assert.rejects(
      client.query(
        "UPDATE disclosure_reference.releases SET status = 'READY', record_counts = '{\"SEED_GOLD\":1}'::jsonb, imported_at = now() WHERE release_id = $1",
        [releaseId],
      ),
      /artifact row count does not match bundle_entry_count/i,
    );
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]).catch(() => {});
  }
});

test("Postgres 16: READY rejected when an artifact's loaded_record_count does not match its actual record row count", async () => {
  const releaseId = "n11-false-count-loaded-vs-actual";
  await insertMinimalLoadingRelease(releaseId);
  // lie: claim 5 loaded records, but only 1 real record row exists
  await client.query(
    "UPDATE disclosure_reference.artifacts SET loaded_record_count = 5, declared_record_count = NULL WHERE release_id = $1",
    [releaseId],
  );
  try {
    await assert.rejects(
      client.query(
        "UPDATE disclosure_reference.releases SET status = 'READY', record_counts = '{\"SEED_GOLD\":5}'::jsonb, imported_at = now() WHERE release_id = $1",
        [releaseId],
      ),
      /loaded_record_count does not match its actual record row count/i,
    );
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]).catch(() => {});
  }
});

test("Postgres 16: READY rejected when an artifact's declared_record_count does not match its loaded_record_count", async () => {
  const releaseId = "n11-false-count-declared-vs-loaded";
  await insertMinimalLoadingRelease(releaseId);
  // loaded_record_count (1) genuinely matches the 1 real record row, but
  // declared_record_count claims the bundle manifest said there should be 2.
  await client.query(
    "UPDATE disclosure_reference.artifacts SET declared_record_count = 2 WHERE release_id = $1",
    [releaseId],
  );
  try {
    await assert.rejects(
      client.query(
        "UPDATE disclosure_reference.releases SET status = 'READY', record_counts = '{\"SEED_GOLD\":1}'::jsonb, imported_at = now() WHERE release_id = $1",
        [releaseId],
      ),
      /declared_record_count does not match its loaded_record_count/i,
    );
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]).catch(() => {});
  }
});

test("Postgres 16: READY rejected when release.record_counts does not match the actual per-role record aggregation", async () => {
  const releaseId = "n11-false-count-summary-mismatch";
  await insertMinimalLoadingRelease(releaseId);
  try {
    await assert.rejects(
      client.query(
        // artifact/record rows are genuinely consistent (1 loaded, 1 real
        // row) -- only the release-level summary jsonb lies about it.
        "UPDATE disclosure_reference.releases SET status = 'READY', record_counts = '{\"SEED_GOLD\":999}'::jsonb, imported_at = now() WHERE release_id = $1",
        [releaseId],
      ),
      /record_counts does not match the actual per-role record aggregation/i,
    );
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]).catch(() => {});
  }
});

test("Postgres 16 counterexample: a genuinely consistent minimal release DOES reach READY", async () => {
  const releaseId = "n11-true-count-consistent";
  await insertMinimalLoadingRelease(releaseId);
  try {
    await client.query(
      "UPDATE disclosure_reference.releases SET status = 'READY', record_counts = '{\"SEED_GOLD\":1}'::jsonb, imported_at = now() WHERE release_id = $1",
      [releaseId],
    );
    const row = await client.query("SELECT status FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]);
    assert.equal(row.rows[0].status, "READY");
  } finally {
    await client.query("DELETE FROM disclosure_reference.releases WHERE release_id = $1", [releaseId]).catch(() => {});
  }
});
