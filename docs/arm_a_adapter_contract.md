# Arm A → QA retriever adapter contract

Turn `A-PLUS-QA-ADAPTER-ONLY-V1`. Scope: wire frozen Arm A retrieval results into QA's
`RetrieverAdapter` Protocol only. No retrieval re-run, no judge34/101-question execution, no
Gold access, no safety/performance verdict.

## Sources

- QA target contract: `src/dart_detective/retriever_adapter.py` (`RetrieverAdapter` Protocol:
  `search(question, conditions, k) -> list[Chunk]`, `fetch_node(doc_id, node_index) -> Node`,
  `readiness() -> dict`). Documented in `docs/interfaces.md` §3.
- Arm A frozen output: `A.results.jsonl` (branch `codex/fourarm-a2-integration-v01` @
  `900d3cc72336a1aece86ec776d84f55ec3564cc8`, produced by the implementation on branch
  `codex/fourarm-ac-vector-import-v01` @ `44f05231de8b9a3b6fdb6ff422435d0586937941`) — a separate
  git history from this QA repo, referenced only by an externally supplied path, never copied in.
- Adapter code: `src/dart_detective/arm_a_adapter.py`.

## Two call shapes in this codebase — which one this adapter targets

`retriever_adapter.py` exposes **two** different factory functions with **different return
shapes**:

| Factory | Returns | Consumer |
|---|---|---|
| `bind(arm)` | an object implementing `RetrieverAdapter` (`search`/`fetch_node`/`readiness`) | the documented Protocol — interfaces.md §3, the 4-arm experiment runner |
| `build_serving_retriever(arm)` | `(retriever, store, arm, pins)` where `retriever` is `CorpusRetriever`-shaped (`.conditions()`, `.retrieve()`, optional `.statement_scopes()`) | `answer_api`/`qa_agent`'s live serving path |

This adapter implements the **first shape** (`RetrieverAdapter`, matching `bind()`), because that
is the one the module's own docstring calls "the one door" and the one the user's instructions
describe field-for-field. Bridging it into the second shape so `answer_api` can actually serve
arm A live is explicitly **not done in this turn** — see the handoff doc.

## Field mapping

| A field (per result item unless noted) | QA `Chunk` field | Transform | Lossless? |
|---|---|---|---|
| `rank` | (drives return-list order) + `metadata.provenance.rank` | sort by rank ascending before conversion | yes |
| `doc_id` | `doc_id` | passthrough | yes |
| `node_index` | `node_index` | passthrough (A's own "primary" node) | yes |
| `node_indices` (or absent → `[node_index]`) | `metadata.provenance.node_indices` | passthrough, full list, never truncated to one | yes |
| `chunk_id` | `chunk_id` | passthrough | yes |
| `score` | `score` | passthrough, `float()` | yes |
| `score_type` | `metadata.provenance.score_type` | passthrough | yes |
| `row`, `col` | `metadata.provenance.row`/`col` | passthrough | yes |
| `chunk_text_sha256` | `metadata.provenance.chunk_text_sha256` | passthrough, also used to verify resolved text | yes |
| `doc_id` | `locator` | **reformatted**: A's own record locator string (`{doc_id}::{file}.xml::n{node_index}`) is discarded; QA's canonical `locator_of(doc_id, node_index)` (`{doc_id}/{rcept_no}.xml#node={node_index}`) is recomputed from the same `(doc_id, node_index)` identity, reusing `retriever_adapter.locator_of` unmodified | yes — same identity, re-serialized |
| `doc_id` | `doc_group` | derived: `doc_id.split("_", 1)[0]` (same fallback rule `retriever_adapter.chunk_from_retrieved` already uses for B/D) | yes — deterministic parse of an existing field |
| (record-level) `question_id`, `arm`, `segment`, `config_sha256`, `code_sha256` | `metadata.provenance.*` | passthrough from the containing record | yes |
| — (not present in A) | `text` | via injected `TextResolver`; **fail-closed** (`TextResolutionRequiredError`) if no resolver is configured, or if the resolver's text's sha256 doesn't match `chunk_text_sha256` (`TextIntegrityMismatchError`) | **no** — A carries no raw text, only a hash; this adapter never fabricates or blank-fills it |
| — (not present in A) | `header` | `""`, explicitly documented as "not sourced from Arm A" | no — honest gap, not a guess |
| — (not present in A) | `section_path` | `[]`, same reasoning | no — honest gap |
| — (not present in A) | `metadata.corp_name` / `rcept_dt` / `report_nm` | **omitted entirely** (not set to a guessed value) | no — honest gap; see "Known gaps" |

`conditions` (the `search()` parameter) is accepted for signature compatibility but intentionally
unused: Arm A's results are already frozen, so there is no live re-filtering to apply.

## `TextResolver` interface

```python
class TextResolver(Protocol):
    def __call__(self, *, doc_id: str, node_index: int, node_indices: list[int],
                 chunk_id: str, chunk_text_sha256: str) -> str: ...
```

A read-only callable the caller injects. It must raise on failure — never return `""`. Its
return value's sha256 is checked against `chunk_text_sha256` by the adapter itself before the
chunk is ever handed to QA; a mismatch raises `TextIntegrityMismatchError` rather than silently
serving unverified text. **No default implementation ships in this turn** — see handoff.

## Error taxonomy

| Error | Raised when |
|---|---|
| `ArmAAdapterError` | base class |
| `TextResolutionRequiredError` | no resolver configured, or resolver returns an empty value |
| `TextIntegrityMismatchError` | resolver's text doesn't hash to `chunk_text_sha256` |
| `MalformedArmAResultError` | a required field is missing or has the wrong type |
| `UnknownQuestionForFrozenArmAError` | the `question` string passed to `search()` isn't in the injected Gold question index, or its `question_id` isn't in `A.results.jsonl` |

## `question` → `question_id` resolution

`RetrieverAdapter.search()` takes free-text `question`, but `A.results.jsonl` is keyed by
`question_id`. Since this adapter only ever replays frozen results for the fixed 101-question
DEV_TUNE set, it builds an exact-string `question text -> question_id` index from an injected
Gold questions file (default: the in-repo `data/eval/phase1_devtune_gold.v0.1.jsonl`, the same
file `scripts/judge_devtune.py` already uses). An unrecognized question fails closed rather than
returning empty results or guessing.

## Selection / DI

`build_retriever_for_arm(arm=None, ...)` in `arm_a_adapter.py` is the new composition point:

- Reuses the existing `DART_QA_ARM` env-var convention (default stays `"D"`, matching
  `retriever_adapter.bind()`'s own default — unchanged).
- `arm == "A"` → builds `ArmAFrozenResultsRetriever` (requires `arm_a_results_path` or
  `ARM_A_RESULTS_PATH` env; `A.results.jsonl` lives outside this repo and is never given a
  hardcoded default path).
- any other arm → calls the existing `retriever_adapter.bind(arm, ...)` **unmodified**.

`retriever_adapter.py` and `answer_api.py` are not edited by this turn; wiring this selector into
`answer_api`'s actual serving call site is future work (see handoff).

## Known gaps / deliberately not implemented this turn

- `statement_scopes(doc_id)` (the optional 연결/별도 scope-bonus hook `qa_agent.py` calls via
  `hasattr`) is not implemented. This is safe: it's an optional soft re-ranking signal, not a
  hard validation gate (`validator.py`'s hard checks operate on `text`/citations, which this
  adapter does populate once a resolver is wired).
- `Node.kind` / `Node.section_path` from `fetch_node()` are left empty — no DocumentIR
  node-store is wired in this turn.
- No real `TextResolver` implementation ships — every chunk raises `TextResolutionRequiredError`
  until one is injected.
