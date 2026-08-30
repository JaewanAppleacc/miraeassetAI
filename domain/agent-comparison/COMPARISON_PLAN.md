# Agent x Model Comparison Plan (Turn P1; telemetry semantics hardened Turn P1.1)

This is a plan document, not an execution log -- no run described here has
happened yet. It exists so the two comparison axes (Agent design, base LLM)
are varied **one at a time**, never both together, and so everyone agrees in
advance which split (`DEV_TUNE` / `DEV_CHECK` / `HOLDOUT`) a given run is
allowed to use before any run happens.

## Why two axes, not one combined sweep

CLAUDE.md's evaluation lifecycle (`DEV_TUNE` -> `DEV_CHECK` -> `HOLDOUT`)
exists to stop a team from tuning against the data that will later grade it.
The same discipline applies here to a second dimension: if Agent design and
base LLM are both changed between two runs, a score difference cannot be
attributed to either one. Every step below pins one axis while the other
varies, exactly like `domain/interfaces/experiment-run.schema.json` already
pins corpus/parser/chunking/index for retrieval experiments -- and, as of
Turn P1.1, `BenchmarkRunManifest` itself pins `agent_variant_revision`,
`model_config_sha256`, `prompt_template_sha256`, and `dataset_sha256` so a
later audit can confirm exactly what stayed fixed between two runs without
re-reading any raw prompt/response text.

## The 8 steps

1. **Same model, 4 Agent designs.** Fix ONE `model_config_id` (a
   `FAKE_DETERMINISTIC` config is enough for the wiring/regression pass this
   Turn already ran; a real model config is used once one is authorized).
   Run all four `AGENT_VARIANT_IDS` (`STRUCTURED_FIRST`, `HYBRID_RETRIEVAL`,
   `PLANNER`, `DOCUMENT_FIRST_RAG`) over the SAME question set and the SAME
   `budget_limits`. Only `agent_variant_id` (and `agent_variant_revision`)
   varies.
2. **Select the top 2 Agent designs** from step 1's telemetry (see "What
   'top' means" below). This selection happens on `DEV_TUNE` data only.
3. **Top 2 Agents x 3 base LLMs.** Fix the two variant ids selected in step
   2. Construct 3 `ModelConfig`s (distinct `provider`/`model`, each API-key
   gated per model-adapter.mjs, each protocol-capability-checked per the
   "Protocol scope correction" note below). Only `model_config_id`
   (and `model_config_sha256`) varies now; the Agent design is held fixed
   per arm.
4. **Total 6 combinations compared** (2 variants x 3 models). Every one of
   the 6 runs uses the same `corpus_snapshot_id`/`fact_coverage_snapshot_id`,
   the same `execution_scope`, and the same question set as steps 1-3.
5. **`DEV_TUNE`**: steps 1-4 all run here. This is the only split a rule,
   prompt, or Agent-selection decision may be adjusted against.
6. **`DEV_CHECK`**: a single, limited confirmation pass over the finalists
   from step 4, run without further rule changes in response to what it
   shows. If `DEV_CHECK` disagrees with `DEV_TUNE`'s ranking, that is a
   signal to distrust the `DEV_TUNE` result, not license to keep iterating
   against `DEV_CHECK` itself.
7. **`HOLDOUT`**: exactly once, after step 6, on whichever single combination
   (or short list) step 6 did not disqualify. A `HOLDOUT` result is never
   used to go back and adjust an Agent or a model choice -- if it fails, the
   right response is to restart the comparison at step 1 with a new
   hypothesis, not to re-run `HOLDOUT` again.
8. **Cost, latency, and accuracy are read together, not accuracy alone --
   and only over `scoring_eligible=true` rows.** Every telemetry event
   carries `latency_ms`, `estimated_cost`, `input_tokens`/`output_tokens`
   next to `validation_status`/`evidence_validation_success_rate`/
   `citation_binding_status` (see `interfaces/telemetry-event.schema.json`).
   Turn P1.1 adds `scoring_eligible`: any row with `model_fallback_used=true`
   (the model call failed, OR its generated answer failed post-generation
   grounding) is `scoring_eligible=false` and MUST be excluded from a
   model-quality comparison table -- a fallback answer reflects the
   fallback renderer's quality, not the configured model's. Such rows MAY
   still be used for a separate structured-retrieval/grounding regression
   check (they are not deleted, only excluded from *this* comparison).

## What "top" means (step 2)

Ranking is a judgment call for whoever runs the comparison, made from the
full telemetry table -- this plan does not hardcode a formula. At minimum,
compare per-variant aggregates, computed only over `scoring_eligible=true`
rows: `validation_status` distribution (fraction `SUPPORTED` vs
`UNANSWERABLE`/`WITHHELD`/`NOT_APPLICABLE`), `evidence_validation_success_rate`
(excluding `null` rows -- and remember this is a Runtime proof-issuance
rate, not a citation-accuracy score against Gold), `citation_binding_status`
PASS rate (a real check of the model's own generated claims), `latency_ms`,
and `estimated_cost`. Separately, the `model_fallback_used` rate itself
(over ALL rows, `scoring_eligible` or not) is a useful signal about how
often a variant/model combination needed to fall back at all -- a high
fallback rate is informative even though those rows are excluded from the
quality comparison itself.

## Scope this Turn actually delivered vs. this plan

Turn P1 built the common contract, the `STRUCTURED_FIRST` variant, and ran
ONLY synthetic-fixture + Seed-25-smoke passes (`SMOKE_REGRESSION`/
`SYNTHETIC_FIXTURE` dataset roles). Turn P1.1 hardened the telemetry
semantics, model-failure accounting, fallback/scoring-eligibility
boundary, post-generation grounding, and manifest reproducibility pins
described above -- still only synthetic-fixture and real-bundle smoke
passes, never `DEV_TUNE`/`DEV_CHECK`/`HOLDOUT`. Steps 1-7 above have not
been executed. See `domain/agent-comparison/IMPLEMENTATION_GUIDE.md` for
what a future worker needs to build before step 1 can run for real (the
three remaining Agent variants; at least one non-fake `ModelConfig` wired
to an authorized, capability-verified provider).
