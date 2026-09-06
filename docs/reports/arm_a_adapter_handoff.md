# Arm A adapter — handoff (Turn A-PLUS-QA-ADAPTER-ONLY-V1)

## What this turn did

Added a minimal adapter so QA's `RetrieverAdapter` Protocol (`search`/`fetch_node`/`readiness`)
can be satisfied by frozen Arm A retrieval results, without re-running retrieval and without
touching any existing QA or Arm A file. Scope was adapter-only by explicit instruction: **no**
judge34/101-question run, **no** Gold-based scoring, **no** safety or performance verdict, **no**
DEV_CHECK/HOLDOUT access.

- Base: `share/dart-qa-handoff` @ `0c92abbe16852cb7880da94b81e06d1539fba665`.
- New worktree/branch: `agent-a-plus-qa-adapter-v01` / `codex/a-plus-qa-adapter-v01`.
- Files added (all new, nothing existing modified — see "Verified invariants" below):
  - `src/dart_detective/arm_a_adapter.py`
  - `tests/agents/test_arm_a_adapter.py` (18 tests, all synthetic fixtures, all passing)
  - `docs/arm_a_adapter_contract.md`
  - `docs/reports/arm_a_adapter_handoff.md` (this file)

## Status flags the user asked to be explicit about

- **Performance: NOT verified.** No judge34 run, no 101-question execution happened in this turn.
- **Safety: NOT verified.** `validator.py`'s grounding checks and the 연결/별도 scope bonus were
  not exercised end-to-end with real data in this turn.
- **Real text resolver: NOT connected.** `arm_a_adapter.py` ships only the `TextResolver`
  interface and the fail-closed behavior when none is injected (`TextResolutionRequiredError`).
  With no resolver wired, **every** real chunk from `A.results.jsonl` will raise, because A's
  frozen file carries only `chunk_text_sha256`, never raw text. A production resolver still needs
  to be built against the pinned DocumentIR corpus (manifest sha256
  `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`, the same corpus Arm A itself
  was built against) and injected via `build_retriever_for_arm(..., arm_a_text_resolver=...)`.
- **B/D path: unchanged**, verified by a byte-hash test (`test_existing_qa_files_byte_unchanged`)
  comparing `retriever_adapter.py`, `answer_api.py`, `agents/qa_agent.py`, `agents/validator.py`,
  and `corpus_retriever.py` against their base-commit sha256 hashes.
- **Live wiring into `answer_api`: NOT done.** `answer_api._get_retriever()` still calls
  `retriever_adapter.build_serving_retriever()` directly, which only supports B/D and has a
  *different* return shape (`(retriever, store, arm, pins)` with a `CorpusRetriever`-shaped
  retriever) than the `RetrieverAdapter` Protocol this adapter implements (see
  `docs/arm_a_adapter_contract.md`, "Two call shapes"). Editing `answer_api.py` or
  `retriever_adapter.py` was out of scope for this turn (the completion instructions required
  zero diffs to existing files).

## Verified invariants

```
git status --short                 # only the 4 new files listed above
git diff --stat <base-sha> -- src/dart_detective/retriever_adapter.py \
    src/dart_detective/answer_api.py src/dart_detective/agents/qa_agent.py \
    src/dart_detective/agents/validator.py src/dart_detective/corpus_retriever.py
                                    # empty
.venv/bin/pytest tests/agents/test_arm_a_adapter.py -v
                                    # 18 passed
```

## Next worker's verification list (separate turns)

1. Build a real `TextResolver` reading the pinned DocumentIR corpus
   (`04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`) and inject it.
2. Decide how to bridge `build_retriever_for_arm("A", ...)` (RetrieverAdapter-shaped) into the
   `CorpusRetriever`-shaped object `answer_api._get_retriever()` actually consumes — either adapt
   `ArmAFrozenResultsRetriever` to also expose `.conditions()`/`.retrieve()`/`.docs_by_id`, or
   unify `build_serving_retriever()` with `bind()` (the module's own docstring already says they
   should be the same door). Either path requires editing an existing file — a new, explicitly
   scoped turn.
3. Only after (1) and (2): a separate, pre-registered turn to run judge34 against the 101-question
   DEV_TUNE set with Arm A wired in, gated exactly as the earlier `A_PLUS_QA_E2E_V1` amendment
   specified (answerability 101/101, weighted score and citation_ok floors, 5-string contract,
   locator/provenance criticals = 0, no DEV_CHECK/HOLDOUT access).
4. Decide whether/how to implement `statement_scopes(doc_id)` for arm A (optional; safe to skip
   per the contract doc's "Known gaps" section, since it's a soft signal not a hard gate).

## Final status

`A_PLUS_QA_ADAPTER_IMPLEMENTED`

No performance or adoption verdict is reported, per this turn's scope.
