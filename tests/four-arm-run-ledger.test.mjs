import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLedgerEntry, assertSingleCompleteBatch, decideReuseEligibility, computeBatchId,
  RunLedgerValidationError,
} from "../domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function baseEntry(overrides = {}) {
  return {
    arm: "A", role: "AC_LIVE", batch_id: "batch1",
    code_sha256: "44f05231de8b9a3b6fdb6ff422435d0586937941",
    config_sha256: SHA,
    input_sha256: { conditions: SHA, universe: SHA2 },
    index_sha256: SHA,
    results_sha256: null,
    status: "NOT_EXECUTED_PENDING_DEVTUNE",
    ...overrides,
  };
}

test("validateLedgerEntry accepts a well-formed A/C entry", () => {
  assert.equal(validateLedgerEntry(baseEntry()), true);
});

test("validateLedgerEntry accepts a well-formed B/D entry with a results_sha256", () => {
  assert.equal(validateLedgerEntry(baseEntry({
    arm: "B", role: "BD_IMPORTED_REFERENCE", status: "REUSED_VERIFIED", results_sha256: SHA,
  })), true);
});

test("validateLedgerEntry rejects an invalid arm/role/status", () => {
  assert.throws(() => validateLedgerEntry(baseEntry({ arm: "Z" })), (e) => e instanceof RunLedgerValidationError && e.code === "LEDGER_ENTRY_INVALID_ARM");
  assert.throws(() => validateLedgerEntry(baseEntry({ role: "BOGUS" })), (e) => e.code === "LEDGER_ENTRY_INVALID_ROLE");
  assert.throws(() => validateLedgerEntry(baseEntry({ status: "BOGUS" })), (e) => e.code === "LEDGER_ENTRY_INVALID_STATUS");
});

test("validateLedgerEntry requires results_sha256 for REUSED_VERIFIED/EXECUTED status", () => {
  assert.throws(
    () => validateLedgerEntry(baseEntry({ status: "REUSED_VERIFIED", results_sha256: null })),
    (e) => e.code === "LEDGER_ENTRY_MISSING_RESULTS_SHA_FOR_STATUS",
  );
});

test("validateLedgerEntry rejects malformed sha256 fields", () => {
  assert.throws(() => validateLedgerEntry(baseEntry({ config_sha256: "not-a-sha" })), (e) => e.code === "LEDGER_ENTRY_INVALID_CONFIG_SHA");
  assert.throws(() => validateLedgerEntry(baseEntry({ input_sha256: { conditions: "bad" } })), (e) => e.code === "LEDGER_ENTRY_INVALID_INPUT_SHA_VALUE");
});

test("assertSingleCompleteBatch accepts exactly one entry per arm sharing one batch_id", () => {
  const entries = ["A", "B", "C", "D"].map((arm) => baseEntry({
    arm, batch_id: "batch1",
    role: arm === "A" || arm === "C" ? "AC_LIVE" : "BD_IMPORTED_REFERENCE",
    status: arm === "A" || arm === "C" ? "NOT_EXECUTED_PENDING_DEVTUNE" : "REUSED_VERIFIED",
    results_sha256: arm === "A" || arm === "C" ? null : SHA,
  }));
  const result = assertSingleCompleteBatch(entries);
  assert.equal(result.batch_id, "batch1");
  assert.deepEqual(result.arms, ["A", "B", "C", "D"]);
});

test("assertSingleCompleteBatch rejects a partial-arm batch (selective rerun)", () => {
  const entries = ["A", "B", "C"].map((arm) => baseEntry({ arm, batch_id: "batch1", results_sha256: SHA, status: "REUSED_VERIFIED" }));
  assert.throws(() => assertSingleCompleteBatch(entries), (e) => e.code === "LEDGER_BATCH_INCOMPLETE");
});

test("assertSingleCompleteBatch rejects entries mixing two different batch_ids (old/new result mixing)", () => {
  const entries = ["A", "B", "C", "D"].map((arm, i) => baseEntry({
    arm, batch_id: i === 0 ? "batch1" : "batch2", results_sha256: SHA, status: "REUSED_VERIFIED",
  }));
  assert.throws(() => assertSingleCompleteBatch(entries), (e) => e.code === "LEDGER_BATCH_ID_MISMATCH");
});

test("assertSingleCompleteBatch rejects a duplicate arm within one batch", () => {
  const entries = ["A", "A", "C", "D"].map((arm) => baseEntry({ arm, batch_id: "batch1", results_sha256: SHA, status: "REUSED_VERIFIED" }));
  assert.throws(() => assertSingleCompleteBatch(entries), (e) => e.code === "LEDGER_BATCH_DUPLICATE_ARM");
});

test("decideReuseEligibility: eligible only when code/config/every input sha matches exactly", () => {
  const prior = baseEntry();
  const eligible = decideReuseEligibility({
    priorEntry: prior, currentCodeSha256: prior.code_sha256, currentConfigSha256: prior.config_sha256,
    currentInputSha256: prior.input_sha256,
  });
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.reasons, []);
});

test("decideReuseEligibility: any single mismatch forces full rerun, never partial reuse", () => {
  const prior = baseEntry();
  const result = decideReuseEligibility({
    priorEntry: prior, currentCodeSha256: prior.code_sha256, currentConfigSha256: prior.config_sha256,
    currentInputSha256: { ...prior.input_sha256, conditions: SHA2 },
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.startsWith("INPUT_SHA_MISMATCH[conditions]")));
});

test("decideReuseEligibility: no prior entry is never eligible", () => {
  assert.deepEqual(decideReuseEligibility({ priorEntry: null }), { eligible: false, reasons: ["NO_PRIOR_ENTRY"] });
});

test("computeBatchId is deterministic and changes when any pin changes", () => {
  const a = computeBatchId({ conditionsSha256: SHA, universeSha256: SHA2, evaluationCutoffId: "20-10-5,10,20" });
  const b = computeBatchId({ conditionsSha256: SHA, universeSha256: SHA2, evaluationCutoffId: "20-10-5,10,20" });
  const c = computeBatchId({ conditionsSha256: SHA2, universeSha256: SHA2, evaluationCutoffId: "20-10-5,10,20" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
