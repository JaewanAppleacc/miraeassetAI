# Official A/C DEV_TUNE-101 Retrieval Run — Results Summary

Turn: `FOURARM-AC-OFFICIAL-DEVTUNE-AND-SELECTION-V1`. Batch:
`35b588e42086e728302c47f0b5d307b7`. Code: `a5c1c8730225d0905b37c0ee8561e9563a56a30d`
(identical for both arms — no code drift between them).

**Retrieval execution: COMPLETE, CLEAN.** **Scoring/selection: BLOCKED_CONTRACT**
(Gold DEV_TUNE-101 content was never provided to this environment — only its
SHA-256 pointer — by the same design that keeps DEV_CHECK/HOLDOUT out of
reach). No DEV_TUNE Gold, DEV_CHECK, or HOLDOUT content was accessed. No
production wiring was performed.

## Execution

| | Arm A (FIXED+FULL_DENSE) | Arm C (FIXED+DENSE_OFF) |
|---|---|---|
| questions | 101/101 | 101/101 |
| errors | 0 | 0 |
| checkpoint integrity | OK (101 unique ids, results_sha256 verified) | OK |
| questions with ≥1 result | 95 | 95 |
| questions with 0 results | 6 (all independently verified as genuine "not in corpus" cases — see below) | 6 (same 6) |
| dense/embedding calls | 101 | 0 (structurally guaranteed) |
| latency p50/p95/max (ms) | 205 / 1593 / 2995 | 62 / 584 / 930 |
| locator/provenance hard gate | **PASSED** (0 unresolved chunks across 1,869 returned chunks) | **PASSED** (0 unresolved chunks across 1,869 returned chunks) |

Segment distribution (from the official conditions artifact): 81 HIGH, 20 LOW.

## The 6 zero-result questions (identical for both arms)

`author_41f346723847e84a051e614a`, `author_642b260aa50968143920281b`,
`author_a24879dc628ff582fdeba8b5`, `author_d640cbedd7330f4b9bcfeeb7`,
`author_f119c5d79a4e52a359a84caa`, `author_ffcc4093fb37a87f1a40322d` — each
independently verified against the live DB (not just the filter logic) as a
genuine absence: the referenced company/doc_group/subtype/period combination
does not exist anywhere in the retrieval-eligible corpus (e.g. no `major`
disclosures for 삼성전기/LG에너지솔루션 at all; no `단일판매공급계약체결`-
subtype exchange filing for KB금융/알테오젠; no 2022 periodic data for
삼성전자 -- the corpus's periodic coverage starts at 2023). All six questions'
own phrasing ("...코퍼스에 포함되어 있는가", "...공시상 확인 가능한가") reads
as a deliberate existence-check design, consistent with correctly returning
empty rather than hallucinating a match.

## Two real bugs found and fixed during this Turn before this run

1. **Wrong `expectedPins` key shape** made every arm A `search()` call fail
   with a false "repository mismatch" error (100% error rate on the first
   attempt, 0 real results produced, discarded before this run).
2. **Metadata filter fields applied uniformly across doc_groups that don't
   share their semantics** (`base_year`/`base_month` only populated for
   `doc_group=periodic`; `doc_subtype` only meaningful for a single pure
   doc_group at a time) silently guaranteed zero recall for 81/101 questions
   on the first corrected attempt. Fixed by routing each field to only the
   doc_group(s) where it is populated and reliable, verified against the
   live DB and regression-tested (`tests/four-arm-conditions-to-filter-mapper.test.mjs`).

Both fixes are committed (`a5c1c8730225d0905b37c0ee8561e9563a56a30d`) and
covered by new tests before this official run was executed.

## Scoring

`official_batch_execution_ready = true` (all pins/ledger/artifacts verified,
independent of any arm's hard-gate outcome). B and D remain frozen at
`HARD_GATE_FAILED` / `selection_eligible=false` per the Owner-ratified
`resolutions.owner.json` (2 `ARM_SPECIFIC` critical packets, unchanged).

A and C's own hard/quality gate (Recall@5/10/20, HIGH Recall@10, LOW
all-required-slots-found, required-evidence critical checks) **cannot be
computed in this environment** -- it requires Gold DEV_TUNE-101 content,
which was never provided here (only its SHA-256 pointer,
`7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b`). The one
hard-gate component that does NOT require Gold -- locator/provenance
integrity -- was computed directly from these results and **passed for both
arms**.

**Final status: `BLOCKED_CONTRACT`.** No `PROVISIONAL_WINNER` is declared;
no `NO_SELECTION` is declared either, since that requires having actually
scored every arm and found none eligible, which has not happened. The next
step is for whoever holds Gold legitimately to run the same frozen scorer
(`ac_scorer_50cc1aa`) against `A.results.jsonl`/`C.results.jsonl` exactly as
it was already run against `B.results.jsonl`/`D.results.jsonl`.

See `execution-manifest.json` for the full machine-readable detail (ledger
entries, arm states, checkpoint integrity, locator/provenance stats).
