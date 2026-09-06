# A4+A3 Integration & DEV_TUNE-101 v1 — Result

Turn: `A4-A3-INTEGRATION-AND-DEVTUNE-V1`. Pre-registration:
`A4_A3_DEVTUNE_V1_AMENDMENT.md` (committed before any result below was
computed; addendum in the same file records 3 pre-flight extraction
fixes made before Gold/DEV_TUNE was opened). QA was not modified;
DEV_CHECK/HOLDOUT were never opened.

## Final verdict: `A4_A3_SELECTED_FOR_QA_INTEGRATION`

**Winning configuration: `R4_wide_rrf_centric`, A3-applied (`final`)
variant.** Passes every pre-registered safety/non-degradation gate and
improves overall `Recall@10` by **+0.0489** over the same-run Arm A
baseline — well above the pre-registered `+0.01` clear-improvement bar.

## Base / final SHA

| Item | Value |
|---|---|
| Worktree / branch | `agent-fourarm-a4-a3-devtune-v01` / `codex/fourarm-a4-a3-devtune-v01` |
| Base commit | `0e4acf0e4d82cf6362e16ad90f6d6f7e6d9c8ee5` (A4 Reranker) |
| A4 Wide Pool source | `codex/fourarm-a4-wide-pool-v01` @ `c9b4cb0e67cc3a87a7ab250d6c1adacd5723aa56` |
| A3 Contradiction Guard source | `codex/fourarm-a3-contradiction-guard-v01` @ `9358e2077397675febc82ae5fbc5240f32bc198a` |
| Amendment commit | `9d4afac` (+ addendum in the same file, same commit lineage) |
| Final commit (this report) | see branch HEAD at push time |

## Input-pin verification (all GREEN, section A/E)

- Local/origin/demo-ai-festival SHA for all three source branches: identical.
- Retrieval index `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7`: `READY`, `record_count=442549`.
- Load session `fixed_kure_attempt_23b88aea…`: `READY`, `expected_unique_embeddable_count=441879`.
- KURE server: `nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dim 1024.
- Scorer/Owner-policy provenance: single, unambiguous 정본 per amendment section 1 (the `agent-a-plus-qa-*` track's differing `fourarm.py` is an explicitly separate, off-limits lineage, not a competing source).
- Section D: 15/15 pre-Gold contract tests GREEN (byte-identity against all three source commits, config registry/weight-SHA pins, R0 original-A-compatible behavior, full wide-pool→rank→A3→refill wiring, bidirectional scope contradiction + ambiguous-scope KEEP_UNKNOWN + independent dimension checks, no hardcoded IDs, no write-SQL/embedDocuments, determinism, byte-invariance of every existing file).
- Section E: infra gate GREEN + 1 non-Gold smoke question GREEN before any Gold access.

## Questions processed

101/101 DEV_TUNE-101 questions run in one single batch (no partial/selective re-runs). 1 question (`gold_b_e95de359f794df64ffab5044`, `NOT_FOUND`/`ANSWERABILITY`, 0 required evidence slots) is excluded from the recall denominator by the scorer's own convention — 100 questions / 286 slots scored.

- Query embedding calls: **101** (exactly one per question, shared across all 6 configs).
- Corpus/document embedding calls: **0**.
- DB write queries: **0**.
- DEV_CHECK/HOLDOUT files accessed: **0**.

## Same-run Arm A baseline (recomputed this Turn, same scorer, same batch)

| metric | value |
|---|---|
| Recall@5 / @10 / @20 | 0.7587 / **0.8287** / 0.8566 |
| HIGH Recall@10 | **0.816** |
| LOW Recall@10 | 0.9167 |
| LOW all-required-slots-found@10 | **16/19** |
| critical / minor / unresolved | 0 / 0 / 0 |

Computed by reproducing arm A's own official retrieval formula
(RRF(k=60) over BM25 top-100 + dense top-100's own top-20 subset) live,
in this same run — not by re-reading the old frozen `A.results.jsonl`
(which is verified byte-unchanged throughout, see below).

## Per-config results (raw = pre-A3 top-20; final = A3-applied top-20)

| config | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all-found@10 | eligible | Δ Recall@10 vs A |
|---|---|---|---|---|---|---|---|---|
| R0 raw | 0.7587 | 0.8287 | 0.8566 | 0.816 | 0.9167 | 16/19 | — | — |
| **R0 final** | 0.7552 | 0.8217 | 0.8531 | 0.808 | 0.9167 | 16/19 | ❌ (degraded) | −0.0070 |
| R1 raw | 0.7867 | 0.8462 | 0.8846 | 0.836 | 0.9167 | 16/19 | — | — |
| **R1 final** | 0.7832 | 0.8392 | 0.8846 | 0.828 | 0.9167 | 16/19 | ✅ | +0.0105 |
| R2 raw | 0.7832 | 0.8566 | 0.8986 | 0.848 | 0.9167 | 16/19 | — | — |
| **R2 final** | 0.7797 | 0.8497 | 0.8951 | 0.840 | 0.9167 | 16/19 | ✅ | +0.0210 |
| R3 raw | 0.7832 | 0.8531 | 0.9126 | 0.844 | 0.9167 | 16/19 | — | — |
| **R3 final** | 0.7797 | 0.8462 | 0.9091 | 0.836 | 0.9167 | 16/19 | ✅ | +0.0175 |
| R4 raw | 0.8147 | 0.8811 | 0.9091 | 0.876 | 0.9167 | 16/19 | — | — |
| **R4 final (WINNER)** | **0.8112** | **0.8776** | 0.9021 | **0.872** | 0.9167 | 16/19 | ✅ | **+0.0489** |
| R5 raw | 0.7797 | 0.8636 | 0.9161 | 0.856 | 0.9167 | 16/19 | — | — |
| **R5 final** | 0.7762 | 0.8566 | 0.9091 | 0.848 | 0.9167 | 16/19 | ✅ | +0.0279 |

`critical=0` and `minor=0` for every arm (structural argument, see
Methodology below); `unresolved=0` for every arm this run.

### Eligibility and tie-break (applied exactly as pre-registered)

Eligibility requires `critical=0` (✓ all), `locator/provenance
critical=0` (✓ all), `Recall@10 >= same-run A` (0.8287), `HIGH
Recall@10 >= 0.816`, `LOW all-found@10 >= 16`. **R0 final fails**
(0.8217 < 0.8287, degraded) — every other `final` config passes.

Tie-break among {R1, R2, R3, R4, R5} (all clear-improvement, `>=0.01`):
rule 1 (fewer critical) ties at 0; rule 2 (higher overall `Recall@10`)
already decides it — **R4 (0.8776)** is strictly highest among the five
(R5 0.8566, R2 0.8497, R3 0.8462, R1 0.8392). **R4 final wins.**

## A3 aggregate counts (identical A3 decisions feed every config, since the same pool + same detectEvidenceContradictions() calls are cached per question and reused across all 6 configs)

| | count |
|---|---|
| PASS | 9,813 |
| REJECT | 174 |
| KEEP_UNKNOWN | 1,737 |
| stable refills (R4) | 20 |
| questions with a final-top20 shortfall (<20 survivors) | 8 |

REJECT is ~1.5% of all candidate-slots across the run — consistent with
the pre-registered "REJECT only on an obvious, decidable contradiction"
intent (see the amendment's pre-flight fix addendum for how an initial,
much higher REJECT rate was found and corrected before this run).

## Net change vs. same-run A at top-10 (winning config, R4 final)

| | count |
|---|---|
| Slots gained (not in A's top-10, now in R4-final's top-10) | 18 |
| Slots lost (in A's top-10, no longer in R4-final's top-10) | 4 |
| Slots unchanged | 264 |
| **Net change** | **+14** |
| A3-REJECTed candidates that were also a correct slot match | 2 |

Net +14 slots on a 286-slot denominator is exactly the ~+4.9-point
`Recall@10` improvement reported above (14/286 ≈ 0.049). The 2
REJECTed-but-correct cases are a disclosed, small cost of the A3 guard's
non-Gold extraction imprecision (see amendment §3's disclosed
limitations) — net effect is still strongly positive (18 gained vs. 4+2
lost/harmed = +12 net even under the more conservative accounting).

## Target Recall@10 ≥ 0.90

**Not achieved.** R4 final = 0.8776. Reported as required by section B;
no rule, weight, config, or feature was changed in an attempt to close
this gap.

## Methodology notes (disclosed simplifications)

- **critical/minor = 0 by structural argument, not a full
  `check_locators()` port**: every candidate this Turn's pipeline emits
  carries `doc_id`/`node_index`/`node_indices` resolved directly from
  real DB rows (never a hand-built locator string), and `row`/`col` are
  never populated for scoring. This eliminates every one of
  `check_locators()`'s own critical triggers (`locator_unparseable`,
  `locator_field_mismatch`, `doc_missing`, `node_missing`,
  `row_col_differs`) by construction, for every arm including same-run
  A (hydrated through the identical path) — not merely "not observed".
  `minor` (table-rendering-difference / offset-only-normalization) was
  not classified this Turn; it does not affect Recall or the hard gate.
  `unresolved` approximates `check_locators()`'s own
  `claim_text_not_in_node`/`gold_span_not_verifiable` buckets via this
  port's "unverified" text state (reused from the A3 Candidate Ceiling
  Audit's own cross-verified `slot_found()` port) — it came out to 0 for
  every arm this run.
- **Scorer**: the frozen scorer's own CLI restricts `--arms` to
  `{A,B,C,D}` and cannot score this Turn's 13 new arm labels without
  editing it (prohibited). This Turn's own JS port of
  `slot_found()`/pooled-recall (same algorithm, cross-verified against
  A's own official RRF output during the Ceiling Audit Turn) was used
  for all scoring instead, including the same-run A reproduction.
- `row_column` was never populated in `questionConditions` this Turn (no
  reliable non-Gold extraction was designed) — `checkRowColumn` PASSes
  trivially for every candidate this run, a conservative (never
  additional-REJECT) simplification.

## Verification (section D/H)

| check | result |
|---|---|
| A/A2/C result/run files, B/D run.json, frozen scorer | byte-unchanged (SHA verified before and after) |
| DB write queries | 0 |
| Corpus embedding calls | 0 |
| DEV_CHECK/HOLDOUT access | 0 |
| Partial/selective question re-runs | 0 (101/101 in one pass) |
| R0–R5 config/weight changes after seeing a result | 0 |
| `git diff --check` | clean |
| `npm run schema:validate` | PASS (36 pairs, unchanged) |
| `npx tsc --noEmit` | clean |
| Scoped tests (`tests/four-arm-a4-a3-integration.test.mjs`) | 15/15 pass |

## Committed artifacts

- This file and `a4-a3-devtune-summary.json` (aggregate metrics, SHAs,
  execution provenance only).
- No raw Gold, raw question/answer text, full chunk text, vector, DB
  URL, personal path, or secret is committed anywhere in this Turn's
  changes — all raw candidate/Gold data lives only under gitignored
  `work/a4-a3-devtune-results/`, `work/gold/`, `work/a4-a3-devtune-scores.json`.
