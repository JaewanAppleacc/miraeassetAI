// Turn A4-RERANKER-ENGINE-V1: the generic reranker engine.
//
// Pipeline (fixed, never reordered by a config):
//   candidate pool -> feature extraction -> weighted reranker score
//   -> deterministic sort (fixed global tie-break) -> top-20
//
// This module never:
//   - removes a candidate for being an apparent contradiction (that is
//     A3 Contradiction Guard's job, run separately, downstream of this
//     engine -- see A4_RERANKER_V1_CONTRACT.md section 4);
//   - issues a new search/DB/KURE call (it is pure, synchronous, and
//     takes its whole candidate pool as an argument);
//   - reads a Gold field, a real failure-packet id, or any DEV_CHECK/
//     HOLDOUT data (it has no code path that could -- there is no I/O
//     here at all);
//   - mutates an input candidate object (every candidate is spread into
//     a NEW frozen object; nothing is written back onto the caller's
//     own objects).
import { extractFeatures, FEATURE_KEYS } from "./a4-reranker-features.mjs";

export const TOP_K = 20;
// The A4 wide pool is BM25 top-100 UNION dense top-100, deduplicated by
// chunk_id -- up to 200 distinct candidates, not 100. Frozen Arm A's
// original top-20 is itself a subset of that same union (every one of
// its members already appears in the BM25 and/or dense top-100 legs), so
// it is never counted as 20 additional candidates on top of the 200.
export const MAX_POOL_SIZE = 200;
export const BM25_DENSE_LEG_MAX_RANK = 100;
export const WIDE_RRF_MAX_RANK = 200;
export const ORIGINAL_A_MAX_RANK = 20;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

// rank: null/undefined means "not present in this leg" (a legitimate,
// meaningful absence -- see a4-reranker-features.mjs's own header) and is
// always allowed. A present rank must be an integer in [1, maxRank].
function assertRankRange(rank, maxRank, label) {
  if (rank === null || rank === undefined) return;
  if (!isPositiveInteger(rank) || rank > maxRank) {
    throw new RangeError(`${label} must be an integer in [1, ${maxRank}] or null (got ${JSON.stringify(rank)})`);
  }
}

// source_ranks.original_a is arm A's RRF rank recomputed over the FULL
// candidate pool (buildWideCandidatePool's own "would-be" ranking), so it
// is NOT capped at 20 in general -- a candidate outside A's actual
// official top-20 can still carry a large original_a rank as diagnostic
// information. The [1,20] ceiling applies ONLY when
// source_membership.original_a_top20 is true (the candidate was actually
// among A's officially-returned 20); in that case a rank is required and
// must fall in [1,20].
function assertOriginalARank(candidate) {
  const rank = candidate.source_ranks?.original_a;
  const isTop20 = candidate.source_membership?.original_a_top20 === true;
  const label = `candidate ${candidate.chunk_id}: source_ranks.original_a`;
  if (rank === null || rank === undefined) {
    if (isTop20) throw new RangeError(`${label} must be an integer in [1, ${ORIGINAL_A_MAX_RANK}] when source_membership.original_a_top20 is true (got null)`);
    return;
  }
  if (!isPositiveInteger(rank)) throw new RangeError(`${label} must be a positive integer or null (got ${JSON.stringify(rank)})`);
  if (isTop20 && rank > ORIGINAL_A_MAX_RANK) {
    throw new RangeError(`${label} must be an integer in [1, ${ORIGINAL_A_MAX_RANK}] when source_membership.original_a_top20 is true (got ${rank})`);
  }
}

// Returns a list of human-readable problems; empty means valid. Never
// throws itself -- assertValidConfig() is the fail-closed entry point.
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    errors.push("config must be an object");
    return errors;
  }
  if (typeof config.config_id !== "string" || config.config_id === "") {
    errors.push("config_id must be a non-empty string");
  }
  if (!config.weights || typeof config.weights !== "object" || Array.isArray(config.weights)) {
    errors.push("weights must be an object");
    return errors;
  }
  for (const key of Object.keys(config.weights)) {
    if (!FEATURE_KEYS.includes(key)) errors.push(`unknown feature weight key: "${key}"`);
  }
  for (const key of FEATURE_KEYS) {
    if (!Object.hasOwn(config.weights, key)) continue; // omitted key defaults to weight 0, always valid
    const w = config.weights[key];
    if (!isFiniteNumber(w)) errors.push(`weight for "${key}" must be a finite number (got ${JSON.stringify(w)})`);
    else if (w < 0) errors.push(`weight for "${key}" must be >= 0 (got ${w})`);
  }
  return errors;
}

export function assertValidConfig(config) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new RangeError(`invalid reranker config "${config && typeof config === "object" ? (config.config_id ?? "?") : "?"}": ${errors.join("; ")}`);
  }
}

function weightedScore(features, weights) {
  let score = 0;
  for (const key of FEATURE_KEYS) {
    const w = weights[key] ?? 0;
    score += w * features[key];
  }
  if (!isFiniteNumber(score)) throw new RangeError("computed reranker_score is not finite");
  return score;
}

// The ONE fixed, global tie-break chain (Turn A4-RERANKER-ENGINE-V1's own
// spec) -- deliberately NOT part of the per-config JSON, so no config can
// weaken or reorder it:
//   reranker_score desc -> original_a_top20 desc -> original_a_rank asc
//   -> wide_rrf_rank asc -> chunk_id bytewise asc.
//
// The original-A protection (both the boolean step AND the rank
// sub-step) applies ONLY to candidates with
// source_membership.original_a_top20 === true. A candidate outside A's
// actual official top-20 may still carry a numeric source_ranks.
// original_a ("would-be" rank, see a4-wide-candidate-pool.mjs), but that
// number is diagnostic only and never used as a protective tie-break
// signal here -- `originalARankForTieBreak` below deliberately ignores it
// unless the top20 flag is true.
function originalARankForTieBreak(entry) {
  if (entry.in_original_a_top20 !== true) return Number.POSITIVE_INFINITY;
  return isFiniteNumber(entry.original_a_rank) ? entry.original_a_rank : Number.POSITIVE_INFINITY;
}

function compareScored(a, b) {
  if (b.reranker_score !== a.reranker_score) return b.reranker_score - a.reranker_score;
  const aTop20 = a.in_original_a_top20 === true ? 1 : 0;
  const bTop20 = b.in_original_a_top20 === true ? 1 : 0;
  if (bTop20 !== aTop20) return bTop20 - aTop20;
  const aRank = originalARankForTieBreak(a);
  const bRank = originalARankForTieBreak(b);
  if (aRank !== bRank) return aRank - bRank;
  const aWide = isFiniteNumber(a.wide_rrf_rank) ? a.wide_rrf_rank : Number.POSITIVE_INFINITY;
  const bWide = isFiniteNumber(b.wide_rrf_rank) ? b.wide_rrf_rank : Number.POSITIVE_INFINITY;
  if (aWide !== bWide) return aWide - bWide;
  if (a.chunk_id < b.chunk_id) return -1;
  if (a.chunk_id > b.chunk_id) return 1;
  return 0;
}

// Every candidate in the wide pool must be traceable to at least one of
// the two source legs (BM25 top-100 or dense top-100) -- a candidate with
// neither flag set could not have come from the pre-registered union
// contract and is rejected rather than silently accepted.
function assertPoolMembership(candidate) {
  const membership = candidate.source_membership ?? {};
  if (membership.bm25_top100 !== true && membership.dense_top100 !== true) {
    throw new RangeError(
      `candidate ${candidate.chunk_id} has neither source_membership.bm25_top100=true nor source_membership.dense_top100=true -- every wide-pool candidate must come from at least one source leg`,
    );
  }
}

function assertValidPool(pool) {
  if (!Array.isArray(pool)) throw new TypeError("pool must be an array");
  if (pool.length > MAX_POOL_SIZE) {
    throw new RangeError(`pool has ${pool.length} candidates, exceeding the pre-registered top-${MAX_POOL_SIZE} (BM25 top-100 UNION dense top-100) ceiling -- this engine never searches beyond its input`);
  }
  const seen = new Set();
  for (const candidate of pool) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.chunk_id !== "string" || candidate.chunk_id === "") {
      throw new TypeError("every candidate must be an object with a non-empty chunk_id");
    }
    if (seen.has(candidate.chunk_id)) throw new RangeError(`duplicate chunk_id in pool: ${candidate.chunk_id}`);
    seen.add(candidate.chunk_id);
    assertPoolMembership(candidate);
    const ranks = candidate.source_ranks ?? {};
    assertRankRange(ranks.bm25, BM25_DENSE_LEG_MAX_RANK, `candidate ${candidate.chunk_id}: source_ranks.bm25`);
    assertRankRange(ranks.dense, BM25_DENSE_LEG_MAX_RANK, `candidate ${candidate.chunk_id}: source_ranks.dense`);
    assertRankRange(ranks.wide_rrf, WIDE_RRF_MAX_RANK, `candidate ${candidate.chunk_id}: source_ranks.wide_rrf`);
    assertOriginalARank(candidate);
  }
}

// pool: RerankerCandidate[] (<=200, the pre-registered wide-pool ceiling --
// BM25 top-100 UNION dense top-100, deduplicated by chunk_id). Every
// candidate in `pool` is scored, in full, before any truncation -- there
// is no pre-scoring cut to 100; only the FINAL sort is truncated to
// TOP_K=20.
// questionContext: RerankerQuestionContext (never Gold).
// config: one pre-registered entry from a4-reranker-configs.v1.json.
//
// Returns a NEW array (<=20 items) of frozen candidate objects: every
// original field preserved, plus `features`, `reranker_score`, and the
// final 1-based `rank`. The output is always a stable subset of the
// input -- no candidate is ever fabricated, and none is ever dropped for
// "being a contradiction" (that filtering, if any, happens downstream of
// this engine, never inside it).
export function rerankCandidates(pool, questionContext, config) {
  assertValidConfig(config);
  assertValidPool(pool);

  const scored = pool.map((candidate) => {
    const features = extractFeatures(candidate, questionContext);
    const reranker_score = weightedScore(features, config.weights);
    return Object.freeze({
      ...candidate,
      features,
      reranker_score,
      in_original_a_top20: candidate.source_membership?.original_a_top20 === true,
      original_a_rank: candidate.source_ranks?.original_a ?? null,
      wide_rrf_rank: candidate.source_ranks?.wide_rrf ?? null,
    });
  });

  scored.sort(compareScored);

  return scored.slice(0, TOP_K).map((entry, index) => Object.freeze({ ...entry, rank: index + 1 }));
}
