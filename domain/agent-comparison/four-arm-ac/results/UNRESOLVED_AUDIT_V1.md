# A/C UNRESOLVED Root-Cause Audit — `FOURARM-AC-UNRESOLVED-AUDIT-V1`

Diagnostic-only turn. **Zero retrieval reruns, zero rescoring, zero result/run file
edits, zero Owner decisions, zero DEV_CHECK access.** This report does not select a
winner and does not relax B/D's frozen `HARD_GATE_FAILED` state.

## A. Invariance re-check (before and after this audit)

- HEAD: `080dd18` (unchanged; worktree was clean at start and end).
- Frozen scorer commit `50cc1aac57145ab7fdb825cbb054842cb993c395`: `SHA256SUMS` 55/55 OK.
- Frozen scorer code SHA (`fourarm.py`, `score.py`): both re-verified byte-identical to
  the pins recorded in `execution-manifest.json.frozen_scorer_code_sha256`.
- A/B/C/D `results.jsonl`/`run.json` SHA: all 8 files re-verified byte-identical to
  `execution-manifest.json.result_run_sha_pre_scoring`/`post_scoring`.
- `judgement.json.status` re-confirmed: `PENDING_UNRESOLVED`, `candidate: A` — unchanged.
- DEV_CHECK/HOLDOUT: 0 files searched, 0 opened (this turn never touches Gold at all,
  only the already-produced `score.*.json`/`results.jsonl`/frozen scorer source).

## B. LOW denominator: conditions=20 vs scorer=19

The conditions artifact (`devtune101_conditions.v2.jsonl`) reports `HIGH=81, LOW=20`
(101 total). Every arm's own scorer output reports `HIGH=81, LOW=19` (100 total).

**One LOW-segment question has `n_slots=0`** in Gold's required-evidence-slot count.
`fourarm.py:260` — `QuestionScore(..., excluded=(n_slots == 0))` — mechanically drops
any question with zero required slots from every segment denominator, because
`Recall = found/n_slots` is undefined at `n_slots=0`. This rule is applied identically
and independently across all 4 arms (confirmed: `n_excluded_zero_slot=1` for A, B, C,
and D alike), which is exactly why the mismatch is uniform rather than arm-specific.

**Verdict: `NORMAL_RULE_APPLICATION`, not a bug.** Cited rule: `fourarm.py:260`.
The excluded question_id (an opaque Gold ID, no question/answer/evidence content) is
`gold_b_e95de359f794df64ffab5044`.

## C. UNRESOLVED population — A/C and their union

No packets were merged or auto-adjudicated; duplicates were identified only by the
frozen scorer's own arm-independent `packet_id_of()` hash
(`question_id|slot_name|doc_id|node_index|reason|chunk_text`, `fourarm.py:451-455`).

| | A | C |
|---|---|---|
| total packets | 229 | 216 |
| unique questions | 81 | 78 |
| unique (question, slot) pairs | 229 | 216 |
| reason code distribution | `no_text_to_verify`: 229 (100%) | `no_text_to_verify`: 216 (100%) |
| packets with non-empty `chunk_text` | 0 / 229 | 0 / 216 |
| locator format | `doc::file::nN`: 229 (100%) | `doc::file::nN`: 216 (100%) |
| multi-node candidate packets | 127 / 229 | 113 / 216 |
| packets per question (p50 / p95 / max) | 2 / 5 / 6 | 2 / 5 / 6 |
| unique doc_ids touched | 84 | 80 |
| duplicate packet_ids within own arm | 0 | 0 |

**A/C overlap (by packet_id, arm-blind hash):** 199 common, 30 A-only, 17 C-only.

**Union:** 246 distinct packets, 85 unique questions, 242 unique (question, slot)
pairs (4 packets share a (question, slot) pair but differ by doc_id/node_index —
i.e. one required slot matched more than one distinct candidate node in a few
cases). 90 unique doc_ids touched; packets-by-doc_id p50/p95/max = 2/5/6; spread
across all 4 corpus doc-groups (major/exchange/periodic/holding all represented —
not concentrated in one document type).

Every single one of the 246 distinct packets carries the identical `reason` code
and an identical empty `chunk_text` — a single uniform signature, not a spread of
independent causes.

## D. Contract transmission-loss check (retriever result → results.jsonl → registry → scorer input → packet)

- **`node_indices` full candidate set: PRESERVED.** 127/229 (A) and 113/216 (C)
  packets are multi-node; `fourarm.py`'s `_result_nodes()` (line 164-168) unions
  `node_index ∪ node_indices` for all membership checks — confirmed by source read,
  **not** first-node-only.
- **`provenance.candidates[]` full objects: NOT PRESERVED.** `reformat_ac.py`'s
  `reformat_result_item()` (lines 54-89) reads the original `provenance.candidates`
  list (per-candidate objects including `node_id`) but only emits a flat integer
  list (`node_indices`); the full per-candidate objects are dropped from the
  committed schema. This currently affects **zero** packets (the scorer only needs
  the int set), but it is a real, separate metadata loss worth flagging for any
  future scorer revision that might want richer per-candidate provenance.
- **row/column/span locator: PRESERVED.** row/col are kept as independent top-level
  fields (not embedded in the locator string); the scorer reads them directly, so
  this representation is fully scorer-compatible.
- **Scorer using only the first node: NO.** Confirmed false by source read
  (`_result_nodes`, `fourarm.py:164-168`).
- **`text` field: DROPPED AT EXPORT — this is the root cause.** A/C's own
  `results.jsonl` result-item schema (both before and after the earlier turn's
  locator/config reformat) never carries a `text`/`chunk_text` field, only
  `chunk_text_sha256` — a deliberate non-leak design choice for the git-committed
  artifact. B/D's own `results.jsonl` (their frozen, gitignored-local package) DOES
  carry a real `text` field. `fourarm.py:323-327`'s `check_locators()` reads
  `r.get("text")` **directly off the result item, not from the NodeStore**, as its
  first content-verification gate: `if not text: severity=unresolved,
  reason=no_text_to_verify`. Because A/C's result items never populate `text`,
  every single slot-match candidate fails this gate before the scorer ever reaches
  its own NodeStore-based comparison (`store.fetch_node`, line 328) — the exact
  mechanism that works correctly for B/D's 15/11 legitimate `unresolved` packets.
- **Recall@k is not contaminated.** `slot_found()` (`fourarm.py:171-228`) treats a
  text-less match as `span_state="blind"` and still counts it as found via
  doc_id+node membership alone — A/C's reported Recall numbers are computed
  independently of this defect. Only the separate `check_locators()` pass (which
  drives the hard/quality-gate critical/minor/unresolved classification) is blind.
- **Metadata-only reconstruction is feasible, in principle.** doc_id+node_index (or
  `node_indices`) is already known for every A/C result item, and the same
  NodeStore the frozen scorer already loads at `data/index/`
  (`store.fetch_node(doc_id, node_index)`) can supply the exact node text with
  **zero new retrieval calls** — a pure re-export step, the same kind of change as
  this session's earlier locator/`config_sha256` reformat. **Not performed this
  turn** (rescoring is explicitly out of scope); whether reconstructed text would
  resolve each of the 246 packets to verified/critical/minor is unknown without an
  actual rescoring pass.
- **Control group (B/D, complete input):** both arms' unresolved packets (15/11) are
  100% `duplicate_evidence_different_node` and 100% carry non-empty `chunk_text` —
  a structurally different, legitimate signature, confirming the frozen scorer does
  correctly separate genuine evidentiary ambiguity from structural gaps when given
  complete input.

## E. Judgement

```
GENUINE_OWNER_REVIEW_REQUIRED:  0
METADATA_CONTRACT_DEFECT:     246   (100% of the A/C union)
FROZEN_SCORER_CONTRACT_GAP:     0
```

**Classification: `METADATA_CONTRACT_DEFECT`** (not `MIXED` — a single, uniform
cause accounts for the entire population). All 246 distinct UNRESOLVED packets
share `reason=no_text_to_verify` with empty `chunk_text`: an export-schema defect
(missing `text` field), not per-item evidentiary insufficiency.

`FROZEN_SCORER_CONTRACT_GAP` is ruled out: the scorer correctly parses A/C's
locator/`node_index`/`node_indices` format (proven by correct Recall@k numbers); it
is not failing to interpret a legitimate provenance format — it is receiving no
text to interpret. No vFINAL §21 resumption is proposed; the scorer's contract
interpretation is not in question here.

`GENUINE_OWNER_REVIEW_REQUIRED` is 0 because no packet in this population has yet
been given the input (`text`) the scorer needs to make even a first-pass
determination — routing these to Owner now would ask a human to judge evidence
they structurally cannot see in the packet.

## F. Owner arm-blind packet preparation

**0 packets prepared this turn.** Per Section E, none of the 246 UNRESOLVED
packets qualify as `GENUINE_OWNER_REVIEW_REQUIRED` while the underlying
`METADATA_CONTRACT_DEFECT` is unresolved — forwarding them now would ask Owner to
classify `COMMON_SOURCE`/`ARM_SPECIFIC`/`UNKNOWN` without the evidence text needed
to judge at all. No new classification categories (e.g. `EQUIVALENT_EVIDENCE`) were
introduced; none were needed since no packet was classified.

Combined SHA-256 of the (empty) prepared packet set: `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`
(`sha256("[]")`), recorded for audit-trail consistency with the non-empty-packet
case.

## G. Scope closed this turn

No A/B/C/D retrieval rerun. No rescoring. No result/run file edits (all 8 files
re-verified byte-identical, see Section A). No Owner decision generated. No
DEV_CHECK execution. No winner declared or implied — `judgement.json.status`
remains `PENDING_UNRESOLVED`, mapped to `BLOCKED`, exactly as before this turn.

Full per-packet detail (question_id/doc_id/node_index-level; no chunk_text exists
in this population to leak) is preserved locally only, under gitignored
`work/bd_handoff/unresolved_audit/` — not committed.
