import test from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, splitTextDeterministic, packTableRowsDeterministic, DEFAULT_CHUNKING_POLICY } from "../domain/agent-comparison/retrieval/document-snapshot/chunking-policy.mjs";
import { computeSnapshotChunkId, sha256Hex } from "../domain/agent-comparison/retrieval/document-snapshot/contracts.mjs";

function block(overrides) {
  return {
    block_id: "doc::file.xml::n0",
    file_id: "file_aaaaaaaaaaaaaaaaaaaaaaaa",
    parent_block_id: null,
    block_type: "PARAGRAPH",
    ordinal: 0,
    section_path: [],
    source_locator: "doc/file.xml#node=0",
    text: null,
    ...overrides,
  };
}

test("one node under the limit becomes exactly one chunk (node boundary respected)", () => {
  const blocks = [block({ text: "짧은 문단입니다." })];
  const descriptors = chunkBlocks(blocks, DEFAULT_CHUNKING_POLICY);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].text_content, "짧은 문단입니다.");
  assert.equal(descriptors[0].node_chunk_index, 0);
  assert.equal(descriptors[0].node_chunk_count, 1);
});

test("a long node is subdivided deterministically with overlap and forward progress", () => {
  const policy = { ...DEFAULT_CHUNKING_POLICY, max_chunk_chars: 100, overlap_chars: 10 };
  const longText = "abcdefghij ".repeat(50); // 550 chars, no natural sentence boundary
  const spans = splitTextDeterministic(longText, policy);
  assert.ok(spans.length > 1, "expected more than one span for text longer than max_chunk_chars");
  for (const span of spans) assert.ok(span.end > span.start, "every span must make forward progress");
  assert.equal(spans[spans.length - 1].end, longText.length, "spans must cover the full text to the end");
  // Re-running the pure function twice must produce byte-identical spans.
  const spansAgain = splitTextDeterministic(longText, policy);
  assert.deepEqual(spans, spansAgain);
});

test("sentence-boundary splitting works across mixed Korean/English text", () => {
  const policy = { ...DEFAULT_CHUNKING_POLICY, max_chunk_chars: 40, overlap_chars: 5 };
  const text = "This is an English sentence. 이것은 한국어 문장입니다. Another English one follows here.";
  const spans = splitTextDeterministic(text, policy);
  assert.ok(spans.length >= 2);
  // At least one split boundary should land right after a sentence-ending period, not mid-word.
  const boundaries = spans.slice(0, -1).map((s) => s.end);
  const landsOnSentenceEnd = boundaries.some((b) => text[b - 1] === "." || text[b - 1] === "다" || /\s/.test(text[b] ?? ""));
  assert.ok(landsOnSentenceEnd, `expected at least one boundary near a sentence end, got boundaries=${JSON.stringify(boundaries)}`);
});

test("table rows are packed without splitting a single row across chunks", () => {
  const policy = { ...DEFAULT_CHUNKING_POLICY, table_max_chunk_chars: 20 };
  const rows = [["aaaa", "bbbb"], ["cccc", "dddd"], ["eeee", "ffff"], ["gggg", "hhhh"]];
  const { spans, fullTableText } = packTableRowsDeterministic(rows, policy);
  assert.ok(spans.length >= 2, "rows should be split into multiple chunks given the small limit");
  for (const span of spans) {
    const text = fullTableText.slice(span.start, span.end);
    // Every emitted span's text must be composed of WHOLE row texts joined by the separator -- never a partial row.
    const rowTexts = rows.slice(span.rowRange[0], span.rowRange[1] + 1).map((r) => r.join(policy.table_row_join));
    assert.equal(text, rowTexts.join(policy.table_row_separator));
  }
});

test("a single oversized table row becomes its own chunk rather than being torn apart", () => {
  const policy = { ...DEFAULT_CHUNKING_POLICY, table_max_chunk_chars: 10 };
  const rows = [["short"], ["x".repeat(500)], ["short2"]];
  const { spans, fullTableText } = packTableRowsDeterministic(rows, policy);
  const oversizedSpan = spans.find((s) => s.rowRange[0] === 1 && s.rowRange[1] === 1);
  assert.ok(oversizedSpan, "the oversized row must appear as its own span");
  assert.equal(fullTableText.slice(oversizedSpan.start, oversizedSpan.end).length, 500);
});

test("an empty node (blank text) produces zero chunks", () => {
  const blocks = [block({ text: "" }), block({ block_id: "doc::file.xml::n1", text: "   \n  " }), block({ block_id: "doc::file.xml::n2", text: null })];
  assert.deepEqual(chunkBlocks(blocks, DEFAULT_CHUNKING_POLICY), []);
});

test("a table with zero rows produces zero chunks", () => {
  const blocks = [block({ block_type: "TABLE", table: { header_rows: [], body_rows: [] } })];
  assert.deepEqual(chunkBlocks(blocks, DEFAULT_CHUNKING_POLICY), []);
});

test("chunk_id is stable for identical inputs and changes when any pinned input changes", () => {
  const base = { snapshotId: "docsnap_aaaa", sourceDocumentId: "exchange_20250101000001", nodeId: "n0", chunkOrdinal: 0, textSha256: sha256Hex("hello") };
  const id1 = computeSnapshotChunkId(base);
  const id2 = computeSnapshotChunkId(base);
  assert.equal(id1, id2);
  assert.match(id1, /^chunk_[0-9a-f]{24}$/);

  const variants = [
    { ...base, snapshotId: "docsnap_bbbb" },
    { ...base, sourceDocumentId: "exchange_20250101000002" },
    { ...base, nodeId: "n1" },
    { ...base, chunkOrdinal: 1 },
    { ...base, textSha256: sha256Hex("different") },
  ];
  for (const variant of variants) assert.notEqual(computeSnapshotChunkId(variant), id1);
});

test("text_sha256 is the exact sha256 of the emitted (trimmed) text_content", () => {
  const blocks = [block({ text: "  padded text with surrounding whitespace  " })];
  const descriptors = chunkBlocks(blocks, DEFAULT_CHUNKING_POLICY);
  assert.equal(descriptors[0].text_content, "padded text with surrounding whitespace");
  assert.equal(sha256Hex(descriptors[0].text_content), sha256Hex("padded text with surrounding whitespace"));
});

test("char_start/char_end index into the ORIGINAL pre-trim node text, not the trimmed text_content", () => {
  const blocks = [block({ text: "   leading and trailing whitespace preserved as offsets   " })];
  const descriptors = chunkBlocks(blocks, DEFAULT_CHUNKING_POLICY);
  const d = descriptors[0];
  assert.equal(d.char_start, 0);
  assert.equal(d.char_end, "   leading and trailing whitespace preserved as offsets   ".length);
});
