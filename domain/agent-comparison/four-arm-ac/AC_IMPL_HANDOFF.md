# Turn AC-IMPL handoff: Fixed-512 A/C search stack + full-load pin

Authority: `/Users/jaewan/Downloads/4arm-vfinal-spec.txt`, SHA-256
`1a856dada61135df7c79f2cfc3c541a5fee8e820927e70786d00368db42da9f5` (the
SHA-256 given in this Turn's own brief was a 65-hex-character string --
one character too long to be a real SHA-256 -- and did not match this
file's real digest; the Owner confirmed the computed 64-character digest
above as the authoritative pin for this Turn. The spec file itself was
never modified.). Reference-only (per CLAUDE.md section 0, "다른 저장소와
과거 작업자의 구현은 참고 자료"): `interfaces.md`, `team-architecture-v4.txt`,
`team-split.md` -- these describe a SEPARATE team's Python codebase
(`dart_corpus.retrieval.conditions.QueryConditions`, `conditions.py`,
`DART_QA_ARM`) that does not exist in, and has no compatibility obligation
with, this repository.

DEV_TUNE-101 was NOT executed. DEV_CHECK/HOLDOUT were never accessed. No
new full embedding run was started.

## What this Turn built

- `domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs` --
  `createArmRetrieverAdapter({ arm: "A"|"C", ... })`. `search(question,
  conditions, k=20)`, `fetch_node(doc_id, node_index)`, `readiness()`.
  Reuses, unmodified: `fixed-kure-hybrid-retriever-adapter.mjs` (arm A's
  BM25+dense+RRF path) and `fixed-kure-bm25-index.mjs`'s persisted BM25
  index (the SAME index object for both arms -- no second index is ever
  built). Arm C's constructor throws if given a `vectorRepository`/
  `embeddingAdapter` -- zero dense/embedding/RRF access is structural, not
  just a call-count claim (also asserted by a static source-scan test).
- `domain/agent-comparison/four-arm-ac/locator-provenance.mjs` -- section G.
- `domain/agent-comparison/four-arm-ac/conditions-fixture.mjs` -- section D,
  synthetic-fixture-only metadata filter builder (no `conditions.py` exists
  in this repo -- see above).
- `domain/agent-comparison/four-arm-ac/pair-diff.mjs` -- section E.
- `domain/agent-comparison/four-arm-ac/config.A.json` /`config.C.json`.
- `tests/four-arm-fixed-ac.test.mjs` -- 31 offline tests (no DB/KURE/Gold).
- `tests/four-arm-fixed-ac-postgres16-integration.test.mjs` -- 5 tests
  against the real scratch PostgreSQL 16 + real local KURE-v1 server.

## B. Fixed common base -- reused, not rebuilt

A and C both use the SAME `fixed-token-512-o64.v0.1.0` chunker output, the
SAME corpus snapshot, the SAME persisted BM25 index (`fixed-kure-bm25-index.mjs`,
one `buildFixedKureBm25Index` call per load session), and the SAME
`passesMetadataFilters` predicate. Arm C's BM25 candidate generation calls
`bm25Search(bm25Index, question, {topK: BM25_TOP_K})` -- the identical call
arm A's own BM25 leg makes internally -- never a separate index or a
different top-K.

## D. Metadata non-leak

No `conditions.py` exists in this repository (see Authority section above).
Per vFINAL section D's own fallback rule, this Turn built
`conditions-fixture.mjs`: `buildMetadataFiltersFromConditions(conditions)`
accepts only `{corp_codes, document_ids, doc_groups, doc_subtypes,
base_years, base_months, receipt_date_from, receipt_date_to, is_correction,
retrieval_eligible}` and silently drops any other field -- a structural
non-leak guard, not just a policy. Tested with a fixture that deliberately
includes Gold-shaped keys (`gold_document_ids`, `expected_answer`,
`required_slot_ids`, `evidence_locator`, `other_arm_results`) and asserts
none of that content reaches the output. `SYNTHETIC_CONDITIONS_FIXTURES`
are hand-authored, question-text-only, never derived from Gold.

## E. Config + pair-diff

`config.A.json`/`config.C.json` pin: arm_code/arm_id, corpus_snapshot_id +
corpus_manifest_sha256 (currently the 1,144-chunk VALIDATION_SHARD_750,
**not yet the full corpus** -- see section J below), chunker id/SHA, BM25
tokenizer/algorithm/index module/candidate_count=100, dense
enabled/candidate_count/index/distance_metric, embedding
repository/revision/dimension, RRF enabled/constant=60, final_top_k=20,
`code_head_sha256` (currently `null` -- stamp with the real commit SHA
immediately before any actual DEV_TUNE-101 execution, per vFINAL section
15; this Turn never executes it so there is nothing to stamp yet),
`embedding_index_config_sha256`.

`pair-diff.mjs`'s `ALLOWED_PAIR_DIFF_KEYS = [arm_code, arm_id, dense,
embedding, rrf]`. `computeConfigPairDiff(configA, configC).disallowed_keys`
is `[]` for the real config pair (tested). A mutation to any other
top-level key (tested: `chunker`, `corpus_snapshot_id`) is rejected via
`assertConfigPairValid` throwing `ConfigPairMismatchError` (`code:
"CONFIG_PAIR_MISMATCH"`).

## G. Locator provenance -- measured, not assumed

`domain/chunking/chunker.mjs`'s `chunkFixed()` already records the FULL
ordered list of contributing DocumentIR node-level spans per chunk
(`source_spans`), and the loader persists that array into
`reference_fixed_kure_chunk_staging.source_spans` (indefinitely, per that
table's own design -- never deleted after materialization). What is NOT
persisted anywhere is each span's own node-local text or its character
offset inside the chunk's `raw_text` -- so a chunk spanning >1 node cannot
be reduced to ONE verified node_index for an arbitrary slot-match span
without re-deriving that offset, which this Turn does not do (that would
require re-parsing the original DocumentIR per document, out of this
Turn's scope).

`locator-provenance.mjs`'s `classifySpans()` therefore returns one of three
honest states instead of ever guessing:

- `NODE_AND_ROW_RESOLVED` -- single span (or single table row): exact.
- `NODE_RESOLVED_ROW_AMBIGUOUS` -- all spans share one node_id (same table),
  but 2+ distinct rows: the document node is certain, the row is not.
- `MULTI_NODE_AMBIGUOUS` -- spans cross 2+ distinct node_ids: neither node
  nor row is resolved; the full ordered candidate list is still returned
  (never collapsed to one "representative" node).

**Measured against the real 1,144-chunk shard**
(`fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583`), via the real-DB
integration test:

| status | count | share |
|---|---|---|
| NODE_AND_ROW_RESOLVED | 12 | 1.05% |
| NODE_RESOLVED_ROW_AMBIGUOUS | 821 | 71.77% |
| MULTI_NODE_AMBIGUOUS | 311 | 27.18% |

Node-level identity (which document node/table a slot-match belongs to,
the case vFINAL section 14 treats as potentially "치명" if wrong) is
therefore resolved for (12+821)/1144 = **72.8%** of chunks; row-level
pinpointing inside a resolved table node is the dominant residual gap
(71.77%), and full node+row resolution succeeds for only 1.05%. Because
vFINAL section G requires this be resolved (not merely mostly-resolved)
before official readiness, `readiness().official_experiment_ready` is
`false` with reason `A_C_LOCATOR_PROVENANCE_NOT_READY` for both arms
against this shard, even though `full_index_ready` is `true`.

`fetch_node(doc_id, node_index)` verifies node IDENTITY only (that the
requested node genuinely appears among a chunk's own persisted spans,
fail-closed `found:false` otherwise) -- it never returns fabricated
node-level text (`node_text_available: false, node_text: null` always),
because that text is not persisted independently of chunk-level
`raw_text` by this loader.

## H/I. Failure classification and readiness

`readiness()` returns `code_ready` / `full_index_ready` /
`official_experiment_ready` separately, plus `checks` (bm25/dense/session/
locator-provenance detail, each a real query result) and `reasons`
(`BM25_INDEX_EMPTY_OR_MISSING`, `A_DENSE_INDEX_NOT_READY_OR_PIN_MISMATCH`,
`LOAD_SESSION_NOT_READY_OR_COUNT_MISMATCH`,
`A_C_LOCATOR_PROVENANCE_NOT_READY`). Construction itself fails closed (not
just `readiness()`) on a KURE revision/dimension pin mismatch for arm A,
and on any dense dependency supplied to arm C. `search()`/`fetch_node()`
reject malformed input (empty question, non-positive k, non-string doc_id,
negative node_index) rather than silently coercing.

## J. Full-load start pin

Verified this Turn (real queries against the scratch PostgreSQL, real
running KURE-v1 server matching the pin exactly):

- Fixed chunker/config SHA: **confirmed**,
  `f8ec08aa8286313b6bb77a4ec452b98e6f4e8f3e042291db91444a78a8b1e6eb`
  (`fixed-token-512-o64.v0.1.0`), identical on the shard session and the
  (stalled) full-corpus session row.
- corpus SHA: **confirmed**,
  `8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e`
  (`corpus_04750795e1a2d5c3`), identical on both session rows.
- KURE pin: **confirmed** -- `nlpai-lab/KURE-v1` rev
  `4ed4540949c70b7da2c74004a915e1f2d5e46e4f` dim 1024, matching both the DB
  rows AND the actually-running local embedding server process's own
  `--repository-id`/`--revision`/`--expected-dimension` flags.
- loader code + schema tests: **GREEN** (31 offline + 5 real-DB tests, this
  Turn's own scoped suite; the three pre-existing uncommitted
  `p11f0-*-phase.mjs` try/finally connection-leak fixes were left as found,
  not authored by this Turn -- see "Pre-existing uncommitted state" below).
- shard 1,144 READY + integrity: **GREEN**, re-validated this Turn against
  the live DB/KURE server (`materialized_chunk_count=1144 ==
  expected_total_chunk_count=1144`, `expected_unique_embeddable_count=1142`).
- existing full-load session conflict: **none active**. One full-corpus
  DISCOVERY session (`fixed_kure_session_8fe191342205848d1d6a6123f38a54e7`,
  `corpus_04750795e1a2d5c3`, no shard suffix) exists in status
  `DISCOVERING` with **0 staging rows** -- created 2026-09-02 16:14:52,
  immediately after this worktree's HEAD commit, essentially a stub with no
  real progress (most likely interrupted by the exact pg-connection-hang
  bug the pre-existing uncommitted `try/finally` diffs fix). Not touched by
  this Turn.
- **unique embeddable count 441,879: NOT independently confirmed.** The
  P11-F handoff (`domain/agent-comparison/P11F_DEV_TUNE_FOUR_VARIANT_HANDOFF.md`)
  states this count "as supplied by the Owner; not independently
  re-derived". The only full-corpus DISCOVERY session has 0 rows written,
  so there is no completed double-pass count to check it against. Running
  the full-corpus DISCOVERY pass to independently confirm it is NOT in this
  Turn's permitted test scope (section K lists only "shard 1,144 smoke",
  not a full-corpus discovery run), so this Turn does not attempt it.

**Verdict: `FULL_LOAD_START_BLOCKED`.** Sole blocking reason: the
441,879 unique-embeddable-count pin is Owner-supplied but not yet
independently, machine-verified (the one real attempt at a full-corpus
DISCOVERY pass has zero progress). Every other J-condition is confirmed.
Once a dedicated Turn runs (or resumes) the full-corpus DISCOVERY pass to
completion and the double-pass determinism check
(`scripts/p11f0-corpus-discovery.mjs`'s own PASS 1/PASS 2 SHA match) GREEN,
re-run this check; if the independently-derived count matches 441,879 and
everything else above still holds, `FULL_LOAD_START_READY` follows.

## Pre-existing uncommitted state (not authored by this Turn)

At the start of this Turn, the worktree already had uncommitted changes to
`.claude/settings.json` (a lighter `git diff --check` PostToolUse hook,
replacing a `verify:contracts` hook -- documented in the P11-F0 handoff as
a deliberate prior-Turn override) and `scripts/p11f0-{corpus-discovery,
embedding-phase,materialization-phase}.mjs` (a `try`/`finally` fix for a
pg-connection-hang bug, matching a pattern already applied to
`p11f0-shard-integration-smoke.mjs`). This Turn read and verified those
diffs (mechanical, no logic change) but did not author, modify, or commit
them, per this Turn's own instruction not to touch `.claude/settings.json`
and not to delete another Turn's in-progress work.
