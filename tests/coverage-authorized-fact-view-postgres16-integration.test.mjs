// Turn N3.1: REAL PostgreSQL 16 integration coverage for
// domain/postgres/coverage-authorized-fact-view.mjs and the two new
// coverage-authorized adapters in domain/postgres/reference-runtime-adapters.mjs,
// against a hand-built SYNTHETIC partial-Coverage release (3 VERIFIED
// Facts, only 2 Coverage-authorized) -- the real v0.20-r3 release
// authorizes all 87 of its Facts, so it alone cannot exercise the
// "authorized narrower than VERIFIED" path this Turn exists to add.
//
// The synthetic release is inserted directly via SQL (mirroring exactly
// what domain/postgres/reference-release-loader.mjs itself writes, just
// without going through a real bundle) rather than built from a portable
// bundle -- coverage-authorized-fact-view.mjs only ever reads
// disclosure_reference.records/releases, so this is a faithful, minimal
// fixture for it. No question_id, company name, or real Seed amount from
// the actual v0.20-r3 data appears anywhere below -- every id/value here is
// a synthetic placeholder invented for this test alone.
//
// Deliberately excluded from `npm run test:reference-db` and
// `npm run verify:contracts` -- run explicitly via:
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     node --test tests/coverage-authorized-fact-view-postgres16-integration.test.mjs
//
// If DATABASE_URL is not set, this suite FAILS CLOSED, never a silent skip.
import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import pg from "pg";
import { applyReferenceReleaseMigration } from "../domain/postgres/reference-release-loader.mjs";
import { createPostgresReferenceRepository } from "../domain/postgres/reference-repository.mjs";
import {
  CoverageAuthorizationIntegrityError,
  createCoverageAuthorizedFactView,
} from "../domain/postgres/coverage-authorized-fact-view.mjs";
import {
  createCoverageAuthorizedPostgresFactStoreAdapter,
  createCoverageAuthorizedPostgresStructuredStoreAdapter,
} from "../domain/postgres/reference-runtime-adapters.mjs";

const { Client } = pg;
const ROOT = process.cwd();

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url === "") {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run "
      + "tests/coverage-authorized-fact-view-postgres16-integration.test.mjs. "
      + "Point it at an EMPTY scratch PostgreSQL 16 database.",
    );
  }
  return url;
}

const DUMMY_SHA256 = "0".repeat(64);

function factPayload(id, overrides = {}) {
  return {
    fact_id: id, corp_code: "00000001", event_id: null, source_document_id: "exchange_20240101000001",
    metric_code: "CONTRACT_AMOUNT", value_status: "DISCLOSED", normalized_value: 100, unit: "KRW",
    scope: "COMPANY", period_type: "EVENT_PERIOD", period_start: "2024-01-01", period_end: "2024-01-01",
    as_of_date: "2024-01-01", known_at: "2024-01-01T00:00:00Z", valid_from: "2024-01-01T00:00:00Z", valid_to: null,
    verification_status: "VERIFIED", evidence_ids: ["evidence_synthetic_a"], ...overrides,
  };
}
function slotPayload(slotKey, factIds, overrides = {}) {
  return {
    slot_key: slotKey, corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", period_key: "as_of:2024-01-01",
    scope: "COMPANY", coverage_state: "ALL_REQUIRED_FACT_SLOTS_VERIFIED", verification_status: "VERIFIED",
    fact_ids: factIds, evidence_ids: [], reason_code: null, ...overrides,
  };
}
function eventPayload(id, overrides = {}) {
  return {
    event_id: id, chain_id: "chain_synthetic_a", corp_code: "00000001", event_type: "HOLDING_REPORT_CORRECTION",
    anchor_document_id: "holding_20240101000001", event_date: "2024-01-01", known_at: "2024-01-01T00:00:00Z",
    valid_from: "2024-01-01T00:00:00Z", valid_to: null, verification_status: "VERIFIED", evidence_ids: [], ...overrides,
  };
}
function relationPayload(id, overrides = {}) {
  return {
    relation_id: id, relation_type: "AMENDS", source_document_id: "exchange_20240101000001",
    target_document_id: "exchange_20230101000001", event_id: null, evidence_id: null, verification_status: "VERIFIED",
    chain_id: "chain_synthetic_a", attributes: { corp_code: "00000001" }, ...overrides,
  };
}
function evidencePayload(id, overrides = {}) {
  return {
    evidence_id: id, document_id: "major_20240101000001", file_id: "file_synthetic_a",
    source_locator: "major_20240101000001/x.xml#node=1", quoted_text: "synthetic", quote_sha256: "a".repeat(64),
    verification_status: "VERIFIED", metadata: { corp_code: "00000001" }, ...overrides,
  };
}

function metadataFor(payload) {
  return {
    corpCode: typeof payload.corp_code === "string" ? payload.corp_code : null,
    documentId: typeof payload.document_id === "string" ? payload.document_id
      : (typeof payload.source_document_id === "string" ? payload.source_document_id
        : (typeof payload.anchor_document_id === "string" ? payload.anchor_document_id : null)),
    metricCode: typeof payload.metric_code === "string" ? payload.metric_code : null,
  };
}

// Inserts a complete, internally-consistent synthetic READY release
// directly via SQL -- satisfies every guard_release_transition/
// reject_non_loading_child_write invariant in 002_reference_release.sql
// (artifact row count == bundle_entry_count, each artifact's
// loaded_record_count == its actual DB row count, record_counts ==
// the real per-role aggregation) so the release genuinely transitions to
// READY the same way a real bundle import would, not via a shortcut that
// bypasses the DB's own consistency checks.
async function insertSyntheticReadyRelease({ client, releaseId, corpusSnapshotId, approvedRevision, factCoverageSnapshotId, roleRecords }) {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO disclosure_reference.releases
         (release_id, status, approved_revision, corpus_snapshot_id, fact_coverage_snapshot_id,
          bundle_manifest_sha256, final_manifest_sha256, final_decision_sha256, bundle_entry_count,
          record_counts, bundle_manifest, final_manifest, final_decision, imported_at)
       VALUES ($1, 'LOADING', $2, $3, $4, $5, $5, $5, $6, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL)`,
      [releaseId, approvedRevision, corpusSnapshotId, factCoverageSnapshotId, DUMMY_SHA256, Object.keys(roleRecords).length],
    );

    for (const [role, records] of Object.entries(roleRecords)) {
      await client.query(
        `INSERT INTO disclosure_reference.artifacts
           (release_id, role, bundle_path, source_path, compression, encoded_sha256, decoded_sha256,
            encoded_bytes, decoded_bytes, declared_record_count, loaded_record_count)
         VALUES ($1, $2, $3, $3, 'none', NULL, $4, NULL, 1, NULL, $5)`,
        [releaseId, role, `${role}.jsonl`, DUMMY_SHA256, records.length],
      );
      // Turn N3.1.1: batched multi-row INSERT (one round trip per role,
      // not one per record) -- the 1,001+ Fact regression fixture below
      // would otherwise need 1,000+ sequential round trips just to set up.
      const BATCH_SIZE = 200;
      for (let start = 0; start < records.length; start += BATCH_SIZE) {
        const batch = records.slice(start, start + BATCH_SIZE);
        const valueRows = [];
        const params = [];
        batch.forEach(({ recordKey, payload }, i) => {
          const meta = metadataFor(payload);
          const ordinal = start + i;
          const base = params.length;
          params.push(releaseId, role, ordinal, recordKey, meta.corpCode, meta.documentId, meta.metricCode, JSON.stringify(payload));
          valueRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NULL, $${base + 7}, $${base + 8}::jsonb)`);
        });
        await client.query(
          `INSERT INTO disclosure_reference.records
             (release_id, role, ordinal, record_key, corp_code, document_id, question_id, metric_code, payload)
           VALUES ${valueRows.join(", ")}`,
          params,
        );
      }
    }

    const recordCounts = Object.fromEntries(Object.entries(roleRecords).map(([role, records]) => [role, records.length]));
    await client.query(
      `UPDATE disclosure_reference.releases SET status = 'READY', record_counts = $2::jsonb, imported_at = now() WHERE release_id = $1`,
      [releaseId, JSON.stringify(recordCounts)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

let client;
test.before(async () => {
  client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  const existing = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'disclosure_reference'");
  if (existing.rows.length > 0) {
    throw new Error("POSTGRESQL_16_INTEGRATION_NOT_RUN: disclosure_reference schema already exists -- requires a genuinely empty scratch database.");
  }
  await applyReferenceReleaseMigration({ client, root: ROOT });
});
test.after(async () => { if (client) await client.end(); });

const RELEASE_A = Object.freeze({
  releaseId: "n31-synthetic-release-a", corpusSnapshotId: "corpus_n31_synthetic_a",
  approvedRevision: "n31-synthetic-revision-a", factCoverageSnapshotId: "fact_coverage_n31_synthetic_a",
});

test("Postgres 16 partial Coverage: 3 VERIFIED Facts loaded, only 2 authorized by Coverage -- raw Repository sees all 3, Agent view sees only the authorized 2", async () => {
  await insertSyntheticReadyRelease({
    client, ...RELEASE_A,
    roleRecords: {
      VERIFIED_FACT: [
        { recordKey: "fact_a", payload: factPayload("fact_a") },
        { recordKey: "fact_b", payload: factPayload("fact_b") },
        { recordKey: "fact_c", payload: factPayload("fact_c") },
      ],
      FACT_COVERAGE_SNAPSHOT: [
        { recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_a"]) },
        { recordKey: "slot_2", payload: slotPayload("slot_2", ["fact_b"]) },
      ],
      VERIFIED_EVENT: [{ recordKey: "event_a", payload: eventPayload("event_a") }],
      VERIFIED_RELATION: [{ recordKey: "relation_a", payload: relationPayload("relation_a") }],
      VERIFIED_EVIDENCE: [{ recordKey: "evidence_a", payload: evidencePayload("evidence_a") }],
    },
  });

  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: RELEASE_A.releaseId, expectedCorpusSnapshotId: RELEASE_A.corpusSnapshotId,
    expectedApprovedRevision: RELEASE_A.approvedRevision, expectedFactCoverageSnapshotId: RELEASE_A.factCoverageSnapshotId,
  });

  // raw Repository: audit view, all 3 VERIFIED Facts, unfiltered.
  const rawFacts = await repository.queryFacts({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  });
  assert.deepEqual(new Set(rawFacts.map((r) => r.record_id)), new Set(["fact_a", "fact_b", "fact_c"]));
  assert.notEqual(await repository.getFact("fact_c"), null, "raw Repository must still serve the unauthorized fact_c -- it is the audit surface");

  // Agent authorized view: only fact_a/fact_b.
  const view = await createCoverageAuthorizedFactView({
    client, repository, expectedFactCoverageSnapshotId: RELEASE_A.factCoverageSnapshotId,
  });
  assert.equal(view.authorizedFactCount(), 2);
  assert.notEqual(await view.getFact("fact_a"), null);
  assert.notEqual(await view.getFact("fact_b"), null);
  assert.equal(await view.getFact("fact_c"), null, "fact_c is VERIFIED but not Coverage-authorized -- must be NOT_FOUND (null) through the Agent view");

  const authorizedFacts = await view.queryFacts({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  });
  assert.deepEqual(new Set(authorizedFacts.map((r) => r.record_id)), new Set(["fact_a", "fact_b"]));

  // limit=1 applied AFTER authorization -- must return exactly 1 authorized
  // record, never a truncated-then-filtered-to-zero result.
  const limited = await view.queryFacts({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1,
  });
  assert.equal(limited.length, 1);
  assert.ok(["fact_a", "fact_b"].includes(limited[0].record_id));

  // Event/Relation/Evidence are completely unaffected by Fact Coverage authorization.
  const events = await repository.queryEvents({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  });
  assert.equal(events.length, 1);
  const relations = await repository.queryRelations({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  });
  assert.equal(relations.length, 1);
  const evidenceRecords = await repository.queryEvidence({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1000,
  });
  assert.equal(evidenceRecords.length, 1);

  // Composite query() through the coverage-authorized structured adapter:
  // FACT filtered, EVENT/RELATION/EVIDENCE untouched.
  const structuredAdapter = createCoverageAuthorizedPostgresStructuredStoreAdapter({ authorizedFactView: view, repository });
  const combined = await structuredAdapter.query({
    schema_version: "0.2.0", query_id: "n31_q1", execution_scope: "OFFICIAL", corpus_snapshot_id: RELEASE_A.corpusSnapshotId,
    fact_coverage_snapshot_id: RELEASE_A.factCoverageSnapshotId, targets: ["FACT", "EVENT", "RELATION", "EVIDENCE"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [], verification_statuses: ["VERIFIED"],
    as_of_date: "9999-12-31", limit: 1000,
  });
  const combinedIds = new Set(combined.records.map((r) => r.record_id));
  assert.ok(combinedIds.has("fact_a") && combinedIds.has("fact_b"));
  assert.ok(!combinedIds.has("fact_c"), "fact_c must be removed from the combined multi-target result");
  assert.ok(combinedIds.has("event_a") && combinedIds.has("relation_a") && combinedIds.has("evidence_a"));

  // FactStore envelope adapter.
  const factStoreAdapter = createCoverageAuthorizedPostgresFactStoreAdapter(view);
  assert.notEqual(await factStoreAdapter.getFact("fact_a"), null);
  assert.equal(await factStoreAdapter.getFact("fact_c"), null);
});

test("Postgres 16: a Coverage slot referencing an unknown fact_id makes Agent view construction fail closed, against a real second synthetic release", async () => {
  const release = Object.freeze({
    releaseId: "n31-synthetic-release-bad-coverage", corpusSnapshotId: "corpus_n31_synthetic_bad",
    approvedRevision: "n31-synthetic-revision-bad", factCoverageSnapshotId: "fact_coverage_n31_synthetic_bad",
  });
  await insertSyntheticReadyRelease({
    client, ...release,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_x", payload: factPayload("fact_x") }],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_x", "fact_ghost"]) }],
    },
  });
  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: release.releaseId, expectedCorpusSnapshotId: release.corpusSnapshotId,
    expectedApprovedRevision: release.approvedRevision, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId }),
    /references fact_id "fact_ghost"/,
  );
});

test("Postgres 16: Coverage authorization from a DIFFERENT release never leaks into or is confused with another release's own Fact -- even for the SAME fact_id string", async () => {
  // Release B reuses the literal id "fact_a" (same string RELEASE_A used
  // above) but never authorizes it -- proving isolation is by real
  // release_id scoping, not by accidental non-collision of test ids.
  const releaseB = Object.freeze({
    releaseId: "n31-synthetic-release-b", corpusSnapshotId: "corpus_n31_synthetic_b",
    approvedRevision: "n31-synthetic-revision-b", factCoverageSnapshotId: "fact_coverage_n31_synthetic_b",
  });
  await insertSyntheticReadyRelease({
    client, ...releaseB,
    roleRecords: {
      VERIFIED_FACT: [
        { recordKey: "fact_a", payload: factPayload("fact_a", { normalized_value: 999 }) },
        { recordKey: "fact_x", payload: factPayload("fact_x") },
      ],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_x"]) }],
    },
  });
  const repositoryB = await createPostgresReferenceRepository({
    client, expectedReleaseId: releaseB.releaseId, expectedCorpusSnapshotId: releaseB.corpusSnapshotId,
    expectedApprovedRevision: releaseB.approvedRevision, expectedFactCoverageSnapshotId: releaseB.factCoverageSnapshotId,
  });
  const viewB = await createCoverageAuthorizedFactView({ client, repository: repositoryB, expectedFactCoverageSnapshotId: releaseB.factCoverageSnapshotId });
  assert.equal(await viewB.getFact("fact_a"), null, "release B never authorized its own fact_a");

  // Release A (from the first test in this file) still authorizes ITS OWN
  // fact_a, completely unaffected by release B's non-authorization of the
  // same id string.
  const repositoryA = await createPostgresReferenceRepository({
    client, expectedReleaseId: RELEASE_A.releaseId, expectedCorpusSnapshotId: RELEASE_A.corpusSnapshotId,
    expectedApprovedRevision: RELEASE_A.approvedRevision, expectedFactCoverageSnapshotId: RELEASE_A.factCoverageSnapshotId,
  });
  const viewA = await createCoverageAuthorizedFactView({ client, repository: repositoryA, expectedFactCoverageSnapshotId: RELEASE_A.factCoverageSnapshotId });
  const stillAuthorized = await viewA.getFact("fact_a");
  assert.notEqual(stillAuthorized, null);
  assert.equal(stillAuthorized.normalized_value, 100, "release A's own fact_a payload, not release B's differently-valued fact_a");
});

test("Postgres 16: passing a mismatched expectedFactCoverageSnapshotId against a real, valid release is rejected", async () => {
  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: RELEASE_A.releaseId, expectedCorpusSnapshotId: RELEASE_A.corpusSnapshotId,
    expectedApprovedRevision: RELEASE_A.approvedRevision, expectedFactCoverageSnapshotId: RELEASE_A.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: "definitely-wrong" }),
    /fact_coverage_snapshot_id mismatch/,
  );
});

// -- Turn N3.1.1 A: the specific real-PostgreSQL regression this Turn
// exists to fix -- with 1,001+ real VERIFIED_FACT rows, the sole
// authorized Fact ranked dead last by known_at must still be found. Under
// the old implementation (raw Repository fetched with a hardcoded
// limit=1000 BEFORE authorization filtering), this Fact would never even
// have been fetched once the total real Fact count exceeded 1000. -------

test("Postgres 16 Turn N3.1.1 regression: with 1,001 real VERIFIED_FACT rows loaded, the single Coverage-authorized Fact -- ranked dead LAST by known_at -- is still found by getFact and queryFacts", async () => {
  const release = Object.freeze({
    releaseId: "n31-synthetic-release-scale", corpusSnapshotId: "corpus_n31_synthetic_scale",
    approvedRevision: "n31-synthetic-revision-scale", factCoverageSnapshotId: "fact_coverage_n31_synthetic_scale",
  });
  const TOTAL = 1001;
  const AUTHORIZED_INDEX = TOTAL - 1; // last by ordinal AND (via known_at below) last by sort order
  const facts = [];
  for (let i = 0; i < TOTAL; i += 1) {
    // known_at strictly DESCENDING as i increases -- index 0 sorts first,
    // the highest index sorts dead last. The authorized Fact sits at the
    // very end of the real Repository's own known_at-desc sort order.
    const knownAt = new Date(Date.UTC(2024, 0, 1) + (TOTAL - i) * 24 * 60 * 60 * 1000).toISOString();
    facts.push({ recordKey: `fact_scale_${i}`, payload: factPayload(`fact_scale_${i}`, { known_at: knownAt }) });
  }
  const authorizedFactId = `fact_scale_${AUTHORIZED_INDEX}`;

  await insertSyntheticReadyRelease({
    client, ...release,
    roleRecords: {
      VERIFIED_FACT: facts,
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", [authorizedFactId]) }],
    },
  });

  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: release.releaseId, expectedCorpusSnapshotId: release.corpusSnapshotId,
    expectedApprovedRevision: release.approvedRevision, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId,
  });
  const view = await createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId });
  assert.equal(view.authorizedFactCount(), 1);

  assert.notEqual(await view.getFact(authorizedFactId), null, "the sole authorized Fact, ranked dead last among 1,001 real rows, must still resolve");

  const result = await view.queryFacts({
    corp_codes: [], metric_codes: [], event_types: [], relation_types: [], document_ids: [], evidence_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [], verification_statuses: ["VERIFIED"], as_of_date: "9999-12-31", limit: 1,
  });
  assert.deepEqual(result.map((r) => r.record_id), [authorizedFactId]);
});

// -- Turn N3.1.1 B: direct-dimension consistency, against a real server. -

test("Postgres 16 Turn N3.1.1: a real slot whose corp_code disagrees with the Fact it authorizes is rejected at construction", async () => {
  const release = Object.freeze({
    releaseId: "n31-synthetic-release-dim-corp", corpusSnapshotId: "corpus_n31_synthetic_dim_corp",
    approvedRevision: "n31-synthetic-revision-dim-corp", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_corp",
  });
  await insertSyntheticReadyRelease({
    client, ...release,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { corp_code: "00000001" }) }],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { corp_code: "00000009" }) }],
    },
  });
  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: release.releaseId, expectedCorpusSnapshotId: release.corpusSnapshotId,
    expectedApprovedRevision: release.approvedRevision, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId }),
    /corp_code "00000009" does not match fact_id "fact_dim" corp_code "00000001"/,
  );
});

test("Postgres 16 Turn N3.1.1: a real slot whose metric_code disagrees with the Fact it authorizes is rejected at construction", async () => {
  const release = Object.freeze({
    releaseId: "n31-synthetic-release-dim-metric", corpusSnapshotId: "corpus_n31_synthetic_dim_metric",
    approvedRevision: "n31-synthetic-revision-dim-metric", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_metric",
  });
  await insertSyntheticReadyRelease({
    client, ...release,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { metric_code: "CONTRACT_AMOUNT" }) }],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { metric_code: "INVESTMENT_AMOUNT" }) }],
    },
  });
  const repository = await createPostgresReferenceRepository({
    client, expectedReleaseId: release.releaseId, expectedCorpusSnapshotId: release.corpusSnapshotId,
    expectedApprovedRevision: release.approvedRevision, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository, expectedFactCoverageSnapshotId: release.factCoverageSnapshotId }),
    /metric_code "INVESTMENT_AMOUNT" does not match fact_id "fact_dim" metric_code "CONTRACT_AMOUNT"/,
  );
});

test("Postgres 16 Turn N3.1.1: a real slot whose NON-NULL scope disagrees with the Fact it authorizes is rejected; a null scope is accepted regardless of the Fact's own scope", async () => {
  const mismatchRelease = Object.freeze({
    releaseId: "n31-synthetic-release-dim-scope-bad", corpusSnapshotId: "corpus_n31_synthetic_dim_scope_bad",
    approvedRevision: "n31-synthetic-revision-dim-scope-bad", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_scope_bad",
  });
  await insertSyntheticReadyRelease({
    client, ...mismatchRelease,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { scope: "COMPANY" }) }],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { scope: "CONSOLIDATED" }) }],
    },
  });
  const mismatchRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: mismatchRelease.releaseId, expectedCorpusSnapshotId: mismatchRelease.corpusSnapshotId,
    expectedApprovedRevision: mismatchRelease.approvedRevision, expectedFactCoverageSnapshotId: mismatchRelease.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository: mismatchRepository, expectedFactCoverageSnapshotId: mismatchRelease.factCoverageSnapshotId }),
    /scope "CONSOLIDATED" does not match fact_id "fact_dim" scope "COMPANY"/,
  );

  const nullScopeRelease = Object.freeze({
    releaseId: "n31-synthetic-release-dim-scope-null", corpusSnapshotId: "corpus_n31_synthetic_dim_scope_null",
    approvedRevision: "n31-synthetic-revision-dim-scope-null", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_scope_null",
  });
  await insertSyntheticReadyRelease({
    client, ...nullScopeRelease,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { scope: "COMPANY" }) }],
      FACT_COVERAGE_SNAPSHOT: [{ recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { scope: null }) }],
    },
  });
  const nullScopeRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: nullScopeRelease.releaseId, expectedCorpusSnapshotId: nullScopeRelease.corpusSnapshotId,
    expectedApprovedRevision: nullScopeRelease.approvedRevision, expectedFactCoverageSnapshotId: nullScopeRelease.factCoverageSnapshotId,
  });
  const nullScopeView = await createCoverageAuthorizedFactView({
    client, repository: nullScopeRepository, expectedFactCoverageSnapshotId: nullScopeRelease.factCoverageSnapshotId,
  });
  assert.notEqual(await nullScopeView.getFact("fact_dim"), null);
});

test("Postgres 16 Turn N3.1.1: the SAME fact_id referenced by two real slots is allowed when both match dimensions, rejected when only one does", async () => {
  const okRelease = Object.freeze({
    releaseId: "n31-synthetic-release-dim-reuse-ok", corpusSnapshotId: "corpus_n31_synthetic_dim_reuse_ok",
    approvedRevision: "n31-synthetic-revision-dim-reuse-ok", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_reuse_ok",
  });
  await insertSyntheticReadyRelease({
    client, ...okRelease,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }) }],
      FACT_COVERAGE_SNAPSHOT: [
        { recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }) },
        { recordKey: "slot_2", payload: slotPayload("slot_2", ["fact_dim"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: null }) },
      ],
    },
  });
  const okRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: okRelease.releaseId, expectedCorpusSnapshotId: okRelease.corpusSnapshotId,
    expectedApprovedRevision: okRelease.approvedRevision, expectedFactCoverageSnapshotId: okRelease.factCoverageSnapshotId,
  });
  const okView = await createCoverageAuthorizedFactView({ client, repository: okRepository, expectedFactCoverageSnapshotId: okRelease.factCoverageSnapshotId });
  assert.equal(okView.authorizedFactCount(), 1);
  assert.notEqual(await okView.getFact("fact_dim"), null);

  const badRelease = Object.freeze({
    releaseId: "n31-synthetic-release-dim-reuse-bad", corpusSnapshotId: "corpus_n31_synthetic_dim_reuse_bad",
    approvedRevision: "n31-synthetic-revision-dim-reuse-bad", factCoverageSnapshotId: "fact_coverage_n31_synthetic_dim_reuse_bad",
  });
  await insertSyntheticReadyRelease({
    client, ...badRelease,
    roleRecords: {
      VERIFIED_FACT: [{ recordKey: "fact_dim", payload: factPayload("fact_dim", { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }) }],
      FACT_COVERAGE_SNAPSHOT: [
        { recordKey: "slot_1", payload: slotPayload("slot_1", ["fact_dim"], { corp_code: "00000001", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }) },
        { recordKey: "slot_2", payload: slotPayload("slot_2", ["fact_dim"], { corp_code: "99999999", metric_code: "CONTRACT_AMOUNT", scope: "COMPANY" }) },
      ],
    },
  });
  const badRepository = await createPostgresReferenceRepository({
    client, expectedReleaseId: badRelease.releaseId, expectedCorpusSnapshotId: badRelease.corpusSnapshotId,
    expectedApprovedRevision: badRelease.approvedRevision, expectedFactCoverageSnapshotId: badRelease.factCoverageSnapshotId,
  });
  await assert.rejects(
    createCoverageAuthorizedFactView({ client, repository: badRepository, expectedFactCoverageSnapshotId: badRelease.factCoverageSnapshotId }),
    CoverageAuthorizationIntegrityError,
  );
});
