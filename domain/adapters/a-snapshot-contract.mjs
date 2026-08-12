// The single source of truth for A's raw source snapshot id (e.g.
// "snap_7484a10220422056") -> B's corpus_snapshot_id (e.g.
// "corpus_04750795e1a2d5c3") mapping, documented in domain/HANDOFF.md.
//
// Both domain/adapters/a-document-ir-reader.mjs (the single-shard sample
// reader) and domain/adapters/seed-canonical-document-ir-store.mjs (the
// indexed multi-shard Seed store) import THIS module rather than each
// declaring their own copy of the mapping -- two independently maintained
// copies is exactly how they could silently drift apart (one adapter
// remapping a snapshot id the other doesn't recognize, or the two
// disagreeing about what a given raw id maps to).

// A loose "does this look like a snapshot id" shape check -- not a strict
// schema (document-ir.schema.json only requires corpus_snapshot_id to be a
// non-empty string; there is no repo-wide frozen ID pattern to bind to
// without overreaching FROZEN v1.1), but enough to reject the actual failure
// modes that matter: whitespace-only values, embedded whitespace, and
// path/quote/control-character injection-shaped strings. Real ids
// (snap_7484a10220422056, corpus_04750795e1a2d5c3) and test fixture ids
// (snap_one, corpus_custom_only, ...) both satisfy this.
const SNAPSHOT_ID_SHAPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function looksLikeSnapshotId(value) {
  // The pattern itself already excludes whitespace entirely (not in the
  // allowed character class), so a match implies "trimmed, non-empty, no
  // embedded whitespace" all at once -- no separate .trim() step needed.
  return typeof value === "string" && SNAPSHOT_ID_SHAPE_PATTERN.test(value);
}

function assertLooksLikeSnapshotId(value, label) {
  if (!looksLikeSnapshotId(value)) {
    throw new Error(
      `${label} must be a non-empty string matching ${SNAPSHOT_ID_SHAPE_PATTERN} (no leading/trailing whitespace, no embedded whitespace or path/quote characters), got ${JSON.stringify(value)}`
    );
  }
}

// Validates every key/value pair in a raw snapshot map, then returns a
// FROZEN, independent shallow copy -- the caller's original object (and any
// later mutation of it) can never affect the returned map. Rejects a map
// key or value that is missing, not a string, whitespace-only, or does not
// look like a snapshot id (numbers, objects, and arrays as values are all
// rejected by the typeof check alone).
export function freezeSnapshotMap(map) {
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("snapshot map must be a plain object of raw id -> corpus_snapshot_id string entries");
  }
  const copy = {};
  for (const [rawId, mappedId] of Object.entries(map)) {
    assertLooksLikeSnapshotId(rawId, "snapshot map key (raw id)");
    assertLooksLikeSnapshotId(mappedId, `snapshot map value for "${rawId}" (mapped corpus_snapshot_id)`);
    copy[rawId] = mappedId;
  }
  return Object.freeze(copy);
}

export const A_TO_B_SNAPSHOT_MAP = freezeSnapshotMap({
  snap_7484a10220422056: "corpus_04750795e1a2d5c3",
});

// Maps a raw A-side source_snapshot_id to its B-side corpus_snapshot_id.
// Deliberately does NOT pass an unrecognized raw id through unchanged --
// silently letting an unknown snapshot "just be itself" would make it
// invisible to snapshot-mismatch checks downstream (a record claiming to
// be from a snapshot nobody has ever mapped, treated as if that were fine)
// and let an unknown-but-syntactically-snapshot-like id collide with real
// B corpus_snapshot_id values. An unmapped id is always an explicit
// rejection here; the caller decides whether that surfaces as a
// construction failure or something else, but it is never silent.
//
// `map` defaults to the shared A_TO_B_SNAPSHOT_MAP but may be overridden
// (e.g. by tests, or by a future caller with a different, explicitly
// provided mapping) -- this is the "inject mapping via factory" half of
// the contract; the shared constant above is the "common contract module"
// half. Both adapters use this same function with its default map in
// normal operation. Callers that accept a caller-supplied map as a factory
// option (e.g. seed-canonical-document-ir-store.mjs's options.snapshotMap)
// should run it through freezeSnapshotMap() ONCE at factory entry (before
// any await) rather than relying on this per-lookup check alone -- that is
// what makes the defensive copy synchronous and immune to the caller
// mutating their original object mid-construction; this function's own
// per-lookup validation is a second, defense-in-depth layer, not a
// substitute for that.
export function remapSourceSnapshotId(rawSnapshotId, { map = A_TO_B_SNAPSHOT_MAP } = {}) {
  assertLooksLikeSnapshotId(rawSnapshotId, "source snapshot id");
  const mapped = map[rawSnapshotId];
  if (!mapped) {
    throw new Error(`unrecognized source corpus_snapshot_id "${rawSnapshotId}": no known A->B mapping for it`);
  }
  assertLooksLikeSnapshotId(mapped, `mapped corpus_snapshot_id for "${rawSnapshotId}"`);
  return mapped;
}
