// Turn P10.1: retrieval-quality metrics for the DEV_TUNE-101 chunking
// comparison. Every metric here is computed from STRUCTURAL provenance
// (document_id, chunk source_spans' order_index/row/col) matched against
// required_evidence_slots[].acceptable_sources[].source_locator -- NEVER
// from expected_answer or evidence_span TEXT (see dev-tune-evidence-
// locator.mjs's own header comment for why).
import { parseEvidenceLocator, chunkCoversLocator } from "./dev-tune-evidence-locator.mjs";

// A required_evidence_slot is "covered" by the ranked chunk list (top-k
// prefix) if ANY of its acceptable_sources is covered by ANY chunk in that
// prefix.
function slotCoveredByTopK(slot, rankedChunks, topK) {
  const prefix = rankedChunks.slice(0, topK);
  return slot.acceptable_sources.some((source) => {
    const parsed = parseEvidenceLocator(source.source_locator, source.document_id);
    return prefix.some((chunk) => chunkCoversLocator(chunk, parsed));
  });
}

// A single chunk is "relevant" to an item if it covers at least one of the
// item's required_evidence_slots (regardless of which).
function chunkIsRelevant(chunk, item) {
  return item.required_evidence_slots.some((slot) =>
    slot.acceptable_sources.some((source) => {
      const parsed = parseEvidenceLocator(source.source_locator, source.document_id);
      return chunkCoversLocator(chunk, parsed);
    }));
}

// Coarser tiers than slot coverage, for the "document/node/locator hit
// rate" diagnostic: document hit ignores order_index/row/col entirely;
// node hit ignores row/col; locator hit is the full match (same as
// chunkCoversLocator itself already does when row/col are present).
function documentHit(rankedChunks, topK, item) {
  const goldDocIds = new Set(item.gold_document_ids ?? []);
  return rankedChunks.slice(0, topK).some((chunk) => goldDocIds.has(chunk.document_id));
}

function nodeHit(rankedChunks, topK, item) {
  const prefix = rankedChunks.slice(0, topK);
  return item.required_evidence_slots.some((slot) =>
    slot.acceptable_sources.some((source) => {
      const parsed = parseEvidenceLocator(source.source_locator, source.document_id);
      return prefix.some((chunk) => chunk.document_id === parsed.documentId && chunk.source_spans.some((span) => span.order_index === parsed.orderIndex));
    }));
}

function locatorHit(rankedChunks, topK, item) {
  const prefix = rankedChunks.slice(0, topK);
  return item.required_evidence_slots.some((slot) =>
    slot.acceptable_sources.some((source) => {
      const parsed = parseEvidenceLocator(source.source_locator, source.document_id);
      return prefix.some((chunk) => chunkCoversLocator(chunk, parsed));
    }));
}

// nDCG@10 with binary per-chunk relevance (see module header): DCG of the
// ACTUAL top-10 ranking's relevance sequence, divided by the DCG of that
// same multiset sorted descending (the best achievable ordering of what
// was actually returned) -- the standard variant used when exhaustive
// relevance judgments beyond the returned set are unavailable.
function ndcgAtK(rankedChunks, item, k) {
  const rel = rankedChunks.slice(0, k).map((chunk) => (chunkIsRelevant(chunk, item) ? 1 : 0));
  const dcg = rel.reduce((sum, r, i) => sum + r / Math.log2(i + 2), 0);
  const idealRel = [...rel].sort((a, b) => b - a);
  const idcg = idealRel.reduce((sum, r, i) => sum + r / Math.log2(i + 2), 0);
  return idcg === 0 ? null : dcg / idcg; // null when nothing in top-k is relevant AND nothing could be -- excluded from macro average, never scored as 0 or 1 artificially
}

function reciprocalRank(rankedChunks, item) {
  for (const [index, chunk] of rankedChunks.entries()) {
    if (chunkIsRelevant(chunk, item)) return 1 / (index + 1);
  }
  return 0;
}

const TOP_K_VALUES = Object.freeze([5, 10, 20]);

// Computes every per-item metric for ONE item given its already-ranked
// (RRF-fused, or BM25-only/dense-only) chunk list. Returns null-safe
// (has_required_slots=false) fields for items with 0 required_evidence_slots.
export function computeItemMetrics(item, rankedChunks) {
  const hasSlots = item.required_evidence_slots.length > 0;
  const slotCoverageByK = {};
  for (const k of TOP_K_VALUES) {
    if (!hasSlots) { slotCoverageByK[k] = null; continue; }
    const coveredCount = item.required_evidence_slots.filter((slot) => slotCoveredByTopK(slot, rankedChunks, k)).length;
    slotCoverageByK[k] = coveredCount / item.required_evidence_slots.length;
  }
  return {
    question_id: item.question_id,
    expected_answerability: item.expected_answerability,
    has_required_slots: hasSlots,
    evidence_slot_coverage_fraction_at_k: slotCoverageByK,
    reciprocal_rank: hasSlots ? reciprocalRank(rankedChunks, item) : null,
    ndcg_at_10: hasSlots ? ndcgAtK(rankedChunks, item, 10) : null,
    document_hit_at_10: documentHit(rankedChunks, 10, item),
    node_hit_at_10: hasSlots ? nodeHit(rankedChunks, 10, item) : false,
    locator_hit_at_10: hasSlots ? locatorHit(rankedChunks, 10, item) : false,
    returned_at_least_one_at_10: rankedChunks.slice(0, 10).length > 0,
  };
}

function mean(values) {
  const filtered = values.filter((v) => v !== null && v !== undefined);
  return filtered.length > 0 ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
}

function rate(values) {
  return values.length > 0 ? values.filter(Boolean).length / values.length : null;
}

// Aggregates per-item metrics into the strategy-level report. "macro"
// throughout = simple mean over items (equal item weight, per this Turn's
// brief's selection rule wording), never slot-pooled/micro-averaged.
export function aggregateStrategyMetrics(perItemMetrics) {
  const withSlots = perItemMetrics.filter((m) => m.has_required_slots);
  const notFoundItems = perItemMetrics.filter((m) => m.expected_answerability === "NOT_FOUND");

  const macroRecallAtK = {};
  for (const k of TOP_K_VALUES) macroRecallAtK[k] = mean(withSlots.map((m) => m.evidence_slot_coverage_fraction_at_k[k]));

  return {
    item_count: perItemMetrics.length,
    items_with_required_slots: withSlots.length,
    macro_evidence_recall_at_k: macroRecallAtK,
    macro_mrr: mean(withSlots.map((m) => m.reciprocal_rank)),
    macro_ndcg_at_10: mean(withSlots.map((m) => m.ndcg_at_10)),
    document_hit_rate_at_10: rate(perItemMetrics.map((m) => m.document_hit_at_10)),
    node_hit_rate_at_10: rate(withSlots.map((m) => m.node_hit_at_10)),
    locator_hit_rate_at_10: rate(withSlots.map((m) => m.locator_hit_at_10)),
    // Definition (fixed before running, documented here and in the final
    // report): fraction of NOT_FOUND items for which top-10 retrieval
    // still returns at least one chunk -- i.e. retrieval ALONE offers no
    // abstention signal. This is expected to be ~1.0 for any working
    // retriever; it measures whether an UPSTREAM answerability check is
    // structurally necessary, not a chunking-strategy quality difference.
    not_found_false_positive_rate_at_10: rate(notFoundItems.map((m) => m.returned_at_least_one_at_10)),
    not_found_item_count: notFoundItems.length,
  };
}
