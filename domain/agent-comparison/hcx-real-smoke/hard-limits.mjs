// Turn P11-B: hard, non-configurable execution limits for the real HyperCLOVA
// X protocol smoke. These are CODE-ENFORCED ceilings -- nothing in config or
// the environment can raise them, only lower them further. This is the
// single source of truth every other P11-B module imports from, so the
// limits can never drift between the runner, the artifact builders, and the
// tests that assert on them.
export const HARD_LIMITS = Object.freeze({
  MAXIMUM_REQUESTS: 10,
  CONCURRENCY: 1,
  RETRY_MAX_ATTEMPTS: 2, // total attempts per logical request (1 initial + 1 retry)
  DEFAULT_REQUEST_TIMEOUT_MS: 15_000,
  MAX_REQUEST_TIMEOUT_MS: 30_000, // an env override above this is clamped down, never raised
  OVERALL_TIME_BUDGET_MS: 300_000, // 5 minutes wall-clock for the whole smoke run
  CONSECUTIVE_SCENARIO_FAILURES_TO_STOP: 2,
});

export function clampRequestTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) return HARD_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(value, HARD_LIMITS.MAX_REQUEST_TIMEOUT_MS);
}
