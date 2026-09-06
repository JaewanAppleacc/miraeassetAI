# FOURARM-A3-CONTRADICTION-GUARD-V1 — handoff

## Purpose and acceptance criteria

Implements a pure `ContradictionGuard` — `detectEvidenceContradictions({
questionConditions, evidenceFacts })` — that classifies a candidate evidence
item against a question's explicit dimension requirements as `PASS`,
`REJECT`, or `KEEP_UNKNOWN`, per `Turn A3-CONTRADICTION-GUARD-V1`. It exists
so a future A3 integrator has a Gold-blind, deterministic building block for
detecting *obvious* evidence contradictions (opposite scope, wrong fiscal
period, incompatible unit, wrong revision side, wrong company, wrong table
row/column) without over-rejecting evidence that is merely under-described.

This turn does **not** (per the task's explicit exclusions):
- open or read `A.results.jsonl` / `A.run.json`,
- run DEV_TUNE,
- open Gold or any existing critical packet,
- perform any real candidate removal,
- compute an A3 score,
- wire this into QA,
- declare a winner.

Everything below is exercised only against hand-authored synthetic
fixtures inline in the test file. No real packet ID, company name, or Gold
string appears anywhere in the implementation or tests — verified by a
source-scan test (see "Tests run").

## Source / branch

- Base branch: `codex/fourarm-a2-integration-v01`
- Base SHA: `900d3cc72336a1aece86ec776d84f55ec3564cc8` (verified via
  `git rev-parse HEAD` immediately after creating the new worktree)
- New worktree: `agent-fourarm-a3-contradiction-guard-v01`
  (`/Users/jaewan/Documents/Codex/worktrees/agent-fourarm-a3-contradiction-guard-v01`)
- New branch: `codex/fourarm-a3-contradiction-guard-v01`
- The A+QA and Oracle Audit worktrees were not opened, read, or modified.

## Files added

- `domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs`
  — the guard. Zero imports (fully self-contained; does not import
  `a2-evidence-scope-validator.mjs`, `a2-stable-evidence-filter.mjs`, or
  anything else — verified by a test that asserts no `import` statement
  appears in the file).
- `domain/agent-comparison/four-arm-ac/results/A3_CONTRADICTION_GUARD_V1_CONTRACT.md`
  — input/output schema and per-dimension rules.
- `tests/four-arm-a3-contradiction-guard.test.mjs` — 29 synthetic tests
  covering every dimension's `REJECT`/`PASS`/`KEEP_UNKNOWN` path, the
  multi-dimension REJECT-wins-over-KEEP_UNKNOWN priority rule, purity
  (input non-mutation), determinism (byte-identical repeat output), input
  validation, and a source-scan for forbidden real packet IDs / Gold field
  names / network-call surface.
- `domain/agent-comparison/four-arm-ac/results/A3_CONTRADICTION_GUARD_V1_HANDOFF.md`
  — this file.

## Design summary

Six independent dimension checks (scope, period, unit, revision, entity,
row_column), each returning `{ status: PASS|REJECT|KEEP_UNKNOWN, expected,
observed, reason? }`. `detectEvidenceContradictions` runs all six against a
single merged view of `evidenceFacts` (no merge of multiple evidence
sources — this module takes one evidence item's facts directly, unlike A2's
`retrievalItem`/`expandedEvidence` two-source merge, since the task's
contract names a single `evidenceFacts` argument) and aggregates: any
`REJECT` → overall `REJECT`; else any `KEEP_UNKNOWN` → overall
`KEEP_UNKNOWN`; else `PASS`. See
`results/A3_CONTRADICTION_GUARD_V1_CONTRACT.md` for the full per-dimension
rules, including the new **revision** dimension (`정정 전`/`정정 후`
markers) and the **entity alias** rule (a different company-name string is
only ever treated as the same entity when it is listed in the question's
own `approved_aliases`, never inferred).

The **unit** dimension differs from a naive "different unit string →
unresolved" treatment in two ways required by the task:
1. Same currency family, different denomination (`원`/`천원`/`백만원`/
   `억원`) → `PASS` with a recorded deterministic `conversion` factor,
   never `REJECT` — an exact conversion is not a contradiction.
2. A currency unit required against an observed `%` or `주` (a different,
   non-convertible unit family) → `REJECT`, not `KEEP_UNKNOWN` — the task
   requires "단위 차이로 값이 호환되지 않음 → REJECT" as a distinct case
   from an unparseable/absent unit hint (which is `KEEP_UNKNOWN`).

The **period** dimension resolves a bare `"YYYY년"` label (no quarter/half
marker) to the full fiscal year (months 1–12), and resolves a quarter named
without an explicit 누적/3개월 qualifier to `null` (undetermined) on
principle — this is a fresh, independent implementation of the same
universal accounting facts A2's validator also used (quarter-end months,
half-year ranges), not a reuse of A2's code or of its UNRESOLVED-implies-
removal policy. This module never removes anything; it only classifies.

## Tests run

```
node --test tests/four-arm-a3-contradiction-guard.test.mjs
# 29 pass, 0 fail
npm run schema:validate
# {"status":"PASS","validated_pairs":36}
npx tsc --noEmit
# no output (clean)
git diff --check
# clean
```

`node_modules` in this fresh worktree was populated by symlinking (not
copying — per the project's node_modules-sync constraint against `cp -r`
breaking `.bin` symlinks on macOS) from the sibling worktree
`agent-fourarm-a2-integration-v01`, whose `package-lock.json` SHA-256
(`a7e15b2baec88ca5ed1a1f4e0469cd7068b62ed9643a0ee1773b665d276b29b0`) was
confirmed identical before symlinking.

`npm run test:domain` (the full ~150-file suite) was not run this turn —
the new test file is intentionally not wired into that script's file list,
since this standalone module is not yet consumed by anything in that
script's scope. A future integration turn should add it to the list once
this guard is actually wired into a pipeline.

## Contract / schema changes

None. This is a new, additive, standalone module. It does not modify any
existing schema, interface, A/B/C/D result/run file, the A2 scope
validator, or the frozen scorer.

## Known limits / open blockers for the next integrator

- **Not wired into any pipeline.** This turn delivers the pure
  classification primitive only. Applying it over real A candidates (in
  whatever form a future A3 turn defines — e.g. alongside or after the A2
  scope validator) is separate work, and per this task's own scope
  restrictions must not begin until that future turn explicitly
  pre-registers its approach before opening `A.results.jsonl` or Gold.
- **`KEEP_UNKNOWN` must not become an implicit removal signal.** The
  contract doc calls this out explicitly: any integrator that drops
  `KEEP_UNKNOWN` candidates from a result set is making a new policy
  decision outside this module, and that decision needs its own
  justification and, per the project's general evaluation-lifecycle
  norms, measurement before being adopted.
- **Unit-family classification is intentionally narrow.** Only `원` family,
  `%`, and `주` are recognized; any other unit phrasing (e.g. `배`, `bp`,
  `건`) currently resolves to `KEEP_UNKNOWN` rather than a third family —
  extending the family table is straightforward but out of this turn's
  scope (the task's dimension list only names 원/천원/백만원/억원/주/%).
  The `%` marker check on raw text is a single-character-class regex and
  can theoretically over-match inside an unrelated string that happens to
  contain a bare `%` sign; no false positive was observed in testing but
  this is the same category of narrowness A2's handoff already flagged for
  its own `%`-based check.
- **Entity/row-column normalization is whitespace/punctuation-insensitive
  only**, not a semantic synonym matcher — e.g. "당기순이익" vs "당기 순이익"
  match, but "당기순이익" vs "순이익" do not (by design: a required label
  must actually appear, not merely overlap).

## Artifacts

- Implementation/test/doc commit: see the commit immediately following this
  handoff in `git log` on `codex/fourarm-a3-contradiction-guard-v01`.
