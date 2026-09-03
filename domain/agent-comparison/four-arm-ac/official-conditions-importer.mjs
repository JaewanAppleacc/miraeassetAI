// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section F: importer/schema/
// validator for the OFFICIAL metadata-conditions artifact vFINAL section 20
// requires (a separate team's `conditions.py`, extracting corp/doc-group/
// period terms from question text ONLY -- see conditions-fixture.mjs's own
// header for why this repository has no conditions.py itself). This module
// does NOT run conditions.py or fabricate its output -- it only defines
// what a real artifact must look like and fail-closes on anything that
// doesn't match, per section F's own instruction ("conditions.py 결과가
// 아직 제공되지 않았다면: importer/schema/validator만 구현").
//
// SYNTHETIC_FIXTURE_ONLY (conditions-fixture.mjs) remains valid for TESTS
// ONLY -- importOfficialConditionsArtifact below is the ONLY path that can
// ever produce official_execution_ready:true, and it always returns false
// while no real artifact has been imported (there is currently no call
// site that supplies one -- see this Turn's final report).
import { createHash } from "node:crypto";

// vFINAL section F's own two field lists, verbatim.
export const OFFICIAL_ALLOWED_FIELDS = Object.freeze([
  "question_id", "corp_codes", "doc_groups", "doc_subtypes",
  "base_years", "base_months", "receipt_date_from", "receipt_date_to",
  "is_correction", "retrieval_eligible",
]);

// Every one of these, if present on ANY row, is an immediate fail-closed
// rejection -- never silently dropped. Includes common alternate spellings
// so a real conditions.py artifact using a slightly different key name for
// the same Gold-shaped concept is still caught.
export const OFFICIAL_FORBIDDEN_FIELDS = Object.freeze([
  "document_ids", "document_id", "gold_document_ids", "gold_document_id",
  "expected_answer", "answer", "required_slot_ids", "required_slots",
  "evidence_locator", "evidence_locators", "source_locator", "source_locators",
  "other_arm_results", "arm_results",
]);

export class OfficialConditionsForbiddenFieldError extends Error {
  constructor(rowIndex, questionId, forbiddenFields) {
    super(`OFFICIAL_METADATA_FILTER_FORBIDDEN_FIELD: row ${rowIndex} (question_id=${questionId ?? "unknown"}) carries forbidden field(s): ${forbiddenFields.join(", ")}`);
    this.name = "OfficialConditionsForbiddenFieldError";
    this.code = "OFFICIAL_METADATA_FILTER_FORBIDDEN_FIELD";
    this.row_index = rowIndex;
    this.question_id = questionId ?? null;
    this.forbidden_fields = forbiddenFields;
  }
}

export class OfficialConditionsValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "OfficialConditionsValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

// vFINAL section 1's own LOW/HIGH rule (n_hard_conditions<=2 => LOW),
// duplicated here (not imported from conditions-fixture.mjs, which is
// test-only) so the official artifact's segmentation SHA is pinned by
// code that never touches the synthetic-fixture path.
function computeSegment(row) {
  const corpCount = Array.isArray(row.corp_codes) ? row.corp_codes.length : 0;
  const hasPeriod = (Array.isArray(row.base_years) && row.base_years.length > 0)
    || (Array.isArray(row.base_months) && row.base_months.length > 0)
    || Boolean(row.receipt_date_from) || Boolean(row.receipt_date_to);
  const hasDocGroup = (Array.isArray(row.doc_groups) && row.doc_groups.length > 0)
    || (Array.isArray(row.doc_subtypes) && row.doc_subtypes.length > 0);
  const nHardConditions = corpCount + (hasPeriod ? 1 : 0) + (hasDocGroup ? 1 : 0);
  return nHardConditions <= 2 ? "LOW" : "HIGH";
}

// rows: the RAW artifact rows exactly as read from disk (an array of plain
// objects), BEFORE any transformation -- validated field-by-field so a
// forbidden field can never survive into buildMetadataFiltersFromConditions-
// style filter construction, even accidentally.
export function validateOfficialConditionsArtifact(rows, { expectedRowCount = 101 } = {}) {
  if (!Array.isArray(rows)) {
    throw new OfficialConditionsValidationError("conditions artifact must be an array of rows", "OFFICIAL_CONDITIONS_NOT_ARRAY");
  }
  if (rows.length !== expectedRowCount) {
    throw new OfficialConditionsValidationError(
      `conditions artifact must have exactly ${expectedRowCount} rows, got ${rows.length}`,
      "OFFICIAL_CONDITIONS_ROW_COUNT_MISMATCH",
      { expected: expectedRowCount, actual: rows.length },
    );
  }

  const seenQuestionIds = new Set();
  const segments = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new OfficialConditionsValidationError(`row ${index} is not a plain object`, "OFFICIAL_CONDITIONS_ROW_NOT_OBJECT", { row_index: index });
    }

    const forbiddenPresent = OFFICIAL_FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(row, field));
    if (forbiddenPresent.length > 0) {
      throw new OfficialConditionsForbiddenFieldError(index, row.question_id, forbiddenPresent);
    }

    const unknownFields = Object.keys(row).filter((key) => !OFFICIAL_ALLOWED_FIELDS.includes(key));
    if (unknownFields.length > 0) {
      throw new OfficialConditionsValidationError(
        `row ${index} (question_id=${row.question_id ?? "unknown"}) carries field(s) not in OFFICIAL_ALLOWED_FIELDS: ${unknownFields.join(", ")}`,
        "OFFICIAL_CONDITIONS_UNKNOWN_FIELD",
        { row_index: index, question_id: row.question_id ?? null, unknown_fields: unknownFields },
      );
    }

    if (typeof row.question_id !== "string" || row.question_id.trim() === "") {
      throw new OfficialConditionsValidationError(`row ${index} has no valid question_id`, "OFFICIAL_CONDITIONS_MISSING_QUESTION_ID", { row_index: index });
    }
    if (seenQuestionIds.has(row.question_id)) {
      throw new OfficialConditionsValidationError(`duplicate question_id: ${row.question_id} (question_id must be 1:1)`, "OFFICIAL_CONDITIONS_DUPLICATE_QUESTION_ID", { question_id: row.question_id });
    }
    seenQuestionIds.add(row.question_id);

    segments.push({ question_id: row.question_id, segment: computeSegment(row) });
  }

  const conditionsSha256 = sha256Hex(rows);
  const segmentationSha256 = sha256Hex(segments);
  return Object.freeze({
    row_count: rows.length,
    question_ids: Object.freeze([...seenQuestionIds]),
    conditions_sha256: conditionsSha256,
    segmentation_sha256: segmentationSha256,
    segments: Object.freeze(segments),
    low_count: segments.filter((s) => s.segment === "LOW").length,
    high_count: segments.filter((s) => s.segment === "HIGH").length,
  });
}

// The only function that can ever return official_execution_ready:true --
// and only once a real artifact (rows + its own declared arm-common
// identity) is actually supplied. No call site in this repository
// currently supplies one (conditions.py has not been provided -- see
// conditions-fixture.mjs's header and this Turn's final report), so every
// existing caller gets official_execution_ready:false, by construction,
// not by an extra flag someone could forget to set.
export function importOfficialConditionsArtifact(rows, options = {}) {
  const validation = validateOfficialConditionsArtifact(rows, options);
  return Object.freeze({
    ...validation,
    official_execution_ready: true,
    source: "OFFICIAL_CONDITIONS_ARTIFACT",
  });
}

// Convenience used by call sites that only need to know whether they are
// allowed to run an OFFICIAL DEV_TUNE execution against a given
// metadata_filter.source config value -- SYNTHETIC_FIXTURE_ONLY (or
// anything other than OFFICIAL_CONDITIONS_ARTIFACT) is never official-ready,
// fail-closed, never silently treated as good enough.
export function assertOfficialExecutionReady(metadataFilterSource) {
  if (metadataFilterSource !== "OFFICIAL_CONDITIONS_ARTIFACT") {
    throw new OfficialConditionsValidationError(
      `metadata_filter.source is "${metadataFilterSource}", not OFFICIAL_CONDITIONS_ARTIFACT -- refusing an official execution (SYNTHETIC_FIXTURE_ONLY is test-only, per vFINAL section F/20)`,
      "OFFICIAL_METADATA_FILTER_SOURCE_NOT_OFFICIAL",
      { metadata_filter_source: metadataFilterSource },
    );
  }
}
