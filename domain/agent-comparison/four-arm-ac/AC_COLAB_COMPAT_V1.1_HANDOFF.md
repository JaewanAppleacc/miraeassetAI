# Turn AC-COLAB-COMPAT-V1.1 handoff

Status -- recorded as two distinct fields (see section I for the numbers
each is based on):

```
benchmark_gate_status: COLAB_BENCHMARK_VERIFIED
cross_runtime_compatibility_status: COLAB_MPS_COMPATIBILITY_VERIFIED
```

`benchmark_gate_status` is the verifier's own pass/fail gate verdict
(`scripts/p11f0-colab-benchmark-verify.mjs`'s `verdict` field, unchanged
vocabulary from Turn V1: `COLAB_BENCHMARK_VERIFIED` /
`COLAB_EMBEDDING_INCOMPATIBLE` / `INPUT_INTEGRITY_BLOCKED` /
`LOCAL_REFERENCE_VALID_NO_REMOTE_YET`). `cross_runtime_compatibility_status`
is this Turn's own, narrower claim -- specifically that a **local MPS
(Apple Silicon)** run and a **Colab CUDA (Tesla T4)** run of the same
pinned KURE-v1 revision produce numerically compatible embeddings on this
corpus, evidenced by the same cosine numbers but stated as its own field
because it names the two runtimes being compared, which the generic gate
verdict does not. Both are also recorded in the non-sensitive aggregate
result artifact, `AC_COLAB_COMPAT_V1.1_RESULT.json`.

This Turn amends Turn AC-COLAB-BENCH-V1 (see `AC_COLAB_BENCH_V1_HANDOFF.md`,
section F: local-run failure) with a fixed local runner and a deterministic
500-row length-stratified local reference run, verified against the user's
already-completed real Colab 5,000-row GPU result. Contract amendment fixed
BEFORE any cosine number existed: `AC_COLAB_BENCH_V1.1_AMENDMENT.md`.

## A. Workspace

- Branch: `codex/fourarm-ac-colab-compat-v11`, HEAD at start:
  `06aa133522fb6b25abfd62f27f011694496367ea`.
- Startup checks confirmed: `pwd`, branch, HEAD, `git status --short` (only
  the user's own pre-existing `.claude/settings.json` edit, excluded from
  this Turn's work), Documents access.
- The prior session for this Turn had terminated on a macOS cwd `EPERM`
  before touching any files -- no work was lost or resumed; this Turn
  started clean.
- System memory re-measured at start: `vm_stat` free pages x 16KB =
  **~3.4GB free** (vs. ~195MB at Turn V1's failure) -- 532 concurrent
  processes, similar count to Turn V1's 545, but memory pressure
  substantially lower.

## B. Amendment fixed before any cosine number existed

`domain/agent-comparison/four-arm-ac/AC_COLAB_BENCH_V1.1_AMENDMENT.md`,
committed/written before running the real local embedding pass or the
verifier. Pins, before any result was looked at:

- 500-row deterministic length-stratified selection method (10 length
  deciles x 50 SHA-evenly-spaced rows each) over the existing 5,000-row
  `benchmark-sample-fulltext.jsonl` population.
- The three local-runner bug fixes (mkdir / fail-fast / no-incomplete-
  output) described below.
- `COSINE_MEAN_MIN = 0.9999` and `COSINE_MIN_MIN = 0.999` explicitly
  UNCHANGED from Turn V1 (re-asserted by the existing, untouched test
  `verifier: fixed compatibility thresholds are exactly the ones this Turn
  pinned before any Colab result existed`).

## C. Existing Colab 5,000-row result (not re-run this Turn)

Found at `~/Downloads/colab-cuda-*` (4-file package the user separately
produced by running `gpu-benchmark-colab-cuda-runner-v2.ipynb` on a real
Colab GPU runtime after Turn V1). Read-only input to this Turn; never
modified or re-run:

- Device: Tesla T4. `row_count_requested=5000`,
  `row_count_succeeded=5000`, `row_count_failed=0`.
- Model pins match exactly: `nlpai-lab/KURE-v1` @
  `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024.
- `generated_at = 2026-09-04T01:36:12Z`.

Turn V1's two failed local-run directories
(`work/turn-ac-colab-bench-v1/local-run`, `local-run-500` -- both
zero-success, one with a truncated/empty `run-stdout.json`) were NOT read
by any script this Turn and are not referenced by this Turn's results.

## D. Deterministic 500-row length-stratified local subset

`scripts/p11f0-colab-benchmark-select-local-subset.mjs` (new). Applied to
`work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl` (population
5,000, unchanged from Turn V1):

```
population: 5000, strata_count: 10, per_stratum: 50, selected_count: 500
sample_manifest_sha256: 29c88f303d114368595bf5a592865c08472ae85f2c52754e00fb7b71b6b3c2d1
strata char_length ranges: [311,1308] [1308,1385] [1385,1455] [1455,1521]
  [1522,1590] [1590,1643] [1643,1708] [1709,1807] [1807,1964] [1964,3030]
```

Output: `work/turn-ac-colab-compat-v1.1/local-subset-500-fulltext.jsonl`
(task-owned, git-ignored, not committed). Deterministic and reproducible
(asserted by an automated test: re-running against the same population,
even reordered, reproduces the identical selection).

Every one of the 500 selected `embed_text_sha256` values is, by
construction, a member of the 5,000-row population the Colab package
already covers -- this is what makes the cross-package cosine comparison
in section F meaningful without a new Colab run.

## E. Local runner bug fixes

`scripts/p11f0-colab-benchmark-local-reference-run.mjs` (same file,
same 4-file output shape and `schema_version` string as Turn V1 -- fixed
in place, not superseded):

1. **mkdir**: `outDir` is now created (`recursive: true`) before any
   write is attempted. Previously a not-yet-existing `outDir` made every
   `writeFileAtomic` call fail with `ENOENT`.
2. **fail-fast**: any batch/row failure (network error, timeout, non-2xx
   HTTP status, dimension mismatch, non-finite component) now aborts the
   ENTIRE run immediately with a `LOCAL_RUN_ABORTED_ON_BATCH_FAILURE`
   error, instead of marking rows failed and grinding through every
   remaining batch (Turn V1 measured this costing 75+ minutes of pure
   timeout wait for a systemically failing run).
3. **incomplete-output**: combined with the fail-fast fix, a failed run
   now writes NO output files at all -- `outDir` is left exactly as found
   (mkdir'd, but empty). A 4-file result package on disk is only ever a
   genuinely complete, all-succeeded run; the previous version could write
   a fully integrity-signed package whose `.npy` contained silent
   all-zero rows for failures not reflected in `row-mapping.jsonl`.

## F. Verifier extension for subset-vs-full comparison

`scripts/p11f0-colab-benchmark-verify.mjs`: `verifyGpuBenchmarkPackage`
gains one new, optional parameter, `localSampleFulltextPath`. When
provided, it is used (instead of `sampleFulltextPath`) to compute the
expected id set and input-ordering SHA for the LOCAL package only; the
REMOTE package is still checked against the full population. Omitting it
reproduces the exact old (Turn V1) behavior byte-for-byte -- verified by
an explicit regression test plus every pre-existing Turn V1 test passing
unchanged. The cross-package cosine comparison itself needed no change:
it already matched rows by `embed_text_sha256`, not row position or
population membership.

## G. Pre-scoped tests: GREEN before the real run

`node --test tests/p11f0-colab-benchmark.test.mjs
tests/p11f0-colab-benchmark-v1.1.test.mjs` -- **29/29 PASS**
(18 pre-existing Turn V1 tests, unchanged and still passing, + 11 new
Turn V1.1 tests: length-stratified selector correctness/determinism/
fail-closed behavior, local-runner mkdir/fail-fast/no-incomplete-output
against a fake local HTTP server -- never the real KURE server, and the
verifier's subset-vs-full extension both with and without
`localSampleFulltextPath`). Run BEFORE the real local MPS pass, per this
Turn's own instructions. `npm run typecheck`: clean. `npm run
schema:validate`: PASS (36 pairs, unchanged -- this Turn touches no
`domain/` JSON Schema). `git diff --check`: clean.

## H. Real local MPS 500/500 run

Local KURE-v1 server started fresh this Turn (task-owned venv/cache,
`nlpai-lab/KURE-v1` @ `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, confirmed
via live `/info`: `device=mps`). Ran:

```
P11F0_KURE_SERVER_URL=http://127.0.0.1:<port>/v1/embeddings \
P11F0_LOCAL_RUN_BATCH_SIZE=10 \
node scripts/p11f0-colab-benchmark-local-reference-run.mjs \
  work/turn-ac-colab-compat-v1.1/local-subset-500-fulltext.jsonl \
  work/turn-ac-colab-compat-v1.1/local-run-500
```

Result: **500/500 succeeded, 0 failed**, 50/50 batches all HTTP 200
(no fail-fast triggered -- every batch genuinely succeeded).
`elapsed_ms_total=244576` (~4.1 min), `texts_per_sec≈2.04`,
`batch_latency_ms` p50=4556ms/p95=6917ms. All 4 output files written to
`work/turn-ac-colab-compat-v1.1/local-run-500/` (task-owned, git-ignored).
Server stopped cleanly after the run.

## I. Cosine comparison: local 500-subset vs. Colab 5,000-row package

```
node scripts/p11f0-colab-benchmark-verify.mjs \
  domain/agent-comparison/four-arm-ac/embedding-input-manifest.summary.json \
  work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl \
  work/turn-ac-colab-compat-v1.1/local-run-500 \
  ~/Downloads \
  colab-cuda \
  work/turn-ac-colab-compat-v1.1/local-subset-500-fulltext.jsonl
```

Result:

```json
{
  "ok": true,
  "errors": [],
  "local_summary": { "row_count": 500, "nonFiniteCount": 0, "worstNormDeviation": 2.977738122744711e-8 },
  "remote_summary": { "row_count": 5000, "nonFiniteCount": 0, "worstNormDeviation": 1.0137906447660328e-7 },
  "cosine": {
    "compared_count": 500,
    "mean_cosine": 0.9999999999941023,
    "min_cosine": 0.9999999996575464,
    "cosine_mean_min_threshold": 0.9999,
    "cosine_min_min_threshold": 0.999
  },
  "verdict": "COLAB_BENCHMARK_VERIFIED"
}
```

All 500 local rows matched a remote row by `embed_text_sha256` (full
overlap, as expected -- the local subset is drawn from the Colab
package's own population). Mean and min cosine both far exceed the fixed
thresholds (pinned in Turn V1, re-affirmed unchanged in section B above)
by roughly 8-10 orders of magnitude of headroom. **CPU/MPS (local) and
CUDA (Colab T4) produce numerically compatible KURE-v1 embeddings for
this corpus.**

```
benchmark_gate_status: COLAB_BENCHMARK_VERIFIED
cross_runtime_compatibility_status: COLAB_MPS_COMPATIBILITY_VERIFIED
```

Non-sensitive aggregate copy of this result (counts, hashes, cosine
statistics -- no raw chunk text, no vector data) committed at
`AC_COLAB_COMPAT_V1.1_RESULT.json`.

## J. What this Turn did NOT do

- Did not re-run Colab (reused the user's existing real 5,000-row result
  as-is).
- Did not attempt a full local 5,000-row run (500 rows judged sufficient
  to validate local/Colab compatibility; see amendment section 4 for the
  explicit scope decision).
- Did not touch DEV_CHECK/HOLDOUT/DB, Gold, or any Architecture Contract
  boundary.
- Did not change either cosine threshold.
- Did not push or open a PR.

## K. Files changed

```
domain/agent-comparison/four-arm-ac/AC_COLAB_BENCH_V1.1_AMENDMENT.md   (new)
domain/agent-comparison/four-arm-ac/AC_COLAB_COMPAT_V1.1_HANDOFF.md    (new, this file)
scripts/p11f0-colab-benchmark-select-local-subset.mjs                  (new)
scripts/p11f0-colab-benchmark-local-reference-run.mjs                  (modified: mkdir/fail-fast/no-incomplete-output)
scripts/p11f0-colab-benchmark-verify.mjs                               (modified: optional localSampleFulltextPath)
tests/p11f0-colab-benchmark-v1.1.test.mjs                               (new, 11 tests)
```

`.claude/settings.json` (user's own pre-existing edit: removed the `Stop`
hook, changed `PostToolUse` to `git diff --check`) is left untouched by
this Turn and excluded from any commit this Turn makes.

## L. Next steps

This Turn's code changes are uncommitted on
`codex/fourarm-ac-colab-compat-v11`. Committing was not performed
automatically per this project's standing instruction to commit only on
explicit request -- see the accompanying chat turn for the commit
decision.
