import test from "node:test";
import assert from "node:assert/strict";
import {
  whitespaceTokenProxy,
  tokenProxyRange,
  utf8ByteLength,
  containsDateLike,
  containsAmountLike,
  isProtectedFromBoilerplate,
  isNumberOnly,
  isSymbolOnly,
  isPageNumberLike,
} from "../domain/agent-comparison/retrieval/index-planning/contracts.mjs";
import { createLengthAnalysisAccumulator } from "../domain/agent-comparison/retrieval/index-planning/length-analysis.mjs";
import { createDuplicateAnalysisAccumulator } from "../domain/agent-comparison/retrieval/index-planning/duplicate-analysis.mjs";
import { classifyBoilerplateCandidate, buildBoilerplateCandidateAnalysis, BOILERPLATE_CANDIDATE, NOT_CANDIDATE, computeHighDocFrequencyThreshold } from "../domain/agent-comparison/retrieval/index-planning/boilerplate-rules.mjs";
import { createHash } from "node:crypto";

function sha256(s) { return createHash("sha256").update(s).digest("hex"); }

function makeChunk({ chunkId, docId, text, blockType = "PARAGRAPH", tableRowRange = null, group = "exchange", ordinal = 0 }) {
  return {
    chunk_id: chunkId, source_document_id: docId, source_group: group,
    source_locator: `${docId}/a.xml#node=0`, node_id: `${docId}::a.xml::n0`, chunk_ordinal: ordinal,
    text_content: text, text_sha256: sha256(text),
    metadata: { block_type: blockType, table_row_range: tableRowRange },
  };
}

test("whitespace token proxy counts whitespace-delimited segments", () => {
  assert.equal(whitespaceTokenProxy("hello world foo"), 3);
  assert.equal(whitespaceTokenProxy("   "), 0);
  assert.equal(whitespaceTokenProxy(""), 0);
});

test("korean-aware token proxy range: lower bound <= upper bound, both scale with char count", () => {
  const short = tokenProxyRange(10);
  const long = tokenProxyRange(1000);
  assert.ok(short.low <= short.high);
  assert.ok(long.low <= long.high);
  assert.ok(long.low > short.low);
  assert.ok(long.high > short.high);
});

test("utf8ByteLength differs from char length for multi-byte Korean text", () => {
  const korean = "한국어";
  assert.ok(utf8ByteLength(korean) > korean.length, "Korean UTF-8 bytes must exceed JS char count");
});

test("length analysis accumulator: block_type/source_group/document distributions and extreme-shape counts", () => {
  const acc = createLengthAnalysisAccumulator({ tableMaxChunkChars: 1200 });
  acc.add(makeChunk({ chunkId: "c1", docId: "d1", text: "a normal paragraph of reasonable length here" }));
  acc.add(makeChunk({ chunkId: "c2", docId: "d1", text: "1", blockType: "TITLE" }));
  acc.add(makeChunk({ chunkId: "c3", docId: "d2", text: "x".repeat(1500), blockType: "TABLE", tableRowRange: [0, 0] }));
  const json = acc.toJSON();
  assert.equal(json.total_chunks, 3);
  assert.equal(json.block_type_counts.TITLE, 1);
  assert.equal(json.block_type_counts.TABLE, 1);
  assert.equal(json.chunks_per_document.documents_represented, 2);
  assert.equal(json.extreme_shape_candidates.extremely_short_chunk_count, 1); // "1"
  assert.equal(json.extreme_shape_candidates.oversized_table_row_chunk_count, 1); // 1500 > 1200
  assert.equal(json.extreme_shape_candidates.title_only_chunk_count, 1);
});

test("exact duplicate accumulator: within-document duplicate is not counted as cross-document", () => {
  const acc = createDuplicateAnalysisAccumulator();
  acc.add(makeChunk({ chunkId: "c1", docId: "d1", text: "repeated line" }));
  acc.add(makeChunk({ chunkId: "c2", docId: "d1", text: "repeated line", ordinal: 1 }));
  const json = acc.toJSON();
  assert.equal(json.unique_text_count, 1);
  assert.equal(json.sum_of_occurrences, 2);
  assert.equal(json.occurrences_match_total_chunks, true);
  assert.equal(json.cross_document_duplicate_groups, 0);
  assert.equal(json.within_document_duplicate_occurrences, 1);
});

test("exact duplicate accumulator: cross-document duplicate is correctly classified and occurrence sum is exact", () => {
  const acc = createDuplicateAnalysisAccumulator();
  acc.add(makeChunk({ chunkId: "c1", docId: "d1", text: "shared boilerplate" }));
  acc.add(makeChunk({ chunkId: "c2", docId: "d2", text: "shared boilerplate" }));
  acc.add(makeChunk({ chunkId: "c3", docId: "d3", text: "shared boilerplate" }));
  acc.add(makeChunk({ chunkId: "c4", docId: "d1", text: "unique to d1" }));
  const json = acc.toJSON();
  assert.equal(json.unique_text_count, 2);
  assert.equal(json.sum_of_occurrences, 4);
  assert.equal(json.occurrences_match_total_chunks, true);
  assert.equal(json.cross_document_duplicate_groups, 1);
  assert.equal(json.cross_document_duplicate_occurrences, 3);
  assert.equal(json.embedding_calls_avoidable, 2); // 4 chunks -> 2 unique texts
});

test("duplicate-analysis top_repeated_text_by_occurrence never exposes more than a 40-char preview", () => {
  const acc = createDuplicateAnalysisAccumulator();
  const longText = "매우 긴 반복 텍스트입니다. ".repeat(20);
  for (let i = 0; i < 3; i += 1) acc.add(makeChunk({ chunkId: `c${i}`, docId: `d${i}`, text: longText }));
  const json = acc.toJSON();
  const top = json.top_repeated_text_by_occurrence[0];
  assert.ok(top.safe_preview.length <= 41); // 40 chars + possible ellipsis char
  assert.notEqual(top.safe_preview, longText);
});

test("date-like and amount-like patterns are detected", () => {
  assert.ok(containsDateLike("계약 체결일: 2025-07-24"));
  assert.ok(containsDateLike("2025년 7월 24일 이사회 결의"));
  assert.ok(containsAmountLike("계약금액(원) 22,764,764,160,000"));
  assert.ok(!containsDateLike("이것은 반복되는 표준 문구입니다."));
  assert.ok(!containsAmountLike("이것은 반복되는 표준 문구입니다."));
});

test("isProtectedFromBoilerplate is true whenever either date or amount pattern matches", () => {
  assert.ok(isProtectedFromBoilerplate("2025-07-24"));
  assert.ok(isProtectedFromBoilerplate("22,764,764,160,000"));
  assert.ok(!isProtectedFromBoilerplate("표준 안내 문구"));
});

test("number-only, symbol-only, page-number-like classifiers", () => {
  assert.ok(isNumberOnly("123, 456"));
  assert.ok(!isNumberOnly("123 개"));
  assert.ok(isSymbolOnly("- | - | -"));
  assert.ok(!isSymbolOnly("- | 1 | -"));
  assert.ok(isPageNumberLike("- 12 -"));
  assert.ok(isPageNumberLike("42"));
});

test("classifyBoilerplateCandidate: a chunk containing a date/amount is NEVER flagged, even at very high frequency", () => {
  const entry = { count: 5000, distinctDocumentCount: 4000, charLength: 30, blockType: "PARAGRAPH", isNumberOnly: false, isSymbolOnly: false, isPageNumberLike: false, protectedFromBoilerplate: true };
  const result = classifyBoilerplateCandidate(entry, { totalDocuments: 4204 });
  assert.equal(result.status, NOT_CANDIDATE);
  assert.equal(result.protected_reason, "CONTAINS_DATE_OR_AMOUNT_LIKE_PATTERN");
});

test("classifyBoilerplateCandidate: high document frequency without protection IS flagged", () => {
  const threshold = computeHighDocFrequencyThreshold(4204);
  const entry = { count: threshold + 10, distinctDocumentCount: threshold + 10, charLength: 20, blockType: "PARAGRAPH", isNumberOnly: false, isSymbolOnly: false, isPageNumberLike: false, protectedFromBoilerplate: false };
  const result = classifyBoilerplateCandidate(entry, { totalDocuments: 4204 });
  assert.equal(result.status, BOILERPLATE_CANDIDATE);
  assert.ok(result.reason_codes.includes("BOILERPLATE_HIGH_DOC_FREQUENCY"));
});

test("classifyBoilerplateCandidate: low-frequency, non-protected, non-symbolic text is not a candidate", () => {
  const entry = { count: 1, distinctDocumentCount: 1, charLength: 50, blockType: "PARAGRAPH", isNumberOnly: false, isSymbolOnly: false, isPageNumberLike: false, protectedFromBoilerplate: false };
  const result = classifyBoilerplateCandidate(entry, { totalDocuments: 4204 });
  assert.equal(result.status, NOT_CANDIDATE);
});

test("buildBoilerplateCandidateAnalysis reports protected_despite_high_frequency_count when a high-frequency hash also contains a date/amount", () => {
  const acc = createDuplicateAnalysisAccumulator();
  const totalDocuments = 100;
  const threshold = computeHighDocFrequencyThreshold(totalDocuments); // max(20, 1) = 20
  for (let i = 0; i < threshold + 5; i += 1) {
    acc.add(makeChunk({ chunkId: `c${i}`, docId: `d${i}`, text: "기준일: 2025-07-24 현재" }));
  }
  const report = buildBoilerplateCandidateAnalysis(acc, { totalDocuments });
  assert.equal(report.boilerplate_candidate_unique_text_count, 0, "a date-bearing high-frequency text must never be a candidate");
  assert.equal(report.protected_despite_high_frequency_count, 1);
});

test("buildBoilerplateCandidateAnalysis flags a genuinely repeated, non-protected short text at high frequency", () => {
  const acc = createDuplicateAnalysisAccumulator();
  const totalDocuments = 100;
  const threshold = computeHighDocFrequencyThreshold(totalDocuments);
  for (let i = 0; i < threshold + 5; i += 1) {
    acc.add(makeChunk({ chunkId: `c${i}`, docId: `d${i}`, text: "표 없음" }));
  }
  const report = buildBoilerplateCandidateAnalysis(acc, { totalDocuments });
  assert.equal(report.boilerplate_candidate_unique_text_count, 1);
  assert.equal(report.boilerplate_candidate_occurrence_count, threshold + 5);
});
