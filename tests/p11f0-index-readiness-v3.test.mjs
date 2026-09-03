// Turn AC-FULL-LOAD-V3 Section K: scoped, offline tests for this Turn's
// two real code changes -- (1) createOrGetAttempt's supersede-validation
// widened to accept INVALID_DISCOVERY_CANONICAL_SCOPE alongside
// SUPERSEDED_ZERO_PROGRESS, and (2) fixed-kure-bm25-index.mjs's
// persist/load switched from one-shot JSON.stringify (which this Turn's
// own full-442,549-chunk build reproduced as a real "Invalid string
// length" crash) to bounded newline-delimited streaming. No real DB, no
// real KURE server, no Gold, no HCX.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFixedKureLoadSessionRepository,
  FixedKureLoadSessionError,
} from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";
import {
  persistFixedKureBm25Index,
  loadFixedKureBm25Index,
  bm25CachePath,
} from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { buildBm25Index } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";

// ---- fake pg client: getSession() backed by an in-memory row map,
// transitionStatus()/createOrGetAttempt() driven by the SAME code paths
// the real repository uses (parameterized SQL against this fake), so the
// tests exercise the actual guard logic, not a re-implementation of it.
function fakeSessionClient(initialRows) {
  const rows = new Map(initialRows.map((r) => [r.load_session_id, { ...r }]));
  return {
    rows,
    async query(sql, params) {
      const s = sql.trim();
      if (s.startsWith("SELECT") && s.includes("WHERE load_session_id = $1") && !s.includes("UPDATE")) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (s.startsWith("INSERT INTO")) {
        const [
          loadSessionId, retrievalIndexId, releaseId, corpusSnapshotId, corpusManifestSha256,
          chunkingPolicyId, chunkingPolicySha256, embeddingConfigSha256, embeddingProvider, embeddingModel,
          embeddingRevision, embeddingDimension, distanceMetric, batchSize, discoveryBatchSize,
          maxRetryAttempts, leaseDurationMs, codeRevision,
          logicalLoadId, executionAttemptId, loaderContractVersion, supersedesLoadSessionId,
        ] = params;
        const row = {
          load_session_id: loadSessionId, retrieval_index_id: retrievalIndexId, release_id: releaseId,
          corpus_snapshot_id: corpusSnapshotId, corpus_manifest_sha256: corpusManifestSha256,
          chunking_policy_id: chunkingPolicyId, chunking_policy_sha256: chunkingPolicySha256,
          embedding_config_sha256: embeddingConfigSha256, embedding_provider: embeddingProvider,
          embedding_model: embeddingModel, embedding_revision: embeddingRevision,
          embedding_dimension: embeddingDimension, distance_metric: distanceMetric,
          batch_size: batchSize, discovery_batch_size: discoveryBatchSize, max_retry_attempts: maxRetryAttempts,
          lease_duration_ms: leaseDurationMs, code_revision: codeRevision, status: "CREATED",
          logical_load_id: logicalLoadId, execution_attempt_id: executionAttemptId,
          loader_contract_version: loaderContractVersion, supersedes_load_session_id: supersedesLoadSessionId,
          discovered_document_count: 0, discovered_total_chunk_count: 0, discovered_search_eligible_count: 0,
          discovered_unique_text_count: 0, embedded_unique_text_count: 0, materialized_chunk_count: 0,
          expected_document_count: null, expected_total_chunk_count: null, expected_search_eligible_count: null,
          expected_unique_embeddable_count: null, last_error_code: null, terminal_diagnostics: null,
          created_at: new Date(), updated_at: new Date(),
        };
        rows.set(loadSessionId, row);
        return { rows: [] };
      }
      if (s.startsWith("UPDATE")) {
        const loadSessionId = params[0];
        const fromStatuses = params[1];
        const toStatus = params[2];
        const row = rows.get(loadSessionId);
        if (!row || !fromStatuses.includes(row.status)) return { rows: [] };
        row.status = toStatus;
        rows.set(loadSessionId, row);
        return { rows: [row] };
      }
      throw new Error(`fakeSessionClient: unhandled SQL: ${s.slice(0, 80)}`);
    },
  };
}

const BASE_PINS = {
  releaseId: "seed-release-v0.20", corpusSnapshotId: "corpus_test",
  corpusManifestSha256: "a".repeat(64), embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
  embeddingRevision: "rev1", embeddingDimension: 1024, distanceMetric: "cosine",
  chunkingPolicyId: "fixed-token-512-o64.v0.1.0", chunkingPolicySha256: "b".repeat(64),
  batchSize: 8, discoveryBatchSize: 10, maxRetryAttempts: 3, leaseDurationMs: 120000,
  loaderContractVersion: "fixed-kure-spool-loader-contract-v1.0",
};

test("createOrGetAttempt: supersedesLoadSessionId accepts INVALID_DISCOVERY_CANONICAL_SCOPE", async () => {
  const { computeFixedKureLogicalLoadId } = await import("../domain/postgres/reference-fixed-kure-load-session-repository.mjs");
  const invalidRow = { load_session_id: "old_attempt", status: "INVALID_DISCOVERY_CANONICAL_SCOPE", logical_load_id: computeFixedKureLogicalLoadId(BASE_PINS) };
  const client = fakeSessionClient([invalidRow]);
  const repo = createFixedKureLoadSessionRepository({ client });
  const { session, created } = await repo.createOrGetAttempt({
    ...BASE_PINS, codeRevision: "new_code_rev", supersedesLoadSessionId: "old_attempt",
  });
  assert.equal(created, true);
  assert.equal(session.supersedes_load_session_id, "old_attempt");
  assert.notEqual(session.execution_attempt_id, "old_attempt");
});

test("createOrGetAttempt: still accepts SUPERSEDED_ZERO_PROGRESS (unchanged legacy path)", async () => {
  const { computeFixedKureLogicalLoadId } = await import("../domain/postgres/reference-fixed-kure-load-session-repository.mjs");
  const zeroProgressRow = { load_session_id: "zp_attempt", status: "SUPERSEDED_ZERO_PROGRESS", logical_load_id: computeFixedKureLogicalLoadId(BASE_PINS) };
  const client = fakeSessionClient([zeroProgressRow]);
  const repo = createFixedKureLoadSessionRepository({ client });
  const { created } = await repo.createOrGetAttempt({
    ...BASE_PINS, codeRevision: "new_code_rev_2", supersedesLoadSessionId: "zp_attempt",
  });
  assert.equal(created, true);
});

test("createOrGetAttempt: rejects supersedesLoadSessionId pointing at a non-supersedable status (e.g. DISCOVERY_COMPLETE)", async () => {
  const { computeFixedKureLogicalLoadId } = await import("../domain/postgres/reference-fixed-kure-load-session-repository.mjs");
  const activeRow = { load_session_id: "active_attempt", status: "DISCOVERY_COMPLETE", logical_load_id: computeFixedKureLogicalLoadId(BASE_PINS) };
  const client = fakeSessionClient([activeRow]);
  const repo = createFixedKureLoadSessionRepository({ client });
  await assert.rejects(
    () => repo.createOrGetAttempt({ ...BASE_PINS, codeRevision: "x", supersedesLoadSessionId: "active_attempt" }),
    (error) => {
      assert.ok(error instanceof FixedKureLoadSessionError);
      assert.equal(error.code, "SUPERSEDED_SESSION_NOT_ACTUALLY_SUPERSEDED");
      return true;
    },
  );
});

test("createOrGetAttempt: rejects supersedesLoadSessionId with a mismatched logical_load_id even if status is supersedable", async () => {
  const invalidRow = { load_session_id: "other_load_attempt", status: "INVALID_DISCOVERY_CANONICAL_SCOPE", logical_load_id: "totally_different_logical_load" };
  const client = fakeSessionClient([invalidRow]);
  const repo = createFixedKureLoadSessionRepository({ client });
  await assert.rejects(
    () => repo.createOrGetAttempt({ ...BASE_PINS, codeRevision: "x", supersedesLoadSessionId: "other_load_attempt" }),
    (error) => {
      assert.ok(error instanceof FixedKureLoadSessionError);
      assert.equal(error.code, "SUPERSEDED_SESSION_LOGICAL_LOAD_MISMATCH");
      return true;
    },
  );
});

test("createOrGetAttempt: rejects a non-existent supersedesLoadSessionId", async () => {
  const client = fakeSessionClient([]);
  const repo = createFixedKureLoadSessionRepository({ client });
  await assert.rejects(
    () => repo.createOrGetAttempt({ ...BASE_PINS, codeRevision: "x", supersedesLoadSessionId: "no_such_attempt" }),
    (error) => {
      assert.ok(error instanceof FixedKureLoadSessionError);
      assert.equal(error.code, "SUPERSEDED_SESSION_NOT_FOUND");
      return true;
    },
  );
});

// ---- BM25 index persistence: streaming round-trip.
let tmpDir;
test.beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "p11f0-bm25-persist-test-"));
});
test.afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("persistFixedKureBm25Index/loadFixedKureBm25Index: small round-trip preserves search behavior", async () => {
  const docs = [
    { id: "chunk_a", text: "삼성전자 반도체 매출 증가" },
    { id: "chunk_b", text: "SK하이닉스 메모리 반도체 실적" },
    { id: "chunk_c", text: "현대자동차 전기차 판매" },
  ];
  const index = buildBm25Index(docs);
  const persisted = await persistFixedKureBm25Index(tmpDir, "sess1", index);
  assert.equal(persisted.documentCount, 3);
  assert.ok(persisted.sha256.match(/^[0-9a-f]{64}$/));
  const reloaded = await loadFixedKureBm25Index(tmpDir, "sess1");
  assert.equal(reloaded.documentCount, index.documentCount);
  assert.equal(reloaded.averageDocLength, index.averageDocLength);
  assert.deepEqual(reloaded.orderedIds, index.orderedIds);
  assert.deepEqual([...reloaded.idf.entries()].sort(), [...index.idf.entries()].sort());
  assert.deepEqual([...reloaded.docTokens.entries()].sort(), [...index.docTokens.entries()].sort());
});

test("persistFixedKureBm25Index: uses the v2 .ndjson cache path (not the old single-JSON v1 path)", async () => {
  const cachePath = bm25CachePath(tmpDir, "sess_x");
  assert.ok(cachePath.endsWith(".bm25-index.v2.ndjson"));
  assert.ok(!cachePath.includes(".v1.json"));
});

test("persistFixedKureBm25Index: two builds of identical input produce byte-identical persisted output (determinism)", async () => {
  const docs = [
    { id: "chunk_1", text: "공시 정정 사유" },
    { id: "chunk_2", text: "분기 보고서 매출액" },
  ];
  const p1 = await persistFixedKureBm25Index(tmpDir, "det1", buildBm25Index(docs));
  const p2 = await persistFixedKureBm25Index(tmpDir, "det2", buildBm25Index(docs));
  assert.equal(p1.sha256, p2.sha256);
  assert.equal(p1.bytes, p2.bytes);
});

test("persistFixedKureBm25Index: a large synthetic index (many documents, long token lists) round-trips without building one oversized JSON string", async () => {
  // Not the real 442,549-chunk scale (too slow for a unit test), but large
  // enough (20,000 docs x ~150 tokens) to exercise the SAME streaming code
  // path (many docTokens entries) that the real corpus hit -- this is a
  // regression test for the exact "Invalid string length" crash this
  // Turn's own Section G run reproduced against fixed-kure-bm25-index.mjs's
  // PRE-fix single JSON.stringify(...) implementation.
  const docs = [];
  for (let i = 0; i < 20000; i += 1) {
    const words = [];
    for (let j = 0; j < 150; j += 1) words.push(`토큰${(i * 150 + j) % 5000}`);
    docs.push({ id: `chunk_synthetic_${String(i).padStart(6, "0")}`, text: words.join(" ") });
  }
  const index = buildBm25Index(docs);
  const persisted = await persistFixedKureBm25Index(tmpDir, "large_sess", index);
  assert.equal(persisted.documentCount, 20000);
  const reloaded = await loadFixedKureBm25Index(tmpDir, "large_sess");
  assert.equal(reloaded.documentCount, 20000);
  assert.equal(reloaded.docTokens.size, 20000);
  assert.equal(reloaded.orderedIds.length, 20000);
});

test("loadFixedKureBm25Index: throws a clear error for a missing cache file (no silent empty index)", async () => {
  await assert.rejects(() => loadFixedKureBm25Index(tmpDir, "does_not_exist"));
});
