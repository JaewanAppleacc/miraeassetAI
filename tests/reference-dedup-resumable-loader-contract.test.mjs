// Turn P8: no-DB contract tests for the Resumable Bounded-Memory Dedup
// Embedding Loader -- id/hash determinism, migration/grant static shape,
// and the resumable JSONL reader's own byte-offset bookkeeping. Real
// PostgreSQL 16+pgvector behavior (session state transitions, lease
// contention, crash-injection resume, two-worker concurrency, real
// materialization/finalization) is proven in
// tests/reference-dedup-resumable-loader-postgres16-integration.test.mjs --
// this file never opens a real DB connection.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  computeDedupLoadSessionId, computeEmbeddingConfigSha256,
} from "../domain/postgres/reference-dedup-load-session-repository.mjs";
import { computeDedupRetrievalIndexId } from "../domain/postgres/reference-dedup-retrieval-loader.mjs";
import {
  referenceDedupLoadSessionReaderGrantSql, referenceDedupLoadSessionWriterGrantSql,
} from "../domain/postgres/reference-dedup-load-session-grants.mjs";
import { readJsonlFromOffset, ResumableDedupLoaderError } from "../domain/postgres/reference-dedup-resumable-loader.mjs";

const BASE_PINS = Object.freeze({
  releaseId: "seed-release-v0.20-r3", sourceSnapshotId: "docsnap_x", embeddingProvider: "p",
  embeddingModel: "m", embeddingRevision: "v1", chunkingPolicyId: "document-node-first-v0.1",
});

// --- id determinism ----------------------------------------------------

test("computeDedupLoadSessionId is deterministic and shares its digest suffix with computeDedupRetrievalIndexId", () => {
  const a = computeDedupLoadSessionId(BASE_PINS);
  const b = computeDedupLoadSessionId({ ...BASE_PINS });
  assert.equal(a, b);
  assert.match(a, /^load_session_[0-9a-f]{32}$/);

  const retrievalIndexId = computeDedupRetrievalIndexId(BASE_PINS);
  assert.equal(a.replace(/^load_session_/, ""), retrievalIndexId.replace(/^dedup_index_/, ""), "the same snapshot+config identity must map to the same digest for both the session and its target index");
});

test("computeDedupLoadSessionId changes when any pin changes (same guarantee as the underlying retrieval index id)", () => {
  const a = computeDedupLoadSessionId(BASE_PINS);
  const c = computeDedupLoadSessionId({ ...BASE_PINS, embeddingRevision: "v2" });
  assert.notEqual(a, c);
});

test("computeEmbeddingConfigSha256 is deterministic and changes on dimension or distance_metric drift (the drift NOT already covered by the id hash)", () => {
  const base = { provider: "p", model: "m", revision: "v1", dimension: 1536, distanceMetric: "cosine" };
  const a = computeEmbeddingConfigSha256(base);
  const b = computeEmbeddingConfigSha256({ ...base });
  assert.equal(a, b);
  assert.notEqual(a, computeEmbeddingConfigSha256({ ...base, dimension: 3072 }));
  assert.notEqual(a, computeEmbeddingConfigSha256({ ...base, distanceMetric: "l2" }));
});

// --- 005 migration: static structural checks (no real DB needed) -------

test("005_reference_dedup_load_sessions.sql never touches 001-004's own tables with ALTER/DROP, and declares its own tables additively", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = path.resolve(import.meta.dirname, "..");
  const sql = await readFile(path.join(root, "domain/postgres/005_reference_dedup_load_sessions.sql"), "utf8");
  assert.doesNotMatch(sql, /ALTER TABLE disclosure_reference\.(releases|artifacts|records|reference_retrieval_indexes|reference_retrieval_chunks|reference_dedup_indexes|reference_dedup_canonical_texts|reference_dedup_occurrences)\b/i);
  assert.doesNotMatch(sql, /DROP TABLE disclosure_reference\.(releases|artifacts|records|reference_retrieval_indexes|reference_retrieval_chunks|reference_dedup_indexes|reference_dedup_canonical_texts|reference_dedup_occurrences)\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_load_sessions/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_canonical_queue/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS disclosure_reference\.reference_dedup_occurrence_staging/i);
  assert.match(sql, /FOR UPDATE SKIP LOCKED|FOR SHARE|lease_expires_at/i, "lease/reclaim columns must exist somewhere in this migration");
});

// --- grants --------------------------------------------------------------

test("load-session reader grant is SELECT-only on exactly the 3 staging/session tables", () => {
  const statements = referenceDedupLoadSessionReaderGrantSql("dedup_load_reader_role");
  const joined = statements.join(" ");
  assert.ok(joined.includes("reference_dedup_load_sessions"));
  assert.ok(joined.includes("reference_dedup_canonical_queue"));
  assert.ok(joined.includes("reference_dedup_occurrence_staging"));
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(joined));
});

test("load-session writer grant has no DELETE anywhere", () => {
  const statements = referenceDedupLoadSessionWriterGrantSql("dedup_load_writer_role");
  const joined = statements.join(" ");
  assert.ok(!/DELETE/i.test(joined));
  assert.ok(joined.includes("reference_dedup_indexes"));
});

test("grant SQL builders reject an unsafe role name", () => {
  assert.throws(() => referenceDedupLoadSessionReaderGrantSql("bad-role; DROP TABLE x"), Error);
  assert.throws(() => referenceDedupLoadSessionWriterGrantSql("Robert'); DROP TABLE Students;--"), Error);
});

// --- resumable JSONL reader: byte-offset bookkeeping --------------------

function chunkLine({ chunkId, text, ordinal = 0 }) {
  return JSON.stringify({
    chunk_id: chunkId, source_document_id: "exchange_20250101000001", corp_code: "00000001",
    source_group: "exchange", document_type: "test", node_id: "exchange_20250101000001::a.xml::n0",
    source_locator: "exchange_20250101000001/a.xml#node=0", parse_status: "SUCCESS", chunk_ordinal: ordinal,
    char_start: 0, char_end: text.length, text_content: text,
    text_sha256: createHash("sha256").update(text).digest("hex"),
    metadata: { block_type: "PARAGRAPH" },
  });
}

async function withTempJsonl(lines, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup-loader-contract-"));
  const filePath = path.join(dir, "chunks.jsonl");
  await writeFile(filePath, lines.map((l) => `${l}\n`).join(""), "utf8");
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readJsonlFromOffset from 0 yields every line with correct 1-based line numbers and monotonically increasing byte offsets", async () => {
  const lines = [
    chunkLine({ chunkId: `chunk_${"1".repeat(24)}`, text: "(단위: 백만원)", ordinal: 0 }),
    chunkLine({ chunkId: `chunk_${"2".repeat(24)}`, text: "보고자 지분 현황", ordinal: 1 }),
    chunkLine({ chunkId: `chunk_${"3".repeat(24)}`, text: "plain ascii text", ordinal: 2 }),
  ];
  await withTempJsonl(lines, async (filePath) => {
    const seen = [];
    for await (const { chunk, lineNumber, byteOffset } of readJsonlFromOffset(filePath)) {
      seen.push({ chunkId: chunk.chunk_id, lineNumber, byteOffset });
    }
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((s) => s.lineNumber), [1, 2, 3]);
    assert.deepEqual(seen.map((s) => s.chunkId), [`chunk_${"1".repeat(24)}`, `chunk_${"2".repeat(24)}`, `chunk_${"3".repeat(24)}`]);
    assert.ok(seen[0].byteOffset < seen[1].byteOffset && seen[1].byteOffset < seen[2].byteOffset);
  });
});

test("resuming readJsonlFromOffset from a previously-yielded byteOffset/lineNumber (Korean multi-byte text included) yields EXACTLY the remaining lines -- never a duplicate, never skipped", async () => {
  const lines = [
    chunkLine({ chunkId: `chunk_${"1".repeat(24)}`, text: "(단위: 백만원)", ordinal: 0 }),
    chunkLine({ chunkId: `chunk_${"2".repeat(24)}`, text: "보고자 지분 현황", ordinal: 1 }),
    chunkLine({ chunkId: `chunk_${"3".repeat(24)}`, text: "plain ascii text", ordinal: 2 }),
  ];
  await withTempJsonl(lines, async (filePath) => {
    const first = [];
    for await (const item of readJsonlFromOffset(filePath)) {
      first.push(item);
      if (first.length === 1) break; // simulate "crashed after committing line 1's checkpoint"
    }
    const checkpoint = first[0];

    const resumed = [];
    for await (const item of readJsonlFromOffset(filePath, { startByteOffset: checkpoint.byteOffset, startLineNumber: checkpoint.lineNumber })) {
      resumed.push(item);
    }
    assert.deepEqual(resumed.map((r) => r.chunk.chunk_id), [`chunk_${"2".repeat(24)}`, `chunk_${"3".repeat(24)}`], "resume must start at exactly line 2, never re-yielding line 1 or skipping line 2");
    assert.deepEqual(resumed.map((r) => r.lineNumber), [2, 3]);
  });
});

test("a malformed row (missing a required field) throws before any further line is read, carrying the offending line number", async () => {
  const badLine = JSON.stringify({ chunk_id: `chunk_${"9".repeat(24)}`, text_content: "missing other required fields" });
  const goodLine = chunkLine({ chunkId: `chunk_${"8".repeat(24)}`, text: "should never be reached" });
  await withTempJsonl([badLine, goodLine], async (filePath) => {
    const seen = [];
    await assert.rejects(
      (async () => {
        for await (const item of readJsonlFromOffset(filePath)) seen.push(item);
      })(),
      (error) => {
        assert.ok(error instanceof ResumableDedupLoaderError);
        assert.equal(error.code, "MALFORMED_ROW");
        assert.match(error.message, /line 1/);
        return true;
      },
    );
    assert.equal(seen.length, 0, "the malformed line must never be yielded as a usable chunk");
  });
});

test("an invalid parse_status is rejected the same way as a missing field", async () => {
  const badLine = JSON.stringify({
    chunk_id: `chunk_${"7".repeat(24)}`, source_document_id: "doc", node_id: "n", source_locator: "loc",
    text_sha256: "a".repeat(64), text_content: "x", parse_status: "NOT_A_REAL_STATUS", metadata: { block_type: "PARAGRAPH" },
  });
  await withTempJsonl([badLine], async (filePath) => {
    await assert.rejects(
      (async () => { for await (const _item of readJsonlFromOffset(filePath)) { /* drain */ } })(),
      (error) => { assert.equal(error.code, "MALFORMED_ROW"); return true; },
    );
  });
});
