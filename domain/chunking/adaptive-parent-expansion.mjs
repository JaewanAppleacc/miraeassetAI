// Turn P10.4 / Stage 3: late parent-context expansion. Search ranking
// (BM25+dense+RRF) runs ONLY over retrieval-eligible chunks (FIXED_WINDOW
// non-table-touching + TABLE_ROW_WITH_HEADERS/TABLE_ROW_SEGMENT_WITH_
// HEADERS) -- CONTEXT_ONLY chunks (MULTI_ROW_CONTEXT, TABLE_PARENT_
// CONTEXT) are never embedded/indexed as base candidates (enforced by the
// caller never including them in the BM25/dense corpus, not by this
// module). This module runs strictly AFTER Top-K is finalized: it never
// re-scores, never adds a result slot, never lets a sibling context chunk
// crowd out another item's own evidence.
import { PARENT_EXPANSION_POLICY } from "./adaptive-chunking-policy.mjs";
import { tokenizeWithOffsets } from "./chunker.mjs";

// Turn P10.4-R / Section F: real truncation, not a label. Retokenizes
// raw_text with the SAME tokenizer the chunker itself used to build it
// (never trusts a caller-declared token_count to slice by), and cuts the
// STRING at the character offset of the last token that fits the budget
// -- so `truncated: true` means the attached text is actually shorter,
// never the full original text with a truncated flag stapled on.
function truncateToTokenBudget(rawText, maxTokens) {
  const text = String(rawText ?? "");
  const tokens = tokenizeWithOffsets(text);
  if (tokens.length <= maxTokens) return { text, tokenCount: tokens.length, truncated: false };
  const cutOffset = maxTokens > 0 ? tokens[maxTokens - 1].end : 0;
  return { text: text.slice(0, cutOffset), tokenCount: maxTokens, truncated: true };
}

// rankedChunks: the ALREADY-FINALIZED Top-K result (array of chunk
// objects, in rank order -- untouched by this function). allChunksByTable:
// Map(table_node_id -> { multiRowContext, parentContext }) for O(1)
// lookup of the CONTEXT_ONLY chunks belonging to a given table, built once
// per document/corpus, never re-derived per query.
export function expandWithParentContext(rankedChunks, contextByTableNodeId, policy = PARENT_EXPANSION_POLICY) {
  let totalExpansionTokens = 0;
  const expanded = rankedChunks.map((chunk, rank) => {
    // Rank/score/source_locator of the original child are preserved
    // verbatim -- expansion attaches context, it never mutates them.
    const base = { rank, chunk_id: chunk.chunk_id, score: chunk.score, source_locator: chunk.source_locator, chunk };
    const tableNodeId = chunk.metadata?.table_node_id;
    if (!tableNodeId || chunk.chunk_type === "FIXED_WINDOW") return { ...base, parent_context: null, expansion_reason: "NOT_A_TABLE_CHILD" };

    const contexts = contextByTableNodeId.get(tableNodeId);
    if (!contexts?.parentContext) return { ...base, parent_context: null, expansion_reason: "NO_PARENT_CONTEXT_AVAILABLE" };

    const { text: boundedText, tokenCount: parentTokens, truncated } = truncateToTokenBudget(contexts.parentContext.raw_text, policy.parent_context_max_tokens);
    // Checked BEFORE attaching, against what this attachment would bring
    // the running total to -- never lets a single attachment push the
    // cumulative total past the configured budget.
    if (totalExpansionTokens + parentTokens > policy.total_expansion_context_budget_tokens) {
      return { ...base, parent_context: null, expansion_reason: "TOTAL_EXPANSION_BUDGET_EXHAUSTED" };
    }
    totalExpansionTokens += parentTokens;
    return {
      ...base,
      // expansion_per_child caps at 1 -- exactly one TABLE_PARENT_CONTEXT
      // per selected child, never the sibling rows or other Parent slots.
      parent_context: { chunk_id: contexts.parentContext.chunk_id, raw_text: boundedText.length > 0 ? boundedText : null, token_count: parentTokens, truncated },
      expansion_reason: "ATTACHED",
    };
  });

  return {
    results: expanded,
    // Top-K slot count MUST equal the input rankedChunks length -- parent
    // expansion never adds or removes a result slot.
    result_count: expanded.length,
    total_expansion_tokens: totalExpansionTokens,
  };
}

// Builds the O(1) lookup map from a document's full chunk list (including
// CONTEXT_ONLY ones) -- called once per document, not per query.
export function buildContextByTableNodeId(allChunks) {
  const map = new Map();
  for (const chunk of allChunks) {
    const tableNodeId = chunk.metadata?.table_node_id;
    if (!tableNodeId) continue;
    const entry = map.get(tableNodeId) ?? {};
    if (chunk.chunk_type === "TABLE_PARENT_CONTEXT") entry.parentContext = { chunk_id: chunk.chunk_id, raw_text: chunk.raw_text, token_count: chunk.token_count };
    if (chunk.chunk_type === "MULTI_ROW_CONTEXT") entry.multiRowContext = { chunk_id: chunk.chunk_id, raw_text: chunk.raw_text, token_count: chunk.token_count };
    map.set(tableNodeId, entry);
  }
  return map;
}

// Selects MULTI_ROW_CONTEXT for a specific child when the item requires
// multi-row evidence (never a default for every child -- only when the
// caller identifies a genuine multi-row need, e.g. via Stage 1-2's
// MULTI_ROW_CALCULATION tag). Distinct rows are preserved: this attaches
// the WHOLE table's row context, not a lossy summary.
export function expandWithMultiRowContext(selectedChild, contextByTableNodeId, policy = PARENT_EXPANSION_POLICY) {
  const tableNodeId = selectedChild.metadata?.table_node_id;
  if (!tableNodeId) return { multi_row_context: null, reason: "NOT_A_TABLE_CHILD" };
  const contexts = contextByTableNodeId.get(tableNodeId);
  if (!contexts?.multiRowContext) return { multi_row_context: null, reason: "NO_MULTI_ROW_CONTEXT_AVAILABLE" };
  // Real bounded raw_text (Turn P10.4-R / Section F), same truncation
  // rule as expandWithParentContext -- MULTI_ROW_CONTEXT must provide
  // actual usable text, never just a token_count/truncated label.
  const { text: boundedText, tokenCount: tokens, truncated } = truncateToTokenBudget(contexts.multiRowContext.raw_text, policy.parent_context_max_tokens);
  return { multi_row_context: { chunk_id: contexts.multiRowContext.chunk_id, raw_text: boundedText.length > 0 ? boundedText : null, token_count: tokens, truncated }, reason: "ATTACHED" };
}
