# HYBRID_RETRIEVAL Agent variant (Turn P2-H)

Implementation: `domain/agent-comparison/flows/hybrid-retrieval-agent.mjs`
Registration: `domain/agent-comparison/register-hybrid-retrieval-variant.mjs`
Tests: `tests/agent-comparison-hybrid-retrieval.test.mjs`

This variant reuses the same frozen `AgentFlow`/`SharedServices`/`runAgentFlow`
contract every other variant uses (see `IMPLEMENTATION_GUIDE.md`). It differs
from `STRUCTURED_FIRST` in one respect: when the VERIFIED Structured Store
already grounds every returned Fact, the Retriever is never called; when it
does not (a Fact was found, but its own declared `evidence_id` never
validated structurally), exactly one `services.retriever.retrieve()` call is
made to try to recover that missing citation text, scoped to that Fact's own
`source_document_id`/`corp_code` -- never a free-form search.

## Sufficiency decision (deterministic, step 4)

`ungroundedCount === 0` after the structured Fact/Evidence pass -> sufficient,
Retriever never called. Otherwise, every ungrounded Fact that itself declares
at least one `evidence_id` is a candidate for retrieval-backed recovery.

## Why Retrieval never replaces structured lookup

A retrieved chunk is only ever adopted as Evidence for a Fact's **own already
-declared** `evidence_id` -- never a new, invented id. If the Structured Store
returns no Fact at all, there is no `evidence_id` anchor to recover against,
so Retrieval is not attempted either (same `NOT_FOUND`/`QUERY_FAILED`
information-limit path `STRUCTURED_FIRST` already uses). This keeps the
Retriever strictly a supplement to structured lookup, never a substitute for
it, per this Turn's brief.

## Fail-closed on conflict

A recovered chunk is validated through the exact same
`services.validator.validateEvidence` boundary the structured path uses. A
chunk that disagrees with the trusted EvidenceStore record for that
`evidence_id` (`EVIDENCE_QUOTE_MISMATCH`/`EVIDENCE_HASH_MISMATCH`/
`EVIDENCE_DOCUMENT_MISMATCH`/`EVIDENCE_LOCATOR_MISMATCH`) is rejected the same
way an unverifiable one is -- never merged in, never guessed at. The
distinction is recorded as a `conflict` flag on the `VALIDATE_RETRIEVED_
EVIDENCE` operations-trace entry (informational only, never a scoring field).

## Why `hard-claim-grounding.mjs` needed no extension

`IMPLEMENTATION_GUIDE.md` suggests extending the allowed-source-text builder
to also cover raw retrieved snippets. This variant does not need that: a
retrieved chunk is only ever added to `groundedFacts` once it has **passed**
`validateEvidence`, at which point it already has the identical `{ fact,
quotes, evidenceIds }` shape a structured-sourced grounded entry has --
`hard-claim-grounding.mjs`'s existing `buildAllowedSourceText` already walks
every entry's `quotes` regardless of which store the quote came from. An
unvalidated snippet is never added to `groundedFacts` at all, so it is
correctly excluded from the model's allowed source text too, using the
existing generic module completely unmodified.

## execution_mode

- `STRUCTURED`: final grounded set is sourced entirely from the Structured
  Store (whether because it was already sufficient, or a Retriever attempt
  contributed nothing usable).
- `BOTH`: at least one grounded entry's evidence was recovered via a
  validated Retriever chunk.
- `EARLY_EXIT`: nothing could be grounded from either source (an honest
  information-limit exit, including a Retriever adapter failure -- see
  `RETRIEVAL_FAILED` below).
- `RETRIEVAL` (alone) is never produced -- this variant has no code path that
  grounds an answer from retrieval evidence without an already-authorized
  Fact.

## Retriever failure accounting

A Retriever-boundary failure (`RETRIEVER_UNAVAILABLE`/`RETRIEVER_ADAPTER_
ERROR`/etc.) is caught and recorded as its own `RETRIEVE` operation with
`ok:false`; if nothing else was grounded, the information-limit reason is the
distinct `RETRIEVAL_FAILED` (never collapsed into `NOT_FOUND`). A
`BudgetExceededError`/`RequestAbortedError` from the same call is rethrown
untouched so `runAgentFlow`'s own generic budget/abort handling applies, same
as any other `SharedServices` call.
