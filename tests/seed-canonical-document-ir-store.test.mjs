import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSeedCanonicalDocumentIrStore } from "../domain/adapters/seed-canonical-document-ir-store.mjs";
import { createDocumentStore } from "../domain/runtime/citation-validator.mjs";

// ---------------------------------------------------------------------------
// Always-run: small self-contained fixtures, no dependency on local work/
// data -- these exercise every success/failure path on every machine.
//
// Every fixture below must be genuinely valid against
// domain/interfaces/document-ir.schema.json -- the store now rejects any
// record that isn't, so a fixture that merely "looks plausible" is not
// good enough (this bit us once already: file_id/block file_id must match
// ^file_[0-9a-f]{24}$, files[] must be non-empty, etc).
// ---------------------------------------------------------------------------

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "doc-ir-store-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeShard(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Writes a shard and returns a genuinely-correct { path, sha256,
// record_count } pinned entry for it, computed from the SAME bytes just
// written -- tests that want to break ONE specific pin can start from a
// known-good entry and corrupt only that field.
function writePinnedShard(path, records) {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body);
  return { path, sha256: sha256Hex(Buffer.from(body, "utf8")), record_count: records.length };
}

function writeReleaseManifest(path, artifacts, overrides = {}) {
  writeFileSync(
    path,
    JSON.stringify({ schema_version: "0.1.0", corpus_snapshot_id: "corpus_04750795e1a2d5c3", artifacts, ...overrides })
  );
}

const FIXTURE_FILE_ID = `file_${"a".repeat(24)}`;

function file(overrides = {}) {
  return {
    file_id: FIXTURE_FILE_ID,
    relative_path: "fixture.xml",
    file_role: "MAIN",
    detected_format: "XML",
    detected_encoding: "utf-8",
    parse_status: "SUCCESS",
    repair_used: false,
    text_loss_suspected: false,
    content_sha256: "a".repeat(64),
    ...overrides,
  };
}

function block(overrides = {}) {
  return {
    block_id: "b1",
    file_id: FIXTURE_FILE_ID,
    parent_block_id: null,
    block_type: "PARAGRAPH",
    ordinal: 0,
    section_path: [],
    source_locator: "loc.a",
    text: "fixture text",
    ...overrides,
  };
}

function docRecord(overrides = {}) {
  return {
    schema_version: "0.1.0",
    corpus_snapshot_id: "snap_7484a10220422056",
    document_id: "exchange_00000000000000",
    parser: { name: "test", version: "0.0.0", completed_at: "2026-01-01T00:00:00Z" },
    files: [file()],
    blocks: [block()],
    ...overrides,
  };
}

test("resolves a document from each of two shards", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "a.jsonl");
    const shardB = join(dir, "b.jsonl");
    writeShard(shardA, [docRecord({ document_id: "exchange_00000000000001", blocks: [block({ text: "from shard A" })] })]);
    writeShard(shardB, [docRecord({ document_id: "exchange_00000000000002", blocks: [block({ text: "from shard B" })] })]);

    const store = await createSeedCanonicalDocumentIrStore([shardA, shardB], { allowUnpinned: true });
    const a = await store.getDocument("exchange_00000000000001");
    const b = await store.getDocument("exchange_00000000000002");
    assert.equal(a.document_id, "exchange_00000000000001");
    assert.equal(a.blocks[0].text, "from shard A");
    assert.equal(b.document_id, "exchange_00000000000002");
    assert.equal(b.blocks[0].text, "from shard B");
    assert.equal(store.documentCount(), 2);
  }));

test("remaps A's raw snapshot id to B's corpus_snapshot_id, same as the sample-only reader", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const doc = await store.getDocument("exchange_00000000000001");
    assert.equal(doc.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
  }));

test("rejects (fails closed) a duplicate document_id across two different shards", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "a.jsonl");
    const shardB = join(dir, "b.jsonl");
    writeShard(shardA, [docRecord({ document_id: "exchange_00000000000009" })]);
    writeShard(shardB, [docRecord({ document_id: "exchange_00000000000009" })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shardA, shardB], { allowUnpinned: true }), /duplicate document_id/);
  }));

test("rejects a duplicate document_id within the SAME shard", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000009" }), docRecord({ document_id: "exchange_00000000000009" })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /duplicate document_id/);
  }));

test("rejects malformed JSON on any line", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeFileSync(shard, `${JSON.stringify(docRecord())}\nnot valid json\n`);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /malformed JSON/);
  }));

test("rejects a record missing document_id", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const { document_id, ...withoutId } = docRecord();
    writeShard(shard, [withoutId]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /does not satisfy document-ir\.schema\.json/);
  }));

test("rejects a record with an empty files[] array", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ files: [] })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /does not satisfy document-ir\.schema\.json/);
  }));

test("rejects a record missing blocks[] entirely", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const { blocks, ...withoutBlocks } = docRecord();
    writeShard(shard, [withoutBlocks]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /does not satisfy document-ir\.schema\.json/);
  }));

test("rejects a record whose block is missing required source_locator", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const { source_locator, ...blockWithoutLocator } = block();
    writeShard(shard, [docRecord({ blocks: [blockWithoutLocator] })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /does not satisfy document-ir\.schema\.json/);
  }));

test("rejects a record whose file_id does not match the required file_<24 hex> pattern", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ files: [file({ file_id: "file_not_hex" })] })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /does not satisfy document-ir\.schema\.json/);
  }));

test("rejects a shard containing invalid UTF-8 byte sequences instead of silently substituting them", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const validLine = Buffer.from(`${JSON.stringify(docRecord())}\n`, "utf8");
    const invalidByte = Buffer.from([0xff]); // never valid as a UTF-8 lead byte
    writeFileSync(shard, Buffer.concat([validLine, invalidByte, Buffer.from("\n")]));
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }),
      /is not valid UTF-8/
    );
  }));

test("rejects construction against a shard path that does not exist -- distinct from a document simply not being found", () =>
  withTmpDir(async (dir) => {
    const missingPath = join(dir, "does-not-exist.jsonl");
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([missingPath], { allowUnpinned: true }), /could not read shard/);
  }));

test("rejects shards whose corpus_snapshot_id disagrees with each other (custom map covering two distinct raw ids)", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "a.jsonl");
    const shardB = join(dir, "b.jsonl");
    writeShard(shardA, [docRecord({ document_id: "exchange_00000000000001", corpus_snapshot_id: "snap_one" })]);
    writeShard(shardB, [docRecord({ document_id: "exchange_00000000000002", corpus_snapshot_id: "snap_two" })]);
    await assert.rejects(
      () =>
        createSeedCanonicalDocumentIrStore([shardA, shardB], {
          allowUnpinned: true,
          snapshotMap: { snap_one: "corpus_one", snap_two: "corpus_two" },
        }),
      /disagrees with the snapshot/
    );
  }));

test("rejects a record whose corpus_snapshot_id is not recognized by the shared A->B mapping", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ corpus_snapshot_id: "snap_totally_unknown" })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /unrecognized source corpus_snapshot_id/);
  }));

test("getDocument returns null for an unknown document_id (never throws for 'not found')", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const result = await store.getDocument("doc_does_not_exist");
    assert.equal(result, null);
  }));

test("through the real (unmodified) createDocumentStore: NOT_FOUND and STORE_UNAVAILABLE are distinguishable outcomes", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const context = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
    const documentStore = createDocumentStore(store, context);

    const notFound = await documentStore.resolve("doc_missing");
    assert.deepEqual(notFound, { ok: false, code: "DOCUMENT_NOT_FOUND" });

    const unavailable = createDocumentStore(null, context); // no adapter at all -- genuinely unavailable
    const unavailableResult = await unavailable.resolve("exchange_00000000000001");
    assert.deepEqual(unavailableResult, { ok: false, code: "DOCUMENT_STORE_UNAVAILABLE" });

    // Positive control: a document that IS indexed resolves ok through the
    // same real Store wrapper.
    const found = await documentStore.resolve("exchange_00000000000001");
    assert.equal(found.ok, true);
    assert.equal(found.documentIR.document_id, "exchange_00000000000001");
  }));

test("through the real createDocumentStore: a snapshot mismatch is caught even though the document itself resolves", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]); // remaps to corpus_04750795e1a2d5c3
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const wrongContext = { corpus_snapshot_id: "corpus_some_other_snapshot" };
    const documentStore = createDocumentStore(store, wrongContext);
    const result = await documentStore.resolve("exchange_00000000000001");
    assert.deepEqual(result, { ok: false, code: "SNAPSHOT_MISMATCH" });
  }));

test("returned documents are deep-frozen -- top-level and nested mutation both fail", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const doc = await store.getDocument("exchange_00000000000001");
    assert.throws(() => {
      doc.document_id = "hacked";
    }, TypeError);
    assert.throws(() => {
      doc.blocks.push({ text: "injected" });
    }, TypeError);
    assert.throws(() => {
      doc.blocks[0].text = "tampered";
    }, TypeError);

    // A second, independent fetch still returns the original, untampered data.
    const again = await store.getDocument("exchange_00000000000001");
    assert.equal(again.document_id, "exchange_00000000000001");
    assert.equal(again.blocks.length, 1);
    assert.equal(again.blocks[0].text, "fixture text");
  }));

test("mutating the caller's shardPaths array AFTER construction does not change what the store considers its shards", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "a.jsonl");
    writeShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const paths = [shardA];
    const store = await createSeedCanonicalDocumentIrStore(paths, { allowUnpinned: true });

    paths.push("/some/path/added/after/construction.jsonl");
    paths[0] = "/tampered/path.jsonl";

    assert.deepEqual(store.shardPaths(), [shardA]);
    const doc = await store.getDocument("exchange_00000000000001"); // still resolvable -- the mutation changed nothing
    assert.equal(doc.document_id, "exchange_00000000000001");
  }));

test("an already-aborted signal rejects with RequestAbortedError and never returns the document, even though it IS indexed", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => store.getDocument("exchange_00000000000001", { signal: controller.signal }), /request aborted/);
  }));

test("through the real createDocumentStore: an already-aborted signal throws before the adapter is ever called", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    const context = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
    const controller = new AbortController();
    controller.abort();
    const documentStore = createDocumentStore(store, context, controller.signal);
    await assert.rejects(() => documentStore.resolve("exchange_00000000000001"));
  }));

test("no per-request re-scan: after construction, deleting the shard file from disk still lets an already-indexed document resolve", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true });
    unlinkSync(shard); // the file is now gone entirely
    const doc = await store.getDocument("exchange_00000000000001"); // must still work -- served from the in-memory index
    assert.equal(doc.document_id, "exchange_00000000000001");
  }));

test("construction requires a non-empty array of shard paths", async () => {
  await assert.rejects(() => createSeedCanonicalDocumentIrStore([]));
  await assert.rejects(() => createSeedCanonicalDocumentIrStore(null));
  await assert.rejects(() => createSeedCanonicalDocumentIrStore("not-an-array"));
});

// ---------------------------------------------------------------------------
// Artifact integrity: pinned { path, sha256, record_count } entries
// (official mode, the default) vs. bare unpinned path strings
// (options.allowUnpinned = true, sandbox/test only).
// ---------------------------------------------------------------------------

test("official mode rejects a bare path string without options.allowUnpinned", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    writeShard(shard, [docRecord()]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard]), /without a pinned sha256\/record_count/);
  }));

test("official mode rejects a pinned entry missing sha256", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord()]);
    delete pinned.sha256;
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([pinned]), /requires both sha256 and record_count pinning/);
  }));

test("official mode rejects a pinned entry missing record_count", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord()]);
    delete pinned.record_count;
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([pinned]), /requires both sha256 and record_count pinning/);
  }));

test("accepts a correctly pinned { path, sha256, record_count } entry in official (default) mode", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord({ document_id: "exchange_00000000000001" })]);
    const store = await createSeedCanonicalDocumentIrStore([pinned]);
    const doc = await store.getDocument("exchange_00000000000001");
    assert.ok(doc);
  }));

test("rejects a shard whose real SHA-256 disagrees with its pinned value", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord()]);
    pinned.sha256 = "f".repeat(64); // wrong, but still a syntactically valid hex hash
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([pinned]), /sha256 mismatch/);
  }));

test("rejects a shard whose actual valid record count disagrees with its pinned record_count", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord()]);
    pinned.record_count = 2; // only 1 record was actually written
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([pinned]), /pinned record_count 2 does not match actual valid record count 1/);
  }));

test("rejects a pinned sha256 that is not a 64-character lowercase hex string", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinned = writePinnedShard(shard, [docRecord()]);
    pinned.sha256 = "not-hex";
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([pinned]), /sha256 must be a 64-character lowercase hex string/);
  }));

test("rejects a pinned record_count that is negative or non-integer", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "a.jsonl");
    const pinnedA = writePinnedShard(shard, [docRecord()]);
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore([{ ...pinnedA, record_count: -1 }]),
      /record_count must be a non-negative integer/
    );
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore([{ ...pinnedA, record_count: 1.5 }]),
      /record_count must be a non-negative integer/
    );
  }));

// ---------------------------------------------------------------------------
// Artifact integrity: resolving pinned shard entries from a release
// manifest path (always official mode -- there is no unpinned variant of
// "read hashes out of a release manifest").
// ---------------------------------------------------------------------------

test("resolves pinned canonical shards from a release manifest path and indexes both", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const shardB = join(dir, "delta.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
      { role: "CANONICAL_DOCUMENT_IR_DELTA", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
      { role: "SOME_OTHER_ARTIFACT", path: join(dir, "irrelevant.json"), sha256: "a".repeat(64), record_count: null },
    ]);

    const store = await createSeedCanonicalDocumentIrStore(manifestPath);
    assert.equal(store.documentCount(), 2);
    assert.ok(await store.getDocument("exchange_00000000000001"));
    assert.ok(await store.getDocument("exchange_00000000000002"));
  }));

test("rejects a release manifest declaring a duplicate canonical role", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const shardB = join(dir, "base2.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
    ]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore(manifestPath), /duplicate CANONICAL_DOCUMENT_IR_BASE artifact/);
  }));

test("rejects a release manifest declaring NO canonical DocumentIR artifacts at all", () =>
  withTmpDir(async (dir) => {
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [{ role: "SOME_OTHER_ARTIFACT", path: join(dir, "irrelevant.json"), sha256: "a".repeat(64), record_count: null }]);
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath),
      /missing required canonical DocumentIR artifact\(s\): CANONICAL_DOCUMENT_IR_BASE, CANONICAL_DOCUMENT_IR_DELTA/
    );
  }));

test("rejects a caller-supplied allowedRoles list containing a role other than the two canonical DocumentIR roles", () =>
  withTmpDir(async (dir) => {
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [{ role: "CANONICAL_DOCUMENT_IR_BASE", path: "x", sha256: "a".repeat(64), record_count: 1 }]);
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath, { allowedRoles: ["CANONICAL_DOCUMENT_IR_BASE", "SOME_OTHER_ROLE"] }),
      /unrecognized canonical DocumentIR role "SOME_OTHER_ROLE"/
    );
  }));

test("rejects a release manifest artifact matching an allowed role but missing a pinned sha256/record_count", () =>
  withTmpDir(async (dir) => {
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [{ role: "CANONICAL_DOCUMENT_IR_BASE", path: "x", sha256: null, record_count: null }]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore(manifestPath), /missing a pinned sha256/);
  }));

// ---------------------------------------------------------------------------
// allowedRoles completeness: in default (BASE + DELTA) mode, a manifest
// declaring only ONE of the two is rejected -- narrowing allowedRoles to
// exactly the role(s) actually present is the only way to accept a
// partial manifest.
// ---------------------------------------------------------------------------

test("default allowedRoles (BASE + DELTA) rejects a manifest declaring ONLY CANONICAL_DOCUMENT_IR_BASE", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
    ]);
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath),
      /missing required canonical DocumentIR artifact\(s\): CANONICAL_DOCUMENT_IR_DELTA/
    );
  }));

test("default allowedRoles (BASE + DELTA) rejects a manifest declaring ONLY CANONICAL_DOCUMENT_IR_DELTA", () =>
  withTmpDir(async (dir) => {
    const shardB = join(dir, "delta.jsonl");
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_DELTA", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
    ]);
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath),
      /missing required canonical DocumentIR artifact\(s\): CANONICAL_DOCUMENT_IR_BASE/
    );
  }));

test("explicit allowedRoles = [CANONICAL_DOCUMENT_IR_BASE] accepts a manifest declaring only BASE", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
    ]);
    const store = await createSeedCanonicalDocumentIrStore(manifestPath, { allowedRoles: ["CANONICAL_DOCUMENT_IR_BASE"] });
    assert.equal(store.documentCount(), 1);
    assert.ok(await store.getDocument("exchange_00000000000001"));
  }));

test("regression: mutating the caller's original allowedRoles array AFTER calling the factory (but before awaiting it) does not change which roles are required", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(manifestPath, [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
    ]);

    const mutableRoles = ["CANONICAL_DOCUMENT_IR_BASE"];
    const storePromise = createSeedCanonicalDocumentIrStore(manifestPath, { allowedRoles: mutableRoles });
    // Mutate the ORIGINAL array synchronously, right after the call -- if
    // this were read lazily (not defensively copied+frozen up front), the
    // pending manifest read would now also require DELTA and fail.
    mutableRoles.push("CANONICAL_DOCUMENT_IR_DELTA");

    const store = await storePromise;
    assert.equal(store.documentCount(), 1);
  }));

// ---------------------------------------------------------------------------
// Manifest snapshot binding: the release manifest's own top-level
// corpus_snapshot_id is validated and pinned; every resolved record's
// actual A->B-mapped snapshot must equal it exactly.
// ---------------------------------------------------------------------------

test("rejects a release manifest missing a top-level corpus_snapshot_id", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const shardB = join(dir, "delta.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schema_version: "0.1.0",
        artifacts: [
          { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
          { role: "CANONICAL_DOCUMENT_IR_DELTA", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
        ],
      })
    );
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath),
      /release manifest\.corpus_snapshot_id must be a non-empty string/
    );
  }));

test("rejects a release manifest whose top-level corpus_snapshot_id is whitespace-only or wrongly typed", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const shardB = join(dir, "delta.jsonl");
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const artifacts = [
      { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
      { role: "CANONICAL_DOCUMENT_IR_DELTA", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
    ];

    const manifestPathA = join(dir, "whitespace.manifest.json");
    writeReleaseManifest(manifestPathA, artifacts, { corpus_snapshot_id: "   " });
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPathA),
      /release manifest\.corpus_snapshot_id must be a non-empty string/
    );

    const manifestPathB = join(dir, "numeric.manifest.json");
    writeReleaseManifest(manifestPathB, artifacts, { corpus_snapshot_id: 12345 });
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPathB),
      /release manifest\.corpus_snapshot_id must be a non-empty string/
    );
  }));

test("rejects when a record's actual A->B-mapped snapshot disagrees with the release manifest's pinned corpus_snapshot_id", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "base.jsonl");
    const shardB = join(dir, "delta.jsonl");
    // Both shards use the default raw snapshot id, which maps (via the
    // real A_TO_B_SNAPSHOT_MAP) to "corpus_04750795e1a2d5c3" -- but the
    // manifest below pins a DIFFERENT (still validly-shaped) snapshot id.
    const pinnedA = writePinnedShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    const pinnedB = writePinnedShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    const manifestPath = join(dir, "release.manifest.json");
    writeReleaseManifest(
      manifestPath,
      [
        { role: "CANONICAL_DOCUMENT_IR_BASE", path: pinnedA.path, sha256: pinnedA.sha256, record_count: pinnedA.record_count },
        { role: "CANONICAL_DOCUMENT_IR_DELTA", path: pinnedB.path, sha256: pinnedB.sha256, record_count: pinnedB.record_count },
      ],
      { corpus_snapshot_id: "corpus_intentionally_wrong" }
    );
    await assert.rejects(
      () => createSeedCanonicalDocumentIrStore(manifestPath),
      /does not match the release manifest's pinned corpus_snapshot_id \("corpus_intentionally_wrong"\)/
    );
  }));

// ---------------------------------------------------------------------------
// Empty-shard fail-closed behavior (requirement: a shard contributing zero
// valid records must never silently produce a thinner-than-expected store
// that would later misreport a real document as DOCUMENT_NOT_FOUND).
// ---------------------------------------------------------------------------

test("rejects (fails closed) when the only shard given is entirely empty", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "empty.jsonl");
    writeFileSync(shard, "");
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /zero valid records/);
  }));

test("rejects (fails closed) when the only shard given contains only blank/whitespace lines", () =>
  withTmpDir(async (dir) => {
    const shard = join(dir, "blank-lines.jsonl");
    writeFileSync(shard, "\n\n   \n\t\n");
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shard], { allowUnpinned: true }), /zero valid records/);
  }));

test("rejects (fails closed) when ONE of several shards is empty, even though the others have valid records", () =>
  withTmpDir(async (dir) => {
    const shardA = join(dir, "a.jsonl");
    const shardEmpty = join(dir, "empty.jsonl");
    const shardB = join(dir, "b.jsonl");
    writeShard(shardA, [docRecord({ document_id: "exchange_00000000000001" })]);
    writeFileSync(shardEmpty, "");
    writeShard(shardB, [docRecord({ document_id: "exchange_00000000000002" })]);
    await assert.rejects(() => createSeedCanonicalDocumentIrStore([shardA, shardEmpty, shardB], { allowUnpinned: true }), /zero valid records/);
  }));

// ---------------------------------------------------------------------------
// Optional, read-only integration against the real Seed corpus shards.
// Skips cleanly when that local-only data isn't present (see
// tests/citation-real-data-integration.test.mjs for the established
// pattern this mirrors). Never writes to these files.
//
// Every record in the real shards must ALSO satisfy the official
// document-ir.schema.json -- construction above would already reject the
// whole store if even one record didn't, so a successful construction here
// is itself the "real Seed artifact passes official schema validation"
// confirmation the task asked for.
// ---------------------------------------------------------------------------

const REAL_SHARD_V06 = resolve("work/domain-seed/seed-canonical-document-ir.v0.6.jsonl");
const REAL_SHARD_V07_DELTA = resolve("work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl");
const HAS_REAL_SHARDS = existsSync(REAL_SHARD_V06) && existsSync(REAL_SHARD_V07_DELTA);
const REAL_RELEASE_MANIFEST = resolve("domain/releases/seed-release.v0.11.manifest.json");
const HAS_REAL_RELEASE_MANIFEST = HAS_REAL_SHARDS && existsSync(REAL_RELEASE_MANIFEST);

test(
  "real data: indexes both real Seed shards (each record passing document-ir.schema.json) and resolves a known document from each without error",
  { skip: !HAS_REAL_SHARDS },
  async () => {
    const store = await createSeedCanonicalDocumentIrStore([REAL_SHARD_V06, REAL_SHARD_V07_DELTA], { allowUnpinned: true });
    // These shards are the Seed-scoped canonical subset (54 documents +
    // 1 delta addition), not the full 4,204-document corpus -- see
    // domain/HANDOFF.md / CLAUDE.md section 9. Each document can still be
    // very large (large tables), hence the 121MB v0.6 file for only 54
    // records.
    assert.equal(store.documentCount(), 55);

    // exchange_20230428800439 is a known v0.6 document used elsewhere in
    // this repo's own real-data tests (tests/citation-real-data-integration.test.mjs).
    const fromV06 = await store.getDocument("exchange_20230428800439");
    assert.ok(fromV06);
    assert.equal(fromV06.document_id, "exchange_20230428800439");

    // exchange_20250428800407 is the one document the v0.7 delta shard adds.
    const fromDelta = await store.getDocument("exchange_20250428800407");
    assert.ok(fromDelta);
    assert.equal(fromDelta.document_id, "exchange_20250428800407");
  }
);

test(
  "real data, OFFICIAL mode: the real Seed v0.11 release manifest pins both canonical DocumentIR shards and both pass hash/count verification",
  { skip: !HAS_REAL_RELEASE_MANIFEST },
  async () => {
    // No allowUnpinned here -- this exercises the real, actually-shipped
    // release manifest's CANONICAL_DOCUMENT_IR_BASE/DELTA sha256 and
    // record_count pins in full official mode.
    const store = await createSeedCanonicalDocumentIrStore(REAL_RELEASE_MANIFEST);
    assert.equal(store.documentCount(), 55);
    assert.equal(store.shardPaths().length, 2);

    const fromBase = await store.getDocument("exchange_20230428800439");
    assert.ok(fromBase);
    const fromDelta = await store.getDocument("exchange_20250428800407");
    assert.ok(fromDelta);
  }
);
