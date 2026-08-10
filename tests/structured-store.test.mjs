import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  createBudgetedStructuredStore,
  createStructuredStore,
  validateStructuredQuery,
} from "../domain/runtime/structured-store.mjs";
import { BudgetExceededError, createExecutionBudget } from "../domain/runtime/agent-runtime.mjs";

const resultSchema = JSON.parse(
  readFileSync(new URL("../domain/interfaces/structured-result.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateResultSchema = ajv.compile(resultSchema);

// Every StructuredResult this module produces, on every code path, must
// conform to its own published schema — an ERROR response is still a
// contractual response, not an escape hatch.
function assertValidResult(result) {
  const valid = validateResultSchema(result);
  assert.ok(valid, JSON.stringify(validateResultSchema.errors ?? [], null, 2));
  return result;
}

const CORPUS_SNAPSHOT_ID = "corpus_04750795e1a2d5c3";
const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_example_v1";

// The SharedContext this "request" is pinned to. A query must target
// exactly this, independent of whatever an adapter might later echo.
const RUN_CONTEXT = Object.freeze({
  corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
  fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
});

function store(adapter = null, context = RUN_CONTEXT) {
  return createStructuredStore(adapter, context);
}

function officialQuery(overrides = {}) {
  return {
    schema_version: "0.2.0",
    query_id: "query_test_1",
    execution_scope: "OFFICIAL",
    corpus_snapshot_id: CORPUS_SNAPSHOT_ID,
    fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID,
    targets: ["FACT"],
    corp_codes: ["00126362"],
    predicates: {
      metric_codes: ["CONTRACT_AMOUNT"],
      event_types: [],
      relation_types: [],
      document_ids: [],
      fact_ids: [],
      event_ids: [],
      relation_ids: [],
      evidence_ids: [],
    },
    period_filter: { start: null, end: "2025-03-14", period_types: ["EVENT_PERIOD"] },
    scope_filter: ["COMPANY"],
    verification_statuses: ["VERIFIED"],
    as_of_date: "2025-03-14",
    limit: 20,
    ...overrides,
  };
}

function verifiedRecord(overrides = {}) {
  return {
    record_type: "FACT",
    record_id: "fact_0123456789abcdef01234567",
    verification_status: "VERIFIED",
    known_at: "2025-03-14T00:00:00Z",
    source_document_ids: ["exchange_20250314800002"],
    evidence_ids: ["evidence_0123456789abcdef01234567"],
    payload: { metric_code: "CONTRACT_AMOUNT", normalized_value: 1_000_000_000, unit: "KRW", scope: "COMPANY" },
    ...overrides,
  };
}

// An adapter that faithfully echoes the query's snapshot ids, as a correct
// adapter must.
function adapterReturning(response) {
  return {
    query: async (query) => ({
      corpus_snapshot_id: query.corpus_snapshot_id,
      fact_coverage_snapshot_id: query.fact_coverage_snapshot_id,
      status: "OK",
      error_codes: [],
      records: [],
      ...response,
    }),
  };
}

// --- shape validation, backed by the real JSON Schema ----------------------

test("validateStructuredQuery rejects a query missing required fields", () => {
  const errors = validateStructuredQuery({ execution_scope: "OFFICIAL" });
  assert.ok(errors.length > 0);
});

test("validateStructuredQuery rejects a query missing only query_id", () => {
  const query = officialQuery();
  delete query.query_id;
  assert.ok(validateStructuredQuery(query).length > 0);
});

test("validateStructuredQuery rejects a query missing nested predicates fields", () => {
  const query = officialQuery();
  delete query.predicates.fact_ids;
  assert.ok(validateStructuredQuery(query).length > 0);
});

test("validateStructuredQuery accepts a well-formed OFFICIAL/VERIFIED query", () => {
  assert.deepEqual(validateStructuredQuery(officialQuery()), []);
});

// --- fail-closed default (no adapter wired) ---------------------------

test("with no adapter, a well-formed OFFICIAL query returns a schema-valid STORE_UNAVAILABLE, not NOT_FOUND", async () => {
  const result = assertValidResult(await store().query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["STORE_UNAVAILABLE"]);
  assert.deepEqual(result.records, []);
  assert.equal(typeof result.query_snapshot_id, "string");
  assert.ok(result.latency_ms >= 0);
});

test("a malformed query returns a schema-valid INVALID_QUERY without ever reaching an adapter", async () => {
  let called = false;
  const adapter = { query: async () => { called = true; return { records: [] }; } };
  const result = assertValidResult(await store(adapter).query({ execution_scope: "OFFICIAL" }));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INVALID_QUERY"]);
  assert.equal(called, false);
});

test("a query missing only query_id is rejected as INVALID_QUERY before the adapter is called", async () => {
  let called = false;
  const adapter = { query: async () => { called = true; return { records: [] }; } };
  const query = officialQuery();
  delete query.query_id;
  const result = assertValidResult(await store(adapter).query(query));
  assert.deepEqual(result.error_codes, ["INVALID_QUERY"]);
  assert.equal(called, false);
});

// --- OFFICIAL scope only ever carries VERIFIED, enforced at runtime not just schema time

test("an OFFICIAL query requesting CANDIDATE data is rejected as INVALID_QUERY before the adapter is called", () => {
  // structured-query.schema.json itself requires OFFICIAL scope to carry
  // verification_statuses === ["VERIFIED"]; this is a shape violation, not
  // a separate runtime-only check.
  assert.ok(validateStructuredQuery(officialQuery({ verification_statuses: ["CANDIDATE"] })).length > 0);
});

test("an OFFICIAL query requesting CANDIDATE data never reaches the adapter", async () => {
  let called = false;
  const adapter = { query: async () => { called = true; return { records: [] }; } };
  const result = assertValidResult(await store(adapter).query(officialQuery({ verification_statuses: ["CANDIDATE"] })));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INVALID_QUERY"]);
  assert.equal(called, false);
});

test("a wired adapter's VERIFIED-only OFFICIAL result passes through, schema-valid", async () => {
  const adapter = adapterReturning({ records: [verifiedRecord()] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "OK");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].verification_status, "VERIFIED");
  assert.deepEqual(result.applied_verification_statuses, ["VERIFIED"]);
});

test("a misbehaving adapter that leaks a CANDIDATE record into an OFFICIAL result is caught, not passed through", async () => {
  const adapter = adapterReturning({
    records: [verifiedRecord(), verifiedRecord({ record_id: "fact_fabricated00000000000000", verification_status: "CANDIDATE" })],
  });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["UNVERIFIED_DATA_FORBIDDEN"]);
  assert.deepEqual(result.records, []);
});

test("a misbehaving adapter that returns a record missing required fields is caught under OFFICIAL scope", async () => {
  const malformed = verifiedRecord();
  delete malformed.payload;
  const adapter = adapterReturning({ records: [malformed] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

test("a SANDBOX query may request CANDIDATE data and it passes through untouched, schema-valid", async () => {
  const adapter = adapterReturning({ records: [verifiedRecord({ verification_status: "CANDIDATE" })] });
  const result = assertValidResult(
    await store(adapter).query(officialQuery({ execution_scope: "SANDBOX", verification_statuses: ["CANDIDATE"] })),
  );
  assert.equal(result.status, "OK");
  assert.equal(result.records[0].verification_status, "CANDIDATE");
});

// --- the query must target the run's actual SharedContext snapshot, not
//     merely agree with whatever an adapter later echoes back -----------

test("a query targeting a different corpus_snapshot_id than the run context is rejected before the adapter is called", async () => {
  let called = false;
  const adapter = { query: async () => { called = true; return { records: [] }; } };
  const result = assertValidResult(
    await store(adapter).query(officialQuery({ corpus_snapshot_id: "corpus_a_flow_made_up" })),
  );
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
  assert.equal(called, false);
});

test("a query targeting a different fact_coverage_snapshot_id than the run context is rejected before the adapter is called", async () => {
  let called = false;
  const adapter = { query: async () => { called = true; return { records: [] }; } };
  const result = assertValidResult(
    await store(adapter).query(officialQuery({ fact_coverage_snapshot_id: "fact_coverage_a_flow_made_up" })),
  );
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
  assert.equal(called, false);
});

test("an adapter that faithfully echoes a query already pinned to the wrong snapshot still gets rejected", async () => {
  // The dangerous case: query and adapter agree with each other while both
  // disagree with the run's real context.
  let called = false;
  const adapter = {
    query: async (query) => {
      called = true;
      return { corpus_snapshot_id: query.corpus_snapshot_id, fact_coverage_snapshot_id: query.fact_coverage_snapshot_id, status: "OK", error_codes: [], records: [verifiedRecord()] };
    },
  };
  const result = await store(adapter).query(officialQuery({ corpus_snapshot_id: "corpus_a_flow_made_up" }));
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
  assert.equal(called, false, "the adapter must never be reached once the query's own snapshot is wrong");
});

// --- adapter response snapshot pinning: missing AND mismatched are both rejected

test("an adapter that echoes a different corpus_snapshot_id than what it was asked is rejected as SNAPSHOT_MISMATCH", async () => {
  const adapter = adapterReturning({ records: [verifiedRecord()], corpus_snapshot_id: "corpus_some_other_snapshot" });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
});

test("an adapter that omits corpus_snapshot_id entirely is rejected as SNAPSHOT_MISMATCH, not silently accepted", async () => {
  const adapter = { query: async () => ({ status: "OK", error_codes: [], records: [verifiedRecord()] }) };
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
});

test("an adapter that echoes a different fact_coverage_snapshot_id is rejected as SNAPSHOT_MISMATCH", async () => {
  const adapter = adapterReturning({ records: [verifiedRecord()], fact_coverage_snapshot_id: "fact_coverage_other" });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["SNAPSHOT_MISMATCH"]);
});

// --- adapter status is preserved, never silently coerced to OK ------------

test("an adapter NOT_FOUND status is preserved, not turned into OK", async () => {
  const adapter = adapterReturning({ status: "NOT_FOUND", records: [] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "NOT_FOUND");
});

test("an adapter ERROR status and its error_codes are preserved, not turned into OK", async () => {
  const adapter = adapterReturning({ status: "ERROR", error_codes: ["TIMEOUT"], records: [] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["TIMEOUT"]);
});

test("an adapter returning an unrecognized status is treated as an adapter contract violation", async () => {
  const adapter = adapterReturning({ status: "MADE_UP", records: [] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

test("an adapter that throws is caught as a schema-valid INTERNAL_ERROR", async () => {
  const adapter = { query: async () => { throw new Error("boom"); } };
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

// --- status/payload semantics cannot contradict each other (schema-enforced)

test("an adapter claiming OK with zero records is rejected — OK must carry at least one record", async () => {
  const adapter = adapterReturning({ status: "OK", records: [] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

test("an adapter claiming NOT_FOUND while still returning records is rejected", async () => {
  const adapter = adapterReturning({ status: "NOT_FOUND", records: [verifiedRecord()] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

test("an adapter claiming ERROR with no error_codes is rejected — ERROR must explain itself", async () => {
  const adapter = adapterReturning({ status: "ERROR", error_codes: [], records: [] });
  const result = assertValidResult(await store(adapter).query(officialQuery()));
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["INTERNAL_ERROR"]);
});

// --- budget wiring -------------------------------------------------------

test("a budgeted StructuredStore consumes a tool call before delegating, and never calls the raw store once spent", async () => {
  let calls = 0;
  const rawStore = { query: async () => { calls += 1; return { status: "ERROR", error_codes: ["STORE_UNAVAILABLE"], records: [] }; } };
  const budget = createExecutionBudget({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 1, timeoutMs: 10_000 });
  const budgeted = createBudgetedStructuredStore(rawStore, budget);

  await budgeted.query(officialQuery());
  assert.equal(calls, 1);
  await assert.rejects(() => budgeted.query(officialQuery()), BudgetExceededError);
  assert.equal(calls, 1, "raw store must not be called once the budget is spent");
});
