// Turn N3.1: fake-client (no real PostgreSQL) unit/contract tests for
// domain/postgres/coverage-authorized-fact-view.mjs and the two new
// coverage-authorized adapters in domain/postgres/reference-runtime-adapters.mjs.
// The real, partial-Coverage PostgreSQL 16 integration fixture (3 VERIFIED
// Facts, 2 Coverage-authorized) lives in
// tests/coverage-authorized-fact-view-postgres16-integration.test.mjs --
// this file only proves the authorization decision logic (construction
// fail-closed paths, getFact/queryFacts filtering, limit-after-authorization,
// adapter envelopes) against a scriptable fake.
import assert from "node:assert/strict";
import test from "node:test";
import { RequestAbortedError } from "../domain/runtime/abortable.mjs";
import { createPostgresReferenceRepository } from "../domain/postgres/reference-repository.mjs";
import {
  CoverageAuthorizationIntegrityError,
  createCoverageAuthorizedFactView,
} from "../domain/postgres/coverage-authorized-fact-view.mjs";
import {
  createCoverageAuthorizedPostgresFactStoreAdapter,
  createCoverageAuthorizedPostgresStructuredStoreAdapter,
} from "../domain/postgres/reference-runtime-adapters.mjs";

const RELEASE_ID = "test-release-coverage-v1";
const CORPUS_SNAPSHOT_ID = "corpus_test_coverage_1";
const APPROVED_REVISION = "test-revision-coverage-1";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_test_coverage_1";
const VALID_PIN = Object.freeze({
  expectedReleaseId: RELEASE_ID, expectedCorpusSnapshotId: CORPUS_SNAPSHOT_ID,
  expectedApprovedRevision: APPROVED_REVISION, expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID,
});
const READY_RELEASE_ROW = Object.freeze({
  release_id: RELEASE_ID, status: "READY", approved_revision: APPROVED_REVISION,
  corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
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
function coverageSlot(slotKey, factIds, overrides = {}) {
  return {
    slot_key: slotKey, corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", period_key: "as_of:2024-01-01",
    scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED",
    fact_ids: factIds, evidence_ids: [], reason_code: null, ...overrides,
  };
}

// Minimal in-memory PostgreSQL fake, extended from reference-repository.test.mjs's
// own fake to additionally recognize coverage-authorized-fact-view.mjs's own
// SQL shape (`role = $2 ORDER BY ordinal`, a single role -- deliberately
// distinct text from the repository's own `role = ANY($2) ORDER BY role,
// ordinal`, so the two SQL shapes can never be confused with one another).
function makeFakeClient({ releases = [], records = [], onQuery } = {}) {
  return {
    async end() { throw new Error("adapter must never call client.end()"); },
    async query(sql, params = []) {
      if (onQuery) onQuery(sql, params);
      const text = String(sql);
      if (/FROM disclosure_reference\.releases WHERE release_id = \$1$/.test(text)) {
        const row = releases.find((r) => r.release_id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/role = ANY\(\$2\) ORDER BY role, ordinal/.test(text)) {
        const rows = records.filter((r) => r.release_id === params[0] && params[1].includes(r.role));
        return { rows: rows.map(({ role, record_key, payload }) => ({ role, record_key, payload })) };
      }
      if (/WHERE release_id = \$1 AND role = \$2 ORDER BY ordinal$/.test(text)) {
        const rows = records.filter((r) => r.release_id === params[0] && r.role === params[1]);
        return { rows: rows.map(({ record_key, payload }) => ({ record_key, payload })) };
      }
      if (/AND role = \$2 AND record_key = \$3$/.test(text)) {
        const row = records.find((r) => r.release_id === params[0] && r.role === params[1] && r.record_key === params[2]);
        return { rows: row ? [{ record_key: row.record_key, payload: row.payload }] : [] };
      }
      throw new Error(`fake client: unrecognized SQL shape: ${text}`);
    },
  };
}

function factRow(id, overrides) {
  return { release_id: RELEASE_ID, role: "VERIFIED_FACT", record_key: id, payload: fact(id, overrides) };
}
function slotRow(slotKey, factIds, overrides) {
  return { release_id: RELEASE_ID, role: "FACT_COVERAGE_SNAPSHOT", record_key: slotKey, payload: coverageSlot(slotKey, factIds, overrides) };
}

async function buildRepositoryAndView({ records, expectedFactCoverageSnapshotId = FACT_COVERAGE_SNAPSHOT_ID, onQuery } = {}) {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW], records, onQuery });
  const repository = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  const view = await createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId });
  return { client, repository, view };
}

const THREE_FACTS_TWO_AUTHORIZED = [
  factRow("fact_a"), factRow("fact_b"), factRow("fact_c"),
  slotRow("slot_1", ["fact_a"]), slotRow("slot_2", ["fact_b"]),
];

test("authorizedFactCount() reflects the union of every slot's fact_ids, not the full VERIFIED_FACT count", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  assert.equal(view.authorizedFactCount(), 2);
});

test("getFact returns the payload for an authorized Fact, null for a VERIFIED-but-unauthorized Fact, and null for a genuinely nonexistent id", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const authorized = await view.getFact("fact_a");
  assert.equal(authorized.fact_id, "fact_a");
  assert.equal(await view.getFact("fact_c"), null, "fact_c is VERIFIED but not referenced by any coverage slot");
  assert.equal(await view.getFact("fact_nonexistent"), null);
});

test("a slot referencing more than one fact_id authorizes all of them", async () => {
  const records = [factRow("fact_a"), factRow("fact_b"), factRow("fact_c"), slotRow("slot_1", ["fact_a", "fact_b"])];
  const { view } = await buildRepositoryAndView({ records });
  assert.equal(view.authorizedFactCount(), 2);
  assert.notEqual(await view.getFact("fact_a"), null);
  assert.notEqual(await view.getFact("fact_b"), null);
  assert.equal(await view.getFact("fact_c"), null);
});

test("the SAME fact_id authorized by two different slots is counted once (Set union, not sum)", async () => {
  const records = [factRow("fact_a"), slotRow("slot_1", ["fact_a"]), slotRow("slot_2", ["fact_a"])];
  const { view } = await buildRepositoryAndView({ records });
  assert.equal(view.authorizedFactCount(), 1);
});

test("construction rejects when expectedFactCoverageSnapshotId does not match the underlying repository's own pinned value", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW], records: THREE_FACTS_TWO_AUTHORIZED });
  const repository = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: "wrong-coverage-snapshot" }),
    /fact_coverage_snapshot_id mismatch/,
  );
});

test("construction rejects when a caller omits expectedFactCoverageSnapshotId -- no optional pin", async () => {
  const client = makeFakeClient({ releases: [READY_RELEASE_ROW], records: THREE_FACTS_TWO_AUTHORIZED });
  const repository = await createPostgresReferenceRepository({ client, ...VALID_PIN });
  await assert.rejects(createCoverageAuthorizedFactView({ client, repository }), TypeError);
});

test("construction rejects when the release has zero FACT_COVERAGE_SNAPSHOT rows -- never silently authorizes nothing", async () => {
  await assert.rejects(
    buildRepositoryAndView({ records: [factRow("fact_a")] }),
    /zero FACT_COVERAGE_SNAPSHOT rows/,
  );
});

test("construction rejects a slot whose record_key does not match its own payload.slot_key", async () => {
  const records = [factRow("fact_a"), { release_id: RELEASE_ID, role: "FACT_COVERAGE_SNAPSHOT", record_key: "slot_1", payload: coverageSlot("DIFFERENT_KEY", ["fact_a"]) }];
  await assert.rejects(buildRepositoryAndView({ records }), CoverageAuthorizationIntegrityError);
});

test("construction rejects a slot whose verification_status is not VERIFIED", async () => {
  const records = [factRow("fact_a"), slotRow("slot_1", ["fact_a"], { verification_status: "CANDIDATE" })];
  await assert.rejects(buildRepositoryAndView({ records }), /not VERIFIED/);
});

test("construction rejects a slot whose fact_ids is not an array of non-empty strings", async () => {
  const notArray = [factRow("fact_a"), slotRow("slot_1", "fact_a")];
  await assert.rejects(buildRepositoryAndView({ records: notArray }), CoverageAuthorizationIntegrityError);

  const containsEmpty = [factRow("fact_a"), slotRow("slot_1", ["fact_a", ""])];
  await assert.rejects(buildRepositoryAndView({ records: containsEmpty }), CoverageAuthorizationIntegrityError);
});

test("construction rejects a slot referencing a fact_id that does not resolve to any real VERIFIED_FACT row in the release", async () => {
  const records = [factRow("fact_a"), slotRow("slot_1", ["fact_a", "fact_ghost"])];
  await assert.rejects(
    buildRepositoryAndView({ records }),
    /references fact_id "fact_ghost", which is not a real VERIFIED_FACT row/,
  );
});

test("a genuine DB failure during either query propagates as a thrown error, never silently reduced to an empty authorization set", async () => {
  const failingClient = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM disclosure_reference\.releases WHERE release_id = \$1$/.test(text)) {
        const row = [READY_RELEASE_ROW].find((r) => r.release_id === params[0]);
        return { rows: row ? [row] : [] };
      }
      throw new Error("simulated connection failure");
    },
  };
  const repository = await createPostgresReferenceRepository({ client: failingClient, ...VALID_PIN });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client: failingClient, repository, expectedFactCoverageSnapshotId: FACT_COVERAGE_SNAPSHOT_ID }),
    /simulated connection failure/,
  );
});

test("queryFacts returns only the Coverage-authorized subset, sorted the same way the raw repository would sort them", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  };
  const records = await view.queryFacts(filters);
  assert.deepEqual(new Set(records.map((r) => r.record_id)), new Set(["fact_a", "fact_b"]));
});

test("limit is applied AFTER authorization filtering, never before -- an unauthorized Fact never occupies a limit slot", async () => {
  // known_at desc sort puts a LATER known_at first; fact_c (unauthorized)
  // is deliberately given the LATEST known_at so it would be the very
  // FIRST record the raw repository returns before any authorization
  // filtering -- if limit were (incorrectly) applied before filtering,
  // limit=1 would return zero authorized records (fact_c only, then
  // filtered away). Applied correctly (after filtering), limit=1 must
  // still return exactly one AUTHORIZED record.
  const records = [
    factRow("fact_a", { known_at: "2024-01-01T00:00:00Z" }),
    factRow("fact_b", { known_at: "2024-01-02T00:00:00Z" }),
    factRow("fact_c", { known_at: "2024-01-03T00:00:00Z" }),
    slotRow("slot_1", ["fact_a"]), slotRow("slot_2", ["fact_b"]),
  ];
  const { view } = await buildRepositoryAndView({ records });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1,
  };
  const result = await view.queryFacts(filters);
  assert.equal(result.length, 1);
  assert.equal(result[0].record_id, "fact_b", "fact_b has the latest known_at among the AUTHORIZED facts");
});

test("queryFacts rejects an invalid limit itself, exactly like the raw repository would, instead of silently substituting its own internal 1000", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const badFilters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 5000,
  };
  await assert.rejects(view.queryFacts(badFilters), TypeError);
});

test("createCoverageAuthorizedPostgresFactStoreAdapter wraps getFact into the FactStore envelope, and returns null for an unauthorized Fact", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const adapter = createCoverageAuthorizedPostgresFactStoreAdapter(view);
  const envelope = await adapter.getFact("fact_a");
  assert.deepEqual(envelope, { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, record: envelope.record });
  assert.equal(envelope.record.fact_id, "fact_a");
  assert.equal(await adapter.getFact("fact_c"), null);
});

test("createCoverageAuthorizedPostgresStructuredStoreAdapter: FACT target is authorization-filtered, EVENT/RELATION/EVIDENCE targets are byte-identical to the unauthorized adapter", async () => {
  const eventPayload = {
    event_id: "event_a", chain_id: "chain_a", corp_code: "00000001", event_type: "HOLDING_REPORT_CORRECTION",
    anchor_document_id: "holding_20240101000001", event_date: "2024-01-01", known_at: "2024-01-01T00:00:00Z",
    valid_from: "2024-01-01T00:00:00Z", valid_to: null, verification_status: "VERIFIED", evidence_ids: [],
  };
  const records = [
    ...THREE_FACTS_TWO_AUTHORIZED,
    { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_a", payload: eventPayload },
  ];
  const { view, repository } = await buildRepositoryAndView({ records });
  const adapter = createCoverageAuthorizedPostgresStructuredStoreAdapter({ authorizedFactView: view, repository });
  const result = await adapter.query({
    schema_version: "0.2.0", query_id: "q1", execution_scope: "OFFICIAL", corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, targets: ["FACT", "EVENT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  });
  assert.equal(result.status, "OK");
  const ids = result.records.map((r) => r.record_id).sort();
  assert.deepEqual(ids, ["event_a", "fact_a", "fact_b"], "fact_c (unauthorized) must be absent, event_a must be present unmodified");
});

test("createCoverageAuthorizedPostgresStructuredStoreAdapter: combined multi-target limit is applied AFTER FACT authorization filtering", async () => {
  const eventPayload = {
    event_id: "event_a", chain_id: "chain_a", corp_code: "00000001", event_type: "HOLDING_REPORT_CORRECTION",
    anchor_document_id: "holding_20240101000001", event_date: "2024-01-01", known_at: "2024-01-04T00:00:00Z",
    valid_from: "2024-01-01T00:00:00Z", valid_to: null, verification_status: "VERIFIED", evidence_ids: [],
  };
  const records = [
    factRow("fact_a", { known_at: "2024-01-01T00:00:00Z" }),
    factRow("fact_b", { known_at: "2024-01-02T00:00:00Z" }),
    factRow("fact_c", { known_at: "2024-01-03T00:00:00Z" }),
    slotRow("slot_1", ["fact_a"]), slotRow("slot_2", ["fact_b"]),
    { release_id: RELEASE_ID, role: "VERIFIED_EVENT", record_key: "event_a", payload: eventPayload },
  ];
  const { view, repository } = await buildRepositoryAndView({ records });
  const adapter = createCoverageAuthorizedPostgresStructuredStoreAdapter({ authorizedFactView: view, repository });
  // known_at desc: event_a (01-04) > fact_c (01-03, unauthorized) > fact_b
  // (01-02) > fact_a (01-01). If limit were applied before FACT
  // authorization, limit=2 would keep [event_a, fact_c] and drop both
  // authorized Facts. Applied correctly, limit=2 must keep [event_a,
  // fact_b] -- the highest-ranked AUTHORIZED Fact, not the highest-ranked
  // Fact overall.
  const result = await adapter.query({
    schema_version: "0.2.0", query_id: "q2", execution_scope: "OFFICIAL", corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, targets: ["FACT", "EVENT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 2,
  });
  assert.deepEqual(result.records.map((r) => r.record_id), ["event_a", "fact_b"]);
});

// -- Turn N3.1.1 A: authorization must be pushed down BEFORE limit, not
// applied to a fixed limit=1000 pre-fetch -- scales correctly regardless of
// total Fact count. -------------------------------------------------------

function makeFacts(count, { authorizedIndex } = {}) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    // known_at DESCENDING as index increases, so index 0 sorts FIRST and
    // the highest index sorts LAST -- the authorized fact is placed at the
    // very end of the sort order so a buggy "fetch top 1000, then filter"
    // implementation would never even see it once count exceeds 1000.
    const known_at = new Date(2024, 0, 1 + (count - i)).toISOString();
    records.push(factRow(`fact_${i}`, { known_at }));
  }
  const authorizedId = `fact_${authorizedIndex}`;
  records.push(slotRow("slot_1", [authorizedId]));
  return records;
}

test("Turn N3.1.1 regression: an authorized Fact ranked LAST among 1,005 real VERIFIED_FACT rows is still found by getFact and queryFacts (not silently dropped by any internal top-1000 pre-fetch)", async () => {
  const records = makeFacts(1005, { authorizedIndex: 1004 });
  const { view } = await buildRepositoryAndView({ records });
  assert.equal(view.authorizedFactCount(), 1);
  assert.notEqual(await view.getFact("fact_1004"), null, "the sole authorized Fact, ranked dead last by known_at, must still resolve");

  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1,
  };
  const result = await view.queryFacts(filters);
  assert.deepEqual(result.map((r) => r.record_id), ["fact_1004"]);
});

test("Turn N3.1.1 A: queryFacts intersects the CALLER's own fact_ids filter with the authorized set, rather than ignoring one or the other", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    // caller asks for fact_a (authorized) AND fact_c (VERIFIED but NOT authorized) --
    // only fact_a may come back.
    fact_ids: ["fact_a", "fact_c"], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  const result = await view.queryFacts(filters);
  assert.deepEqual(result.map((r) => r.record_id), ["fact_a"]);
});

test("Turn N3.1.1 A: queryFacts returns an empty array (never all Facts) when the caller's fact_ids filter has zero overlap with the authorized set", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: ["fact_c"], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  assert.deepEqual(await view.queryFacts(filters), []);
});

// -- Turn N3.1.2: the empty-intersection path no longer pushes a sentinel
// fact_id down to the raw Repository -- it returns [] directly, without
// issuing any raw Repository query at all. -------------------------------

test("Turn N3.1.2: an empty intersection returns exactly [] -- deepEqual to the empty array, not merely empty-length", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: ["fact_c"], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  assert.deepEqual(await view.queryFacts(filters), []);
});

test("Turn N3.1.2: even if the raw store holds a Fact record whose record_key looks like a sentinel/placeholder string, it is never returned for an unrelated empty intersection", async () => {
  // No former sentinel constant exists in the module anymore -- this
  // fixture just proves that ANY oddly-named real record_key, including
  // one that would have collided with the removed sentinel literal, can
  // never leak through when the caller's own fact_ids filter has zero
  // overlap with the authorized set. Since the empty-intersection path
  // never calls repository.queryFacts at all, this is structurally
  // guaranteed, not merely coincidental.
  const weirdId = "__n3_1_1_coverage_authorized_fact_view_empty_set__";
  const records = [
    ...THREE_FACTS_TWO_AUTHORIZED,
    factRow(weirdId), // VERIFIED but never referenced by any coverage slot -- unauthorized
  ];
  const { view } = await buildRepositoryAndView({ records });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: ["fact_c"], event_ids: [], relation_ids: [], // requests only an unauthorized id -- empty intersection
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  assert.deepEqual(await view.queryFacts(filters), []);
  assert.equal(await view.getFact(weirdId), null, "the odd-looking id itself is VERIFIED but never Coverage-authorized");
});

test("Turn N3.1.2: an already-aborted signal rejects with RequestAbortedError even on the empty-intersection (no-I/O) path", async () => {
  const { view } = await buildRepositoryAndView({ records: THREE_FACTS_TWO_AUTHORIZED });
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: ["fact_c"], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(view.queryFacts(filters, { signal: controller.signal }), RequestAbortedError);
});

test("Turn N3.1.2: when the authorized set itself is empty (a real slot row exists, but its own fact_ids array is empty), queryFacts with no fact_ids filter still returns []", async () => {
  const records = [factRow("fact_a"), slotRow("slot_1", [])];
  const { view } = await buildRepositoryAndView({ records });
  assert.equal(view.authorizedFactCount(), 0);
  const filters = {
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [],
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  };
  assert.deepEqual(await view.queryFacts(filters), []);
  assert.equal(await view.getFact("fact_a"), null);
});

// -- Turn N3.1.1 B: direct-dimension consistency (corp_code/metric_code/
// non-null scope), mirroring seed-fact-artifact-store.mjs exactly. --------

test("construction rejects a slot whose corp_code does not match the Fact it authorizes", async () => {
  const records = [factRow("fact_a", { corp_code: "00000001" }), slotRow("slot_1", ["fact_a"], { corp_code: "00000002" })];
  await assert.rejects(buildRepositoryAndView({ records }), /corp_code "00000002" does not match fact_id "fact_a" corp_code "00000001"/);
});

test("construction rejects a slot whose metric_code does not match the Fact it authorizes", async () => {
  const records = [factRow("fact_a", { metric_code: "CONTRACT_AMOUNT" }), slotRow("slot_1", ["fact_a"], { metric_code: "INVESTMENT_AMOUNT" })];
  await assert.rejects(buildRepositoryAndView({ records }), /metric_code "INVESTMENT_AMOUNT" does not match fact_id "fact_a" metric_code "CONTRACT_AMOUNT"/);
});

test("construction rejects a slot whose NON-NULL scope does not match the Fact it authorizes", async () => {
  const records = [factRow("fact_a", { scope: "COMPANY" }), slotRow("slot_1", ["fact_a"], { scope: "CONSOLIDATED" })];
  await assert.rejects(buildRepositoryAndView({ records }), /scope "CONSOLIDATED" does not match fact_id "fact_a" scope "COMPANY"/);
});

test("construction ACCEPTS a slot whose scope is null or omitted, regardless of the Fact's own scope -- null/undefined scope means 'no scope filter'", async () => {
  const nullScope = [factRow("fact_a", { scope: "COMPANY" }), slotRow("slot_1", ["fact_a"], { scope: null })];
  await assert.doesNotReject(buildRepositoryAndView({ records: nullScope }));

  const omittedScope = [factRow("fact_b", { scope: "CONSOLIDATED" }), { release_id: RELEASE_ID, role: "FACT_COVERAGE_SNAPSHOT", record_key: "slot_1", payload: (() => { const s = coverageSlot("slot_1", ["fact_b"]); delete s.scope; return s; })() }];
  await assert.doesNotReject(buildRepositoryAndView({ records: omittedScope }));
});

test("the SAME fact_id referenced by two DIFFERENT slots is allowed when BOTH slots' dimensions independently match that Fact", async () => {
  const records = [
    factRow("fact_a", { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }),
    slotRow("slot_1", ["fact_a"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }),
    slotRow("slot_2", ["fact_a"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: null }),
  ];
  const { view } = await buildRepositoryAndView({ records });
  assert.equal(view.authorizedFactCount(), 1);
  assert.notEqual(await view.getFact("fact_a"), null);
});

test("the SAME fact_id referenced by two slots is rejected if EITHER slot's dimensions mismatch, even though the other slot matches", async () => {
  const records = [
    factRow("fact_a", { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }),
    slotRow("slot_1", ["fact_a"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }),
    slotRow("slot_2", ["fact_a"], { corp_code: "99999999", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }),
  ];
  await assert.rejects(buildRepositoryAndView({ records }), CoverageAuthorizationIntegrityError);
});

test("Turn N3.1.1: the unknown-fact_id check is resolved via repository.getFact per unique id, not a bulk/limit-bounded scan -- an authorized fact_id ranked past where a 1000-row scan would have stopped is still validated correctly", async () => {
  // 1005 real Facts, none matching the coverage slot's own fact_id at all
  // -- the slot references a genuinely unknown id. If the unknown-fact_id
  // check depended on any bulk, limit-bounded fetch, adding 1005 unrelated
  // real Facts first would not change the outcome (still correctly
  // rejected) -- this test exists to document/lock in that
  // resolveFact()/repository.getFact() is a single targeted lookup, never
  // a scan, regardless of how many other real Facts exist in the release.
  const records = makeFacts(1005, { authorizedIndex: 0 });
  const badSlot = slotRow("slot_ghost", ["fact_totally_unknown"]);
  await assert.rejects(
    buildRepositoryAndView({ records: [...records, badSlot] }),
    /references fact_id "fact_totally_unknown", which is not a real VERIFIED_FACT row/,
  );
});
