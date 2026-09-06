# A4+A3 Integration & DEV_TUNE-101 v1 — Pre-registration Amendment

Turn: `A4-A3-INTEGRATION-AND-DEVTUNE-V1`. Written and committed **before**
any new A4/A3 result or score is viewed. Nothing below is edited after
Gold is opened.

## 0. Base references (fixed before execution)

| Item | Value |
|---|---|
| A4 Wide Pool | `codex/fourarm-a4-wide-pool-v01` @ `c9b4cb0e67cc3a87a7ab250d6c1adacd5723aa56` |
| A4 Reranker | `codex/fourarm-a4-reranker-v01` @ `0e4acf0e4d82cf6362e16ad90f6d6f7e6d9c8ee5` |
| A3 Contradiction Guard | `codex/fourarm-a3-contradiction-guard-v01` @ `9358e2077397675febc82ae5fbc5240f32bc198a` |
| New worktree/branch | `agent-fourarm-a4-a3-devtune-v01` / `codex/fourarm-a4-a3-devtune-v01`, based on `0e4acf0…` |
| Ancestry check | all three branches share common ancestor `900d3cc7…`; A3 guard's own parent is an ancestor of the A4 Reranker HEAD, so the guard commit cherry-picks cleanly (verified, 0 conflicts) |
| SHA agreement | all three commits verified byte-identical between `origin` and `demo-ai-festival` (`git ls-remote` on both, section A) |

## 1. Section A pre-checks (recorded, not results)

- Local/origin/demo-ai-festival SHA for all three source branches: **identical** (see table above).
- Working tree: clean at each step.
- Concurrent DB writer: **0** other backends on `p11f0_scratch` (`pg_stat_activity` checked).
- Retrieval index: `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7`, `READY`, `record_count=442549`.
- Load session `fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e`: `READY`, `expected_unique_embeddable_count=441879`, `materialized_chunk_count=442549`.
- KURE server `/info`: `nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024.
- Existing result/run file SHAs recorded (must remain unchanged at the end):

| file | sha256 |
|---|---|
| `results/A.results.jsonl` | `1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156` |
| `results/A.run.json` | `1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395` |
| `results/A2.results.jsonl` | `3083901a68ae0e79f2c1e7d9c841337384898f8276769ea30483c7923416a773` |
| `results/A2.run.json` | `c55d90ab5b66619fe8d75dbe27791fcf846f48bb0463eee611c7e76ee4fc6b40` |
| `results/C.results.jsonl` | `898b53e3aa32c86502d54d13bc3de93d27139ae70975ad64e63a9490fe693081` |
| `results/C.run.json` | `19e3e044a27d3ea8399851e2224c7430f95562967f9cdd36dba7100712a9eb07` |
| `official/B.run.json` | `f9e61e4682bfa39d69884a62093f6f2d43f09fa85c02aa440cc32c8de378dff4` |
| `official/D.run.json` | `86296910e10ea7a9669adcb9ebd8e980cd0c5145d5517d6c51ca933a06cefed0` |

### Scorer / Owner-policy source-of-truth check

Two different `fourarm.py` file contents were found on disk:

- `sha256=4a717350d6…` — the multinode-fix-patched frozen scorer
  (`ac_scorer_50cc1aa` + local patch), matching this repo's own committed
  `domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/fourarm.patched.py`
  **exactly**, and present at the actual runtime scorer package used by
  prior four-arm-ac Turns (`agent-fourarm-official-integration-v01/work/bd_handoff/scorer/src/dart_corpus/evaluation/fourarm.py`).
- `sha256=d6249932…` — an older, unpatched version, found only inside the
  three `agent-a-plus-qa-*` worktrees (`agent-a-plus-qa-adapter-v01`,
  `agent-a-plus-qa-full-index-smoke-v01`, `agent-a-plus-qa-live-retriever-v01`).

This is **not** a same-lineage ambiguity: the `agent-a-plus-qa-*`
worktrees belong to the explicitly separate, off-limits "A+QA" track
(this Turn's own §I prohibits touching an A+QA branch), never part of
the four-arm-ac evaluation lineage this Turn operates in. The single
"정본" scorer for this Turn is therefore the multinode-fix-patched
version (`4a717350d6…`), used exactly as already established by
`SCORER_MULTINODE_FIX_V1_AMENDMENT.md`/`RESULTS_SUMMARY.md`. Owner policy
(`domain/agent-comparison/four-arm-ac/official/resolutions.owner.json`,
sha `90940c7d5142…`) is identical across every four-arm-ac worktree
checked; the only other `resolutions.owner*.json`-named files found
(`work/bd_handoff/owner_review_v2/resolutions.owner.v2.draft.json`,
`.../owner_review_v3/resolutions.owner.v3.draft.json`) are explicitly
named **drafts** in a gitignored scratch directory, not competing
"정본" candidates.

**IMPORTANT scorer-invocation note (methodology, fixed before any
result):** the frozen scorer's own CLI (`scripts/fourarm/score.py`)
hard-restricts `--arms` to the literal choice set `{A,B,C,D}`
(`argparse(..., choices=["A","B","C","D"])`) and cannot score this
Turn's new arm labels (the same-run-A reproduction, and R0–R5
raw/A3-applied — 13 distinct result sets) without editing the frozen
CLI, which is out of scope and prohibited (§I: no scorer modification).
This Turn therefore reuses this project's own already-validated,
already-cross-checked JS port of the scorer's `slot_found()`/pooled
`recall@k` aggregation (`fourarm.patched.py`'s exact algorithm, ported
and score/rank-verified against A's own official RRF output during the
A3 Candidate Ceiling Audit Turn) rather than shelling out to
`score.py`. Gold is read only by this scoring code path, once, in
memory — never logged, never quoted, never copied to a git-tracked
path.

## 2. Fixed retrieval/reranker configuration (locked)

| Parameter | Value |
|---|---|
| corpus | identical to Arm A (`corpus_04750795e1a2d5c3`) |
| chunking | Fixed-512 (`fixed-token-512-o64.v0.1.0`) |
| metadata_prefilter | identical to Arm A (`mapOfficialConditionToFilterInput` → `buildMetadataFiltersFromConditions` → `fetchEligibleChunkIds`/`passesMetadataFilters`) |
| bm25_candidate_k | 100 |
| dense_candidate_k | 100 (wide leg; the top-20 subset of this same list is what "original-A-compatible" reproduction uses, exactly as `buildWideCandidatePool()` itself does) |
| rrf_constant | 60 |
| wide_pool_max | 200 |
| reranker_configs | R0–R5, exactly 6, from `a4-reranker-configs.v1.json` (untouched) |
| final_output_k | 20 |
| primary_evaluation_k | 10 |
| reported_cutoffs | [5, 10, 20] |

`a4-reranker-configs.v1.json` sha256: `4572fcf3c574a8422af153559e218f86126c62c97a0b823b8a0e01884b8ac0f4`.

Per-config weight-object sha256 (frozen, `JSON.stringify(weights)`):

| config_id | weights sha256 |
|---|---|
| `R0_original_a_baseline` | `aaaaedd926b726efa126fe2ae75f2a547a6f1666e6707eb37363d0b08a930a6d` |
| `R1_bm25_dense_original_rrf` | `bef4423c1d437cd8b6c7dc01f7946311ad7f94fb0e82235a67253053f562e1f4` |
| `R2_plus_lexical_term_coverage` | `275aefaaab1ba18d253f9b67b5eb395821e8b6f3218aa3aa12dc9d1d7c5166ae` |
| `R3_plus_metadata_consistency` | `bee4359b5684ca8e3c6a96fae76f3a1bd893baff68c9c79186cbb887388b27a0` |
| `R4_wide_rrf_centric` | `e096edb3bfdc3e8af5559328e9578317157073b12c1be33f84b6ae9976225272` |
| `R5_reciprocal_fusion_plus_coverage` | `6fc15a799bcb4e800b47912a3482793f8d88427454c7d648f424a8001b98b6a3` |

No weight, feature, or config is added/removed/reweighted after this
point, regardless of any result seen later.

## 3. A3 Contradiction Guard wiring (fixed)

- `PASS`/`REJECT`/`KEEP_UNKNOWN` per `detectEvidenceContradictions()`,
  unmodified, byte-identical to `9358e20`.
- Only `REJECT` is removed. `PASS` and `KEEP_UNKNOWN` are both kept and
  passed to `selectWithStableRefill`. A2's PASS-only filter
  (`a2-evidence-scope-validator.mjs`/`a2-stable-evidence-filter.mjs`) is
  never imported or reused.
- Checked dimensions: scope, period, unit/sign, revision, entity,
  row/column — each independently, per the guard's own fixed rules.
- **`row_column` is never populated from the question this Turn** — no
  reliable, non-Gold way to extract "required row/column label" from
  free question text was designed in the time available. This means
  `checkRowColumn` trivially `PASS`es for every candidate (per the
  guard's own documented behavior: an absent requirement always passes).
  This is a disclosed scope limitation, not a bug — it means row/column
  contradictions are never caught this Turn, which is a conservative
  (never-REJECT) direction, not one that could inflate REJECT counts.
- **`questionConditions` extraction** (from the question's own text and
  official, non-Gold `conditions` object only):
  - `scope`: `CONSOLIDATED` if the question text contains "연결",
    `SEPARATE` if it contains "별도"/"개별" (same marker list as the
    guard's own internal `CONSOLIDATED_MARKERS`/`SEPARATE_MARKERS`,
    duplicated in the new pipeline module since the guard does not
    export them); both or neither present → omitted (not checked).
  - `period`: the guard's own exported `normalizePeriodLabel(questionText)`,
    reused unmodified. Returns `null` (→ omitted, not checked) on any
    ambiguous or unparseable phrase — never guessed.
  - `unit`: the guard's own currency/percent/share token vocabulary
    (억원/백만원/천원/원/%/주), detected in the question text with the
    same marker rules (duplicated, not exported).
  - `revision`: "정정 전"/"정정 후" markers in the question text (same
    rule, duplicated).
  - `entity`: the question's own official `conditions.corps` →
    `corp_code` via the SAME company resolver
    (`seed-company-resolver.mjs`/`four-arm-conditions-to-filter-mapper.mjs`)
    already used for retrieval filtering — compared against the
    candidate's own `corp_code` (an exact code match, not a
    normalized-name string match, for reliability). Never derived from
    Gold.
- **`evidenceFacts` extraction** (from the candidate's own hydrated text/
  metadata/provenance only, never Gold):
  - `scope_hint`/`period_hint`/`unit_hint`/`revision_hint`: the
    candidate's own full chunk text, passed straight into the guard's
    own hint-parsing rules (reused unmodified — this Turn's pipeline
    does not reimplement the guard's parsing, only the request-side
    marker detection above).
  - `entity`: the candidate's own `corp_code` (from its DB row metadata).
  - `table_title`/`row_label`/`column_label`: never populated (see
    `row_column` note above).
  - **Disclosed limitation**: a Fixed-512 chunk can legitimately contain
    more than one period/column (e.g. 당기 vs 전기 side by side in one
    table). `period_hint` scans the *whole* chunk text and resolves the
    *first* matching year/quarter phrase, which may not always be the
    column a specific slot actually refers to. This is a known,
    disclosed imprecision — mitigated by the fact that (a) a genuinely
    ambiguous quarter phrase (no explicit 누적/3개월 qualifier) already
    resolves to `null` → `KEEP_UNKNOWN` per the guard's own rule, never
    a confident wrong answer, and (b) `KEEP_UNKNOWN` is never grounds for
    removal.
  - A field this extraction cannot confidently resolve is left `null`/
    absent, which the guard itself turns into `KEEP_UNKNOWN` for that
    dimension (never a fabricated REJECT).

## 4. Pipeline (fixed order, section C)

```
1. BM25 top-100 (A-compatible: same bm25Search/eligibleIds path A uses)
2. KURE dense top-100 (one embedQuery call per question, reused across steps 3+)
3. original-A-compatible top-20: RRF(k=60) over BM25 top-100 + dense top-100's
   own rank<=20 subset -- computed by this pipeline AND independently
   re-verified by buildWideCandidatePool()'s own built-in reproducibility
   check (throws if they disagree)
4. buildWideCandidatePool({ original_a_top20, bm25_top100, dense_top100 })
5. hydration + chunk_text_sha256 verification against the DB row's own
   text_sha256 (fail-closed on mismatch)
6. questionContext extraction (§3 above)
7. rankCandidatePool() for each of R0..R5 (full ranking, <=200, no
   pre-truncation) -- ONE shared wide pool and ONE shared query embedding
   feed all 6 configs
8. detectEvidenceContradictions() for every candidate actually reached by
   any config's ranking (i.e. the full <=200-candidate pool, computed once
   per question and cached by chunk_id -- not recomputed per config)
9. selectWithStableRefill() per config
10. final top-20 per config, plus the "raw" (pre-A3) top-20 per config,
    plus the same-run original-A-compatible top-20, all reported separately
```

## 5. Pre-registered selection rule (fixed, not adjustable after results)

A4+A3 candidate eligibility (must satisfy **all**):

- `critical = 0`
- `locator/provenance critical = 0`
- overall `Recall@10 >= same-run A Recall@10`
- `HIGH Recall@10 >= same-run A HIGH Recall@10`
- `LOW all-required-slots-found@10 >= same-run A` (same metric)

Clear-improvement bar: overall `Recall@10 >= same-run A Recall@10 + 0.01`.

Tie-break order among configs that pass eligibility:

1. fewer `critical`
2. higher overall `Recall@10`
3. higher `HIGH Recall@10`
4. higher `LOW all-found@10`
5. higher `Recall@20`
6. lower `p95` latency
7. `config_id` bytewise ascending

The `Recall@10 >= 0.90` target is reported separately and never used to
adjust any rule, weight, or config.

## 6. Verdicts (fixed, section H)

| Condition | Verdict |
|---|---|
| passes all safety/non-degradation gates, `Recall@10` improvement `>= 0.01` | `A4_A3_SELECTED_FOR_QA_INTEGRATION` |
| passes safety gates, improvement `< 0.01` | `KEEP_EXISTING_A_FOR_SUBMISSION` |
| `Recall@10` improved but `critical > 0` | `NO_SELECTION_SAFETY_BLOCKED` |
| overall/HIGH/LOW any one degraded vs. same-run A | `KEEP_EXISTING_A_FOR_SUBMISSION` |
| contract/reproducibility/infra failure | `BLOCKED_CONTRACT` |

## 7. Prohibitions restated (binding for this Turn)

DEV_CHECK/HOLDOUT access; QA code edits; A+QA branch edits; adding/
removing/reweighting R0–R5; adding a feature after seeing a result;
partial-question re-runs; corpus re-embedding; new chunking; folding the
81 fallback documents in; BM25 tokenizer changes; DB writes/migrations;
editing any original result file; declaring a winner outside the rules
above.
