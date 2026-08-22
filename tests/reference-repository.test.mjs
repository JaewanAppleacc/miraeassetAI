// Turn N2: fake-client (no real PostgreSQL) unit/contract tests for
// domain/postgres/reference-repository.mjs and
// domain/postgres/reference-runtime-adapters.mjs. The real, byte-for-byte
// equivalence check against a real PostgreSQL 16 server and the portable
// seed-structured-query-adapter.mjs lives in
// tests/reference-repository-postgres16-integration.test.mjs -- this file
// only proves the repository's own decision logic (pin validation,
// fail-closed negative paths, deterministic ordering, mutation isolation,
// caller-owned client lifecycle) against a scriptable fake.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresReferenceRepository,
  ReferenceRepositoryIntegrityError,
} from "../domain/postgres/reference-repository.mjs";
import {
  createPostgresFactStoreAdapter,
  createPostgresEvidenceStoreAdapter,
  createPostgresStructuredStoreAdapter,
} from "../domain/postgres/reference-runtime-adapters.mjs";
import { createFactStore } from "../domain/runtime/fact-store.mjs";
import { createEvidenceStore } from "../domain/runtime/citation-validator.mjs";
import { createStructuredStore } from "../domain/runtime/structured-store.mjs";

const RELEASE_ID = "test-release-v1";
const CORPUS_SNAPSHOT_ID = "corpus_test_1";
const APPROVED_REVISION = "test-revision-1";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_test_1";

const VALID_PIN = Object.freeze({
  expectedReleaseId: RELEASE_ID,
  expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID,
  expectedApprovedRevision: APPROVED_REVISION,
  expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
});

function fact(id, overrides = {}) {
  return {
    fact_id: id, corp_code: "00000001", event_id: null, source_document_id: "exchange_20240101000001",
    metric_code: "CONTRACT_AMOUNT", value_status: "DISCLOSED", normalized_value: 100, unit: "KRW",
    scope: "COMPANY", period_type: "EVENT_PERIOD", period_start: "2024-01-01", period_end: "2024-01-01",
    as_of_date: "2024-01-01", known_at: "2024-01-01T00:00:00Z", valid_from: "2024-01-01T00:00:00Z", valid_to: null,
    verification_status: "VERIFIED", evidence_ids: ["evidence_0000000000000000000000aa"],
    ...overrides,
  };
}
function event(id, overrides = {}) {
  return {
    event_id: id, chain_id: "chain_0000000000000000000000aa", corp_code: "00000001", event_type: "HOLDING_REPORT_CORRECTION",
    anchor_document_id: "holding_20240101000001", event_date: "2024-01-01", known_at: "2024-01-01T00:00:00Z",
    valid_from: "2024-01-01T00:00:00Z", valid_to: null, verification_status: "VERIFIED",
    evidence_ids: ["evidence_0000000000000000000000aa"], ...overrides,
  };
}
function relation(id, overrides = {}) {
  return {
    relation_id: id, relation_type: "AMENDS", source_document_id: "exchange_20240101000001",
    target_document_id: "exchange_20230101000001", event_id: null, evidence_id: null, verification_status: "VERIFIED",
    chain_id: "chain_0000000000000000000000aa", attributes: { corp_code: "00000001" }, ...overrides,
  };
}
function evidence(id, overrides = {}) {
  return {
    evidence_id: id, document_id: "major_20240101000001", file_id: "file_0000000000000000000000aa",
    source_locator: "major_20240101000001/x.xml#node=1", quoted_text: "hello", quote_sha256: "a".repeat(64),
    verification_status: "VERIFIED", metadata: { corp_code: "00000001" }, ...overrides,
  };
}

// Minimal in-memory PostgreSQL fake: understands exactly the SQL shapes
// this repository issues (releases pin lookup, records-by-role-set,
// records-by-role+record_key) -- not a general SQL engine.
function makeFakeClient({ releases = [], records = [] } = {}) {
  const calls = [];
  return {
    calls,
    endCalled: false,
    async end() { this.endCalled = true; throw new Error("adapter must never call client.end()"); },
    async release() { this.endCalled = true; throw new Error("adapter must never call client.release()"); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      const text = String(sql);
      if (/FROM disclosure_reference\.releases WHERE release_id = \$1$/.test(text)) {
        const row = releases.find((r) => r.release_id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/role = ANY\(\$2\) ORDER BY role, ordinal/.test(text)) {
        const rows = records.filter((r) => r.release_id === params[0] && params[1].includes(r.role));
        return { rows: rows.map(({ role, record_key, payload }) => ({ role, record_key, payload })) };
      }
      if (/AND role = \$2 AND record_key = \$3$/.test(text)) {
        const row = records.find((r) => r.release_id === params[0] && r.role === params[1] && r.record_key === params[2]);
        return { rows: row ? [{ record_key: row.record_key, payload: row.payload }] : [] };
      }
      throw new Error(`fake client: unrecognized SQL shape: ${text}`);
    },
  };
}

const READY_RELEASE_ROW = Object.freeze({
  release_id: RELEASE_ID, status: "READY", approved_revision: APPROVED_REVISION,
  corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
});

test("READY release with a matching pin constructs successfully and exposes the verified pin fields", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  assert.equal(repo.releaseId, RELEASE_ID);
  assert.equal(repo.corpusSnapshotId, CORPUS_SNAPSHOT_ID);
  assert.equal(repo.approvedRevision, APPROVED_REVISION);
  assert.equal(repo.factCoverageSnapshotId, FACT_COVERAGE_SNAPSHOT_ID);
});

test("missing release is rejected, not silently substituted", async () => {
  const client = makeFakeClient({ releases: [] });
  await assert.rejects(createPostgresReferenceRepository({ client, ...VALID_PIN }), /was not found/);
});

test("LOADING release is rejected", async () => {
  const client = makeFakeClient({ releases: [{ ...READY_RELEASE_ROW, status: "LOADING" }] });
  await assert.rejects(createPostgresReferenceRepository({ client, ...VALID_PIN }), /is not READY \(status=LOADING\)/);
});

test("release_id mismatch (pinning a release_id no row matches) is rejected -- no fallback to any other release", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  await assert.rejects(
    createPostgresReferenceRepository({ client, ...VALID_PIN, expectedReleaseId: "some-other-release" }),
    /was not found/,
  );
});

test("corpus_snapshot_id mismatch is rejected", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  await assert.rejects(
    createPostgresReferenceRepository({ client, ...VALID_PIN, expectedCorpusSnapshotId: "wrong-corpus" }),
    /corpus_snapshot_id mismatch/,
  );
});

test("approved_revision mismatch is rejected", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  await assert.rejects(
    createPostgresReferenceRepository({ client, ...VALID_PIN, expectedApprovedRevision: "wrong-revision" }),
    /approved_revision mismatch/,
  );
});

test("fact_coverage_snapshot_id mismatch is rejected", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  await assert.rejects(
    createPostgresReferenceRepository({ client, ...VALID_PIN, expectedFactCoverageSnapshotId: "wrong-coverage" }),
    /fact_coverage_snapshot_id mismatch/,
  );
});

test("a caller omitting any pin is rejected -- production-shaped construction has no optional pin", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  for (const omitted of ["expectedReleaseId", "expectedCorpusSnapshotId", "expectedApprovedRevision", "expectedFactCoverageSnapshotId"]) {
    const pin = { ...VALID_PIN };
    delete pin[omitted];
    await assert.rejects(createPostgresReferenceRepository({ client, ...pin }), TypeError, omitted);
  }
  await assert.rejects(createPostgresReferenceRepository({}), TypeError, "client");
});

test("another READY release existing does not cause fallback -- the pinned release_id strictly scopes every query", async () => {
  const otherReady = { release_id: "other-release", status: "READY", approved_revision: "other-rev", corpus_snapshot_id: "other-corpus", fact_coverage_snapshot_id: "other-coverage" };
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW, otherReady],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_aaaaaaaaaaaaaaaaaaaaaaaa", payload: fact("fact_aaaaaaaaaaaaaaaaaaaaaaaa") },
      { release_id: "other-release", role: "VERIFIED_FACT", record_key: "fact_bbbbbbbbbbbbbbbbbbbbbbbb", payload: fact("fact_bbbbbbbbbbbbbbbbbbbbbbbb") },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const results = await repo.queryFacts({ as_of_date: "2024-01-01", limit: 100 });
  assert.deepEqual(results.map((r) => r.record_id), ["fact_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.equal(await repo.getFact("fact_bbbbbbbbbbbbbbbbbbbbbbbb"), null, "a record belonging to a DIFFERENT release must never be servable through this repository instance");
});

test("a non-existent ID resolves as NOT_FOUND (null), never throws", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW], records: [] });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  assert.equal(await repo.getFact("fact_does_not_exist_00000000"), null);
  assert.equal(await repo.getEvidence("evidence_does_not_exist_0000"), null);
  assert.equal(await repo.getEvent("event_does_not_exist_0000000"), null);
  assert.equal(await repo.getRelation("relation_does_not_exist"), null);
});

test("a genuine DB failure during a get/query call is a thrown repository error, never silently converted to NOT_FOUND", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW] });
  client.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM disclosure_reference\.releases/.test(text)) return { rows: [READY_RELEASE_ROW] };
    throw new Error("simulated connection reset");
  };
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.getFact("fact_aaaaaaaaaaaaaaaaaaaaaaaa"), /simulated connection reset/);
  await assert.rejects(repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 }), /simulated connection reset/);
});

test("role mismatch (a row's payload does not look like the role it is stored under) is rejected, not silently served", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      // Stored under role VERIFIED_FACT, record_key "fact_x", but the
      // payload is shaped like an Event (no fact_id at all).
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: event("event_x") },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.getFact("fact_x"), ReferenceRepositoryIntegrityError);
  await assert.rejects(repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 }), ReferenceRepositoryIntegrityError);
});

test("record_key <-> payload stable-ID mismatch is rejected", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_y") },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.getFact("fact_x"), ReferenceRepositoryIntegrityError);
});

test("a non-VERIFIED payload stored under a VERIFIED_* role is rejected, never leaked", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x", { verification_status: "CANDIDATE" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.getFact("fact_x"), ReferenceRepositoryIntegrityError);
  await assert.rejects(repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 }), ReferenceRepositoryIntegrityError);
});

// -- Turn N2.1 (Codex-reported defect): conflicting corp_code for the SAME
// document_id must fail closed, never silently resolve to "whichever value
// was seen first" -- mirrors seed-structured-query-adapter.mjs's own
// register() exactly. Codex's exact reproduction: two VERIFIED_FACT rows
// both anchored to document_id "exchange_20240101000001", one with
// corp_code "00000001" and one with "00000002" -- pre-fix this was
// silently ACCEPTED (the first-seen corp_code won); post-fix it must throw
// ReferenceRepositoryIntegrityError. --------------------------------------

test("Turn N2.1 Codex counterexample: two Facts sharing a document_id with DIFFERENT corp_code are rejected, not silently resolved to the first-seen value", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_b", payload: fact("fact_b", { source_document_id: "exchange_20240101000001", corp_code: "00000002" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(
    repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 }),
    (error) => error instanceof ReferenceRepositoryIntegrityError && /conflicting corp_code/.test(error.message),
  );
});

test("a Fact and an Event sharing a document_id with DIFFERENT corp_code are rejected", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "holding_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_a", payload: event("event_a", { anchor_document_id: "holding_20240101000001", corp_code: "00000002" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.queryEvents({ as_of_date: "2024-01-01", limit: 10 }), ReferenceRepositoryIntegrityError);
});

test("a Relation's attributes.corp_code conflicting with an existing Fact/Event corp_code for the same document_id is rejected", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_RELATION", record_key: "relation_a", payload: relation("relation_a", { source_document_id: "exchange_20240101000001", target_document_id: "exchange_20230101000001", attributes: { corp_code: "00000002" } }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.queryRelations({ as_of_date: "2024-01-01", limit: 10 }), ReferenceRepositoryIntegrityError);
});

test("the SAME document_id repeated with the SAME corp_code is accepted -- only a genuine mismatch is a conflict", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_b", payload: fact("fact_b", { source_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_a", payload: event("event_a", { anchor_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const facts = await repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 });
  assert.equal(facts.length, 2);
});

test("different document_ids with different corp_code values do not falsely trip the conflict check", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_b", payload: fact("fact_b", { source_document_id: "exchange_20230101000001", corp_code: "00000002" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const facts = await repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 });
  assert.equal(facts.length, 2);
});

test("a corp_code conflict located in a VERIFIED role that is NOT the query's own target still fails the whole query closed (the repository always scans all four VERIFIED_* roles to build documentCorp)", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      // The conflict lives entirely between an Event and a Relation --
      // neither is a VERIFIED_FACT row -- yet a plain queryFacts() call
      // (which only WANTS Fact records) must still fail closed, because
      // building documentCorp always reads all four VERIFIED_* roles.
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { source_document_id: "holding_20240101000009", corp_code: "00000009" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_a", payload: event("event_a", { anchor_document_id: "exchange_20240101000001", corp_code: "00000001" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_RELATION", record_key: "relation_a", payload: relation("relation_a", { source_document_id: "exchange_20240101000001", target_document_id: "exchange_20230101000001", attributes: { corp_code: "00000002" } }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 }), ReferenceRepositoryIntegrityError);
});

test("every SQL statement issued uses $-placeholders with a separate params array -- no caller value is ever string-concatenated into SQL text", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await repo.getFact("fact_x' OR 1=1 --");
  await repo.queryFacts({ as_of_date: "2024-01-01", limit: 10, corp_codes: ["00000001' OR 1=1 --"] });
  for (const call of client.calls) {
    assert.doesNotMatch(call.sql, /'/, `SQL text must never contain a literal quote (found in: ${call.sql})`);
    assert.match(call.sql, /\$1/, "every query must use parameter placeholders");
  }
});

test("deterministic ordering: repeated queries over the same data return records in the same order", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_c", payload: fact("fact_c", { known_at: "2024-01-01T00:00:00Z" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_a", payload: fact("fact_a", { known_at: "2024-01-02T00:00:00Z" }) },
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_b", payload: fact("fact_b", { known_at: "2024-01-02T00:00:00Z" }) },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const first = await repo.queryFacts({ as_of_date: "2024-01-02", limit: 100 });
  const second = await repo.queryFacts({ as_of_date: "2024-01-02", limit: 100 });
  const ids = first.map((r) => r.record_id);
  assert.deepEqual(ids, ["fact_a", "fact_b", "fact_c"], "known_at desc, then record_id asc as a stable tie-break");
  assert.deepEqual(second.map((r) => r.record_id), ids);
});

test("limit boundary: only the top `limit` records (post-sort) are returned, and invalid limits are rejected", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [1, 2, 3].map((n) => ({ release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: `fact_${n}`, payload: fact(`fact_${n}`) })),
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const limited = await repo.queryFacts({ as_of_date: "2024-01-01", limit: 2 });
  assert.equal(limited.length, 2);
  for (const badLimit of [0, -1, 1001, 1.5, undefined, "10"]) {
    await assert.rejects(repo.queryFacts({ as_of_date: "2024-01-01", limit: badLimit }), TypeError);
  }
});

test("returned records are independent copies -- mutating one result cannot affect a later call", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const first = await repo.getFact("fact_x");
  assert.ok(Object.isFrozen(first), "returned records must be frozen -- a caller cannot mutate the repository's own state through them");
  assert.throws(() => { first.normalized_value = 999999; }, TypeError);
  const second = await repo.getFact("fact_x");
  assert.equal(second.normalized_value, 100, "a second call must be unaffected by any attempted mutation of the first result");
  assert.notEqual(first, second, "two calls must return distinct object instances, never the same shared reference");
});

test("the repository never ends or releases the caller-owned client/pool", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await repo.getFact("fact_x");
  await repo.queryFacts({ as_of_date: "2024-01-01", limit: 10 });
  assert.equal(client.endCalled, false, "client.end()/release() must never be called by this module -- lifecycle is caller-owned");
});

// -- Runtime Store adapter wiring (FactStore / EvidenceStore / StructuredStore) --

test("createPostgresFactStoreAdapter wired through the real createFactStore resolves a VERIFIED fact and enforces snapshot pinning", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const adapter = createPostgresFactStoreAdapter(repo);
  const store = createFactStore(adapter, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID });
  const resolved = await store.resolve("fact_x");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.record.fact_id, "fact_x");

  const wrongSnapshotStore = createFactStore(adapter, { corpus_snapshot_id: "wrong", fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID });
  const rejected = await wrongSnapshotStore.resolve("fact_x");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "FACT_SNAPSHOT_MISMATCH");
});

test("createPostgresEvidenceStoreAdapter wired through the real createEvidenceStore resolves VERIFIED evidence", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_EVIDENCE", record_key: "evidence_x", payload: evidence("evidence_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const adapter = createPostgresEvidenceStoreAdapter(repo);
  const store = createEvidenceStore(adapter, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID });
  const resolved = await store.resolve("evidence_x");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.record.evidence_id, "evidence_x");
});

test("createPostgresStructuredStoreAdapter wired through the real createStructuredStore returns a schema-valid combined result across targets", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [
      { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: "fact_x", payload: fact("fact_x") },
      { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_x", payload: event("event_x") },
    ],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const adapter = createPostgresStructuredStoreAdapter(repo);
  const store = createStructuredStore(adapter, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID });
  const result = await store.query({
    schema_version: "0.2.0", query_id: "query_test_1", execution_scope: "OFFICIAL",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    targets: ["FACT", "EVENT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2024-01-01", limit: 100,
  });
  assert.equal(result.status, "OK");
  assert.deepEqual(result.records.map((r) => r.record_type).sort(), ["EVENT", "FACT"]);
  assert.equal(result.corpus_snapshot_id, CORPUS_SNAPSHOT_ID);
  assert.equal(result.fact_coverage_snapshot_id, FACT_COVERAGE_SNAPSHOT_ID);
});

test("createPostgresStructuredStoreAdapter never leaks a non-VERIFIED record on an OFFICIAL query, even if repository data were somehow non-VERIFIED", async () => {
  const client = makeFakeClient({
    releases: [READY_RELEASE_ROW],
    records: [{ release_id: RELEASE_ID, role: "VERIFIED_RELATION", record_key: "relation_x", payload: relation("relation_x") }],
  });
  const repo = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const adapter = createPostgresStructuredStoreAdapter(repo);
  const store = createStructuredStore(adapter, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID });
  const result = await store.query({
    schema_version: "0.2.0", query_id: "query_test_2", execution_scope: "OFFICIAL",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    targets: ["RELATION"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2024-01-01", limit: 100,
  });
  assert.equal(result.status, "OK");
  assert.equal(result.records[0].verification_status, "VERIFIED");
});
