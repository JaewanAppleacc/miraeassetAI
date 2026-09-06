# FOURARM-A2-INTEGRATION-AND-DEVTUNE-V1 — result

## Verdict

```
BLOCKED_CONTRACT
```

DEV_TUNE-101 was **not executed**. Per the pre-registered gate
(`A2_DEVTUNE_V1_AMENDMENT.md`, Section E of the task), the run only proceeds
if every one of `A2_INTEGRATION_CONTRACT_GREEN`, `REAL_FETCH_NODE_GREEN`,
`ZERO_NEW_RETRIEVAL_CALLS`, `ZERO_DB_WRITES`, `FROZEN_A_INPUT_SHA_MATCH`,
`ORIGINAL_RESULTS_INVARIANT`, `SCORER_SHA_MATCH` is green. `REAL_FETCH_NODE_GREEN`
fails, so the batch was not run, no A2 score exists, and DEV_CHECK/HOLDOUT
were not opened.

## Branch / SHAs

- Base branch: `codex/fourarm-alternate-node-review-integration-v01`
- Base SHA: `622759a39681f96d00d103eca53d07276b705a29`
- New worktree: `agent-fourarm-a2-integration-v01`
- New branch: `codex/fourarm-a2-integration-v01`
- Merged: `codex/fourarm-a2-scope-validator-v01` @
  `a96d4ee61f397cb336cdd58665400d1d272b2d11` (fast-forward), then
  `codex/fourarm-a2-late-expansion-v01` @
  `fedacd365913972a5513f425b1b58d47ef3ea592` (merge commit `c58caf2`) — both
  confirmed present and identical on `origin` and `demo-ai-festival` before
  merging. No merge conflicts.
- Amendment commit: `e7e15b1` —
  `A2_DEVTUNE_V1_AMENDMENT.md` only, committed before opening any new A2
  score or re-reading `A.results.jsonl`/Gold this turn.
- This result's own HEAD: `e7e15b1` plus the integration code/test commit
  that follows it in `git log` on this branch.

## Integration of the two prior turns

Both implementations merged cleanly (zero file conflicts):

- `a2-evidence-scope-validator.mjs` (Scope Validator turn)
- `a2-node-grounded-evidence.mjs`, `a2-stable-evidence-filter.mjs` (Late
  Expansion turn)

**A real interface gap was found and fixed** (Section D.1 of the task —
"두 구현을 merge 또는 cherry-pick하고 충돌 및 인터페이스 차이를 점검한다"):
the two modules were never composed together before this turn, and their
schemas do not match directly:

1. `buildNodeGroundedEvidence()`'s return shape has no flat `scope_hint`/
   `period`/`period_hint`/`unit`/`row_label`/`column_label`/`table_title`
   field — only per-node `expandedNodes[]`/`tableContext[]` arrays.
   `validateEvidenceDimensions()`'s `expandedEvidence` parameter requires
   exactly those flat fields. Fixed with a new bridge function,
   `mapExpandedEvidenceForValidator()` (in the new
   `a2-integration-pipeline.mjs`), that reads only already-fetched node
   content and only emits a flat value when it is unambiguous across every
   table node actually expanded for that evidence item — any genuine
   ambiguity (>1 distinct table, or a row/col index outside the returned
   label arrays) is left `null`, which the validator then treats as
   `UNRESOLVED`, never guessed.
2. Within that bridge, the validator's own `period` field expects an
   already-structured `{fiscal_year, start_month, end_month}` object (or
   `{label}`); a raw Korean phrase like fetchNode's `table.period` must go
   through the separate `period_hint` field or it silently fails to parse.
   Caught by this turn's own contract test (test 1/10 initially failed by
   writing to the wrong field) and fixed before proceeding.
3. Composed into one pipeline: `a2-integration-pipeline.mjs`
   (`evaluateFrozenItem`, `runA2OverFrozenTop20`) — expand -> bridge ->
   validate -> feed into `applyStableEvidenceFilter`. No new file changes
   the meaning of any of the three original modules.

**A second, larger interface gap was found and is reported, not silently
worked around:** `official/devtune101_conditions.v2.jsonl` (the only
existing per-question condition extraction over the real 101-item batch)
produces `{corps, doc_groups, year_months, years, wants_latest, ...}` —
there is no existing extractor producing the validator's required
`questionConditions = {scope, entity, period, unit, row_column}` shape.
A `corps[0]` -> `entity` and `year_months`/`years` -> `period` mapping is
straightforward and Gold-blind, but `scope` (연결/별도), `unit`, and
`row_column` are not extracted by anything upstream. Running the validator
over the real 101 questions as-is would only meaningfully exercise the
period and entity dimensions; `scope`/`unit`/`row_column` would trivially
`PASS` for every item (a null requirement always passes, by the validator's
own pre-registered design). Building a new Korean-text extractor for those
three dimensions is out of this turn's scope — it would itself be new,
unvalidated logic introduced right before a one-shot scored run, which the
amendment's spirit (fix everything before seeing results) argues against
doing casually. This is surfaced here as a real limitation of what A2 can
currently validate, not fixed by loosening or guessing.

## Section C — real fetchNode: not achievable in this environment

A new, read-only adapter was added: `a2-real-node-store-adapter.mjs`,
exporting `createRealNodeStoreFetchNode({ chunkStagingReader,
tableRowReader })` and the fail-closed default `createUnavailableFetchNode()`.
It does not modify `arm-retriever-adapter.mjs`'s existing `fetch_node()`.

**It cannot be wired to a live, populated NodeStore in this session**,
confirmed by direct inspection, not assumption:

- `db/index.ts` requires a Cloudflare D1 binding (`env.DB`) that is not
  present outside the deployed Worker runtime — unavailable here.
- The only local Postgres databases (`psql -l`) are `postgres`,
  `scratch_repro`, `template0/1`. `scratch_repro` has the full
  `disclosure_reference`-style schema (25 tables: `documents`, `sections`,
  `source_tables`, `chunks`, ...) but **zero rows in every table** — a
  schema-only scratch DB for integration tests, not a populated corpus.
  No `manifest.jsonl` or any DocumentIR/node-text snapshot file exists
  anywhere on disk in this session.
- This matches the prior AC-LOCATOR-READY turn's own documented finding in
  this exact repository: "no live DATABASE_URL/KURE server was available in
  this session, so no real-DB query was attempted."
- Independent of environment access: `locator-provenance.mjs`'s own header
  states node-local text is **not persisted separately from chunk-level
  `raw_text`** in the current loader for the general (>1-span, ~99% of
  chunks) case — so even a live, populated store could not answer "the
  exact text of this one node" for most nodes, only for the ~1% of chunks
  that reduce to a single span, or for table rows if a `source_tables`
  row-level reader is separately wired.

`a2-real-node-store-adapter.mjs` is written to be genuinely correct against
the real schema (`reference_fixed_kure_chunk_staging.source_spans` for
identity via the existing `verifyNodeIdentity()`, chunk `raw_text` only when
a chunk resolves to exactly one node, an optional table-row reader for
`source_tables.body_rows`/`header_rows`), and is exercised in this turn's
tests only against schema-faithful **mock** readers — never against live
data, because none exists here. Per the pre-registered amendment, its
fail-closed default (`createUnavailableFetchNode`) is what any run in this
environment would actually use: every lookup resolves `UNRESOLVED`.

**Gate result: `REAL_FETCH_NODE_GREEN = FAIL`.** This is the sole blocking
gate; Section E therefore requires `BLOCKED_CONTRACT`.

## Gate results

| Gate | Result | Basis |
|---|---|---|
| `A2_INTEGRATION_CONTRACT_GREEN` | PASS | 15/15 new integration contract tests pass (schema bridge, top-20 membership, stable subsequence, PASS-only refill, zero out-of-top-20 leakage, zero retrieval-call references, zero write-statement references, fail-closed identity mismatch, fetch-failure -> UNRESOLVED, independent per-dimension checks, byte-identical rerun, zero diff on frozen A/B/C/D/scorer files vs base) |
| `REAL_FETCH_NODE_GREEN` | **FAIL** | No live, populated NodeStore reachable in this session (see above) |
| `ZERO_NEW_RETRIEVAL_CALLS` | PASS | No `bm25`/`reciprocalRankFusion`/`embedQuery`/`searchDocumentChunksByVector`/`KURE`/`rrf(` reference in any new file's executable code (source-scan test) |
| `ZERO_DB_WRITES` | PASS | No `INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`/`CREATE TABLE`/`ALTER TABLE` in any new file's executable code (source-scan test); both injected readers are documented SELECT-only, and this turn never opened a real connection |
| `FROZEN_A_INPUT_SHA_MATCH` | PASS | `git diff --name-only 622759a -- .../results/A.results.jsonl .../results/A.run.json` = empty |
| `ORIGINAL_RESULTS_INVARIANT` | PASS | Same check extended to B/C/D result/run files (contract test 12) — empty diff |
| `SCORER_SHA_MATCH` | PASS | Same check extended to `scorer-patch-multinode-v1/{fourarm.patched.py,fourarm.patch.diff}` — empty diff |

## Execution counts (Section H)

- Questions processed by A2 this turn: **0** (batch not run; gate blocked)
- PASS / REJECT / UNRESOLVED evidence counts: N/A (not run)
- Stable-refill shortfall count: N/A (not run)
- Overall / HIGH / LOW metrics: N/A (not run) — no A2 score exists to
  compare against A's own recorded metrics
- Critical / minor / unresolved counts: N/A (not run)
- BM25 / dense / RRF / KURE calls made this turn: **0**
- DB write queries made this turn: **0** (no DB connection was ever opened)
- DEV_CHECK / HOLDOUT accessed: **no** (not opened, per Section G: "A2가
  통과하기 전에는 DEV_CHECK를 열거나 실행하지 않는다" — A2 did not pass)

## Tests / schema / typecheck

```
node --test tests/four-arm-a2-integration-contract.test.mjs   # 15 pass, 0 fail
node --test tests/four-arm-a2-scope-validator.test.mjs \
             tests/four-arm-a2-late-expansion.test.mjs \
             tests/four-arm-a2-integration-contract.test.mjs  # 64 pass, 0 fail
node --test tests/four-arm-fixed-ac.test.mjs                  # 52 pass, 0 fail (pre-existing suite, unaffected)
npm run schema:validate                                       # {"status":"PASS","validated_pairs":36}
npx tsc --noEmit                                               # clean (no output)
git diff --check                                               # clean
```

`node_modules` in this fresh worktree is a local, gitignored symlink (not
copied) to the sibling worktree `agent-fourarm-a2-scope-validator-v01`,
whose `package-lock.json` SHA-256 was confirmed identical first.

## What would need to change to re-attempt A2 (not done this turn)

1. A real, populated NodeStore reachable from wherever DEV_TUNE-101 is
   actually executed (a live D1 binding, or a Postgres instance with the
   `disclosure_reference.reference_fixed_kure_chunk_staging` /
   `source_tables` schema actually loaded with the real corpus) — this
   turn's `a2-real-node-store-adapter.mjs` is ready to be wired to one via
   its `chunkStagingReader`/`tableRowReader` parameters without further
   code changes.
2. A Gold-blind extractor producing `{scope, entity, period, unit,
   row_column}` per question from the real 101 questions (today only
   entity/period are derivable from `devtune101_conditions.v2.jsonl`).

Neither is a decision made in response to seeing any result — both are
named here as pre-conditions for a future attempt, per the amendment's own
"no threshold/rule/limit change after seeing results" freeze.
