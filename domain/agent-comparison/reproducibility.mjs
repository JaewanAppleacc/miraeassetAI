// Turn P1.1: helpers for the BenchmarkRunManifest reproducibility pins
// (agent_variant_revision, model_config_sha256, prompt_template_sha256,
// dataset_sha256, code_revision). Every pin here is a HASH or a revision
// id -- never the raw content itself (a prompt template's SHA is pinned,
// not the template text; a dataset's SHA is pinned, not the dataset
// records). This module never reads or writes Gold/HOLDOUT/DEV_CHECK data.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

// sha256 of a deterministically key-sorted JSON encoding -- stable
// regardless of the property insertion order the caller happened to build
// the object in. Used for both "hash this object" (ModelConfig) and "hash
// this array of records" (a dataset's question list) callers.
export function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ModelConfig never contains the API key itself (only the env var NAME --
// see model-config.schema.json), so hashing the whole validated config is
// safe and never leaks a secret into a manifest.
export function computeModelConfigSha256(modelConfig) {
  return canonicalSha256(modelConfig);
}

export function computePromptTemplateSha256(templateText) {
  return sha256Hex(templateText);
}

export function computeDatasetSha256(questions) {
  return canonicalSha256(questions.map((q) => ({ question_id: q.question_id ?? null, question: q.question })));
}

// Best-effort, never throws: a manifest with `code_revision: "unknown"` is
// still valid and still useful (it honestly records that the revision
// could not be determined), rather than failing the whole benchmark run
// over a git lookup.
export function detectCodeRevision(cwd = process.cwd()) {
  try {
    const stdio = ["ignore", "pipe", "ignore"];
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio }).trim().length > 0;
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    return "unknown";
  }
}
