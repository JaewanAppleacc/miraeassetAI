# FOURARM-A2-INTEGRATION-AND-DEVTUNE-V1 — pre-registration amendment

Committed before opening any new A2 score, any new critical-item result, or
re-reading `A.results.jsonl`/Gold for this turn. Fixed here and not revised
after results are seen.

## Source / branch

- Base branch: `codex/fourarm-alternate-node-review-integration-v01`
- Base SHA: `622759a39681f96d00d103eca53d07276b705a29`
- Merged (fast-forward, then merge commit): `codex/fourarm-a2-scope-validator-v01` @
  `a96d4ee61f397cb336cdd58665400d1d272b2d11`, `codex/fourarm-a2-late-expansion-v01` @
  `fedacd365913972a5513f425b1b58d47ef3ea592`
- New worktree: `agent-fourarm-a2-integration-v01`
- New branch: `codex/fourarm-a2-integration-v01`

## A2 pipeline (fixed, no substitutions)

```
frozen Arm A top-20 (A.results.jsonl, unchanged)
  -> node-grounded late expansion (a2-node-grounded-evidence.mjs)
  -> evidence scope/period/unit/sign/row-column/entity validator
     (a2-evidence-scope-validator.mjs)
  -> keep PASS only
  -> stable refill over original top-20 rank order
     (a2-stable-evidence-filter.mjs)
  -> final top-10 evaluated
```

No new search, embedding, or reranking of any kind is introduced. No
component other than the three listed modules participates in producing
A2's candidate set or ordering.

## Fixed limits and rules (not adjustable after seeing results)

- Input: frozen Arm A top-20 only (`A.results.jsonl`, this branch's copy,
  byte-unchanged).
- BM25 / dense / RRF / KURE re-execution: 0 calls.
- No new candidate generation of any kind.
- Candidate nodes per evidence item: maximum 8.
- Expanded text budget: maximum 12,000 characters total per evidence item.
- Per-node text budget: maximum 6,000 characters.
- Only `PASS` evidence is adopted into the final set.
- `REJECT` and `UNRESOLVED` are never adopted.
- Refill preserves the original Arm A rank order exactly (stable
  subsequence) — no re-scoring, no re-sorting, no tie-break change.
- Candidates outside the original top-20 are never used, at any stage.
- Final evaluated cutoff: top-k = 10.
- Reported recall cutoffs: Recall@5 / Recall@10 / Recall@20.
- Execution: the full 101-item DEV_TUNE batch, run exactly once, in a
  single batch.
- No partial-question re-run: a partial or per-question re-execution of
  DEV_TUNE-101 after this turn's single run is out of scope; an
  infrastructure failure is recovered only by re-running the same pinned
  batch (or a verified checkpoint of it), never by cherry-picking questions
  after seeing their outcome.

## Q2–Q4 period-qualifier handling (fixed, no loosening)

A period phrase for Q2, Q3, or Q4 with no explicit 누적/3개월 (or
equivalent) qualifier does not get an automatic `PASS` or automatic
`REJECT`. If the actual fetched node cannot itself resolve whether the
value is the quarter-only or year-to-date cumulative figure, the evidence
stays `UNRESOLVED`, per the pre-registered scope-validator design
(`A2_SCOPE_VALIDATOR_V1_AMENDMENT.md`, `A2_SCOPE_VALIDATOR_V1_HANDOFF.md`).
This turn does not add a heuristic, default, or fallback that resolves this
ambiguity in either direction.

## Pass/fail thresholds (fixed before results)

A2 is adopted (`PROVISIONAL_RETRIEVAL_CORE=A2`) only if **all** hold:

- critical violation count = 0
- locator/provenance critical violation count = 0
- unresolved count among evidence actually selected into the final top-10 = 0
- overall Recall@10 >= 0.8117
- HIGH-tier Recall@10 >= 0.798
- LOW-tier all-required-slots-found@10 >= 15/19

If any safety/critical gate fails (critical or locator/provenance hard
gate): `NO_SELECTION_BLOCKED`.
If safety gates pass but any quality threshold above fails:
`A2_REMEDIATION_QUALITY_GATE_FAILED`.
If the execution/contract gate in Section E of the task (integration
contract, real fetchNode, zero new retrieval calls, zero DB writes, frozen
input SHA match, original-results invariance, scorer SHA match) is not
fully green: `BLOCKED_CONTRACT`, and DEV_TUNE-101 is not executed at all.

None of the above thresholds, validator rules, or expansion limits are
changed after this turn's results (or lack thereof) are seen.

## Real fetchNode (Section C) — scope fixed here

The read-only fetchNode adapter added this turn is a new file, separate
from `arm-retriever-adapter.mjs`'s existing `fetch_node()` (whose meaning
is not changed). It must resolve exact `(document_id, node_index)` pairs
against the actual corpus/NodeStore the READY retrieval index references,
never fall back to another document/node, never accept Gold or the
question text as a lookup key, never write to any store, and never use
fetched text to influence ranking. If no real, populated NodeStore is
reachable from this environment, the adapter fails closed (every lookup
resolves `UNRESOLVED`) rather than fabricating or substituting content —
this is a pre-registered fallback behavior, not a decision made after
seeing what a live connection would return.

## What this turn does not do

- Does not read Gold, DEV_CHECK, or HOLDOUT content.
- Does not use a question's Gold answer to select, expand, or validate a
  node.
- Does not modify `A.results.jsonl`, `A.run.json`, or any B/C/D result/run
  file, or the frozen scorer.
- Does not change validator rules, expansion limits, or thresholds after
  results are seen.
