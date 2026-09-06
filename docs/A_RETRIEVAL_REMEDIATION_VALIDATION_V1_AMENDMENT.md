# A-RETRIEVAL-REMEDIATION-VALIDATION-V1 — Amendment

Written and committed BEFORE the frozen control run, the candidate run, or any scored
number is produced or viewed. Fixes commits, commands, metric definitions, an environment
limitation and its handling, and the decision rule so none of them can be adjusted after
seeing a result.

## 0. Starting-point verification (done before this document)

```text
new worktree:          agent-a-remediation-validation-v01
new branch:             codex/a-remediation-validation-v01
checked out from:      feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
                        (verified via `git ls-remote demo-ai-festival feat/fourarm-a-retrieval-remediation-v01`
                        -- exact match, fetched fresh)
frozen submission baseline (input reference only, never checked out into this worktree,
never written to): codex/a4-a3-plus-qa-frozen-v01 @ 6e24545671892a1222d75453d4e74547646aa489
                        (verified via `git ls-remote origin` and `git ls-remote demo-ai-festival`
                        -- both match exactly)
working tree:          clean immediately after worktree creation
npm install:           524 packages, clean, no source changes
```

## 1. What "Frozen A" actually is (derived, not assumed)

The task names the frozen submission baseline as `codex/a4-a3-plus-qa-frozen-v01 @ 6e24545`,
but that commit is the QA-serving repo's own docs/config lineage — it does not contain the
four-arm-ac retrieval implementation files at all (`git ls-tree` on that commit has no
`domain/agent-comparison/four-arm-ac/` or `scripts/p11f0-fourarm-devtune-ac-run.mjs`). The
actual Arm A retrieval CODE embedded in that submission (via the vendored
`config/a4-a3-runtime-source-manifest.v1.json` byte-identical import from
`codex/fourarm-a4-a3-devtune-v01 @ 3ee4462`) was traced with `git merge-base`:

```text
git merge-base --is-ancestor 900d3cc72336a1aece86ec776d84f55ec3564cc8 3ee4462026126a0dd8fc5c99a6d83df510a84058
  -> true (900d3cc is an ancestor of 3ee4462)
git diff --stat 900d3cc 3ee4462 -- domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs \
  domain/agent-comparison/retrieval/ domain/chunking/ domain/retrieval/
  -> empty (zero changes to any core Arm A retrieval file between 900d3cc and 3ee4462;
     every file 3ee4462 adds on top of 900d3cc is a new, additive A4/A3-only file)
git merge-base b30b909dad9b56d22dc116f1fffb041e0d69e5ff 3ee4462026126a0dd8fc5c99a6d83df510a84058
  -> 900d3cc72336a1aece86ec776d84f55ec3564cc8
```

This proves `900d3cc` (`codex/fourarm-a2-integration-v01`, "feat(a2): wire real DocumentIR
NodeStore fetchNode; DEV_TUNE-101 -> NO_SELECTION_BLOCKED") is **exactly** the fork point:
the remediation branch (`c6b9a19` onward, culminating in `b30b909`) branches from it, and the
frozen submission's own vendored Arm-A-adjacent code is a strict descendant of it with zero
retrieval-file changes in between. So "Frozen A" = the retrieval behaviour at `900d3cc`,
which — per the remediation branch's own design — is preserved byte-identically inside
`b30b909` itself as `FROZEN_POLICY` (the default policy every caller gets unless
`--policy remediation-v1` is passed). **Both the control and candidate runs therefore use
the SAME checked-out code (`b30b909`), differing only by the `--policy` CLI flag** — this is
not a shortcut, it is the exact mechanism `domain/agent-comparison/four-arm-ac/A_RETRIEVAL_REMEDIATION_V1_HANDOFF.md`
itself specifies ("every caller that does not name a policy gets FROZEN_POLICY = the
byte-identical code path that produced the committed results").

There already exists a **committed, official Arm A DEV_TUNE-101 result**
(`domain/agent-comparison/four-arm-ac/results/A.results.jsonl` + `A.run.json`, present at
`900d3cc` unchanged, `code_sha256=a5c1c8730225d0905b37c0ee8561e9563a56a30d`,
`config_sha256=399bcd59944319e232aa428e47befe54fbb8f7cc1b44eed9d72a28d3e3dbbbc3`,
`results_sha256=1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156`). This is the
"기존 A 결과" step 4 requires the control run to reproduce on retrieval fields — never
overwritten by anything in this turn.

## 2. Environment limitation, fixed in advance: critical/minor/unresolved is NOT independently
computable in this environment

`scripts/fourarm/score.py` (the Python scorer used throughout this project's whole B/D/A/C
history — confirmed identical `EXPECTED_CONDITIONS_SHA256`/owner-decision SHA between the
JS harness and the Python `data/eval/devtune101_conditions.v2.jsonl`) computes
`critical`/`minor`/`unresolved`/`coarse` counts **only** via `check_locators(qs, store)`,
gated by `store = None if args.no_locator_check else NodeStore(args.index_dir)`
(`scripts/fourarm/score.py`). `NodeStore.__init__` unconditionally reads
`<index_dir>/index_manifest.json` and `<index_dir>/node_offsets.jsonl` — verified empirically
in this environment: `data/index/` does not exist in the QA worktree
(`codex/a4-a3-plus-qa-frozen-v01`), and no `document_ir` source directory exists anywhere on
this machine (searched all mounted volumes) — `scripts/build_index.py` cannot rebuild it
either, since its own input is that same absent 8GB DocumentIR source. This is the same,
already-documented, pre-existing environment gap noted in this project's own history
(`docs/reports/A4_A3_PLUS_QA_SELF_CONTAINED_AND_JUDGE_V1.md` §4: "a pre-existing, gitignored
local-data precondition ... not present in this environment for EITHER backend"). It is not
new to this turn and not something this turn can fix without rebuilding an index from data
that is not here (`재청킹·인덱스 재구축` is explicitly prohibited by this turn's own rules
regardless).

Consequence, fixed now: `scripts/fourarm/score.py --arms A --no-locator-check` will be run
for both control and candidate. `score.{arm}.json`'s `violations.critical/minor/unresolved`
will read `0/0/0` in that mode **not because no violations exist, but because
`check_locators` never runs** — the score object's own `locator_checked: false` field is the
authoritative marker of this, and every mention of `critical`/`minor`/`unresolved` in this
turn's final report **must** be printed alongside that `locator_checked` value, never as a
bare number. `Recall@k`/`all_found@k` are **not** blocked by this: `slot_found()` matches
directly against each result item's own `text` field (hydrated separately, see §3) against
Gold span lines; `store` is only used for one additional disqualification check ("this is
the right node's wrong text window") that makes matching **stricter**, not more lenient, when
available. Without it (`store=None`), matching is marginally more permissive — applied
identically to both the control and candidate runs, so it does not bias the relative
comparison this turn exists to make, but it is disclosed here so recall numbers are not read
as an absolute, NodeStore-verified figure.

**How this limitation is handled in the decision rule**: §6 below adds an explicit
substitute safety check (zero-result count, per-question regression count, HIGH/LOW
Recall@10 non-degradation) precisely because the true critical/minor/unresolved axis cannot
be independently certified here. `REMEDIATION_RECOMMENDED_FOR_INTEGRATION`, if reached, is
reported with this caveat attached verbatim — it is a recommendation for the next stage
(a full NodeStore-backed critical audit on a machine with DocumentIR access), never a
substitute for one.

## 3. Text hydration (required for `slot_found` to do anything beyond blind doc/node
matching)

Neither the committed `A.results.jsonl` nor the JS runner's fresh output includes a `text`
field per result item (only `chunk_text_sha256`) — confirmed by inspection. The already-
existing, unmodified, read-only hydrator (`scripts/p11f0-fourarm-scoring-view-hydrator.mjs`,
from `docs: commit cf46981`, present unchanged in `b30b909`) does exactly this, but its own
`main()` hard-codes the committed-results path. Its two exported functions
(`assertReadyIndex`, `hydrateArm`) are already parameterized by input path and are reused
**unmodified** by a new, small driver script this turn adds
(`scripts/a-remediation-validation-hydrate.mjs`) that calls them against this turn's own
control/candidate output paths instead. Same safety contract, verbatim: exact `chunk_id`
lookup against the same READY index, `sha256(text_content) == chunk_text_sha256` and
`source_document_id == doc_id` required for every item, abort entirely (write nothing) on
any single failure, field-level invariance check that only `text` was added. This is a new
file, not a modification of the existing hydrator or of any frozen/committed result.

## 4. Commands (fixed, run in this order)

```bash
# Control (frozen policy = default, no --policy flag) — NEW output dir, never overwrites
# the committed domain/agent-comparison/four-arm-ac/results/A.results.jsonl
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A \
    --batch-id 090d62ecd2685974 --out-dir work/a-remediation-review/control

# Candidate (remediation-v1 policy), same code checkout, same batch semantics, separate dir
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A --policy remediation-v1 \
    --batch-id 35ea2cb7bfcbfa2f --out-dir work/a-remediation-review/candidate

# Hydration (new driver reusing the existing hydrator's exported functions unmodified)
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
  node scripts/a-remediation-validation-hydrate.mjs \
    --in work/a-remediation-review/control/A.results.ndjson --out work/a-remediation-review/control
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
  node scripts/a-remediation-validation-hydrate.mjs \
    --in work/a-remediation-review/candidate/A.results.remediation-v1.ndjson --out work/a-remediation-review/candidate

# Scoring (existing, unmodified Python scorer; gold/conditions read from the frozen QA
# worktree by absolute path, READ-ONLY, never written to)
QA=/Users/jaewan/Documents/Codex/worktrees/agent-a4-a3-plus-qa-final-v01
python3 "$QA/scripts/fourarm/score.py" --arms A --no-locator-check \
  --gold "$QA/data/eval/phase1_devtune_gold.v0.1.jsonl" \
  --conditions "$QA/data/eval/devtune101_conditions.v2.jsonl" \
  --results-dir work/a-remediation-review/control
python3 "$QA/scripts/fourarm/score.py" --arms A --no-locator-check \
  --gold "$QA/data/eval/phase1_devtune_gold.v0.1.jsonl" \
  --conditions "$QA/data/eval/devtune101_conditions.v2.jsonl" \
  --results-dir work/a-remediation-review/candidate

# Diagnostic-only chunk metadata lookup (is_correction/doc_subtype/receipt_date), read-only
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
  node scripts/a-remediation-validation-fetch-chunk-metadata.mjs \
    --control work/a-remediation-review/control/A.results.jsonl \
    --candidate work/a-remediation-review/candidate/A.results.jsonl \
    --out work/a-remediation-review/chunk_metadata.json

# Per-question diagnostic analysis (new script, §5)
python3 scripts/a-remediation-validation-analyze.py \
  --qa-root "$QA" \
  --conditions "$QA/data/eval/devtune101_conditions.v2.jsonl" \
  --control work/a-remediation-review/control \
  --candidate work/a-remediation-review/candidate \
  --chunk-metadata work/a-remediation-review/chunk_metadata.json \
  --out work/a-remediation-review/analysis.json
```

`--gold`/`--conditions` sha256 will be recorded and confirmed identical to the pins already
recorded throughout this project's history (`7941144c...f102b` and `83d5b8a0...`
respectively) before scoring — same Gold, same conditions, same corpus/index/KURE as every
prior B/D/A/C measurement.

## 5. Metrics and how each is computed

```text
Recall@5/10/20 (ALL)        score.A.json: segments.ALL["recall@5"/"recall@10"/"recall@20"]
HIGH Recall@10              score.A.json: segments.HIGH["recall@10"]
LOW Recall@10               score.A.json: segments.LOW["recall@10"]
LOW all_found@10            score.A.json: segments.LOW["all_found@10"] (count) / LOW question count
critical/minor/unresolved   score.A.json: violations.critical/minor/unresolved -- reported
                            ONLY alongside locator_checked (false in this environment, see §2)
zero-result question count  count of question_ids in the raw results file with results == []
improved/regressed/unchanged  per-question diff: for each question_id, compare
                            slot_found()-derived found-count at k=10 between control and
                            candidate hydrated results (same Gold, same k) -- improved =
                            candidate found > control found, regressed = candidate found <
                            control found, unchanged = equal. Computed by a new, committed
                            analysis script (scripts/a-remediation-validation-analyze.py)
                            that reuses dart_corpus.evaluation.fourarm.slot_found /
                            load_gold directly (imported from the QA worktree by absolute
                            sys.path insert, read-only) -- not reimplemented.
date-condition recovery     count of questions whose Gold conditions/tags indicate a
                            date-anchored filing (question text contains a full date and
                            doc_groups in {exchange, major, holding}) where control's
                            all_found@10 is False and candidate's is True
subtype recovery            count of questions where the extracted doc_subtype narrowed the
                            control pool (0-result or <20-result on the primary pass per the
                            remediation handoff's own diagnosis) and candidate's all_found@10
                            recovers to True
correction-notice change    count of questions whose Gold gold_document_ids or retrieved
                            doc_ids in either run resolve to a 정정 (correction) filing
                            (checked against corp_codes/doc metadata in the conditions file),
                            control vs candidate, reported as a delta -- diagnostic only, not
                            a pass/fail gate
p50/p95/max latency         from each run's own A.run.json / A.run.remediation-v1.json
                            latency_ms block (already computed by the runner itself)
retrieval passes/question   from each candidate result item's retrieval_pass/retrieval_group
                            fields (per the handoff doc, only candidate/remediation output
                            carries this; control/frozen has none by design -- reported as
                            "n/a (frozen policy runs one pass)" for control)
```

## 6. Decision rule (fixed before any result)

```text
BLOCKED_CONTROL_REPLAY  if the control run's retrieval fields (question_id, rank, chunk_id,
                        doc_id, node_index/node_indices, score, chunk_text_sha256) do not
                        reproduce the committed A.results.jsonl exactly, for any question.
                        Latency/code_sha/timestamps are excluded by design (they differ by
                        construction between a fresh run and the original). If this fires,
                        no candidate run is scored and no other verdict is reported.

REMEDIATION_REJECTED_SAFETY  if, versus control: any HIGH or LOW Recall@10 regression, any
                        increase in zero-result question count, or any increase in
                        critical-severity locator violations WHEN locator_checked is true
                        for both (never applicable in this environment per §2, but the rule
                        is stated for completeness/future re-run with DocumentIR access).

REMEDIATION_NOT_ADOPTED  if none of the above fire, but Recall@10 (ALL) and LOW all_found@10
                        do not both improve, OR p95 latency for the candidate exceeds the
                        control's p95 by more than 2x with no offsetting recall gain
                        proportionate to that cost (judged narratively, not a hard formula,
                        and disclosed either way).

REMEDIATION_RECOMMENDED_FOR_INTEGRATION  if control replay succeeds, no safety regression
                        fires, and both Recall@10 (ALL) and LOW all_found@10 improve versus
                        control with zero increase in zero-result questions and zero
                        per-question Recall@10 regressions among LOW-segment questions.
                        Reported with the mandatory §2 caveat: the true critical/minor/
                        unresolved axis was not independently verifiable in this
                        environment and a NodeStore-backed audit (needs DocumentIR access)
                        is a recommended follow-up before integration, not a substitute for
                        this recommendation.
```

Ties or ambiguous mixed results (e.g., ALL Recall@10 improves but LOW all_found@10 does not)
are reported as `REMEDIATION_NOT_ADOPTED` with the full breakdown shown — never rounded up
to a recommendation.

## 7. Confirmed in advance, applies throughout

```text
original A/A4/A3/QA result files: never opened for writing (read via absolute path only
                                   where cited; domain/agent-comparison/four-arm-ac/results/
                                   A.results.jsonl and A.run.json in this worktree are also
                                   never written to by this turn's commands)
partial question re-runs:         none -- both runs cover the full 101 DEV_TUNE-101 batch
corpus re-embedding:               none -- same READY index (fixed_kure_index_8fe191342205848d1d6a6123f38a54e7,
                                   442549 records), same KURE-v1 server (revision
                                   4ed4540949c70b7da2c74004a915e1f2d5e46e4f)
re-chunking / re-indexing:         none -- same BM25 cache directory reused
                                   (~/Library/Caches/ai-festival-p11f0-bm25-index), same
                                   chunking_policy_id (fixed-token-512-o64.v0.1.0)
DEV_CHECK / HOLDOUT access:        none -- data/eval/phase1_devtune_gold.v0.1.jsonl (DEV_TUNE)
                                   only, sha256 pinned above
frozen submission branch:          never checked out/modified in this worktree
policy/gate change after a result: none will be made; this document is not editable after
                                   §8 onward is written
```
