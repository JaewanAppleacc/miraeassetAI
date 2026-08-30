# Implementation Guide: adding an Agent variant

This is for whoever implements `HYBRID_RETRIEVAL`, `PLANNER`, or
`DOCUMENT_FIRST_RAG` next. The three can be built in parallel by three
different workers -- each one only touches its own new file(s) plus one
new `register-*.mjs` file, never anyone else's.

## What already exists, reuse it as-is

- **AgentInput / FinalResponse / StructuredQuery / StructuredResult**
  (`CLAUDE.md` sections 2/4, `domain/interfaces/*.schema.json`) -- do not
  invent a parallel shape.
- **AgentFlow / SharedServices / `runAgentFlow`**
  (`domain/runtime/agent-runtime.mjs`) -- your variant is `{ id, run(input,
  context, services) }`, executed through the SAME unmodified
  `runAgentFlow` every other variant uses.
- **ModelAdapter** (`domain/agent-comparison/model-adapter.mjs`,
  `fake-model-adapter.mjs`) -- your variant's factory signature is
  `(modelAdapter, options?) -> AgentFlow`, same as
  `createStructuredFirstFlow`. Never call a specific provider by name
  inside your Flow; only call `modelAdapter.generate(...)`.
  **Turn P1.1 response contract:** `generate()` resolves to
  `{ text, used_fact_ids, used_evidence_ids, input_tokens, output_tokens,
  estimated_cost, finish_reason }`, or throws a `ModelCallError` with a
  stable `.code` (`MODEL_CALL_TIMEOUT`/`MODEL_CALL_HTTP_ERROR`/
  `MODEL_CALL_MALFORMED_RESPONSE`/`MODEL_CALL_UNKNOWN_ERROR`). Your Flow
  must catch that failure itself and decide what to do (see "Fallback
  accounting" below) -- `modelAdapter.generate()` never substitutes a
  fallback on your behalf.
- **Post-generation grounding** (`domain/agent-comparison/flows/hard-claim-grounding.mjs`)
  -- `verifyGeneratedAnswer({ text, usedFactIds, usedEvidenceIds,
  authorizedFactIds, validatedEvidenceIds, groundedFacts })` is generic and
  reusable by any variant that calls a ModelAdapter to generate free text.
  Use it (or a variant-appropriate equivalent with the same PASS/FAIL/
  NOT_CHECKED contract) rather than trusting a generated answer as-is.
- **Telemetry** (`domain/agent-comparison/telemetry.mjs`) -- you do not need
  to touch this file. `buildTelemetryEvent` already derives every field from
  (a) the `AgentOutcome` `runAgentFlow` returns, (b) your Flow's own
  `think_trace.validation` object (see below), and (c) the model-adapter
  usage snapshot `benchmark-runner.mjs` collects for you.
- **Benchmark runner / manifest** (`domain/agent-comparison/benchmark-runner.mjs`)
  -- you do not need to touch this file; it drives any registered variant
  identically, including the Turn P1.1 reproducibility pins.

## Fallback accounting: fields your Flow must set

`buildTelemetryEvent` reads four fields from your Flow's
`final_response.think_trace.validation` object (a free-form field
`final-response.schema.json` already allows -- see
`flows/structured-first-agent.mjs` for the exact pattern to copy):

- `citation_binding_status`: `"PASS"` (a model-generated answer was kept,
  fully verified), `"FAIL"` (a model-generated answer was discarded after
  verification), or `"NOT_CHECKED"` (no model-generated text existed to
  check -- either no model call was attempted, or the call itself failed).
- `unsupported_claim_count`: integer, only nonzero when
  `citation_binding_status === "FAIL"` because of a hard-claim rejection
  (as opposed to an id-level citation-binding rejection).
- `model_fallback_used`: `true` whenever your Flow returned a deterministic
  fallback answer instead of a genuine model-generated one, for ANY reason.
  `false` both for a genuine kept model answer AND for a legitimate
  zero-model-call information-limit answer -- `model_call_attempt_count`
  (derived automatically from `instrumentModelAdapter`, not something you
  set) is what distinguishes those two `false` cases downstream.
- `scoring_eligible`: if you omit this, `buildTelemetryEvent` defaults it to
  `!model_fallback_used` -- usually correct, so most variants do not need
  to set it explicitly. Only override it if your variant has a case where a
  fallback answer should still count toward scoring (rare; document why).

**Never let a fallback-substituted answer count as a model success.** This
is the single most important invariant Turn P1.1 added -- test it the same
way `tests/agent-comparison-structured-first-agent.test.mjs` does (a
citing-something-unauthorized case, an unsupported-hard-claim case, and a
model-call-failure case, each asserting `model_fallback_used`/
`scoring_eligible`/`citation_binding_status`).

## What you actually write

1. `domain/agent-comparison/flows/<your-variant>-agent.mjs` exporting
   `create<YourVariant>Flow(modelAdapter, options)`.
2. `domain/agent-comparison/register-<your-variant>-variant.mjs`:
   ```js
   import { createYourVariantFlow } from "./flows/your-variant-agent.mjs";
   import { registerAgentVariant } from "./variant-registry.mjs";
   registerAgentVariant("YOUR_VARIANT_ID", (modelAdapter, options) => createYourVariantFlow(modelAdapter, options));
   ```
   Import this file (instead of editing `register-default-variants.mjs`)
   wherever you run your variant.
3. Tests under `tests/agent-comparison-<your-variant>-agent.test.mjs`,
   built the same way `tests/agent-comparison-structured-first-agent.test.mjs`
   is: a synthetic fixture (see `tests/lib/agent-comparison-fixture.mjs` --
   extend it or add your own sibling fixture file; do not point a new test
   at real Seed data or Gold). Cover at minimum: a grounded PASS, an
   unauthorized-citation FAIL, an unsupported-hard-claim FAIL, and a model
   call failure -- the same four shapes `structured-first-agent.test.mjs`
   already covers.

## Hard rules that apply to every variant, not just `STRUCTURED_FIRST`

- **Never invent a value.** Only ever surface a value that came back from
  a `services.structuredStore.query()`/`services.retriever.retrieve()` call
  and, for anything you cite as evidence, only after
  `services.validator.validateEvidence()` actually succeeded for it. Then,
  for anything a ModelAdapter GENERATED (as opposed to a value you render
  yourself), also run it through post-generation grounding before trusting
  it -- see above.
- **`OFFICIAL` execution_scope / `VERIFIED`-only**, unless your variant's
  whole point is to compare `SANDBOX`/`CANDIDATE` behavior. Copy
  `STRUCTURED_FIRST`'s choice unless you have a specific, documented reason
  not to.
- **No company name / question_id / expected-answer literal anywhere in
  your Flow's code.** This codebase's own identity/join key for a company
  is `corp_code`, not a name string (`domain/README.md`) -- a "different
  company inserted" check is naturally expressed as a `corp_code`-shaped
  hard-claim/citation-binding rejection (see `hard-claim-grounding.mjs`'s
  own header comment), not a new Korean-name-matching NLP pass.
- **No new vector DB / embedding index.** Use `services.retriever`
  (`domain/runtime/retriever-store.mjs`), which is itself fail-closed with
  no adapter wired. If no real Retriever adapter exists yet, wire a
  synthetic one in your tests (same pattern as
  `tests/lib/agent-comparison-fixture.mjs`'s structuredStoreAdapter).
- **Do not read Gold, `HOLDOUT`, or `DEV_CHECK` data while building or unit-
  testing your variant.** Seed 25 may be used read-only for a wiring smoke
  run, but never to tune a rule, and never scored against expected answers.
  Prefer `tests/agent-comparison-real-bundle-smoke.test.mjs`'s pattern
  (query the real bundle broadly, no fixed question list) over depending on
  the git-untracked Seed 25 Gold file, so your variant's own smoke test
  runs in a clean worktree too.
- **Do not touch:** `domain/runtime/agent-runtime.mjs`,
  `domain/flows/thin-structured-flow.mjs`, anything under
  `domain/releases/`, `domain/postgres/`, or
  `domain/runtime/configured-seed-runtime.mjs`.

## Variant-specific starting notes

- **HYBRID_RETRIEVAL**: combine a `services.structuredStore.query()` pass
  with a `services.retriever.retrieve()` pass. `telemetry.mjs` already
  separately counts `structured_query_count` and `document_retrieval_count`
  -- this is the variant whose telemetry differs from `STRUCTURED_FIRST`'s
  (always `document_retrieval_count === 0`) most visibly. Post-generation
  grounding still applies to anything the model generates from retrieved
  document text, not just structured Fact data -- extend
  `hard-claim-grounding.mjs`'s allowed-source-text builder (or write a
  sibling function) to also include retrieved document snippets.
- **PLANNER**: keep every step inside ONE `runAgentFlow` call --
  `budget_limits.maxToolCalls`/`maxRetrievals`/`timeoutMs` already cap a
  runaway planning loop for you.
- **DOCUMENT_FIRST_RAG**: still route any Fact-grounded claim through
  `services.validator.validateFacts`/`validateEvidence` AND through
  post-generation grounding the same way `STRUCTURED_FIRST` does --
  "document-first" changes what is searched first, not whether a claim
  needs a validated proof and a grounding check before it is stated as
  fact.
