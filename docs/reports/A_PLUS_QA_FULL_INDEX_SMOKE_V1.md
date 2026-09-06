# A+QA full-index smoke — handoff (Turn A-PLUS-QA-FULL-INDEX-SMOKE-V1)

## Scope

Verifies the already-built real-time A+QA live-retriever connection (Turn
A-PLUS-QA-LIVE-RETRIEVER-V1) against the **full 442,549-chunk READY index**, not the 18-chunk
smoke shard that turn's own tests used. This is a submission-readiness smoke test, not a
performance/DEV_TUNE scoring run — no score, arm comparison, or winner is declared here.

- Source branch/commit: `codex/a-plus-qa-live-retriever-v01` @ `1cd64985f4e49808995734865cd4ca11ae0f97e8`
  — confirmed identical on `origin` (JaewanAppleacc/miraeassetAI) and `demo-ai-festival`
  (jiyoung04lee/demo_ai_fesfival) before starting, and on the pre-existing local worktree HEAD.
- New worktree/branch: `agent-a-plus-qa-full-index-smoke-v01` / `codex/a-plus-qa-full-index-smoke-v01`.
- No other worktree was modified. The Arm A/C implementation
  (`agent-fourarm-ac-vector-import-v01` @ `44f0523`) was read-only referenced via
  `ARM_A_LIVE_IMPL_ROOT`, exactly as the live-retriever turn's own worker already does.

## A. Full infrastructure — directly queried, not assumed

The `AC_VECTOR_IMPORT_V1_HANDOFF.md` handoff (in the Arm A/C worktree) describes the full index as
`READY`, but **that state does not exist in `scratch_repro`** (the database the 18-chunk shard
lives in, on `localhost:5432`) — its `reference_retrieval_indexes` table has only the one 18-row
shard, and its full-corpus `DISCOVERY` sessions are stuck at 0 rows. Direct queries against the
**other** local Postgres instance found it instead, live and unmodified, in a second database that
turn's earlier work had left running:

| Field | Value |
|---|---|
| Database | `postgresql://jaewan@localhost:55329/p11f0_scratch` (NOT `scratch_repro`) |
| `retrieval_index_id` | `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7` |
| `retrieval_index_status` | `READY` (direct `SELECT`, confirmed) |
| `retrieval_record_count` | **442549** |
| `unique_chunk_id_count` | **442549** (`COUNT(DISTINCT chunk_id)` over the same rows) |
| `precomputed_embedding_count` | **441879** |
| `embedding_dimension` | **1024** |
| KURE `repository` | `nlpai-lab/KURE-v1` |
| KURE `revision` | `4ed4540949c70b7da2c74004a915e1f2d5e46e4f` |
| KURE dimension | `1024` |
| Materialized load session | `fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e` — `READY`, `442549/442549` |
| Discovery/provenance session | `fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36` — holds the 442,549 `source_spans` rows used for locator/`fetch_node` provenance |
| `corpus_snapshot_id` | `corpus_04750795e1a2d5c3` (full corpus, no shard suffix) |
| Live KURE-v1 server | `http://127.0.0.1:58411` — real running process, `/health`→`{"status":"ok"}`, `/info` revision/dimension match exactly |

All of the above was obtained with `SELECT`-only `psql` queries. **No migration, no
materialization, no embedding/index build was run** — this index was already `READY` from prior
work; this Turn only connected to it.

### DB read-only proof (this Turn's actual queries)

Every query this Turn issued against Postgres — directly via `psql` and inside
`scripts/arm_a_live_worker.mjs`/`arm-retriever-adapter.mjs` (read, not modified) — is a `SELECT`.
Verified by reading the full source of every query site in both files; none contains
`INSERT`/`UPDATE`/`DELETE`/DDL. **DB write count from this Turn's work: 0.**

### Adaptation required (worker session-id wiring — no search/rerank logic touched)

The full-corpus index uses the newer "attempt"-based scheme with **two** session rows: an
immutable `DISCOVERY` attempt (`c7ee3363…`, holds `source_spans` + the `canonical_queue` rows the
persisted BM25 cache was built from) and a separate `READY` successor (`23b88aea…`, holds the
materialized/dense session status). The 18-chunk shard predates this split (one plain session id
for everything), so `scripts/arm_a_live_worker.mjs` only ever threaded through one
`ARM_A_LIVE_LOAD_SESSION_ID`. `createArmRetrieverAdapter` already had a `provenanceLoadSessionId`
parameter for exactly this split (defaulting to `loadSessionId`) — the worker script itself just
never passed it. This Turn added two **optional** env vars, both defaulting to
`ARM_A_LIVE_LOAD_SESSION_ID` (so the existing shard test is unaffected — reverified, still 3/3
passing):

- `ARM_A_LIVE_BM25_LOAD_SESSION_ID` — which session id `loadFixedKureBm25Index`/
  `buildFixedKureBm25Index` build/load against.
- `ARM_A_LIVE_PROVENANCE_LOAD_SESSION_ID` — passed straight through as
  `provenanceLoadSessionId` to `createArmRetrieverAdapter` (unmodified function/file).

No BM25/dense/RRF/metadata-filter logic was added or changed; this only wires an existing
parameter through. Diff: `scripts/arm_a_live_worker.mjs` (+11/-4 lines).

### Operational note (not a code/logic change)

Loading the full corpus's persisted BM25 cache (`fixed_kure_attempt_c7ee3363….bm25-index.v2.ndjson`,
1.7GB on disk) OOMs Node's default heap. Both real runs below used
`NODE_OPTIONS="--max-old-space-size=8192"` when spawning the worker. This is an environment
variable, not a code change.

## B. New-question smoke — real full index

5 new questions, **not** any of the frozen 101 `DEV_TUNE` IDs, each a real, already-materialized
chunk's own text pulled fresh by direct SQL from the full index (same established non-Gold-probe
convention `scripts/arm_a_live_worker.test.mjs`/the Arm A repo's own
`p11f0-shard-integration-smoke.mjs` already use) — never touching
`data/eval/phase1_devtune_gold.v0.1.jsonl` or any `gold25` fixture:

| # | chunk_id | document group | doc_id | numeric? |
|---|---|---|---|---|
| 1 | `chunk_25845e0607f2f5a7abf6ae97` | periodic | `periodic_20250814002920` | no (prose fund description) — **55 persisted spans across 55 distinct nodes → genuinely multi-node** |
| 2 | `chunk_64022f2f74ed1a08f029d666` | major | `major_20240910000559` | yes (daily stock-trading table) |
| 3 | `chunk_000605521f33cb42e89c1bc8` | holding | `holding_20230504000774` | mixed |
| 4 | `chunk_0008d4f96bca991cb655b20d` | exchange | `exchange_20250922800142` | yes (정정 계약금액: 690,971,410,282 → 736,334,822,604) |
| 5 | `chunk_000094f84dd03923aacac791` | periodic | `periodic_20250311001180` | no (credit-loss provisioning narrative) |

All 4 real document groups (periodic/major/holding/exchange) are covered; ≥1 numeric and ≥1
non-numeric question; #1 was specifically chosen (55 distinct `order_index` values in its
persisted spans, not merely 55 row/col spans of one node) to surface a genuine
multi-node result without forcing which nodes.

Verified per question, at both the Node worker layer
(`scripts/arm_a_live_worker_full_index.test.mjs`, real subprocess) and independently again in pure
Python (`tests/agents/test_arm_a_live_full_index_smoke.py`, real `ArmALiveWorkerClient` — a second,
separate real worker subprocess, same code path production QA uses):

- Real Arm A worker invoked (BM25 top-100 → KURE-v1 dense top-20 → RRF k=60 → top-k): **yes**, both layers.
- `A.results.jsonl` opened by either the worker or the Python client during this Turn: **0** (structurally verified — see below).
- Top-k respected, never exceeded: yes, all 5×2 = 10 runs.
- Result text never empty: yes, every returned item, both layers.
- Body SHA-256 match (`sha256(text) == chunk_text_sha256`): **verified for every returned item, both the JS layer's own check and the second, independent pure-Python check in `arm_a_live_adapter._verify_item`. 0 mismatches observed.**
- `document_id` present and consistent per item: yes.
- `node_indices` fully preserved (never collapsed to one node): yes — probe #1's self-hit carried its full multi-node `node_indices` (length > 1) at both layers.
- Delivered to Python QA: yes — see §D below (3 of the 5 questions went through the full public `answer_api.answer_ex()` path).
- Citations traceable into the delivered search results: yes (§D).
- B/D (`build_line_window_retriever`/`base.retrieve()`) invocations: **0** — asserted via a fake base whose `retrieve()` raises `AssertionError` if ever called; never raised, in either the direct-retriever sweep or the full `answer_ex()` pipeline run.

### Persistent worker — no restarts

- Node layer: one worker subprocess, started once (`workerStartCount == 1` asserted), served 1
  `readiness` + all 5 `search` requests over the same stdin/stdout pipe.
- Python layer: one separate real worker subprocess (module-scoped `ArmALiveWorkerClient`
  fixture), started once, served 1 `readiness` + 5 direct `search()` calls + 3 full
  `answer_ex()` calls (9 requests total) with the **same subprocess PID observed throughout**
  (`pids_seen` set of size 1, asserted).
- Worker restarts observed, either layer: **0**.

### fetch_node()

Instrumented at runtime (wrapped `ArmALiveWorkerClient.fetch_node` with a call counter) across
both the direct-retriever sweep and the full `answer_ex()` pipeline run: **0 calls**. This matches
a structural finding made before running anything: no caller in the QA serving path
(`qa_agent.py`, `answer_api.py`, `grounded_answer.py`, `fallback.py`, `routing.py`,
`validator.py`, `corpus_retriever.py`) ever calls `.fetch_node(` on a retriever/serving-retriever
object — it is only used by the offline 4-arm evaluation scorer (`fourarm.py`) and by the
`retriever_adapter.py` Protocol's own B/D implementation, neither of which this live path
exercises. Per this Turn's own instructions: **this is recorded as a fact, not made a blocker for
this submission path.** No fetch_node hydration code was added (nothing calls it, so there was
nothing to fix).

## C. fetch_node() determination

As above: **not called anywhere in the real QA answer path.** No implementation change was made to
`fetch_node()` (worker or Python adapter) — the Turn's own instructions say to add a minimal
read implementation *only if* it is called and fails on empty body; since it is never called on
this path, no such change was made, and none of the "no other fallback / no Gold as key / fail
closed on SHA mismatch / no search logic in fetch_node" constraints were at risk.

## D. Real QA delivery + citation grounding (no external LLM key in this environment)

`CLOVA_API_KEY` is unset in this environment (`.env.example` only, no `.env`) — `llm.py`'s
`get_llm()` returns `None` cleanly in that case (no exception), so `qa_agent.answer_question(...,
llm=None)` takes its existing, already-shipped deterministic path (same "LLM 없음" mode this
repo's own prior E2E runs — see `CLAUDE.md` history — already validated at 98-101/101
answerability).

3 of the 5 probe questions were run through the full public `answer_api.answer_ex()` entrypoint
(`retrieval_backend=ARM_A_LIVE`, real worker, fake-base-with-raising-`retrieve()` to prove 0 B/D
fallback):

- All 3 returned a valid 5-string wire (`question_id, question, retrieved_context, think_trace,
  answer` — all strings), `meta["error_code"] == ""`, `think_trace.validation.status != "ERROR"`.
- `meta["llm_used"] is False` for all 3 — confirms the deterministic path was genuinely taken
  (no LLM call was fabricated or silently skipped-but-claimed).
- Every `retrieved_context` entry carried a real, non-empty `document_id` (never fabricated /
  off-corpus) — grounded directly in the real search results this Turn's worker returned.
- `fetch_node()` calls during these 3 answers: 0 (same counter as §B).

Because a valid, grounded answer **was** produced for every question (deterministic path, not an
error/refusal), this does **not** meet the "검색은 성공하지만 답변 생성 불가" condition — search
and answer delivery both succeeded end to end.

## E. Verification run summary

| Metric | Value |
|---|---|
| Base SHA | `1cd64985f4e49808995734865cd4ca11ae0f97e8` (verified identical on `origin` + `demo-ai-festival`) |
| Final SHA (this branch, pre-push) | see `git log -1` on `codex/a-plus-qa-full-index-smoke-v01` at push time |
| Real `retrieval_index_id` / status / count | `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7` / `READY` / `442549` |
| KURE pin | `nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dim 1024 |
| New questions: total / succeeded / failed | 5 / 5 / 0 |
| Worker initializations (real, across this Turn's 2 test layers) | 2 (1 Node-only, 1 Python-driven) |
| Worker restarts | 0 |
| Real search calls against the full index | 5 (Node) + 5 (Python direct) + 3 (Python via `answer_ex`) = 13 |
| Body SHA-256 verifications | every returned item, both layers (JS + independent Python re-check) — 0 mismatches |
| Multi-node preservation | confirmed (probe #1, 55 distinct nodes, full `node_indices` preserved) |
| QA delivery + citation grounding | confirmed for 3/3 `answer_ex()` runs, `llm_used=False` (no `CLOVA_API_KEY` in this environment), 0 errors |
| `fetch_node()` calls (instrumented) | 0 — and structurally never called anywhere in the QA serving path |
| B/D fallback calls | 0 (asserted via raising fake base, never triggered) |
| DB writes (this Turn's own queries/code paths) | 0 (structural: every query site is `SELECT`) |
| DEV_TUNE / DEV_CHECK / HOLDOUT / Gold access | 0 (grep-verified across all new/changed files — the only matches are docstring/comment mentions of what is deliberately *not* read) |

### Tests run

- Existing: `pytest tests/agents/ -k arm_a --ignore=tests/agents/test_answer_wire.py --ignore=tests/agents/test_dense_rerank.py`
  → **47 passed, 2 skipped** (both pre-existing, unrelated — same as the live-retriever turn's own
  43-passed baseline + this Turn's 4 new tests; `test_dense_rerank.py` ignored for a pre-existing
  missing-`numpy` gap in this fresh worktree venv, reported explicitly rather than silently
  skipped past — not this Turn's regression, `numpy` is unrelated to anything this Turn touched).
- Existing: `node --test scripts/arm_a_live_worker.test.mjs` (18-chunk shard, unaffected by the
  session-id wiring change) → **3 passed, 0 failed**.
- New: `node --test scripts/arm_a_live_worker_full_index.test.mjs` (real full index) → **3
  passed, 0 failed**.
- New: `pytest tests/agents/test_arm_a_live_full_index_smoke.py` (real full index, real worker,
  real answer_ex pipeline) → **4 passed, 0 failed** (single combined run, one shared worker
  subprocess across all 4 tests, 179s).

## Final status

**A_PLUS_QA_FULL_INDEX_SMOKE_GREEN**

The full 442,549-chunk READY index (not the 18-chunk shard) is genuinely connected end to end:
real Arm A worker → real BM25+dense+RRF over the full corpus → real hydrated/SHA-verified text →
real Python QA pipeline → grounded citations, for 5 new, cross-document-group, non-Gold questions,
with 0 B/D fallback, 0 `A.results.jsonl` access, 0 DB writes, and 0 Gold/DEV_TUNE/DEV_CHECK/HOLDOUT
access. No score, ranking, or arm winner is declared by this Turn.

## Known gaps (recorded, not blockers for this submission path)

- `fetch_node()` still returns a minimal, non-hydrated `Node` when called (unchanged from the
  live-retriever turn) — moot for this path since nothing in QA serving calls it, but still a real
  gap for any *future* caller that would.
- `DEFAULT_ARM`/`DART_QA_RETRIEVAL_BACKEND` production default is unchanged (still `DEFAULT`/B-D);
  switching it to `ARM_A_LIVE` remains explicitly out of scope, as it was for the prior turn.
- This smoke ran without a `CLOVA_API_KEY`; the LLM-present path (`llm_used=True`) against the full
  index specifically was not exercised here (the deterministic path was, and succeeded).
