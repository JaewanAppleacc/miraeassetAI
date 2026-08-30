// Turn P6: per-item content hash, the same canonicalize-then-sha256 pattern
// domain/agent-comparison/reproducibility.mjs's canonicalSha256 already
// uses for computeModelConfigSha256/computeDatasetSha256 -- duplicated
// here (not imported) so this module never has to import a whole-dataset
// helper just to hash one record, and stays independently testable. Hashes
// the WHOLE DatasetRecord (question + hints + every expected_* field +
// split) -- unlike computeDatasetSha256 (question_id/question pairs only,
// deliberately excludes expected answers from the per-RUN dataset pin so a
// BenchmarkRunManifest never needs to embed Gold), evaluation_item_sha256
// exists specifically so a later audit CAN confirm which exact expected_*
// content a given BenchmarkItemResult was scored against, without needing
// the whole dataset file -- it never appears in a ModelAdapter prompt or in
// anything shown to an Agent variant, only in the post-hoc result record.
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

export function computeEvaluationItemSha256(datasetRecord) {
  return sha256Hex(JSON.stringify(canonicalize(datasetRecord)));
}

// Whole-dataset pin -- canonicalized (evaluation_item_id, question, split)
// triples only, mirroring reproducibility.mjs's computeDatasetSha256
// shape/intent exactly (question_id -> evaluation_item_id), so a dataset's
// identity is pinned without embedding any expected_* content in the
// dataset-level hash either.
export function computeDatasetItemsSha256(datasetRecords) {
  const slim = datasetRecords.map((record) => ({
    evaluation_item_id: record.evaluation_item_id,
    question: record.question,
    split: record.split,
  }));
  return sha256Hex(JSON.stringify(canonicalize(slim)));
}
