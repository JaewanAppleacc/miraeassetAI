# Arm A live retriever — handoff (Turn A-PLUS-QA-LIVE-RETRIEVER-V1)

## What this turn did

Replaced the frozen-replay data source with a genuinely live path: `answer_api` with
`DART_QA_RETRIEVAL_BACKEND=ARM_A_LIVE` now sends an arbitrary question to a persistent Node.js
worker process, which calls Arm A's real, unmodified retrieval code
(`createArmRetrieverAdapter` — metadata prefilter → BM25 top-100 → KURE-v1 dense top-20 → RRF
k=60 → top-20) against a real Postgres/pgvector-backed materialized index, hydrates real chunk
text, verifies it against the recorded `chunk_text_sha256`/`document_id`, and hands the result to
QA's existing `qa_agent`/answer-assembly pipeline unchanged. No HTTP server was added — the
transport is a stdin/stdout JSONL protocol over one long-lived subprocess.

- Base: QA `share/dart-qa-handoff` lineage, `codex/a-plus-qa-live-wiring-v01` @ `858658e`.
- New worktree/branch: `agent-a-plus-qa-live-retriever-v01` / `codex/a-plus-qa-live-retriever-v01`.
- Arm A implementation called (read-only, unmodified): `codex/fourarm-ac-vector-import-v01` @
  `44f0523`, worktree `/Users/jaewan/Documents/Codex/worktrees/agent-fourarm-ac-vector-import-v01`.

## Real Arm A call path

- **Not** an HTTP server, **not** a fresh CLI process per question. A single persistent
  `node scripts/arm_a_live_worker.mjs` subprocess connects one Postgres client, loads one BM25
  index, and constructs one `createArmRetrieverAdapter({arm:"A", ...})` **once** at startup, then
  answers every subsequent question over the same stdin/stdout pipe (verified in the real
  integration test: 3 sequential questions handled by the same process, same loaded index — the
  `restart per question` failure mode was never present).
- No reusable single-question CLI/worker entrypoint for Arm A existed in the repo before this turn
  (checked); a thin worker was added per the turn's own stated priority order.
- The worker imports Arm A's real modules from the separate, untouched worktree via
  `ARM_A_LIVE_IMPL_ROOT` (env var, never hardcoded) using `path.join()` + dynamic `import()`; `pg`
  (a dependency of that other worktree, not of this repo) is resolved via
  `node:module.createRequire(path.join(implRoot, "package.json"))`, so the QA repo needed **zero**
  new npm dependencies or `node_modules`.

## Real infrastructure exercised (not synthetic)

- Postgres migrations 009–013 applied to the shared `scratch_repro` scratch DB.
- Real KURE-v1 embedding server at `127.0.0.1:58411` (`nlpai-lab/KURE-v1` @
  `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024) — confirmed via live `/health`+`/info`
  probes inside the worker's own `readiness()` handler, not just a DB-recorded pin.
- Real shard: 12 real documents → 18 real chunks, `corpus_snapshot_id=corpus_04750795e1a2d5c3_shard_val_12`,
  built via the existing, unmodified `p11f0-corpus-discovery.mjs` → `p11f0-embedding-phase.mjs` →
  `p11f0-materialization-phase.mjs` (v1, not v2 — v2's attempt-based session-id scheme is
  incompatible with the embedding/materialization phases' plain `computeFixedKureLoadSessionId`
  lookup; this was discovered and avoided before it caused a stuck session).

## Arbitrary-question smoke results (real subprocess, real DB, real KURE server — `node --test scripts/arm_a_live_worker.test.mjs`)

- `readiness` → `arm_a_live_ready: true`, `kure_revision_match: true`, `embedding_dimension: 1024`.
- 3 real, non-Gold, non-DEV_TUNE probe questions (each a real materialized chunk's own text —
  same established non-Gold probe pattern the Arm A repo's own
  `p11f0-shard-integration-smoke.mjs` uses) each returned ≤ requested `top_k`, every result's
  `sha256(text) == chunk_text_sha256`, rank strictly increasing, and each probe's own chunk was
  found in its own top-5 self-match search.
- One probe (`chunk_6e3a20e45b85e6a8042139ff`, 27 persisted spans) genuinely surfaced a multi-node
  result: `node_indices: [0, 1, 2, 3]` at rank 1, preserved in full (not collapsed to one node) all
  the way through the Python `ArmALiveRetriever`.
- Also verified directly via the Python client against the real worker (not just synthetic
  fixtures): a hand-written question with no relationship to any Gold/frozen set
  ("완전히 새로운 임의의 질문입니다 — 반도체 공급계약 관련 내용이 있습니까?") returned 3 real
  results.
- All 3 `node --test` cases pass: `readiness reflects real infra state`,
  `3+ arbitrary non-Gold questions get real top-k results with verified real text`,
  `the worker never reads/imports the frozen A.results.jsonl replay path`.

## Access/fallback counts

- `A.results.jsonl` opened by the `ARM_A_LIVE` path: **0** (structurally verified — the worker
  source never mentions that filename or `ARM_A_RESULTS_PATH` outside its own docstring, and
  `ArmALiveRetriever` holds no reference to `arm_a_adapter.ArmAFrozenResultsRetriever`).
- B/D (`build_line_window_retriever`/`bind()`) invocations on the live path: **0** — the fake-base
  test asserts `base.retrieve()` raises if ever called, and it never was.
- Gold/DEV_TUNE/DEV_CHECK/HOLDOUT files read anywhere in this turn's new code or tests: **0**.
- Worker restarts per question during the 3-question smoke: **0** (one process, one loaded index,
  three sequential requests).

## Text hydration and integrity

Every returned result's real text is hydrated from `disclosure_reference.reference_retrieval_chunks.text_content`
inside the worker (a read-only `SELECT`), checked there against `chunk_text_sha256` and
`source_document_id`, and checked **again**, independently, in pure Python inside
`ArmALiveRetriever` (no DB access needed for this second pass) before a `Chunk` is ever built.
Both layers pass on real data; both layers are unit-tested to fail closed on injected corruption
(`TEXT_SHA_MISMATCH`, `DOCUMENT_ID_MISMATCH`, `TEXT_RESOLUTION_REQUIRED`).

## QA delivery confirmation

`test_answer_api_reaches_qa_agent_with_arm_a_live_backend` configures `answer_api` with
`retrieval_backend=ARM_A_LIVE` and a stub worker, then runs the question through
`qa_agent.answer_question(...)` and `answer_api.answer_ex(...)` end to end: the resulting 5-string
wire is well-formed, `think_trace.validation.status != "ERROR"`, and the retrieval step recorded
exactly the live-path chunks (rank order and `node_indices` intact) — `qa_agent`/answer-assembly
logic itself was not modified.

## Existing QA files changed, and why

- `src/dart_detective/arm_a_serving_bridge.py`: +9 lines. Added `RETRIEVAL_BACKEND_ARM_A_FROZEN_REPLAY`
  as an explicit additional alias for the existing (unchanged) frozen-replay path — isolates it by
  name from `ARM_A_LIVE`, per this turn's instructions, without breaking `858658e`'s own tests
  (which still use the literal `"ARM_A_FIXED_RRF"`). Added `RETRIEVAL_BACKEND_ARM_A_LIVE` to the
  accepted-backends tuple.
- `src/dart_detective/answer_api.py`: +7/-2 lines. One new `elif` branch in `_build_retriever()`
  routing `ARM_A_LIVE` to `arm_a_live_adapter.build_arm_a_live_serving_retriever(...)`; `DEFAULT`
  and the frozen-replay branch are untouched (verified: `test_default_backend_calls_build_serving_retriever_unchanged`
  and all of `test_arm_a_serving_bridge.py` still pass unmodified).
- `tests/agents/test_arm_a_adapter.py`: updated one stale byte-hash pin for `answer_api.py`
  (turn 2, `858658e`, had already legitimately changed this file and updated this same pin once;
  this turn's own further change required updating it again — the file's own comment already
  documents that DEFAULT/`ARM_A_FIXED_RRF` behavior-preservation, not byte-identity, is the actual
  contract, enforced by `test_arm_a_serving_bridge.py`'s regression tests instead).
- `retriever_adapter.py`, `agents/qa_agent.py`, `agents/validator.py`, `corpus_retriever.py`,
  `arm_a_adapter.py`: byte-identical to `858658e` (checked via `git diff --stat`).

## Test results

- `pytest tests/agents/ -k arm_a --ignore=tests/agents/test_answer_wire.py`: **43 passed, 2
  skipped** (the 2 skips are pre-existing, unrelated to this turn — `test_arm_a_serving_bridge.py`
  fixtures gated on real corpus artifacts not present in this worktree, same as before).
  `test_answer_wire.py` was excluded from collection because it needs `httpx2`, a pre-existing
  environment gap unrelated to this turn's changes (fastapi/starlette's test client dependency).
- Node integration (`node --test scripts/arm_a_live_worker.test.mjs`, real infra): **3 passed, 0
  failed**.
- Structural checks (all pass): no `A.results.jsonl`/`ARM_A_RESULTS_PATH` reference in live-path
  code; no `http.createServer`/`express(`/port anywhere in the worker; no BM25/RRF function
  redefinition (only imported and called).

## Schema/typecheck/lint

- Python: `ast.parse` syntax check passes on both new modules. `pyright` is not installed in this
  environment — reported explicitly rather than assumed passing, per this repo's own stated
  convention ("명령이 설치되지 않았으면 통과한 척하지 말고 명시적으로 보고한다").
- Node: `node --check` passes on both new `.mjs` files.

## DEV_TUNE/DEV_CHECK/HOLDOUT non-access

Not read anywhere in this turn's new files. The frozen adapter's Gold-question index
(`phase1_devtune_gold.v0.1.jsonl`) is never opened by the `ARM_A_LIVE` path — arbitrary question
strings are answered directly by the worker's own Postgres-backed search, with no question-id
lookup step at all.

## Remaining real-evaluation work (explicitly deferred)

- No DEV_TUNE-101 run, no judge34, no A vs. B/D comparison, no winner declared — per this turn's
  scope.
- `fetch_node` on the live path returns a minimal, non-hydrated `Node` (kind/section_path/lines
  empty) — it round-trips Arm A's own identity-verification result but does not carry node text;
  this was sufficient for the required smoke (which only exercises `search`) and is noted here as
  a known gap for whoever wires deeper node-level lookups.
- The default `DART_QA_RETRIEVAL_BACKEND` remains unchanged (still resolves to `DEFAULT`/B-D) —
  switching the production default to `ARM_A_LIVE` is explicitly out of scope.
- Performance and safety verification (judge34-equivalent, grounding/citation checks against real
  HCX answers) have not been run against this live path — that is the next, separate,
  pre-registered turn.

## Final status

`A_PLUS_QA_LIVE_ADAPTER_READY`
