# Agent Comparison (Turn P1; hardened Turn P1.1)

Common experiment contract for comparing (1) different Agent designs and
(2) different base LLMs, one axis at a time, plus the first reference Agent
implementation, `STRUCTURED_FIRST`.

This module reuses the existing frozen contracts (`domain/runtime/
agent-runtime.mjs`'s `AgentFlow`/`SharedServices`/`runAgentFlow`,
`domain/interfaces/{final-response,structured-query,structured-result}.
schema.json`, the Coverage-authorized Fact boundary, the v0.20 portable
bundle, and the PostgreSQL read-only adapter) exactly as they exist today.
Nothing under `domain/runtime/`, `domain/flows/thin-structured-flow.mjs`,
`domain/postgres/`, or `domain/releases/` was modified to build this.

## Turn P1.1: what changed and why

Turn P1's telemetry had three real problems, all fixed this Turn:

1. **`citation_accuracy` was mislabeled.** It measured how often
   `services.validator.validateEvidence` issued a proof (a Runtime
   plumbing fact), not whether a citation was actually correct. It is
   **removed**. Its replacement, `evidence_validation_success_rate`, keeps
   the same computation but an honest name and an explicit warning in its
   schema description that it is not a citation-accuracy score. Real
   citation accuracy against Gold stays a separate, Gold-based scorer's
   job -- this module never claims to compute it.
2. **A model call failure was invisible.** `model_call_count` existed but
   said nothing about success vs. failure. Now `model_call_attempt_count`
   is incremented the instant a call starts, `model_call_success_count`/
   `model_call_failure_count` are recorded on settle (their sum always
   equals the attempt count -- enforced by
   `domain/agent-comparison/telemetry.mjs`'s `instrumentModelAdapter` and
   checked in tests), and every failure carries a stable
   `model_failure_code` (`MODEL_CALL_TIMEOUT` / `MODEL_CALL_HTTP_ERROR` /
   `MODEL_CALL_MALFORMED_RESPONSE` / `MODEL_CALL_UNKNOWN_ERROR` /
   `MODEL_ADAPTER_UNAVAILABLE`) -- see `model-adapter.mjs`'s
   `ModelCallError`. A failure is always rethrown to the caller, never
   silently swallowed inside the adapter.
3. **A fallback answer could look like a model success.** `STRUCTURED_FIRST`
   now records `model_fallback_used` and `scoring_eligible` on every run.
   `scoring_eligible` is `false` whenever a fallback answer was substituted
   for any reason -- the model call itself failing, or (new this Turn) the
   model's own generated answer failing **post-generation grounding**.

New this Turn: **post-generation grounding**
(`flows/hard-claim-grounding.mjs`). A model-generated answer is never
returned as-is. `ModelAdapter.generate()` now returns `{ text,
used_fact_ids, used_evidence_ids, ... }`; `STRUCTURED_FIRST` verifies (a)
every `used_fact_id`/`used_evidence_id` was actually authorized+validated
THIS request, and (b) every hard claim (number/date/document id) extracted
from the answer text is present in this request's own grounded data. A
failure of either check discards the whole generated answer and
substitutes the same deterministic, fully-grounded fallback renderer used
for a model-call failure -- distinguished by `citation_binding_status`
(`FAIL` for a rejected generated answer vs. `NOT_CHECKED` for a call that
never produced text at all) and `unsupported_claim_count`.

Also new: `BenchmarkRunManifest` reproducibility pins
(`agent_variant_revision`, `model_config_sha256`, `prompt_template_id`/
`_sha256`, `dataset_sha256`, `temperature`, `max_output_tokens`,
`determinism`, `cache_policy`, `code_revision`,
`fallback_scoring_policy`) -- see `reproducibility.mjs`. None of these
store raw prompt/response text; only hashes/ids of them.

## Protocol scope correction

`kind: "HTTP_CHAT_COMPLETIONS"` in `model-config.schema.json` is **one**
generic Chat-Completions-compatible protocol adapter -- it is **not** a
claim that every model provider is supported. It only works for a provider
whose endpoint accepts `{model, messages, max_tokens, temperature}` and
replies with `{choices:[{message:{content}, finish_reason}],
usage:{prompt_tokens, completion_tokens}}` where `content` is a JSON
string encoding `{answer, used_fact_ids, used_evidence_ids}`. A provider
with a materially different shape needs its **own** adapter kind added to
`MODEL_ADAPTER_KINDS` (`contracts.mjs`) and its own construction branch in
`model-adapter.mjs` -- provider differences are meant to be expressed as a
distinct adapter *capability*, never papered over inside this one generic
branch. **Before comparing models across providers, verify the target
provider actually speaks this protocol shape** (or that its own adapter
kind exists) -- this module does not probe or negotiate that itself. No
real network call is made anywhere in this Turn's tests/scripts.

## What's here

| File | Role |
|---|---|
| `contracts.mjs` | `AGENT_VARIANT_IDS`, `CITATION_BINDING_STATUSES`, `MODEL_CALL_ERROR_CODES`, schema validators |
| `interfaces/model-config.schema.json` | Provider/model identity, injected as config -- never hardcoded |
| `interfaces/telemetry-event.schema.json` | One measurement record per (question, variant, model) run (v0.2 -- see Turn P1.1 above) |
| `interfaces/benchmark-run-manifest.schema.json` | Pins everything held fixed for one benchmark run, including reproducibility hashes (v0.2) |
| `model-adapter.mjs` | `createModelAdapter(config)` -- fails closed with no API key, typed `ModelCallError`s, never leaks raw errors/keys |
| `fake-model-adapter.mjs` | `createDeterministicFakeModelAdapter()` -- offline, reproducible, can simulate a failure by throwing |
| `telemetry.mjs` | `instrumentModelAdapter`, `buildTelemetryEvent` -- derives the common measurement fields |
| `reproducibility.mjs` | Canonical-hash and code-revision helpers for the manifest pins |
| `variant-registry.mjs` | Generic `registerAgentVariant`/`getAgentVariantFactory` map |
| `register-default-variants.mjs` | Registers `STRUCTURED_FIRST` only (see `IMPLEMENTATION_GUIDE.md`) |
| `flows/question-analysis.mjs` | Step 1-2 of `STRUCTURED_FIRST`: question -> conditions |
| `flows/hard-claim-grounding.mjs` | Post-generation grounding: hard-claim extraction + citation-binding verification (Turn P1.1) |
| `flows/structured-first-agent.mjs` | The `STRUCTURED_FIRST` `AgentFlow` itself |
| `benchmark-runner.mjs` | `createBenchmarkRunManifest` + `runBenchmark`: drives any registered variant over a question list |
| `seed-bundle-harness.mjs` | Read-only: unpacks the real, already-approved v0.20-r3 bundle for a smoke run |
| `COMPARISON_PLAN.md` | The 8-step Agent x Model comparison plan and its `DEV_TUNE`/`DEV_CHECK`/`HOLDOUT` ordering |
| `IMPLEMENTATION_GUIDE.md` | For whoever builds `HYBRID_RETRIEVAL`/`PLANNER`/`DOCUMENT_FIRST_RAG` next |

## STRUCTURED_FIRST in one paragraph

Analyze the question into corp_codes/metric_codes/period/scope conditions
(never hardcoded -- see `flows/question-analysis.mjs`) -> query
`services.structuredStore` with `execution_scope: "OFFICIAL"`
(`verification_statuses: ["VERIFIED"]` only) -> pull each matched Fact's
Evidence/Event/Relation for enrichment -> validate every citation through
`services.validator.validateEvidence` before trusting it -> if at least one
Fact is grounded, ask the injected `ModelAdapter` for a structured
`{text, used_fact_ids, used_evidence_ids}` answer -> **verify the model's
own answer** (`hard-claim-grounding.mjs`) before trusting it at all -> keep
it only if every citation and hard claim checks out; otherwise discard it
wholesale and use a deterministic, fully-grounded fallback rendering -> if
nothing could be grounded in the first place, state the information limit
in Korean instead of ever calling the model.

## Running the tests

```bash
npm run test:agent-comparison                        # fully hermetic, no bundle/network I/O
npm run test:agent-comparison:real-bundle-smoke       # materializes the real, approved v0.20-r3 bundle read-only
```

## Seed 25 smoke run (optional, requires local `work/domain-seed/`)

```bash
npm run agent-comparison:seed25-smoke -- --out work/agent-comparison/seed25-smoke.jsonl
```

Requires `work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl` to
already exist locally -- the same precondition every existing Seed 25 E2E
test already has. That file is git-untracked local scratch data and is
never copied in by this script from another worktree. Seed 25 is used here
strictly under its documented `SMOKE_REGRESSION` role -- this script never
reads Gold, never scores an answer against expected text, and never tunes
a rule based on its output. `test:agent-comparison:real-bundle-smoke`
above covers the same "does this actually work against real approved
data" need without requiring that local scratch data.
