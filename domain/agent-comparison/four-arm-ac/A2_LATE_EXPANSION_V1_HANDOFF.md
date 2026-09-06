# FOURARM-A2-NODE-GROUNDED-EXPANSION-V1 — handoff

## Purpose and acceptance criteria

Implements an A2 postprocessor that expands the frozen arm A top-20 result
set into node-grounded evidence using only already-persisted provenance
(never a new BM25/dense/RRF search), then applies a stable PASS/REJECT/
UNRESOLVED refill over the existing rank order to produce a validated
final top-k.

This turn does **not**:
- run a real DEV_TUNE execution or make a winner determination,
- call KURE, BM25, dense search, or RRF (verified by source-scan test),
- mutate any DB, index, or the frozen scorer,
- read Gold/DEV_CHECK/HOLDOUT content,
- push force/amend/rebase or open a PR.

Everything is exercised only against synthetic fixtures constructed with
the repository's own `buildProvenanceSet` (`locator-provenance.mjs`).

## Source / branch

- Base branch: `codex/fourarm-alternate-node-review-integration-v01`
- Base SHA: `622759a39681f96d00d103eca53d07276b705a29`
- New worktree: `agent-fourarm-a2-late-expansion-v01`
- New branch: `codex/fourarm-a2-late-expansion-v01`

Required reading honored:
- `CLAUDE.md`
- `domain/agent-comparison/four-arm-ac/results/ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md`
- `domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs`
- `domain/agent-comparison/four-arm-ac/locator-provenance.mjs`
- `domain/agent-comparison/four-arm-ac/AC_LOCATOR_READY_REPORT.md`
- `domain/agent-comparison/four-arm-ac/results/UNRESOLVED_AUDIT_V1.md`
- `domain/agent-comparison/four-arm-ac/config.A.json`, `config.C.json`

## Files added

Implementation (`domain/agent-comparison/four-arm-ac/`):

- `a2-node-grounded-evidence.mjs` — `buildNodeGroundedEvidence({
  retrievalItem, fetchNode, limits })`. Candidate node indices are read
  ONLY from `retrievalItem.provenance.candidates` (falling back to
  `node_index`/`node_indices` only when no provenance sidecar is present at
  all) — never an adjacent/neighboring node. `fetchNode` is a caller-
  injected, read-only dependency this module never implements or wires to a
  database; its expected contract is documented in the module header. A
  chunk with `provenance.unresolved` (no persisted spans) or zero gathered
  candidates returns `UNRESOLVED` without ever calling `fetchNode`. Each
  candidate node is fetched once (row/col-agnostic, full-node) and, when it
  is a table, its minimal context (title/period/unit/row/col labels) is
  rendered from only the fields `fetchNode` actually returned — nothing is
  fabricated. Header/dimension lines are never partially truncated: either
  they fit inside `maxSingleNodeChars`/the remaining `maxExpandedChars`
  budget, or the node is marked `UNRESOLVED` (`REQUIRED_TABLE_DIMENSION_TRUNCATED`)
  rather than silently degraded. Any single node-fetch failure or identity
  mismatch (returned `documentId`/`nodeIndex` not matching the request)
  forces the whole result to `UNRESOLVED` (`NODE_FETCH_FAILED`), fail-closed.
  Every per-candidate `source_locator` is preserved independently in
  `locatorCandidates` (never merged into one string).
- `a2-stable-evidence-filter.mjs` — `applyStableEvidenceFilter({
  frozenTop20, validationResults, finalK })`. Walks `frozenTop20` exactly
  once, in its existing order; PASS accepts, REJECT removes (skipped,
  refill continues from the next existing-rank item), UNRESOLVED excludes
  and is recorded separately (never adopted). A `frozenTop20` item with no
  matching `validationResults` entry defaults to `UNRESOLVED`
  (`NO_VALIDATION_RESULT`), not silent PASS. `finalTopK` is exactly the
  first `finalK` accepted items in their original order — no re-scoring, no
  re-sorting, no tie-break change; a `validationResults` entry for a
  `chunk_id` outside `frozenTop20` can structurally never reach `finalTopK`
  (only `frozenTop20`'s own items are ever read). A shortfall
  (`finalTopK.length < finalK`) is reported via `finalTopKShortfall`, never
  silently padded.

Test (`tests/`):

- `four-arm-a2-late-expansion.test.mjs` — 26 offline tests covering every
  item in Section E: multi-node locator preservation, invalid doc/node
  fail-closed, max-candidate-node and max-char limits actually enforced,
  table title/period/unit/row/col preservation (and no-fabrication), a
  required-dimension truncation forcing `UNRESOLVED`, partial node-fetch
  failure forcing `UNRESOLVED`, `EMPTY_SPANS_INVALID` short-circuiting
  before any `fetchNode` call, `node_index`/`node_indices` fallback, PASS/
  REJECT/UNRESOLVED stable refill (including out-of-order validation input
  and a validation entry for a chunk outside top-20), unfilled-`finalK`
  shortfall reporting, no-mutation-of-inputs, no new score fields, and
  source-scan tests asserting zero BM25/dense/RRF/embedding references and
  zero DB/network/filesystem writes in both new modules.

## Contract limits (Section B) — no conflict found, not changed

`DEFAULT_LIMITS = { maxCandidateNodes: 8, maxExpandedChars: 12000,
maxSingleNodeChars: 6000 }`, matching the task's pre-fixed values exactly.
Cross-checked against `config.A.json`/`config.C.json`'s own
`retrieval_output_k: 20`, `primary_evaluation_k: 10`,
`reported_cutoffs: [5, 10, 20]` — identical, no `BLOCKED_CONTRACT`.

## Invariance (Section D)

`git status --short` before committing showed only the 3 new files listed
above (`a2-node-grounded-evidence.mjs`, `a2-stable-evidence-filter.mjs`,
`four-arm-a2-late-expansion.test.mjs`) as untracked — no existing file
(any `A.results.jsonl`/`A.run.json`, B/C/D results/run, frozen scorer,
KURE vectors/index, BM25 index) was modified, so their SHAs are trivially
identical before and after this turn. `node_modules` is a local, gitignored
symlink added for tooling only (`npm run schema:validate` / `tsc`), never
committed.

## Tests run

- `node --test tests/four-arm-a2-late-expansion.test.mjs`: 26/26 passing.
- `node --test tests/four-arm-fixed-ac.test.mjs`: 52/52 passing (pre-
  existing suite, confirmed unaffected).
- `npm run schema:validate`: `{"status":"PASS","validated_pairs":36}`.
- `npx tsc --noEmit`: clean (no output).
- `git diff --check`: clean.
- `npm run test:domain` / `npm run verify:contracts`: not run this turn —
  out of scope for a two-file additive change with its own scoped test
  file, consistent with prior four-arm-ac Turns' own scoped-test practice
  (e.g. `AC_LOCATOR_READY_REPORT.md`'s own "Scoped test results" section).

## Contract / schema changes

None. No `domain/interfaces` schema, migration, or frozen scorer file was
touched. Both new modules are purely additive application-layer code under
`domain/agent-comparison/four-arm-ac/`.

## Known limitations / open items

- `fetchNode`'s contract (documented in `a2-node-grounded-evidence.mjs`'s
  header) is a superset of the existing `arm-retriever-adapter.mjs`
  `fetch_node()` (identity-verification only, `node_text_available` always
  `false`) — it assumes a caller-supplied, real node-content source (per
  `UNRESOLVED_AUDIT_V1.md` section D's own note that a NodeStore-backed
  `fetch_node` "can supply the exact node text with zero new retrieval
  calls"). Building or wiring that concrete `fetchNode` implementation is
  explicitly out of this turn's scope (Section A treats it as an injected
  parameter); this handoff surfaces the assumption rather than silently
  guessing at it.
- No real DEV_TUNE/DEV_CHECK execution, validator wiring, or winner
  determination was performed, per the task's own explicit instruction.
