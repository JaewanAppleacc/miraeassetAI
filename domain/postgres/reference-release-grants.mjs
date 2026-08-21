// Turn N1: explicit, caller-invoked permission grants for the
// disclosure_reference schema (item 6 of the Turn N1 spec -- "권한 경계").
//
// Deliberately NOT part of 002_reference_release.sql: the migration must
// stay usable against any PostgreSQL instance regardless of what
// reader/writer roles (if any) that instance already has, and this
// project never auto-creates global roles as a side effect of running a
// migration. A caller who DOES want to grant Agent Runtime read-only
// access, or grant the loader's own write access, invokes one of the
// functions below explicitly with a role name THEY already created
// (CREATE ROLE is intentionally out of scope here too -- role
// provisioning is an operator decision, not something this module
// decides).
//
// Role identifiers cannot be bound as ordinary SQL parameters (PostgreSQL
// has no placeholder syntax for identifiers), so the role name is
// validated against a strict allowlist pattern BEFORE being interpolated
// into the GRANT statement text -- the standard safe approach for
// DDL-with-identifier statements. Anything that doesn't look like a
// plain, unquoted, lowercase-start PostgreSQL identifier is rejected
// before any SQL is built or sent.
const SAFE_ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertSafeRoleName(roleName, label) {
  if (typeof roleName !== "string" || !SAFE_ROLE_NAME.test(roleName)) {
    throw new Error(`${label}: role name must match ${SAFE_ROLE_NAME} (got ${JSON.stringify(roleName)})`);
  }
  return roleName;
}

// Turn N1.1: enumerated per-table/view grants only -- never
// "ON ALL TABLES IN SCHEMA" and never "ALTER DEFAULT PRIVILEGES". Both
// of the earlier (Turn N1) blanket forms silently (a) handed the writer
// role DML on schema_migrations, a migration-bookkeeping table no
// loader/reader identity has any legitimate reason to touch, and (b)
// auto-granted the SAME privileges to any table a FUTURE migration adds,
// with no new review step. Every object below is named explicitly, and a
// future migration's new table gets NO grant at all until this file is
// updated on purpose.
const READER_SELECT_OBJECTS = Object.freeze([
  "disclosure_reference.releases", "disclosure_reference.artifacts", "disclosure_reference.records",
  "disclosure_reference.verified_facts", "disclosure_reference.verified_evidence",
  "disclosure_reference.verified_events", "disclosure_reference.verified_relations",
]);

// Read-only access for Agent Runtime / any reader that only ever queries
// the disclosure_reference schema: SELECT on the three landing tables
// plus the four query-convenience views. schema_migrations is
// deliberately excluded -- a reader never needs it.
export function referenceReaderGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceReaderGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT ON ${READER_SELECT_OBJECTS.join(", ")} TO ${role}`,
  ];
}

// Read/write access for the loader's OWN role (the one importReferenceRelease
// actually connects as) -- the MINIMUM DML each of the three landing
// tables actually needs, per the loader's real usage: releases and
// artifacts are both INSERTed once and UPDATEd once (the LOADING row,
// then the READY transition / loaded_record_count tally); records is
// only ever INSERTed, never UPDATEd or DELETEd. No table gets DELETE --
// the loader itself never issues one -- and schema_migrations is
// excluded entirely (that table belongs to whatever privileged
// connection applies 002_reference_release.sql, not to this role).
// INSERT/UPDATE at the GRANT level are still bounded by the schema's own
// immutability triggers (reject_non_loading_child_write /
// guard_release_transition) -- this grant controls who may ATTEMPT a
// write at all, not what a write is allowed to do once attempted.
export function referenceWriterGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceWriterGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.releases TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.artifacts TO ${role}`,
    `GRANT SELECT, INSERT ON disclosure_reference.records TO ${role}`,
  ];
}

async function applyStatements(client, statements) {
  if (!client || typeof client.query !== "function") throw new TypeError("client.query is required");
  for (const statement of statements) await client.query(statement);
  return Object.freeze({ applied: Object.freeze([...statements]) });
}

export async function applyReferenceReaderGrant({ client, roleName }) {
  return applyStatements(client, referenceReaderGrantSql(roleName));
}

export async function applyReferenceWriterGrant({ client, roleName }) {
  return applyStatements(client, referenceWriterGrantSql(roleName));
}
