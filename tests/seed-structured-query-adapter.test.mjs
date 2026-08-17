import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSeedStructuredQueryAdapter } from "../domain/adapters/seed-structured-query-adapter.mjs";
import { RequestAbortedError } from "../domain/runtime/abortable.mjs";
import { createStructuredStore } from "../domain/runtime/structured-store.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MANIFEST_PATH = path.join(ROOT, "work/domain-seed/seed-structured-artifacts.v0.1.manifest.json");
const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_snapshot_8102664d6ead285485104d8f";

let adapter;
test.before(async () => {
  adapter = await createSeedStructuredQueryAdapter({ manifestPath: MANIFEST_PATH, root: ROOT });
});

function officialQuery(overrides = {}) {
  const predicates = {
    metric_codes: [], event_types: [], relation_types: [], document_ids: [],
    fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [],
    ...(overrides.predicates ?? {}),
  };
  return {
    schema_version: "0.2.0",
    query_id: "query_seed_adapter",
    execution_scope: "OFFICIAL",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    targets: ["FACT"],
    corp_codes: [],
    predicates,
    period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [],
    verification_statuses: ["VERIFIED"],
    as_of_date: "2026-08-13",
    limit: 1000,
    ...overrides,
    predicates,
  };
}

test("constructs the pinned real Seed artifact set and exposes exact counts", () => {
  assert.deepEqual(adapter.recordCounts(), { FACT: 54, EVENT: 24, RELATION: 40, EVIDENCE: 160 });
  assert.ok(Object.isFrozen(adapter.recordCounts()));
});

test("an exact Fact query returns only the requested VERIFIED Fact", async () => {
  const result = await adapter.query(officialQuery({
    predicates: { fact_ids: ["fact_3119bfad2317adbd818a3b6a"] },
  }));
  assert.equal(result.status, "OK");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record_type, "FACT");
  assert.equal(result.records[0].payload.metric_code, "CONTRACT_AMOUNT");
  assert.equal(result.records[0].verification_status, "VERIFIED");
});

test("Event, Relation, and Evidence IDs are independently queryable", async () => {
  const cases = [
    ["EVENT", "event_5e6374560eef57ddaa7f1a3d", "event_ids"],
    ["RELATION", "relation_017a8b70a5153d23a0c6337e", "relation_ids"],
    ["EVIDENCE", "evidence_05dabd799b44945b5d8d0f61", "evidence_ids"],
  ];
  for (const [target, id, predicate] of cases) {
    const result = await adapter.query(officialQuery({ targets: [target], predicates: { [predicate]: [id] } }));
    assert.equal(result.status, "OK", target);
    assert.deepEqual(result.records.map((record) => record.record_id), [id], target);
  }
});

test("corp, metric, document, period, and scope filters all narrow the real data", async () => {
  const matching = await adapter.query(officialQuery({
    corp_codes: ["00164645"],
    predicates: {
      metric_codes: ["CONTRACT_AMOUNT"],
      document_ids: ["exchange_20230428800439"],
    },
    period_filter: { start: "2023-01-01", end: "2033-01-01", period_types: ["EVENT_PERIOD"] },
    scope_filter: ["COMPANY"],
  }));
  assert.equal(matching.status, "OK");
  assert.ok(matching.records.length >= 1);
  assert.ok(matching.records.every((record) => record.payload.corp_code === "00164645"));

  const wrongScope = await adapter.query(officialQuery({
    predicates: { fact_ids: ["fact_3119bfad2317adbd818a3b6a"] },
    scope_filter: ["CONSOLIDATED"],
  }));
  assert.equal(wrongScope.status, "NOT_FOUND");
});

test("as_of_date prevents future knowledge from leaking", async () => {
  const result = await adapter.query(officialQuery({ as_of_date: "2022-01-01" }));
  assert.equal(result.status, "NOT_FOUND");
  assert.deepEqual(result.records, []);
});

test("limit and deterministic ordering are enforced", async () => {
  const query = officialQuery({ targets: ["FACT", "EVENT", "RELATION", "EVIDENCE"], limit: 5 });
  const first = await adapter.query(query);
  const second = await adapter.query(query);
  assert.equal(first.records.length, 5);
  assert.deepEqual(first.records.map((record) => record.record_id), second.records.map((record) => record.record_id));
});

test("returned result and nested payloads are deeply immutable", async () => {
  const result = await adapter.query(officialQuery({
    predicates: { fact_ids: ["fact_3119bfad2317adbd818a3b6a"] },
  }));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.records));
  assert.ok(Object.isFrozen(result.records[0].payload));
  assert.throws(() => { result.records[0].payload.metric_code = "FORGED"; }, TypeError);
});

test("an already-aborted request is rejected before returning data", async () => {
  const controller = new AbortController();
  controller.abort("test abort");
  await assert.rejects(
    adapter.query(officialQuery(), { signal: controller.signal }),
    (error) => error instanceof RequestAbortedError,
  );
});

test("the real adapter passes the existing StructuredStore boundary and result schema", async () => {
  const store = createStructuredStore(adapter, {
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
  });
  const result = await store.query(officialQuery({
    predicates: { fact_ids: ["fact_3119bfad2317adbd818a3b6a"] },
  }));
  assert.equal(result.status, "OK");
  assert.deepEqual(result.applied_verification_statuses, ["VERIFIED"]);
  assert.equal(result.records[0].record_id, "fact_3119bfad2317adbd818a3b6a");
  assert.equal(result.error_codes.length, 0);
});

test("StructuredStore rejects a request pinned to a different snapshot before querying", async () => {
  let calls = 0;
  const countingAdapter = { query: async (...args) => { calls += 1; return adapter.query(...args); } };
  const store = createStructuredStore(countingAdapter, {
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
  });
  const result = await store.query(officialQuery({ corpus_snapshot_id: "corpus_wrong" }));
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
  assert.equal(calls, 0);
});

test("construction fails closed when a required manifest role is missing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-structured-missing-role-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  manifest.artifacts = manifest.artifacts.filter((item) => item.role !== "VERIFIED_RELATION");
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    createSeedStructuredQueryAdapter({ manifestPath, root: ROOT }),
    /missing role VERIFIED_RELATION/,
  );
});

test("construction also pins the Evidence manifest and Owner decision audit artifacts", async (t) => {
  for (const missingRole of ["VERIFIED_EVIDENCE_MANIFEST", "OWNER_DECISION"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "seed-structured-missing-audit-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    manifest.artifacts = manifest.artifacts.filter((item) => item.role !== missingRole);
    const manifestPath = path.join(directory, `${missingRole}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      createSeedStructuredQueryAdapter({ manifestPath, root: ROOT }),
      new RegExp(`missing role ${missingRole}`),
    );
  }
});

test("construction fails closed on an artifact hash mismatch", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seed-structured-bad-hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  manifest.artifacts.find((item) => item.role === "VERIFIED_FACT").sha256 = "0".repeat(64);
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    createSeedStructuredQueryAdapter({ manifestPath, root: ROOT }),
    /pin mismatch/,
  );
});
