# Official 4-Arm DEV_TUNE-101 Scoring — Results Summary

Turn: `FOURARM-OFFICIAL-SCORING-V1`. Batch: `35b588e42086e728302c47f0b5d307b7`.
Frozen scorer commit: `50cc1aac57145ab7fdb825cbb054842cb993c395` (`ac_scorer_50cc1aa`),
re-verified byte-identical (`shasum -a 256 -c SHA256SUMS` 55/55 OK) before use.

**This supersedes the prior `BLOCKED_CONTRACT` report.** DEV_TUNE-101 Gold is
an allowed evaluation input for this pre-registered experiment (distinct
from DEV_CHECK/HOLDOUT, which remain untouched). Gold
(`dev-tune-gold.v0.1.jsonl`, SHA-256 `7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b`,
101 rows, 100% `split=DEV_TUNE`) was read only by the frozen scorer process
itself to compute aggregate metrics -- never opened, quoted, or logged by
this session, and never copied into a git-tracked path.

## What changed in A/C's own artifacts (format only, retrieval unmodified)

Real preflight (`scripts/fourarm/preflight_arm.py`) caught three schema
defects in the previous Turn's runner output, none of which touch what was
retrieved: an incompatible `locator` string syntax, a null `node_index` for
multi-node-ambiguous chunks (contract requires a primary index plus the
full set in `node_indices`), and a `run.json` missing the `config` object
interfaces.md section 1-3 requires (`config_sha256` must hash that embedded
object, not an external config file). Fixed by a pure reformatting pass
(zero new retrieval calls) — `A.results.jsonl`/`C.results.jsonl`
`results_sha256` changed accordingly; the underlying ranked chunk_id/
doc_id/node_index/score per question did not.

`peak_rss_mb` is `null` -- genuinely not measured by the original runner,
not estimated. This is flagged by the optional convenience
`preflight_arm.py` check but is not read anywhere in `score.py`'s actual
judgement path (verified by inspection).

## Real, verified DocumentIR index

The frozen scorer's `--final` mode unconditionally needs `data/index/`
(built from the full 4,204-document, ~8.5GB DocumentIR) to resolve
locators. All 4 DocumentIR files were located and independently verified
byte-exact against the pinned SHAs before use; the rebuilt
`doc_index.jsonl` hash (`c93c18f71ca18cf319e365793fde5e87a0bce470b8d275d65c3881a26d5f5f86`)
matches the README's own pinned value exactly, confirming this is the same
index B/D's own team used.

## Results (k=10 primary; Gold `7941144c…`; conditions `83d5b8a0…`)

| arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | critical | minor | unresolved | hard-safe |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.7692 | 0.8007 | 0.8217 | 0.784 | 0.9167 | 16/19 | 0 | 0 | 229 | **yes** |
| B (frozen) | 0.479 | 0.5874 | 0.6713 | 0.576 | 0.6667 | 11/19 | 2 | 0 | 15 | no |
| C | 0.7273 | 0.7552 | 0.8462 | 0.74 | 0.8611 | 15/19 | 0 | 0 | 216 | **yes** |
| D (frozen) | 0.486 | 0.5839 | 0.6678 | 0.576 | 0.6389 | 9/19 | 2 | 0 | 11 | no |

B and D reproduced **byte-identical** to their previously-frozen
`score.B.json`/`score.D.json` (`92a3b73...`/`186cf33c...`), confirming full
determinism -- neither B/D's results/run files nor the scorer were touched.

COMMON_SOURCE exclusion: 0 questions (limit 5) for every arm, before and
after adjudication -- unchanged from B/D's own prior run.

## Hard / quality gate chain

1. **Hard safety gate**: `critical=0` → A, C pass; `critical=2` (frozen,
   `u-1b6cd184a87f`/`u-8564414f6080`) → B, D fail. B/D's `HARD_GATE_FAILED`
   state is preserved exactly, not relaxed.
2. **Quality gate** (best ALL/HIGH Recall@10 among hard-safe arms): only
   **A** passes (`ALL=0.8007`, `HIGH=0.784` vs C's `ALL=0.7552`,
   `HIGH=0.74`).
3. **LOW all_found@10** among quality-gate passers: A=16/19 (only
   candidate remaining).
4. **Selection**: candidate **A**, `selection_type=PERFORMANCE_WINNER` —
   held, not finalized (see below).

## Final judgement: `PENDING_UNRESOLVED` → reported as `BLOCKED`

The frozen scorer's own `judgement.json.status` is `PENDING_UNRESOLVED`,
not one of `PROVISIONAL_WINNER`/`NO_SELECTION`. A and C each surface a
large number of **brand-new** UNRESOLVED packets (229 and 216
respectively) that have never been through Owner arm-blind adjudication --
these are entirely distinct from B/D's already-adjudicated 17 packets
(2 critical + 15 UNKNOWN), since A/C's different retrieval strategy
produces different candidate mismatches. Per vFINAL's own rule (no
automatic UNKNOWN resolution, ever), the scorer correctly refuses to
finalize any judgement -- not even a provisional one -- while these remain
unreviewed. This is a real, honest, by-design outcome of the frozen
scorer, not a scorer error: it ran to completion and produced a complete,
reproducible judgement chain (see `judgement.json`).

**This Turn does not declare `PROVISIONAL_WINNER=A`.** Doing so would
require the scorer's own chain to reach that conclusion, which it
explicitly did not (it stops at `"16C selection held"`, a suspended state).
`A` is the strong performance candidate pending Owner review of its 229
new unresolved packets (and C's 216) -- the same arm-blind process already
applied to B/D's 17.

## Security / access boundary

- DEV_CHECK/HOLDOUT: 0 files searched, 0 opened.
- Gold content: never quoted, logged, or committed. Only its SHA-256
  pointer appears anywhere in this report or the repo.
- No raw chunk text committed: `violations.items` (which carries
  `chunk_text` per flagged evidence slot) was stripped from every
  committed `score.{arm}.json` -- aggregate counts only. The full,
  unstripped reports remain locally at `work/bd_handoff/scorer/results/fourarm/`
  (gitignored).
- No HCX calls, no production wiring.
- `PGPASSWORD`/API keys/DB URLs: none appear in any committed file.

## File/result SHA invariance (recorded before scoring, re-verified after)

All of B/D's `{results.jsonl,run.json}` and both of A/C's reformatted
`{results.jsonl,run.json}` are byte-identical before and after the
`score.py --final` run — the scorer only ever *wrote* new files
(`score.*.json`, `judgement.json`, `adjudication.json`, `unresolved/*`),
never touched an existing result/run file. Frozen scorer code
(`fourarm.py`/`score.py`) SHA also unchanged, verified before and after.

See `scoring/` for the sanitized (chunk-text-stripped) `score.{A,B,C,D}.json`,
`judgement.json`, `adjudication.json`, `arm_registry.json`, and `summary.md`.
