// Turn K item C/D: deterministic gzip encode + bounded-decompression tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipDeterministic, gunzipSafe } from "../domain/adapters/deterministic-gzip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

test("gzipDeterministic: header carries MTIME=0 and no FNAME/FCOMMENT/FEXTRA/FHCRC flags", () => {
  const encoded = gzipDeterministic(Buffer.from("hello disclosure analyst"));
  assert.equal(encoded[0], 0x1f);
  assert.equal(encoded[1], 0x8b);
  assert.equal(encoded[3], 0, "FLG must be 0");
  assert.deepEqual([...encoded.subarray(4, 8)], [0, 0, 0, 0], "MTIME must be 0");
});

test("gzipDeterministic: the SAME input built in two independent temp directories produces byte-identical (same SHA-256) output", async () => {
  const payload = Buffer.from(JSON.stringify({ document_id: "doc_1", nodes: Array.from({ length: 500 }, (_, i) => ({ i, text: `node ${i} 텍스트` })) }), "utf8");
  const dirA = await mkdtemp(path.join(ROOT, "work", "gzip-determinism-a-"));
  const dirB = await mkdtemp(path.join(ROOT, "work", "gzip-determinism-b-"));
  try {
    const encodedA = gzipDeterministic(payload);
    const encodedB = gzipDeterministic(payload);
    await writeFile(path.join(dirA, "out.gz"), encodedA);
    await writeFile(path.join(dirB, "out.gz"), encodedB);
    const bytesA = await readFile(path.join(dirA, "out.gz"));
    const bytesB = await readFile(path.join(dirB, "out.gz"));
    assert.equal(sha256(bytesA), sha256(bytesB));
    assert.ok(bytesA.equals(bytesB));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("gzipDeterministic + gunzipSafe: round-trips arbitrary UTF-8 content exactly", () => {
  const payload = Buffer.from("정정공시 이력: (예정) 약 100억원\n둘째 줄", "utf8");
  const encoded = gzipDeterministic(payload);
  const { decoded } = gunzipSafe(encoded, { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 100 });
  assert.ok(decoded.equals(payload));
});

test("gunzipSafe: rejects when encoded size exceeds maxEncodedBytes", () => {
  const encoded = gzipDeterministic(Buffer.from("x".repeat(1000)));
  assert.throws(
    () => gunzipSafe(encoded, { maxEncodedBytes: 10, maxDecodedBytes: 10_000, maxCompressionRatio: 1000 }),
    /exceeds maxEncodedBytes/,
  );
});

test("gunzipSafe: rejects a high-ratio decompression bomb before allocating the full decoded buffer (maxDecodedBytes)", () => {
  const bomb = gzipDeterministic(Buffer.alloc(10_000_000, 0x41)); // 10MB of 'A', compresses to a few KB
  assert.throws(
    () => gunzipSafe(bomb, { maxEncodedBytes: 1_000_000, maxDecodedBytes: 1_000_000, maxCompressionRatio: 100_000 }),
    /exceeds maxDecodedBytes/,
  );
});

test("gunzipSafe: rejects when compression ratio exceeds maxCompressionRatio even if both absolute sizes are individually within bounds", () => {
  const bomb = gzipDeterministic(Buffer.alloc(500_000, 0x41));
  assert.throws(
    () => gunzipSafe(bomb, { maxEncodedBytes: 1_000_000, maxDecodedBytes: 1_000_000, maxCompressionRatio: 10 }),
    /exceeds maxCompressionRatio/,
  );
});

test("gunzipSafe: rejects trailing non-gzip garbage appended after a valid member", () => {
  const encoded = gzipDeterministic(Buffer.from("payload"));
  const withGarbage = Buffer.concat([encoded, Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  assert.throws(
    () => gunzipSafe(withGarbage, { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000 }),
    /is not exactly one well-formed gzip member|invalid gzip input/,
  );
});

test("gunzipSafe: rejects concatenated gzip members by default", () => {
  const memberA = gzipSync(Buffer.from("member-a"), { level: 9 });
  const memberB = gzipSync(Buffer.from("member-b"), { level: 9 });
  const concatenated = Buffer.concat([memberA, memberB]);
  assert.throws(
    () => gunzipSafe(concatenated, { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000 }),
    /is not exactly one well-formed gzip member/,
  );
});

test("gunzipSafe: allows concatenated gzip members ONLY when allowConcatenatedGzipMembers is explicitly true", () => {
  const memberA = gzipSync(Buffer.from("member-a-"), { level: 9 });
  const memberB = gzipSync(Buffer.from("member-b"), { level: 9 });
  const concatenated = Buffer.concat([memberA, memberB]);
  const { decoded } = gunzipSafe(concatenated, {
    maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000, allowConcatenatedGzipMembers: true,
  });
  assert.equal(decoded.toString("utf8"), "member-a-member-b");
});

test("gunzipSafe: rejects non-gzip input outright (bad magic bytes)", () => {
  assert.throws(
    () => gunzipSafe(Buffer.from("not gzip at all"), { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000 }),
    /not a gzip member/,
  );
});

test("gunzipSafe: enforces maxRecordCount when recordSeparator is supplied (JSONL-shaped content)", () => {
  const jsonl = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n";
  const encoded = gzipDeterministic(Buffer.from(jsonl, "utf8"));
  assert.throws(
    () => gunzipSafe(encoded, { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000, recordSeparator: "\n", maxRecordCount: 5 }),
    /exceeds maxRecordCount/,
  );
  const { record_count } = gunzipSafe(encoded, { maxEncodedBytes: 10_000, maxDecodedBytes: 10_000, maxCompressionRatio: 1000, recordSeparator: "\n", maxRecordCount: 20 });
  assert.equal(record_count, 10);
});

test("gunzipSafe: options are required -- calling without maxEncodedBytes/maxDecodedBytes/maxCompressionRatio throws rather than defaulting to unbounded", () => {
  const encoded = gzipDeterministic(Buffer.from("x"));
  assert.throws(() => gunzipSafe(encoded, {}), /is required/);
  assert.throws(() => gunzipSafe(encoded, { maxEncodedBytes: 10 }), /is required/);
});
