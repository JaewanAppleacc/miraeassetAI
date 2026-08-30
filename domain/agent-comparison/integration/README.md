# Agent Comparison Integration (Turn P3)

Wires the four independently-implemented, independently-tested Agent
variants (`STRUCTURED_FIRST`, `HYBRID_RETRIEVAL`, `PLANNER`,
`DOCUMENT_FIRST_RAG`) into ONE registry and ONE comparison harness that
runs identical input through all four in isolation. This Turn does not
decide which Agent design is "best" -- it only proves the common contract
(same `ModelConfig`, same release pin, same question/corp_code/budget)
executes safely and reproducibly across all four, and produces one
`ComparisonRecord` per variant with no raw text, no cross-variant state
leakage, and honest failure reporting.

## Why the four variants differ, precisely (do not flatten these into "RAG")

- **STRUCTURED_FIRST**: corp_code/metric_code conditions -> Structured
  Store Fact query -> Evidence-validate. No retrieval, ever.
- **HYBRID_RETRIEVAL**: identical Fact-first path. Retrieval is invoked
  **only** when a Fact was found but its own declared evidence_ids failed
  to validate (a grounding *gap*, not an absence of Facts) -- when the
  Structured Store returns nothing at all, this variant reports the same
  information limit STRUCTURED_FIRST would, it never substitutes retrieval
  for a missing Fact.
- **PLANNER**: decomposes a question into several independent, bounded
  Structured Store sub-requests (steps). An **opt-in only**
  (`input.hints.enable_retrieval_fallback`) retrieval attempt for an
  unsatisfied DOCUMENT-kind step is recorded purely as an informational
  note (`retrievalNotes`) -- it is never merged into `groundedFacts` and
  never grounds an answer.
- **DOCUMENT_FIRST_RAG**: the only variant that starts from
  `services.retriever.retrieve()`. A retrieval hit is a **candidate
  document_id only** -- it is never citable on its own. The Structured
  Store and `services.validator.validateEvidence` must independently
  cross-confirm a Fact/Evidence tied to that document_id before anything
  is grounded.

All four share the exact same post-generation grounding boundary
(`flows/hard-claim-grounding.mjs`'s `verifyGeneratedAnswer`) and the exact
same telemetry contract (`telemetry.mjs`'s `buildTelemetryEvent`) -- this
Turn changed none of that; it only confirmed (see the test suite) that all
four actually use it identically.

## What's here

| File | Role |
|---|---|
| `register-all-variants.mjs` | Side-effect import of all four `register-*.mjs` files -- the ONE place that guarantees all four are in the registry |
| `variant-revisions.mjs` | `agent_variant_revision` = the git blob hash of a variant's own flow file at a ref |
| `release-pin.mjs` | `release_id` + `release_manifest_sha256` (sha256 of the real v0.20-r3 `bundle-manifest.json` bytes), read-only |
| `determinism.mjs` | `answer_sha256`/`execution_trace_sha256` -- strips volatile timing keys before hashing so identical input always hashes identically |
| `contracts.mjs` | Ajv validator for `interfaces/comparison-record.schema.json` (self-contained, does not touch the root `contracts.mjs`) |
| `comparison-record.mjs` | Projects an existing `TelemetryEvent` (unmodified) + the pins above into a schema-valid `ComparisonRecord` |
| `four-variant-comparison.mjs` | `runFourVariantComparison(...)` -- the orchestrator: fresh instrumented ModelAdapter + fresh Flow instance per variant, sequential execution, per-variant try/catch |
| `interfaces/comparison-record.schema.json` | The 23-field record schema (see below) |

## ComparisonRecord: what it stores and what it deliberately never stores

Every field listed in the Turn P3 brief is present:
`benchmark_run_id`, `agent_variant_id`, `agent_variant_revision`,
`model_config_sha256`, `dataset_item_id`, `release_id`,
`release_manifest_sha256`, `execution_mode`, `structured_query_count`,
`document_retrieval_count`, `model_call_attempt_count`,
`model_call_success_count`, `model_call_failure_count`,
`model_fallback_used`, `model_failure_code`, `citation_binding_status`,
`unsupported_claim_count`, `evidence_validation_success_rate`,
`scoring_eligible`, `latency_ms`, `answer_sha256`,
`execution_trace_sha256`, `run_status`.

- **`latency_ms` is observational only.** It is excluded from
  `execution_trace_sha256`'s hashed input (`determinism.mjs` strips every
  `latency_ms`/`started_at` key recursively before hashing) -- two runs of
  the same variant over the same input hash identically even though real
  wall-clock latency differs.
- **No raw answer text, no raw `ExecutionTrace`, no raw prompt, no raw
  model response, no API key, no internal exception message is ever
  stored.** Only `answer_sha256`/`execution_trace_sha256` (content hashes)
  and `model_failure_code` (a stable code, never `Error.message`).
- **`run_status: "FAILED"`** means the harness itself could not obtain a
  `FinalResponse` for that variant at all (unregistered variant, or the
  variant's own factory threw before `runAgentFlow` could even run) --
  every count field is `0`/`null`/`false` in that case, `scoring_eligible`
  is always `false`, and the real exception is never surfaced (only a
  stable code, defaulting to `AGENT_VARIANT_EXECUTION_ERROR`). This is
  distinct from a variant's own internal information-limit/fallback
  answer, which is a normal `run_status: "OK"` record (`runAgentFlow`
  itself is designed to never throw -- see
  `domain/runtime/agent-runtime.mjs`).

## Scoring boundary

**No quality score or ranking is computed anywhere in this Turn.** Any
future scorer reading these records **must** exclude every row with
`scoring_eligible: false` (a fallback-substituted or failed run) from a
model/Agent-quality comparison; such rows remain valid for a
structured-retrieval/grounding regression check, never for quality
ranking.

## Running

```bash
npm run test:agent-comparison-integration
npm run test:agent-comparison-integration:real-bundle-smoke   # materializes the real, approved v0.20-r3 bundle read-only
npm run agent-comparison:four-variant-smoke                    # CLI: all four variants over one broadly-sampled real Fact, FAKE_DETERMINISTIC only
```

No real network call is made anywhere in this Turn's tests/scripts -- only
`FAKE_DETERMINISTIC` ModelAdapter instances are used. Comparing real model
performance is explicitly out of scope until a Gold split is finalized in
a separate Turn (see `domain/agent-comparison/COMPARISON_PLAN.md`).
