// Uses only SYNTHETIC fixture files written to a temp directory -- never
// reads the real ~8.6GB corpus (that is exercised only by
// scripts/p10.2-stage1-full-corpus-count-only.mjs directly).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { corpusSourceFileStats, streamAllDocuments, CORPUS_SOURCE_FILES } from "../domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs";

async function withFixtureDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "p10.2-streamer-test-"));
  try {
    for (const { filename } of CORPUS_SOURCE_FILES) {
      await writeFile(path.join(dir, filename), ""); // start empty, individual tests overwrite as needed
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CORPUS_SOURCE_FILES names exactly the 4 real doc_group files, in a fixed order", () => {
  assert.deepEqual(CORPUS_SOURCE_FILES.map((f) => f.docGroup), ["exchange", "major", "holding", "periodic"]);
  assert.deepEqual(CORPUS_SOURCE_FILES.map((f) => f.filename), ["exchange.jsonl", "major.jsonl", "holding.jsonl", "periodic-001.jsonl"]);
});

test("corpusSourceFileStats measures REAL bytes via fs.stat, never a hardcoded constant", async () => {
  await withFixtureDir(async (dir) => {
    await writeFile(path.join(dir, "exchange.jsonl"), "x".repeat(123));
    const stats = await corpusSourceFileStats(dir);
    const exchangeStat = stats.find((s) => s.docGroup === "exchange");
    assert.equal(exchangeStat.bytes, 123);
  });
});

test("streamAllDocuments yields one record per line, in file order, across all 4 files", async () => {
  await withFixtureDir(async (dir) => {
    await writeFile(path.join(dir, "exchange.jsonl"), `${JSON.stringify({ doc_id: "exchange_1" })}\n${JSON.stringify({ doc_id: "exchange_2" })}\n`);
    await writeFile(path.join(dir, "major.jsonl"), `${JSON.stringify({ doc_id: "major_1" })}\n`);
    const seen = [];
    for await (const { documentId, docGroup } of streamAllDocuments(dir)) seen.push({ documentId, docGroup });
    assert.deepEqual(seen, [
      { documentId: "exchange_1", docGroup: "exchange" },
      { documentId: "exchange_2", docGroup: "exchange" },
      { documentId: "major_1", docGroup: "major" },
    ]);
  });
});

test("streamAllDocuments skips blank lines without producing a phantom record", async () => {
  await withFixtureDir(async (dir) => {
    await writeFile(path.join(dir, "exchange.jsonl"), `${JSON.stringify({ doc_id: "exchange_1" })}\n\n\n${JSON.stringify({ doc_id: "exchange_2" })}\n`);
    const seen = [];
    for await (const { documentId } of streamAllDocuments(dir)) seen.push(documentId);
    assert.deepEqual(seen, ["exchange_1", "exchange_2"]);
  });
});

test("streamAllDocuments yields the full raw record object, not just the id", async () => {
  await withFixtureDir(async (dir) => {
    await writeFile(path.join(dir, "exchange.jsonl"), `${JSON.stringify({ doc_id: "exchange_1", nodes: [{ node_id: "n0" }] })}\n`);
    const results = [];
    for await (const entry of streamAllDocuments(dir)) results.push(entry);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].rawRecord.nodes, [{ node_id: "n0" }]);
  });
});

test("a malformed JSON line throws rather than being silently skipped", async () => {
  await withFixtureDir(async (dir) => {
    await writeFile(path.join(dir, "exchange.jsonl"), "{not valid json\n");
    await assert.rejects(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of streamAllDocuments(dir)) { /* drain */ }
    });
  });
});
