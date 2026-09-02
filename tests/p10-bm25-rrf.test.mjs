import test from "node:test";
import assert from "node:assert/strict";
import { buildBm25Index, bm25Search, bm25Score, defaultTokenize } from "../domain/agent-comparison/chunking-comparison/bm25.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";

const DOCS = [
  { id: "chunk_aaa", text: "삼성전자 반도체 공급계약 체결" },
  { id: "chunk_bbb", text: "LG전자 배터리 공급계약 해지" },
  { id: "chunk_ccc", text: "삼성전자 반도체 수출 계약금액 증가" },
  { id: "chunk_zzz", text: "전혀 관련 없는 문서 내용" },
];

test("bm25: ranks documents sharing more query terms higher", () => {
  const index = buildBm25Index(DOCS);
  const results = bm25Search(index, "삼성전자 반도체 계약", { topK: 4 });
  assert.equal(results[0].id, "chunk_aaa");
  assert.ok(new Set(results.slice(0, 2).map((r) => r.id)).has("chunk_ccc"));
  assert.ok(results.every((r) => Number.isFinite(r.score)));
});

test("bm25: deterministic across repeated builds and searches", () => {
  const index1 = buildBm25Index(DOCS);
  const index2 = buildBm25Index(DOCS);
  const results1 = bm25Search(index1, "삼성전자 계약", { topK: 4 });
  const results2 = bm25Search(index2, "삼성전자 계약", { topK: 4 });
  assert.deepEqual(results1, results2);
});

test("bm25: exact score ties break by lexicographically smaller id", () => {
  const tiedDocs = [
    { id: "chunk_b", text: "동일한 문장 내용" },
    { id: "chunk_a", text: "동일한 문장 내용" },
  ];
  const index = buildBm25Index(tiedDocs);
  const results = bm25Search(index, "동일한 문장", { topK: 2 });
  assert.equal(results[0].score, results[1].score);
  assert.equal(results[0].id, "chunk_a");
});

test("bm25: topK truncates only AFTER full-corpus scoring/sorting", () => {
  const index = buildBm25Index(DOCS);
  const full = bm25Search(index, "삼성전자 반도체 계약", { topK: 100 });
  const limited = bm25Search(index, "삼성전자 반도체 계약", { topK: 2 });
  assert.deepEqual(limited, full.slice(0, 2));
});

test("bm25: query term absent from the corpus contributes zero, never NaN", () => {
  const index = buildBm25Index(DOCS);
  const score = bm25Score(index, "chunk_aaa", ["never-seen-term-xyz"]);
  assert.equal(score, 0);
});

test("bm25: rejects duplicate document ids", () => {
  assert.throws(() => buildBm25Index([{ id: "x", text: "a" }, { id: "x", text: "b" }]), /duplicate document id/);
});

test("defaultTokenize: lowercases and preserves Korean/number runs", () => {
  assert.deepEqual(defaultTokenize("Samsung 1,000원"), ["samsung", "1", ",", "000원"]);
});

test("rrf: fuses by rank position, not raw score magnitude", () => {
  const bm25List = [{ id: "a", score: 100 }, { id: "b", score: 1 }];
  const denseList = [{ id: "b", score: 0.9 }, { id: "a", score: 0.1 }];
  const fused = reciprocalRankFusion([bm25List, denseList], { topK: 2 });
  // Both a and b are rank-1 once each -> equal RRF score -> id tie-break.
  assert.equal(fused[0].id, "a");
  assert.equal(fused[0].score, fused[1].score);
});

test("rrf: an id appearing in only one list still gets fused in, and is not force-included when absent from a shorter topK slice", () => {
  const bm25List = [{ id: "a", score: 1 }, { id: "b", score: 0.5 }, { id: "c", score: 0.1 }];
  const denseList = [{ id: "a", score: 0.5 }];
  const fused = reciprocalRankFusion([bm25List, denseList], { topK: 3 });
  const ids = fused.map((f) => f.id);
  assert.ok(ids.includes("a"));
  assert.ok(ids.includes("b"));
  assert.ok(ids.includes("c"));
  assert.equal(fused[0].id, "a"); // present in both lists at rank 1 -> highest fused score
});

test("rrf: deterministic and respects topK cap", () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, score: 10 - i }));
  const fused1 = reciprocalRankFusion([list], { topK: 3 });
  const fused2 = reciprocalRankFusion([list], { topK: 3 });
  assert.deepEqual(fused1, fused2);
  assert.equal(fused1.length, 3);
});
