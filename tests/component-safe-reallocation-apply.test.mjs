// Turn N4.16: synthetic-fixture unit tests for
// domain/evaluation/component-safe-reallocation-apply.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPoolSplitDelta, applyAuthorDelta, diffRecordsByAssignmentId, verifyDeltaApplicationScope,
} from "../domain/evaluation/component-safe-reallocation-apply.mjs";

test("applyPoolSplitDelta: applies only split-dimension moves, leaves non-targeted records byte-identical, never mutates the input array", () => {
  const poolRecords = [
    { assignment_id: "a1", planned_split: "HOLDOUT", other_field: 1 },
    { assignment_id: "a2", planned_split: "DEV_CHECK", other_field: 2 },
    { assignment_id: "a3", planned_split: "DEV_TUNE", other_field: 3 },
  ];
  const deltaRows = [
    { assignment_id: "a1", dimension: "split", from: "HOLDOUT", to: "DEV_TUNE" },
    { assignment_id: "a2", dimension: "author", from: "AUTHOR_A", to: "AUTHOR_B" }, // wrong dimension, must be ignored
  ];
  const frozenBefore = JSON.parse(JSON.stringify(poolRecords));
  const after = applyPoolSplitDelta({ poolRecords, deltaRows });
  assert.deepEqual(poolRecords, frozenBefore, "input array must never be mutated");
  assert.equal(after.find((r) => r.assignment_id === "a1").planned_split, "DEV_TUNE");
  assert.equal(after.find((r) => r.assignment_id === "a2").planned_split, "DEV_CHECK", "author-dimension delta rows must never affect planned_split");
  assert.equal(after.find((r) => r.assignment_id === "a3").planned_split, "DEV_TUNE");
  assert.deepEqual(after.find((r) => r.assignment_id === "a1"), { assignment_id: "a1", planned_split: "DEV_TUNE", other_field: 1 });
});

test("applyPoolSplitDelta: throws if a delta's assignment_id is not in poolRecords", () => {
  assert.throws(() => applyPoolSplitDelta({
    poolRecords: [{ assignment_id: "a1", planned_split: "HOLDOUT" }],
    deltaRows: [{ assignment_id: "MISSING", dimension: "split", from: "HOLDOUT", to: "DEV_TUNE" }],
  }), /not found in poolRecords/);
});

test("applyPoolSplitDelta: throws if the delta's expected 'from' does not match the record's current planned_split (stale-delta protection)", () => {
  assert.throws(() => applyPoolSplitDelta({
    poolRecords: [{ assignment_id: "a1", planned_split: "DEV_CHECK" }],
    deltaRows: [{ assignment_id: "a1", dimension: "split", from: "HOLDOUT", to: "DEV_TUNE" }],
  }), /does not match delta's expected "from"/);
});

test("applyAuthorDelta: applies only author-dimension moves, ignores split-dimension rows, never mutates input", () => {
  const authorRows = [
    { assignment_id: "a1", author_allocation: "AUTHOR_A", extra: "x" },
    { assignment_id: "a2", author_allocation: "AUTHOR_B", extra: "y" },
  ];
  const deltaRows = [
    { assignment_id: "a1", dimension: "author", from: "AUTHOR_A", to: "AUTHOR_B" },
    { assignment_id: "a2", dimension: "split", from: "DEV_TUNE", to: "HOLDOUT" }, // wrong dimension, must be ignored
  ];
  const frozenBefore = JSON.parse(JSON.stringify(authorRows));
  const after = applyAuthorDelta({ authorRows, deltaRows });
  assert.deepEqual(authorRows, frozenBefore);
  assert.equal(after.find((r) => r.assignment_id === "a1").author_allocation, "AUTHOR_B");
  assert.equal(after.find((r) => r.assignment_id === "a2").author_allocation, "AUTHOR_B", "split-dimension delta rows must never affect author_allocation");
});

test("applyAuthorDelta: throws on a stale 'from' value", () => {
  assert.throws(() => applyAuthorDelta({
    authorRows: [{ assignment_id: "a1", author_allocation: "AUTHOR_B" }],
    deltaRows: [{ assignment_id: "a1", dimension: "author", from: "AUTHOR_A", to: "AUTHOR_B" }],
  }), /does not match delta's expected "from"/);
});

test("diffRecordsByAssignmentId: detects added/removed ids and per-id changed fields exactly", () => {
  const before = [
    { assignment_id: "a1", x: 1, y: 2 },
    { assignment_id: "a2", x: 5, y: 6 },
    { assignment_id: "a3", x: 9, y: 9 },
  ];
  const after = [
    { assignment_id: "a1", x: 1, y: 2 }, // unchanged
    { assignment_id: "a2", x: 99, y: 6 }, // x changed
    { assignment_id: "a4", x: 0, y: 0 }, // a3 removed, a4 added
  ];
  const diff = diffRecordsByAssignmentId({ before, after });
  assert.deepEqual(diff.added_ids, ["a4"]);
  assert.deepEqual(diff.removed_ids, ["a3"]);
  assert.equal(diff.changed_id_count, 1);
  assert.deepEqual(diff.changed, [{ assignment_id: "a2", changed_fields: ["x"] }]);
});

test("diffRecordsByAssignmentId: a deep-equal nested array/object field is NOT reported as changed", () => {
  const before = [{ assignment_id: "a1", tags: ["x", "y"], nested: { a: 1 } }];
  const after = [{ assignment_id: "a1", tags: ["x", "y"], nested: { a: 1 } }];
  const diff = diffRecordsByAssignmentId({ before, after });
  assert.equal(diff.changed_id_count, 0);
});

test("verifyDeltaApplicationScope: passes when changed ids exactly match expected and only allowed fields changed", () => {
  const diff = { added_ids: [], removed_ids: [], changed: [{ assignment_id: "a1", changed_fields: ["planned_split"] }] };
  const result = verifyDeltaApplicationScope({ diff, expectedChangedIds: ["a1"], allowedFields: ["planned_split"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("verifyDeltaApplicationScope: flags rows added/removed, unexpected ids changed, expected ids NOT changed, and disallowed fields, independently", () => {
  const diff = {
    added_ids: ["new1"],
    removed_ids: ["gone1"],
    changed: [
      { assignment_id: "a1", changed_fields: ["planned_split"] },
      { assignment_id: "unexpected1", changed_fields: ["planned_split"] },
      { assignment_id: "a2", changed_fields: ["planned_split", "tags"] },
    ],
  };
  const result = verifyDeltaApplicationScope({ diff, expectedChangedIds: ["a1", "a2", "a3"], allowedFields: ["planned_split"] });
  assert.equal(result.ok, false);
  const types = result.violations.map((v) => v.type).sort();
  assert.deepEqual(types, ["DISALLOWED_FIELD_CHANGED", "EXPECTED_ID_NOT_CHANGED", "ROWS_ADDED", "ROWS_REMOVED", "UNEXPECTED_ID_CHANGED"]);
  assert.deepEqual(result.violations.find((v) => v.type === "EXPECTED_ID_NOT_CHANGED").ids, ["a3"]);
  assert.deepEqual(result.violations.find((v) => v.type === "UNEXPECTED_ID_CHANGED").ids, ["unexpected1"]);
  assert.deepEqual(result.violations.find((v) => v.type === "DISALLOWED_FIELD_CHANGED").fields, ["tags"]);
});
