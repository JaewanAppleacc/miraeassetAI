// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section F/H: offline tests for
// official-conditions-importer.mjs. No real conditions.py artifact exists
// (see conditions-fixture.mjs's header) -- these tests exercise the
// importer/schema/validator against hand-built fixture rows only, per
// section F's own instruction.
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateOfficialConditionsArtifact, importOfficialConditionsArtifact,
  assertOfficialExecutionReady, OfficialConditionsForbiddenFieldError,
  OfficialConditionsValidationError, OFFICIAL_FORBIDDEN_FIELDS, OFFICIAL_ALLOWED_FIELDS,
} from "../domain/agent-comparison/four-arm-ac/official-conditions-importer.mjs";

function validRow(n, overrides = {}) {
  return { question_id: `q_${String(n).padStart(3, "0")}`, corp_codes: ["00126380"], doc_groups: ["periodic"], base_years: [2024], ...overrides };
}

function makeRows(n) {
  return Array.from({ length: n }, (_, i) => validRow(i));
}

test("validateOfficialConditionsArtifact accepts a well-formed 101-row artifact", () => {
  const result = validateOfficialConditionsArtifact(makeRows(101));
  assert.equal(result.row_count, 101);
  assert.equal(result.question_ids.length, 101);
  assert.match(result.conditions_sha256, /^[0-9a-f]{64}$/);
  assert.match(result.segmentation_sha256, /^[0-9a-f]{64}$/);
});

test("validateOfficialConditionsArtifact rejects a row count other than the expected 101", () => {
  assert.throws(() => validateOfficialConditionsArtifact(makeRows(100)), (error) => error.code === "OFFICIAL_CONDITIONS_ROW_COUNT_MISMATCH");
});

test("validateOfficialConditionsArtifact rejects a duplicate question_id (must be 1:1)", () => {
  const rows = makeRows(101);
  rows[50] = { ...rows[50], question_id: rows[0].question_id };
  assert.throws(() => validateOfficialConditionsArtifact(rows), (error) => error.code === "OFFICIAL_CONDITIONS_DUPLICATE_QUESTION_ID");
});

test("validateOfficialConditionsArtifact rejects a missing/empty question_id", () => {
  const rows = makeRows(101);
  rows[10] = { ...rows[10], question_id: "" };
  assert.throws(() => validateOfficialConditionsArtifact(rows), (error) => error.code === "OFFICIAL_CONDITIONS_MISSING_QUESTION_ID");
});

test("validateOfficialConditionsArtifact rejects a field outside OFFICIAL_ALLOWED_FIELDS (unknown, not Gold-shaped)", () => {
  const rows = makeRows(101);
  rows[5] = { ...rows[5], some_new_signal: "x" };
  assert.throws(() => validateOfficialConditionsArtifact(rows), (error) => error.code === "OFFICIAL_CONDITIONS_UNKNOWN_FIELD");
});

test("every OFFICIAL_FORBIDDEN_FIELDS entry fail-closes with OFFICIAL_METADATA_FILTER_FORBIDDEN_FIELD, never silently dropped", () => {
  for (const forbiddenField of OFFICIAL_FORBIDDEN_FIELDS) {
    const rows = makeRows(101);
    rows[7] = { ...rows[7], [forbiddenField]: ["would-leak-gold"] };
    assert.throws(
      () => validateOfficialConditionsArtifact(rows),
      (error) => error instanceof OfficialConditionsForbiddenFieldError
        && error.code === "OFFICIAL_METADATA_FILTER_FORBIDDEN_FIELD"
        && error.forbidden_fields.includes(forbiddenField),
      `expected forbidden field "${forbiddenField}" to be rejected`,
    );
  }
});

test("OFFICIAL_ALLOWED_FIELDS and OFFICIAL_FORBIDDEN_FIELDS never overlap", () => {
  const overlap = OFFICIAL_ALLOWED_FIELDS.filter((f) => OFFICIAL_FORBIDDEN_FIELDS.includes(f));
  assert.deepEqual(overlap, []);
});

test("importOfficialConditionsArtifact returns official_execution_ready:true only for a validated real artifact", () => {
  const imported = importOfficialConditionsArtifact(makeRows(101));
  assert.equal(imported.official_execution_ready, true);
  assert.equal(imported.source, "OFFICIAL_CONDITIONS_ARTIFACT");
});

test("importOfficialConditionsArtifact still fail-closes on a forbidden field -- never returns official_execution_ready:true for a bad artifact", () => {
  const rows = makeRows(101);
  rows[0] = { ...rows[0], document_ids: ["periodic_00000000000001"] };
  assert.throws(() => importOfficialConditionsArtifact(rows), (error) => error.code === "OFFICIAL_METADATA_FILTER_FORBIDDEN_FIELD");
});

test("assertOfficialExecutionReady rejects SYNTHETIC_FIXTURE_ONLY -- fail-closed, no official DEV_TUNE run is possible against test fixtures", () => {
  assert.throws(
    () => assertOfficialExecutionReady("SYNTHETIC_FIXTURE_ONLY"),
    (error) => error.code === "OFFICIAL_METADATA_FILTER_SOURCE_NOT_OFFICIAL",
  );
});

test("assertOfficialExecutionReady accepts only the exact OFFICIAL_CONDITIONS_ARTIFACT source value", () => {
  assert.doesNotThrow(() => assertOfficialExecutionReady("OFFICIAL_CONDITIONS_ARTIFACT"));
  assert.throws(() => assertOfficialExecutionReady(undefined), OfficialConditionsValidationError);
  assert.throws(() => assertOfficialExecutionReady(null), OfficialConditionsValidationError);
});

test("segmentation follows vFINAL section 1's own LOW (<=2 hard conditions) / HIGH (>=3) rule", () => {
  const rows = [
    { question_id: "q_000", corp_codes: ["00126380"] }, // 1 hard condition -> LOW
    { question_id: "q_001", corp_codes: ["00126380"], base_years: [2024], doc_groups: ["periodic"] }, // 3 -> HIGH
    ...makeRows(99).map((r, i) => ({ ...r, question_id: `q_extra_${i}` })),
  ];
  const result = validateOfficialConditionsArtifact(rows);
  assert.equal(result.segments[0].segment, "LOW");
  assert.equal(result.segments[1].segment, "HIGH");
});
