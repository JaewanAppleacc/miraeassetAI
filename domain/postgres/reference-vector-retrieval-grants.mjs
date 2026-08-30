// Turn P4: explicit, caller-invoked permission grants for the two new
// disclosure_reference.reference_retrieval_* tables (003_reference_vector_retrieval.sql).
// Mirrors reference-release-grants.mjs's own pattern exactly -- enumerated
// per-table grants only, never "ON ALL TABLES IN SCHEMA" and never
// "ALTER DEFAULT PRIVILEGES" (so a future migration's new table gets no
// grant until this file is updated on purpose), no CREATE ROLE, and a
// strict role-name allowlist since PostgreSQL has no parameter placeholder
// for identifiers.
const SAFE_ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertSafeRoleName(roleName, label) {
  if (typeof roleName !== "string" || !SAFE_ROLE_NAME.test(roleName)) {
    throw new Error(`${label}: role name must match ${SAFE_ROLE_NAME} (got ${JSON.stringify(roleName)})`);
  }
  return roleName;
}

const RETRIEVAL_READER_SELECT_OBJECTS = Object.freeze([
  "disclosure_reference.reference_retrieval_indexes",
  "disclosure_reference.reference_retrieval_chunks",
]);

// Read-only access for Agent Runtime / any reader of the retrieval index --
// SELECT only, on exactly these two tables. No access to schema_migrations,
// no access to any other disclosure_reference table (a reader that also
// needs Fact/Evidence/Event/Relation access must separately be granted
// reference-release-grants.mjs's own referenceReaderGrantSql -- this file
// never assumes or grants that on its own behalf).
export function referenceRetrievalReaderGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceRetrievalReaderGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT ON ${RETRIEVAL_READER_SELECT_OBJECTS.join(", ")} TO ${role}`,
  ];
}

// Read/write access for the vector-retrieval LOADER's own role -- the
// minimum DML the loader actually needs: reference_retrieval_indexes is
// INSERTed once (the LOADING row) and UPDATEd once (the READY transition);
// reference_retrieval_chunks is only ever INSERTed, never UPDATEd or
// DELETEd by the loader itself. No DELETE on either table, and no access
// at all to disclosure_reference.releases/artifacts/records (this role
// reads the release via reference-repository.mjs's OWN reader path, which
// callers grant separately -- this file grants ONLY the two new tables it
// owns) or schema_migrations. INSERT/UPDATE here are still bounded by
// 003_reference_vector_retrieval.sql's own immutability triggers -- this
// grant controls who may ATTEMPT a write at all, not what a write is
// allowed to do once attempted.
export function referenceRetrievalWriterGrantSql(roleName) {
  const role = assertSafeRoleName(roleName, "referenceRetrievalWriterGrantSql");
  return [
    `GRANT USAGE ON SCHEMA disclosure_reference TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE ON disclosure_reference.reference_retrieval_indexes TO ${role}`,
    `GRANT SELECT, INSERT ON disclosure_reference.reference_retrieval_chunks TO ${role}`,
  ];
}

async function applyStatements(client, statements) {
  if (!client || typeof client.query !== "function") throw new TypeError("client.query is required");
  for (const statement of statements) await client.query(statement);
  return Object.freeze({ applied: Object.freeze([...statements]) });
}

export async function applyReferenceRetrievalReaderGrant({ client, roleName }) {
  return applyStatements(client, referenceRetrievalReaderGrantSql(roleName));
}

export async function applyReferenceRetrievalWriterGrant({ client, roleName }) {
  return applyStatements(client, referenceRetrievalWriterGrantSql(roleName));
}
