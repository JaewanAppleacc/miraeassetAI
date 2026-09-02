import test from "node:test";
import assert from "node:assert/strict";
import { expandWithParentContext, buildContextByTableNodeId, expandWithMultiRowContext } from "../domain/chunking/adaptive-parent-expansion.mjs";
import { PARENT_EXPANSION_POLICY } from "../domain/chunking/adaptive-chunking-policy.mjs";

function makeChunk({ chunkId, chunkType = "TABLE_ROW_WITH_HEADERS", tableNodeId = "t1", rowStart = 0, score = 1.0 }) {
  return { chunk_id: chunkId, chunk_type: chunkType, score, source_locator: `loc_${chunkId}`, source_spans: [{ row_start: rowStart }], metadata: { table_node_id: tableNodeId } };
}

test("late expansion rank invariant: rank/score/source_locator of each result are unchanged after expansion", () => {
  const ranked = [makeChunk({ chunkId: "c1", score: 0.9 }), makeChunk({ chunkId: "c2", score: 0.8 })];
  const contexts = buildContextByTableNodeId([
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "parent1", raw_text: "표제목: X", token_count: 10, metadata: { table_node_id: "t1" } },
  ]);
  const { results, result_count } = expandWithParentContext(ranked, contexts);
  assert.equal(result_count, 2, "Top-K slot count must be unchanged");
  assert.equal(results[0].rank, 0);
  assert.equal(results[0].score, 0.9);
  assert.equal(results[0].source_locator, "loc_c1");
  assert.equal(results[1].rank, 1);
  assert.equal(results[1].score, 0.8);
});

test("parent context is attached at most once per child (expansion_per_child: 1), never the whole set of siblings", () => {
  const ranked = [makeChunk({ chunkId: "c1" })];
  const contexts = buildContextByTableNodeId([
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "parent1", raw_text: "표제목: X", token_count: 10, metadata: { table_node_id: "t1" } },
  ]);
  const { results } = expandWithParentContext(ranked, contexts);
  assert.equal(results[0].parent_context.chunk_id, "parent1");
  assert.equal(results[0].expansion_reason, "ATTACHED");
});

test("sibling slot crowding prevention: expansion never adds a new result slot -- result_count always equals the input Top-K length", () => {
  const ranked = [makeChunk({ chunkId: "c1" }), makeChunk({ chunkId: "c2", tableNodeId: "t2" }), makeChunk({ chunkId: "c3", tableNodeId: "t1" })];
  const contexts = buildContextByTableNodeId([
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p1", raw_text: "x", token_count: 10, metadata: { table_node_id: "t1" } },
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p2", raw_text: "y", token_count: 10, metadata: { table_node_id: "t2" } },
  ]);
  const { results, result_count } = expandWithParentContext(ranked, contexts);
  assert.equal(result_count, 3);
  assert.equal(results.length, 3);
});

test("distinct rows from a multi-evidence question are preserved -- two different children from the SAME table both keep their own rank/row, neither is dropped or merged", () => {
  const ranked = [makeChunk({ chunkId: "c1", tableNodeId: "t1", rowStart: 2, score: 0.9 }), makeChunk({ chunkId: "c2", tableNodeId: "t1", rowStart: 5, score: 0.7 })];
  const contexts = buildContextByTableNodeId([{ chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p1", raw_text: "x", token_count: 10, metadata: { table_node_id: "t1" } }]);
  const { results } = expandWithParentContext(ranked, contexts);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].chunk_id, results[1].chunk_id);
  assert.equal(results[0].chunk.source_spans[0].row_start, 2);
  assert.equal(results[1].chunk.source_spans[0].row_start, 5);
});

test("total expansion context budget is enforced -- once exhausted, further children get NO_PARENT_CONTEXT rather than exceeding the configured cap", () => {
  const tightPolicy = { ...PARENT_EXPANSION_POLICY, total_expansion_context_budget_tokens: 15 };
  const ranked = [makeChunk({ chunkId: "c1", tableNodeId: "t1" }), makeChunk({ chunkId: "c2", tableNodeId: "t2" })];
  // Real 10-token text (Turn P10.4-R: truncation/budget math is now driven
  // by real retokenization of raw_text, not a caller-declared number).
  const tenTokens = Array.from({ length: 10 }, (_, i) => `단어${i}`).join(" ");
  const contexts = buildContextByTableNodeId([
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p1", raw_text: tenTokens, token_count: 10, metadata: { table_node_id: "t1" } },
    { chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p2", raw_text: tenTokens, token_count: 10, metadata: { table_node_id: "t2" } },
  ]);
  const { results, total_expansion_tokens } = expandWithParentContext(ranked, contexts, tightPolicy);
  assert.equal(results[0].expansion_reason, "ATTACHED");
  assert.equal(results[1].expansion_reason, "TOTAL_EXPANSION_BUDGET_EXHAUSTED");
  assert.ok(total_expansion_tokens <= tightPolicy.total_expansion_context_budget_tokens);
});

test("no configuration values are hardcoded inline -- the policy object controls token caps, not a literal in the expansion function", () => {
  // Realistic multi-token text (5000 distinct space-separated tokens,
  // matching the real tokenizer's word-run semantics) -- token_count is
  // genuinely 5000, not a made-up label unconnected to raw_text.
  const longRawText = Array.from({ length: 5000 }, (_, i) => `단어${i}`).join(" ");
  const ranked = [makeChunk({ chunkId: "c1" })];
  const contexts = buildContextByTableNodeId([{ chunk_type: "TABLE_PARENT_CONTEXT", chunk_id: "p1", raw_text: longRawText, token_count: 5000, metadata: { table_node_id: "t1" } }]);
  const customPolicy = { ...PARENT_EXPANSION_POLICY, parent_context_max_tokens: 50 };
  const { results } = expandWithParentContext(ranked, contexts, customPolicy);
  assert.equal(results[0].parent_context.token_count, 50);
  assert.equal(results[0].parent_context.truncated, true);
  // Turn P10.4-R / Section F: truncated must mean the ATTACHED TEXT is
  // actually shorter, never the full original text with a label attached.
  assert.ok(results[0].parent_context.raw_text.length < longRawText.length, "truncated raw_text must be strictly shorter than the original");
  assert.equal(results[0].parent_context.raw_text, Array.from({ length: 50 }, (_, i) => `단어${i}`).join(" "), "truncated text must be exactly the first 50 tokens, cut at a token boundary");
});

test("expandWithMultiRowContext: attaches multi-row context only when available, never fabricated, and provides real bounded raw_text (not just a token_count/truncated label)", () => {
  const contexts = buildContextByTableNodeId([{ chunk_type: "MULTI_ROW_CONTEXT", chunk_id: "m1", raw_text: "행1 행2 행3\n행4 행5 행6", token_count: 6, metadata: { table_node_id: "t1" } }]);
  const withContext = expandWithMultiRowContext(makeChunk({ chunkId: "c1", tableNodeId: "t1" }), contexts);
  assert.equal(withContext.multi_row_context.chunk_id, "m1");
  assert.equal(withContext.multi_row_context.raw_text, "행1 행2 행3\n행4 행5 행6");
  assert.equal(withContext.multi_row_context.truncated, false);
  const withoutContext = expandWithMultiRowContext(makeChunk({ chunkId: "c2", tableNodeId: "t_missing" }), contexts);
  assert.equal(withoutContext.multi_row_context, null);
});

test("expandWithMultiRowContext truncates real bounded raw_text when it exceeds the budget, exactly like expandWithParentContext", () => {
  const longRawText = Array.from({ length: 200 }, (_, i) => `행${i}`).join(" ");
  const contexts = buildContextByTableNodeId([{ chunk_type: "MULTI_ROW_CONTEXT", chunk_id: "m1", raw_text: longRawText, token_count: 200, metadata: { table_node_id: "t1" } }]);
  const customPolicy = { ...PARENT_EXPANSION_POLICY, parent_context_max_tokens: 30 };
  const { multi_row_context } = expandWithMultiRowContext(makeChunk({ chunkId: "c1", tableNodeId: "t1" }), contexts, customPolicy);
  assert.equal(multi_row_context.token_count, 30);
  assert.equal(multi_row_context.truncated, true);
  assert.equal(multi_row_context.raw_text, Array.from({ length: 30 }, (_, i) => `행${i}`).join(" "));
});
