# Agent Comparison Benchmark Runner / Gold-blind Scoring Infrastructure (Turn P6)

Builds a common Benchmark Runner and 8 independent Grading Scorers that run
identical evaluation items through all four Agent variants
(`STRUCTURED_FIRST`, `HYBRID_RETRIEVAL`, `PLANNER`, `DOCUMENT_FIRST_RAG`)
via the existing, unmodified `domain/runtime/agent-runtime.mjs`
`runAgentFlow`. **This Turn never reads real Gold/HOLDOUT data and never
computes an Agent ranking** -- every schema/example/test here uses synthetic
fixture ids/values only.

## What's here

| File | Role |
|---|---|
| `interfaces/dataset-record.schema.json` | Section A: the minimal DatasetRecord contract a Benchmark Runner accepts -- deliberately does not fix the real Gold's eventual shape |
| `interfaces/dataset-manifest.schema.json` | Summarizes a loaded dataset: split counts, leakage check result, HOLDOUT gate state |
| `dataset.mjs` | `loadDatasetRecords` -- schema validation, duplicate-id check, `checkSplitLeakage`, and the HOLDOUT unlock gate (reuses `domain/runtime/evaluation-usage-ledger.mjs`'s `canUseSplit` unmodified) |
| `runner.mjs` | `runBenchmark` -- the common runner: every (DatasetRecord, variant_id) pair gets a fresh instrumented ModelAdapter + fresh Flow instance, `structuredClone`d input/context, independent try/catch, full reproducibility pins |
| `failure-classification.mjs` | `classifyOutcome` -- the ONE place that derives `outcome_category` (10 mutually-exclusive buckets, section D) from `runAgentFlow`'s own `ExecutionTrace.fallback_reason`/`think_trace.validation` |
| `scorers/*.mjs` | The 8 independent Grading Scorers (section C) -- each returns `{status, raw_score, error_codes, details}`, never a combined score |
| `scorers/index.mjs` | `scoreItem` -- orchestrates all 8, SKIPping every axis when `scoring_eligible=false`, computing `composite_score` only when an explicit `ScoringPolicy` is supplied |
| `report.mjs` | `summarizeRunResult` (per-variant aggregate) / `buildComparisonReport` (cross-variant) -- `ranking_performed`/`holdout_accessed`/`official_gold_accessed` are schema-`const`-locked to `false` this Turn |
| `interfaces/benchmark-item-result.schema.json` | One (item, variant) execution -- no raw prompt/response/API key/exception message, only ids/hashes/counts/enums/scoring axis outputs |
| `interfaces/benchmark-run-result.schema.json`, `interfaces/benchmark-comparison-report.schema.json` | Aggregate/cross-variant reports |
| `interfaces/scoring-policy.schema.json` | Optional, explicit weighting + unit-conversion table -- absent by default (axis-only output) |

## outcome_category (section D)

`NORMAL_ANSWER` / `NORMAL_INFORMATION_LIMIT` / `MODEL_NOT_ATTEMPTED_INFORMATION_LIMIT`
are the only categories eligible for `scoring_eligible=true` (still gated by
the Flow's own `scoring_eligible` claim). Every other category --
`MODEL_CALL_FAILURE_FALLBACK`, `POST_HOC_CLAIM_VALIDATION_FAILURE_FALLBACK`,
`AGENT_VARIANT_EXECUTION_FAILURE`, `TIMEOUT`, `ABORTED`, `BUDGET_EXCEEDED`,
`DATASET_CONTRACT_FAILURE` -- is always `scoring_eligible=false`, but is
still counted in `outcome_category_counts`/`ineligible_count` (never
dropped from failure-rate statistics, only excluded from axis mean/median).

## Running

```bash
npm run test:agent-comparison-benchmark-infra
npm run test:agent-comparison-benchmark-infra:real-bundle-smoke   # materializes the real, approved v0.20-r3 bundle read-only
```

No real network call is made anywhere in this Turn's tests -- only
`FAKE_DETERMINISTIC` ModelAdapter instances are used. Real Agent-quality
ranking over an official Gold split is out of scope until a separate,
later Turn.
