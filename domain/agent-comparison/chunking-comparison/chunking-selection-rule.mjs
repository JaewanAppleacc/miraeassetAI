// Turn P10.1: the FIXED chunking-selection rule, pinned before any
// evaluation is run and NEVER changed after seeing results (this Turn's
// brief, item 7). A pure function over already-computed strategy metrics
// -- never re-derives or re-weights anything based on which strategy
// "looks better."
//
// Rule order (exactly as specified):
//   1. Any strategy with >=1 locator/provenance violation is disqualified.
//   2. Primary criterion: macro Evidence Recall@10 (higher wins).
//   3. If the Recall@10 difference is < RECALL_TIE_TOLERANCE, prefer MRR.
//   4. If the MRR difference is ALSO < tolerance, prefer Recall@5.
//   5. If quality is effectively tied even after (2)-(4), prefer the
//      strategy with fewer unique embedding calls, then lower dense p50
//      latency.
//   6. If Hierarchical wins primarily because it has far more chunks
//      (cost), that cost increase is surfaced explicitly in the report
//      (never hidden behind a bare "winner" label).
//   7. (meta) This rule's own content-hash is recorded in every selection
//      report so a later diff can prove it was never edited after seeing
//      results.
export const RECALL_TIE_TOLERANCE = 0.01;
export const MRR_TIE_TOLERANCE = 0.01;

export const SELECTION_STATUS = Object.freeze({
  SELECTED: "FINAL_CHUNKING_SELECTED_FOR_EMBEDDING_COMPARISON",
  NO_SELECTION: "NO_FINAL_CHUNKING_SELECTION_MARGIN_TOO_SMALL",
});

// Returns { winner: strategyId|null, reasonTrail: string[], comparisons: [...] }
// strategies: [{ chunking_config_id, locator_provenance_violations,
//   macro_evidence_recall_at_k: {5,10,20}, macro_mrr,
//   smoke_unique_embed_texts (or total_unique_embed_texts), latency_dense_p50_ms,
//   total_chunks }]
export function selectChunkingStrategy(strategies, { determinismStable = true } = {}) {
  const reasonTrail = [];
  const qualified = strategies.filter((s) => s.locator_provenance_violations === 0);
  const disqualified = strategies.filter((s) => s.locator_provenance_violations > 0);
  if (disqualified.length > 0) {
    reasonTrail.push(`disqualified (locator/provenance violations > 0): ${disqualified.map((s) => s.chunking_config_id).join(", ")}`);
  }

  if (!determinismStable) {
    return { status: SELECTION_STATUS.NO_SELECTION, winner: null, reasonTrail: [...reasonTrail, "evaluation is not deterministic across reruns (unstable) -- refusing to select"] };
  }

  if (qualified.length === 0) {
    return { status: SELECTION_STATUS.NO_SELECTION, winner: null, reasonTrail: [...reasonTrail, "every strategy disqualified by locator/provenance violations"] };
  }
  if (qualified.length === 1) {
    reasonTrail.push(`only one qualifying strategy remains: ${qualified[0].chunking_config_id}`);
    return { status: SELECTION_STATUS.SELECTED, winner: qualified[0].chunking_config_id, reasonTrail };
  }

  // Deterministic ranking pass: sort qualified strategies by
  // chunking_config_id first so comparator ties are never order-dependent,
  // then apply the fixed rule chain.
  const ranked = [...qualified].sort((a, b) => a.chunking_config_id.localeCompare(b.chunking_config_id));

  function compare(a, b) {
    const recallA = a.macro_evidence_recall_at_k[10];
    const recallB = b.macro_evidence_recall_at_k[10];
    if (Math.abs(recallA - recallB) >= RECALL_TIE_TOLERANCE) return recallB - recallA;

    const mrrA = a.macro_mrr;
    const mrrB = b.macro_mrr;
    if (Math.abs(mrrA - mrrB) >= MRR_TIE_TOLERANCE) return mrrB - mrrA;

    const recall5A = a.macro_evidence_recall_at_k[5];
    const recall5B = b.macro_evidence_recall_at_k[5];
    if (Math.abs(recall5A - recall5B) >= RECALL_TIE_TOLERANCE) return recall5B - recall5A;

    // Effectively tied on quality -- rule 5: cost tie-break.
    if (a.total_unique_embed_texts !== b.total_unique_embed_texts) return a.total_unique_embed_texts - b.total_unique_embed_texts;
    if (a.latency_dense_p50_ms !== b.latency_dense_p50_ms) return a.latency_dense_p50_ms - b.latency_dense_p50_ms;
    return 0; // truly indistinguishable even after every tie-break
  }

  const sorted = [...ranked].sort(compare);
  const [best, second] = sorted;
  const stillTied = second !== undefined && compare(best, second) === 0;

  if (stillTied) {
    reasonTrail.push(`top strategies (${best.chunking_config_id}, ${second.chunking_config_id}) remain indistinguishable after every tie-break rule`);
    return { status: SELECTION_STATUS.NO_SELECTION, winner: null, reasonTrail };
  }

  reasonTrail.push(`selected ${best.chunking_config_id} by macro_evidence_recall_at_10=${best.macro_evidence_recall_at_k[10]} (tie-break chain applied as needed)`);

  // Rule 6: cost disclosure when a chunk-heavy strategy wins.
  const maxChunksOther = Math.max(0, ...sorted.slice(1).map((s) => s.total_chunks));
  const costNote = best.total_chunks > maxChunksOther * 1.5
    ? `NOTE: ${best.chunking_config_id} won with ${best.total_chunks} total chunks vs. the next-largest strategy's ${maxChunksOther} -- its performance advantage comes with a proportional chunk-count/storage/embedding-call cost increase; this is disclosed, never hidden.`
    : null;
  if (costNote) reasonTrail.push(costNote);

  return { status: SELECTION_STATUS.SELECTED, winner: best.chunking_config_id, reasonTrail, costNote };
}
