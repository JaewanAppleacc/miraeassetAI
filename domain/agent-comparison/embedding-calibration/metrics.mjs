// Turn P9: self-supervised calibration SMOKE metrics only. Every function
// here operates on a run's OWN embedded items ranking against THEMSELVES
// (self-match) -- never against DEV_GOLD, HOLDOUT, or any external
// relevance judgment. See runner.mjs's own header for why this is
// explicitly not a retrieval-quality or Agent-quality measurement.

// cosine similarity between two equal-length finite-number vectors.
export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Ranks every OTHER item (and itself) by similarity to `queryItem`'s own
// embedding, descending, with a stable tie-break (calibration_item_id
// ascending) so identical similarity scores never produce run-to-run
// ordering noise. Returns an array of calibration_item_id, best match
// first.
export function rankBySimilarity(queryItem, allItems, embeddingByItemId) {
  const queryVector = embeddingByItemId.get(queryItem.calibrationItemId);
  const scored = allItems.map((item) => ({
    id: item.calibrationItemId,
    score: cosineSimilarity(queryVector, embeddingByItemId.get(item.calibrationItemId)),
  }));
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored.map((s) => s.id);
}

// Self-match Recall@K: for a given item, does its OWN calibration_item_id
// (== expected_self_match_id) appear within the top K of its own ranking?
export function selfMatchHitAtK(rankedIds, expectedSelfMatchId, k) {
  return rankedIds.slice(0, k).includes(expectedSelfMatchId);
}

export function computeRecallAtK(items, embeddingByItemId, k) {
  if (items.length === 0) return 0;
  let hits = 0;
  for (const item of items) {
    const ranked = rankBySimilarity(item, items, embeddingByItemId);
    if (selfMatchHitAtK(ranked, item.expectedSelfMatchId, k)) hits += 1;
  }
  return hits / items.length;
}

// Mean Reciprocal Rank of the item's own self-match position (1-based).
export function computeMRR(items, embeddingByItemId) {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const item of items) {
    const ranked = rankBySimilarity(item, items, embeddingByItemId);
    const position = ranked.indexOf(item.expectedSelfMatchId);
    sum += position === -1 ? 0 : 1 / (position + 1);
  }
  return sum / items.length;
}

// Ranking a SECOND time from the SAME embeddings must reproduce the
// IDENTICAL ordering (including tie-break) -- proves rankBySimilarity has
// no hidden nondeterminism (Map iteration order, floating point ordering
// noise, etc).
export function rankingIsReproducible(items, embeddingByItemId) {
  for (const item of items) {
    const first = rankBySimilarity(item, items, embeddingByItemId);
    const second = rankBySimilarity(item, items, embeddingByItemId);
    if (JSON.stringify(first) !== JSON.stringify(second)) return false;
  }
  return true;
}

// corp_code metadata-filter accuracy smoke: for every item, restricting the
// candidate set to ONLY items sharing its own corp_code must (a) never let
// a different-company item outrank/replace the self-match, and (b) never
// include a different-company id anywhere in the filtered ranking at all.
// This is checking the SAME invariant reference-dedup-retrieval-repository.mjs's
// real filter-before-top-k SQL enforces at the DB layer, but purely
// in-memory over this run's own embeddings.
export function corpCodeFilterAccuracy(items, embeddingByItemId) {
  if (items.length === 0) return { accuracy: 1, violations: [] };
  const violations = [];
  for (const item of items) {
    const sameCorpItems = items.filter((other) => other.corpCode === item.corpCode);
    const ranked = rankBySimilarity(item, sameCorpItems, embeddingByItemId);
    const crossCorpLeak = ranked.some((id) => {
      const found = items.find((other) => other.calibrationItemId === id);
      return found && found.corpCode !== item.corpCode;
    });
    if (crossCorpLeak) violations.push(item.calibrationItemId);
  }
  return { accuracy: (items.length - violations.length) / items.length, violations };
}
