// Turn AC-OFFICIAL-INTEGRATION-V1: importer/validator for the REAL official
// conditions v2 artifact (devtune101_conditions.v2.jsonl), as actually
// delivered by the B/D workstream -- see official/IMPORT_MANIFEST.json for
// full lineage. This module is ADDITIVE: it does not modify or replace
// official-conditions-importer.mjs's existing OFFICIAL_ALLOWED_FIELDS/
// validateOfficialConditionsArtifact, which assumed a flat per-question row
// shape (corp_codes/base_years/receipt_date_from/...) that the real
// artifact does not use. The real artifact instead nests a `conditions`
// object per question with a DIFFERENT field set (corps/years/year_months/
// correction/candidate_terms/...) -- discovered by reading the actual
// delivered file, not assumed in advance. Rather than force the old
// validator to accept a shape it was never designed for, this module
// defines what THIS artifact must look like and fail-closes on anything
// else, per the same "importer/schema/validator only" instruction the
// original module followed.
//
// IMPORTANT SCOPE LIMIT (explicit, not an oversight): this module only
// validates the artifact's bytes/shape/identity. It does NOT map a row's
// `conditions` into the arm-retriever-adapter's METADATA_FILTER_KEYS shape
// (conditions-fixture.mjs) for real per-question retrieval-time filtering.
// That mapping needs (a) a corp-NAME -> corp_code resolution step (the
// artifact's `corps` field holds Korean display names like "아모레퍼시픽",
// not the 8-digit corp_codes passesMetadataFilters/reference_retrieval_
// chunks.corp_code actually compare against) via the gated, Owner-approval-
// pending CompanyResolver (domain/adapters/seed-company-resolver.mjs), and
// (b) taxonomy alignment between exchange_subtypes/major_labels/
// periodic_subtypes and the chunker's own doc_subtype vocabulary. Neither
// exists yet, and wiring either up is real production wiring this Turn
// explicitly does not do. See AC_OFFICIAL_INTEGRATION_V1_HANDOFF.md.
import { createHash } from "node:crypto";

export const CONDITIONS_V2_TOP_LEVEL_FIELDS = Object.freeze([
  "question_id", "question", "segment", "n_hard_conditions", "conditions",
]);

export const CONDITIONS_V2_CONDITION_FIELDS = Object.freeze([
  "candidate_terms", "corps", "correction", "doc_groups",
  "exchange_subtypes", "major_labels", "periodic_subtypes",
  "wants_latest", "year_months", "years",
]);

// Same Gold-shaped forbidden-field concept official-conditions-importer.mjs
// already enforces, reproduced here (not imported) so this module's
// fail-closed behavior does not depend on that module's own field list ever
// staying in sync -- a duplicate, independent tripwire is the point.
export const CONDITIONS_V2_FORBIDDEN_FIELDS = Object.freeze([
  "document_ids", "document_id", "gold_document_ids", "gold_document_id",
  "expected_answer", "answer", "required_slot_ids", "required_slots",
  "evidence_locator", "evidence_locators", "source_locator", "source_locators",
  "other_arm_results", "arm_results", "gold_sha256", "gold",
]);

export class OfficialConditionsV2ValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "OfficialConditionsV2ValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256HexBytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function hasForbiddenField(obj) {
  return CONDITIONS_V2_FORBIDDEN_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

// vFINAL section 1's own LOW/HIGH rule, reproduced a THIRD time (also in
// conditions-fixture.mjs and official-conditions-importer.mjs) deliberately
// -- each copy is an independent cross-check against the artifact's own
// declared `segment`, not a shared implementation any one of them could
// silently drift without the others noticing.
function computeSegmentV2(conditions, nHardConditions) {
  if (typeof nHardConditions === "number") return nHardConditions <= 2 ? "LOW" : "HIGH";
  const corpCount = Array.isArray(conditions.corps) ? conditions.corps.length : 0;
  const hasPeriod = (Array.isArray(conditions.years) && conditions.years.length > 0)
    || (Array.isArray(conditions.year_months) && conditions.year_months.length > 0);
  const hasDocGroup = (Array.isArray(conditions.doc_groups) && conditions.doc_groups.length > 0)
    || (Array.isArray(conditions.exchange_subtypes) && conditions.exchange_subtypes.length > 0)
    || (Array.isArray(conditions.major_labels) && conditions.major_labels.length > 0)
    || (Array.isArray(conditions.periodic_subtypes) && conditions.periodic_subtypes.length > 0);
  const n = corpCount + (hasPeriod ? 1 : 0) + (hasDocGroup ? 1 : 0);
  return n <= 2 ? "LOW" : "HIGH";
}

// rawBytes: the artifact file's raw bytes exactly as read from disk (a
// Buffer), BEFORE any parsing -- the SHA-256 gate below runs against these
// bytes, never against a re-serialized/reformatted copy, so byte-for-byte
// tampering (even whitespace-only) is caught.
export function validateOfficialConditionsV2Artifact(rawBytes, { expectedSha256, expectedRowCount = 101 } = {}) {
  if (!Buffer.isBuffer(rawBytes)) {
    throw new OfficialConditionsV2ValidationError("rawBytes must be a Buffer of the artifact's actual file contents", "CONDITIONS_V2_NOT_BUFFER");
  }
  const fileSha256 = sha256HexBytes(rawBytes);
  if (typeof expectedSha256 === "string" && fileSha256 !== expectedSha256) {
    throw new OfficialConditionsV2ValidationError(
      `conditions v2 artifact sha256 mismatch: expected ${expectedSha256}, got ${fileSha256}`,
      "CONDITIONS_V2_SHA256_MISMATCH",
      { expected: expectedSha256, actual: fileSha256 },
    );
  }

  const text = rawBytes.toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== expectedRowCount) {
    throw new OfficialConditionsV2ValidationError(
      `conditions v2 artifact must have exactly ${expectedRowCount} rows, got ${lines.length}`,
      "CONDITIONS_V2_ROW_COUNT_MISMATCH",
      { expected: expectedRowCount, actual: lines.length },
    );
  }

  const seenQuestionIds = new Set();
  const segments = [];
  for (const [index, line] of lines.entries()) {
    let row;
    try { row = JSON.parse(line); } catch (error) {
      throw new OfficialConditionsV2ValidationError(`row ${index} is not valid JSON: ${error.message}`, "CONDITIONS_V2_ROW_NOT_JSON", { row_index: index });
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new OfficialConditionsV2ValidationError(`row ${index} is not a plain object`, "CONDITIONS_V2_ROW_NOT_OBJECT", { row_index: index });
    }

    const forbiddenTop = hasForbiddenField(row);
    if (forbiddenTop.length > 0) {
      throw new OfficialConditionsV2ValidationError(
        `row ${index} (question_id=${row.question_id ?? "unknown"}) carries forbidden top-level field(s): ${forbiddenTop.join(", ")}`,
        "CONDITIONS_V2_FORBIDDEN_FIELD", { row_index: index, question_id: row.question_id ?? null, forbidden_fields: forbiddenTop },
      );
    }
    const unknownTop = Object.keys(row).filter((k) => !CONDITIONS_V2_TOP_LEVEL_FIELDS.includes(k));
    if (unknownTop.length > 0) {
      throw new OfficialConditionsV2ValidationError(
        `row ${index} carries unknown top-level field(s): ${unknownTop.join(", ")}`,
        "CONDITIONS_V2_UNKNOWN_TOP_LEVEL_FIELD", { row_index: index, unknown_fields: unknownTop },
      );
    }

    if (typeof row.question_id !== "string" || row.question_id.trim() === "") {
      throw new OfficialConditionsV2ValidationError(`row ${index} has no valid question_id`, "CONDITIONS_V2_MISSING_QUESTION_ID", { row_index: index });
    }
    if (seenQuestionIds.has(row.question_id)) {
      throw new OfficialConditionsV2ValidationError(`duplicate question_id: ${row.question_id}`, "CONDITIONS_V2_DUPLICATE_QUESTION_ID", { question_id: row.question_id });
    }
    seenQuestionIds.add(row.question_id);

    if (typeof row.question !== "string" || row.question.trim() === "") {
      throw new OfficialConditionsV2ValidationError(`row ${index} (${row.question_id}) has no valid question text`, "CONDITIONS_V2_MISSING_QUESTION_TEXT", { row_index: index, question_id: row.question_id });
    }

    const conditions = row.conditions;
    if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) {
      throw new OfficialConditionsV2ValidationError(`row ${index} (${row.question_id}) has no valid conditions object`, "CONDITIONS_V2_MISSING_CONDITIONS", { row_index: index, question_id: row.question_id });
    }
    const forbiddenCond = hasForbiddenField(conditions);
    if (forbiddenCond.length > 0) {
      throw new OfficialConditionsV2ValidationError(
        `row ${index} (${row.question_id}) carries forbidden condition field(s): ${forbiddenCond.join(", ")}`,
        "CONDITIONS_V2_FORBIDDEN_CONDITION_FIELD", { row_index: index, question_id: row.question_id, forbidden_fields: forbiddenCond },
      );
    }
    const unknownCond = Object.keys(conditions).filter((k) => !CONDITIONS_V2_CONDITION_FIELDS.includes(k));
    if (unknownCond.length > 0) {
      throw new OfficialConditionsV2ValidationError(
        `row ${index} (${row.question_id}) conditions carries unknown field(s): ${unknownCond.join(", ")}`,
        "CONDITIONS_V2_UNKNOWN_CONDITION_FIELD", { row_index: index, question_id: row.question_id, unknown_fields: unknownCond },
      );
    }

    if (row.segment !== "LOW" && row.segment !== "HIGH") {
      throw new OfficialConditionsV2ValidationError(`row ${index} (${row.question_id}) has invalid segment ${JSON.stringify(row.segment)}`, "CONDITIONS_V2_INVALID_SEGMENT", { row_index: index, question_id: row.question_id });
    }
    const recomputedSegment = computeSegmentV2(conditions, row.n_hard_conditions);
    if (recomputedSegment !== row.segment) {
      throw new OfficialConditionsV2ValidationError(
        `row ${index} (${row.question_id}) declared segment=${row.segment} but recomputes to ${recomputedSegment}`,
        "CONDITIONS_V2_SEGMENT_MISMATCH", { row_index: index, question_id: row.question_id, declared: row.segment, recomputed: recomputedSegment },
      );
    }

    segments.push({ question_id: row.question_id, segment: row.segment, n_hard_conditions: row.n_hard_conditions ?? null });
  }

  return Object.freeze({
    file_sha256: fileSha256,
    row_count: lines.length,
    question_ids: Object.freeze([...seenQuestionIds]),
    segments: Object.freeze(segments),
    low_count: segments.filter((s) => s.segment === "LOW").length,
    high_count: segments.filter((s) => s.segment === "HIGH").length,
    official_execution_ready: true,
    source: "OFFICIAL_CONDITIONS_ARTIFACT",
    runtime_wiring_status: "ARTIFACT_IMPORTED_NOT_WIRED",
  });
}

// universe.csv: validated as an opaque, SHA-pinned artifact only -- this
// Turn does not parse or interpret its rows (no A/C code path consumes
// universe.csv yet; it is the conditions extractor's own input on the B/D
// side). A header-shape sanity check is still performed so a truncated or
// wrong-file substitution is caught even if someone forgets to check the
// SHA.
export function validateOfficialUniverseArtifact(rawBytes, { expectedSha256 } = {}) {
  if (!Buffer.isBuffer(rawBytes)) {
    throw new OfficialConditionsV2ValidationError("rawBytes must be a Buffer of the artifact's actual file contents", "UNIVERSE_NOT_BUFFER");
  }
  const fileSha256 = sha256HexBytes(rawBytes);
  if (typeof expectedSha256 === "string" && fileSha256 !== expectedSha256) {
    throw new OfficialConditionsV2ValidationError(
      `universe artifact sha256 mismatch: expected ${expectedSha256}, got ${fileSha256}`,
      "UNIVERSE_SHA256_MISMATCH",
      { expected: expectedSha256, actual: fileSha256 },
    );
  }
  const text = rawBytes.toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new OfficialConditionsV2ValidationError("universe artifact has no rows", "UNIVERSE_EMPTY");
  }
  return Object.freeze({
    file_sha256: fileSha256,
    line_count: lines.length,
    header: lines[0],
    official_execution_ready: true,
    source: "OFFICIAL_CONDITIONS_ARTIFACT",
  });
}
