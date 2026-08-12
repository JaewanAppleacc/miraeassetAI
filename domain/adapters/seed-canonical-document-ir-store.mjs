// Real, read-only, INDEXED DocumentStore adapter (domain/runtime/
// citation-validator.mjs's `{ getDocument }` interface) over one or more
// canonical DocumentIR JSONL shards -- e.g.
// work/domain-seed/seed-canonical-document-ir.v0.6.jsonl +
// seed-canonical-document-ir.v0.7.delta.jsonl.
//
// This is NOT domain/adapters/a-document-ir-reader.mjs: that adapter does a
// fresh linear scan of a single JSONL file on every getDocument() call --
// fine for a 4-document sample, not for a real multi-shard Seed corpus.
// This module builds a document_id -> record index exactly ONCE, at
// construction, across every shard given to it, and answers every later
// getDocument() call from that in-memory index -- O(1) lookup, zero
// per-request file I/O, zero per-request re-scanning.
//
// Never writes to, mutates, or regenerates the source JSONL shards -- they
// are read exactly once each, in full, at construction time only. No path
// in this module is ever hardcoded; every shard path is supplied by the
// caller (directly, or indirectly via a release manifest path).
//
// FROZEN v1.1 note: this is a Runtime Host component (Component I/O:
// DocumentStore), not a change to A's canonical DocumentIR format, doc/node
// ID scheme, or source_locator semantics -- it only indexes and serves what
// A already produced, unmodified.
//
// ---------------------------------------------------------------------------
// Artifact integrity (official vs. sandbox/test mode)
// ---------------------------------------------------------------------------
// The first argument accepts two shapes:
//
//   1. An array of shard entries. Each entry is either
//        { path, sha256, record_count }   -- pinned, official mode
//      or a bare path string              -- ONLY accepted when
//                                             options.allowUnpinned === true
//   2. A path (string) to a seed release manifest (see
//      domain/releases/seed-release.v0.*.manifest.json) -- the artifact
//      entries whose role is in options.allowedRoles (default: BOTH
//      CANONICAL_DOCUMENT_IR_BASE and CANONICAL_DOCUMENT_IR_DELTA) are
//      extracted from it and used as pinned shard entries. EVERY role in
//      allowedRoles must appear EXACTLY ONCE in the manifest -- with the
//      default, a manifest declaring only BASE (or only DELTA) is
//      rejected; narrowing allowedRoles to e.g. just ["CANONICAL_DOCUMENT_
//      IR_BASE"] is the only way to accept a BASE-only manifest. This mode
//      is always pinned -- there is no unpinned variant of "read hashes
//      out of a release manifest" -- and the manifest's own top-level
//      corpus_snapshot_id is validated and pinned as the ONE expected
//      snapshot every resolved record's actual A->B mapping must equal.
//
// In official mode (the default), every shard MUST carry a pinned sha256
// and record_count -- missing either fails closed at construction. Bare,
// unpinned path strings are a sandbox/test-only convenience gated behind
// the explicit options.allowUnpinned flag; production/official callers
// never set it.
//
// The pinned sha256 is always verified against the shard file's RAW BYTES
// (read via fs/promises readFile into a Buffer and hashed before any UTF-8
// decoding or JSON parsing happens) -- never against a UTF-8-decoded string
// or the JSON.parse() result, so byte-level tampering or invalid encoding
// cannot be silently normalized away before the hash check runs. Decoding
// itself is fatal/strict UTF-8 (see decodeUtf8Strict), not the lossy
// Buffer#toString("utf8") that silently substitutes invalid byte sequences
// with U+FFFD.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { abortReason, RequestAbortedError } from "../runtime/abortable.mjs";
import { freezeSnapshotMap, looksLikeSnapshotId, remapSourceSnapshotId } from "./a-snapshot-contract.mjs";
import { validateDocumentIrRecord } from "./seed-artifact-schema-validators.mjs";

const CANONICAL_DOCUMENT_IR_ROLES = Object.freeze(["CANONICAL_DOCUMENT_IR_BASE", "CANONICAL_DOCUMENT_IR_DELTA"]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isValidSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isValidRecordCount(value) {
  return Number.isInteger(value) && value >= 0;
}

// Fatal (strict) UTF-8 decoding -- Buffer#toString("utf8") silently
// replaces invalid byte sequences with U+FFFD, which would let byte-level
// corruption or a genuinely wrong encoding pass straight through as
// "successfully decoded" text (and, if it happens to land outside a JSON
// string's structural bytes, even parse as JSON). A real DocumentIR shard
// is required to be valid UTF-8 by construction, so any decode failure
// here is itself a fail-closed signal, not something to paper over.
function decodeUtf8Strict(buffer, path, label = "shard") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error(`${path}: ${label} is not valid UTF-8: ${error.message}`);
  }
}

async function readShardBuffer(path) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(`${path}: could not read shard: ${error.message}`);
  }
}

// Validates `allowedRoles` and returns a frozen, independent copy --
// called synchronously at factory entry (before any await), so a caller
// mutating their original array after calling the factory (but before the
// returned Promise resolves) can never change which roles this store
// actually requires/accepts.
function freezeAllowedRoles(allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    throw new Error("options.allowedRoles must be a non-empty array of canonical DocumentIR roles");
  }
  for (const role of allowedRoles) {
    if (typeof role !== "string" || !CANONICAL_DOCUMENT_IR_ROLES.includes(role)) {
      throw new Error(`unrecognized canonical DocumentIR role "${role}": only ${CANONICAL_DOCUMENT_IR_ROLES.join(", ")} are accepted`);
    }
  }
  return Object.freeze([...allowedRoles]);
}

// A single shard entry: bare string path (sandbox/test only) or a pinned
// { path, sha256, record_count } object. Returns a normalized
// { path, sha256: string|null, record_count: number|null } -- a fresh
// plain object independent of whatever the caller passed in.
function normalizeShardEntry(entry, allowUnpinned) {
  if (typeof entry === "string") {
    if (entry === "") throw new Error("shard path must be a non-empty string");
    if (!allowUnpinned) {
      throw new Error(
        `shard "${entry}" was given as a bare path without a pinned sha256/record_count -- official mode requires ` +
          `{ path, sha256, record_count } entries (set options.allowUnpinned = true for sandbox/test use only)`
      );
    }
    return { path: entry, sha256: null, record_count: null };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string" || entry.path === "") {
    throw new Error('shard entry must be a non-empty path string, or an object with a non-empty "path"');
  }
  const hasHash = entry.sha256 !== undefined && entry.sha256 !== null;
  const hasCount = entry.record_count !== undefined && entry.record_count !== null;
  if (!allowUnpinned && (!hasHash || !hasCount)) {
    throw new Error(
      `${entry.path}: official mode requires both sha256 and record_count pinning (set options.allowUnpinned = true for sandbox/test use only)`
    );
  }
  if (hasHash && !isValidSha256(entry.sha256)) {
    throw new Error(`${entry.path}: sha256 must be a 64-character lowercase hex string`);
  }
  if (hasCount && !isValidRecordCount(entry.record_count)) {
    throw new Error(`${entry.path}: record_count must be a non-negative integer`);
  }
  return { path: entry.path, sha256: hasHash ? entry.sha256 : null, record_count: hasCount ? entry.record_count : null };
}

function normalizeShardList(shardsInput, allowUnpinned) {
  if (!Array.isArray(shardsInput) || shardsInput.length === 0) {
    throw new Error(
      "createSeedCanonicalDocumentIrStore requires a non-empty array of shard entries, or a release manifest path string"
    );
  }
  return shardsInput.map((entry) => normalizeShardEntry(entry, allowUnpinned));
}

// Extracts pinned shard entries for `allowedRoles` (default:
// CANONICAL_DOCUMENT_IR_BASE + CANONICAL_DOCUMENT_IR_DELTA -- `allowedRoles`
// is already validated + frozen by freezeAllowedRoles() before this is
// called) from a seed release manifest, plus the manifest's own top-level
// corpus_snapshot_id (validated and returned so the caller can bind every
// DocumentIR record's actual A->B-mapped snapshot to it). EVERY role in
// `allowedRoles` must appear EXACTLY ONCE among the manifest's artifacts --
// a role appearing twice, or not at all, both fail closed. This is what
// makes { allowedRoles: [BASE] } accept a BASE-only manifest while the
// default (both roles) always requires both to be present.
async function resolveShardsFromReleaseManifest(manifestPath, allowedRoles, root) {
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`${manifestPath}: could not read release manifest: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`${manifestPath}: malformed release manifest JSON: ${error.message}`);
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error(`${manifestPath}: release manifest has no artifacts[]`);
  }
  if (!looksLikeSnapshotId(manifest.corpus_snapshot_id)) {
    throw new Error(`${manifestPath}: release manifest.corpus_snapshot_id must be a non-empty string in the expected snapshot id format`);
  }

  const seenRoles = new Set();
  const entries = [];
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.role !== "string" || !allowedRoles.includes(artifact.role)) continue;
    if (seenRoles.has(artifact.role)) {
      throw new Error(`${manifestPath}: duplicate ${artifact.role} artifact declared in release manifest`);
    }
    seenRoles.add(artifact.role);
    if (typeof artifact.path !== "string" || artifact.path === "") {
      throw new Error(`${manifestPath}: ${artifact.role} artifact is missing a valid path`);
    }
    if (!isValidSha256(artifact.sha256)) {
      throw new Error(`${manifestPath}: ${artifact.role} artifact is missing a pinned sha256`);
    }
    if (!isValidRecordCount(artifact.record_count)) {
      throw new Error(`${manifestPath}: ${artifact.role} artifact is missing a pinned record_count`);
    }
    entries.push({ path: resolvePath(root, artifact.path), sha256: artifact.sha256, record_count: artifact.record_count });
  }

  const missingRoles = allowedRoles.filter((role) => !seenRoles.has(role));
  if (missingRoles.length > 0) {
    throw new Error(`${manifestPath}: release manifest is missing required canonical DocumentIR artifact(s): ${missingRoles.join(", ")}`);
  }

  return { entries, corpusSnapshotId: manifest.corpus_snapshot_id };
}

// Async factory: construction itself performs the (one-time) indexing work
// and the returned Promise is the ONLY way to obtain a usable store -- there
// is no partially-built object handed back before every shard has been
// fully read, hash/count-verified, schema-validated, and indexed. A caller
// cannot issue a getDocument() call "before initialization finishes"
// because there is nothing to call it on until this Promise resolves.
//
// Fails closed (rejects) on: a missing/unreadable shard file or release
// manifest, invalid UTF-8 or byte-level corruption in a shard (see
// decodeUtf8Strict), an unpinned shard entry outside sandbox/test mode, a
// shard whose real SHA-256 (over raw bytes) or actual valid-record count
// disagrees with its pinned value, a release manifest role outside
// CANONICAL_DOCUMENT_IR_BASE/DELTA, a duplicate canonical-role artifact in
// a release manifest, ANY role in `allowedRoles` not appearing exactly
// once among the manifest's artifacts (the default requires BOTH BASE and
// DELTA; narrowing allowedRoles to just one of them is the only way to
// accept a manifest that declares only that one), a missing or malformed
// release manifest.corpus_snapshot_id, malformed JSON on any line, a
// record that does not satisfy domain/interfaces/document-ir.schema.json,
// an unrecognized source corpus_snapshot_id (see a-snapshot-contract.mjs),
// the SAME document_id appearing more than once (within one shard or
// across shards -- never resolved by a "last shard wins" merge), a
// record's actual A->B-mapped corpus_snapshot_id disagreeing with either
// the release manifest's pinned corpus_snapshot_id (manifest mode) or an
// earlier shard's established snapshot (plain array mode), or ANY given
// shard contributing zero valid records (an empty/all-blank shard is a
// loud construction failure, never a silently-thinner-than-expected store
// that would later misreport a real document as DOCUMENT_NOT_FOUND).
//
// `options.snapshotMap` optionally overrides the shared A->B snapshot
// mapping (domain/adapters/a-snapshot-contract.mjs's default) -- validated
// and defensively copied + frozen synchronously, before any await, so a
// caller mutating their original map object after calling this factory
// (but before the returned Promise resolves) can never change what this
// store actually indexes with. `options.allowUnpinned` opts into
// sandbox/test mode (bare path strings, or entries missing sha256/
// record_count, are accepted). `options.allowedRoles` narrows which
// release-manifest artifact roles are recognized (default: both canonical
// DocumentIR roles, EACH required exactly once) -- also validated and
// defensively copied + frozen synchronously, before any await. `options.root`
// is the directory release-manifest artifact paths are resolved relative to
// (default: process.cwd()).
//
// In release-manifest mode, the manifest's own top-level corpus_snapshot_id
// is validated and pinned as the expected snapshot: every record's actual
// A->B-mapped corpus_snapshot_id must equal it exactly, not merely agree
// with whatever the first-seen record happened to claim.
export async function createSeedCanonicalDocumentIrStore(shardsOrManifestPath, options = {}) {
  const { allowUnpinned = false, root = process.cwd() } = options;
  const allowedRoles = freezeAllowedRoles(options.allowedRoles ?? CANONICAL_DOCUMENT_IR_ROLES);
  const snapshotMap = options.snapshotMap !== undefined ? freezeSnapshotMap(options.snapshotMap) : undefined;

  let shardEntries;
  let expectedSnapshotId = null;
  if (typeof shardsOrManifestPath === "string") {
    const resolved = await resolveShardsFromReleaseManifest(shardsOrManifestPath, allowedRoles, root);
    shardEntries = resolved.entries;
    expectedSnapshotId = resolved.corpusSnapshotId;
  } else {
    shardEntries = normalizeShardList(shardsOrManifestPath, allowUnpinned);
  }

  // Construction-time snapshot: this store's OWN frozen copy of the shard
  // path list. Mutating whatever the caller passed in after construction
  // can never change what this store considers its shards or reports via
  // shardPaths() -- normalizeShardEntry/resolveShardsFromReleaseManifest
  // already produced fresh plain objects above, so this is simply
  // capturing their paths.
  const shards = Object.freeze(shardEntries.map((entry) => entry.path));

  const index = new Map(); // document_id -> { record: frozen DocumentIR, shardPath }
  // When resolved from a release manifest, snapshotId starts pinned to the
  // manifest's own corpus_snapshot_id -- the very first record's mapped
  // snapshot is already checked against it below, not just against
  // whatever a later shard happens to agree with. Otherwise (plain array
  // of shard entries, no manifest) it starts null and is established by
  // the first record seen, as before.
  let snapshotId = expectedSnapshotId;

  for (const entry of shardEntries) {
    const buffer = await readShardBuffer(entry.path);

    if (entry.sha256 !== null) {
      const actualHash = sha256Hex(buffer);
      if (actualHash !== entry.sha256) {
        throw new Error(`${entry.path}: sha256 mismatch (actual ${actualHash}, pinned ${entry.sha256})`);
      }
    }

    // Only decoded to UTF-8 text (and only then parsed as JSONL) AFTER the
    // raw-byte hash check above has already run. Fatal/strict decoding --
    // see decodeUtf8Strict -- never silently substitutes invalid bytes.
    const lines = decodeUtf8Strict(buffer, entry.path).split(/\r?\n/);
    let recordsInThisShard = 0;

    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const lineNumber = i + 1;

      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`${entry.path}:${lineNumber}: malformed JSON: ${error.message}`);
      }

      const schemaErrors = validateDocumentIrRecord(record);
      if (schemaErrors.length > 0) {
        throw new Error(`${entry.path}:${lineNumber}: record does not satisfy document-ir.schema.json:\n  ${schemaErrors.join("\n  ")}`);
      }

      if (index.has(record.document_id)) {
        const existing = index.get(record.document_id);
        throw new Error(
          `duplicate document_id "${record.document_id}": first indexed from ${existing.shardPath}, seen again in ${entry.path}:${lineNumber}`
        );
      }

      const mappedSnapshotId = remapSourceSnapshotId(record.corpus_snapshot_id, snapshotMap ? { map: snapshotMap } : {});
      if (snapshotId === null) {
        snapshotId = mappedSnapshotId;
      } else if (mappedSnapshotId !== snapshotId) {
        throw new Error(
          expectedSnapshotId !== null
            ? `${entry.path}:${lineNumber}: corpus_snapshot_id "${mappedSnapshotId}" does not match the release manifest's pinned corpus_snapshot_id ("${expectedSnapshotId}")`
            : `${entry.path}:${lineNumber}: corpus_snapshot_id "${mappedSnapshotId}" disagrees with the snapshot ("${snapshotId}") established by earlier shards -- refusing to index a mixed-snapshot store`
        );
      }

      const remapped = { ...record, corpus_snapshot_id: mappedSnapshotId };
      index.set(record.document_id, { record: deepFreeze(remapped), shardPath: entry.path });
      recordsInThisShard++;
    }

    if (recordsInThisShard === 0) {
      throw new Error(`${entry.path}: shard contains zero valid records -- refusing to build a store that would silently under-serve it`);
    }
    if (entry.record_count !== null && recordsInThisShard !== entry.record_count) {
      throw new Error(
        `${entry.path}: pinned record_count ${entry.record_count} does not match actual valid record count ${recordsInThisShard}`
      );
    }
  }

  return Object.freeze({
    // Returns the frozen DocumentIR record, or null if document_id is not
    // indexed. Never throws for "not found" -- only for a genuine store
    // problem (e.g. an already-aborted signal), matching
    // domain/runtime/citation-validator.mjs's createDocumentStore
    // expectation that a thrown error means DOCUMENT_STORE_UNAVAILABLE and
    // a clean null means DOCUMENT_NOT_FOUND.
    async getDocument(documentId, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      const entry = index.get(documentId);
      return entry ? entry.record : null;
    },
    // Diagnostics only -- not part of the DocumentStore contract.
    documentCount() {
      return index.size;
    },
    shardPaths() {
      return shards;
    },
  });
}
