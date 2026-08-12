import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanonicalJsonlDocumentAdapter } from "../domain/adapters/a-document-ir-reader.mjs";
import { A_TO_B_SNAPSHOT_MAP, freezeSnapshotMap, remapSourceSnapshotId } from "../domain/adapters/a-snapshot-contract.mjs";
import { createSeedCanonicalDocumentIrStore } from "../domain/adapters/seed-canonical-document-ir-store.mjs";

// ---------------------------------------------------------------------------
// Regression coverage for requirement 1 of the Seed Artifact Store Adapter
// enhancement: domain/adapters/a-document-ir-reader.mjs (the single-shard
// sample reader) and domain/adapters/seed-canonical-document-ir-store.mjs
// (the indexed multi-shard Seed store) must NEVER declare their own copies
// of the A->B snapshot mapping -- both import the single shared contract in
// domain/adapters/a-snapshot-contract.mjs. These tests exercise BOTH
// modules against the SAME raw snapshot id and assert they agree, so a
// future edit that reintroduces a second, independently-maintained mapping
// in either module (and lets it drift) would be caught here.
// ---------------------------------------------------------------------------

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-contract-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURE_FILE_ID = `file_${"a".repeat(24)}`;

function docRecord(overrides = {}) {
  return {
    schema_version: "0.1.0",
    corpus_snapshot_id: "snap_7484a10220422056",
    document_id: "exchange_00000000000001",
    parser: { name: "test", version: "0.0.0", completed_at: "2026-01-01T00:00:00Z" },
    files: [
      {
        file_id: FIXTURE_FILE_ID,
        relative_path: "fixture.xml",
        file_role: "MAIN",
        detected_format: "XML",
        detected_encoding: "utf-8",
        parse_status: "SUCCESS",
        repair_used: false,
        text_loss_suspected: false,
        content_sha256: "a".repeat(64),
      },
    ],
    blocks: [
      {
        block_id: "b1",
        file_id: FIXTURE_FILE_ID,
        parent_block_id: null,
        block_type: "PARAGRAPH",
        ordinal: 0,
        section_path: [],
        source_locator: "loc.a",
        text: "fixture text",
      },
    ],
    ...overrides,
  };
}

test("the shared map has at least one known raw->corpus mapping, and remapSourceSnapshotId agrees with it for every entry", () => {
  const rawIds = Object.keys(A_TO_B_SNAPSHOT_MAP);
  assert.ok(rawIds.length > 0);
  for (const rawId of rawIds) {
    assert.equal(remapSourceSnapshotId(rawId), A_TO_B_SNAPSHOT_MAP[rawId]);
  }
});

test("regression: the Reader and the Store remap the SAME raw snapshot id to the SAME corpus_snapshot_id for an identical record", () =>
  withTmpDir(async (dir) => {
    const rawSnapshotId = Object.keys(A_TO_B_SNAPSHOT_MAP)[0];
    const record = docRecord({ corpus_snapshot_id: rawSnapshotId });
    const path = join(dir, "shared.jsonl");
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    const readerAdapter = createCanonicalJsonlDocumentAdapter(path);
    const fromReader = await readerAdapter.getDocument(record.document_id);

    const store = await createSeedCanonicalDocumentIrStore([path], { allowUnpinned: true });
    const fromStore = await store.getDocument(record.document_id);

    const expected = A_TO_B_SNAPSHOT_MAP[rawSnapshotId];
    assert.equal(fromReader.corpus_snapshot_id, expected);
    assert.equal(fromStore.corpus_snapshot_id, expected);
    assert.equal(fromReader.corpus_snapshot_id, fromStore.corpus_snapshot_id);
  }));

test("regression: the Reader and the Store BOTH reject the identical unrecognized raw snapshot id, never silently passing it through", () =>
  withTmpDir(async (dir) => {
    const record = docRecord({ corpus_snapshot_id: "snap_totally_unknown", document_id: "exchange_00000000000002" });
    const path = join(dir, "unknown.jsonl");
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    const readerAdapter = createCanonicalJsonlDocumentAdapter(path);
    await assert.rejects(() => readerAdapter.getDocument(record.document_id), /unrecognized source corpus_snapshot_id/);

    await assert.rejects(() => createSeedCanonicalDocumentIrStore([path], { allowUnpinned: true }), /unrecognized source corpus_snapshot_id/);
  }));

test("regression: an explicit snapshotMap override applies identically whether passed through the shared function directly or via the Store's factory option", () =>
  withTmpDir(async (dir) => {
    const customMap = { snap_custom_only: "corpus_custom_only" };
    const record = docRecord({ corpus_snapshot_id: "snap_custom_only", document_id: "exchange_00000000000003" });
    const path = join(dir, "custom.jsonl");
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    assert.equal(remapSourceSnapshotId("snap_custom_only", { map: customMap }), "corpus_custom_only");

    const store = await createSeedCanonicalDocumentIrStore([path], { allowUnpinned: true, snapshotMap: customMap });
    const fromStore = await store.getDocument(record.document_id);
    assert.equal(fromStore.corpus_snapshot_id, "corpus_custom_only");
  }));

// ---------------------------------------------------------------------------
// Snapshot mapping hardening: freezeSnapshotMap() validates every key/value
// pair (trim'd non-empty string, matching the shared snapshot-id shape) and
// returns a frozen, independent copy -- it is what
// seed-canonical-document-ir-store.mjs's factory runs a caller-supplied
// options.snapshotMap through, synchronously, before any await.
// ---------------------------------------------------------------------------

test("freezeSnapshotMap accepts a well-formed map and returns a frozen copy", () => {
  const frozen = freezeSnapshotMap({ snap_a: "corpus_a", snap_b: "corpus_b" });
  assert.deepEqual(frozen, { snap_a: "corpus_a", snap_b: "corpus_b" });
  assert.throws(() => {
    frozen.snap_a = "hacked";
  }, TypeError);
});

test("freezeSnapshotMap rejects a numeric mapping value", () => {
  assert.throws(() => freezeSnapshotMap({ snap_a: 12345 }), /must be a non-empty string/);
});

test("freezeSnapshotMap rejects an object mapping value", () => {
  assert.throws(() => freezeSnapshotMap({ snap_a: { nested: true } }), /must be a non-empty string/);
});

test("freezeSnapshotMap rejects a whitespace-only mapping value", () => {
  assert.throws(() => freezeSnapshotMap({ snap_a: "   " }), /must be a non-empty string/);
});

test("freezeSnapshotMap rejects a null or undefined mapping value", () => {
  assert.throws(() => freezeSnapshotMap({ snap_a: null }), /must be a non-empty string/);
  assert.throws(() => freezeSnapshotMap({ snap_a: undefined }), /must be a non-empty string/);
});

test("freezeSnapshotMap rejects a mapping value containing embedded whitespace or path-like characters", () => {
  assert.throws(() => freezeSnapshotMap({ snap_a: "corpus a" }), /must be a non-empty string/);
  assert.throws(() => freezeSnapshotMap({ snap_a: "corpus/a" }), /must be a non-empty string/);
});

test("freezeSnapshotMap rejects a non-object map (array, string, null, number)", () => {
  assert.throws(() => freezeSnapshotMap(["snap_a", "corpus_a"]), /plain object/);
  assert.throws(() => freezeSnapshotMap("snap_a"), /plain object/);
  assert.throws(() => freezeSnapshotMap(null), /plain object/);
  assert.throws(() => freezeSnapshotMap(42), /plain object/);
});

test("regression: mutating the caller's original snapshotMap object AFTER calling the Store factory (but before awaiting it) does not change the indexed result", () =>
  withTmpDir(async (dir) => {
    const mutableMap = { snap_defensive_copy_test: "corpus_before_mutation" };
    const record = docRecord({ corpus_snapshot_id: "snap_defensive_copy_test", document_id: "exchange_00000000000004" });
    const path = join(dir, "defensive-copy.jsonl");
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    const storePromise = createSeedCanonicalDocumentIrStore([path], { allowUnpinned: true, snapshotMap: mutableMap });
    // Mutate the ORIGINAL object synchronously, right after the call --
    // the factory's synchronous, pre-first-await freezeSnapshotMap() copy
    // must already have captured the pre-mutation value by this point.
    mutableMap.snap_defensive_copy_test = "corpus_AFTER_mutation_should_not_apply";

    const store = await storePromise;
    const doc = await store.getDocument("exchange_00000000000004");
    assert.equal(doc.corpus_snapshot_id, "corpus_before_mutation");
  }));
