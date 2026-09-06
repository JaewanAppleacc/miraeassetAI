# A-REMEDIATION-REPLAY-CONTRACT-V2 — Final Report

Verdict: **`REMEDIATION_NOT_ADOPTED`**. Control replay succeeded (the prior turn's
`BLOCKED_CONTROL_REPLAY` is resolved). No safety regression fired. Recall improved
substantially overall, but the pre-registered top-tier bar requires **both** Recall@10
(ALL) and LOW all_found@10 to improve, and LOW all_found@10 did not move at all
(16/19 in both runs) — so per the amendment's own rule this does not qualify as
`REMEDIATION_RECOMMENDED_FOR_INTEGRATION`, despite large real gains elsewhere.

## 1. Pins

```text
new worktree:          agent-a-remediation-replay-v02
new branch:             codex/a-remediation-replay-contract-v02
checked out from:      feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
amendment commit:      8974b18 (pre-registered before any run)
approved scorer commit (read from handoff/fourarm_bd_final_v01/MANIFEST.json's
  authoritative_scorer_commit field, cross-checked against the frozen submission's own
  git history -- not guessed): 50cc1aac57145ab7fdb825cbb054842cb993c395
committed A.results.jsonl / A.run.json: unchanged this turn (never opened for writing)
frozen submission (codex/a4-a3-plus-qa-frozen-v01 @ 6e24545): never checked out/modified
```

## 2. Independent re-confirmation of the prior BLOCKED (done before the amendment)

Re-ran the existing scorer against the prior turn's own untouched control output --
reproduced the identical `TypeError: int() argument ... not 'NoneType'` crash. Root cause
confirmed unchanged: intervening `a2` commits (between `a5c1c87`, which produced the
committed reference, and `900d3cc`) added multi-node-ambiguous locator resolution
(`provenance.candidates[]`, `node_index: null`), and the existing scorer was never updated
to read it.

## 3. Locator compatibility view -- what it actually took (two issues, not one)

The prior turn's analysis anticipated one problem (`node_index`/`node_indices` union). A
second, independent problem surfaced empirically on the first real scoring attempt: the
raw `locator` STRING field itself changed syntax (`doc/file.xml#node=N;row=R-R;col=C-C`,
semicolon-separated ranges) and no longer matches the scorer's `parse_locator()` regex
(which expects `doc/file.xml#node=N&row=R&col=C` or `doc::file::nN`) -- every item was
flagged `critical: locator_unparseable` (218 on the first control scoring attempt) until
`scripts/a-remediation-locator-compat-view.py` was extended to also regenerate this string
in the old, parseable `doc::file::nN` form (using the file component read directly from a
verified `provenance.candidates[].node_id`, never fabricated). This was found and fixed
via a non-Gold check (the crash/violation count itself, not a Recall number) **before any
candidate/remediation result was produced or seen** -- same discipline as this project's
own precedent for defects found this way. Score after the fix: `critical: 0` (down from
218), `minor: 1`, `unresolved: 21` (all pre-existing, legitimate `duplicate_evidence_
different_node` ambiguity packets, matching this project's established taxonomy), `coarse:
159` -- a real, sane distribution, not a suppressed one.

The compatibility view (§3 of the amendment) never modifies the original runner output or
the frozen scorer; it only ADDS a resolved `node_index`/`node_indices`/`locator` to a new,
derived file, preserving the full multi-node candidate union at every step. It fails
closed (writes nothing) on any document_id mismatch or empty node union -- neither
triggered on either run (0 failures, both control and candidate, 1869 and 1927 items
respectively).

## 4. Real NodeStore verification (upgrade over the prior turn)

Rebuilt `data/index/` (read-only symlinks into this worktree only; the canonical
DocumentIR at `~/Downloads/drive-download-20260804T043134Z-1-002/`, SHA-256-verified
against the manifest, was never modified) via the existing, unmodified
`scripts/build_index.py`:

```text
doc_index_sha256:    c93c18f71ca18cf319e365793fde5e87a0bce470b8d275d65c3881a26d5f5f86  -- MATCHES manifest
node_offsets_sha256: 99179bd7f7b536d67bc8d876e3fecf588219f008cc27512551dcb0a28314051c  -- MATCHES manifest
```

Byte-for-byte reproduction of the manifest-pinned index. `score.py` ran **without**
`--no-locator-check` for both runs -- `locator_checked: true` in both `score.A.json`
outputs, a real critical/minor/unresolved check, not the placeholder from the prior turn.

## 5. Control replay -- SUCCESS

```bash
DATABASE_URL=... P11F0_KURE_SERVER_URL=... \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A \
    --batch-id 1cb8528c17daa109 --out-dir work/a-remediation-review-v2/control
```

101/101 questions, 0 errors. Identity check against the committed `A.results.jsonl`,
**all 101 questions**:

```text
required fields (question_id, rank, doc_id, chunk_id, chunk_text_sha256, score): 0 mismatches
bonus fields (node_index, node_indices, post-compat-view):                       0 mismatches
```

The compatibility view reconstructs the exact old-schema values from the new
provenance-based schema (verified directly: question 1 rank 1's resolved
`node_index=20, node_indices=[20..34]` is byte-identical to the committed reference's
values for that same item).

## 6. Candidate run (remediation-v1)

```bash
DATABASE_URL=... P11F0_KURE_SERVER_URL=... \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --policy remediation-v1 \
    --batch-id fd7c3a946485a1bd --out-dir work/a-remediation-review-v2/candidate
```

101/101 questions, 0 errors. Hydrated 1927/1927 items (0 failures), compat view 0 fail-closed
triggers.

## 7. Metrics (control vs candidate, real NodeStore-backed scoring both)

| metric | control | candidate | delta |
|---|---|---|---|
| Recall@5 (ALL) | 0.7587 | 0.8951 | **+0.1364** |
| Recall@10 (ALL) | 0.8287 | 0.9510 | **+0.1223** |
| Recall@20 (ALL) | 0.8566 | 0.9615 | **+0.1049** |
| HIGH Recall@10 | 0.8160 | 0.9560 | **+0.1400** |
| LOW Recall@10 | 0.9167 | 0.9167 | 0 (unchanged) |
| LOW all_found@10 | 16/19 | 16/19 | 0 (unchanged) |
| ALL all_found@10 | 73/100 | 91/100 | **+18** |
| HIGH all_found@10 | 57/81 | 75/81 | **+18** |
| critical | 0 | 0 | 0 (no increase) |
| minor | 1 | 1 | 0 |
| unresolved | 21 | 21 | 0 |
| coarse | 159 | 181 | +22 (informational only, never a gate) |
| zero-result questions | 6 | 4 | **-2 (improved)** |
| improved / regressed / unchanged (found@10, per-question) | -- | -- | 18 / 1 / 82 |
| date-anchored recovery | -- | -- | 18 questions |
| subtype-narrowed recovery | -- | -- | 5 questions (subset of the 18) |
| correction-notice chunks in top-20 (diagnostic only) | 60 | 330 | +270 (expected: `correction_filter: ONLY_WHEN_ASKED` vs the frozen hard exclusion) |
| p50 / p95 / max latency (ms) | 186 / 1428 / 2721 | 231 / 1288 / 2195 | p95 **improved** (-140ms) |
| retrieval passes/question (candidate; control is always 1 pass by design) | -- | 0 passes: 4, 1 pass: 39, 2 passes: 55, 3 passes: 3 | -- |

The one regressed question (`author_087a90f5918d4e0b3e00959c`, HIGH segment, "두산로보틱스
연결기준 매출액... 2023년과 2025년 사이... 변동") went from 1/2 to 0/2 slots found at k=10;
neither run reached `all_found@10` for it either way, so it does not move any aggregate
gate metric -- reported here for completeness, not hidden.

## 8. Decision-rule application (fixed in the amendment, before this result existed)

```text
BLOCKED_CONTROL_REPLAY?           NO -- replay succeeded (§5), compat view never failed
                                   closed, rebuilt index matches manifest pins exactly (§4).
REMEDIATION_REJECTED_SAFETY?      NO -- no HIGH/LOW Recall@10 regression (HIGH improved,
                                   LOW unchanged), no increase in zero-result count
                                   (improved), no increase in critical (held at 0).
REMEDIATION_RECOMMENDED_FOR_INTEGRATION?  NO -- requires BOTH Recall@10 (ALL) and LOW
                                   all_found@10 to improve. Recall@10 (ALL) improved
                                   (+0.1223); LOW all_found@10 did NOT move (16/19 both) --
                                   condition not met.
REMEDIATION_NOT_ADOPTED?          YES -- "Recall@10 (ALL) and LOW all_found@10 do not both
                                   improve" is true (only one of the two did).
```

## 9. Confirmations

```text
old_style_node_index_via_removing_provenance: never -- compat view file retains the full
                                              original `provenance` block in the derived
                                              output alongside the added node_index/
                                              node_indices/locator fields
first_node_forced_selection:                 never -- full union preserved and verified
original_A_results_or_scorer_modified:       never (sha256 of both files in
                                              domain/agent-comparison/four-arm-ac/results/
                                              unchanged; scripts/fourarm/score.py and
                                              src/dart_corpus/evaluation/fourarm.py never
                                              opened for writing)
policy_changed_after_seeing_a_result:        false -- the amendment (§3, §7) was committed
                                              (8974b18) before either run was executed; the
                                              locator-string fix (§3) was made after finding
                                              a crash (a non-Gold, non-recall signal), before
                                              any candidate result existed, matching this
                                              project's own precedent for that discipline
partial_question_reruns:                      none -- both runs cover the full 101 questions
DEV_CHECK_or_HOLDOUT_accessed:                false
frozen_submission_branch_modified:            false
pr_created:                                    false
force_amend_rebase_reset_used:                 false
db_write_count:                                0 (all queries this turn were inside
                                              `BEGIN TRANSACTION READ ONLY ... ROLLBACK`
                                              blocks in the hydrator/metadata-fetch scripts,
                                              or plain SELECTs from the retrieval runner)
```

## 10. Existing test-suite invariance

```text
node --test tests/four-arm-a-retrieval-remediation.test.mjs tests/four-arm-run-checkpoint.test.mjs
  -> 29 pass, 0 fail
```

## 11. Final verdict

```text
REMEDIATION_NOT_ADOPTED
```

The remediation candidate is a real, substantial, safe improvement on every metric except
the one this project's own contract (`docs/interfaces.md` §1-5: "all_found@k ... LOW 주
판정") designates as the primary decision axis: LOW all_found@10 is unchanged. All 18
recovered questions (date-anchored and/or subtype-narrowed misses, exactly matching the
remediation's own stated intent) fall in the HIGH segment; none of the 19 LOW-segment
questions happen to need the specific mechanisms this remediation adds. This is reported
as the honest outcome of the pre-registered rule, not adjusted after seeing it. Whether to
revisit the LOW-segment gap, or to weigh the HIGH-segment and latency gains differently, is
an Owner decision outside this turn's scope -- this turn declares no winner and makes no
final-submission recommendation.
