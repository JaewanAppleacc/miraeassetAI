// Turn AC-OFFICIAL-INTEGRATION-V1: the ONE shared evaluation-cutoff
// contract for all four arms (A/B/C/D). config.A.json/config.C.json already
// pin retrieval_output_k=20/primary_evaluation_k=10/reported_cutoffs=
// [5,10,20] as plain config fields (vFINAL section E) -- this module is the
// executable form of that same contract: a single top-K retrieval per
// question, cutoffs derived from it afterward, never a second retrieval at
// a different K. B/D's own B.run.json/D.run.json independently confirm the
// same discipline already (config.k=20/chunk_k=20, summary.md reports
// Recall@5/10/20) -- this module does not change that, it only gives A/C's
// (not yet executed) side an importable, testable version of the identical
// rule so a future runner cannot silently diverge from it.
export const RETRIEVAL_OUTPUT_K = 20;
export const PRIMARY_EVALUATION_K = 10;
export const REPORTED_CUTOFFS = Object.freeze([5, 10, 20]);

export class CutoffContractViolationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "CutoffContractViolationError";
    this.code = code;
    Object.assign(this, details);
  }
}

// rankedIds: the FULL ranked result of ONE retrieval_output_k=20 call, in
// rank order. Never re-queried per cutoff -- every reported cutoff is a
// pure slice of this one list, which is the only way "single retrieval,
// derived cutoffs" can be enforced structurally rather than by convention.
export function deriveCutoffRanking(rankedIds, k) {
  if (!Array.isArray(rankedIds)) throw new CutoffContractViolationError("rankedIds must be an array", "CUTOFF_RANKED_IDS_NOT_ARRAY");
  if (rankedIds.length > RETRIEVAL_OUTPUT_K) {
    throw new CutoffContractViolationError(
      `rankedIds has ${rankedIds.length} entries, more than RETRIEVAL_OUTPUT_K=${RETRIEVAL_OUTPUT_K} -- a pool larger than the single official retrieval call is not allowed`,
      "CUTOFF_POOL_EXCEEDS_RETRIEVAL_OUTPUT_K", { actual: rankedIds.length },
    );
  }
  if (!REPORTED_CUTOFFS.includes(k)) {
    throw new CutoffContractViolationError(`k=${k} is not one of the contract's REPORTED_CUTOFFS ${JSON.stringify(REPORTED_CUTOFFS)}`, "CUTOFF_K_NOT_IN_CONTRACT", { k });
  }
  return Object.freeze(rankedIds.slice(0, k));
}

// relevantIds: the question's full relevant-id set (Gold-derived at actual
// scoring time -- this module never reads Gold itself, it only computes
// recall given whatever relevant-id set its caller supplies, so it stays
// generically testable with synthetic fixtures and cannot itself become an
// access path to Gold/DEV_CHECK/HOLDOUT content).
export function computeRecallAtK(rankedIds, relevantIds, k) {
  const top = deriveCutoffRanking(rankedIds, k);
  const relevantSet = new Set(relevantIds);
  if (relevantSet.size === 0) return null;
  const hitCount = top.filter((id) => relevantSet.has(id)).length;
  return hitCount / relevantSet.size;
}

// One retrieval, three derived numbers, primary called out explicitly --
// this is the shape a run ledger entry's metrics field should carry so a
// reader never has to guess which of the three cutoffs is the winner-
// determination one.
export function summarizeRecallAcrossKs(rankedIds, relevantIds) {
  const byK = {};
  for (const k of REPORTED_CUTOFFS) byK[k] = computeRecallAtK(rankedIds, relevantIds, k);
  return Object.freeze({
    retrieval_output_k: RETRIEVAL_OUTPUT_K,
    primary_evaluation_k: PRIMARY_EVALUATION_K,
    reported_cutoffs: REPORTED_CUTOFFS,
    recall_at_k: Object.freeze(byK),
    primary_recall: byK[PRIMARY_EVALUATION_K],
  });
}
