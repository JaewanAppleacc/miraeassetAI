// Turn P5.2: explicit, caller-invoked permission grants for the three new
// disclosure_reference.reference_dedup_* tables
// (004_reference_dedup_retrieval_index.sql). Mirrors
// reference-vector-retrieval-grants.mjs's own pattern exactly -- enumerated
// per-table grants only, never "ON ALL TABLES IN SCHEMA", no CREATE ROLE,
// strict role-name allowlist.
const SAFE_ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertSafeRoleName(roleName, label) {
  if (typeof roleName !== "string" || !SAFE_ROLE_NAME.test(roleName)) {
    throw new Error(`${label}: role name must match ${SAFE_ROLE_NAME} (got ${JSON.stringify(roleName)})`);
  }
  return roleName;
}

const DEDUP_READER_SELECT_OBJECTS = Object.freeze([
  "disclosure_reference.reference_dedup_indexes",
  "disclosure_reference.reference_dedup_canonical_texts",
  "disclosure_reference.reference_dedup_occurrences",
]);

// Read-only access for Agent Runtime / any reader of the dedup index --
// SELECT only, on exactly these three tables.
export function referenceDedupReaderGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceDedupReaderGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT ON ${DEDUP_READER_SELECT_OBJECTS.join(", ")} TO ${role}`,
  ];
}

// Read/write access for the dedup LOADER's own role. No DELETE anywhere,
// and no access to releases/artifacts/records/reference_retrieval_*
// (003's own tables) or schema_migrations -- this file grants ONLY the
// three tables it owns. INSERT/UPDATE are still bounded by
// 004_reference_dedup_retrieval_index.sql's own immutability triggers.
export function referenceDedupWriterGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceDedupWriterGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
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

export async function applyReferenceDedupReaderGrant({ client, roleName }) {
  return applyStatements(client, referenceDedupReaderGrantSql(roleName));
}

export async function applyReferenceDedupWriterGrant({ client, roleName }) {
  return applyStatements(client, referenceDedupWriterGrantSql(roleName));
}
