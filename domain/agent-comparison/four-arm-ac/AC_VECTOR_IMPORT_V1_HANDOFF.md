# Turn AC-VECTOR-IMPORT-V1 handoff

Status: `A_C_FULL_INDEX_READY`; unified official four-arm execution remains blocked on the real, pinned conditions artifact.

## Scope and immutable inputs

- Branch base: `a35608c` (`codex/fourarm-ac-colab-full-shards-v01`).
- Full corpus: 4,204 documents; Fixed-512 search-eligible occurrences: 442,549.
- Eligible unique embedding inputs: 441,879.
- KURE pin: `nlpai-lab/KURE-v1` revision `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024, float32.
- Eight-shard logical merge manifest SHA-256: `d79e046ec03944e6c2282939ec3a9596eebebd58484201f0b8e23ebbc0b923af`.
- Shard coverage: 8/8, 441,879 rows, duplicate/missing/out-of-range indices all zero.
- No Gold, DEV_TUNE, DEV_CHECK, or HOLDOUT data was read by the import/materialization path.

## Additive database contract

Migration `013_reference_fixed_kure_precomputed_embeddings.sql` adds an immutable discovery-source link, a precomputed-vector staging table, an imported-shard audit table, and a keyset materialization cursor. `inherit_fixed_kure_discovery()` links a pristine successor attempt to an already verified terminal discovery attempt. It does not copy, reparent, delete, or update the source attempt's discovery rows.

The source attempt remains:

- `fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36`
- status `INVALID_DISCOVERY_CANONICAL_SCOPE`
- 4,204 documents and 442,549 eligible occurrences
- zero embedded/materialized rows on the source attempt
- original `updated_at` unchanged

The materialized successor is:

- `fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e`
- source link to the attempt above
- status `READY`
- 441,879/441,879 unique vectors imported
- 442,549/442,549 eligible occurrences materialized

## Import and materialization

`p11f0-precomputed-vector-import.mjs` streams each NPY row and validates the result manifest, vector/mapping SHA, row identity, input SHA, global index, finite values, dimension, and normalization before creating a PostgreSQL binary-COPY spool. Each shard is imported atomically and recorded by immutable audit metadata. Re-running a fully imported shard is idempotent only when every recorded identity pin matches.

Materialization uses server-side `INSERT ... SELECT` batches and a persisted keyset cursor. It joins occurrences from the immutable discovery source to vectors stored under the successor; raw text or vector arrays are not loaded into Node as a full-corpus collection.

All eight shards imported successfully. The retrieval index `fixed_kure_index_8fe191342205848d1d6a6123f38a54e7` is `READY` with 442,549 unique chunk IDs and zero wrong-dimension rows. A real dense self-match query returned its source chunk at rank 1 (exact scan approximately 1.3 seconds on the scratch database).

## Adapter wiring and readiness

Arm A/C construction now accepts two explicit pins:

- `loadSessionId`: the `READY` successor used for state, materialized chunks, and dense retrieval.
- `provenanceLoadSessionId`: the immutable discovery source used for `source_spans`, `fetch_node`, and locator provenance.

This separation prevents either fabricated provenance on the successor or a false readiness failure caused by reading the terminal source's status. Full-corpus locator readiness is computed in PostgreSQL as bounded aggregate counts rather than returning 442,549 JSON rows to Node. Result: 442,549 provenance rows, zero empty span sets, `provenance_ready=true`.

Real arm-A readiness result:

- `code_ready=true`
- `full_index_ready=true`
- `official_experiment_ready=true` at the A/C infrastructure layer
- BM25 ready: 442,549 documents
- dense index ready: true
- load session: `READY`, 442,549/442,549 materialized
- locator unresolved: 0

Arm C continues to reject vector/embedding dependencies structurally; dense, RRF, and embedding calls remain impossible on its code path.

## Verification

- Offline scoped tests: 58/58 passed.
- Real PostgreSQL integration tests: 7/7 passed.
- Interface schema validation: 36/36 pairs passed.
- TypeScript no-emit check: clean.
- `git diff --check`: clean.
- Source discovery attempt: unchanged.
- Real HCX calls: zero.
- Production runtime wiring: unchanged.

## Remaining gate

Do not run the official DEV_TUNE comparison from this branch yet. A/C infrastructure is ready, but `config.A.json` and `config.C.json` intentionally retain `metadata_filter.source=SYNTHETIC_FIXTURE_ONLY`. Import the B/D workstream's real conditions artifact, verify its pinned SHA and common-universe identity, then execute all four arms through the single frozen runner/scorer. DEV_CHECK remains one-shot and HOLDOUT remains inaccessible.
