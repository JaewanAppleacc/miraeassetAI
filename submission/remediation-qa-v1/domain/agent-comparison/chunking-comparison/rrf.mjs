// Turn P10: Reciprocal Rank Fusion for combining a BM25 ranked list and a
// Dense (cosine) ranked list into one, deterministic tie-break included.
const DEFAULT_K = 60; // standard RRF constant

// rankedLists: array of [{ id, score }] arrays, already sorted desc by
// score (as bm25Search / denseSearch already return). Fuses by RANK
// (1-based position within each list), NOT by raw score magnitude -- so
// no cross-method score-scale normalization is ever needed or performed.
export function reciprocalRankFusion(rankedLists, { k = DEFAULT_K, topK = 10 } = {}) {
  const fused = new Map(); // id -> accumulated rrf score
  for (const list of rankedLists) {
    list.forEach((entry, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      fused.set(entry.id, (fused.get(entry.id) ?? 0) + contribution);
    });
  }
  const result = [...fused.entries()].map(([id, score]) => ({ id, score }));
  result.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return result.slice(0, topK);
}
