# FOURARM-A2-SCOPE-VALIDATOR-V1 — handoff

## Purpose and acceptance criteria

Implements a general, Gold-blind **Evidence Scope Validator** that decides
whether an Arm A search result's consolidated/separate scope, period, unit/
sign, and row/column meaning conflict with what a question requires. This is
the first building block of A2 (`frozen A top-20 + scope validator + stable
refill`) — the pre-registered remediation candidate required after
`ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md`'s `NO_SELECTION_BLOCKED` verdict
(A's two critical failures were both consolidated/separate scope confusion).

This turn does **not**:
- read or execute against real A results (`A.results.jsonl`/`A.run.json`),
- read or use Gold values, Gold locators, or `acceptable_sources`,
- copy any real critical-packet content into a fixture,
- re-run retrieval, embedding, or ranking,
- perform any actual DEV_TUNE rescoring (0 executions — see below),
- modify any A/B/C/D result/run file,
- hardcode any packet/question/company ID or specific numeric value as a
  branch condition,
- access DEV_CHECK/HOLDOUT,
- touch production wiring.

Everything is exercised only against hand-authored synthetic fixtures inline
in the test file.

## Ordering honored (Section A pre-registration)

`results/A2_SCOPE_VALIDATOR_V1_AMENDMENT.md` was written and committed
(`6affa3f`) **before** opening `A.results.jsonl`, the alternate-node
sensitivity result/Gold, or any critical packet. Only after that commit were
the following opened, strictly for schema/convention alignment (not for
tuning the validator's rules to the actual critical packets):

- `CLAUDE.md`
- `results/ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md`
- `results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md` (prior turn's)
- `official/alternate-node-sensitivity-policy.v1.json`
- `locator-provenance.mjs`, `conditions-fixture.mjs`,
  `alternate-node-sensitivity-adjudication-adapter.v1.mjs` (existing
  conventions: source_locator/provenance shape, questionConditions shape,
  pure-function/`Object.freeze` style, `tests/four-arm-*.test.mjs` naming)

`ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md` names two critical packet IDs
(`u-47511cac6428`, `u-e4b7183bc619`) for A. Neither ID, nor any value from
that document, appears anywhere in the implementation or its tests — this is
asserted by a source-scan test (see below).

## Source / branch

- Base branch: `codex/fourarm-alternate-node-review-integration-v01`
- Base SHA: `622759a39681f96d00d103eca53d07276b705a29`
- Base remote: confirmed present and identical on both `origin` and
  `demo-ai-festival` (verified via `git ls-remote` before branching)
- New worktree: `agent-fourarm-a2-scope-validator-v01`
- New branch: `codex/fourarm-a2-scope-validator-v01`

## Files added

- `domain/agent-comparison/four-arm-ac/results/A2_SCOPE_VALIDATOR_V1_AMENDMENT.md`
  — Section A freeze, committed separately before any A results/Gold read.
- `domain/agent-comparison/four-arm-ac/a2-evidence-scope-validator.mjs` —
  the validator. Exports `validateEvidenceDimensions({ questionConditions,
  retrievalItem, expandedEvidence })`, plus `normalizePeriodLabel`,
  `VALIDATION_STATUS`, `REJECT_REASONS`, `SCOPE_VALIDATOR_VERSION`, and
  `ScopeValidatorInputError`. Zero imports from Gold, the scorer, DB, or an
  embedding server — verified by inspection (no `import` statements beyond
  none needed) and by a test that scans the file for `acceptable_sources`/
  `gold_evidence`/`gold_answer`-shaped field access.
- `tests/four-arm-a2-scope-validator.test.mjs` — 23 scoped tests (all
  synthetic fixtures, no real packet content).
- `domain/agent-comparison/four-arm-ac/results/A2_SCOPE_VALIDATOR_V1_HANDOFF.md`
  — this file.

## Design summary

Five independent dimension checks, each returning
`{ status: PASS|REJECT|UNRESOLVED, expected, observed, reason? }`:

- **scope** — detects `연결`/`별도`/`개별` markers in a `scope_hint` text
  field. Absence of a marker is `null` (undetermined), never inferred as the
  opposite scope. Both markers present → `AMBIGUOUS` (also treated as
  undetermined). Opposite marker present → immediate `REJECT`.
- **period** — normalizes a raw Korean period phrase (`"2024년 1분기 누적"`
  etc.) to a canonical `{fiscal_year, start_month, end_month}` range using
  fixed calendar-quarter/half/full-year month boundaries (a universal
  accounting fact applied uniformly, not a per-question or per-packet
  parameter). Q1's own quarter and its year-to-date cumulative are
  structurally identical, so `normalizePeriodLabel` resolves "1분기" the same
  way regardless of a 누적/3개월 qualifier; Q2–Q4 named without an explicit
  qualifier resolve to `null` (fail-closed, since disclosures routinely show
  both a 3-month and a cumulative column for those quarters). Equal ranges →
  `PASS`; differing ranges → `REJECT`; either side unresolvable → `UNRESOLVED`.
- **unit/sign** — recognizes `원`/`천원`/`백만원`/`십억원` denomination
  markers and converts between them via a fixed power-of-ten table (never by
  rounding or numeric-value similarity — the validator never compares actual
  values at all). A same-family denomination difference is `PASS` with a
  recorded `conversion` (`from_unit`, `to_unit`,
  `multiply_observed_value_by`); a required-sign conflict, or evidence
  explicitly marked as a non-currency unit (`%`) when a currency unit is
  required, is `REJECT`; an unparseable unit hint is `UNRESOLVED`.
- **row_column** — compares `table_title`/`row_label`/`column_label` against
  the question's required values after whitespace/punctuation-insensitive
  normalization (`NFKC` + collapse whitespace + strip common punctuation).
  Node identity is never used as a shortcut to PASS; only label meaning is
  compared, so a same-node evidence item with a different table/row/column
  meaning still `REJECT`s.
- **entity** — same normalized-label comparison, for a required company/
  entity name.

`validateEvidenceDimensions` merges `retrievalItem` and `expandedEvidence`
into one read-only evidence-context object (the latter overriding the
former field-by-field when present — the fetched/expanded node is more
authoritative than the raw retrieval-time hit), runs all five checks, and
aggregates: any `REJECT` makes the overall `status` `REJECT`; otherwise any
`UNRESOLVED` makes it `UNRESOLVED`; otherwise `PASS`. `reasons` collects
every contributing dimension's reason code (not just the one that decided
the overall status), deduplicated, drawn only from the fixed six-value enum
in Section B of the task.

## Tests run

```
node --test tests/four-arm-a2-scope-validator.test.mjs
# 23 pass, 0 fail
npm run schema:validate
# {"status":"PASS","validated_pairs":36}
npx tsc --noEmit
# no output (clean)
git diff --check --cached
# clean
```

`npm run test:domain` (the full ~150-file suite) was not run this turn — the
new test file is intentionally not wired into that script's file list, since
this module is not yet consumed by anything in `test:domain`'s scope. It can
be added to that list once A2 is wired into an actual pipeline (a future
turn).

`node_modules` in this fresh worktree was populated by symlinking (not
copying — see the `node_modules_sync_pitfall` constraint against `cp -r`
breaking `.bin` symlinks on macOS) from the sibling worktree
`agent-fourarm-alternate-node-harness-v01`, whose `package-lock.json` SHA-256
was confirmed identical before symlinking.

## Contract / schema changes

None. This is a new, additive, standalone module. It does not modify any
existing schema, interface, A/B/C/D result/run file, or the frozen scorer.

## Artifacts

- Amendment commit: `6affa3f` — `A2_SCOPE_VALIDATOR_V1_AMENDMENT.md` only.
- Implementation/test commit: see the commit immediately following this
  handoff in `git log` on `codex/fourarm-a2-scope-validator-v01`.

## Known limits / open blockers

- **Stable refill is not implemented.** This turn's scope (Section C of the
  task) is the pure validator only. Applying it over A's frozen top-20 and
  refilling rejected/unresolved slots deterministically is separate work for
  a future turn, and will itself need its own pre-registration before any
  actual A results are read for that purpose.
- **No actual DEV_TUNE execution occurred this turn: 0.** Confirmed by
  construction — every test input is a synthetic fixture, and the module has
  no code path that reads `A.results.jsonl`, a DB, or an embedding server.
- Q2–Q4 period labels without an explicit 누적/3개월 qualifier resolve to
  `UNRESOLVED` by design; if upstream question/evidence extraction can
  reliably disambiguate these (e.g. from adjacent column context), a future
  turn could pass an already-structured `{fiscal_year, start_month,
  end_month}` period object instead of a raw label to bypass the ambiguity,
  without changing this module's contract.
- The non-currency-unit conflict path (`%` marker) is intentionally narrow
  to avoid false positives from common Korean words; it is not a general
  unit-family classifier.
