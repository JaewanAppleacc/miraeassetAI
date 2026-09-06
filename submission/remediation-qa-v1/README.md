# DART 공시 QA — A4-R4-A3-Remediation-QA runtime

Curated runtime-only export (allowlisted files only) — no git history, no evaluation
data, no other worktrees, no credentials.

## Model structure (default backend: `ARM_A4_A3_REMEDIATION_LIVE`)

```
A4 wide candidate pool  (BM25 top-100 + dense top-100, KURE-v1)
  -> R4_wide_rrf_centric reranker
  -> A3 contradiction guard / stable refill
  -> Remediation policy (REMEDIATION_V1_POLICY: opt-in subtype-relaxed passes with
     evidence promotion, per-receipt-date windows merged round-robin, BM25
     zero-score candidate drop)
  -> QA (routing / grounded answer generation / validation / 5-field wire)
```

`ARM_A4_A3_LIVE` (pre-remediation baseline) is also present, byte-identical, since
`answer_api.py` imports it unconditionally — it is not the active backend by default.

## Source SHA

```
model_source_sha=b5f9443f7ca3ec2d57c2d17453070ab23c4a6341
```

Branch `codex/a4-a3-remediation-integration-v01`, identical on `origin` and
`demo-ai-festival` at packaging time. Per-file provenance in `MODEL_SOURCE_MANIFEST.md`;
per-file hashes of this package's own contents in `SHA256SUMS`.

## Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
npm ci         # pg, ajv, ajv-formats from the committed package-lock.json
```

## Environment variables

See `.env.example` — it contains variable names and non-secret frozen defaults only;
no API keys or absolute paths are included.

## KURE / Postgres / index requirements

- **KURE-v1 pin** (must match embeddings already loaded into Postgres — the worker
  refuses to start on a mismatch): `repository=nlpai-lab/KURE-v1`,
  `revision=4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, `dimension=1024`.
- **PostgreSQL**: pgvector-enabled instance holding this corpus's chunk embeddings
  (dev repo's own test suite targets PostgreSQL 16).
- **DocumentIR** (not bundled): parsed corpus jsonl files, path via
  `DART_QA_DOCUMENT_IR_DIR` — used for node/row text lookup, not retrieval ranking.
- **Stage-1 index** (not bundled): build with `python scripts/build_index.py` (needs
  DocumentIR + the included `data/corpus/manifest.jsonl`/`universe.csv`) into
  `DART_QA_INDEX_DIR` (default `data/index/`).
- **Postgres vector index + BM25 cache** (not bundled, not built by this package):
  point `ARM_A4_A3_REMEDIATION_LIVE_RETRIEVAL_INDEX_ID` /
  `_CORPUS_SNAPSHOT_ID` / `_BM25_CACHE_DIR` at wherever it already exists.

## Run

```bash
cp .env.example .env   # fill in real values
set -a
source .env
set +a
PYTHONPATH=src python scripts/run_server.py
```

The supplied `.env.example` enables the evaluation profile and pins
`DART_QA_CODE_SHA` to the packaged runtime source commit. The optional
`DART_QA_LATE_EXPANSION` experiment remains unset/OFF, matching the selected model's
101-question validation. Do not replace the code pin with an evaluation-result commit.

Serves on `:${PORT:-8000}` (`GET /health`, `GET /ready`,
`GET /answer?question_id=...&question=...`). `python scripts/deploy_probe.py http://<host>:<port>`
runs a fuller readiness check; `python scripts/qa_preflight.py` checks env/index-path
state with no network call.

## Known limitations

- **Backend dispatch registration.** At `model_source_sha`, `ARM_A4_A3_REMEDIATION_LIVE`
  is implemented but not yet registered in `answer_api.py`'s backend dispatch table
  (out of scope for the turn that added it). Rather than patch those pinned files (which
  would break byte-identity with `model_source_sha`), `scripts/run_server.py` builds the
  retriever via its own public builder and injects it through `answer_api.reset()`
  (an existing public hook) before serving. Side effect: `readiness()["retrieval_backend"]`
  still reports the unrelated default `"DEFAULT"` — `readiness()["arm"]`
  (`"A4_A3_REMEDIATION"`) and `readiness()["pins"]["retrieval_backend"]`
  (`"ARM_A4_A3_REMEDIATION_LIVE"`) are the accurate fields.
- **No corpus/index bundled** — see requirements above.
- **HCX only, by competition rule** — `llm.py` has an unused local/dev Anthropic path;
  with no LLM configured it falls back to a deterministic (non-LLM) answer.
- **Fallback order**: rule-based repair -> fixed template -> direct evidence excerpt;
  degraded results are marked non-cacheable.
- **No dense-rerank arm B code** (`dense_rerank.py` excluded — unused by this backend,
  whose dense scoring runs in the Node worker's own Postgres/pgvector + KURE path).
- **No evaluation data included.** The HCX comparison that selected this model as
  default is recorded at `codex/a4-a3-remediation-integration-v01@16289e2a`
  (docs-only commit, referenced by hash only, not included here).
