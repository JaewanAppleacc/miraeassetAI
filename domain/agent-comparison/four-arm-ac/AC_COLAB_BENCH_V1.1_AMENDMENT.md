# Turn AC-COLAB-COMPAT-V1.1 -- benchmark contract amendment

Status at amendment time: this document is fixed and committed BEFORE any
cosine number for this Turn is computed. It amends Turn AC-COLAB-BENCH-V1
(see `AC_COLAB_BENCH_V1_HANDOFF.md`), does not reopen Architecture Contract
v1.1 (CLAUDE.md section 1, FROZEN), does not touch Gold/DEV_CHECK/HOLDOUT/DB,
and does not change either cosine threshold.

## 1. Why this amendment exists

Turn AC-COLAB-BENCH-V1 section F reproduced two real local-reference-run
failures (0/5,000 and 0/500 rows embedded), root-caused to system-wide
memory pressure (~195MB free RAM at the time), not to a code or model bug.
The Colab side of that Turn was prepared but not run.

Since then, the user ran `gpu-benchmark-colab-cuda-runner-v2.ipynb` on a
real Colab GPU runtime (Tesla T4) and downloaded a complete, real 4-file
result package to `~/Downloads/colab-cuda-*`:

- `row_count_requested = 5000`, `row_count_succeeded = 5000`,
  `row_count_failed = 0`
- model pins match exactly: `nlpai-lab/KURE-v1` @
  `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024
- `generated_at = 2026-09-04T01:36:12Z`

This Turn independently re-measured system memory at start:
`vm_stat` reports ~211,752 free pages x 16KB = **~3.4GB free**, a large
improvement over the ~195MB at the prior failure. A full 5,000-row local
run is still not attempted this Turn (no re-measurement of the ~15-hour
extrapolated full-run cost was performed, and re-running Colab is out of
scope -- see section 4). Instead, this amendment fixes a smaller, still
statistically meaningful **500-row local reference run**, chosen to be
directly, deterministically comparable against the ALREADY-COMPLETE Colab
5,000-row package without re-running Colab and without reusing either of
Turn V1's two failed local attempts (`work/turn-ac-colab-bench-v1/local-run`
and `local-run-500`, both zero-success, one truncated/empty output).

## 2. What changes (additive, versioned, tested)

### 2.1 Local reference-run scope: 500-row deterministic length-stratified subset

The prior Turn's `benchmark-sample-fulltext-first500.jsonl` was the literal
first 500 rows (by ascending `embed_text_sha256`) of the 5,000-row sample --
not stratified by anything, and never reused by this Turn (superseded, not
patched in place, since other artifacts may still reference it).

This amendment fixes a NEW deterministic selection, over the SAME 5,000-row
population in `work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl`
(itself a fixed subset of the Colab package's population -- every one of
its `embed_text_sha256` values is therefore also present in the Colab
5,000-row result, which is what makes a hash-matched cosine comparison
against the existing Colab package possible without a new Colab run):

1. Compute `char_length = text.length` (UTF-16 code units) for every row.
2. Sort rows by `char_length` ascending, tie-broken by `embed_text_sha256`
   ascending (fully deterministic, no RNG).
3. Partition the sorted rows into **10 equal-size length strata (deciles)**
   by rank (population 5,000 / 10 = 500 rows/stratum).
4. Within each stratum, re-sort by `embed_text_sha256` ascending and take a
   **SHA-evenly-spaced selection of 50 rows** (`step = stratum_size / 50,
   floor-indexed`) -- the exact method the original 5,000-sample selection
   already uses (`p11f0-embedding-input-manifest.mjs`), applied per-stratum
   instead of over the whole population, so the result density-matches the
   existing project convention instead of introducing a new one.
5. Total: 10 x 50 = 500 rows, spanning the full text-length distribution of
   the 5,000-row population (not concentrated in short/typical-length
   chunks the way an unstratified first-N or hash-only sample can be).

Implemented in `scripts/p11f0-colab-benchmark-select-local-subset.mjs`.
Deterministic and reproducible: re-running against the same input file
reproduces byte-identical output and the same `sample_manifest_sha256`
(asserted by an automated test). Fails closed (refuses to run, no partial
output) if the population size is not exactly 5,000, if any row is missing
`text`/`embed_text_sha256`/`embedding_input_id`, or if any stratum would
need more rows than it contains.

### 2.2 Local runner bug fixes (`scripts/p11f0-colab-benchmark-local-reference-run.mjs`)

Three real bugs, fixed in place (same file, same 4-file output shape,
same `schema_version` string -- the file FORMAT is unchanged, only the
runner's failure-handling behavior):

1. **mkdir**: the runner never created `outDir` before writing; a
   not-yet-existing output directory made every `writeFileAtomic` call
   fail with `ENOENT` on its `.partial` rename step. Fixed: `outDir` is
   created (`recursive: true`) before any write is attempted.
2. **fail-fast**: the runner previously treated a batch timeout/failure as
   "mark these rows failed, continue to the next batch" -- for a
   systemically failing run (as Turn V1 section F measured: full timeout
   on every batch) this meant grinding through the ENTIRE input at
   `perBatchTimeoutMs` cost per batch (75+ minutes for 500 rows at the
   previously observed 90s/batch timeout) before ever reporping a
   failure. Fixed: the runner now aborts the ENTIRE run on the FIRST
   batch failure (network error, timeout, or non-2xx HTTP status) --
   consistent with this Turn's requirement that a local run is only
   meaningful as a true 500/500, never a partial result silently
   compared against Colab.
3. **incomplete-output**: on any row failure, the old runner still wrote
   all 4 output files at the end, with the failed rows' slots in the
   `.npy` matrix left as all-zero (never through `l2Normalize`, since
   that path is skipped on failure) but WITHOUT a corresponding
   `row-mapping.jsonl` line -- producing a package whose `.npy` row count
   did not match its mapping row count, which the verifier's
   `ROW_COUNT_MAPPING_MISMATCH` check would eventually catch, but only
   after a fully-written, integrity-signed 4-file package gave the false
   impression of a complete result. Fixed: combined with the fail-fast
   change above, the runner now writes NO output files at all on any
   failure -- a failed run leaves `outDir` exactly as it was found (no
   `.npy`/`.jsonl`/`.json` written), and exits non-zero with a clear
   `LOCAL_RUN_ABORTED_ON_BATCH_FAILURE` message. A result package on disk
   is only ever a genuinely complete, all-succeeded run.

### 2.3 Verifier extension for subset-vs-full comparison (`scripts/p11f0-colab-benchmark-verify.mjs`)

`verifyGpuBenchmarkPackage` gains one new, optional parameter:
`localSampleFulltextPath`. When provided, it is used (instead of
`sampleFulltextPath`) to compute the expected id set and input-ordering SHA
for the LOCAL package only; the REMOTE package continues to be checked
against the full `sampleFulltextPath` population. When omitted, behavior is
byte-for-byte identical to before (both packages checked against the same
population) -- fully additive, no existing caller or test needs to change.
The cross-package cosine comparison (`compareCosine`) already matched rows
by `embed_text_sha256` rather than row position or population membership,
so it requires no change: it will naturally compare exactly the local
package's 500 rows against their matching rows in the remote package's
5,000, and nothing else.

## 3. What does NOT change

- `COSINE_MEAN_MIN = 0.9999` and `COSINE_MIN_MIN = 0.999` -- unchanged,
  still asserted by an automated test, still fixed before this Turn's
  cosine number exists.
- The 4-file result package format, `schema_version` strings, model pins
  (`nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`,
  dimension 1024), and integrity-manifest mechanism.
- The existing 5,000-row `benchmark-sample-fulltext.jsonl` and the Colab
  notebook -- neither is modified or re-run.
- No DEV_CHECK/HOLDOUT/DB access. No Gold access. No Architecture Contract
  change.

## 4. Explicitly out of scope for this Turn

- Re-running Colab. The existing 5,000-row Colab package is reused as-is.
- Attempting a full local 5,000-row run. Not reproduced as failing again
  this Turn (memory conditions have measurably improved), but also not
  attempted -- 500 rows is judged sufficient to validate local/Colab
  embedding compatibility while keeping local wall-clock time bounded.
- Reusing either of Turn V1's two failed local-run directories
  (`work/turn-ac-colab-bench-v1/local-run`, `local-run-500`) as if they
  were real data. Both are zero-success, truncated (empty `run-stdout.json`)
  artifacts and are not read by this Turn's scripts or reports.

## 5. Governance basis (CLAUDE.md section 16)

This amendment is justified by basis 1 ("Seed E2E에서 재현된 실패"): Turn
AC-COLAB-BENCH-V1 section F is a reproduced local-run failure, and this
amendment's narrower 500-row scope with a fail-fast/no-incomplete-output
runner is the direct, tested response to that reproduced failure. It is an
internal candidate-script contract change (`scripts/`, not `domain/`
Architecture), governed by CLAUDE.md section 0's "그 밖의 ... 청킹·검색·DB
구성은 이 Candidate의 내부 계약이다" -- additive, tested, and documented
here before use.
