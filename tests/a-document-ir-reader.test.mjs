import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCanonicalJsonlDocumentAdapter } from "../domain/adapters/a-document-ir-reader.mjs";

// --- always-run: a small self-contained fixture, no dependency on local
//     work/ data, so these exercise the reader's success and error paths
//     on every machine and in CI, not just this one -----------------------

function makeFixtureJsonl(records) {
  const dir = mkdtempSync(join(tmpdir(), "a-document-ir-reader-test-"));
  const path = join(dir, "canonical.fixture.jsonl");
  // Deliberately includes irregular whitespace/key ordering so the
  // prefilter can't rely on exact JSON.stringify byte formatting.
  writeFileSync(path, records.map((record) => JSON.stringify(record, null, 0).replace(/,"/g, ', "')).join("\n") + "\n");
  return { dir, path };
}

const FIXTURE_DOC_A = {
  schema_version: "0.1.0",
  corpus_snapshot_id: "snap_7484a10220422056",
  document_id: "exchange_fixture_a",
  parser: { name: "test", version: "0.0.0", completed_at: "2026-01-01T00:00:00Z" },
  files: [],
  blocks: [{ block_id: "b1", file_id: "file_a", parent_block_id: null, block_type: "PARAGRAPH", ordinal: 0, section_path: [], source_locator: "loc.a", text: "fixture A text" }],
};

const FIXTURE_DOC_B = {
  ...FIXTURE_DOC_A,
  document_id: "exchange_fixture_b",
  blocks: [{ ...FIXTURE_DOC_A.blocks[0], source_locator: "loc.b", text: "fixture B text" }],
};

test("fixture: a known document_id resolves with B's mapped corpus_snapshot_id", async () => {
  const { dir, path } = makeFixtureJsonl([FIXTURE_DOC_A, FIXTURE_DOC_B]);
  try {
    const adapter = createCanonicalJsonlDocumentAdapter(path);
    const doc = await adapter.getDocument("exchange_fixture_a");
    assert.ok(doc);
    assert.equal(doc.document_id, "exchange_fixture_a");
    assert.equal(doc.corpus_snapshot_id, "corpus_04750795e1a2d5c3"); // remapped from snap_7484a10220422056
    assert.equal(doc.blocks[0].text, "fixture A text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture: a different document_id in the same file resolves independently", async () => {
  const { dir, path } = makeFixtureJsonl([FIXTURE_DOC_A, FIXTURE_DOC_B]);
  try {
    const adapter = createCanonicalJsonlDocumentAdapter(path);
    const doc = await adapter.getDocument("exchange_fixture_b");
    assert.equal(doc.document_id, "exchange_fixture_b");
    assert.equal(doc.blocks[0].text, "fixture B text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture: a document_id absent from a cleanly-read file resolves to null", async () => {
  const { dir, path } = makeFixtureJsonl([FIXTURE_DOC_A]);
  try {
    const adapter = createCanonicalJsonlDocumentAdapter(path);
    const doc = await adapter.getDocument("exchange_does_not_exist");
    assert.equal(doc, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture: a missing backing file throws (DOCUMENT_STORE_UNAVAILABLE via DocumentStore), it is not DOCUMENT_NOT_FOUND", async () => {
  const adapter = createCanonicalJsonlDocumentAdapter(resolve("work/a-document-ir/does-not-exist.jsonl"));
  await assert.rejects(() => adapter.getDocument("exchange_fixture_a"));
});

test("fixture: a corrupted line matching the requested document_id throws instead of being silently skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a-document-ir-reader-test-"));
  const path = join(dir, "corrupt.jsonl");
  try {
    // The corrupt line must mention the target document_id, or the
    // substring prefilter would skip straight past it — that's the case
    // being tested: a match that then fails to parse.
    writeFileSync(path, `${JSON.stringify(FIXTURE_DOC_A)}\nnot valid json but mentions exchange_corrupt_target {{{\n`);
    const adapter = createCanonicalJsonlDocumentAdapter(path);
    await assert.rejects(() => adapter.getDocument("exchange_corrupt_target"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- optional: the real A sample, when present locally ---------------------
//
// work/ is deliberately gitignored local-only data (CLAUDE.md: "대용량
// work/, 원본 데이터... Git에 추가하지 않는다"). These skip cleanly when
// that data isn't present, instead of failing verify:contracts on a
// machine that never ran the A adapter locally — the fixture tests above
// are what actually guarantee coverage everywhere.
const SAMPLE_PATH = resolve("work/a-document-ir/canonical.sample.jsonl");
const HAS_SAMPLE = existsSync(SAMPLE_PATH);

test("real A canonical DocumentIR: known document_id resolves with B's mapped corpus_snapshot_id", { skip: !HAS_SAMPLE }, async () => {
  const adapter = createCanonicalJsonlDocumentAdapter(SAMPLE_PATH);
  const doc = await adapter.getDocument("exchange_20250728800035");
  assert.ok(doc);
  assert.equal(doc.document_id, "exchange_20250728800035");
  assert.equal(doc.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
  assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 0);
});

test("real A canonical DocumentIR: a real table block carries the real cell text", { skip: !HAS_SAMPLE }, async () => {
  const adapter = createCanonicalJsonlDocumentAdapter(SAMPLE_PATH);
  const doc = await adapter.getDocument("exchange_20250728800035");
  const block = doc.blocks.find((b) => b.block_id === "exchange_20250728800035::20250728800035.xml::n0");
  assert.ok(block);
  assert.equal(block.source_locator, "exchange_20250728800035/20250728800035.xml#node=0");
  const cells = [...block.table.header_rows, ...block.table.body_rows].flat();
  assert.ok(cells.includes("22,764,764,160,000"));
});

test("real A canonical DocumentIR: a second real document also resolves independently", { skip: !HAS_SAMPLE }, async () => {
  const adapter = createCanonicalJsonlDocumentAdapter(SAMPLE_PATH);
  const doc = await adapter.getDocument("major_20241031000508");
  assert.ok(doc);
  assert.equal(doc.document_id, "major_20241031000508");
  assert.equal(doc.corpus_snapshot_id, "corpus_04750795e1a2d5c3");
});

test("real A canonical DocumentIR: a non-existent document_id resolves to null, not an error", { skip: !HAS_SAMPLE }, async () => {
  const adapter = createCanonicalJsonlDocumentAdapter(SAMPLE_PATH);
  const doc = await adapter.getDocument("exchange_00000000000000");
  assert.equal(doc, null);
});
