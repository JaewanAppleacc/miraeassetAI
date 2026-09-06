# FOURARM-A4-WIDE-CANDIDATE-POOL-V1 — handoff

## Purpose and acceptance criteria

Implements `buildWideCandidatePool({ original_a_top20, bm25_top100,
dense_top100 })` per `Turn A4-WIDE-CANDIDATE-POOL-V1`: a pure,
deterministic union/dedup of arm A's existing official top-20, a BM25
top-100 leg, and a KURE dense top-100 leg into one A4 candidate pool,
keyed by `chunk_id`. It exists so a future A4 reranker turn has a wide,
lossless candidate set to work from — wider than A's own 20-candidate
cutoff — while still preserving, per candidate, exactly how it compares
under A's own original (narrow) ranking method versus the wider diagnostic
one.

This turn does **not** (per the task's explicit exclusions):
- implement a reranker,
- implement or touch the Contradiction Guard (`a3-evidence-contradiction-
  guard.mjs`, a separate prior turn's module — not referenced here),
- wire this into QA,
- perform any Gold scoring,
- modify arm A, arm C, or the A2 pipeline.

Everything below is exercised only against hand-authored synthetic
fixtures inline in the test file. No real packet ID, company name, or Gold
string appears anywhere in the implementation or tests — verified by a
source-scan test. This turn never opened Gold, DEV_TUNE, or any oracle
number; the only bytes of real existing artifacts this turn's tests touch
are SHA256 checksums of `A.results.jsonl`/`A.run.json`/`C.results.jsonl`/
`C.run.json`/`A2.results.jsonl`/`A2.run.json`/`score.A2.json`, used purely
to prove those files were not modified.

## Source / branch

- Source branch: `codex/fourarm-a3-ceiling-audit-v01`
- Source commit (remote `origin` HEAD, confirmed identical to local and to
  `demo-ai-festival`'s remote HEAD via `git ls-remote` before branching):
  `30210ba61292c0ea241ed840b7124c18363c0c14`
- New worktree: `agent-fourarm-a4-wide-pool-v01`
  (`/Users/jaewan/Documents/Codex/worktrees/agent-fourarm-a4-wide-pool-v01`)
- New branch: `codex/fourarm-a4-wide-pool-v01`
- The A, A2, A3, and A+QA worktrees were not opened, read, or modified.

## Files added

- `domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs` — the
  pool builder. Zero imports; zero I/O of any kind.
- `domain/agent-comparison/four-arm-ac/A4_WIDE_CANDIDATE_POOL_V1_CONTRACT.md`
  — input/output schema, the two-rank design, RRF formula, and merge/dedup
  rules.
- `tests/four-arm-a4-wide-candidate-pool.test.mjs` — 20 synthetic tests:
  A-top-20 completeness, BM25-only/dense-only inclusion, exact-one dedup
  of a candidate common to both legs, full source-rank preservation,
  `original_a_rank` reproduction (including for a candidate beyond A's
  actual cutoff), `wide_rrf_rank` divergence from `original_a_rank`,
  multi-node `node_indices` union, an exact-tie determinism case,
  input-array-order invariance, repeat-call determinism, three distinct
  fail-closed conflict/malformed-input cases, a source-scan for forbidden
  real identifiers and I/O call surface, and a SHA256 invariance check
  over the existing A/A2/C result and run files.
- `domain/agent-comparison/four-arm-ac/A4_WIDE_CANDIDATE_POOL_V1_HANDOFF.md`
  — this file.

## Design summary

Every input record carries its rank as an **explicit `rank` field**, never
implied by its position in the array. This is a deliberate departure from
the array-position convention `domain/agent-comparison/chunking-comparison
/rrf.mjs`'s `reciprocalRankFusion` uses internally (and which arm A's own
hybrid retriever adapter relies on) — it is what makes "shuffle the input
array order, get byte-identical output" a meaningful, testable property
for this module, rather than something that would silently change the
computed ranking. This module does not import `rrf.mjs`; it reimplements
the same one-line, standard formula (`1 / (RRF_CONSTANT + rank)`,
identical `k=60`) directly, so results are numerically identical to what
`rrf.mjs` would produce given the same rank/`k` inputs, while gaining the
explicit-rank, order-independent input contract this task's acceptance
tests require.

Two ranks are computed and both are preserved on every pool item that
reaches them (see the contract doc for the full rationale):
- `source_ranks.original_a` / `source_scores.original_a_rrf` — RRF over
  `bm25_top100` + `dense_top100`'s own rank`<=20` subset, reproducing A's
  actual formula. A **fail-closed reproduction check** verifies the given
  `original_a_top20`'s own order is exactly what this recomputation
  produces for its leading entries; a caller passing inconsistent
  bm25/dense legs for a given A top-20 gets a thrown
  `ORIGINAL_A_RRF_NOT_REPRODUCIBLE` error, not a silently-wrong pool.
- `source_ranks.wide_rrf` / `source_scores.wide_rrf` — RRF over
  `bm25_top100` + the FULL `dense_top100` (up to 100). Diagnostic only,
  per the task's own instruction never treated as a final ranking by this
  module or documented as one for any caller.

Dedup/merge: descriptive fields (`text`/`locator`/`provenance`/`metadata`)
merge by fixed priority (`original_a_top20` > `bm25_top100` >
`dense_top100`); `node_indices` merges by UNION across every occurrence
(never narrowed to whichever list happened to carry the fuller set);
`document_id`/`chunk_text_sha256` must agree exactly across every
occurrence of a `chunk_id` or the call throws (fail-closed on a genuine
identity conflict, distinct from the softer priority-merge used for
descriptive fields). Final pool order is `chunk_id` ascending (plain
codepoint comparison) — a fixed, arbitrary-but-explicit canonical order
that is not itself a ranking (rankings live in each item's own
`source_ranks`).

## Tests run

```
node --test tests/four-arm-a4-wide-candidate-pool.test.mjs
# 20 pass, 0 fail
npm run schema:validate
# {"status":"PASS","validated_pairs":36}
npx tsc --noEmit
# no output (clean)
git diff --check
# clean
git status --short
# only the two new files listed above (untracked); no existing tracked
# file modified
```

`node_modules` in this fresh worktree was populated by symlinking (not
copying — per the project's node_modules-sync constraint against `cp -r`
breaking `.bin` symlinks on macOS) from the sibling worktree
`agent-fourarm-a3-contradiction-guard-v01`, whose `package-lock.json`
SHA-256 (`a7e15b2baec88ca5ed1a1f4e0469cd7068b62ed9643a0ee1773b665d276b29b0`)
was confirmed identical before symlinking.

`npm run test:domain` (the full ~150-file suite) was not run this turn —
the new test file is intentionally not wired into that script's file
list, since this standalone module is not yet consumed by anything in
that script's scope. A future integration turn (the actual A4
reranker) should add it once this pool is wired into a real pipeline.

## Contract / schema changes

None. This is a new, additive, standalone module. It reads no existing
schema or interface, and modifies no existing A/B/C/D result/run file —
verified both by `git status --short` (no existing tracked file touched)
and by a SHA256 invariance test over the concrete files present on this
branch (`A.results.jsonl`, `A.run.json`, `C.results.jsonl`, `C.run.json`,
`A2.results.jsonl`, `A2.run.json`, `score.A2.json`). No `B.*`/`D.*` result
files exist in this worktree to guard.

## Known limits / open blockers for the next integrator

- **Not wired into any pipeline.** This turn delivers the pure pool
  builder only. A future A4 turn must supply real `original_a_top20`,
  `bm25_top100`, and `dense_top100` lists (each with an explicit `rank`
  field per candidate) — sourcing those from arm A's actual retrieval
  output is that future turn's own responsibility, and per this task's
  own scope restrictions must not begin by opening `A.results.jsonl` or
  Gold without its own explicit pre-registration first.
- **The reproduction check is intentionally strict.** If a future
  integration ever legitimately needs `original_a_top20` to reflect A's
  output under a *different* dense-leg policy than "top `rank<=20` of the
  same wide dense-100 list" (e.g. a metadata-filtered dense leg that isn't
  simply a prefix of the wide one), `ORIGINAL_A_RRF_NOT_REPRODUCIBLE` will
  fire on entirely valid input. That would be a genuine contract change
  (a new parameter for how the original-A dense subset is selected), not
  a bug in this module — it should be raised as a blocker rather than
  silently loosened.
- **Rank lists may be sparse (non-contiguous)** by design (see the
  contract doc) — this module does not itself verify that a caller's
  `bm25_top100`/`dense_top100` represents every candidate between rank 1
  and its highest given rank. A caller that wants that stronger guarantee
  needs its own check upstream of this module.
- **`locator`/`provenance`/`metadata` merge is priority-first-non-null,
  not a deep merge.** If two occurrences of the same `chunk_id` carry
  materially different (not just differently-complete) provenance
  objects, only the highest-priority one is kept in the `provenance`
  field itself — only `node_indices` is guaranteed to be the full union.
  A future integrator that needs the full provenance union too should
  treat that as a follow-up enhancement, not assume it already holds.

## Artifacts

- Implementation/test/doc commit: see the commit immediately following
  this handoff in `git log` on `codex/fourarm-a4-wide-pool-v01`.
