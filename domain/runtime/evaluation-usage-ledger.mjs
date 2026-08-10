// Evaluation Usage Ledger + Split Lifecycle (CLAUDE.md sections 11-12;
// domain/evaluation/README.md's "Usage freeze and late chain discovery").
//
// This module is NOT about how many Gold questions exist in each split —
// domain/evaluation/README.md's 500-question table predates the current
// final sizing (DEV_TUNE 150 / DEV_CHECK 50 / HOLDOUT 100) and is not
// touched here. This module is about USAGE CONTROL: once a split exists,
// what stops it from being peeked at, reused, or promoted past its
// intended lifecycle.
//
// Two independent concerns, two independent APIs:
//   1. The append-only Usage Event ledger (evaluation-usage-event.schema.json
//      v0.2) — a tamper-evident hash-chained log of every execution attempt.
//   2. Split Lifecycle state (evaluation-split-lifecycle.schema.json v0.1) —
//      per-assignment assigned_split (fixed at authoring time), plus TWO
//      further independent axes: split_lock_status and
//      holdout_lifecycle_status (see transitionSplitLock/
//      transitionHoldoutLifecycle below). Never merge these into one enum:
//      an assignment can be LOCKED_BY_CHAIN (lock axis) while its
//      holdout_lifecycle_status is still SEALED (lifecycle axis) — they
//      answer different questions, and assigned_split answers a third,
//      even more basic one ("which split was this ALWAYS meant for").
//
// Trust boundary: canUseSplit is the fail-closed PRE-execution check —
// call it before running anything, and treat any run_purpose/candidate
// hash/lifecycle-state/run-identity gap as a rejection, not a warning.
// appendUsageEvent does NOT trust that canUseSplit was already called: it
// re-runs the exact same gate itself before ever appending, so there is no
// way to add an event to the ledger that canUseSplit would have refused.
// There is no exported function that mutates or removes an existing event —
// the only way this ledger changes is by appending, and appendUsageEvent
// always returns a NEW, deep-frozen array, never mutating the one it was
// given.
//
// RUN IDENTITY: a run_id names ONE execution context that can span many
// assignments (e.g. one HOLDOUT run_id covering all ~100 HOLDOUT
// questions). The FIRST event recorded under a run_id fixes that run's
// identity — executed_split, usage_kind, run_purpose,
// configuration_sha256, git_commit — for every later event under the SAME
// run_id. A later append that disagrees on any of those fields is
// RUN_IDENTITY_MISMATCH, not a new run and not silently accepted: it would
// otherwise let someone smuggle a configuration change into an
// already-budgeted run.
//
// POLICY — does a FAILED run count toward the DEV_CHECK/HOLDOUT budget?
// Yes. A DISTINCT run_id consumes the budget the instant it is first
// recorded against DEV_CHECK/HOLDOUT, regardless of whether that run's
// outcome is later SUCCESS or FAILURE. There is no "it failed, so it
// doesn't count" exemption: this module cannot currently distinguish "the
// harness crashed before ever loading DEV_CHECK/HOLDOUT data" from "the
// harness loaded and scored the data, then crashed while writing results"
// — and treating the former as free would let someone repeatedly claim
// FAILURE to re-roll unlimited attempts against held-out data. A real
// FAILURE is still appended (audit completeness — the attempt genuinely
// happened) but grants no extra budget: exhausting the run budget with
// FAILUREs is exhausting it for real. A future round could add a
// dedicated exposure_started/attempt state recorded BEFORE data is loaded,
// which would let a true "crashed before touching anything" case be
// exempted — that state does not exist yet, so the safe default is "every
// recorded official execution attempt is exposure."
//
// KNOWN LIMITATION — hash chain, not a tamper-proof ledger: previous_log_hash
// / event_hash form a simple LINEAR hash chain. This reliably detects
// accidental corruption and naive tampering (editing one entry without
// recomputing everything downstream, deleting an entry without relinking
// around it, reordering entries). It does NOT defend against a fully
// privileged attacker who edits a whole suffix of the file consistently
// AND relinks around a deletion — that requires an external anchor
// (append-only storage, periodic checksums published elsewhere, etc.),
// which is out of scope here. canUseSplit and appendUsageEvent both
// re-validate the WHOLE chain (validateUsageLedger) before trusting it for
// anything — a corrupt ledger is LEDGER_CORRUPT, fail-closed, never
// silently trusted for a budget/lifecycle decision.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  EVALUATION_SPLITS,
  HOLDOUT_LIFECYCLE_STATUSES,
  ids,
  RUN_OUTCOMES,
  RUN_PURPOSES,
  RUN_PURPOSE_TO_SPLITS,
  SPLIT_LOCK_STATUSES,
  USAGE_KIND_TO_SPLIT,
  validateEvaluationUsageEvent,
} from "../contracts.mjs";

export const USAGE_LEDGER_CODES = Object.freeze([
  "INVALID_USAGE_INPUT",
  "LEDGER_CORRUPT",
  "LIFECYCLE_ASSIGNMENT_MISMATCH",
  "PROVISIONAL_SPLIT_FORBIDS_OFFICIAL_USE",
  "ASSIGNED_SPLIT_MISMATCH",
  "TUNING_LOCKED_ASSIGNMENT_CANNOT_BE_PROMOTED",
  "ASSIGNMENT_SPLIT_HISTORY_MISMATCH",
  "DUPLICATE_RUN_ASSIGNMENT",
  "RUN_IDENTITY_MISMATCH",
  "RUN_PURPOSE_REQUIRED",
  "RUN_PURPOSE_SPLIT_MISMATCH",
  "CANDIDATE_HASH_REQUIRED",
  "DEV_CHECK_BUDGET_EXHAUSTED",
  "HOLDOUT_FINAL_BUDGET_EXHAUSTED",
  "HOLDOUT_SEALED",
  "HOLDOUT_NOT_OPENED_FOR_FINAL_RUN",
  "HOLDOUT_ALREADY_CONSUMED",
  "HOLDOUT_DIAGNOSTIC_REQUIRES_DIAGNOSTIC_ONLY_STATE",
  "INVALID_LIFECYCLE_TRANSITION",
  "LEDGER_INVALID_EVENT_SHAPE",
  "DUPLICATE_USAGE_EVENT_ID",
]);

// CLAUDE.md section 11: fixed by the competition's evaluation lifecycle,
// not a per-call parameter.
export const MAX_DEV_CHECK_RUNS = 2;
export const MAX_HOLDOUT_FINAL_RUNS = 1;

// Identity fields a run_id must stay consistent on for its entire
// lifetime — see the "RUN IDENTITY" module note above.
const RUN_IDENTITY_FIELDS = Object.freeze([
  ["executed_split", "executedSplit"],
  ["usage_kind", "usageKind"],
  ["run_purpose", "runPurpose"],
  ["configuration_sha256", "configurationSha256"],
  ["git_commit", "gitCommit"],
]);

function fail(code, message) {
  return { ok: false, code, message };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Hashes everything EXCEPT event_hash itself — the one field a hash can
// never authenticate its own value into.
function computeEventHash(eventWithoutHash) {
  return sha256Hex(JSON.stringify(canonicalize(eventWithoutHash)));
}

// Object.freeze is shallow — a frozen event whose chain_ids_at_use array
// is NOT itself frozen would still let `event.chain_ids_at_use.push(...)`
// silently mutate it in place. This freezes every nested object/array too.
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- pre-flight, fail-closed check -----------------------------------------

// Returns { ok: true } or { ok: false, code, message }. Never throws on
// malformed input — malformed input is exactly what this rejects.
export function canUseSplit({
  log = [],
  assignmentId,
  runId,
  lifecycleState = {},
  executedSplit,
  usageKind,
  runPurpose,
  configurationSha256,
  gitCommit = null,
} = {}) {
  if (typeof assignmentId !== "string" || assignmentId === "") {
    return fail("INVALID_USAGE_INPUT", "assignmentId is required");
  }
  if (typeof runId !== "string" || runId === "") {
    return fail("INVALID_USAGE_INPUT", "runId is required");
  }
  if (!["SANDBOX", "DEV_TUNE", "DEV_CHECK", "HOLDOUT"].includes(executedSplit)) {
    return fail("INVALID_USAGE_INPUT", "invalid executedSplit");
  }
  if (USAGE_KIND_TO_SPLIT[usageKind] !== executedSplit) {
    return fail("INVALID_USAGE_INPUT", "usageKind does not match executedSplit");
  }

  // A corrupt ledger is never trusted for a budget/lifecycle decision —
  // gate on this before reading `log` for anything else.
  const ledgerErrors = validateUsageLedger(log);
  if (ledgerErrors.length > 0) {
    return fail("LEDGER_CORRUPT", ledgerErrors.join("; "));
  }

  if (typeof lifecycleState.assignment_id !== "string" || lifecycleState.assignment_id === "") {
    return fail("INVALID_USAGE_INPUT", "lifecycleState.assignment_id is required");
  }
  if (lifecycleState.assignment_id !== assignmentId) {
    return fail(
      "LIFECYCLE_ASSIGNMENT_MISMATCH",
      `lifecycleState belongs to ${lifecycleState.assignment_id}, not the requested assignmentId ${assignmentId}`,
    );
  }
  if (!EVALUATION_SPLITS.includes(lifecycleState.assigned_split)) {
    return fail("INVALID_USAGE_INPUT", "invalid lifecycleState.assigned_split");
  }

  const splitLockStatus = lifecycleState.split_lock_status;
  if (!SPLIT_LOCK_STATUSES.includes(splitLockStatus)) {
    return fail("INVALID_USAGE_INPUT", "invalid lifecycleState.split_lock_status");
  }

  // Provisional (not yet chain-closure-locked): the ONLY allowed execution
  // is SANDBOX, regardless of assigned_split. Once locked, assigned_split
  // becomes authoritative and SANDBOX is no longer available at all — an
  // assignment locked to HOLDOUT cannot be run as SANDBOX any more than it
  // can be run as DEV_TUNE, and an assignment locked to DEV_CHECK cannot
  // be run as HOLDOUT, DEV_TUNE, OR SANDBOX.
  if (splitLockStatus === "PROVISIONAL_UNTIL_CHAIN_CLOSURE") {
    if (executedSplit !== "SANDBOX") {
      return fail("PROVISIONAL_SPLIT_FORBIDS_OFFICIAL_USE", "a provisional assignment can only be executed as SANDBOX");
    }
  } else if (executedSplit !== lifecycleState.assigned_split) {
    return fail(
      "ASSIGNED_SPLIT_MISMATCH",
      `this assignment is locked and pinned to ${lifecycleState.assigned_split}; it cannot be executed as ${executedSplit}`,
    );
  }

  // README's "tuning_locked": once an assignment has been used in
  // DEV_TUNE, it can never be promoted to a different official split.
  // Kept as its own specific check (ahead of the general history check
  // below) so the DEV_TUNE case keeps its own specific, established code.
  if (executedSplit !== "DEV_TUNE" && executedSplit !== "SANDBOX") {
    const everTuned = log.some((event) => event.assignment_id === assignmentId && event.executed_split === "DEV_TUNE");
    if (everTuned) {
      return fail(
        "TUNING_LOCKED_ASSIGNMENT_CANNOT_BE_PROMOTED",
        "this assignment was already used in DEV_TUNE and cannot be promoted to another official split",
      );
    }
  }

  // The LEDGER's OWN observed history of past OFFICIAL (non-SANDBOX) usage
  // for this assignment is authoritative — independent of whatever the
  // CALLER's lifecycleState.assigned_split currently claims. A caller
  // (or a stale/edited lifecycle record) claiming assigned_split=HOLDOUT
  // for an assignment the ledger already shows was used as DEV_CHECK must
  // still be rejected, even though assigned_split and executedSplit agree
  // with EACH OTHER — they don't agree with what actually happened. Covers
  // every official-to-official move (DEV_CHECK<->HOLDOUT, and also
  // DEV_CHECK/HOLDOUT -> DEV_TUNE, which the DEV_TUNE-specific check above
  // does not, since that one only guards the DEV_TUNE -> other direction).
  // SANDBOX is never treated as official history (see the module's SANDBOX
  // note above) and never reaches this check itself since executedSplit
  // === "SANDBOX" is excluded below.
  if (executedSplit !== "SANDBOX") {
    const historicalOfficialSplits = new Set(
      log
        .filter((event) => event.assignment_id === assignmentId && event.executed_split !== "SANDBOX")
        .map((event) => event.executed_split),
    );
    if (historicalOfficialSplits.size > 0 && !historicalOfficialSplits.has(executedSplit)) {
      return fail(
        "ASSIGNMENT_SPLIT_HISTORY_MISMATCH",
        `assignment ${assignmentId} was previously recorded under official split(s) ${[...historicalOfficialSplits].sort().join(", ")}; cannot now execute as ${executedSplit}`,
      );
    }
  }

  // A run_id names ONE execution context that may span MANY assignments
  // (e.g. one HOLDOUT run_id covering 100 questions), but each assignment
  // may appear under it AT MOST ONCE — used_at/run_outcome differing does
  // not matter, and a FAILURE does not grant a free re-run under the SAME
  // run_id. A genuine retry needs a NEW run_id, which is then subject to
  // the budget rules again (see the POLICY note above).
  const priorRunEvents = log.filter((event) => event.run_id === runId);
  if (priorRunEvents.some((event) => event.assignment_id === assignmentId)) {
    return fail(
      "DUPLICATE_RUN_ASSIGNMENT",
      `assignment ${assignmentId} was already recorded under run_id ${runId} — retry with a new run_id instead`,
    );
  }

  // Run identity: whatever the FIRST event under this run_id declared for
  // these fields is binding for every later event under the same run_id.
  const priorRunEvent = priorRunEvents[0] ?? null;
  if (priorRunEvent) {
    const currentValues = { executedSplit, usageKind, runPurpose, configurationSha256, gitCommit };
    for (const [eventField, inputField] of RUN_IDENTITY_FIELDS) {
      const priorValue = priorRunEvent[eventField] ?? null;
      const currentValue = currentValues[inputField] ?? null;
      if (priorValue !== currentValue) {
        return fail(
          "RUN_IDENTITY_MISMATCH",
          `run_id ${runId} was first recorded with ${eventField}=${JSON.stringify(priorValue)}; this call disagrees with ${JSON.stringify(currentValue)}`,
        );
      }
    }
  }
  const isNewRun = !priorRunEvent;

  if (executedSplit === "DEV_CHECK" || executedSplit === "HOLDOUT") {
    if (!RUN_PURPOSES.includes(runPurpose)) {
      return fail("RUN_PURPOSE_REQUIRED", "a recognized run_purpose is required before DEV_CHECK/HOLDOUT execution");
    }
    if (!RUN_PURPOSE_TO_SPLITS[runPurpose].includes(executedSplit)) {
      return fail("RUN_PURPOSE_SPLIT_MISMATCH", `run_purpose ${runPurpose} cannot be used with executed_split ${executedSplit}`);
    }
    if (typeof configurationSha256 !== "string" || !/^[0-9a-f]{64}$/.test(configurationSha256)) {
      return fail("CANDIDATE_HASH_REQUIRED", "a candidate configuration_sha256 is required before DEV_CHECK/HOLDOUT execution");
    }
  }

  // Budget: a DISTINCT run_id consumes the budget the moment it is first
  // recorded (see the POLICY note above — outcome-agnostic on purpose). A
  // run_id already present in the log (a continuation — e.g. the 2nd of
  // 100 HOLDOUT assignments under the same run) never consumes it again.
  if (executedSplit === "DEV_CHECK" && isNewRun) {
    const distinctRunIds = new Set(log.filter((event) => event.executed_split === "DEV_CHECK").map((event) => event.run_id));
    if (distinctRunIds.size >= MAX_DEV_CHECK_RUNS) {
      return fail("DEV_CHECK_BUDGET_EXHAUSTED", `DEV_CHECK has already been used in ${MAX_DEV_CHECK_RUNS} distinct run(s)`);
    }
  }

  if (executedSplit === "HOLDOUT") {
    const holdoutStatus = lifecycleState.holdout_lifecycle_status;
    if (!HOLDOUT_LIFECYCLE_STATUSES.includes(holdoutStatus)) {
      return fail("INVALID_USAGE_INPUT", "invalid lifecycleState.holdout_lifecycle_status");
    }
    if (holdoutStatus === "SEALED") {
      return fail("HOLDOUT_SEALED", "this HOLDOUT assignment is still SEALED — no execution, diagnostic or otherwise, is allowed yet");
    }
    if (runPurpose === "FINAL_HOLDOUT_EVALUATION") {
      if (holdoutStatus === "CONSUMED" || holdoutStatus === "DIAGNOSTIC_ONLY") {
        return fail(
          "HOLDOUT_ALREADY_CONSUMED",
          "this HOLDOUT assignment has already been consumed by an independent final run and cannot be reused as one",
        );
      }
      if (holdoutStatus !== "OPENED") {
        return fail("HOLDOUT_NOT_OPENED_FOR_FINAL_RUN", "a FINAL_HOLDOUT_EVALUATION run requires holdout_lifecycle_status=OPENED");
      }
      if (isNewRun) {
        const distinctFinalRunIds = new Set(
          log
            .filter((event) => event.usage_kind === "FINAL_HOLDOUT" && event.run_purpose === "FINAL_HOLDOUT_EVALUATION")
            .map((event) => event.run_id),
        );
        if (distinctFinalRunIds.size >= MAX_HOLDOUT_FINAL_RUNS) {
          return fail(
            "HOLDOUT_FINAL_BUDGET_EXHAUSTED",
            `HOLDOUT has already been used in ${MAX_HOLDOUT_FINAL_RUNS} independent final run(s)`,
          );
        }
      }
    }
    if (runPurpose === "DIAGNOSTIC_ONLY" && holdoutStatus !== "DIAGNOSTIC_ONLY") {
      return fail(
        "HOLDOUT_DIAGNOSTIC_REQUIRES_DIAGNOSTIC_ONLY_STATE",
        "a DIAGNOSTIC_ONLY-purpose run requires holdout_lifecycle_status=DIAGNOSTIC_ONLY",
      );
    }
  }

  return { ok: true };
}

// --- append-only ledger -----------------------------------------------------

// Returns { ok: true, log: newLog, event } or { ok: false, code, message }.
// Never mutates `log` — always returns a brand-new, deep-frozen array; the
// appended event object is itself deep-frozen too.
export function appendUsageEvent(log, input, { now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(log)) return fail("INVALID_USAGE_INPUT", "log must be an array");

  const {
    assignmentId,
    questionId = null,
    runId,
    usageKind,
    executedSplit,
    runPurpose,
    runOutcome,
    lifecycleState = {},
    chainIdsAtUse = [],
    gitCommit = null,
    configurationSha256 = null,
    notes = null,
  } = input ?? {};

  // Defense in depth: this does NOT trust that the caller already called
  // canUseSplit — it re-runs the identical gate itself (which itself
  // starts with the LEDGER_CORRUPT check — see canUseSplit).
  const gate = canUseSplit({
    log,
    assignmentId,
    runId,
    lifecycleState,
    executedSplit,
    usageKind,
    runPurpose,
    configurationSha256,
    gitCommit,
  });
  if (!gate.ok) return gate;

  if (!RUN_OUTCOMES.includes(runOutcome)) {
    return fail("INVALID_USAGE_INPUT", "runOutcome must be SUCCESS or FAILURE");
  }
  if (!Array.isArray(chainIdsAtUse)) {
    return fail("INVALID_USAGE_INPUT", "chainIdsAtUse must be an array");
  }

  const usedAt = now();
  const usageEventId = ids.evaluationUsage(assignmentId, runId, usedAt);

  // Proactive duplicate detection — never rely on a LATER
  // validateUsageLedger() call to be the only thing that would ever catch
  // this; reject it at append time instead.
  if (log.some((event) => event.usage_event_id === usageEventId)) {
    return fail(
      "DUPLICATE_USAGE_EVENT_ID",
      `usage_event_id ${usageEventId} (derived from assignmentId+runId+used_at) already exists in this ledger`,
    );
  }

  const previousEvent = log.length > 0 ? log[log.length - 1] : null;
  const previousLogHash = previousEvent ? previousEvent.event_hash : null;

  const eventWithoutHash = {
    schema_version: "0.2.0",
    usage_event_id: usageEventId,
    assignment_id: assignmentId,
    question_id: questionId,
    run_id: runId,
    usage_kind: usageKind,
    executed_split: executedSplit,
    run_purpose: runPurpose,
    run_outcome: runOutcome,
    used_at: usedAt,
    assigned_split_at_use: lifecycleState.assigned_split,
    split_lock_status_at_use: lifecycleState.split_lock_status,
    holdout_lifecycle_status_at_use: lifecycleState.holdout_lifecycle_status,
    chain_ids_at_use: [...chainIdsAtUse],
    git_commit: gitCommit,
    configuration_sha256: configurationSha256,
    notes,
    previous_log_hash: previousLogHash,
  };

  const event = deepFreeze({ ...eventWithoutHash, event_hash: computeEventHash(eventWithoutHash) });

  const shapeErrors = validateEvaluationUsageEvent(event);
  if (shapeErrors.length > 0) {
    return fail("LEDGER_INVALID_EVENT_SHAPE", shapeErrors.join("; "));
  }

  return { ok: true, log: deepFreeze([...log, event]), event };
}

// Returns an array of error strings; empty = a valid, unbroken, untampered
// ledger. Checks, per entry: schema shape, no duplicate usage_event_id,
// previous_log_hash links to the immediately preceding entry's event_hash
// (or null for the first entry), and event_hash matches a fresh
// recomputation of that entry's own content. Ledger-wide (not per-entry):
// no assignment_id appears more than once under the same run_id; no
// assignment_id has more than one distinct OFFICIAL (non-SANDBOX)
// executed_split across its whole history; and every event sharing a
// run_id agrees on executed_split/usage_kind/run_purpose/
// configuration_sha256/git_commit (RUN_IDENTITY_FIELDS) — any of these is
// itself corruption (a ledger that got here by any means other than this
// module's own append-time DUPLICATE_RUN_ASSIGNMENT/
// ASSIGNMENT_SPLIT_HISTORY_MISMATCH/RUN_IDENTITY_MISMATCH checks, e.g. a
// hand-edited or externally merged file), not merely something to reject
// going forward.
export function validateUsageLedger(log) {
  if (!Array.isArray(log)) return ["log must be an array"];

  const errors = [];
  const seenIds = new Set();
  const seenRunAssignments = new Set();
  const officialSplitsByAssignment = new Map();
  const identityByRun = new Map(); // run_id -> the first well-shaped event recorded under it
  let previousHash = null;

  for (const [index, event] of log.entries()) {
    const shapeErrors = validateEvaluationUsageEvent(event);
    if (shapeErrors.length > 0) {
      errors.push(`log[${index}]: ${shapeErrors.join("; ")}`);
      previousHash = event?.event_hash ?? previousHash;
      continue;
    }

    if (seenIds.has(event.usage_event_id)) {
      errors.push(`log[${index}]: duplicate usage_event_id ${event.usage_event_id}`);
    }
    seenIds.add(event.usage_event_id);

    const runAssignmentKey = JSON.stringify([event.run_id, event.assignment_id]);
    if (seenRunAssignments.has(runAssignmentKey)) {
      errors.push(`log[${index}]: assignment ${event.assignment_id} appears more than once under run_id ${event.run_id}`);
    }
    seenRunAssignments.add(runAssignmentKey);

    // Ledger-wide run identity: every event under the same run_id must
    // agree on these fields — canUseSplit's own RUN_IDENTITY_MISMATCH gate
    // only catches this going forward through the live append API; a log
    // assembled some OTHER way (loaded from disk, merged from multiple
    // sources) needs this checked here too, or an inconsistency could sit
    // in the ledger undetected until something happens to notice it.
    const priorIdentityEvent = identityByRun.get(event.run_id);
    if (priorIdentityEvent) {
      for (const [eventField] of RUN_IDENTITY_FIELDS) {
        const priorValue = priorIdentityEvent[eventField] ?? null;
        const currentValue = event[eventField] ?? null;
        if (priorValue !== currentValue) {
          errors.push(
            `log[${index}]: run_id ${event.run_id} has inconsistent ${eventField} across its events (first recorded as ${JSON.stringify(priorValue)}, this entry has ${JSON.stringify(currentValue)}) — run identity broken`,
          );
        }
      }
    } else {
      identityByRun.set(event.run_id, event);
    }

    if (event.executed_split !== "SANDBOX") {
      const splits = officialSplitsByAssignment.get(event.assignment_id) ?? new Set();
      splits.add(event.executed_split);
      officialSplitsByAssignment.set(event.assignment_id, splits);
    }

    if ((event.previous_log_hash ?? null) !== previousHash) {
      errors.push(`log[${index}]: previous_log_hash does not match the preceding event's event_hash — hash chain broken`);
    }

    const { event_hash: storedHash, ...withoutHash } = event;
    if (computeEventHash(withoutHash) !== storedHash) {
      errors.push(`log[${index}]: event_hash does not match this event's own content — forged or corrupted`);
    }

    previousHash = storedHash;
  }

  for (const [assignmentId, splits] of officialSplitsByAssignment.entries()) {
    if (splits.size > 1) {
      errors.push(
        `assignment ${assignmentId} has more than one official executed_split recorded in this ledger's history: ${[...splits].sort().join(", ")}`,
      );
    }
  }

  return errors;
}

// --- Split Lifecycle transitions --------------------------------------------

const SPLIT_LOCK_TRANSITIONS = Object.freeze({
  PROVISIONAL_UNTIL_CHAIN_CLOSURE: Object.freeze(["LOCKED_BY_CHAIN", "LOCKED_BY_COVERAGE"]),
  LOCKED_BY_CHAIN: Object.freeze([]),
  LOCKED_BY_COVERAGE: Object.freeze([]),
});

export function transitionSplitLock(current, next) {
  if (!SPLIT_LOCK_STATUSES.includes(current) || !SPLIT_LOCK_STATUSES.includes(next)) {
    return fail("INVALID_LIFECYCLE_TRANSITION", "unknown split_lock_status");
  }
  if (!(SPLIT_LOCK_TRANSITIONS[current] ?? []).includes(next)) {
    return fail("INVALID_LIFECYCLE_TRANSITION", `${current} -> ${next} is not an allowed split-lock transition`);
  }
  return { ok: true, status: next };
}

const HOLDOUT_LIFECYCLE_TRANSITIONS = Object.freeze({
  SEALED: Object.freeze(["OPENED"]),
  OPENED: Object.freeze(["CONSUMED"]),
  CONSUMED: Object.freeze(["DIAGNOSTIC_ONLY"]),
  DIAGNOSTIC_ONLY: Object.freeze([]),
});

export function transitionHoldoutLifecycle(current, next) {
  if (!HOLDOUT_LIFECYCLE_STATUSES.includes(current) || !HOLDOUT_LIFECYCLE_STATUSES.includes(next)) {
    return fail("INVALID_LIFECYCLE_TRANSITION", "unknown holdout_lifecycle_status");
  }
  if (!(HOLDOUT_LIFECYCLE_TRANSITIONS[current] ?? []).includes(next)) {
    return fail("INVALID_LIFECYCLE_TRANSITION", `${current} -> ${next} is not an allowed HOLDOUT lifecycle transition`);
  }
  return { ok: true, status: next };
}

// --- minimal disk persistence: JSONL, atomic single-line append -----------
//
// Deliberately minimal — a real Harness's storage needs are out of scope
// here (see the module header). This gives just enough to (a) load an
// existing ledger file and detect corruption (a line that isn't valid
// JSON, or a chain that doesn't validate), and (b) append one new event
// without a read-modify-write race on the WHOLE file.

export function readLedgerFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`corrupt ledger file at line ${index + 1}: ${error.message}`);
    }
  });
}

// A single appendFileSync call is one write(2) for a line this small,
// which POSIX guarantees appends atomically relative to other O_APPEND
// writers on the same file — no partial-line interleaving. This is NOT a
// transactional store; it is the minimal guarantee this module commits to
// (see the module header's KNOWN LIMITATION on the hash chain itself).
export function appendEventLineAtomic(filePath, event) {
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}
