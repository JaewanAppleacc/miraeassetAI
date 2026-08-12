// Real, read-only FactStore adapter (domain/runtime/fact-store.mjs's
// `{ getFact }` interface) over an explicitly PINNED Fact artifact
// (JSONL, one semantic-bundle.schema.json $defs.fact record per line) +
// its Fact Coverage Snapshot (a single domain/interfaces/
// fact-coverage-snapshot.schema.json document).
//
// No real Fact artifact or Coverage Snapshot exists in this repo yet --
// VERIFIED Fact/Event generation and Coverage Snapshot generation are both
// out of scope for this module. It only knows how to safely SERVE
// whichever pinned artifacts a caller explicitly supplies.
//
// Construction accepts ONLY explicit pins -- unlike
// seed-canonical-document-ir-store.mjs / seed-evidence-artifact-store.mjs,
// there is no allowUnpinned/sandbox convenience mode here:
//   { factArtifactPath, factArtifactSha256, factRecordCount,
//     factCoverageSnapshotPath, factCoverageSnapshotSha256 }
// All five are required; construction fails closed if any is missing or
// malformed, before any file is even opened.
//
// Both the Fact artifact and the Coverage Snapshot are read as raw Buffer
// bytes and SHA-256-verified against their pinned hash BEFORE any UTF-8
// decoding happens, and decoding itself is fatal/strict UTF-8 (never the
// lossy Buffer#toString("utf8") that silently substitutes invalid byte
// sequences with U+FFFD) -- byte-level tampering or invalid encoding can
// never be silently normalized away.
//
// IMPORTANT (does not decide policy): getFact() returns whatever
// verification_status the STORED Fact record actually carries -- CANDIDATE
// stays CANDIDATE, this adapter never promotes it. Whether CANDIDATE data
// is usable on an official path is decided entirely by domain/runtime/
// fact-store.mjs's createFactStore/createFactProvenanceValidator
// (unmodified, imported by callers as-is) -- this module is a data
// source, not a trust decision.
//
// KNOWN LIMITATIONS -- none of the following are cross-checked by this
// module, because doing so would require artifact inputs it does not take
// (Evidence, DocumentIR, Event) or would require inventing a semantic
// policy nobody has reviewed or asked for. A successful construction is
// NOT proof any of these are real or consistent:
//   - a coverage slot's evidence_ids[] (schema-validated for SHAPE only --
//     array of unique strings; no Evidence artifact input exists here to
//     cross-check against)
//   - a Fact record's OWN evidence_ids[] (same reason as above)
//   - a Fact record's source_document_id actually existing in any real
//     DocumentIR store (no DocumentIR input exists here)
//   - a Fact record's event_id actually existing as a real Event (no
//     Event artifact/store exists yet in this repo at all)
//   - a coverage slot's period_key having any particular semantic
//     relationship to a Fact's period_type/period_start/period_end/
//     as_of_date -- there is no official Fact-field mapping for
//     period_key, so this module deliberately does not invent one (only
//     corp_code, metric_code, and non-null scope are checked -- see the
//     "direct-dimension consistency" block below, which are the fields
//     with an unambiguous, identically-named correspondence)
//
// KNOWN LIMITATION (deliberate, not an oversight): the SAME fact_id is
// allowed to appear in more than one coverage slot (as long as each such
// slot's own corp_code/metric_code/scope agree with that fact -- see the
// dimension-consistency check). This module does not invent a "one
// fact_id, one slot" exclusivity policy -- that is an undecided semantic
// question outside this task's scope. The only duplication this module
// rejects is a duplicate slot_key within one Coverage Snapshot, which is
// unambiguous.
//
// AUTHORIZATION BOUNDARY: getFact() only ever serves a fact_id that is
// actually referenced by SOME slot in the CURRENT Coverage Snapshot (see
// authorizedFactIds below) -- a VERIFIED Fact sitting in the artifact but
// outside every slot's fact_ids is treated exactly like a Fact that does
// not exist. The Fact artifact is allowed to hold MORE records than the
// current Coverage Snapshot covers (that's a legitimate "spare capacity"
// state, not an integrity failure), but "present in the artifact" must
// never be conflated with "authorized for use by this Coverage Snapshot
// right now".
//
// This module does not wire itself as a default adapter anywhere in this
// repo -- it is only ever used when a caller explicitly constructs one
// with explicit paths/hashes (mirroring seed-evidence-artifact-store.mjs's
// documentStoreAdapter/evidenceStoreAdapter injection convention).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortReason, RequestAbortedError } from "../runtime/abortable.mjs";
import {
  SEMANTIC_BUNDLE_SCHEMA_VERSION,
  validateFactCoverageSnapshot,
  validateFactRecord,
} from "./seed-artifact-schema-validators.mjs";

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isValidSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertSha256(value, name) {
  if (!isValidSha256(value)) {
    throw new Error(`${name} must be a 64-character lowercase hex string`);
  }
}

function assertRecordCount(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

async function readFileBuffer(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(`${path}: could not read ${label}: ${error.message}`);
  }
}

// Fatal (strict) UTF-8 decoding -- see seed-canonical-document-ir-store.mjs /
// seed-evidence-artifact-store.mjs for the same helper and rationale: a
// real Seed artifact is required to be valid UTF-8 by construction, so any
// decode failure is itself a fail-closed signal, never something to paper
// over with lossy replacement-character decoding.
function decodeUtf8Strict(buffer, path, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${path}: ${label} is not valid UTF-8: ${error.message}`);
  }
}

// Async factory: construction performs the pin validation, the raw-byte
// hash/UTF-8/schema verification of BOTH artifacts, and the one-time
// fact_id index + coverage cross-validation. The returned Promise is the
// only way to obtain a usable store -- nothing is handed back before
// every check below has passed, and getFact() only ever does a Map
// lookup afterward (no per-request file I/O or re-validation).
//
// Fails closed (rejects) on: any missing/malformed pin field, a missing/
// unreadable fact artifact or coverage snapshot file, invalid UTF-8 or
// byte-level corruption in either (see decodeUtf8Strict), a real SHA-256
// (over raw bytes) disagreeing with its pinned value for either artifact,
// an actual valid Fact record count disagreeing with the pinned
// factRecordCount, malformed JSON on any Fact artifact line or in the
// coverage snapshot document, zero valid Fact records, a Fact record that
// does not satisfy semantic-bundle.schema.json's $defs.fact shape, a
// duplicate fact_id within the Fact artifact, a coverage snapshot that
// does not satisfy fact-coverage-snapshot.schema.json, a
// semantic_bundle_schema_version that disagrees with the official schema
// version this store actually validated every Fact against, a duplicate
// slot_key within the coverage snapshot, a coverage slot referencing a
// fact_id that is not indexed from the Fact artifact, a coverage slot
// referencing a fact_id whose stored verification_status is not VERIFIED,
// or a coverage slot whose corp_code/metric_code/non-null scope disagrees
// with the fact_id it references.
export async function createSeedFactArtifactStore(options = {}) {
  const { factArtifactPath, factArtifactSha256, factRecordCount, factCoverageSnapshotPath, factCoverageSnapshotSha256 } = options;

  assertNonEmptyString(factArtifactPath, "factArtifactPath");
  assertSha256(factArtifactSha256, "factArtifactSha256");
  assertRecordCount(factRecordCount, "factRecordCount");
  assertNonEmptyString(factCoverageSnapshotPath, "factCoverageSnapshotPath");
  assertSha256(factCoverageSnapshotSha256, "factCoverageSnapshotSha256");

  // --- Fact artifact: raw-byte hash, then fatal UTF-8 decode, then JSONL ---
  const factBuffer = await readFileBuffer(factArtifactPath, "fact artifact");
  const actualFactHash = sha256Hex(factBuffer);
  if (actualFactHash !== factArtifactSha256) {
    throw new Error(`${factArtifactPath}: sha256 mismatch (actual ${actualFactHash}, pinned ${factArtifactSha256})`);
  }
  const factText = decodeUtf8Strict(factBuffer, factArtifactPath, "fact artifact");

  const factIndex = new Map(); // fact_id -> frozen Fact record
  const factLines = factText.split(/\r?\n/);
  for (const [i, line] of factLines.entries()) {
    if (!line.trim()) continue;
    const lineNumber = i + 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${factArtifactPath}:${lineNumber}: malformed JSON: ${error.message}`);
    }

    const schemaErrors = validateFactRecord(record);
    if (schemaErrors.length > 0) {
      throw new Error(
        `${factArtifactPath}:${lineNumber}: record does not satisfy semantic-bundle.schema.json's Fact shape:\n  ${schemaErrors.join("\n  ")}`
      );
    }

    if (factIndex.has(record.fact_id)) {
      throw new Error(`${factArtifactPath}:${lineNumber}: duplicate fact_id "${record.fact_id}"`);
    }
    factIndex.set(record.fact_id, deepFreeze(record));
  }

  if (factIndex.size === 0) {
    throw new Error(`${factArtifactPath}: fact artifact contains zero valid records -- refusing to build a store that would silently under-serve it`);
  }
  if (factIndex.size !== factRecordCount) {
    throw new Error(`${factArtifactPath}: record count mismatch (found ${factIndex.size}, pinned ${factRecordCount})`);
  }

  // --- Coverage snapshot: raw-byte hash, then fatal UTF-8 decode, then JSON ---
  const coverageBuffer = await readFileBuffer(factCoverageSnapshotPath, "fact coverage snapshot");
  const actualCoverageHash = sha256Hex(coverageBuffer);
  if (actualCoverageHash !== factCoverageSnapshotSha256) {
    throw new Error(
      `${factCoverageSnapshotPath}: sha256 mismatch (actual ${actualCoverageHash}, pinned ${factCoverageSnapshotSha256})`
    );
  }
  const coverageText = decodeUtf8Strict(coverageBuffer, factCoverageSnapshotPath, "fact coverage snapshot");

  let coverage;
  try {
    coverage = JSON.parse(coverageText);
  } catch (error) {
    throw new Error(`${factCoverageSnapshotPath}: malformed JSON: ${error.message}`);
  }

  const coverageSchemaErrors = validateFactCoverageSnapshot(coverage);
  if (coverageSchemaErrors.length > 0) {
    throw new Error(
      `${factCoverageSnapshotPath}: does not satisfy fact-coverage-snapshot.schema.json:\n  ${coverageSchemaErrors.join("\n  ")}`
    );
  }

  // The Coverage Snapshot must have been produced against the SAME
  // semantic-bundle.schema.json version this store actually validated
  // every Fact record against (SEMANTIC_BUNDLE_SCHEMA_VERSION, read from
  // the official schema itself -- see seed-artifact-schema-validators.mjs
  // -- never a second hardcoded copy of the version string). The schema
  // itself only requires semantic_bundle_schema_version to be a non-empty
  // string; a Coverage Snapshot claiming a DIFFERENT (even otherwise
  // schema-valid) version is a real Fact-shape mismatch this store must
  // still catch.
  if (coverage.semantic_bundle_schema_version !== SEMANTIC_BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `${factCoverageSnapshotPath}: semantic_bundle_schema_version "${coverage.semantic_bundle_schema_version}" does not match the semantic-bundle.schema.json version this store validates Facts against ("${SEMANTIC_BUNDLE_SCHEMA_VERSION}")`
    );
  }

  // --- Coverage <-> Fact cross-validation ---
  // authorizedFactIds is the union of every slot's fact_ids -- the ONLY
  // Facts getFact() will ever serve. A Fact present in the artifact but
  // not referenced by any current Coverage slot is deliberately kept
  // un-servable: the Fact artifact may hold more records than the current
  // Coverage Snapshot actually covers (that's allowed), but "in the
  // artifact" must never be conflated with "authorized for use right
  // now" -- only Coverage decides that.
  const authorizedFactIds = new Set();
  const seenSlotKeys = new Set();
  for (const slot of coverage.slots) {
    if (seenSlotKeys.has(slot.slot_key)) {
      throw new Error(`${factCoverageSnapshotPath}: duplicate slot_key "${slot.slot_key}"`);
    }
    seenSlotKeys.add(slot.slot_key);

    for (const factId of slot.fact_ids) {
      const factRecord = factIndex.get(factId);
      if (!factRecord) {
        throw new Error(`${factCoverageSnapshotPath}: slot "${slot.slot_key}" references unknown fact_id "${factId}"`);
      }
      if (factRecord.verification_status !== "VERIFIED") {
        throw new Error(
          `${factCoverageSnapshotPath}: slot "${slot.slot_key}" references fact_id "${factId}" whose verification_status is "${factRecord.verification_status}", not VERIFIED`
        );
      }
      // Direct-dimension consistency: only fields with an unambiguous,
      // identically-named correspondence between a coverage slot and a
      // Fact record. slot.period_key has no official Fact-field mapping,
      // so it is deliberately NOT checked here -- inventing one would be
      // a new, un-reviewed semantic policy.
      if (slot.corp_code !== factRecord.corp_code) {
        throw new Error(
          `${factCoverageSnapshotPath}: slot "${slot.slot_key}" corp_code "${slot.corp_code}" does not match fact_id "${factId}" corp_code "${factRecord.corp_code}"`
        );
      }
      if (slot.metric_code !== factRecord.metric_code) {
        throw new Error(
          `${factCoverageSnapshotPath}: slot "${slot.slot_key}" metric_code "${slot.metric_code}" does not match fact_id "${factId}" metric_code "${factRecord.metric_code}"`
        );
      }
      // scope is NOT a required field in fact-coverage-snapshot.schema.json's
      // slot shape -- a slot may omit it entirely (undefined) or set it
      // explicitly to null; both mean "no scope filter", so `!= null`
      // (loose) is deliberate here, not a typo for `!==`. Only an actual
      // string scope is compared against the fact's own scope.
      if (slot.scope != null && slot.scope !== factRecord.scope) {
        throw new Error(
          `${factCoverageSnapshotPath}: slot "${slot.slot_key}" scope "${slot.scope}" does not match fact_id "${factId}" scope "${factRecord.scope}"`
        );
      }

      authorizedFactIds.add(factId);
    }
  }

  const corpusSnapshotId = coverage.corpus_snapshot_id;
  const factCoverageSnapshotId = coverage.fact_coverage_snapshot_id;
  const slotCount = coverage.slots.length;

  return Object.freeze({
    // Returns { corpus_snapshot_id, fact_coverage_snapshot_id, record }
    // (record's own verification_status is whatever was actually stored
    // -- never upgraded, never trusted from a caller) or null if fact_id
    // is not indexed OR is not authorized by the current Coverage
    // Snapshot (see authorizedFactIds above) -- a VERIFIED Fact sitting
    // in the artifact but outside every slot's fact_ids is exactly as
    // unservable as one that never existed. Never throws for "not found"
    // -- only for a genuine store problem, matching createFactStore's
    // expectations.
    async getFact(factId, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      if (!authorizedFactIds.has(factId)) return null;
      const record = factIndex.get(factId);
      // corpus_snapshot_id / fact_coverage_snapshot_id in the envelope
      // come from the COVERAGE SNAPSHOT only -- never from the stored
      // Fact record (which carries neither field), never from the caller.
      return Object.freeze({ corpus_snapshot_id: corpusSnapshotId, fact_coverage_snapshot_id: factCoverageSnapshotId, record });
    },
    // Diagnostics only -- not part of the FactStore contract.
    // factCount() is the FULL Fact artifact's record count; authorizedFactCount()
    // is the (generally smaller-or-equal) number of DISTINCT fact_ids the
    // current Coverage Snapshot actually authorizes getFact() to serve.
    factCount() {
      return factIndex.size;
    },
    authorizedFactCount() {
      return authorizedFactIds.size;
    },
    slotCount() {
      return slotCount;
    },
  });
}
