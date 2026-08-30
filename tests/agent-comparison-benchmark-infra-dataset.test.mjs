// Turn P6 section A/F: Dataset Record / Dataset Manifest contract tests --
// synthetic fixtures only, no real Gold/HOLDOUT data is ever read here.
import assert from "node:assert/strict";
import test from "node:test";
import { loadDatasetRecords, checkSplitLeakage, DatasetContractError } from "../domain/agent-comparison/benchmark/dataset.mjs";
import { validateDatasetManifest, validateDatasetRecord } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { makeFixtureDatasetRecord } from "./lib/agent-comparison-benchmark-infra-fixture.mjs";

test("DatasetRecord: the fixture record itself is schema-valid", () => {
  assert.deepEqual(validateDatasetRecord(makeFixtureDatasetRecord()), []);
});

test("loadDatasetRecords: a well-formed single-item dataset produces a valid DatasetManifest", () => {
  const { manifest, records } = loadDatasetRecords([makeFixtureDatasetRecord()], { datasetId: "dataset_test_0001" });
  assert.deepEqual(validateDatasetManifest(manifest), []);
  assert.equal(manifest.item_count, 1);
  assert.equal(manifest.split_counts.DEV_TUNE, 1);
  assert.equal(manifest.leakage_check.violations.length, 0);
  assert.equal(manifest.holdout_gate.unlocked, false);
  assert.equal(manifest.holdout_gate.holdout_item_count, 0);
  assert.equal(records.length, 1);
});

test("loadDatasetRecords: rejects a record that fails the DatasetRecord schema", () => {
  const bad = makeFixtureDatasetRecord({ evaluation_item_id: "not-a-valid-id" });
  assert.throws(() => loadDatasetRecords([bad], { datasetId: "dataset_test_bad" }), (error) => {
    assert.ok(error instanceof DatasetContractError);
    assert.equal(error.code, "INVALID_DATASET_RECORD");
    return true;
  });
});

test("loadDatasetRecords: rejects duplicate evaluation_item_id", () => {
  const record = makeFixtureDatasetRecord();
  assert.throws(() => loadDatasetRecords([record, { ...record }], { datasetId: "dataset_test_dup" }), (error) => {
    assert.ok(error instanceof DatasetContractError);
    assert.equal(error.code, "DUPLICATE_EVALUATION_ITEM_ID");
    return true;
  });
});

// Test 13: a manifest with evaluation_group_id/chain_component_id leaking
// across splits is rejected before any execution.
test("checkSplitLeakage: detects an evaluation_group_id spanning two splits", () => {
  const a = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_a", evaluation_group_id: "group_x", split: "DEV_TUNE" });
  const b = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_b", evaluation_group_id: "group_x", split: "DEV_CHECK" });
  const violations = checkSplitLeakage([a, b]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "EVALUATION_GROUP_ID");
  assert.equal(violations[0].key, "group_x");
  assert.deepEqual(violations[0].splits, ["DEV_CHECK", "DEV_TUNE"]);
});

test("checkSplitLeakage: detects a chain_component_id spanning two splits", () => {
  const a = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_c", chain_component_id: "chain_x", split: "DEV_TUNE" });
  const b = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_d", chain_component_id: "chain_x", split: "HOLDOUT" });
  const violations = checkSplitLeakage([a, b]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "CHAIN_COMPONENT_ID");
});

test("loadDatasetRecords: a leaking split manifest is refused before any execution (SPLIT_LEAKAGE)", () => {
  const a = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_e", evaluation_group_id: "group_y", split: "DEV_TUNE" });
  const b = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_leak_f", evaluation_group_id: "group_y", split: "HOLDOUT" });
  assert.throws(() => loadDatasetRecords([a, b], { datasetId: "dataset_test_leak" }), (error) => {
    assert.ok(error instanceof DatasetContractError);
    assert.equal(error.code, "SPLIT_LEAKAGE");
    return true;
  });
});

// Test 14: HOLDOUT rows present with no unlock token at all -> the WHOLE
// load is refused (never "load everything except HOLDOUT").
test("loadDatasetRecords: refuses to load ANY of a dataset containing a HOLDOUT row when no holdoutUnlock is supplied", () => {
  const devTuneItem = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_holdout_guard_a", split: "DEV_TUNE" });
  const holdoutItem = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_holdout_guard_b", split: "HOLDOUT" });
  assert.throws(() => loadDatasetRecords([devTuneItem, holdoutItem], { datasetId: "dataset_test_holdout_locked" }), (error) => {
    assert.ok(error instanceof DatasetContractError);
    assert.equal(error.code, "HOLDOUT_UNLOCK_REQUIRED");
    return true;
  });
});

test("loadDatasetRecords: refuses a HOLDOUT row when the supplied holdoutUnlock's lifecycleState is still SEALED (a real canUseSplit rejection, not a second weaker gate)", () => {
  const holdoutItem = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_holdout_sealed", split: "HOLDOUT" });
  const holdoutUnlock = {
    log: [],
    runId: "run_test_holdout_sealed",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: "a".repeat(64),
    lifecycleStateByItemId: {
      evaluation_item_holdout_sealed: {
        assignment_id: "evaluation_item_holdout_sealed",
        assigned_split: "HOLDOUT",
        split_lock_status: "LOCKED_BY_CHAIN",
        holdout_lifecycle_status: "SEALED",
      },
    },
  };
  assert.throws(() => loadDatasetRecords([holdoutItem], { datasetId: "dataset_test_holdout_sealed", holdoutUnlock }), (error) => {
    assert.ok(error instanceof DatasetContractError);
    assert.equal(error.code, "HOLDOUT_SEALED");
    return true;
  });
});

test("loadDatasetRecords: a genuine unlock token (canUseSplit ok) admits a HOLDOUT row, and the manifest honestly records unlocked=true", () => {
  const holdoutItem = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_holdout_open", split: "HOLDOUT" });
  const holdoutUnlock = {
    log: [],
    runId: "run_test_holdout_open",
    runPurpose: "FINAL_HOLDOUT_EVALUATION",
    configurationSha256: "b".repeat(64),
    lifecycleStateByItemId: {
      evaluation_item_holdout_open: {
        assignment_id: "evaluation_item_holdout_open",
        assigned_split: "HOLDOUT",
        split_lock_status: "LOCKED_BY_CHAIN",
        holdout_lifecycle_status: "OPENED",
      },
    },
  };
  const { manifest, records } = loadDatasetRecords([holdoutItem], { datasetId: "dataset_test_holdout_open", holdoutUnlock });
  assert.deepEqual(validateDatasetManifest(manifest), []);
  assert.equal(manifest.holdout_gate.unlocked, true);
  assert.equal(manifest.holdout_gate.holdout_item_count, 1);
  assert.equal(manifest.holdout_gate.unlock_run_purpose, "FINAL_HOLDOUT_EVALUATION");
  assert.equal(records.length, 1);
});

test("loadDatasetRecords: deterministic dataset_sha256 for identical item content regardless of array order", () => {
  const a = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_order_a" });
  const b = makeFixtureDatasetRecord({ evaluation_item_id: "evaluation_item_order_b" });
  const first = loadDatasetRecords([a, b], { datasetId: "dataset_test_order" });
  const second = loadDatasetRecords([a, b], { datasetId: "dataset_test_order" });
  assert.equal(first.manifest.dataset_sha256, second.manifest.dataset_sha256);
});
