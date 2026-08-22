import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendEventLineAtomic,
  appendUsageEvent,
  canUseSplit,
  MAX_DEV_CHECK_RUNS,
  MAX_HOLDOUT_FINAL_RUNS,
  readLedgerFile,
  transitionHoldoutLifecycle,
  transitionSplitLock,
  USAGE_LEDGER_CODES,
  validateUsageLedger,
} from "../domain/runtime/evaluation-usage-ledger.mjs";

const CONFIG_HASH = "8d121b8a9ca873380164256bcb3ad52c8f3f8746d1194342272822dceaaae8c5";
const OTHER_CONFIG_HASH = "a47006b7b043be85d31f3672a683c2b0358b2c1105d33bfb50d993d634f2887a";

// A self-contained mirror of the module's own private canonicalize +
// sha256 hashing, used ONLY to hand-construct a hash-VALID event for tests
// that need to simulate a ledger assembled by merging two independently
// produced logs (never going through appendUsageEvent's own identity
// gate). Deliberately not importing an internal from the module itself —
// this keeps the module's public API surface unchanged for this purpose.
function canonicalizeForTest(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForTest);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeForTest(value[key])]));
  }
  return value;
}

function computeEventHashForTest(eventWithoutHash) {
  return createHash("sha256").update(JSON.stringify(canonicalizeForTest(eventWithoutHash)), "utf8").digest("hex");
}

function lifecycle(assignmentId, assignedSplit, overrides = {}) {
  return {
    assignment_id: assignmentId,
    assigned_split: assignedSplit,
    split_lock_status: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status: "SEALED",
    ...overrides,
  };
}

function provisional(assignmentId, assignedSplit, overrides = {}) {
  return lifecycle(assignmentId, assignedSplit, { split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE", ...overrides });
}

function appendOrThrow(log, input) {
  const result = appendUsageEvent(log, input, { now: () => "2026-08-10T09:00:00Z" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.log;
}

function appendOrThrowAt(log, input, isoTime) {
  const result = appendUsageEvent(log, input, { now: () => isoTime });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.log;
}

// --- 1. provisional 공식 실행 거부 -----------------------------------------

test("canUseSplit rejects a provisional assignment used for an official (non-SANDBOX) split", () => {
  const result = canUseSplit({
    assignmentId: "author_0000000000000000000000a1",
    runId: "run_a1",
    lifecycleState: provisional("author_0000000000000000000000a1", "DEV_TUNE"),
    executedSplit: "DEV_TUNE",
    usageKind: "TUNING",
    runPurpose: "FLOW_SELECTION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROVISIONAL_SPLIT_FORBIDS_OFFICIAL_USE");
});

test("canUseSplit allows a provisional assignment used only as SANDBOX", () => {
  const result = canUseSplit({
    assignmentId: "author_0000000000000000000000a1",
    runId: "run_sandbox_a1",
    lifecycleState: provisional("author_0000000000000000000000a1", "DEV_TUNE"),
    executedSplit: "SANDBOX",
    usageKind: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
  });
  assert.equal(result.ok, true);
});

// --- 2. DEV_TUNE -> DEV_CHECK/HOLDOUT 재배치 거부 ---------------------------

test("canUseSplit rejects promoting an assignment already used in DEV_TUNE to DEV_CHECK", () => {
  const assignmentId = "author_0000000000000000000000a2";
  let log = appendOrThrow([], {
    assignmentId,
    runId: "run_tune_1",
    usageKind: "TUNING",
    executedSplit: "DEV_TUNE",
    runPurpose: "FLOW_SELECTION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "DEV_TUNE"),
  });
  const result = canUseSplit({
    log,
    assignmentId,
    runId: "run_check_promo",
    // even a (hypothetically re-pinned) DEV_CHECK assignment record is still blocked by the tuning-locked history check
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TUNING_LOCKED_ASSIGNMENT_CANNOT_BE_PROMOTED");
});

// --- 3. DEV_CHECK 3회째 거부 (now: distinct run_id, outcome-agnostic) ------

test(`canUseSplit rejects a ${MAX_DEV_CHECK_RUNS + 1}th distinct DEV_CHECK run once the budget is exhausted`, () => {
  let log = [];
  for (let i = 1; i <= MAX_DEV_CHECK_RUNS; i += 1) {
    const assignmentId = `author_00000000000000000000dc${i}`;
    log = appendOrThrow(log, {
      assignmentId,
      runId: `run_check_${i}`,
      usageKind: "CHECKPOINT",
      executedSplit: "DEV_CHECK",
      runPurpose: "CRITICAL_REGRESSION_CHECK",
      runOutcome: "SUCCESS",
      lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
      configurationSha256: CONFIG_HASH,
    });
  }
  const result = canUseSplit({
    log,
    assignmentId: "author_00000000000000000000dc9",
    runId: "run_check_9",
    lifecycleState: lifecycle("author_00000000000000000000dc9", "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEV_CHECK_BUDGET_EXHAUSTED");
});

test("canUseSplit allows appending a SECOND assignment within an ALREADY-COUNTED DEV_CHECK run_id (continuing an in-progress run is not a new run)", () => {
  const a1 = "author_00000000000000000000db1";
  const a2 = "author_00000000000000000000db2";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_check_shared",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  });
  log = appendOrThrow(log, {
    assignmentId: a2,
    runId: "run_check_shared", // SAME run_id, a different assignment in the same batch run
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a2, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(log.filter((e) => e.run_id === "run_check_shared").length, 2);
});

// --- required regression: HOLDOUT one run_id, 100 different assignments ---

test("HOLDOUT: the SAME run_id can record 100 different assignments successfully, consuming budget only once", () => {
  let log = [];
  for (let i = 1; i <= 100; i += 1) {
    const assignmentId = `author_${String(i).padStart(6, "0")}000000000000000000`;
    log = appendOrThrow(log, {
      assignmentId,
      runId: "run_holdout_full",
      usageKind: "FINAL_HOLDOUT",
      executedSplit: "HOLDOUT",
      runPurpose: "FINAL_HOLDOUT_EVALUATION",
      runOutcome: "SUCCESS",
      lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
      configurationSha256: CONFIG_HASH,
    });
  }
  assert.equal(log.length, 100);
  assert.equal(new Set(log.map((e) => e.run_id)).size, 1);
  assert.deepEqual(validateUsageLedger(log), []);
});

// --- required regression: second independent HOLDOUT run_id rejected -----

test("a second, independent HOLDOUT run_id is rejected even for a brand-new assignment", () => {
  const a1 = "author_0000000000000000000000h1";
  const a2 = "author_0000000000000000000000h2";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_holdout_first",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  const result = canUseSplit({
    log,
    assignmentId: a2,
    runId: "run_holdout_second",
    lifecycleState: lifecycle(a2, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "HOLDOUT_FINAL_BUDGET_EXHAUSTED");
});

// --- required regression: run identity must stay consistent per run_id ---

test("reusing a run_id with a DIFFERENT configuration_sha256 is rejected as RUN_IDENTITY_MISMATCH", () => {
  const a1 = "author_0000000000000000000000i1";
  const a2 = "author_0000000000000000000000i2";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_identity_1",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  });
  const result = canUseSplit({
    log,
    assignmentId: a2,
    runId: "run_identity_1", // SAME run_id
    lifecycleState: lifecycle(a2, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: OTHER_CONFIG_HASH, // different hash
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RUN_IDENTITY_MISMATCH");
});

test("reusing a run_id with a DIFFERENT run_purpose is rejected as RUN_IDENTITY_MISMATCH", () => {
  const a1 = "author_0000000000000000000000i3";
  const a2 = "author_0000000000000000000000i4";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_identity_2",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  const result = canUseSplit({
    log,
    assignmentId: a2,
    runId: "run_identity_2", // SAME run_id
    lifecycleState: lifecycle(a2, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "DIAGNOSTIC_ONLY", // different purpose
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RUN_IDENTITY_MISMATCH");
});

test("reusing a run_id with the SAME identity fields is allowed (that's the normal multi-assignment case)", () => {
  const a1 = "author_0000000000000000000000i5";
  const a2 = "author_0000000000000000000000i6";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_identity_3",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
    gitCommit: "abc123",
  });
  const result = canUseSplit({
    log,
    assignmentId: a2,
    runId: "run_identity_3",
    lifecycleState: lifecycle(a2, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
    gitCommit: "abc123",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// --- 4. FAILURE 우회 차단 ---------------------------------------------------
// POLICY: a distinct run_id consumes the DEV_CHECK/HOLDOUT budget the
// moment it is FIRST recorded, regardless of run_outcome.

test(`a FAILURE-outcome DEV_CHECK run STILL consumes the budget — repeated FAILUREs cannot open unlimited attempts`, () => {
  let log = [];
  for (let i = 1; i <= MAX_DEV_CHECK_RUNS; i += 1) {
    const assignmentId = `author_00000000000000000000f${i}0`;
    log = appendOrThrow(log, {
      assignmentId,
      runId: `run_failed_check_${i}`,
      usageKind: "CHECKPOINT",
      executedSplit: "DEV_CHECK",
      runPurpose: "CRITICAL_REGRESSION_CHECK",
      runOutcome: "FAILURE", // every attempt fails
      lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
      configurationSha256: CONFIG_HASH,
    });
  }
  const result = canUseSplit({
    log,
    assignmentId: "author_00000000000000000000f99",
    runId: "run_failed_check_99",
    lifecycleState: lifecycle("author_00000000000000000000f99", "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false, "budget must be exhausted after 2 FAILURE runs too — FAILURE is not a free retry");
  assert.equal(result.code, "DEV_CHECK_BUDGET_EXHAUSTED");
});

// --- required regression: a FAILURE-outcome HOLDOUT run still blocks a second run ---

test("a FAILURE-outcome HOLDOUT run STILL blocks a second, independent HOLDOUT run_id", () => {
  const a1 = "author_0000000000000000000000j1";
  const a2 = "author_0000000000000000000000j2";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_holdout_failed",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "FAILURE", // the harness crashed
    lifecycleState: lifecycle(a1, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  const result = canUseSplit({
    log,
    assignmentId: a2,
    runId: "run_holdout_retry",
    lifecycleState: lifecycle(a2, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false, "a crashed first attempt must not grant a fresh independent-final-run budget");
  assert.equal(result.code, "HOLDOUT_FINAL_BUDGET_EXHAUSTED");
});

// --- 5. assigned_split pinning ---------------------------------------------

test("an assignment locked+assigned to DEV_CHECK cannot be executed as HOLDOUT, DEV_TUNE, or SANDBOX", () => {
  const assignmentId = "author_0000000000000000000000k1";
  const attempts = [
    { executedSplit: "HOLDOUT", usageKind: "FINAL_HOLDOUT", runPurpose: "FINAL_HOLDOUT_EVALUATION" },
    { executedSplit: "DEV_TUNE", usageKind: "TUNING", runPurpose: "FLOW_SELECTION" },
    { executedSplit: "SANDBOX", usageKind: "SANDBOX", runPurpose: "SANDBOX_EXPLORATION" },
  ];
  for (const attempt of attempts) {
    const result = canUseSplit({
      assignmentId,
      runId: `run_bypass_${attempt.executedSplit}`,
      lifecycleState: lifecycle(assignmentId, "DEV_CHECK", { holdout_lifecycle_status: "OPENED" }),
      configurationSha256: CONFIG_HASH,
      ...attempt,
    });
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.equal(result.code, "ASSIGNED_SPLIT_MISMATCH", JSON.stringify(attempt));
  }
});

test("an assignment locked+assigned to HOLDOUT cannot be executed as DEV_TUNE or SANDBOX", () => {
  const assignmentId = "author_0000000000000000000000k2";
  for (const attempt of [
    { executedSplit: "DEV_TUNE", usageKind: "TUNING", runPurpose: "FLOW_SELECTION" },
    { executedSplit: "SANDBOX", usageKind: "SANDBOX", runPurpose: "SANDBOX_EXPLORATION" },
  ]) {
    const result = canUseSplit({
      assignmentId,
      runId: `run_holdout_bypass_${attempt.executedSplit}`,
      lifecycleState: lifecycle(assignmentId, "HOLDOUT"),
      configurationSha256: CONFIG_HASH,
      ...attempt,
    });
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.equal(result.code, "ASSIGNED_SPLIT_MISMATCH", JSON.stringify(attempt));
  }
});

test("canUseSplit rejects a lifecycleState belonging to a DIFFERENT assignment_id", () => {
  const result = canUseSplit({
    assignmentId: "author_0000000000000000000000m1",
    runId: "run_mismatch_1",
    lifecycleState: lifecycle("author_0000000000000000000000m2", "DEV_CHECK"), // wrong assignment
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LIFECYCLE_ASSIGNMENT_MISMATCH");
});

test("usage events record assigned_split_at_use and holdout_lifecycle_status_at_use as audit fields", () => {
  const assignmentId = "author_0000000000000000000000k3";
  const log = appendOrThrow([], {
    assignmentId,
    runId: "run_audit_1",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(log[0].assigned_split_at_use, "HOLDOUT");
  assert.equal(log[0].holdout_lifecycle_status_at_use, "OPENED");
});

// --- assignment's past OFFICIAL split is fixed by the LEDGER's own
// history, independent of whatever lifecycleState.assigned_split claims —
// closes the bypass where a caller "re-pins" assigned_split to match a new
// (illegitimate) attempt. ---------------------------------------------

test("an assignment already used as DEV_CHECK is rejected if lifecycleState is changed to claim it's assigned to HOLDOUT", () => {
  const assignmentId = "author_0000000000000000000000r1";
  let log = appendOrThrow([], {
    assignmentId,
    runId: "run_history_check",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  });
  // the caller (or a stale/edited lifecycle record) now claims this SAME
  // assignment is pinned to HOLDOUT — executedSplit and the claimed
  // assigned_split agree with EACH OTHER, but not with the ledger's own
  // history.
  const result = canUseSplit({
    log,
    assignmentId,
    runId: "run_history_holdout_attempt",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ASSIGNMENT_SPLIT_HISTORY_MISMATCH");
});

test("an assignment already used as HOLDOUT is rejected if lifecycleState is changed to claim it's assigned to DEV_CHECK", () => {
  const assignmentId = "author_0000000000000000000000r2";
  let log = appendOrThrow([], {
    assignmentId,
    runId: "run_history_holdout_first",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  const result = canUseSplit({
    log,
    assignmentId,
    runId: "run_history_check_attempt",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ASSIGNMENT_SPLIT_HISTORY_MISMATCH");
});

test("SANDBOX usage does not fix split history — an assignment used only via SANDBOX can still be locked and executed under its genuinely assigned split", () => {
  const assignmentId = "author_0000000000000000000000r3";
  let log = appendOrThrow([], {
    assignmentId,
    runId: "run_sandbox_peek",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional(assignmentId, "DEV_CHECK"),
  });
  const result = canUseSplit({
    log,
    assignmentId,
    runId: "run_after_sandbox",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("validateUsageLedger treats an assignment already recorded under TWO distinct official splits as LEDGER_CORRUPT", () => {
  const assignmentId = "author_0000000000000000000000r4";
  const devCheckEvent = appendOrThrow([], {
    assignmentId,
    runId: "run_corrupt_history_1",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  })[0];
  // constructed directly (not via appendUsageEvent, which would itself
  // reject this) to simulate a ledger that reached this state by some
  // OTHER means — e.g. a hand-edited or externally merged file.
  const holdoutEvent = {
    ...devCheckEvent,
    usage_event_id: "eval_usage_1111111111111111111111",
    run_id: "run_corrupt_history_2",
    usage_kind: "FINAL_HOLDOUT",
    executed_split: "HOLDOUT",
    run_purpose: "FINAL_HOLDOUT_EVALUATION",
    assigned_split_at_use: "HOLDOUT",
    // otherwise-well-shaped (satisfies validateEvaluationUsageEvent's own
    // FINAL_HOLDOUT_EVALUATION-requires-OPENED check) so this fixture
    // actually exercises the LEDGER-WIDE "two official splits" invariant
    // being tested here, rather than getting short-circuited earlier by a
    // per-entry shape error.
    holdout_lifecycle_status_at_use: "OPENED",
    previous_log_hash: devCheckEvent.event_hash,
  };
  const corrupted = [devCheckEvent, holdoutEvent]; // holdoutEvent's own event_hash is now stale too, but the split-history check fires independent of that
  const errors = validateUsageLedger(corrupted);
  assert.ok(errors.some((error) => error.includes("more than one official executed_split")));

  const gateResult = canUseSplit({
    log: corrupted,
    assignmentId: "author_0000000000000000000000r5",
    runId: "run_after_corrupt_history",
    lifecycleState: lifecycle("author_0000000000000000000000r5", "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(gateResult.ok, false);
  assert.equal(gateResult.code, "LEDGER_CORRUPT");
});

// --- SEALED / HOLDOUT lifecycle gating (unchanged behavior, re-verified) --

test("canUseSplit rejects ANY HOLDOUT execution (final or diagnostic) while SEALED", () => {
  for (const runPurpose of ["FINAL_HOLDOUT_EVALUATION", "DIAGNOSTIC_ONLY"]) {
    const assignmentId = `author_0000000000000000000000n${runPurpose === "DIAGNOSTIC_ONLY" ? 1 : 2}`;
    const result = canUseSplit({
      assignmentId,
      runId: `run_sealed_${runPurpose}`,
      lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "SEALED" }),
      executedSplit: "HOLDOUT",
      usageKind: "FINAL_HOLDOUT",
      runPurpose,
      configurationSha256: CONFIG_HASH,
    });
    assert.equal(result.ok, false, runPurpose);
    assert.equal(result.code, "HOLDOUT_SEALED", runPurpose);
  }
});

test("canUseSplit requires holdout_lifecycle_status=OPENED for FINAL_HOLDOUT_EVALUATION, and rejects it once CONSUMED", () => {
  const assignmentId = "author_0000000000000000000000n3";
  const result = canUseSplit({
    assignmentId,
    runId: "run_consumed_1",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "CONSUMED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "HOLDOUT_ALREADY_CONSUMED");
});

test("canUseSplit allows a DIAGNOSTIC_ONLY-purpose run only once holdout_lifecycle_status is DIAGNOSTIC_ONLY", () => {
  const assignmentId = "author_0000000000000000000000n4";
  const stillConsumed = canUseSplit({
    assignmentId,
    runId: "run_diag_1",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "CONSUMED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "DIAGNOSTIC_ONLY",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(stillConsumed.ok, false);
  assert.equal(stillConsumed.code, "HOLDOUT_DIAGNOSTIC_REQUIRES_DIAGNOSTIC_ONLY_STATE");

  const diagnosticReady = canUseSplit({
    assignmentId,
    runId: "run_diag_2",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "DIAGNOSTIC_ONLY" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "DIAGNOSTIC_ONLY",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(diagnosticReady.ok, true);
});

// --- lifecycle transitions (unchanged) -------------------------------------

test("transitionSplitLock allows PROVISIONAL_UNTIL_CHAIN_CLOSURE -> LOCKED_BY_CHAIN and -> LOCKED_BY_COVERAGE", () => {
  assert.deepEqual(transitionSplitLock("PROVISIONAL_UNTIL_CHAIN_CLOSURE", "LOCKED_BY_CHAIN"), { ok: true, status: "LOCKED_BY_CHAIN" });
  assert.deepEqual(transitionSplitLock("PROVISIONAL_UNTIL_CHAIN_CLOSURE", "LOCKED_BY_COVERAGE"), { ok: true, status: "LOCKED_BY_COVERAGE" });
});

test("transitionSplitLock rejects backward and lateral transitions", () => {
  assert.equal(transitionSplitLock("LOCKED_BY_CHAIN", "PROVISIONAL_UNTIL_CHAIN_CLOSURE").ok, false);
  assert.equal(transitionSplitLock("LOCKED_BY_COVERAGE", "PROVISIONAL_UNTIL_CHAIN_CLOSURE").ok, false);
  assert.equal(transitionSplitLock("LOCKED_BY_CHAIN", "LOCKED_BY_COVERAGE").ok, false);
  assert.equal(transitionSplitLock("LOCKED_BY_COVERAGE", "LOCKED_BY_CHAIN").ok, false);
});

test("transitionHoldoutLifecycle allows only the exact linear chain SEALED -> OPENED -> CONSUMED -> DIAGNOSTIC_ONLY", () => {
  assert.deepEqual(transitionHoldoutLifecycle("SEALED", "OPENED"), { ok: true, status: "OPENED" });
  assert.deepEqual(transitionHoldoutLifecycle("OPENED", "CONSUMED"), { ok: true, status: "CONSUMED" });
  assert.deepEqual(transitionHoldoutLifecycle("CONSUMED", "DIAGNOSTIC_ONLY"), { ok: true, status: "DIAGNOSTIC_ONLY" });
});

test("transitionHoldoutLifecycle rejects skipping a stage", () => {
  const result = transitionHoldoutLifecycle("SEALED", "CONSUMED");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_LIFECYCLE_TRANSITION");
});

test("transitionHoldoutLifecycle rejects every backward transition", () => {
  assert.equal(transitionHoldoutLifecycle("OPENED", "SEALED").ok, false);
  assert.equal(transitionHoldoutLifecycle("CONSUMED", "OPENED").ok, false);
  assert.equal(transitionHoldoutLifecycle("DIAGNOSTIC_ONLY", "CONSUMED").ok, false);
  assert.equal(transitionHoldoutLifecycle("DIAGNOSTIC_ONLY", "SEALED").ok, false);
});

test("transitionHoldoutLifecycle: from CONSUMED, ONLY DIAGNOSTIC_ONLY is allowed", () => {
  assert.equal(transitionHoldoutLifecycle("CONSUMED", "SEALED").ok, false);
  assert.equal(transitionHoldoutLifecycle("CONSUMED", "OPENED").ok, false);
  assert.equal(transitionHoldoutLifecycle("CONSUMED", "DIAGNOSTIC_ONLY").ok, true);
});

test("DIAGNOSTIC_ONLY is a terminal state — no transition out", () => {
  for (const next of ["SEALED", "OPENED", "CONSUMED"]) {
    assert.equal(transitionHoldoutLifecycle("DIAGNOSTIC_ONLY", next).ok, false);
  }
});

// --- hash chain integrity (unchanged core logic) ---------------------------

function threeEventLedger() {
  const a1 = "author_0000000000000000000000d1";
  const a2 = "author_0000000000000000000000d2";
  const a3 = "author_0000000000000000000000d3";
  let log = [];
  log = appendOrThrow(log, {
    assignmentId: a1,
    runId: "run_chain_1",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional(a1, "DEV_TUNE"),
  });
  log = appendOrThrow(log, {
    assignmentId: a2,
    runId: "run_chain_2",
    usageKind: "TUNING",
    executedSplit: "DEV_TUNE",
    runPurpose: "FLOW_SELECTION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a2, "DEV_TUNE"),
  });
  log = appendOrThrow(log, {
    assignmentId: a3,
    runId: "run_chain_3",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a3, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  });
  return log;
}

test("validateUsageLedger passes on an untouched, valid three-event ledger", () => {
  assert.deepEqual(validateUsageLedger(threeEventLedger()), []);
});

test("validateUsageLedger detects a modified middle row", () => {
  const log = threeEventLedger();
  const tampered = [...log];
  tampered[1] = { ...tampered[1], chain_ids_at_use: ["chain_injected"] }; // event_hash now stale
  assert.ok(validateUsageLedger(tampered).length > 0);
});

test("validateUsageLedger detects a deleted middle row", () => {
  const log = threeEventLedger();
  const tampered = [log[0], log[2]]; // row 1 removed, row 2's previous_log_hash now dangles
  assert.ok(validateUsageLedger(tampered).length > 0);
});

test("validateUsageLedger detects reordered rows", () => {
  const log = threeEventLedger();
  const tampered = [log[0], log[2], log[1]]; // swapped
  assert.ok(validateUsageLedger(tampered).length > 0);
});

test("validateUsageLedger detects a forged event_hash that doesn't match the event's own content", () => {
  const log = threeEventLedger();
  const tampered = [...log];
  tampered[0] = { ...tampered[0], event_hash: "f".repeat(64) };
  assert.ok(validateUsageLedger(tampered).length > 0);
});

// --- ledger-wide run identity: two events sharing a run_id must agree on
// executed_split/usage_kind/run_purpose/configuration_sha256/git_commit —
// checked even when each event's OWN hash-chain fields are internally
// valid, and even for a log that never went through appendUsageEvent's own
// per-append RUN_IDENTITY_MISMATCH gate (e.g. two independently produced
// logs merged together by some other process). --------------------------

test("validateUsageLedger detects a run_id whose events disagree on configuration_sha256, even though every individual event's hash chain is internally valid", () => {
  const a1 = "author_0000000000000000000000t1";
  const a2 = "author_0000000000000000000000t2";
  const eventA = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_merged_config_mismatch",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  })[0];

  // Hand-constructed (not via appendUsageEvent, which would itself reject
  // this via RUN_IDENTITY_MISMATCH) — its own hash-chain fields are
  // computed correctly and DO link to eventA, so this isolates the
  // ledger-wide identity check from the separately tested hash-chain
  // integrity check.
  const eventBWithoutHash = {
    schema_version: "0.2.0",
    usage_event_id: "eval_usage_2222222222222222222222",
    assignment_id: a2,
    question_id: null,
    run_id: "run_merged_config_mismatch", // SAME run_id as eventA
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "CRITICAL_REGRESSION_CHECK",
    run_outcome: "SUCCESS",
    used_at: "2026-08-10T09:05:00Z",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    git_commit: null,
    configuration_sha256: OTHER_CONFIG_HASH, // DIFFERENT from eventA
    notes: null,
    previous_log_hash: eventA.event_hash,
  };
  const eventB = { ...eventBWithoutHash, event_hash: computeEventHashForTest(eventBWithoutHash) };

  const merged = [eventA, eventB];
  const errors = validateUsageLedger(merged);
  assert.ok(
    !errors.some((error) => error.includes("hash chain") || error.includes("forged")),
    "the hash chain itself must be fully valid — this test isolates the identity check",
  );
  assert.ok(errors.some((error) => error.includes("inconsistent configuration_sha256")));
});

test("validateUsageLedger detects a run_id whose events disagree on run_purpose, even though every individual event's hash chain is internally valid", () => {
  const a1 = "author_0000000000000000000000t3";
  const a2 = "author_0000000000000000000000t4";
  const eventA = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_merged_purpose_mismatch",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  })[0];

  const eventBWithoutHash = {
    schema_version: "0.2.0",
    usage_event_id: "eval_usage_3333333333333333333333",
    assignment_id: a2,
    question_id: null,
    run_id: "run_merged_purpose_mismatch", // SAME run_id as eventA
    usage_kind: "FINAL_HOLDOUT",
    executed_split: "HOLDOUT",
    run_purpose: "DIAGNOSTIC_ONLY", // DIFFERENT from eventA's FINAL_HOLDOUT_EVALUATION
    run_outcome: "SUCCESS",
    used_at: "2026-08-10T09:05:00Z",
    assigned_split_at_use: "HOLDOUT",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "DIAGNOSTIC_ONLY", // required for a well-shaped DIAGNOSTIC_ONLY event on its own
    chain_ids_at_use: [],
    git_commit: null,
    configuration_sha256: CONFIG_HASH,
    notes: null,
    previous_log_hash: eventA.event_hash,
  };
  const eventB = { ...eventBWithoutHash, event_hash: computeEventHashForTest(eventBWithoutHash) };

  const merged = [eventA, eventB];
  const errors = validateUsageLedger(merged);
  assert.ok(
    !errors.some((error) => error.includes("hash chain") || error.includes("forged")),
    "the hash chain itself must be fully valid — this test isolates the identity check",
  );
  assert.ok(errors.some((error) => error.includes("inconsistent run_purpose")));
});

test("a merged ledger with a broken run identity is rejected via the existing LEDGER_CORRUPT path at both canUseSplit and appendUsageEvent", () => {
  const a1 = "author_0000000000000000000000t5";
  const a2 = "author_0000000000000000000000t6";
  const eventA = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_merged_gate_check",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  })[0];
  const eventBWithoutHash = {
    schema_version: "0.2.0",
    usage_event_id: "eval_usage_4444444444444444444444",
    assignment_id: a2,
    question_id: null,
    run_id: "run_merged_gate_check",
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "CRITICAL_REGRESSION_CHECK",
    run_outcome: "SUCCESS",
    used_at: "2026-08-10T09:05:00Z",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    git_commit: "commit-b",
    configuration_sha256: CONFIG_HASH,
    notes: null,
    previous_log_hash: eventA.event_hash,
  };
  const eventB = { ...eventBWithoutHash, event_hash: computeEventHashForTest(eventBWithoutHash) };
  const merged = [eventA, eventB]; // eventA.git_commit is null, eventB's is "commit-b"

  const a7 = "author_0000000000000000000000t7";
  const gateResult = canUseSplit({
    log: merged,
    assignmentId: a7,
    runId: "run_after_merged_gate_check",
    lifecycleState: lifecycle(a7, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(gateResult.ok, false);
  assert.equal(gateResult.code, "LEDGER_CORRUPT");

  const appendResult = appendUsageEvent(merged, {
    assignmentId: a7,
    runId: "run_after_merged_gate_check",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional(a7, "DEV_TUNE"),
  });
  assert.equal(appendResult.ok, false);
  assert.equal(appendResult.code, "LEDGER_CORRUPT");
});

// --- 4 (schema note). LEDGER_CORRUPT fail-closed ---------------------------

test("canUseSplit rejects a corrupted ledger as LEDGER_CORRUPT instead of evaluating budget against it", () => {
  const corrupted = [...threeEventLedger()];
  corrupted[1] = { ...corrupted[1], chain_ids_at_use: ["chain_injected"] };
  const result = canUseSplit({
    log: corrupted,
    assignmentId: "author_0000000000000000000000d9",
    runId: "run_after_corruption",
    lifecycleState: lifecycle("author_0000000000000000000000d9", "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LEDGER_CORRUPT");
});

test("appendUsageEvent rejects appending onto a corrupted ledger as LEDGER_CORRUPT", () => {
  const corrupted = [...threeEventLedger()];
  corrupted[1] = { ...corrupted[1], chain_ids_at_use: ["chain_injected"] };
  const result = appendUsageEvent(corrupted, {
    assignmentId: "author_0000000000000000000000d8",
    runId: "run_after_corruption_2",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional("author_0000000000000000000000d8", "DEV_TUNE"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LEDGER_CORRUPT");
});

test("a corrupted ledger that HIDES a used HOLDOUT run cannot be used to bypass the budget check (gate rejects the corruption itself, never falls through to a budget check against tampered data)", () => {
  const a1 = "author_0000000000000000000000d7";
  const a2 = "author_0000000000000000000000d6";
  let log = appendOrThrow([], {
    assignmentId: a1,
    runId: "run_holdout_hidden",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(a1, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  // attacker deletes the only HOLDOUT usage event to make the budget look untouched
  const tampered = [];
  const result = canUseSplit({
    log: tampered,
    assignmentId: a2,
    runId: "run_holdout_after_delete",
    lifecycleState: lifecycle(a2, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  // deleting down to an empty (individually "valid-shaped") log is itself
  // undetectable BY THIS MODULE ALONE without an external anchor (see the
  // module's KNOWN LIMITATION) — the meaningful, testable guarantee is that
  // a PARTIALLY tampered log (the realistic accidental-corruption/naive-edit
  // case) is caught, which the sibling tests above already cover. This test
  // documents the boundary: an attacker who deletes back to a genuinely
  // empty, internally-consistent log is out of this module's threat model.
  assert.equal(result.ok, true, "documenting the known limitation: an attacker who deletes ALL prior events leaves a validly-empty log this module cannot distinguish from a truly fresh ledger");
  assert.equal(log.length, 1);
});

// --- 5. 불변성 ---------------------------------------------------------------

test("appendUsageEvent never mutates the input log — returns a new array, and every event (including nested chain_ids_at_use) is deep-frozen", () => {
  const before = threeEventLedger();
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const assignmentId = "author_0000000000000000000000g1";
  const result = appendUsageEvent(before, {
    assignmentId,
    runId: "run_extra",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional(assignmentId, "DEV_TUNE"),
    chainIdsAtUse: ["chain_a", "chain_b"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(before, beforeSnapshot, "the original log array/entries must not be mutated");
  assert.notEqual(result.log, before, "appendUsageEvent must return a NEW array");
  assert.throws(() => { result.event.chain_ids_at_use.push("forged"); }, TypeError);
  assert.throws(() => { result.event.chain_ids_at_use[0] = "forged"; }, TypeError);
  assert.deepEqual(result.event.chain_ids_at_use, ["chain_a", "chain_b"]);
});

test("nested chain_ids_at_use on an event already in the ledger cannot be mutated either", () => {
  const log = threeEventLedger();
  assert.throws(() => { log[0].chain_ids_at_use.push("forged"); }, TypeError);
});

// --- 6. 이벤트 ID: proactive duplicate rejection, not just later validation --

test("appendUsageEvent proactively rejects a repeat of the exact same assignment+run+timestamp at append time, not just via a later validateUsageLedger() call", () => {
  const assignmentId = "author_0000000000000000000000p1";
  const input = {
    assignmentId,
    runId: "run_dup_1",
    usageKind: "SANDBOX",
    executedSplit: "SANDBOX",
    runPurpose: "SANDBOX_EXPLORATION",
    runOutcome: "SUCCESS",
    lifecycleState: provisional(assignmentId, "DEV_TUNE"),
  };
  const first = appendUsageEvent([], input, { now: () => "2026-08-10T09:00:00Z" });
  assert.equal(first.ok, true);
  // identical assignment/run/timestamp -> DUPLICATE_RUN_ASSIGNMENT now
  // catches this earlier and more specifically than the usage_event_id
  // collision it would also produce (see the dedicated
  // DUPLICATE_RUN_ASSIGNMENT tests below for the general case).
  const second = appendUsageEvent(first.log, input, { now: () => "2026-08-10T09:00:00Z" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "DUPLICATE_RUN_ASSIGNMENT");
});

// --- same run, same assignment recorded twice: DUPLICATE_RUN_ASSIGNMENT ---
// used_at/run_outcome differing must not matter — a genuine retry needs a
// NEW run_id, which is then subject to the budget rules again.

test("the SAME assignment recorded a SECOND time under the SAME run_id is rejected as DUPLICATE_RUN_ASSIGNMENT, even with a different used_at", () => {
  const assignmentId = "author_0000000000000000000000s1";
  let log = appendOrThrowAt([], {
    assignmentId,
    runId: "run_dup_assignment_1",
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  }, "2026-08-10T09:00:00Z");
  const result = appendUsageEvent(log, {
    assignmentId,
    runId: "run_dup_assignment_1", // same run_id, same assignment
    usageKind: "CHECKPOINT",
    executedSplit: "DEV_CHECK",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    configurationSha256: CONFIG_HASH,
  }, { now: () => "2026-08-10T09:05:00Z" }); // different used_at
  assert.equal(result.ok, false);
  assert.equal(result.code, "DUPLICATE_RUN_ASSIGNMENT");
});

test("a FAILURE first attempt for an assignment, retried as SUCCESS under the SAME run_id, is rejected as DUPLICATE_RUN_ASSIGNMENT", () => {
  const assignmentId = "author_0000000000000000000000s2";
  let log = appendOrThrowAt([], {
    assignmentId,
    runId: "run_dup_assignment_2",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "FAILURE",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  }, "2026-08-10T09:00:00Z");
  const retry = appendUsageEvent(log, {
    assignmentId,
    runId: "run_dup_assignment_2", // same run_id — a genuine retry needs a NEW one
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  }, { now: () => "2026-08-10T09:10:00Z" });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "DUPLICATE_RUN_ASSIGNMENT");
});

test("a retry with a genuinely NEW run_id is allowed (and is subject to the budget rules again)", () => {
  const assignmentId = "author_0000000000000000000000s3";
  let log = appendOrThrow([], {
    assignmentId,
    runId: "run_dup_assignment_3a",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "FAILURE",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    configurationSha256: CONFIG_HASH,
  });
  // a NEW run_id is a genuinely new run, which the budget rules apply to
  // again — since MAX_HOLDOUT_FINAL_RUNS=1 and the first (failed) run_id
  // already consumed it, the new run_id is correctly rejected on budget
  // grounds, not treated as a free continuation.
  const result = canUseSplit({
    log,
    assignmentId,
    runId: "run_dup_assignment_3b",
    lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "HOLDOUT_FINAL_BUDGET_EXHAUSTED");
});

test("DUPLICATE_RUN_ASSIGNMENT does not interfere with the SAME run_id recording 100 DIFFERENT assignments", () => {
  let log = [];
  for (let i = 1; i <= 100; i += 1) {
    const assignmentId = `author_${String(i).padStart(6, "0")}111111111111111111`;
    log = appendOrThrow(log, {
      assignmentId,
      runId: "run_no_dup_interference",
      usageKind: "FINAL_HOLDOUT",
      executedSplit: "HOLDOUT",
      runPurpose: "FINAL_HOLDOUT_EVALUATION",
      runOutcome: "SUCCESS",
      lifecycleState: lifecycle(assignmentId, "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
      configurationSha256: CONFIG_HASH,
    });
  }
  assert.equal(log.length, 100);
});

// --- 10. 정상 DEV_CHECK 2회 + 정상 HOLDOUT 1회 통과 --------------------------

test("a full valid flow passes: 2 successful DEV_CHECK runs (budget exactly used) + 1 successful HOLDOUT final run", () => {
  let log = [];

  for (let i = 1; i <= MAX_DEV_CHECK_RUNS; i += 1) {
    const assignmentId = `author_00000000000000000000q${i}0`;
    log = appendOrThrow(log, {
      assignmentId,
      runId: `run_ok_check_${i}`,
      usageKind: "CHECKPOINT",
      executedSplit: "DEV_CHECK",
      runPurpose: "CRITICAL_REGRESSION_CHECK",
      runOutcome: "SUCCESS",
      lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
      configurationSha256: CONFIG_HASH,
    });
  }

  const holdoutAssignment = "author_00000000000000000000q99";
  let holdoutLifecycle = lifecycle(holdoutAssignment, "HOLDOUT", { holdout_lifecycle_status: "SEALED" });
  const opened = transitionHoldoutLifecycle(holdoutLifecycle.holdout_lifecycle_status, "OPENED");
  assert.equal(opened.ok, true);
  holdoutLifecycle = { ...holdoutLifecycle, holdout_lifecycle_status: opened.status };

  log = appendOrThrow(log, {
    assignmentId: holdoutAssignment,
    runId: "run_ok_holdout",
    usageKind: "FINAL_HOLDOUT",
    executedSplit: "HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    runOutcome: "SUCCESS",
    lifecycleState: holdoutLifecycle,
    configurationSha256: CONFIG_HASH,
  });

  assert.deepEqual(validateUsageLedger(log), []);
  assert.equal(log.length, MAX_DEV_CHECK_RUNS + 1);

  // budget is now exhausted for both
  const thirdCheck = canUseSplit({
    log,
    assignmentId: "author_00000000000000000000q00",
    runId: "run_ok_check_extra",
    lifecycleState: lifecycle("author_00000000000000000000q00", "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(thirdCheck.ok, false);
  assert.equal(thirdCheck.code, "DEV_CHECK_BUDGET_EXHAUSTED");

  const secondHoldout = canUseSplit({
    log,
    assignmentId: "author_00000000000000000000q98",
    runId: "run_ok_holdout_extra",
    lifecycleState: lifecycle("author_00000000000000000000q98", "HOLDOUT", { holdout_lifecycle_status: "OPENED" }),
    executedSplit: "HOLDOUT",
    usageKind: "FINAL_HOLDOUT",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(secondHoldout.ok, false);
  assert.equal(secondHoldout.code, "HOLDOUT_FINAL_BUDGET_EXHAUSTED");
});

// --- pre-flight existence checks -------------------------------------------

test("canUseSplit rejects a DEV_CHECK/HOLDOUT attempt with no recognized run_purpose", () => {
  const assignmentId = "author_0000000000000000000000h1a";
  const result = canUseSplit({
    assignmentId,
    runId: "run_no_purpose",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: undefined,
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RUN_PURPOSE_REQUIRED");
});

test("canUseSplit rejects a DEV_CHECK/HOLDOUT attempt with no candidate configuration hash", () => {
  const assignmentId = "author_0000000000000000000000h2a";
  const result = canUseSplit({
    assignmentId,
    runId: "run_no_hash",
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "CANDIDATE_HASH_REQUIRED");
});

test("canUseSplit rejects a missing runId", () => {
  const assignmentId = "author_0000000000000000000000h3a";
  const result = canUseSplit({
    assignmentId,
    lifecycleState: lifecycle(assignmentId, "DEV_CHECK"),
    executedSplit: "DEV_CHECK",
    usageKind: "CHECKPOINT",
    runPurpose: "CRITICAL_REGRESSION_CHECK",
    configurationSha256: CONFIG_HASH,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_USAGE_INPUT");
});

test("USAGE_LEDGER_CODES enumerates every code this module can return", () => {
  for (const code of [
    "LEDGER_CORRUPT",
    "LIFECYCLE_ASSIGNMENT_MISMATCH",
    "PROVISIONAL_SPLIT_FORBIDS_OFFICIAL_USE",
    "ASSIGNED_SPLIT_MISMATCH",
    "TUNING_LOCKED_ASSIGNMENT_CANNOT_BE_PROMOTED",
    "ASSIGNMENT_SPLIT_HISTORY_MISMATCH",
    "DUPLICATE_RUN_ASSIGNMENT",
    "RUN_IDENTITY_MISMATCH",
    "DEV_CHECK_BUDGET_EXHAUSTED",
    "HOLDOUT_FINAL_BUDGET_EXHAUSTED",
    "HOLDOUT_SEALED",
    "HOLDOUT_ALREADY_CONSUMED",
    "HOLDOUT_DIAGNOSTIC_REQUIRES_DIAGNOSTIC_ONLY_STATE",
    "INVALID_LIFECYCLE_TRANSITION",
    "DUPLICATE_USAGE_EVENT_ID",
  ]) {
    assert.ok(USAGE_LEDGER_CODES.includes(code), code);
  }
});

// --- minimal disk persistence: atomic append + corruption detection -------

// Turn N2.2: each of the three tests below previously created its own
// mkdtempSync() scratch directory and never removed it -- neither on a
// clean pass nor (more importantly) if the assertion in between threw.
// try/finally guarantees removal on both paths, matching the established
// convention used elsewhere in this test suite (e.g.
// reference-release-contract.test.mjs's mkdtemp/finally pattern).
test("readLedgerFile returns [] for a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  try {
    assert.deepEqual(readLedgerFile(join(dir, "does-not-exist.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEventLineAtomic + readLedgerFile round-trip a valid ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  try {
    const filePath = join(dir, "ledger.jsonl");
    const log = threeEventLedger();
    for (const event of log) appendEventLineAtomic(filePath, event);
    const loaded = readLedgerFile(filePath);
    assert.deepEqual(loaded, log);
    assert.deepEqual(validateUsageLedger(loaded), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerFile throws on a corrupt (non-JSON) line instead of silently skipping it", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  try {
    const filePath = join(dir, "ledger.jsonl");
    writeFileSync(filePath, '{"valid": "json"}\nthis is not json\n', "utf8");
    assert.throws(() => readLedgerFile(filePath), /corrupt ledger file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- source hygiene: no stray raw NUL bytes in the module's own source ---
// A previous round accidentally embedded one raw NUL control-character
// byte (not a JS escape sequence, an actual byte) into a composite-key
// template literal, which made the source file register as binary,
// breaking file-type detection and text-search tools on it.
// JSON.stringify([a, b]) is used for composite keys instead, specifically
// to avoid ever needing a raw separator byte again.

test("domain/runtime/evaluation-usage-ledger.mjs contains zero raw NUL bytes", async () => {
  const { readFileSync: readRaw } = await import("node:fs");
  const moduleUrl = new URL("../domain/runtime/evaluation-usage-ledger.mjs", import.meta.url);
  const bytes = readRaw(moduleUrl);
  const nulCount = bytes.filter((byte) => byte === 0).length;
  assert.equal(nulCount, 0);
});
