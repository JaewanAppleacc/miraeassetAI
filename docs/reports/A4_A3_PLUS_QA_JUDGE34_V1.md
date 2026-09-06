# A4-A3-PLUS-QA-JUDGE34-V1 — Blocked Before Execution

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
