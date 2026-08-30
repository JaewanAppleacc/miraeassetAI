import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocumentRetrievalSnapshot, SnapshotBuildError } from "../domain/agent-comparison/retrieval/document-snapshot/build-snapshot.mjs";
import { DEFAULT_CHUNKING_POLICY } from "../domain/agent-comparison/retrieval/document-snapshot/chunking-policy.mjs";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const FIXTURE_DOCS = {
  "exchange.jsonl": [
    {
      doc_id: "exchange_20250101000001",
      schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_test",
      source_files: [{ rel_path: "a.xml", is_attachment: false, content_format: "kind_html", content_sha256: sha256(Buffer.from("a")), declared_encoding: "utf-8", actual_encoding_used: "utf-8" }],
      nodes: [
        { kind: "paragraph", node_id: "exchange_20250101000001::a.xml::n0", section_hierarchy: [], source: { rel_path: "a.xml", order_index: 0 }, text: "동일한 노드 ID 텍스트" },
      ],
      warnings: [], parse_quality: { tier: "structured" },
    },
  ],
  "major.jsonl": [
    {
      // Deliberately shares the SAME node_id suffix pattern/text as the
      // exchange document above -- chunk_id must still differ because it
      // is scoped by source_document_id, proving no cross-document mixing.
      doc_id: "major_20250102000002",
      schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_test",
      source_files: [{ rel_path: "a.xml", is_attachment: false, content_format: "dart_xml", content_sha256: sha256(Buffer.from("b")), declared_encoding: "utf-8", actual_encoding_used: "utf-8" }],
      nodes: [
        { kind: "paragraph", node_id: "major_20250102000002::a.xml::n0", section_hierarchy: [], source: { rel_path: "a.xml", order_index: 0 }, text: "동일한 노드 ID 텍스트" },
      ],
      warnings: [], parse_quality: { tier: "structured" },
    },
  ],
  "holding.jsonl": [
    {
      doc_id: "holding_20250104000004",
      schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_test",
      source_files: [{ rel_path: "d.xml", is_attachment: false, content_format: "dart_xml", content_sha256: sha256(Buffer.from("d")), declared_encoding: "utf-8", actual_encoding_used: "utf-8" }],
      nodes: [
        { kind: "paragraph", node_id: "holding_20250104000004::d.xml::n0", section_hierarchy: [], source: { rel_path: "d.xml", order_index: 0 }, text: "Fallback text only, no structure recovered here." },
      ],
      warnings: [{ doc_id: "holding_20250104000004", rel_path: "d.xml", code: "parse_failed", severity: "error", message: "not well-formed" }],
      parse_quality: { tier: "fallback" },
    },
  ],
  "periodic-001.jsonl": [
    {
      doc_id: "periodic_20250105000005",
      schema_version: "1.0", parser_version: "1.0.0", corpus_snapshot_id: "snap_test",
      source_files: [{ rel_path: "c_viewer.html", is_attachment: false, content_format: "html", content_sha256: sha256(Buffer.from("c")), declared_encoding: "utf-8", actual_encoding_used: "utf-8" }],
      nodes: [],
      warnings: [{ doc_id: "periodic_20250105000005", rel_path: "c_viewer.html", code: "parse_failed", severity: "warning", message: "no <table> found in KIND HTML document" }],
      parse_quality: { tier: "partial" },
    },
  ],
};

const FIXTURE_MANIFEST = [
  { doc_id: "exchange_20250101000001", corp_code: "00000001", corp_name: "Test Corp A", doc_group: "exchange", doc_subtype: "단일판매공급계약체결", report_nm: "test", is_correction: false, rcept_no: "20250101000001", rcept_dt: "20250101", base_year: null, base_month: null },
  { doc_id: "major_20250102000002", corp_code: "00000002", corp_name: "Test Corp B", doc_group: "major", doc_subtype: null, report_nm: "test", is_correction: false, rcept_no: "20250102000002", rcept_dt: "20250102", base_year: null, base_month: null },
  { doc_id: "holding_20250104000004", corp_code: "00000003", corp_name: "Test Corp C", doc_group: "holding", doc_subtype: "대량보유상황보고서", report_nm: "test", is_correction: false, rcept_no: "20250104000004", rcept_dt: "20250104", base_year: null, base_month: null },
  { doc_id: "periodic_20250105000005", corp_code: "00000004", corp_name: "Test Corp D", doc_group: "periodic", doc_subtype: "quarter", report_nm: "test", is_correction: false, rcept_no: "20250105000005", rcept_dt: "20250105", base_year: 2025, base_month: 3 },
];

async function writeFixture(root, { docs = FIXTURE_DOCS, manifestRows = FIXTURE_MANIFEST } = {}) {
  await mkdir(join(root, "source"), { recursive: true });
  const files = [];
  for (const [name, records] of Object.entries(docs)) {
    const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    await writeFile(join(root, "source", name), content);
    files.push({ file_name: name, bytes: Buffer.byteLength(content), lines: records.length, sha256: sha256(Buffer.from(content)) });
  }
  await writeFile(join(root, "inventory.json"), JSON.stringify({ files }));
  const manifestContent = manifestRows.map((r) => JSON.stringify(r)).join("\n") + (manifestRows.length ? "\n" : "");
  await writeFile(join(root, "manifest.jsonl"), manifestContent);
  return {
    inventoryPath: join(root, "inventory.json"),
    sourceDir: join(root, "source"),
    manifestPath: join(root, "manifest.jsonl"),
  };
}

async function withScratch(fn) {
  const scratch = await mkdtemp(join(tmpdir(), "p5-build-test-"));
  try {
    await fn(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readJsonl(path) {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test("cross-document mixing prevention: identical node_id/text in two different documents produce different chunk_ids and are never merged", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const outputDir = join(scratch, "output");
    await buildDocumentRetrievalSnapshot({ ...inputs, outputDir });
    const chunks = await readJsonl(join(outputDir, "document-chunks.v0.1.jsonl"));
    const exchangeChunk = chunks.find((c) => c.source_document_id === "exchange_20250101000001");
    const majorChunk = chunks.find((c) => c.source_document_id === "major_20250102000002");
    assert.ok(exchangeChunk && majorChunk);
    assert.equal(exchangeChunk.text_content, majorChunk.text_content, "fixture deliberately shares identical text across documents");
    assert.notEqual(exchangeChunk.chunk_id, majorChunk.chunk_id, "chunk_id must be document-scoped even for identical node_id + text");
    assert.notEqual(exchangeChunk.source_document_id, majorChunk.source_document_id);
  });
});

test("PARTIAL documents are preserved with parse_status=PARTIAL and only their real extracted text chunked", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const outputDir = join(scratch, "output");
    await buildDocumentRetrievalSnapshot({ ...inputs, outputDir });
    const records = await readJsonl(join(outputDir, "document-records.v0.1.jsonl"));
    const holding = records.find((r) => r.source_document_id === "holding_20250104000004");
    assert.equal(holding.coverage_state, "PARTIAL_PARSE_FAILURE");
    assert.equal(holding.parse_status, "PARTIAL");
    assert.equal(holding.retrieval_eligible, true);
    assert.equal(holding.chunk_count, 1);
    const chunks = await readJsonl(join(outputDir, "document-chunks.v0.1.jsonl"));
    const holdingChunk = chunks.find((c) => c.source_document_id === "holding_20250104000004");
    assert.equal(holdingChunk.parse_status, "PARTIAL");
    assert.equal(holdingChunk.text_content, "Fallback text only, no structure recovered here.");
  });
});

test("FAILED documents are preserved as a metadata-only record with retrieval_eligible=false and zero chunks -- no invented text", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const outputDir = join(scratch, "output");
    await buildDocumentRetrievalSnapshot({ ...inputs, outputDir });
    const records = await readJsonl(join(outputDir, "document-records.v0.1.jsonl"));
    const failed = records.find((r) => r.source_document_id === "periodic_20250105000005");
    assert.equal(failed.coverage_state, "PARSE_FAILED");
    assert.equal(failed.parse_status, "FAILED");
    assert.equal(failed.retrieval_eligible, false);
    assert.equal(failed.chunk_count, 0);
    assert.equal(failed.failure_reason, "PARSE_FAILED_NO_BLOCKS");
    const chunks = await readJsonl(join(outputDir, "document-chunks.v0.1.jsonl"));
    assert.equal(chunks.filter((c) => c.source_document_id === "periodic_20250105000005").length, 0);
  });
});

test("streaming atomic write: final files exist with correct line counts and no .tmp-* leftovers after a clean build", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const outputDir = join(scratch, "output");
    const result = await buildDocumentRetrievalSnapshot({ ...inputs, outputDir });
    const entries = await readdir(outputDir);
    assert.ok(entries.includes("document-records.v0.1.jsonl"));
    assert.ok(entries.includes("document-chunks.v0.1.jsonl"));
    assert.equal(entries.filter((name) => name.includes(".tmp-")).length, 0, "no temp files may survive a clean build");
    const records = await readJsonl(join(outputDir, "document-records.v0.1.jsonl"));
    assert.equal(records.length, result.totalDocuments);
  });
});

test("a manifest join failure aborts the whole build and leaves zero final artifact files (fail-closed, no partial output)", async () => {
  await withScratch(async (scratch) => {
    // Manifest is missing a row for one of the four documents.
    const brokenManifest = FIXTURE_MANIFEST.filter((row) => row.doc_id !== "major_20250102000002");
    const inputs = await writeFixture(scratch, { manifestRows: brokenManifest });
    const outputDir = join(scratch, "output");
    await assert.rejects(() => buildDocumentRetrievalSnapshot({ ...inputs, outputDir }), SnapshotBuildError);
    let entries = [];
    try { entries = await readdir(outputDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.deepEqual(entries.filter((name) => !name.includes(".tmp-")), [], "no FINAL artifact file may exist after a failed build");
  });
});

test("a duplicate source_document_id across two source files is rejected fail-closed", async () => {
  await withScratch(async (scratch) => {
    const docs = { ...FIXTURE_DOCS, "holding.jsonl": [{ ...FIXTURE_DOCS["exchange.jsonl"][0] }] }; // duplicate doc_id, wrong file
    const inputs = await writeFixture(scratch, { docs });
    await assert.rejects(() => buildDocumentRetrievalSnapshot({ ...inputs, outputDir: join(scratch, "output") }), /duplicate/i);
  });
});

test("expectedTotals mismatch is rejected fail-closed (a real-corpus regression must never pass silently)", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    await assert.rejects(
      () => buildDocumentRetrievalSnapshot({ ...inputs, outputDir: join(scratch, "output"), expectedTotals: { total_documents: 999, doc_groups: {}, coverage_states: {} } }),
      /expected 999/,
    );
  });
});

test("determinism: two independent build runs over the same fixture produce byte-identical canonical hashes and snapshot_id", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const resultA = await buildDocumentRetrievalSnapshot({ ...inputs, outputDir: join(scratch, "output-a"), completedAt: "2020-01-01T00:00:00.000Z" });
    const resultB = await buildDocumentRetrievalSnapshot({ ...inputs, outputDir: join(scratch, "output-b"), completedAt: "2099-12-31T23:59:59.000Z" });
    assert.equal(resultA.snapshotId, resultB.snapshotId);
    assert.equal(resultA.canonicalManifestSha256, resultB.canonicalManifestSha256, "generated_at must be excluded from the canonical manifest hash");
    assert.equal(resultA.documentRecordsSha256, resultB.documentRecordsSha256);
    assert.equal(resultA.documentChunksSha256, resultB.documentChunksSha256);
  });
});

test("document-chunks.v0.1.jsonl supports filtering by source_document_id (streaming scan yields exactly that document's chunks)", async () => {
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    const outputDir = join(scratch, "output");
    await buildDocumentRetrievalSnapshot({ ...inputs, outputDir });
    const chunks = await readJsonl(join(outputDir, "document-chunks.v0.1.jsonl"));
    const filtered = chunks.filter((c) => c.source_document_id === "exchange_20250101000001");
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((c) => c.source_document_id === "exchange_20250101000001"));
  });
});

test("mutation independence: the default chunking policy object is never mutated by a build run", async () => {
  const before = JSON.stringify(DEFAULT_CHUNKING_POLICY);
  await withScratch(async (scratch) => {
    const inputs = await writeFixture(scratch);
    await buildDocumentRetrievalSnapshot({ ...inputs, outputDir: join(scratch, "output") });
  });
  assert.equal(JSON.stringify(DEFAULT_CHUNKING_POLICY), before);
});
