import assert from "node:assert/strict";
import test from "node:test";
import { createFactProvenanceValidator, createFactStore, projectFactToCalculationInput } from "../domain/runtime/fact-store.mjs";

const CONTEXT = { corpus_snapshot_id: "corpus_04750795e1a2d5c3", fact_coverage_snapshot_id: "fact_coverage_snapshot_0123456789abcdef01234567" };

// Canonical Fact record shape — semantic-bundle.schema.json's Fact $def
// field names (normalized_value, not `value`).
function factRecord(overrides = {}) {
  return {
    fact_id: "fact_0123456789abcdef01234567",
    normalized_value: 1_000_000_000,
    unit: "KRW",
    scope: "CONSOLIDATED",
    value_status: "DISCLOSED",
    known_at: "2025-03-14T00:00:00Z",
    valid_from: "2025-03-14T00:00:00Z",
    valid_to: null,
    verification_status: "VERIFIED",
    ...overrides,
  };
}

function factAdapterWith(records, envelopeOverrides = {}) {
  const byId = new Map(
    records.map((record) => [
      record.fact_id,
      { corpus_snapshot_id: CONTEXT.corpus_snapshot_id, fact_coverage_snapshot_id: CONTEXT.fact_coverage_snapshot_id, ...envelopeOverrides, record },
    ]),
  );
  return { getFact: async (factId) => byId.get(factId) ?? null };
}

// The request-side CalculationInput — deliberately matches
// projectFactToCalculationInput(factRecord()) field for field.
function calculationInput(overrides = {}) {
  return {
    fact_id: "fact_0123456789abcdef01234567",
    value: 1_000_000_000,
    unit: "KRW",
    scope: "CONSOLIDATED",
    value_status: "DISCLOSED",
    known_at: "2025-03-14T00:00:00Z",
    valid_from: "2025-03-14T00:00:00Z",
    valid_to: null,
    ...overrides,
  };
}

function newValidator({ records = [factRecord()], envelopeOverrides = {} } = {}) {
  const factStore = createFactStore(factAdapterWith(records, envelopeOverrides), CONTEXT);
  return createFactProvenanceValidator(factStore);
}

// --- canonical projection ---------------------------------------------

test("projectFactToCalculationInput projects normalized_value into value, field for field", () => {
  const record = factRecord({ normalized_value: 42 });
  assert.deepEqual(projectFactToCalculationInput(record), {
    fact_id: record.fact_id,
    value: 42,
    unit: record.unit,
    scope: record.scope,
    value_status: record.value_status,
    known_at: record.known_at,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
  });
});

// --- happy path: canonical projection and request agree exactly --------

test("a genuinely VERIFIED, matching fact record resolves when the request matches the canonical projection exactly", async () => {
  const result = await newValidator().check([calculationInput()]);
  assert.deepEqual(result, { ok: true });
});

test("multiple facts in one request all resolve independently", async () => {
  const records = [factRecord(), factRecord({ fact_id: "fact_1111111111111111111111", normalized_value: 500 })];
  const inputs = [calculationInput(), calculationInput({ fact_id: "fact_1111111111111111111111", value: 500 })];
  const result = await newValidator({ records }).check(inputs);
  assert.deepEqual(result, { ok: true });
});

// --- fail-closed ---------------------------------------------------------

test("FactStore not wired: the official path fails closed", async () => {
  const factStore = createFactStore(null, CONTEXT);
  const result = await createFactProvenanceValidator(factStore).check([calculationInput()]);
  assert.deepEqual(result, { ok: false, code: "FACT_STORE_UNAVAILABLE" });
});

test("an adapter that throws is treated as FACT_STORE_UNAVAILABLE, not a crash", async () => {
  const factStore = createFactStore({ getFact: async () => { throw new Error("db down"); } }, CONTEXT);
  const result = await createFactProvenanceValidator(factStore).check([calculationInput()]);
  assert.deepEqual(result, { ok: false, code: "FACT_STORE_UNAVAILABLE" });
});

test("a non-existent fact_id is rejected as FACT_NOT_FOUND", async () => {
  const result = await newValidator().check([calculationInput({ fact_id: "fact_does_not_exist000000" })]);
  assert.deepEqual(result, { ok: false, code: "FACT_NOT_FOUND" });
});

// --- snapshot binding: BOTH corpus and fact-coverage snapshots ------------

test("a fact reviewed against a different processing (corpus) snapshot is rejected as FACT_SNAPSHOT_MISMATCH", async () => {
  const result = await newValidator({ envelopeOverrides: { corpus_snapshot_id: "corpus_some_older_snapshot" } }).check([
    calculationInput(),
  ]);
  assert.deepEqual(result, { ok: false, code: "FACT_SNAPSHOT_MISMATCH" });
});

test("a fact from a different Fact Coverage Snapshot is rejected as FACT_COVERAGE_SNAPSHOT_MISMATCH", async () => {
  const result = await newValidator({
    envelopeOverrides: { fact_coverage_snapshot_id: "fact_coverage_snapshot_other0000000000" },
  }).check([calculationInput()]);
  assert.deepEqual(result, { ok: false, code: "FACT_COVERAGE_SNAPSHOT_MISMATCH" });
});

// --- request must match the canonical projection exactly ------------------

test("a request value different from the stored fact's normalized_value is rejected", async () => {
  const result = await newValidator().check([calculationInput({ value: 999_999_999 })]);
  assert.deepEqual(result, { ok: false, code: "FACT_VALUE_MISMATCH" });
});

test("a request unit different from the stored fact's unit is rejected", async () => {
  const result = await newValidator().check([calculationInput({ unit: "USD" })]);
  assert.deepEqual(result, { ok: false, code: "FACT_UNIT_MISMATCH" });
});

test("a request scope different from the stored fact's scope is rejected", async () => {
  const result = await newValidator().check([calculationInput({ scope: "SEPARATE" })]);
  assert.deepEqual(result, { ok: false, code: "FACT_SCOPE_MISMATCH" });
});

test("a request value_status different from the stored fact's value_status is rejected", async () => {
  const result = await newValidator().check([calculationInput({ value_status: "WITHHELD" })]);
  assert.deepEqual(result, { ok: false, code: "FACT_VALUE_STATUS_MISMATCH" });
});

// --- a caller cannot pick its own favorable validity period ---------------

test("a request valid_to that disagrees with the stored fact's valid_to is rejected — a caller cannot extend its own validity", async () => {
  const records = [factRecord({ valid_to: "2020-12-31T00:00:00Z" })]; // actually expired
  const forgedInput = calculationInput({ valid_to: "2030-12-31T00:00:00Z" }); // caller claims still valid
  const result = await newValidator({ records }).check([forgedInput]);
  assert.deepEqual(result, { ok: false, code: "FACT_TEMPORAL_MISMATCH" });
});

test("a request known_at or valid_from that disagrees with the stored fact's is rejected", async () => {
  const knownAtResult = await newValidator().check([calculationInput({ known_at: "2099-01-01T00:00:00Z" })]);
  assert.deepEqual(knownAtResult, { ok: false, code: "FACT_TEMPORAL_MISMATCH" });

  const validFromResult = await newValidator().check([calculationInput({ valid_from: "2099-01-01T00:00:00Z" })]);
  assert.deepEqual(validFromResult, { ok: false, code: "FACT_TEMPORAL_MISMATCH" });
});

// --- verification_status comes only from the store ---------------------

test("a CANDIDATE record in the FactStore is rejected on the official path, regardless of what the request claims", async () => {
  const result = await newValidator({ records: [factRecord({ verification_status: "CANDIDATE" })] }).check([calculationInput()]);
  assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
});

test("a REJECTED record in the FactStore is rejected on the official path", async () => {
  const result = await newValidator({ records: [factRecord({ verification_status: "REJECTED" })] }).check([calculationInput()]);
  assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
});

// --- one bad fact in a multi-fact request fails the whole request -------

test("one unresolvable fact among several fails the entire calculation input set", async () => {
  const records = [factRecord()];
  const inputs = [calculationInput(), calculationInput({ fact_id: "fact_missing_00000000000000" })];
  const result = await newValidator({ records }).check(inputs);
  assert.deepEqual(result, { ok: false, code: "FACT_NOT_FOUND" });
});
