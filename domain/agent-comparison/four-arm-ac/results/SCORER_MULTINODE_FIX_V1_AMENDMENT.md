# `FOURARM-SCORER-MULTINODE-FIX-V1` — Pre-Fix Amendment

Written and committed **before** the patch is applied or any new score is viewed,
per this Turn's Section D. Pins the defect, the exact fix rule, and the allowed
outcome branches.

## Pinned facts

- **Base HEAD**: `cf46981` (`cf469818a7b606a031c0738924943c2781739606`), new branch
  `codex/fourarm-scorer-multinode-fix-v01`.
- **Frozen scorer commit being patched**: `50cc1aac57145ab7fdb825cbb054842cb993c395`
  (`ac_scorer_50cc1aa`). The upstream commit itself is never altered; a locally
  patched fork is created under this repo, versioned and SHA-recorded separately
  (see "Scorer version/SHA" below) so it is never confused with the upstream pin.
- **Superseded material**: every recommendation and draft produced from the
  400-char-truncated packet view (`FOURARM-OWNER-REVIEW-V2`'s first pass) is
  `SUPERSEDED_TRUNCATED_REVIEW`. The already-corrected full-text review
  (`packets_review_v2.json`, draft SHA `e73e5b909f1d215c265f51a034c445379f98cf05c3b866bfa00d95c6c3293408`,
  independently verified by `four-arm-owner-review-fulltext-guard.mjs`:
  `full_text_verified_count=22/22`, `scorer_400_char_truncation_confirmed_count=22/22`)
  is the correct starting point for this Turn and is **not** further superseded by
  this amendment — it is the input this fix is validated against.

## Defect: table-rendering divergence, not missing evidence

Root cause, confirmed by direct inspection of real packets (not assumed):

For the 13 `claim_text_not_in_node` packets, `check_locators()`
(`fourarm.py:323-333`) compares the retrieved chunk's own recorded text against
the concatenation of `store.fetch_node(doc_id, n)` for `n` in the multi-node
union (`node_index ∪ node_indices`, via `_result_nodes()`), using only
whitespace-collapsing normalization (`norm_text`). Direct inspection of
`u-17fecb7b46e3` (doc `major_20250205000509`, candidate nodes `[0,1,2,3]`, Gold's
own designated node `3` already inside that set) shows the divergence: the
canonical `NodeStore` text for node 1 begins with four empty-cell pipe markers
(`||||금융위원회...`) that the retrieval index's own table-to-text serialization
does not reproduce (`금융위원회...` with no leading pipes) — a genuine
table-rendering difference in how empty cells are serialized, not a difference
in the underlying data. Once this divergence occurs, every later character
position is shifted, so the containment check fails even though the same
content is present in both texts. The same empty-row-pipe pattern was directly
confirmed in `u-4867fc90e51b` (doc `major_20250818000219`) as well.

This defect affects **only** the `claim_text_not_in_node` branch. It is
structurally impossible for it to affect `duplicate_evidence_different_node`
(which is a **different**, later `check_locators` branch reached only when the
`claim_text_not_in_node` check has already **passed** — i.e. a packet cannot be
both), or B/D's own unresolved population, which is confirmed 100%
`duplicate_evidence_different_node` (15/15 for B, 11/11 for D) and contains zero
`claim_text_not_in_node` packets. B/D are therefore expected to reproduce
byte-identical after this patch.

## Fix rule (exact, pinned before any new score is viewed)

Inside the existing `claim_text_not_in_node` branch only, **before** falling
through to the existing `unresolved` verdict:

1. Only proceed if Gold's own designated node for this exact slot match
   (`m["gold_node"]`, already computed by the existing `slot_found()` — not
   re-derived) is a member of the same node union already computed at
   `fourarm.py:318` (`nodes = sorted(_result_nodes(r))`). If Gold's node is
   **not** in the candidate set, this packet is untouched and keeps its
   existing behavior (this is exactly the `duplicate_evidence_different_node`
   population's own condition — already false for all 9 of those packets,
   confirmed empirically, so this guard alone provides full isolation).
2. Re-derive a **content-preserving** normalization that, in addition to
   `norm_text`'s whitespace collapse, strips lines that are structurally empty
   table rows/cells (a line whose only characters are whitespace or `|`) —
   applied identically to both the chunk's own text and the concatenated
   node-store text. This never removes or alters any line carrying real
   content; it only removes empty-row noise of exactly the kind found above.
3. Check two conditions under this normalization:
   a. the chunk's own (table-aware-normalized) text is contained within the
      table-aware-normalized concatenated node text (proves the chunk is a
      genuine, uncorrupted excerpt of the correct node(s), only differently
      rendered around empty cells); **and**
   b. at least one line of Gold's own evidence_span (using the existing
      `span_lines()` six-character-minimum rule, already used elsewhere in this
      file) is present, under the same normalization, within the chunk's own
      text (proves the specific required evidence is actually present, not
      merely that the chunk is undamaged).
4. If **both** (a) and (b) hold: `severity="minor"`,
   `reason="same_evidence_table_rendering_difference"` — the slot stays found,
   this does **not** create an `unresolved` packet, and it has no hard-gate
   effect. This mirrors the existing, already-frozen
   `same_evidence_offset_or_normalization` minor pathway, extended to the
   multi-node/table-rendering case specifically.
5. If (a) holds but (b) does not (the chunk is a genuine, correct excerpt but
   does not happen to contain the specific required value — e.g. it is
   truncated before reaching it): **no automatic classification is added.**
   The packet falls through to the existing, unmodified `unresolved` /
   `claim_text_not_in_node` verdict, exactly as before this patch. This Turn's
   own report may recommend `ARM_SPECIFIC`/`critical=false` for such a packet
   as an **AI recommendation only** (per the existing arm-blind Owner-review
   process already in use) — the frozen scorer itself never emits an
   `ARM_SPECIFIC` verdict, and no `resolutions.json` entry is written or
   signed by this Turn.
6. If (a) does not hold, nothing changes: the existing `unresolved` /
   `claim_text_not_in_node` verdict is unchanged.

## What this patch explicitly does **not** do

- It does not change `ARM_SPECIFIC`'s existing meaning anywhere else: a slot
  failure for the affected arm regardless of `critical`, with `critical=true`
  additionally failing the hard gate. That mechanism (`adjudication_plan()`,
  `fourarm.py:504-545`) is untouched.
- It does not introduce `EQUIVALENT_EVIDENCE` or any fourth resolution class.
  `COMMON_SOURCE` / `ARM_SPECIFIC` / `UNKNOWN` remain the only three.
- It does not relax `duplicate_evidence_different_node` handling in any way —
  a different node's matching text is still never auto-resolved by the scorer,
  by construction (see isolation argument above).
- It does not touch A/C's own `results.jsonl`/`run.json`, B/D's results or
  score, or the existing Owner `resolutions.owner.json`/`resolutions.json`.
- It performs no retrieval, embedding, or ranking of any kind — it only
  changes how already-retrieved, already-SHA-verified chunk text is compared
  against the already-built DocumentIR NodeStore.
- No DEV_CHECK/HOLDOUT access.

## Scorer version / SHA

The patched fork is recorded as `ac_scorer_50cc1aa+multinode-fix-v1`. Its own
`fourarm.py` SHA-256 (post-patch) is recorded separately once the patch is
applied (see the commit that follows this amendment); the upstream frozen
commit `50cc1aac5…` and its unpatched `fourarm.py` SHA
(`d62499328a43e5b9811c98c8fd810d423abc746152843db93880638f4a9dad0e`) remain the
permanent reference point and are never overwritten.

## Rule freeze

No additional rule changes are made after this point based on what the
resulting scores turn out to be. If the patch does not cleanly resolve the 12
packets identified as `claim_text_not_in_node` candidates using this exact,
generic (non-packet-ID-hardcoded) rule, the outcome is `BLOCKED_CONTRACT`, not
a further ad hoc rule adjustment.
