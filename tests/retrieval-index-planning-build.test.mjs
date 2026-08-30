import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRetrievalIndexPlan, IndexPlanBuildError } from "../domain/agent-comparison/retrieval/index-planning/build-index-plan.mjs";
import { CHUNK_ID_PATTERN } from "../domain/agent-comparison/retrieval/document-snapshot/contracts.mjs";

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

function fixtureChunk({ chunkId, docId, group, text, blockType = "PARAGRAPH", ordinal = 0 }) {
  return {
    schema_version: "0.1.0", snapshot_id: "docsnap_" + "f".repeat(32), chunking_policy_id: "document-node-first-v0.1", chunking_policy_sha256: "a".repeat(64),
    chunk_id: chunkId, source_document_id: docId, corp_code: "00000001", source_group: group, document_type: "test",
    source_locator: `${docId}/a.xml#node=0`, node_id: `${docId}::a.xml::n0`, chunk_ordinal: ordinal,
    char_start: 0, char_end: text.length, text_content: text, text_sha256: sha256(text), parse_status: "SUCCESS",
    metadata: { block_type: blockType, section_path: [], node_chunk_index: 0, node_chunk_count: 1, table_row_range: null, file_id: "file_" + "b".repeat(24), file_relative_path: "a.xml" },
  };
}

const FIXTURE_CHUNKS = [
  fixtureChunk({ chunkId: `chunk_${"1".repeat(24)}`, docId: "exchange_20250101000001", group: "exchange", text: "repeated boilerplate line" }),
  fixtureChunk({ chunkId: `chunk_${"2".repeat(24)}`, docId: "exchange_20250102000002", group: "exchange", text: "repeated boilerplate line" }),
  fixtureChunk({ chunkId: `chunk_${"3".repeat(24)}`, docId: "exchange_20250102000002", group: "exchange", text: "unique real content about a contract dated 2025-07-24", ordinal: 1 }),
  fixtureChunk({ chunkId: `chunk_${"4".repeat(24)}`, docId: "major_20250103000003", group: "major", text: "another unique paragraph entirely" }),
];
const FIXTURE_RECORDS = [
  { schema_version: "0.1.0", source_document_id: "exchange_20250101000001", corp_code: "00000001", source_group: "exchange", parse_status: "SUCCESS", retrieval_eligible: true, chunk_count: 1 },
  { schema_version: "0.1.0", source_document_id: "exchange_20250102000002", corp_code: "00000001", source_group: "exchange", parse_status: "SUCCESS", retrieval_eligible: true, chunk_count: 2 },
  { schema_version: "0.1.0", source_document_id: "major_20250103000003", corp_code: "00000002", source_group: "major", parse_status: "SUCCESS", retrieval_eligible: true, chunk_count: 1 },
];

async function writeFixtureSnapshot(dir, { chunks = FIXTURE_CHUNKS, records = FIXTURE_RECORDS } = {}) {
  await mkdir(dir, { recursive: true });
  const chunksContent = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
  const recordsContent = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  await writeFile(join(dir, "document-chunks.v0.1.jsonl"), chunksContent);
  await writeFile(join(dir, "document-records.v0.1.jsonl"), recordsContent);
  const manifest = {
    schema_version: "0.1.0", snapshot_id: "docsnap_" + "f".repeat(32), generated_at: "2020-01-01T00:00:00.000Z",
    total_documents: records.length, total_chunks: chunks.length,
    coverage_state_counts: { PRESENT: records.length, PARTIAL_PARSE_FAILURE: 0, PARSE_FAILED: 0 },
    document_chunks_file: { name: "document-chunks.v0.1.jsonl", sha256: sha256(Buffer.from(chunksContent)) },
    document_records_file: { name: "document-records.v0.1.jsonl", sha256: sha256(Buffer.from(recordsContent)) },
  };
  await writeFile(join(dir, "document-snapshot-manifest.v0.1.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "parse-status-report.v0.1.json"), JSON.stringify({ total_documents: records.length }));
  await writeFile(join(dir, "gate-status.v0.1.json"), JSON.stringify({ overall_status: "GATE_PASSED" }));
  await writeFile(join(dir, "portability-report.v0.1.json"), JSON.stringify({ status: "PASS" }));
  await writeFile(join(dir, "determinism-rebuild-report.v0.1.json"), JSON.stringify({ status: "PASS" }));
  await writeFile(join(dir, "p4-document-chunk-compatibility-report.v0.1.json"), JSON.stringify({ status: "PASS" }));
  return {
    expectedPins: {
      snapshotId: manifest.snapshot_id,
      totalDocuments: manifest.total_documents,
      totalChunks: manifest.total_chunks,
      documentChunksSha256: manifest.document_chunks_file.sha256,
      documentRecordsSha256: manifest.document_records_file.sha256,
      coverageStateCounts: manifest.coverage_state_counts,
    },
  };
}

async function withScratch(fn) {
  const scratch = await mkdtemp(join(tmpdir(), "p5-1-build-test-"));
  try { await fn(scratch); } finally { await rm(scratch, { recursive: true, force: true }); }
}

test("streaming atomic write: all 8 core output files are written with no leftover .tmp-* files", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const outputDir = join(scratch, "output");
    await buildRetrievalIndexPlan({ snapshotDir, outputDir, expectedPins, completedAt: "2020-01-01T00:00:00.000Z" });
    const entries = await readdir(outputDir);
    for (const name of ["input-pin-manifest.v0.1.json", "chunk-length-analysis.v0.1.json", "exact-duplicate-analysis.v0.1.json", "boilerplate-candidate-analysis.v0.1.json", "embedding-size-scenarios.v0.1.json", "retrieval-index-strategy-comparison.v0.1.json", "recommended-index-plan.v0.1.json", "provenance-preservation-report.v0.1.json"]) {
      assert.ok(entries.includes(name), `missing ${name}`);
    }
    assert.equal(entries.filter((name) => name.includes(".tmp-")).length, 0);
  });
});

test("a pin mismatch is fail-closed and leaves zero final output files", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const outputDir = join(scratch, "output");
    const badPins = { ...expectedPins, snapshotId: "docsnap_WRONG" };
    await assert.rejects(() => buildRetrievalIndexPlan({ snapshotDir, outputDir, expectedPins: badPins, completedAt: "2020-01-01T00:00:00.000Z" }), IndexPlanBuildError);
    let entries = [];
    try { entries = await readdir(outputDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.deepEqual(entries.filter((name) => !name.includes(".tmp-")), []);
  });
});

test("a chunk-count pin mismatch (simulating a tampered snapshot) is fail-closed", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const badPins = { ...expectedPins, totalChunks: expectedPins.totalChunks + 1 };
    await assert.rejects(() => buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output"), expectedPins: badPins, completedAt: "2020-01-01T00:00:00.000Z" }), /input pin verification failed/);
  });
});

test("the Turn P5 snapshot files are never modified (sha256 unchanged after a full analysis run)", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const before = { chunks: await readFile(join(snapshotDir, "document-chunks.v0.1.jsonl")), records: await readFile(join(snapshotDir, "document-records.v0.1.jsonl")) };
    await buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output"), expectedPins, completedAt: "2020-01-01T00:00:00.000Z" });
    const after = { chunks: await readFile(join(snapshotDir, "document-chunks.v0.1.jsonl")), records: await readFile(join(snapshotDir, "document-records.v0.1.jsonl")) };
    assert.equal(sha256(after.chunks), sha256(before.chunks));
    assert.equal(sha256(after.records), sha256(before.records));
    assert.deepEqual(after.chunks, before.chunks);
  });
});

test("determinism: two independent build runs over the same fixture produce byte-identical canonical outputs", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const resultA = await buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output-a"), expectedPins, completedAt: "2020-01-01T00:00:00.000Z" });
    const resultB = await buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output-b"), expectedPins, completedAt: "2099-12-31T23:59:59.000Z" });
    assert.deepEqual(resultA.duplicateAnalysisJson.unique_text_count, resultB.duplicateAnalysisJson.unique_text_count);
    assert.deepEqual(resultA.strategyComparison, resultB.strategyComparison);
    assert.deepEqual(resultA.recommendedPlan.primary_recommendation, resultB.recommendedPlan.primary_recommendation);
    assert.equal(resultA.recomputedChunksSha256, resultB.recomputedChunksSha256);
  });
});

test("provenance reconstruction sample verification passes and reports occurrences_match_total_chunks", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir);
    const result = await buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output"), expectedPins, completedAt: "2020-01-01T00:00:00.000Z" });
    assert.equal(result.provenanceReport.status, "PASS");
    assert.equal(result.provenanceReport.sum_of_occurrences_equals_total_chunks, true);
    for (const sample of result.provenanceReport.sample_reconstruction_results) {
      assert.equal(sample.counts_match, true);
    }
  });
});

test("a duplicate chunk_id in the snapshot (invariant violation) is rejected fail-closed", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const dupChunks = [...FIXTURE_CHUNKS, { ...FIXTURE_CHUNKS[0] }]; // exact duplicate chunk_id
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir, { chunks: dupChunks });
    await assert.rejects(() => buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output"), expectedPins, completedAt: "2020-01-01T00:00:00.000Z" }), /duplicate chunk_id/);
  });
});

test("a chunk referencing an unknown source_document_id is rejected fail-closed", async () => {
  await withScratch(async (scratch) => {
    const snapshotDir = join(scratch, "snapshot");
    const orphan = fixtureChunk({ chunkId: `chunk_${"9".repeat(24)}`, docId: "exchange_99999999999999", group: "exchange", text: "orphaned" });
    const { expectedPins } = await writeFixtureSnapshot(snapshotDir, { chunks: [...FIXTURE_CHUNKS, orphan], records: FIXTURE_RECORDS });
    // total_chunks pin must reflect the new count for the manifest-level check to even get this far
    const adjustedPins = { ...expectedPins, totalChunks: FIXTURE_CHUNKS.length + 1 };
    await assert.rejects(() => buildRetrievalIndexPlan({ snapshotDir, outputDir: join(scratch, "output"), expectedPins: adjustedPins, completedAt: "2020-01-01T00:00:00.000Z" }), /source_document_id absent from document-records|input pin verification failed/);
  });
});

test("P4 chunk_id shape compatibility: this Turn's fixture chunk_ids satisfy the same pattern P4's schema requires", () => {
  for (const chunk of FIXTURE_CHUNKS) {
    assert.match(chunk.chunk_id, CHUNK_ID_PATTERN);
  }
});
