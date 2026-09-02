// Turn P11-D: hard, non-configurable execution limits for the structured-
// output PROTOCOL comparison, mirroring hcx-real-smoke/hard-limits.mjs's
// own "single source of truth, code-enforced ceiling" pattern. Nothing in
// config or the environment can raise these -- only lower them further.
export const P11D_HARD_LIMITS = Object.freeze({
  SCENARIOS_PER_CANDIDATE: 5,
  REPETITIONS_PER_SCENARIO: 3,
  PER_CANDIDATE_REQUESTS: 15, // SCENARIOS_PER_CANDIDATE * REPETITIONS_PER_SCENARIO
  BASE_REQUESTS_TOTAL: 30, // PER_CANDIDATE_REQUESTS * 2 candidates
  GLOBAL_HARD_CAP: 36, // BASE_REQUESTS_TOTAL + retry headroom (CLAUDE.md Turn P11-D section F)
  RETRY_MAX_ATTEMPTS: 2, // total attempts per logical request: 1 initial + 1 retry, 429/5xx only
  CONCURRENCY: 1,
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  MAX_REQUEST_TIMEOUT_MS: 30_000,
  TEMPERATURE: 0,
});

export function clampRequestTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) return P11D_HARD_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(value, P11D_HARD_LIMITS.MAX_REQUEST_TIMEOUT_MS);
}
