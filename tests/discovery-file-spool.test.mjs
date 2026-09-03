// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section H/J/P: offline tests for
// discovery-file-spool.mjs and copy-format.mjs -- no DB, no real corpus.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyEncodeField, copyEncodeRow } from "../domain/agent-comparison/chunking-comparison/copy-format.mjs";
import { createSpoolShardSet } from "../domain/agent-comparison/chunking-comparison/discovery-file-spool.mjs";

test("copyEncodeField escapes backslash/tab/newline/carriage-return, and null becomes the \\N sentinel", () => {
  assert.equal(copyEncodeField("a\tb\nc\rd\\e"), "a\\tb\\nc\\rd\\\\e");
  assert.equal(copyEncodeField(null), "\\N");
  assert.equal(copyEncodeField(undefined), "\\N");
});

test("copyEncodeField never lets a real value collide with the \\N NULL sentinel -- a literal backslash-N is escaped, not passed through raw", () => {
  const encoded = copyEncodeField("\\N"); // the two literal characters backslash, N
  assert.notEqual(encoded, "\\N"); // must NOT equal the unescaped sentinel
  assert.equal(encoded, "\\\\N"); // backslash doubled, N unchanged
});

test("copyEncodeField fails closed on an embedded NUL byte (PostgreSQL text columns cannot store one)", () => {
  assert.throws(() => copyEncodeField(`bad${String.fromCharCode(0)}value`), /COPY_FIELD_CONTAINS_NUL_BYTE/);
});

test("copyEncodeField handles Unicode (Korean, punctuation, digits) without mangling", () => {
  const value = "기업: 삼성전자\n문서: 단일판매·공급계약체결 (2024년, 3월)";
  const encoded = copyEncodeField(value);
  assert.ok(encoded.includes("\\n"));
  assert.ok(encoded.includes("삼성전자"));
});

test("copyEncodeRow joins fields with a single tab, in order", () => {
  assert.equal(copyEncodeRow(["a", null, "b\tc"]), "a\t\\N\tb\\tc");
});

let tmpDir;
test.beforeEach(async () => { tmpDir = await mkdtemp(path.join(tmpdir(), "spool-test-")); });
test.afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

test("createSpoolShardSet rolls to a new shard exactly at maxRowsPerShard, never splitting mid-shard early or late", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a"], maxRowsPerShard: 3, maxBytesPerShard: 1e9 });
  for (let i = 0; i < 7; i += 1) {
    const maybePromise = set.addRow([`v${i}`]);
    if (maybePromise) await maybePromise;
  }
  const shards = await set.finalize();
  assert.deepEqual(shards.map((s) => s.rowCount), [3, 3, 1]);
});

test("every completed shard's streamed SHA-256 exactly matches an independent post-hoc hash of the actual file bytes", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a", "b"], maxRowsPerShard: 100, maxBytesPerShard: 1e9 });
  for (let i = 0; i < 10; i += 1) {
    const maybePromise = set.addRow([`val${i}`, i % 2 === 0 ? null : "x\ty\nz"]);
    if (maybePromise) await maybePromise;
  }
  const [shard] = await set.finalize();
  const fileContent = await readFile(shard.path);
  const independentSha256 = createHash("sha256").update(fileContent).digest("hex");
  assert.equal(shard.sha256, independentSha256);
  assert.equal(fileContent.byteLength, shard.byteCount);
});

test("a shard file is only ever visible under its final .copy name once fully written -- no .partial file survives finalize()", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a"], maxRowsPerShard: 5, maxBytesPerShard: 1e9 });
  const maybePromise = set.addRow(["v0"]);
  if (maybePromise) await maybePromise;
  await set.finalize();
  const finalPath = path.join(tmpDir, "t-000000.copy");
  const info = await stat(finalPath);
  assert.ok(info.isFile());
  await assert.rejects(() => stat(`${finalPath}.partial`), { code: "ENOENT" });
});

test("addRow is synchronous (returns undefined, not a Promise) on the common no-roll path -- only a real shard roll returns a Promise", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a"], maxRowsPerShard: 1000, maxBytesPerShard: 1e9 });
  const result = set.addRow(["v0"]); // first row always opens a shard -> this one DOES roll
  if (result) await result;
  const secondResult = set.addRow(["v1"]); // no roll needed this time
  assert.equal(secondResult, undefined);
  await set.finalize();
});

test("finalize() on a shard set that never received a row produces zero shards, not an empty shard file", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a"], maxRowsPerShard: 10, maxBytesPerShard: 1e9 });
  const shards = await set.finalize();
  assert.deepEqual(shards, []);
});

test("deterministic ordering: shard filenames are zero-padded and sort in write order", async () => {
  const set = createSpoolShardSet({ spoolDir: tmpDir, namePrefix: "t", columns: ["a"], maxRowsPerShard: 1, maxBytesPerShard: 1e9 });
  for (let i = 0; i < 3; i += 1) {
    const maybePromise = set.addRow([`v${i}`]);
    if (maybePromise) await maybePromise;
  }
  const shards = await set.finalize();
  const filenames = shards.map((s) => s.filename);
  assert.deepEqual(filenames, [...filenames].sort());
  assert.deepEqual(filenames, ["t-000000.copy", "t-000001.copy", "t-000002.copy"]);
});
