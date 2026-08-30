// Turn P6 section A: the Dataset Record / Dataset Manifest contract a
// common Benchmark Runner accepts. This module is the ONE place a caller
// hands over a raw array of candidate DatasetRecords and gets back either
// (a) a validated DatasetManifest + the records themselves, ready to run,
// or (b) a thrown, fail-closed rejection -- there is no partial-load path.
//
// HOLDOUT GATE: reuses domain/runtime/evaluation-usage-ledger.mjs's
// canUseSplit UNMODIFIED (read-only import) as the actual "explicit unlock
// token" mechanism, rather than inventing a second, weaker HOLDOUT gate
// that could drift from the one the rest of this codebase already trusts
// (CLAUDE.md sections 11-12). No `holdoutUnlock` argument at all -> ANY
// HOLDOUT row present rejects the WHOLE load (HOLDOUT_UNLOCK_REQUIRED) --
// never "load everything except the HOLDOUT rows", which would silently
// let a caller believe a partial dataset was complete. A `holdoutUnlock`
// that canUseSplit itself rejects (wrong run_purpose, SEALED lifecycle,
// budget exhausted, ...) rejects the whole load too, with canUseSplit's
// own real code -- this module never re-implements or loosens that gate's
// own rules.
//
// SPLIT/CHAIN LEAKAGE: two items sharing an evaluation_group_id (e.g.
// paraphrases of the same underlying question) or a chain_component_id
// (the same decision-respecting-graph correction-chain component) must
// never be assigned to different splits -- a HOLDOUT item's own paraphrase
// leaking into DEV_TUNE would let that HOLDOUT question be effectively
// tuned against. checkSplitLeakage is fail-closed and total: it always
// runs, never opt-in, and a caller cannot proceed past a violation without
// fixing the input data.
import {
  canUseSplit,
} from "../../runtime/evaluation-usage-ledger.mjs";
import { validateDatasetRecord, validateDatasetManifest } from "./contracts.mjs";
import { computeDatasetItemsSha256 } from "./item-sha.mjs";

export class DatasetContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DatasetContractError";
    this.code = code;
  }
}

// Any (kind, key) pair whose member items' `split`s are not all identical
// is a violation -- reported once per (kind, key), listing every split
// observed for it (order-independent, sorted for determinism).
export function checkSplitLeakage(records) {
  const violations = [];
  for (const [kind, field] of [["EVALUATION_GROUP_ID", "evaluation_group_id"], ["CHAIN_COMPONENT_ID", "chain_component_id"]]) {
    const splitsByKey = new Map();
    for (const record of records) {
      const key = record[field];
      if (key === null || key === undefined) continue;
      if (!splitsByKey.has(key)) splitsByKey.set(key, new Set());
      splitsByKey.get(key).add(record.split);
    }
    for (const [key, splits] of splitsByKey.entries()) {
      if (splits.size > 1) {
        violations.push({ kind, key, splits: [...splits].sort() });
      }
    }
  }
  // Deterministic order: never depends on Map/Set iteration happening to
  // match insertion order across a JS engine version -- explicit sort.
  violations.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)));
  return violations;
}

// `holdoutUnlock`, when the dataset contains any HOLDOUT row, must be
// `{ log, runId, runPurpose, configurationSha256, gitCommit,
//    lifecycleStateByItemId: { [evaluation_item_id]: lifecycleState } }`
// -- lifecycleState is canUseSplit's own `lifecycleState` shape
// (assignment_id/assigned_split/split_lock_status/holdout_lifecycle_status).
// This module treats `evaluation_item_id` as canUseSplit's `assignmentId`.
function verifyHoldoutGate(holdoutRecords, holdoutUnlock) {
  if (holdoutRecords.length === 0) {
    return { holdout_item_count: 0, unlocked: false, unlock_run_purpose: null };
  }
  if (!holdoutUnlock) {
    throw new DatasetContractError(
      "HOLDOUT_UNLOCK_REQUIRED",
      `dataset contains ${holdoutRecords.length} HOLDOUT row(s) but no holdoutUnlock was supplied -- refusing to load any of it`,
    );
  }
  const { log = [], runId, runPurpose, configurationSha256, gitCommit = null, lifecycleStateByItemId = {} } = holdoutUnlock;
  for (const record of holdoutRecords) {
    const lifecycleState = lifecycleStateByItemId[record.evaluation_item_id];
    if (!lifecycleState) {
      throw new DatasetContractError(
        "HOLDOUT_UNLOCK_REQUIRED",
        `no lifecycleState supplied for HOLDOUT item ${record.evaluation_item_id} -- refusing to load any of it`,
      );
    }
    const gate = canUseSplit({
      log, assignmentId: record.evaluation_item_id, runId, lifecycleState,
      executedSplit: "HOLDOUT", usageKind: "FINAL_HOLDOUT", runPurpose, configurationSha256, gitCommit,
    });
    if (!gate.ok) {
      throw new DatasetContractError(gate.code, `HOLDOUT unlock rejected for item ${record.evaluation_item_id}: ${gate.message}`);
    }
  }
  return { holdout_item_count: holdoutRecords.length, unlocked: true, unlock_run_purpose: runPurpose };
}

// Returns { manifest, records } or throws DatasetContractError. Never
// returns a partial/filtered record set -- either every record in `records`
// is accepted (contract-valid, no leakage, HOLDOUT gate cleared for every
// HOLDOUT row present) or the whole call throws.
export function loadDatasetRecords(records, { datasetId, holdoutUnlock } = {}) {
  if (typeof datasetId !== "string" || datasetId === "") {
    throw new DatasetContractError("INVALID_DATASET_ID", "datasetId is required");
  }
  if (!Array.isArray(records)) {
    throw new DatasetContractError("INVALID_DATASET_SHAPE", "records must be an array");
  }

  const shapeErrors = [];
  records.forEach((record, index) => {
    const errors = validateDatasetRecord(record);
    if (errors.length > 0) shapeErrors.push(`records[${index}] (${record?.evaluation_item_id ?? "?"}): ${errors.join("; ")}`);
  });
  if (shapeErrors.length > 0) {
    throw new DatasetContractError("INVALID_DATASET_RECORD", shapeErrors.join(" | "));
  }

  const seenIds = new Set();
  for (const record of records) {
    if (seenIds.has(record.evaluation_item_id)) {
      throw new DatasetContractError("DUPLICATE_EVALUATION_ITEM_ID", `duplicate evaluation_item_id: ${record.evaluation_item_id}`);
    }
    seenIds.add(record.evaluation_item_id);
  }

  const violations = checkSplitLeakage(records);
  if (violations.length > 0) {
    throw new DatasetContractError(
      "SPLIT_LEAKAGE",
      `evaluation_group_id/chain_component_id leak across splits: ${violations.map((v) => `${v.kind}=${v.key} in ${v.splits.join(",")}`).join(" | ")}`,
    );
  }

  const holdoutRecords = records.filter((record) => record.split === "HOLDOUT");
  const holdoutGate = verifyHoldoutGate(holdoutRecords, holdoutUnlock);

  const splitCounts = { DEV_TUNE: 0, DEV_CHECK: 0, HOLDOUT: 0 };
  for (const record of records) splitCounts[record.split] += 1;

  const gradingPolicyVersions = [...new Set(records.map((record) => record.grading_policy_version))].sort();

  const manifest = {
    schema_version: "0.1.0",
    dataset_id: datasetId,
    dataset_sha256: computeDatasetItemsSha256(records),
    item_count: records.length,
    split_counts: splitCounts,
    leakage_check: { checked: true, violations: [] },
    holdout_gate: holdoutGate,
    grading_policy_versions: gradingPolicyVersions,
  };
  const manifestErrors = validateDatasetManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(`loadDatasetRecords produced an invalid DatasetManifest: ${manifestErrors.join("; ")}`);
  }

  return { manifest, records: Object.freeze([...records]) };
}
