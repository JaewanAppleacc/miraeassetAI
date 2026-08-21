import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectReferenceReleaseRecords } from "../domain/postgres/reference-release-contract.mjs";
import { applyReferenceReleaseMigration } from "../domain/postgres/reference-release-loader.mjs";
import { referenceReaderGrantSql, referenceWriterGrantSql, applyReferenceReaderGrant, applyReferenceWriterGrant } from "../domain/postgres/reference-release-grants.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SQL_PATH = path.join(ROOT, "domain/postgres/002_reference_release.sql");

test("reference migration declares an immutable release/artifact/record landing schema without pgvector", async () => {
  const sql = await readFile(SQL_PATH, "utf8");
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS disclosure_reference/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.releases/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.artifacts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.records/);
  assert.match(sql, /reference release .* immutable once READY/);
  assert.doesNotMatch(sql, /vector\s*\(/i);
});

// Turn N1: the LOADING -> READY transition guard must protect every
// identity/snapshot/hash/count/payload field the spec requires, not just
// a subset. This is a static text check (fast, always runs) -- the real
// SQL-level proof that a mutation attempt actually raises lives in the
// PostgreSQL 16 integration suite (tests/reference-release-postgres16-integration.test.mjs),
// since only a real server executes plpgsql trigger bodies.
test("guard_release_transition protects every required field, not only release_id/hashes", async () => {
  const sql = await readFile(SQL_PATH, "utf8");
  const guardMatch = sql.match(/CREATE OR REPLACE FUNCTION disclosure_reference\.guard_release_transition\(\)[\s\S]*?\$\$;/);
  assert.ok(guardMatch, "guard_release_transition function body not found");
  const guardBody = guardMatch[0];
  for (const field of [
    "release_id", "approved_revision", "corpus_snapshot_id", "fact_coverage_snapshot_id",
    "bundle_manifest_sha256", "final_manifest_sha256", "final_decision_sha256",
    "bundle_entry_count", "bundle_manifest", "final_manifest", "final_decision", "created_at",
  ]) {
    assert.match(guardBody, new RegExp(`NEW\\.${field}\\s+IS DISTINCT FROM\\s+OLD\\.${field}`), `guard_release_transition does not protect ${field}`);
  }
});

// Turn N1.1: the DB itself must refuse a LOADING -> READY transition whose
// artifact/record counts are internally inconsistent -- static text check
// here (fast, always runs); the real SQL-level proof of an actual
// rejection lives in the PostgreSQL 16 integration suite.
test("guard_release_transition verifies artifact count, per-artifact loaded/declared record counts, and the record_counts aggregation before allowing READY", async () => {
  const sql = await readFile(SQL_PATH, "utf8");
  const guardMatch = sql.match(/CREATE OR REPLACE FUNCTION disclosure_reference\.guard_release_transition\(\)[\s\S]*?\$\$;/);
  assert.ok(guardMatch);
  const guardBody = guardMatch[0];
  assert.match(guardBody, /count\(\*\)\s*FROM\s*disclosure_reference\.artifacts\s*WHERE\s*release_id\s*=\s*NEW\.release_id\)\s*<>\s*NEW\.bundle_entry_count/i);
  assert.match(guardBody, /a\.loaded_record_count\s*<>\s*\(\s*SELECT\s*count\(\*\)\s*FROM\s*disclosure_reference\.records/i);
  assert.match(guardBody, /a\.declared_record_count\s*IS NOT NULL\s*AND\s*a\.declared_record_count\s*<>\s*a\.loaded_record_count/i);
  assert.match(guardBody, /NEW\.record_counts\s*<>\s*\(/i);
  assert.match(guardBody, /jsonb_object_agg/i);
});

test("the migration never creates a global role -- role provisioning stays an explicit operator/caller decision", async () => {
  const sql = await readFile(SQL_PATH, "utf8");
  assert.doesNotMatch(sql, /CREATE ROLE/i);
  assert.doesNotMatch(sql, /CREATE USER/i);
});

// -- Turn N1: explicit reader/writer permission grants (item 6, "권한 경계") -

test("referenceReaderGrantSql/referenceWriterGrantSql build scoped GRANT statements for a caller-supplied role, and reject unsafe role names", () => {
  const readerSql = referenceReaderGrantSql("agent_runtime_reader");
  assert.ok(readerSql.every((stmt) => stmt.includes("agent_runtime_reader")));
  assert.equal(readerSql.some((stmt) => /INSERT|UPDATE|DELETE/.test(stmt)), false, "reader grant must never include write verbs");

  const writerSql = referenceWriterGrantSql("reference_loader_writer");
  for (const unsafe of ["role; DROP TABLE disclosure_reference.releases; --", "Role With Spaces", "", "1role", "role\"quoted"]) {
    assert.throws(() => referenceReaderGrantSql(unsafe));
    assert.throws(() => referenceWriterGrantSql(unsafe));
  }
});

// -- Turn N1.1: least-privilege -- no "ON ALL TABLES", no "ALTER DEFAULT
// PRIVILEGES", schema_migrations excluded, and DML enumerated per table
// exactly matching what the loader itself actually does. -------------------

test("Turn N1.1: grants never use a blanket ON ALL TABLES or ALTER DEFAULT PRIVILEGES form", () => {
  for (const stmt of [...referenceReaderGrantSql("agent_runtime_reader"), ...referenceWriterGrantSql("reference_loader_writer")]) {
    assert.doesNotMatch(stmt, /ON ALL TABLES/i);
    assert.doesNotMatch(stmt, /ALTER DEFAULT PRIVILEGES/i);
  }
});

test("Turn N1.1: neither reader nor writer grants ever touch schema_migrations", () => {
  for (const stmt of [...referenceReaderGrantSql("agent_runtime_reader"), ...referenceWriterGrantSql("reference_loader_writer")]) {
    assert.doesNotMatch(stmt, /schema_migrations/i);
  }
});

test("Turn N1.1: writer grant is enumerated per table with the minimum DML the loader actually issues (no DELETE anywhere, records is INSERT-only)", () => {
  const writerSql = referenceWriterGrantSql("reference_loader_writer");
  assert.equal(writerSql.some((stmt) => /DELETE/i.test(stmt)), false, "the loader never issues DELETE -- writer must not be granted it");
  assert.ok(writerSql.some((stmt) => /GRANT SELECT, INSERT, UPDATE ON disclosure_reference\.releases/.test(stmt)));
  assert.ok(writerSql.some((stmt) => /GRANT SELECT, INSERT, UPDATE ON disclosure_reference\.artifacts/.test(stmt)));
  assert.ok(writerSql.some((stmt) => /GRANT SELECT, INSERT ON disclosure_reference\.records/.test(stmt)));
  assert.equal(writerSql.some((stmt) => /disclosure_reference\.records/.test(stmt) && /UPDATE/.test(stmt)), false, "records is INSERT-only for the writer -- the loader never UPDATEs a record");
});

test("Turn N1.1: reader grant covers exactly the three landing tables and four query views, SELECT only", () => {
  const readerSql = referenceReaderGrantSql("agent_runtime_reader");
  const selectStatement = readerSql.find((stmt) => stmt.startsWith("GRANT SELECT ON"));
  assert.ok(selectStatement);
  for (const object of [
    "disclosure_reference.releases", "disclosure_reference.artifacts", "disclosure_reference.records",
    "disclosure_reference.verified_facts", "disclosure_reference.verified_evidence",
    "disclosure_reference.verified_events", "disclosure_reference.verified_relations",
  ]) {
    assert.ok(selectStatement.includes(object), `reader grant is missing ${object}`);
  }
});

test("applyReferenceReaderGrant/applyReferenceWriterGrant send exactly the generated statements to the provided client, in order", async () => {
  const executed = [];
  const client = { async query(sql) { executed.push(sql); return { rows: [] }; } };
  const readerResult = await applyReferenceReaderGrant({ client, roleName: "agent_runtime_reader" });
  assert.deepEqual(executed, referenceReaderGrantSql("agent_runtime_reader"));
  assert.deepEqual(readerResult.applied, executed);

  executed.length = 0;
  await applyReferenceWriterGrant({ client, roleName: "reference_loader_writer" });
  assert.deepEqual(executed, referenceWriterGrantSql("reference_loader_writer"));
});

test("collectReferenceReleaseRecords parses JSONL, expands Coverage slots, and keeps control JSON as one record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reference-contract-"));
  try {
    await writeFile(path.join(root, "facts.jsonl"), '{"fact_id":"fact_a","corp_code":"00000001","source_document_id":"doc_a","metric_code":"M"}\n');
    await writeFile(path.join(root, "coverage.json"), JSON.stringify({ slots: [{ slot_key: "q::a" }, { slot_key: "q::b" }] }));
    await writeFile(path.join(root, "control.json"), JSON.stringify({ status: "APPROVED" }));
    const records = [];
    const artifacts = [];
    const result = await collectReferenceReleaseRecords({
      materializedRoot: root,
      bundleManifest: { entries: [
        { role: "VERIFIED_FACT", source_path: "facts.jsonl", record_count: 1 },
        { role: "FACT_COVERAGE_SNAPSHOT", source_path: "coverage.json", record_count: 2 },
        { role: "RELEASE_DECISION", source_path: "control.json", record_count: null },
      ] },
      async onRecord(record) { records.push(record); },
      async onArtifact(artifact) { artifacts.push(artifact); },
    });
    assert.deepEqual(result.roleCounts, { VERIFIED_FACT: 1, FACT_COVERAGE_SNAPSHOT: 2, RELEASE_DECISION: 1 });
    assert.deepEqual(records.map((record) => record.recordKey), ["fact_a", "q::a", "q::b", "RELEASE_DECISION:control"]);
    assert.equal(records[0].documentId, "doc_a");
    assert.equal(artifacts.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectReferenceReleaseRecords rejects record-count mismatch and duplicate stable IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reference-contract-negative-"));
  try {
    await writeFile(path.join(root, "facts.jsonl"), '{"fact_id":"fact_a"}\n{"fact_id":"fact_a"}\n');
    const base = {
      materializedRoot: root,
      onRecord: async () => {},
      onArtifact: async () => {},
    };
    await assert.rejects(
      collectReferenceReleaseRecords({ ...base, bundleManifest: { entries: [{ role: "VERIFIED_FACT", source_path: "facts.jsonl", record_count: 2 }] } }),
      /duplicate record key/,
    );
    await writeFile(path.join(root, "facts.jsonl"), '{"fact_id":"fact_a"}\n');
    await assert.rejects(
      collectReferenceReleaseRecords({ ...base, bundleManifest: { entries: [{ role: "VERIFIED_FACT", source_path: "facts.jsonl", record_count: 2 }] } }),
      /loaded 1 records, expected 2/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectReferenceReleaseRecords rejects invalid UTF-8 and missing role key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reference-contract-utf8-"));
  try {
    await writeFile(path.join(root, "bad.jsonl"), Buffer.from([0xff, 0xfe, 0x0a]));
    const callbacks = { onRecord: async () => {}, onArtifact: async () => {} };
    await assert.rejects(
      collectReferenceReleaseRecords({ materializedRoot: root, bundleManifest: { entries: [{ role: "VERIFIED_FACT", source_path: "bad.jsonl", record_count: 1 }] }, ...callbacks }),
      /invalid UTF-8/,
    );
    await writeFile(path.join(root, "bad.jsonl"), '{}\n');
    await assert.rejects(
      collectReferenceReleaseRecords({ materializedRoot: root, bundleManifest: { entries: [{ role: "VERIFIED_FACT", source_path: "bad.jsonl", record_count: 1 }] }, ...callbacks }),
      /required record key fact_id is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyReferenceReleaseMigration sends the tracked migration to the database client", async () => {
  const queries = [];
  await applyReferenceReleaseMigration({
    client: { async query(sql) {
      queries.push(sql);
      return String(sql) === "SHOW server_version_num" ? { rows: [{ server_version_num: "160011" }] } : { rows: [] };
    } },
    root: ROOT,
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[0], "SHOW server_version_num");
  assert.match(queries[1], /002_reference_release_v0\.1/);
});

test("applyReferenceReleaseMigration fails closed outside PostgreSQL 16", async () => {
  for (const serverVersion of ["150012", "170001", undefined]) {
    let migrationSent = false;
    await assert.rejects(
      applyReferenceReleaseMigration({
        client: { async query(sql) {
          if (String(sql) !== "SHOW server_version_num") migrationSent = true;
          return { rows: [{ server_version_num: serverVersion }] };
        } },
        root: ROOT,
      }),
      /PostgreSQL 16 is required/,
    );
    assert.equal(migrationSent, false);
  }
});
