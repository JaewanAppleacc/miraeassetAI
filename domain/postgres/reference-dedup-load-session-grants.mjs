// Turn P8: explicit, caller-invoked permission grants for the loader-
// internal staging/session tables added by 005_reference_dedup_load_sessions.sql.
// Mirrors reference-dedup-retrieval-grants.mjs's own pattern exactly --
// enumerated per-table grants only, never "ON ALL TABLES IN SCHEMA", no
// CREATE ROLE, strict role-name allowlist. No DELETE anywhere (rows are
// retired via ON DELETE CASCADE from the parent session row, never by a
// worker-role DELETE statement).
const SAFE_ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertSafeRoleName(roleName, label) {
  if (typeof roleName !== "string" || !SAFE_ROLE_NAME.test(roleName)) {
    throw new Error(`${label}: role name must match ${SAFE_ROLE_NAME} (got ${JSON.stringify(roleName)})`);
  }
  return roleName;
}

const LOAD_SESSION_TABLES = Object.freeze([
  "disclosure_reference.reference_dedup_load_sessions",
  "disclosure_reference.reference_dedup_canonical_queue",
  "disclosure_reference.reference_dedup_occurrence_staging",
]);

// Read-only observability access (e.g. an operator dashboard watching
// session progress) -- SELECT only, on exactly these three tables.
export function referenceDedupLoadSessionReaderGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceDedupLoadSessionReaderGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT ON ${LOAD_SESSION_TABLES.join(", ")} TO ${role}`,
  ];
}

// Read/write access for the loader worker role itself. No DELETE -- rows
// are only ever retired via CASCADE from a session row, never by direct
// worker DELETE. Also grants the 004 writer privileges this same worker
// needs for materialization (INSERT/SELECT/UPDATE on reference_dedup_indexes,
// INSERT/SELECT on the canonical/occurrence tables) so a single role can
// run the whole pipeline end to end.
export function referenceDedupLoadSessionWriterGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceDedupLoadSessionWriterGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.reference_dedup_load_sessions TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.reference_dedup_canonical_queue TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.reference_dedup_occurrence_staging TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.reference_dedup_indexes TO ${role}`,
    `GRANT SELECT, INSERT ON disclosure_reference.reference_dedup_canonical_texts TO ${role}`,
    `GRANT SELECT, INSERT ON disclosure_reference.reference_dedup_occurrences TO ${role}`,
  ];
}

async function applyStatements(client, statements) {
  if (!client || typeof client.query !== "function") throw new TypeError("client.query is required");
  for (const statement of statements) await client.query(statement);
  return Object.freeze({ applied: Object.freeze([...statements]) });
}

export async function applyReferenceDedupLoadSessionReaderGrant({ client, roleName }) {
  return applyStatements(client, referenceDedupLoadSessionReaderGrantSql(roleName));
}

export async function applyReferenceDedupLoadSessionWriterGrant({ client, roleName }) {
  return applyStatements(client, referenceDedupLoadSessionWriterGrantSql(roleName));
}
