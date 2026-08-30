// Turn P6.1 (hardened Turn P6): per-item and whole-dataset content hashes.
// Same canonicalize-then-sha256 pattern
// domain/agent-comparison/reproducibility.mjs's canonicalSha256 already
// uses -- duplicated here (not imported) so this module never has to
// import a whole-dataset helper just to hash one record, and stays
// independently testable.
//
// Turn P6.1 fix: the pre-fix computeDatasetItemsSha256 hashed only
// {evaluation_item_id, question, split} -- changing ANY expected_* field
// (the actual Gold content) left dataset_sha256 completely unchanged, so a
// tampered/corrected Gold file could silently masquerade as the same
// dataset. dataset_sha256 now canonically hashes the FULL DatasetRecord
// content every scorer actually reads (question/hints/split/
// evaluation_group_id/chain_component_id/expected_answerability/
// expected_facts/expected_events/expected_relations/
// expected_numeric_claims/expected_date_claims/allowed_evidence_ids/
// grading_policy_version) -- while still never persisting the raw Gold
// itself anywhere: only the resulting sha256 digest is ever stored (in the
// DatasetManifest / BenchmarkItemResult / BenchmarkComparisonReport), the
// canonicalized intermediate object is never retained past this function
// call. Hashing content one-way is not the same as copying it -- a sha256
// digest cannot be inverted back into the Gold it was computed from.
//
// Records are sorted by evaluation_item_id before hashing (Turn P6.1
// section D.3) so the SAME set of records in a DIFFERENT array order still
// produces the IDENTICAL dataset_sha256 -- only the record CONTENT and
// MEMBERSHIP affect the hash, never incidental array order.
import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Hex(text) {
  return createHash("sha256").update(typeof text === "string" ? text : "", "utf8").digest("hex");
}

// evaluation_item_sha256: unchanged in spirit from Turn P6 -- the whole
// canonicalized DatasetRecord, hashed. Never appears in a ModelAdapter
// prompt or anything shown to an Agent variant, only in the post-hoc
// result record (so a later audit can confirm which exact expected_*
// content a given BenchmarkItemResult was scored against, without needing
// the whole dataset file).
export function computeEvaluationItemSha256(datasetRecord) {
  return sha256Hex(JSON.stringify(canonicalize(datasetRecord)));
}

// The exact set of DatasetRecord fields the dataset-level hash binds --
// every field a Grading Scorer reads (Turn P6.1 section D.2). Deliberately
// NOT the whole record verbatim (that would just duplicate
// computeEvaluationItemSha256's own job) -- listed explicitly so it is
// obvious, by inspection, that no expected_* field was left out.
function datasetHashProjection(record) {
  return {
    evaluation_item_id: record.evaluation_item_id,
    question: record.question,
    hints: record.hints ?? null,
    split: record.split,
    evaluation_group_id: record.evaluation_group_id ?? null,
    chain_component_id: record.chain_component_id ?? null,
    expected_answerability: record.expected_answerability,
    expected_facts: record.expected_facts ?? [],
    expected_events: record.expected_events ?? [],
    expected_relations: record.expected_relations ?? [],
    expected_numeric_claims: record.expected_numeric_claims ?? [],
    expected_date_claims: record.expected_date_claims ?? [],
    allowed_evidence_ids: record.allowed_evidence_ids ?? [],
    grading_policy_version: record.grading_policy_version,
  };
}

// Whole-dataset pin -- canonicalized, evaluation_item_id-sorted projection
// of EVERY expected_* field over every item actually loaded. Changing any
// one item's expected_* content (or hints, split, group/chain membership,
// grading_policy_version) changes this hash; re-ordering the SAME items in
// the input array does not.
export function computeDatasetItemsSha256(datasetRecords) {
  const sorted = [...datasetRecords].sort((a, b) => a.evaluation_item_id.localeCompare(b.evaluation_item_id));
  const projected = sorted.map(datasetHashProjection);
  return sha256Hex(JSON.stringify(canonicalize(projected)));
}
