// Turn P5: shared, pure helpers for the portable DocumentIR retrieval
// snapshot. Nothing here does I/O -- every function is a deterministic
// transform over its inputs so it can be unit-tested without the real
// 4,204-document corpus.
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "0.1.0";

export const DOC_GROUPS = Object.freeze(["periodic", "major", "exchange", "holding"]);

export const PARSE_STATUS = Object.freeze({
  SUCCESS: "SUCCESS",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
});

// Maps domain/adapters/a-document-ir.mjs's own mapCoverageState() states
// (PRESENT / PARTIAL_PARSE_FAILURE / PARSE_FAILED -- see domain/HANDOFF.md's
// "B parse coverage" line) onto this snapshot's own parse_status vocabulary.
// This module never redefines coverage semantics -- it only relabels the
// existing, frozen coverage states for this Turn's chunk/document schema.
const COVERAGE_TO_PARSE_STATUS = Object.freeze({
  PRESENT: PARSE_STATUS.SUCCESS,
  PARTIAL_PARSE_FAILURE: PARSE_STATUS.PARTIAL,
  PARSE_FAILED: PARSE_STATUS.FAILED,
});

export function coverageStateToParseStatus(coverageState) {
  const mapped = COVERAGE_TO_PARSE_STATUS[coverageState];
  if (!mapped) throw new Error(`unknown coverage state: ${coverageState}`);
  return mapped;
}

export const CHUNK_ID_PATTERN = /^chunk_[0-9a-f]{24}$/;
export const SNAPSHOT_ID_PATTERN = /^docsnap_[0-9a-f]{32}$/;
export const CORP_CODE_PATTERN = /^[0-9]{8}$/;
export const DOCUMENT_ID_PATTERN = /^(periodic|major|exchange|holding)_[0-9]{14}$/;

export function sha256Hex(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(bytes).digest("hex");
}

// Same recursive key-sort canonicalization convention already used by
// domain/postgres/reference-vector-retrieval-loader.mjs's own canonicalize()
// -- object key order must never affect a hash.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

// Strips the given top-level keys (e.g. "generated_at") before hashing, so a
// wall-clock timestamp never enters a reproducibility pin. Mirrors the
// intent of domain/agent-comparison/integration/determinism.mjs's
// canonicalizeExecutionTrace, but for a flat manifest object rather than an
// execution trace tree.
export function canonicalizeExcluding(value, excludedKeys) {
  const excluded = new Set(excludedKeys);
  const clone = canonicalize(value);
  for (const key of excluded) delete clone[key];
  return clone;
}

export function computeSnapshotId({ inputCorpusManifestSha256, sourceFileShas, chunkingPolicyId, chunkingPolicySha256, schemaVersion }) {
  const digest = sha256Hex({
    input_corpus_manifest_sha256: inputCorpusManifestSha256,
    source_file_shas: canonicalize(sourceFileShas),
    chunking_policy_id: chunkingPolicyId,
    chunking_policy_sha256: chunkingPolicySha256,
    schema_version: schemaVersion,
  });
  return `docsnap_${digest.slice(0, 32)}`;
}

// The chunk_id contract: snapshot_id + source_document_id + node_id +
// chunk_ordinal + text_sha256 -> one deterministic id, shaped exactly like
// domain/postgres/reference-vector-retrieval-repository.mjs's own
// `chunk_[0-9a-f]{24}` pattern so a P4 DOCUMENT_CHUNK compatibility adapter
// never needs to reshape it (see p4-document-chunk-adapter.mjs).
export function computeSnapshotChunkId({ snapshotId, sourceDocumentId, nodeId, chunkOrdinal, textSha256 }) {
  const digest = sha256Hex(`${snapshotId}\0${sourceDocumentId}\0${nodeId}\0${chunkOrdinal}\0${textSha256}`);
  return `chunk_${digest.slice(0, 24)}`;
}

export class PortabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "PortabilityError";
  }
}

// Rejects any path that is absolute, contains a ".." segment, or escapes
// (via a symlink or otherwise) the given root once resolved. Every path
// this module ever writes into a snapshot artifact must pass this check --
// "portable" here means "safe to hand to a different machine/user without
// leaking this machine's directory layout or reading outside its own root."
export function assertPortableRelativePath(relativePath, label = "path") {
  if (typeof relativePath !== "string" || relativePath === "") {
    throw new PortabilityError(`${label} must be a non-empty string`);
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new PortabilityError(`${label} must be repository/snapshot-relative, not absolute: ${relativePath}`);
  }
  if (relativePath.includes("~")) {
    throw new PortabilityError(`${label} must not reference a home directory: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new PortabilityError(`${label} must not contain ".." segments: ${relativePath}`);
  }
  return relativePath;
}
