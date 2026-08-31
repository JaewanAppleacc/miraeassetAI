import test from "node:test";
import assert from "node:assert/strict";
import { parseEvidenceLocator, chunkCoversLocator, UnrecognizedLocatorError } from "../domain/agent-comparison/chunking-comparison/dev-tune-evidence-locator.mjs";

function makeChunk({ documentId, orderIndex, rowStart = null, rowEnd = null, colStart = null, colEnd = null }) {
  return {
    document_id: documentId,
    source_spans: [{ file_id: "file_abc", rel_path: "x.xml", order_index: orderIndex, row_start: rowStart, row_end: rowEnd, col_start: colStart, col_end: colEnd, source_locator: "x" }],
  };
}

test("parses the query-param locator style (docId/relPath#node=N&row=R&col=C)", () => {
  const parsed = parseEvidenceLocator("major_20231026000201/20231026000201.xml#node=3&row=1&col=2", "major_20231026000201");
  assert.deepEqual(parsed, { documentId: "major_20231026000201", orderIndex: 3, row: 1, col: 2, rawNodeId: null });
});

test("parses the query-param locator style with no row/col", () => {
  const parsed = parseEvidenceLocator("major_20231026000201/20231026000201.xml#node=5", "major_20231026000201");
  assert.equal(parsed.orderIndex, 5);
  assert.equal(parsed.row, null);
  assert.equal(parsed.col, null);
});

test("parses the raw node_id locator style (docId::relPath::nN)", () => {
  const parsed = parseEvidenceLocator("exchange_20230428800439::20230428800439.xml::n7", "exchange_20230428800439");
  assert.equal(parsed.documentId, "exchange_20230428800439");
  assert.equal(parsed.orderIndex, 7);
  assert.equal(parsed.row, null);
});

test("throws UnrecognizedLocatorError on an unknown format rather than guessing", () => {
  assert.throws(() => parseEvidenceLocator("totally-unexpected-format", "x"), UnrecognizedLocatorError);
});

test("chunkCoversLocator: matches by document_id + order_index when no row/col specified", () => {
  const chunk = makeChunk({ documentId: "d1", orderIndex: 4 });
  assert.ok(chunkCoversLocator(chunk, { documentId: "d1", orderIndex: 4, row: null, col: null }));
  assert.ok(!chunkCoversLocator(chunk, { documentId: "d1", orderIndex: 5, row: null, col: null }));
  assert.ok(!chunkCoversLocator(chunk, { documentId: "d2", orderIndex: 4, row: null, col: null }));
});

test("chunkCoversLocator: table span with row/col range must contain the locator's row/col", () => {
  const tableChunk = makeChunk({ documentId: "d1", orderIndex: 2, rowStart: 3, rowEnd: 5, colStart: 0, colEnd: 2 });
  assert.ok(chunkCoversLocator(tableChunk, { documentId: "d1", orderIndex: 2, row: 4, col: 1 }));
  assert.ok(!chunkCoversLocator(tableChunk, { documentId: "d1", orderIndex: 2, row: 9, col: 1 }));
  assert.ok(!chunkCoversLocator(tableChunk, { documentId: "d1", orderIndex: 2, row: 4, col: 9 }));
});

test("chunkCoversLocator: a non-table span (row_start=null) matches on order_index alone even when the locator specifies row/col", () => {
  const paragraphChunk = makeChunk({ documentId: "d1", orderIndex: 2 });
  assert.ok(chunkCoversLocator(paragraphChunk, { documentId: "d1", orderIndex: 2, row: 4, col: 1 }));
});
