# A-RETRIEVAL-REMEDIATION-VALIDATION-V1 — Final Report

Verdict: **`BLOCKED_CONTROL_REPLAY`**. Per the pre-registered decision rule
(`docs/A_RETRIEVAL_REMEDIATION_VALIDATION_V1_AMENDMENT.md` §6), because the control run's
retrieval fields could not be reproduced against the committed `A.results.jsonl`, **the
candidate (`remediation-v1`) run was never executed and no comparison, recall number, or
recommendation is issued.**

## 1. Pins

```text
new worktree:          agent-a-remediation-validation-v01
new branch:             codex/a-remediation-validation-v01
checked out from:      feat/fourarm-a-retrieval-remediation-v01 @ b30b909dad9b56d22dc116f1fffb041e0d69e5ff
frozen submission (input reference only, never checked out/written to):
                        codex/a4-a3-plus-qa-frozen-v01 @ 6e24545671892a1222d75453d4e74547646aa489
amendment commit:      18ccb7a (pre-registered before any run)
committed A.results.jsonl (unchanged this turn): sha256=1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156
committed A.run.json (unchanged this turn):      sha256=1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395
```

`git status --porcelain -- domain/ scripts/` shows zero modification to any existing
tracked file in this worktree at any point this turn — only new files were added (the
amendment, three small tooling scripts, this report).

## 2. Frozen A derivation (proved, not assumed)

`900d3cc72336a1aece86ec776d84f55ec3564cc8` (`codex/fourarm-a2-integration-v01`) is:

- the exact fork point of the remediation branch (`git merge-base b30b909
  3ee4462026126a0dd8fc5c99a6d83df510a84058` → `900d3cc`, and `c6b9a19^` → `900d3cc`), and
- an ancestor of `3ee4462` (the commit the current submission's own ARM_A4_A3_LIVE backend
  vendored byte-identical), with **zero** diff on any core Arm A retrieval file
  (`arm-retriever-adapter.mjs`, `domain/agent-comparison/retrieval/`, `domain/chunking/`,
  `domain/retrieval/`) between the two.

So "Frozen A" = the retrieval behaviour at `900d3cc`, preserved byte-identically inside
`b30b909` as `FROZEN_POLICY` (the default when no `--policy` flag is passed) — control and
candidate were always going to share one code checkout, differing only by that flag, per
the remediation branch's own design (`A_RETRIEVAL_REMEDIATION_V1_HANDOFF.md`).

## 3. Control run (executed)

```bash
DATABASE_URL=postgresql://jaewan@127.0.0.1:55329/p11f0_scratch \
P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
  node scripts/p11f0-fourarm-devtune-ac-run.mjs --arm A \
    --batch-id 090d62ecd2685974 --out-dir work/a-remediation-review/control
```

```text
n_questions: 101, n_errors: 0, checkpoint.canonical_rows: 101, checkpoint.resumed: false
latency_ms: p50=189 p95=1317 max=2934
conditions input_sha256: 83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527
  (matches EXPECTED_CONDITIONS_SHA256 in the runner and the pin used throughout this
  project's B/D/A/C history)
```

Real Postgres (`p11f0_scratch`), real KURE-v1 server (confirmed `/health`+`/info` live,
revision `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dim 1024), real persisted BM25 cache
(`~/Library/Caches/ai-festival-p11f0-bm25-index`, reused unmodified — no re-chunking, no
re-indexing, no re-embedding). Output at `work/a-remediation-review/control/`
(gitignored, not committed).

## 4. Control replay check — split result

**Core retrieval identity: byte-identical, 0/101 questions differ.** Compared
`question_id, rank, doc_id, chunk_id, chunk_text_sha256, score` between the fresh control
run and the committed `A.results.jsonl` for all 101 questions: **zero mismatches**. This
proves the actual retrieval BEHAVIOUR (which chunks are retrieved, in what order, with what
score) is unchanged since the commit that produced the committed reference
(`code_sha256=a5c1c8730225d0905b37c0ee8561e9563a56a30d`, i.e. `a5c1c87`, an ancestor of
`900d3cc`).

**Locator schema: diverged.** `node_index`/`node_indices` differ on essentially every
multi-node result (e.g. question 1, rank 1: committed `node_index=20,
node_indices=[20..34]`; fresh `node_index=null, node_indices` absent, replaced by a new
`locator_status: "MULTI_NODE_AMBIGUOUS"` and a `provenance.candidates[]` array holding the
same node range — 20 through 34 — now individually disambiguated with row/col detail per
candidate). `git log a5c1c87..900d3cc` shows the intervening commits responsible:
`feat: add node-grounded late-expansion A2 postprocessor for frozen arm A top-20`,
`feat(a2): integrate scope validator + late expansion; real fetchNode blocked`,
`feat(a2): wire real DocumentIR NodeStore fetchNode; DEV_TUNE-101 -> NO_SELECTION_BLOCKED`,
among ~20 others — a real, intentional locator-resolution feature (multi-node
disambiguation with row/col candidates) landed on this lineage after the committed
reference was produced and was never followed by a fresh official DEV_TUNE-101 re-run
against it (900d3cc's own commit message ends "-> NO_SELECTION_BLOCKED").

**This schema change is not merely cosmetic — it breaks the existing frozen scorer.**
Ran `scripts/fourarm/score.py --arms A --no-locator-check` (the existing, unmodified
Python scorer used throughout this project's whole B/D/A/C history) against the fresh
control output. It crashes:

```text
File ".../dart_corpus/evaluation/fourarm.py", line 191, in ok
    return (str(r.get("doc_id") or ""), int(r.get("node_index", -1))) not in banned
TypeError: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'
```

`_result_nodes()`/`slot_found()`/`check_locators()` all assume `node_index` is always a
concrete int (or absent, defaulting to `-1`) — none of them anticipate a present-but-`null`
value, which is exactly what the current retrieval runner now emits for every
`MULTI_NODE_AMBIGUOUS` result. **Recall@k, all_found@k, and critical/minor/unresolved
cannot be computed at all on this control output with the existing scorer** — not "computed
with a caveat" as the pre-registered §2 environment-limitation anticipated, but a hard
crash before any number is produced.

## 5. Decision-rule application

Per the amendment's §6, verbatim:

```text
BLOCKED_CONTROL_REPLAY  if the control run's retrieval fields (question_id, rank, chunk_id,
                        doc_id, node_index/node_indices, score, chunk_text_sha256) do not
                        reproduce the committed A.results.jsonl exactly, for any question.
```

`node_index`/`node_indices` — explicitly named in that field list — differ from the
committed reference on effectively every multi-node question, and the divergence is
severe enough to crash the scorer outright rather than merely differ in a harmless way.
**This fires.** Per the same section: "If this fires, no candidate run is scored and no
other verdict is reported." Accordingly, the `--policy remediation-v1` run was **not
executed**, per both this pre-registered rule and the task's own step-5 gate ("재현 성공
시" — only if reproduction succeeds). No Recall/critical/latency/pass-count numbers for
either policy are reported, because none were computed.

## 6. Side-finding (documented for whoever resolves the blocker — not part of this turn's
verdict)

While investigating why `NodeStore` could not be constructed for a fuller locator check
(the environment limitation pre-registered in the amendment's §2), the canonical 8GB
DocumentIR — believed completely absent from this machine based on the prior turn's search
(`~/Desktop/document_ir`, and a broad filesystem search) — was found to actually be present
at `~/Downloads/drive-download-20260804T043134Z-1-002/` (`exchange.jsonl`, `holding.jsonl`,
`major.jsonl`, `periodic-001.jsonl`), confirmed via exact SHA-256 match against every pin
already recorded in `A.run.json`'s `input_sha256.document_ir` block:

```text
exchange.jsonl:   80000c1c12f09bb59ce5bea41f62c5a70a39bdc965859c8436c261e9bde02c2a  MATCH
holding.jsonl:    fd88d83c53a4c465ec1cbedce0a41046cfa7819822e2d7df046fccf42b8cbc09  MATCH
major.jsonl:      5c58da7ad32fe31603f59bdea6829c29e6cb00b823c336b6e90b71f41d25d3ba  MATCH
periodic-001.jsonl: 0aee546312b93797cf35f946144e044d8f43a947c38bb49b0766b623076be852  MATCH
```

This means a future re-attempt — once the scorer/schema incompatibility in §4 is resolved
(the correct fix is an Owner decision, not this turn's to make: either the scorer is
updated to read `provenance.candidates[].node_index` when `node_index` is `null`, or the
runner is asked to keep populating a legacy `node_index`/`node_indices` pair alongside the
new provenance detail) — could run `scripts/build_index.py` to get a real `data/index/` and
do full `NodeStore`-backed critical/minor/unresolved scoring in this same environment. This
was not attempted this turn (out of scope — rebuilding an index is not part of resolving a
schema-compatibility blocker, and this turn's own rules prohibit "재청킹·인덱스 재구축"
regardless of whether it would technically be possible).

## 7. Existing test-suite invariance

```text
node --test tests/four-arm-a-retrieval-remediation.test.mjs tests/four-arm-run-checkpoint.test.mjs
  -> 29 pass, 0 fail (0.12s)
```

Matches the counts in the remediation branch's own handoff doc ("remediation 22/22,
checkpoint 7/7" = 29). Nothing in this environment/worktree broke any existing test.

## 8. Confirmations

```text
original_A_A4_A3_QA_results_modified:  false (domain/agent-comparison/four-arm-ac/results/
                                        A.results.jsonl and A.run.json sha256 unchanged
                                        throughout, see §1; codex/a4-a3-plus-qa-frozen-v01
                                        never checked out into this worktree)
policy_changed_after_seeing_a_result:  false -- the amendment (§2 and §6) was committed and
                                        pushed (commit 18ccb7a) before the control run was
                                        ever executed; the BLOCKED_CONTROL_REPLAY outcome
                                        was pre-specified as a possible outcome, not invented
                                        after seeing this specific failure
partial_question_reruns:               none -- the control run covered the full 101-question
                                        batch (candidate was never run at all, not partially)
corpus_re_embedding:                   none
re_chunking_or_re_indexing:            none -- same BM25 cache dir reused unmodified
DEV_CHECK_or_HOLDOUT_accessed:         false -- data/eval/phase1_devtune_gold.v0.1.jsonl
                                        (DEV_TUNE) only, read-only, from the frozen QA
                                        worktree by absolute path
frozen_submission_branch_modified:     false
winner_or_final_submission_declared:   false -- this turn issues no such declaration; the
                                        remediation candidate remains neither adopted nor
                                        rejected on its merits, only untested due to a
                                        tooling/schema blocker
pr_created:                            false
force_amend_rebase_reset_used:         false
db_write_count:                        0 (control run's own retrieval reads + one read-only
                                        transaction in the score.py probe; no INSERT/UPDATE/
                                        DELETE issued by anything this turn ran)
```

## 9. Final verdict

```text
BLOCKED_CONTROL_REPLAY
```

The remediation candidate (`b30b909`, `--policy remediation-v1`) was never run and is
neither recommended nor rejected by this turn. The blocker is a locator-schema
incompatibility between the current Arm A retrieval runner (which now emits
`node_index: null` + a `provenance.candidates[]` array for multi-node-ambiguous results,
landed in commits between `a5c1c87` and `900d3cc`) and the existing frozen Python scorer
(which still assumes a concrete int `node_index`) — not a retrieval-behaviour regression
(core identity fields are byte-identical to the committed reference across all 101
questions) and not an infrastructure failure (DB/KURE/BM25 all real and healthy throughout).
Resolving it (an Owner decision on which side adapts) is a prerequisite for any future
re-attempt at this validation.
