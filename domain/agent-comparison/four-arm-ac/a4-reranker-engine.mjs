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
export const MAX_POOL_SIZE = 100;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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
function compareScored(a, b) {
  if (b.reranker_score !== a.reranker_score) return b.reranker_score - a.reranker_score;
  const aTop20 = a.in_original_a_top20 === true ? 1 : 0;
  const bTop20 = b.in_original_a_top20 === true ? 1 : 0;
  if (bTop20 !== aTop20) return bTop20 - aTop20;
  const aRank = isFiniteNumber(a.original_a_rank) ? a.original_a_rank : Number.POSITIVE_INFINITY;
  const bRank = isFiniteNumber(b.original_a_rank) ? b.original_a_rank : Number.POSITIVE_INFINITY;
  if (aRank !== bRank) return aRank - bRank;
  const aWide = isFiniteNumber(a.wide_rrf_rank) ? a.wide_rrf_rank : Number.POSITIVE_INFINITY;
  const bWide = isFiniteNumber(b.wide_rrf_rank) ? b.wide_rrf_rank : Number.POSITIVE_INFINITY;
  if (aWide !== bWide) return aWide - bWide;
  if (a.chunk_id < b.chunk_id) return -1;
  if (a.chunk_id > b.chunk_id) return 1;
  return 0;
}

function assertValidPool(pool) {
  if (!Array.isArray(pool)) throw new TypeError("pool must be an array");
  if (pool.length > MAX_POOL_SIZE) {
    throw new RangeError(`pool has ${pool.length} candidates, exceeding the pre-registered top-${MAX_POOL_SIZE} ceiling -- this engine never searches beyond its input`);
  }
  const seen = new Set();
  for (const candidate of pool) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.chunk_id !== "string" || candidate.chunk_id === "") {
      throw new TypeError("every candidate must be an object with a non-empty chunk_id");
    }
    if (seen.has(candidate.chunk_id)) throw new RangeError(`duplicate chunk_id in pool: ${candidate.chunk_id}`);
    seen.add(candidate.chunk_id);
  }
}

// pool: RerankerCandidate[] (<=100, the pre-registered wide-pool ceiling).
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
      original_a_rank: candidate.scores?.original_a_rrf?.rank ?? null,
      wide_rrf_rank: candidate.scores?.wide_rrf?.rank ?? null,
    });
  });

  scored.sort(compareScored);

  return scored.slice(0, TOP_K).map((entry, index) => Object.freeze({ ...entry, rank: index + 1 }));
}
