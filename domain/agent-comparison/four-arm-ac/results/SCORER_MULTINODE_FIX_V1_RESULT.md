# A/C Multi-Node Scorer Fix — `FOURARM-SCORER-MULTINODE-FIX-V1`

Follows `SCORER_MULTINODE_FIX_V1_AMENDMENT.md` (committed at `f0cc646`, before the
patch was applied or any new score was viewed). Fixes a genuine defect in the
frozen scorer's `claim_text_not_in_node` check without touching A/C's own
retrieval, results/run files, B/D's results/score, or the existing Owner
resolutions.

## The patch

`domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/` records the
patch as a versioned fork: `ac_scorer_50cc1aa+multinode-fix-v1`. Upstream
`fourarm.py` SHA-256 `d62499328a4…` is unchanged and never overwritten; the
patched `fourarm.py` SHA-256 is `4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804`.
`score.py` is byte-identical to before (`4f2a4c1063c…`) — untouched.

The patch adds exactly one narrow branch inside `check_locators()`'s existing
`claim_text_not_in_node` check (see `fourarm.patch.diff`): when Gold's own
designated node for a slot match is already a member of the retrieved
multi-node candidate set (`node_index ∪ node_indices`), a content-preserving
normalization (strips only structurally-empty table rows — lines that are
pure whitespace/`|` — never touches any line carrying real content) is tried.
If the chunk's own text is consistent with the concatenated node-store text
under this normalization **and** at least one line of Gold's own evidence is
present in the chunk, the packet becomes `severity=minor,
reason=same_evidence_table_rendering_difference` instead of an `unresolved`
Owner-review packet. If Gold's node is not in the candidate set, or the
required evidence is genuinely absent even under this normalization, nothing
changes — the packet falls through to the exact same code as before.

Root cause (confirmed by direct inspection, not assumed): the canonical
NodeStore text for `major_20250205000509` node 1 renders empty table cells as
their own separate lines (e.g. `" |  | "`), while the retrieval index's own
table-to-text serialization omits those lines entirely — a genuine
table-rendering divergence, not a difference in the underlying data or in
which content was actually retrieved.

## Isolation, verified

- 9/9 of the `duplicate_evidence_different_node` packets have Gold's own node
  **not** in the candidate set — the patch's own guard condition is false for
  all of them, so it is structurally impossible for the patch to touch this
  population.
- B and D's entire unresolved population is confirmed 100%
  `duplicate_evidence_different_node` (15/15, 11/11) — zero
  `claim_text_not_in_node` packets exist for either arm, so the patch cannot
  reach B/D's scoring at all.
- **B and D reproduced byte-identical** to the canonical frozen pins
  (`score.B.json` = `92a3b73025c…`, `score.D.json` = `186cf33c1e4…`) after the
  full-batch rescore — confirmed by direct SHA-256, not merely by inspection.
- 11 new regression tests (`scorer-patch-multinode-v1/test_multinode_fix.py`,
  hermetic, no real DocumentIR dependency) plus the frozen package's own
  pre-existing 51-test suite (50 passed; the one failure,
  `test_final_fails_on_missing_results_file`, is confirmed pre-existing —
  reproduced identically against the unpatched original — caused by earlier
  turns' hydrated A/C files already sitting in the shared local scoring
  directory, unrelated to and unaffected by this patch).

## Result: 12 of 22 resolved by a single generic rule, exactly as predicted

Recall numbers are **unchanged** from the pre-patch hydration-only rescore
(A: 0.7587/0.8287/0.8566 @5/10/20; C: 0.7238/0.7587/0.8636) — this patch only
changes how already-determined found/not-found matches are classified for
Owner-review purposes, never the underlying Recall.

| arm | critical | minor | unresolved | hard-safe |
|---|---|---|---|---|
| A | 0 | 13 (12 new `same_evidence_table_rendering_difference` + 1 pre-existing offset/normalization) | **9** (was 21) | yes |
| B (frozen) | 2 | 0 | 15 | no |
| C | 1 (unrelated `row_col_differs`, from the prior hydration turn) | 11 (10 new + 1 pre-existing) | **5** (was 15) | no |
| D (frozen) | 2 | 0 | 11 | no |

Deduplicating A's and C's own unresolved packets by the scorer's own
arm-blind `packet_id` hash: **12 packets resolved, 10 remain**, matching the
exact predicted split with **no packet ID hardcoded** in the fix rule itself
(the rule is generic — node-membership + content-normalization — verified
against real data before being written into code):

- **12 resolved to minor**: `u-17fecb7b46e3`, `u-2345d5c23981`, `u-4867fc90e51b`,
  `u-55e4f67d79e1`, `u-6bfa78c62c56`, `u-91b74251bb8e`, `u-a7d3446ba17d`,
  `u-b652c12b86bf`, `u-c8642db18cf2`, `u-e462edc78fce`, `u-ed6afd9b0dd6`,
  `u-f4499ab8f480` — no longer exist as UNRESOLVED packets at all.
- **10 remain UNRESOLVED**, exactly matching the three predicted categories:
  - 7 same-fact-at-a-different-node (`u-0d1651be7c2e`, `u-14717c25f52d`,
    `u-6c53d4b6b694`, `u-99b67532d0b6`, `u-bb95a8e2ea07`, `u-ea8415e261d8`,
    `u-edcebce21692`) — Gold's own node is genuinely absent from the retrieved
    candidate set; whether the source's own repetition of this fact should be
    treated as `COMMON_SOURCE` is a real Owner policy question this Turn does
    not resolve.
  - 2 clearly-wrong-evidence (`u-47511cac6428`, `u-e4b7183bc619`) — recommend
    `ARM_SPECIFIC`/critical.
  - 1 incomplete-recovery (`u-a2e6569d0ac5`, "conversion_terms") — the chunk
    is a genuine, verified excerpt of the correct node but is truncated
    before the specific required value; recommend `ARM_SPECIFIC`/critical=false.

`ARM_SPECIFIC`'s existing meaning is unchanged anywhere in the scorer: a slot
failure for the affected arm regardless of `critical`, with `critical=true`
additionally failing the hard gate (`adjudication_plan()` untouched). No
`EQUIVALENT_EVIDENCE` or fourth resolution class was introduced.

## Hard / quality gate (unchanged in kind, narrower unresolved population)

Same as the prior hydration-only turn: **A** is the sole hard-safe
(`critical=0`) and quality-gate-passing arm (`ALL=0.8287`, `HIGH=0.816`), LOW
`all_found@10`=16/19. `judgement.json.status` remains `PENDING_UNRESOLVED`
(A/C's own unresolved counts are 9 and 5, not zero) —
**`PROVISIONAL_WINNER=A` is not declared.**

## Owner arm-blind review material (v3, 10 packets)

`official/unresolved-review-template-v3.json` — arm-blind (no arm/score/
rank/candidate anywhere, verified by scan), classification pre-set `UNKNOWN`
for every entry, no automatic classification. Full, SHA-verified,
untruncated text (not the frozen scorer's 400-char export) was used for the
underlying review material, independently re-verified by
`four-arm-owner-review-fulltext-guard.mjs`: `full_text_verified_count=10/10`,
`scorer_400_char_truncation_confirmed_count=10/10`. AI recommendation
distribution: `UNKNOWN`=5, `ARM_SPECIFIC`=3, `COMMON_SOURCE`=2 — all
non-binding. Draft SHA-256: `412c54769078a60096b54461e1d52a1e3ebb3fa982dd86b6aa07ada38194998b`.
Combined SHA-256 of the 10 raw packet files: `3b662957dffcaa2a71f183b1a62b0f2e6e8fc887f9b9bd7c6d09927c498d5d09`.

## Security / access boundary

DEV_CHECK/HOLDOUT: 0 files searched, 0 opened. No retrieval, embedding, or
ranking rerun. No production wiring. No raw chunk text, Gold content, or
evidence span in any committed file — full-text review material and raw
packets stay local-only under gitignored `work/`.

## Final status: `READY_FOR_OWNER_FINAL_ADJUDICATION`

Per Section I's own criteria: the 400-char defect is fixed, the multi-node
scorer fix is complete and isolated (verified byte-identical B/D
reproduction), the 12 clean-fix packets are resolved by a single generic
(non-hardcoded) rule, and the remaining packets are regenerated as an
arm-blind Owner review set awaiting a human decision. No winner is declared.
