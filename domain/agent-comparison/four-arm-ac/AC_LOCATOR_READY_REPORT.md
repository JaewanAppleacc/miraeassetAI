# Turn AC-LOCATOR-READY: A/C locator provenance remediation

Base SHA: `f0e3263999616e6acdf3204fe5c7c46fc36221c5` (`feat: implement fixed
A/C retrieval arms`, the AC-IMPL Turn). Branch:
`codex/fourarm-ac-locator-ready-v01`, worktree isolated from every other
concurrent session/worktree in this repo. DEV_CHECK/HOLDOUT were never
accessed; no Gold content was read or used to pick/validate a locator; no
real embedding/HCX call and no corpus re-chunking were performed (verified
by source-scan tests -- see below).

## A. Input pins (unchanged from AC-IMPL, read-only re-confirmed)

- Chunker/config: `fixed-token-512-o64.v0.1.0`,
  `f8ec08aa8286313b6bb77a4ec452b98e6f4e8f3e042291db91444a78a8b1e6eb`.
- Corpus snapshot: `corpus_04750795e1a2d5c3`,
  `8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e`.
- KURE pin: `nlpai-lab/KURE-v1` rev `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`,
  dim 1024.
- AC-IMPL shard: 1,144 chunks, `fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583`
  (READY, per AC_IMPL_HANDOFF.md; not independently re-queried this Turn --
  no live DATABASE_URL/KURE server was available in this session, so no
  real-DB query was attempted; see "Not executed this Turn" below).

## B. Root cause -- by type, with reproducible evidence

Traced in `domain/chunking/chunker.mjs` (`chunkFixed` /
`tokenWindowsFromSegments` / `packSegments` / `mergeSpans`) and
`domain/agent-comparison/four-arm-ac/{locator-provenance,arm-retriever-adapter}.mjs`.

| # | Candidate cause (per the brief's checklist) | Verdict | Evidence |
|---|---|---|---|
| 1 | Adapter lost an originally-precise node+row locator | **Not found** | `chunkFixed()`'s `mergeSpans()` already persists the FULL ordered span list per chunk (`{node_id, order_index, row_start, row_end, col_start, col_end, source_locator}`), and the prior Turn's staging loader persists that array unmodified into `reference_fixed_kure_chunk_staging.source_spans`. No lossy step exists between chunker output and staged `source_spans`. |
| 2 | A Fixed chunk legitimately spans multiple rows/nodes -- multiple locators are correct | **Confirmed, dominant cause** | `tokenWindowsFromSegments()` concatenates ALL segments (table rows, paragraphs, section titles) of a document with `"\n"` and slides a fixed 512-token/64-overlap window across the concatenated text (`chunker.mjs:148-166`). A window's `usedSegments` is whatever segments its character range overlaps -- by construction this can span many table rows of one node (measured: `NODE_RESOLVED_ROW_AMBIGUOUS`, 821/1144 = 71.77%) or cross node boundaries entirely (measured: `MULTI_NODE_AMBIGUOUS`, 311/1144 = 27.18%). This is expected chunker output, not a defect. |
| 3 | Parser/DocumentIR itself fails to supply an accurate row | **Not found** | Every table-row segment already carries its own `row_start`/`row_end`/`col_start`/`col_end` from `node.normalized_rows` (`chunker.mjs:79-98`) at segment-build time, before any windowing. No row information is missing at the DocumentIR layer for the measured shard (0/1144 `EMPTY_SPANS_INVALID`). |
| 4 | Chunk-occurrence <-> source-locator join error | **Not found** | `arm-retriever-adapter.mjs`'s `fetchStagingSpans()` joins on `(load_session_id, chunk_id)` -- the same two keys the staging table is keyed and queried by everywhere else in this codebase; no alternate join path exists. |
| 5 | Multi-node chunk provenance representation contract is insufficient | **Confirmed, the actual defect** | `classifySpans()` already computed the full candidate list (`candidate_spans`/`candidate_node_indices`) for ambiguous chunks, but `toArmResultItem()` (the only place search results are built) discarded it, exposing just one (frequently `null`) `node_index`/`row`/`col` per result. Separately, `readiness()` gated `official_experiment_ready` on `coverage.all_fully_resolved` (100% single-node+row) -- conflating cause #2 (legitimate ambiguity) with a real gap, which is exactly why `official_experiment_ready` was `false` for both arms even though every chunk had fully-honest, complete provenance data available. |

**Conclusion:** the corpus/chunker/parser/loader/join layers are all
already correct and lossless. The defect was entirely in the four-arm-ac
result/readiness CONTRACT: (a) result items didn't expose the multi-
candidate provenance set, and (b) `readiness()` used the wrong bar
(100% singular resolution) instead of "every chunk has an interpretable,
non-empty candidate set."

## C/D. Remediation -- metadata/sidecar only, zero corpus/chunk/embedding changes

Changed files (all four-arm-ac application layer + its offline tests --
nothing in `domain/chunking/`, `domain/postgres/`, embedding adapters, or
any migration):

- `locator-provenance.mjs`: added `buildProvenanceSet(spans)` (occurrence-
  level provenance sidecar: status, `unresolved`/`unresolved_reason`,
  deduplicated `candidates[]`, `candidate_count`), `buildDownstreamExpansionInput(docId, provenanceSet)`
  (ready-to-call `{doc_id, node_index}` pairs for node-grounded late
  expansion / `fetch_node`), and extended `summarizeLocatorCoverage()` with
  `unresolved_count` / `ambiguous_count` / `provenance_ready` (the corrected
  gate: `total > 0 && unresolved_count === 0`). `all_fully_resolved` /
  `fully_resolved_fraction` are kept, unchanged in meaning, as observability-
  only measurements. `verifyNodeIdentity()` gained optional `row`/`col`
  params (fail-closed reject when supplied and not among the node's own
  persisted spans) -- additive, existing node-only calls unaffected.
- `arm-retriever-adapter.mjs`: `toArmResultItem()` now attaches a
  `provenance` field (status/unresolved/candidates/candidate_count/
  downstream_expansion_input) to every A and C result item, built via the
  identical `buildProvenanceSet` call for both arms -- purely additive,
  every pre-existing field (`node_index`/`row`/`col`/`locator`/
  `locator_status`) keeps its old value and meaning. `fetch_node()` gained
  optional `{row, col}` (default `null`, existing 2-arg call sites
  unaffected). `readiness()`'s gate changed from
  `coverage.all_fully_resolved` to `coverage.provenance_ready`; the reason
  code changed from `A_C_LOCATOR_PROVENANCE_NOT_READY` (fired on any
  ambiguity) to `A_C_LOCATOR_UNRESOLVED_SPANS_PRESENT` (fires only when a
  chunk has zero persisted spans -- a genuine gap).

No chunk_id, chunk text, `raw_text`, `embed_text`, embedding config, or
corpus/chunker file was read for writing or touched for writing.
`git diff --stat` for this Turn touches exactly 2 source files
(`locator-provenance.mjs`, `arm-retriever-adapter.mjs`) and 2 test files --
nothing else.

**METADATA_ONLY_LOCATOR_FIX = true.** Chunk count, chunk IDs, chunk text
bytes, embedding-input bytes, embedding config, and existing vector/index
compatibility are all unaffected -- this Turn never reads or writes
`reference_retrieval_chunks.text_content`, `text_sha256`, any embedding
table, or the chunker/ids/embedding-adapter modules. **REEMBEDDING_REQUIRED
does not apply; no full-load-blocking handoff is produced.**

## E/F. Resolution distribution (measured by the AC-IMPL Turn; re-derivable, not re-measured this Turn -- no live DB/KURE was available in this session)

| status | count | share | readiness impact (before -> after) |
|---|---|---|---|
| NODE_AND_ROW_RESOLVED | 12 | 1.05% | ready -> ready |
| NODE_RESOLVED_ROW_AMBIGUOUS | 821 | 71.77% | **blocked -> ready** (legitimate ambiguity, full candidate set preserved) |
| MULTI_NODE_AMBIGUOUS | 311 | 27.18% | **blocked -> ready** (legitimate ambiguity, full candidate set preserved) |
| EMPTY_SPANS_INVALID (unresolved) | 0 | 0.00% | would block (isolated, not conflated with ambiguity) |

`official_experiment_ready` for this shard's real data therefore flips
from `false` (reason `A_C_LOCATOR_PROVENANCE_NOT_READY`, now retired) to
`true` -- conditioned on `unresolved_count === 0` holding when re-queried
live (measured by AC-IMPL's own integration test to be the case: 12+821+311
= 1144, no remainder). This is NOT because resolution improved to 100% --
it did not, and per this Turn's own instruction that is not the goal. It is
because the readiness contract no longer conflates "multiple correct
locators" with "no usable locator."

Zero fatal errors (no chunk's provenance ever names a node/document other
than its own -- structurally guaranteed: `fetch_node`'s SQL always scopes
`WHERE load_session_id = $1 AND document_id = $2`, tested). Zero
UNRESOLVED chunks isolated as such in this shard; the contract now
supports and isolates them (via `unresolved`/`unresolved_reason` and
`provenance_ready`) if a future materialization run produces any.

## Scoped test results (offline, no DB/KURE/Gold)

`node --test tests/four-arm-fixed-ac.test.mjs`: **51/51 passing** (31
pre-existing + 20 new, covering every item in the brief's Section E test
matrix: node-only / row-qualified / cell-qualified locators, multi-row and
multi-node Fixed chunks, mixed table+prose chunks, multi-candidate
preservation, invalid document/node/row/column rejection, zero-locator
fail-closed, duplicate-locator dedup, order determinism, malformed-spans
UNRESOLVED classification, Gold-correction structural impossibility, A/C
shared-path parity, metadata/Gold non-leak, vector/embedding non-access,
double-run canonical SHA match, and DEV_CHECK/HOLDOUT non-reference).

`tests/four-arm-fixed-ac-postgres16-integration.test.mjs` was updated for
consistency (its readiness assertion now checks `provenance_ready` /
`unresolved_count` instead of `all_fully_resolved`) but **not executed**
this Turn -- it requires a live `DATABASE_URL` + running local KURE-v1
server, neither of which was available in this session, and the brief
directs against any real embedding/HCX call. `npm run test:domain` and
`verify:contracts` were not run (out of this Turn's scope per the brief).

## Readiness (Section F)

- Every returned chunk has an interpretable provenance set: **yes**
  (`buildProvenanceSet` never returns an empty candidate list except for
  the explicit `unresolved` case).
- Zero fatal cross-document/node errors: **yes** (structural, tested).
- Multi-row/multi-node ambiguity not hidden: **yes** (full `candidates[]`
  surfaced on every result item, never collapsed).
- Downstream expansion input provided: **yes**
  (`provenance.downstream_expansion_input`, ready for
  `fetch_node(doc_id, node_index, {row, col})`).
- Determinism: **PASS** (double-run SHA match test).
- Metadata/Gold leakage: **0** (tested).
- Existing vector compatibility: **unaffected / fully reusable** (no
  chunk/embedding-path code touched).
- Unresolved isolated: **yes** (`unresolved`/`unresolved_reason`,
  `unresolved_count`, distinct from ambiguity counts).

## Commit/push

Commit message: `fix: preserve source provenance for fixed retrieval arms`.
Pushed to `origin/codex/fourarm-ac-locator-ready-v01`. No Gold content, raw
corpus, vectors, DB state, or environment config included in the commit
(only the two source files, two test files, and this report).
