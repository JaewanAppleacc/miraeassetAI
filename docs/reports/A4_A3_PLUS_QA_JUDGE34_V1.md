# A4-A3-PLUS-QA-JUDGE34-V1 — Blocked, then Corrected and Executed (101 questions)

**Status update**: both blockers below (§2, §3) were subsequently resolved by
the Owner — the KURE-v1 embedding server was restarted with the same pin, and
the Owner confirmed the question-set correction (34 → 101, DEV_TUNE Gold) in
`docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT_ADDENDUM_101.md` (committed before any
new result existed, per the freeze discipline). `ARM_A_LIVE` and
`ARM_A4_A3_LIVE` were then each run against the full, real 101-question
DEV_TUNE Gold set, serially, real HyperCLOVA X calls throughout. **See §7
onward for the actual execution and final verdict** — §1-6 below are kept
verbatim as the historical record of the original blocked attempt.

Turn A4-A3-PLUS-QA-JUDGE34-V1. Goal was to run the pre-registered
`docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT.md` comparison (`ARM_A_LIVE` + QA vs
`ARM_A4_A3_LIVE` + QA, identical 34-question judge34 set, same-run decision
rule). **No question was executed against any LLM or retrieval backend.**
Two independent, pre-execution blockers were found during the mandated
start-of-turn verification (items 1–8 of the governing instructions) — either
one alone is sufficient to withhold execution per that turn's own rule
("provider readiness가 실패하면 실행하지 말고 BLOCKED_EXTERNAL_QA_PROVIDER로
보고한다") and per this repo's standing discipline (no partial runs, no
post-hoc spec edits, no mock results).

## 1. Pins / starting-point verification

```text
worktree:                 agent-a4-a3-plus-qa-final-v01
branch:                   codex/a4-a3-plus-qa-final-v01
HEAD (local):              bc90bce9fc6505e33ab233755bffba248121bce7
HEAD (origin):             bc90bce9fc6505e33ab233755bffba248121bce7   (fetched fresh, matches)
HEAD (demo-ai-festival):   bc90bce9fc6505e33ab233755bffba248121bce7   (fetched fresh, matches)
working tree:              clean (verified before and after this turn's read-only checks)
```

Freeze/amendment documents present and unmodified this turn (sha256, matches
git blob at HEAD — computed before and confirmed identical to the committed
blob):

```text
docs/A4_A3_PLUS_QA_FINAL_V1_FREEZE.md      sha256=4964997b9bd0e44e94d6c05aa57fd518014153ad0226e7e49e430da8c41a9df0
docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT.md   sha256=5606fd79a417cc74fc8c0101946dbcb037b989c028aea21f24c2eaaf7e0a1386
config/a4-a3-plus-qa-final-v1.json         sha256=fba792b609f5c6b2b25e106fdb799fa03d2d7f29bb57d7f9129c46dc3d4c4e55
config/a4-a3-runtime-source-manifest.v1.json sha256=a0f837cf2ac496e2a05e68f80874928200703702e568d5469d44da8475d77a7e
```

## 2. Blocker A (contract) — the pre-registered "judge34 34-question set" does not exist

The amendment's Comparison specification states:

```yaml
question_set: the existing, already-approved judge34 set (results/judge34/'s own 34 questions)
question_count: 34
```

Checked `results/judge34/judge.jsonl` directly: it contains **101** rows, not
34 (`wc -l` → 101; `results/judge34/summary.json`'s own `"n": 101,
"answerability_ok": 101`). `git log --follow` on that path shows it is not a
new 34-question artifact created for this turn — it is the *34th sequential
judge-iteration directory* in this project's long-running judge-quality
history (`results/judge2` … `results/judge33` → renamed to `results/judge34`
by commit `0c92abb`, "judge34·gold25 r8 실측 … 답변가능성 101/101"), each one
always covering the **full 101-question DEV_TUNE set** — the naming
convention documented throughout `CLAUDE.md`'s "심사위원 모드 개선 이력"
section (judge1 → judge34, all against the same 101 DEV_TUNE questions).
"Judge34" names an iteration number, not a question count. No file anywhere
in this repository (`find . -iname "*judge34*"` and adjacent searches) holds
a distinct, pre-registered 34-question subset.

This is a factual contradiction inside the frozen amendment document itself,
discovered before any provider call was made. Per this turn's own explicit
prohibitions ("일부 질문만 재실행", "결과 확인 후 프롬프트 수정", "새 설계는
하지 않는다"), none of the following are acceptable substitutes and were NOT
done:

- Running all 101 questions instead of the specified 34 (changes the
  pre-registered comparison's scope/cost/latency envelope after the fact).
- Picking an arbitrary 34-row subset of the 101 to satisfy the count (invents
  a selection the amendment never specified — indistinguishable from
  "일부 질문만 재실행").
- Editing the amendment document to match the actual file (a post-hoc spec
  change is exactly what "새 설계는 하지 않는다" / the freeze discipline
  forbids).

**Resolution required from the Owner**: either point at the actual
34-question artifact this turn intended (if one exists under a different
name/path) or amend the comparison spec through the project's own §21
change procedure before this turn can run.

## 3. Blocker B (external provider/infra readiness) — KURE-v1 embedding server unreachable

Preflight checks 5–7, run against real infrastructure (no mocks):

```text
CLOVA_API_KEY:            present (existence-only check; value never read, logged, or printed)
Postgres (p11f0_scratch): reachable, port 55329
retrieval_index_id:       fixed_kure_index_8fe191342205848d1d6a6123f38a54e7
index_status:             READY   (disclosure_reference.reference_retrieval_indexes, queried directly)
record_count:             442549  (confirmed twice: index metadata row AND COUNT(*) on
                                    disclosure_reference.reference_retrieval_chunks)
embedding_dimension:      1024
embedding_provider/model: nlpai-lab / KURE-v1
embedding_revision:       4ed4540949c70b7da2c74004a915e1f2d5e46e4f  (matches KURE_PIN in both
                                                                      ARM_A_LIVE and ARM_A4_A3_LIVE)
source_snapshot_id:       corpus_04750795e1a2d5c3 (matches freeze pin)
```

Real KURE-v1 embedding HTTP server (`http://127.0.0.1:58411`) is **not
running** in this environment (`curl` → connection refused). Ran the actual,
self-contained `ArmA4A3LiveWorkerClient.readiness()` (no mock, real
subprocess, real Postgres, real persisted BM25 cache) to get ground truth
rather than guessing:

```json
{
  "database_ready": true,
  "bm25_index_ready": true,
  "bm25_document_count": 442549,
  "kure_ready": false,
  "kure_revision_match": false,
  "embedding_dimension": null,
  "arm_a4_a3_live_ready": false,
  "kure_pin": {"repository": "nlpai-lab/KURE-v1", "revision": "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", "dimension": 1024},
  "retrieval_index_id": "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7",
  "corpus_snapshot_id": "corpus_04750795e1a2d5c3",
  "reranker_config": "R4_wide_rrf_centric"
}
```

Worker stderr: `KURE server health/info probe failed: fetch failed`. Both
`ARM_A_LIVE` and `ARM_A4_A3_LIVE` share this same KURE dependency for dense
candidate generation — this readiness failure is backend-agnostic and would
block either arm equally, so it is not itself evidence for or against the
comparison; it is a pure infra-availability gap. Per `CLAUDE.md`'s storage
principle, the embedding/vector stack belongs to the "A/C 스택 담당자"
environment, not this folder — starting a third-party embedding server
(sentence-transformers/torch, loaded from a sibling worktree's script) was
judged out of scope for this turn and was **not attempted**; no server was
started, no process was spawned to fabricate a passing readiness check.

## 4. Execution

**None.** Zero questions were sent to either backend or to HyperCLOVA X.
`questions_failed`, `citation_validity`, `answerability`,
`numeric_correctness`, `groundedness`, `weighted_score`, `critical_evidence_errors`,
latency, and A3 reject/refill statistics are all **not applicable** — no run
was attempted, per the instruction to not execute when a precondition check
fails.

## 5. Confirmations

```text
clova_api_key_value_exposed:  never (existence-only check)
dev_check_accessed:           false
holdout_accessed:             false
gold_accessed:                false
mock_qa_result_fabricated:    false
partial_result_used_for_verdict: false
r4_weight_or_config_changed:  false
a3_rule_changed:               false
extractor_changed:             false
prompt_changed:                false
amendment_document_edited:    false (byte-identical to freeze; see §1 sha256)
pr_created:                   false
force_amend_rebase_reset_used: false
original_result_files_touched: none (results/judge34/* read-only; unchanged, see §1/§2 sha256)
db_write_count:                0
```

## 6. Final verdict

```text
BLOCKED_CONTRACT
```

Both blockers must be resolved before this turn can run: (A) the Owner must
identify or re-specify the actual 34-question judge set the amendment
intended (§2), and (B) the KURE-v1 embedding server must be brought up and
verified live (`/health`, `/info`) in this environment (§3) — independently,
CLOVA_API_KEY is present and not itself a blocker. Neither `ARM_A_LIVE` nor
`ARM_A4_A3_LIVE` is favored or disfavored by this report; `KEEP_EXISTING_A_PLUS_QA_FOR_SUBMISSION`
remains the standing default (no new candidate was ever run) until a
corrected comparison can execute cleanly end-to-end.

---

## 7. Blockers resolved — pins re-verified before execution

```text
KURE-v1 server (restarted by Owner, same pin): http://127.0.0.1:58411
  /health -> {"status": "ok"}
  /info   -> repository_id=nlpai-lab/KURE-v1, model_revision=4ed4540949c70b7da2c74004a915e1f2d5e46e4f,
             embedding_dimension=1024, device=mps
ARM_A4_A3_LIVE readiness (real worker, real subprocess): arm_a4_a3_live_ready=true,
  database_ready=true, bm25_index_ready=true, bm25_document_count=442549,
  kure_ready=true, kure_revision_match=true, embedding_dimension=1024
ARM_A_LIVE readiness (real worker, real subprocess, ARM_A_LIVE_IMPL_ROOT pinned to
  agent-fourarm-ac-vector-import-v01 @ 44f0523, read-only, unmodified): arm_a_live_ready=true,
  official_experiment_ready=true, bm25_document_count=442549, materialized_chunk_count=442549,
  locator_provenance.provenance_ready=true, reasons=[]
question_source: data/eval/phase1_devtune_gold.v0.1.jsonl, 101 lines,
  sha256=7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b (unchanged, matches
  the pin recorded in CLAUDE.md)
CLOVA_API_KEY: present (existence-only check, never read/printed)
CLOVA_MODEL / DART_QA_FC_TEMPERATURE / DART_QA_SEED / DART_QA_LATE_EXPANSION /
  DART_QA_EXPANDED_RETRIEVAL: all unset -> defaults (HCX-005, 0.1, 42, OFF, OFF), identical
  for both runs
HEAD at execution time: 253ee7c (docs: addendum — fix amendment's five decision metrics ...)
```

## 8. Execution

Ran `scripts/judge_devtune.py` (existing, unmodified, judge1..judge34-era scorer) once per
backend, serially (`ARM_A_LIVE` to completion, then `ARM_A4_A3_LIVE`), via a thin,
uncommitted `work/run_judge101_backend.py` driver that only calls
`answer_api.configure(retrieval_backend=<ARM>, base_factory=None)` before invoking
`judge_devtune.py`'s own `main()` unmodified (see
`docs/A4_A3_PLUS_QA_JUDGE_V1_AMENDMENT_ADDENDUM_101.md` § Execution runner for why
`base_factory=None` is required and why it does not favor either backend). No `--limit`,
no question subset, no prompt/R4/A3/extractor change between the two runs. All 101
DEV_TUNE Gold questions, real HyperCLOVA X calls, real Postgres, real KURE-v1 server, real
BM25 cache, both runs.

```text
ARM_A_LIVE:     101/101 questions completed, exit code 0, no exception in either run's log
ARM_A4_A3_LIVE: 101/101 questions completed, exit code 0, no exception in either run's log
questions_failed: 0 (both) — no unhandled exception, no crash marker in any of the 202
                  wire/meta records; the JSON-parse misses below are the pipeline's
                  already-designed llm_error -> fallback path, not execution failures
provider health: no 429/40009/timeout/connection error in either run (both runs' llm_error
                  values are exclusively "JSON을 찾지 못했다"/JSON-syntax parse failures —
                  the documented, already-measured degraded-path class this pipeline is
                  built to survive via its 3-stage fallback, not a provider outage)
latency (ms):     ARM_A_LIVE      n=101 min=8605  p50=20868 p95=36539 max=50184 mean=20986.1
                  ARM_A4_A3_LIVE  n=101 min=8124  p50=19229 p95=36181 max=48672 mean=19696.6
                  (both well inside the 290s serving budget; ARM_A4_A3_LIVE p50/mean
                  slightly lower, consistent with its worker returning a pre-reranked top-20
                  vs ARM_A_LIVE's bare RRF top-20 needing more downstream evidence-selection work)
llm_used:         ARM_A_LIVE 60/101, ARM_A4_A3_LIVE 62/101
fallback_stage triggered: ARM_A_LIVE 2/101, ARM_A4_A3_LIVE 3/101
```

**A3 reject/refill statistics**: not available for this run. `answer_api`'s serving
contract (`think_trace`/`meta`) does not surface the Node worker's internal
pool/reject/refill counters — those are only exposed by the separate Section-G-style debug
harness (`scripts/a4_a3_full_index_smoke.mjs`), which was run previously on a different,
non-Gold 10-question sample (`docs/reports/A4_A3_PLUS_QA_SELF_CONTAINED_AND_JUDGE_V1.md`
§5: reject 79, refill 6 total across those 10 questions) — that number is prior, already-
reported evidence about the pipeline's internal behavior, not a measurement of this run's
own 101 DEV_TUNE questions. No attempt was made to re-instrument or re-run through the
debug harness for this turn (would mean re-running questions through a second path,
outside what was asked).

## 9. Decision-rule metrics (mapping fixed in advance — see
`docs/A4_A3_PLUS_QA_JUDGE_V1_METRIC_MAPPING_ADDENDUM.md`, committed before either run's
aggregate existed)

All values read directly from each run's own `work/judge101_<arm>/summary.json` (raw files
are gitignored under `work/`, not committed — only these aggregate numbers are recorded
here and in `config/a4-a3-plus-qa-judge34-summary.v1.json`):

| metric | ARM_A_LIVE (baseline) | ARM_A4_A3_LIVE (candidate) | candidate >= baseline? |
|---|---|---|---|
| citation_validity (citation_ok/n) | 101/101 = 1.0000 | 101/101 = 1.0000 | yes (tie at ceiling) |
| answerability (answerability_ok/n) | 92/101 = 0.91089 | 93/101 = 0.92079 | yes |
| numeric_correctness (NUMERIC_LOOKUP full-rate) | 28/55 = 0.50909 | 31/55 = 0.56364 | yes |
| groundedness (slots_full_in_context/n) | 46/101 = 0.45545 | 48/101 = 0.47525 | yes |
| weighted_score (full + 0.5×partial, raw count) | 39 + 0.5×33 = 55.5 | 42 + 0.5×33 = 58.5 | yes |
| critical_evidence_errors (citation_ok=false & validation_status=SUPPORTED) | 0 | 0 | == 0 required, holds |
| execution_errors (questions_failed) | 0 | 0 | == 0 required, holds |

`value` breakdown (n=101, value_denominator=92 both runs, identical to the convention used
in every prior judge1..judge34 iteration):

```text
ARM_A_LIVE:     full=39  partial=33  zero=20
ARM_A4_A3_LIVE: full=42  partial=33  zero=17
```

All seven decision-rule conditions hold. This is **not** an exact tie across all five
ratio/score metrics (four strictly improve; only `citation_validity` ties, and only
because it is already at its ceiling of 1.0 on the baseline run) — so the amendment's
"동점이면 기존을 선택한다" tie-break does not apply here.

## 10. Confirmations (this execution)

```text
dev_check_accessed:            false
holdout_accessed:               false
gold_accessed:                  data/eval/phase1_devtune_gold.v0.1.jsonl only (DEV_TUNE, not
                                 DEV_CHECK/HOLDOUT) — sha256 unchanged, see §7
clova_api_key_value_exposed:    never (existence-only check both before and during)
mock_qa_result_fabricated:      false — real HyperCLOVA X, real Postgres, real KURE-v1,
                                 real Node worker subprocesses throughout
r4_weight_or_config_changed:    false
a3_rule_changed:                false
extractor_changed:              false
prompt_changed:                 false
question_subset_or_limit_used:  false (--limit never passed; both runs are the full 101)
partial_result_used_for_verdict: false (both runs 101/101 complete)
amendment_or_addenda_edited_after_seeing_a_result: false — question-set addendum (9ace970)
                                 and metric-mapping addendum (253ee7c) were both committed
                                 and pushed before either run's aggregate existed (see git
                                 log timestamps vs work/ file mtimes)
db_write_count:                  0 (both worker readiness/search paths are read-only against
                                 disclosure_reference.*; answer_api itself performs no writes)
pr_created:                      false
force_amend_rebase_reset_used:   false
raw_wires_and_judge_rows:        work/judge101_arm_a_live/, work/judge101_arm_a4_a3_live/
                                 (gitignored under work/, not committed; only the aggregate
                                 numbers above and in config/a4-a3-plus-qa-judge34-summary.v1.json
                                 are recorded in git)
```

## 11. Final verdict

```text
A4_A3_PLUS_QA_READY_FOR_FINAL_CHECK
```

`ARM_A4_A3_LIVE` + QA satisfies every condition in the amendment's decision rule against
the same-run `ARM_A_LIVE` + QA baseline, on the full, real 101-question DEV_TUNE Gold set,
serial execution, identical QA code/provider/model/temperature/seed, zero execution
errors, zero critical evidence errors, no provider outage in either run. Per the amendment,
this result is reported as-is; no further code change (R4 weight, A3 rule, extractor,
prompt) was made after seeing it, and none is proposed here. Whether to proceed to a final
submission check is an Owner decision outside this turn's scope.
