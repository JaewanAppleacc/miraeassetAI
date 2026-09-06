# A-REMEDIATION-REPLAY-CONTRACT-V2 — Amendment

Written and committed BEFORE the remediation-v1 run is executed or any recall/critical
number for it is produced or viewed. Fixes the independent re-confirmation of the prior
BLOCKED_CONTROL_REPLAY, the actual (not guessed) approved scorer pin, the locator
compatibility-view contract, and the decision rule.

## 0. Starting-point verification

```text
new worktree:          agent-a-remediation-replay-v02
new branch:             codex/a-remediation-replay-contract-v02
checked out from:      feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
                        (verified via `git ls-remote demo-ai-festival` -- exact match)
prior validation branch: codex/a-remediation-validation-v01 @ d07fc6d99dd42baa3efe1df23838475d38822260
                        (verified via `git ls-remote origin`/`git ls-remote demo-ai-festival`
                        -- both match)
frozen submission (input reference only, never checked out into this worktree, never
written to): codex/a4-a3-plus-qa-frozen-v01 @ 6e24545671892a1222d75453d4e74547646aa489
                        (verified via `git ls-remote origin` -- exact match)
working tree:          clean immediately after worktree creation
npm install:           524 packages, clean, identical to the prior validation worktree
```

## 1. Independent re-confirmation of the prior BLOCKED_CONTROL_REPLAY (done before this
document)

Re-ran `scripts/fourarm/score.py --arms A --no-locator-check` (existing, unmodified) against
the prior turn's own already-produced control output
(`agent-a-remediation-validation-v01/work/a-remediation-review/control/A.results.ndjson`,
untouched since that turn, never re-executed) from a fresh shell, no code changes:
reproduces the exact same crash reported before —

```text
TypeError: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'
  at fourarm.py:191, in slot_found()'s `ok()` closure: int(r.get("node_index", -1))
```

confirming the root cause is real and reproducible, not a one-off artifact of the prior
turn's environment. Root cause (also independently re-derived): `git log a5c1c87..900d3cc`
shows the intervening commits that added multi-node-ambiguous locator resolution
(`provenance.candidates[]`, `node_index: null` for ambiguous items) after the committed
`A.results.jsonl` reference was produced (`code_sha256=a5c1c87`).

## 2. Approved scorer pin — read from the actual manifest, not guessed

Per this turn's own step 4, checked `codex/fourarm-bd-final-handoff-v01`'s
`handoff/fourarm_bd_final_v01/MANIFEST.json` (fetched fresh from `demo-ai-festival`) rather
than assuming any SHA:

```json
"authoritative_scorer_commit": "50cc1aac57145ab7fdb825cbb054842cb993c395"
```

Cross-checked independently against the frozen submission itself
(`git log --oneline -1 6e24545 -- scripts/fourarm/score.py src/dart_corpus/evaluation/fourarm.py`)
-> both files' last-touching commit in the frozen candidate's own history is `50cc1aa` --
**matches exactly**, confirming the frozen submission still uses this exact scorer, unchanged.
Content hashes (computed via `git show 6e24545:<path> | sha256`, not the frozen candidate's
working tree, so this reads history, not disk state):

```text
scripts/fourarm/score.py                    sha256=4f2a4c1063cabbd698e3f548b1ce87d957252736b7f1f34a4e5db77c598de124
src/dart_corpus/evaluation/fourarm.py       sha256=d62499328a43e5b9811c98c8fd810d423abc746152843db93880638f4a9dad0e
```

**These files are not modified by this turn, at all.** The compatibility view (§3) is a
separate, new, read-only transform that runs *before* the scorer sees the data.

The same manifest also pins `documentir_files` (exchange/holding/major/periodic SHA-256)
and `doc_index_sha256`/`node_offsets_sha256` (a previously-built `data/index/`). Both are
re-verified in §4 below.

## 3. Locator compatibility view — contract (fixed before any result)

A new script (`scripts/a-remediation-locator-compat-view.py`, added this turn, does not
modify `scripts/fourarm/score.py` or `src/dart_corpus/evaluation/fourarm.py`) transforms a
raw `A.results.<policy>.ndjson` (JS runner output, real `provenance.candidates[]`) into a
`{arm}.results.jsonl` the existing scorer can consume without crashing, subject to:

```text
- Retrieval reproducibility is judged ONLY on: question_id, rank, doc_id, chunk_id,
  chunk_text_sha256 ("text_sha" in the task's own wording), score. node_index/node_indices/
  provenance are explicitly EXCLUDED from the reproducibility check this time (last turn's
  own mistake: it required exact node_index/node_indices match, which broke on a legitimate,
  additive schema upgrade) -- locator correctness is instead judged separately, by semantic
  equivalence (below), never by byte-for-byte field match.
- Every raw item's node reference is fully understood: node_index (if not null),
  node_indices (if present), AND every provenance.candidates[].node_index (if a provenance
  block is present) are unioned into one set -- the FULL candidate node union, never reduced
  to "the first node" or any single representative pick.
- The view's own node_index field (required by the existing scorer's `_result_nodes()` and
  `check_locators()`, both written for a scalar) is set to min(node_union) -- a
  deterministic, order-independent representative -- and node_indices is set to
  sorted(node_union) IN FULL, so `_result_nodes()`'s `{node_index} | set(node_indices)`
  recovers the complete original union regardless of which element node_index happens to
  be. No candidate is dropped, ever.
- row/col are passed through only when every candidate in the union agrees on the same
  (row, col) pair (an unambiguous single-cell reference); otherwise both are set to null
  (ambiguous -- matches the existing scorer's own "coarse: no_row_col_in_chunk" category,
  never fabricated as a false single value).
- Semantic equivalence check (separate from reproducibility, run for every item that HAS a
  provenance block): the resolved node union's node_id document prefix must equal the
  item's own doc_id for every candidate -- if any candidate's node_id belongs to a
  different doc_id, OR if the resolved node union is empty, the view generation
  **fails closed for the entire run** (writes nothing, exits non-zero, same discipline as
  the existing, unmodified `p11f0-fourarm-scoring-view-hydrator.mjs`) -- never silently
  drops the offending item or substitutes a guess.
- Uses ONLY the pinned DocumentIR (§4) for anything requiring real document text/structure
  (i.e., building `data/index/` for the real `NodeStore`-backed locator check) -- never a
  different or partial copy.
- The original `*.ndjson` raw runner output and the committed `A.results.jsonl` are opened
  read-only and never modified; the view is a new file in gitignored `work/`.
```

## 4. Real NodeStore-backed scoring (upgrade over the prior turn's `--no-locator-check`)

The prior turn's environment-limitation note assumed the 8GB DocumentIR was completely
absent; it was subsequently found at
`~/Downloads/drive-download-20260804T043134Z-1-002/` (exchange/holding/major/periodic,
SHA-256-verified against the very same pins recorded in the frozen submission's
`A.run.json` AND in `handoff/fourarm_bd_final_v01/MANIFEST.json`). Per this turn's own
"pinned DocumentIR만 사용" instruction, `data/index/` was rebuilt this turn (read-only
symlinks into a local `work/document-ir-staging/` directory inside THIS worktree only --
the user's `~/Downloads` and the frozen QA worktree are never written to) via the existing,
unmodified `scripts/build_index.py` (invoked by absolute path from the frozen QA worktree,
output directed to `work/a-remediation-review-v2/data-index/` inside this worktree only):

```text
doc_index_sha256:    c93c18f71ca18cf319e365793fde5e87a0bce470b8d275d65c3881a26d5f5f86  -- MATCHES manifest pin
node_offsets_sha256: 99179bd7f7b536d67bc8d876e3fecf588219f008cc27512551dcb0a28314051c  -- MATCHES manifest pin
n_docs: 4204, n_missing_manifest: 0, elapsed_s: 71.4
```

Byte-for-byte reproduction of the previously-built, manifest-pinned index. This means
`scripts/fourarm/score.py` can run **without** `--no-locator-check` this time --
`critical`/`minor`/`unresolved`/`coarse` will be real, `locator_checked: true`, not the
"not evaluated" placeholder from the prior turn. This is a genuine capability upgrade
discovered before any remediation result was seen, not a criterion changed in reaction to
one -- same discipline as this project's own precedent for a real defect found via a
non-Gold check and fixed pre-result.

## 5. Commands (fixed, run in this order)

```bash
# Control (frozen policy) -- fresh run in this worktree for a self-contained audit trail
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A \
    --batch-id <new random hex> --out-dir work/a-remediation-review-v2/control

# Candidate (remediation-v1 policy) -- ONLY if control replay (rank/doc_id/chunk_id/
# chunk_text_sha256/score, all 101 questions) succeeds
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --policy remediation-v1 \
    --batch-id <new random hex> --out-dir work/a-remediation-review-v2/candidate

# Text hydration (existing, unmodified hydrator's exported functions, same driver script
# pattern as the prior turn -- reused, not rewritten)
DATABASE_URL=... node scripts/a-remediation-validation-hydrate.mjs --in ... --out ...
  # (ported byte-identical from the prior turn's branch; see §7)

# Locator compatibility view (new, this turn -- §3)
python3 scripts/a-remediation-locator-compat-view.py --in <hydrated results> --out <path>

# Scoring (existing, unmodified scorer; REAL index this time, no --no-locator-check)
QA=/Users/jaewan/Documents/Codex/worktrees/agent-a4-a3-plus-qa-final-v01
python3 "$QA/scripts/fourarm/score.py" --arms A \
  --gold "$QA/data/eval/phase1_devtune_gold.v0.1.jsonl" \
  --conditions "$QA/data/eval/devtune101_conditions.v2.jsonl" \
  --index-dir work/a-remediation-review-v2/data-index \
  --results-dir <control or candidate results dir>
```

## 6. Metrics (identical definitions to the prior turn's amendment, now backed by a real
NodeStore locator check instead of `--no-locator-check`)

```text
Recall@5/10/20 (ALL/HIGH/LOW), LOW all_found@10  -- score.A.json segments.{ALL,HIGH,LOW}
critical/minor/unresolved/coarse                  -- score.A.json violations, locator_checked=true
zero-result question count                        -- raw results with results == []
improved/regressed/unchanged                       -- per-question found@10 diff, control vs candidate
date-anchored / subtype-narrowed recovery          -- same methodology as the prior amendment
                                                     (question full-date regex + doc_groups /
                                                     exchange_subtypes|periodic_subtypes non-empty,
                                                     control all_found@10=False -> candidate=True)
correction-notice ("정정") presence change          -- diagnostic only, metadata.is_correction
p50/p95/max latency                                -- each run's own *.run*.json
retrieval passes/question                           -- candidate's own retrieval_pass/retrieval_group
```

## 7. Decision rule (fixed before any result)

```text
BLOCKED_CONTROL_REPLAY   if, using the compatibility view, the control run's
                         question_id/rank/doc_id/chunk_id/chunk_text_sha256/score do not
                         reproduce the committed A.results.jsonl exactly for any question,
                         OR the compatibility view itself fails closed (§3) for any item, OR
                         the rebuilt data/index/ does not match the manifest's pinned
                         doc_index_sha256/node_offsets_sha256.

REMEDIATION_REJECTED_SAFETY  if control replay succeeds but, versus control: any HIGH or
                         LOW Recall@10 regression, any increase in zero-result question
                         count, or any increase in critical-severity locator violations.

REMEDIATION_NOT_ADOPTED  if neither of the above fires, but Recall@10 (ALL) and LOW
                         all_found@10 do not both improve, OR candidate p95 latency exceeds
                         control's by >2x with no proportionate recall gain.

REMEDIATION_RECOMMENDED_FOR_INTEGRATION  if control replay succeeds, no safety regression
                         fires, critical count does not increase, and both Recall@10 (ALL)
                         and LOW all_found@10 improve versus control.
```

Mixed/ambiguous results are reported as `REMEDIATION_NOT_ADOPTED` with the full breakdown
shown, never rounded up.

## 8. Confirmed in advance

```text
old-style node_index fabricated by discarding provenance: never -- §3's view ADDS node_index/
                                                            node_indices alongside the
                                                            original provenance, never removes it
first-node collapse:                                       never -- full union preserved (§3)
original A results / frozen scorer files modified:         never
policy changed after seeing a result:                      none -- this document is final
                                                             before §9 onward is written
partial question re-runs:                                  none -- full 101 both runs
DEV_CHECK / HOLDOUT access:                                 none
frozen submission branch:                                   never checked out/modified
```
