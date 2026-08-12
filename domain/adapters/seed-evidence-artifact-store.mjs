// Real, read-only EvidenceStore adapter (domain/runtime/
// citation-validator.mjs's `{ getEvidence }` interface) over a Seed
// Evidence artifact JSONL + its manifest -- e.g.
// work/domain-seed/seed-evidence-verified.v0.2.jsonl +
// seed-evidence-verified.v0.2.manifest.json.
//
// Before trusting a single record, this cross-checks the artifact's ACTUAL
// SHA-256 (over its raw bytes, not a UTF-8-decoded string -- see
// readFileBuffer/sha256HexOfBuffer below), record count, evidence_id set,
// and corpus_snapshot_id against what the manifest declares. A manifest
// that no longer matches its own artifact (stale, hand-edited, half-
// copied, or byte-level tampered) is exactly the kind of drift this must
// catch at construction time -- fail closed once, loudly -- not silently
// serve possibly-wrong data on every later request.
//
// IMPORTANT (does not decide policy): getEvidence() returns whatever
// verification_status the STORED record actually carries -- CANDIDATE
// stays CANDIDATE, this adapter never promotes it. Whether CANDIDATE data
// is usable on an official path is decided entirely by domain/runtime/
// citation-validator.mjs's createEvidenceStore/createCitationValidator
// (unmodified, imported by callers as-is) -- this module is a data source,
// not a trust decision.
//
// seed-evidence-verified.v0.2.jsonl is Seed-round Evidence that has not yet
// gone through human semantic review (see its own manifest/report). This
// module does not wire it, or any other artifact, as a default adapter
// anywhere in this repo -- it is only ever used when a caller explicitly
// constructs one with explicit paths (see agent-runtime.mjs's
// documentStoreAdapter/evidenceStoreAdapter injection points).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortReason, RequestAbortedError } from "../runtime/abortable.mjs";
import { looksLikeSnapshotId } from "./a-snapshot-contract.mjs";
import { validateEvidenceRecord } from "./seed-artifact-schema-validators.mjs";

function sha256HexOfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Fatal (strict) UTF-8 decoding -- Buffer#toString("utf8") silently
// replaces invalid byte sequences with U+FFFD, which would let byte-level
// corruption or a genuinely wrong encoding pass straight through as
// "successfully decoded" text. The evidence artifact is required to be
// valid UTF-8 by construction, so a decode failure here is itself a
// fail-closed signal.
function decodeUtf8Strict(buffer, path, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${path}: ${label} is not valid UTF-8: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const REQUIRED_MANIFEST_FIELDS = Object.freeze(["artifact_sha256", "record_count", "evidence_ids", "corpus_snapshot_id"]);

// The evidence artifact is read as a raw Buffer (never pre-decoded to a
// UTF-8 string) so its SHA-256 is computed over the exact bytes on disk --
// invalid UTF-8 or byte-level tampering must never be silently normalized
// away (e.g. by lossy replacement-character decoding) before the hash
// check runs. Only decoded to text, and only then split/parsed as JSONL,
// AFTER the hash comparison below has already passed.
async function readFileBuffer(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(`${path}: could not read ${label}: ${error.message}`);
  }
}

async function readTextFile(path, label) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: could not read ${label}: ${error.message}`);
  }
}

function parseJson(text, path, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: malformed ${label} JSON: ${error.message}`);
  }
}

// Async factory: construction performs the manifest cross-check and the
// one-time evidence_id index build. The returned Promise is the only way
// to obtain a usable store -- nothing is handed back before every check
// below has passed.
//
// Fails closed (rejects) on: a missing/unreadable evidence or manifest
// file, malformed JSON in either, a manifest missing a required
// cross-check field, a manifest.corpus_snapshot_id that is not a non-empty
// string, a record that does not satisfy semantic-bundle.schema.json's
// Evidence shape (domain/adapters/seed-artifact-schema-validators.mjs), an
// artifact whose real SHA-256/record count/evidence_id set disagrees with
// the manifest, or a duplicate evidence_id within the artifact itself (or
// within the manifest's own declared id list).
export async function createSeedEvidenceArtifactStore({ evidencePath, manifestPath }) {
  if (!evidencePath || !manifestPath) {
    throw new Error("createSeedEvidenceArtifactStore requires both evidencePath and manifestPath");
  }

  const [artifactBuffer, manifestText] = await Promise.all([
    readFileBuffer(evidencePath, "evidence artifact"),
    readTextFile(manifestPath, "manifest"),
  ]);
  const manifest = parseJson(manifestText, manifestPath, "manifest");

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`${manifestPath}: manifest is missing required field "${field}"`);
    }
  }
  if (!Array.isArray(manifest.evidence_ids)) {
    throw new Error(`${manifestPath}: manifest.evidence_ids must be an array`);
  }
  if (typeof manifest.artifact_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.artifact_sha256)) {
    throw new Error(`${manifestPath}: manifest.artifact_sha256 must be a 64-character lowercase hex string`);
  }
  // typeof === "string" && trim().length > 0, PLUS the common corpus
  // snapshot id shape check shared with a-snapshot-contract.mjs (rejects
  // whitespace-only, embedded-whitespace, and injection-shaped values).
  if (!looksLikeSnapshotId(manifest.corpus_snapshot_id)) {
    throw new Error(`${manifestPath}: manifest.corpus_snapshot_id must be a non-empty string in the expected snapshot id format`);
  }

  const actualHash = sha256HexOfBuffer(artifactBuffer);
  if (actualHash !== manifest.artifact_sha256) {
    throw new Error(
      `${evidencePath}: SHA-256 mismatch against ${manifestPath} (actual ${actualHash}, manifest declares ${manifest.artifact_sha256})`
    );
  }
  // Decoded to UTF-8 text (and only then split/parsed as JSONL) only AFTER
  // the raw-byte hash check above has already passed. Fatal/strict
  // decoding -- never silently substitutes invalid bytes.
  const artifactText = decodeUtf8Strict(artifactBuffer, evidencePath, "evidence artifact");

  const manifestIdList = manifest.evidence_ids;
  const manifestIdSet = new Set(manifestIdList);
  if (manifestIdSet.size !== manifestIdList.length) {
    throw new Error(`${manifestPath}: manifest.evidence_ids contains duplicate evidence_id entries`);
  }

  const index = new Map(); // evidence_id -> frozen record
  const lines = artifactText.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${evidencePath}:${i + 1}: malformed JSON: ${error.message}`);
    }
    const schemaErrors = validateEvidenceRecord(record);
    if (schemaErrors.length > 0) {
      throw new Error(
        `${evidencePath}:${i + 1}: record does not satisfy semantic-bundle.schema.json's Evidence shape:\n  ${schemaErrors.join("\n  ")}`
      );
    }
    if (index.has(record.evidence_id)) {
      throw new Error(`${evidencePath}:${i + 1}: duplicate evidence_id "${record.evidence_id}"`);
    }
    index.set(record.evidence_id, deepFreeze(record));
  }

  if (index.size !== manifest.record_count) {
    throw new Error(`${evidencePath}: record count mismatch (found ${index.size}, manifest declares ${manifest.record_count})`);
  }

  const indexedIdSet = new Set(index.keys());
  const missingFromArtifact = [...manifestIdSet].filter((id) => !indexedIdSet.has(id));
  const extraInArtifact = [...indexedIdSet].filter((id) => !manifestIdSet.has(id));
  if (missingFromArtifact.length > 0 || extraInArtifact.length > 0) {
    throw new Error(
      `${evidencePath}: evidence_id set does not match ${manifestPath} (missing from artifact: ${missingFromArtifact.length}, unexpected extra in artifact: ${extraInArtifact.length})`
    );
  }

  const corpusSnapshotId = manifest.corpus_snapshot_id;

  return Object.freeze({
    // Returns { corpus_snapshot_id, record } (record's own
    // verification_status is whatever was actually stored -- never
    // upgraded, never trusted from a caller) or null if evidence_id is not
    // indexed. Never throws for "not found" -- only for a genuine store
    // problem, matching createEvidenceStore's expectations.
    async getEvidence(evidenceId, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      const record = index.get(evidenceId);
      if (!record) return null;
      // corpus_snapshot_id in the envelope comes from the MANIFEST only --
      // never from the stored record, never from the caller.
      return Object.freeze({ corpus_snapshot_id: corpusSnapshotId, record });
    },
    recordCount() {
      return index.size;
    },
  });
}
