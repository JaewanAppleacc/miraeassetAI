// Official schema validation for records the Seed Artifact Store Adapters
// index -- the single source of truth for "is this a well-formed canonical
// DocumentIR record" / "is this a well-formed Evidence record" / "is this
// a well-formed Fact/Event record" / "is this a well-formed Fact Coverage
// Snapshot" is the real, frozen schema files, compiled once here with the
// same Ajv2020 + ajv-formats pattern domain/runtime/final-response-
// validator.mjs already uses, never a hand-rolled field-by-field shape
// check that could drift from the schema.
//
// Every record/document validator here only ever receives the output of
// JSON.parse() on a single JSONL line, or a whole small JSON document (see
// seed-canonical-document-ir-store.mjs / seed-evidence-artifact-store.mjs
// / seed-fact-artifact-store.mjs) -- never a live, caller-supplied JS
// object -- so unlike final-response-validator.mjs there is no adversarial
// circular-reference/toJSON/BigInt trust boundary to defend here; a value
// that came out of JSON.parse can never contain any of those.
import semanticBundleSchema from "../interfaces/semantic-bundle.schema.json" with { type: "json" };
import {
  validateDocumentIrSchema,
  validateEvidenceSchema,
  validateEventSchema,
  validateFactCoverageSnapshotSchema,
  validateFactSchema,
} from "../generated/runtime-schema-validators.mjs";

function errorsOf(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}`);
}

// Returns [] when record satisfies domain/interfaces/document-ir.schema.json,
// otherwise a list of human-readable error strings.
export function validateDocumentIrRecord(record) {
  return validateDocumentIrSchema(record) ? [] : errorsOf(validateDocumentIrSchema);
}

// Returns [] when record satisfies semantic-bundle.schema.json's
// $defs.evidence shape, otherwise a list of human-readable error strings.
export function validateEvidenceRecord(record) {
  return validateEvidenceSchema(record) ? [] : errorsOf(validateEvidenceSchema);
}

// Returns [] when record satisfies semantic-bundle.schema.json's
// $defs.fact shape, otherwise a list of human-readable error strings.
export function validateFactRecord(record) {
  return validateFactSchema(record) ? [] : errorsOf(validateFactSchema);
}

// Returns [] when record satisfies semantic-bundle.schema.json's
// $defs.event shape, otherwise a list of human-readable error strings.
export function validateEventRecord(record) {
  return validateEventSchema(record) ? [] : errorsOf(validateEventSchema);
}

// Returns [] when the (whole) object satisfies
// domain/interfaces/fact-coverage-snapshot.schema.json, otherwise a list
// of human-readable error strings.
export function validateFactCoverageSnapshot(snapshot) {
  return validateFactCoverageSnapshotSchema(snapshot) ? [] : errorsOf(validateFactCoverageSnapshotSchema);
}

// The exact semantic_bundle_schema_version every Fact record validated by
// validateFactRecord() above was actually checked against -- read directly
// from the official schema's own properties.schema_version.const (never a
// second, independently-typed copy of "0.2.0" living in adapter code that
// could silently drift from the schema it claims to describe).
export const SEMANTIC_BUNDLE_SCHEMA_VERSION = semanticBundleSchema.properties.schema_version.const;
