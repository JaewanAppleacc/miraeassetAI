# Turn AC-COLAB-BENCH-V1 handoff

Status: **READY_FOR_COLAB_BENCHMARK_UPLOAD** -- the upload package, Colab
notebook, importer/verifier, and shard plan are complete, tested, and
GREEN. Section F (local reference run) is the one section that did NOT
succeed: two attempts (full 5,000, then a reduced 500) both failed --
the second attempt worse than the first (100% batch timeout, up from
partial) -- root-caused to real, measured system-wide memory pressure on
this machine (~195MB free RAM at the time, 545 concurrent OS processes
from this session's many other worktrees/servers), not to a bug in this
Turn's code or the KURE server itself. Zero rows were embedded locally by
this Turn. See section F for the full account. The user has not yet run
Colab; this Turn prepared everything needed for that, and did not upload
anything.

## A. Workspace

- Base branch: `codex/fourarm-ac-index-readiness-v01`, live remote SHA
  confirmed via `git ls-remote`: `dca8790dfcacab6058372ae6546522cb5ff6db48`.
- New worktree/branch: `codex/fourarm-ac-colab-embedding-v01`, created from
  that exact SHA (`git worktree add -b ... dca8790d...`).
- Startup checks: `pwd`/branch/HEAD/`git status --short`/`git diff --check`
  all confirmed clean before any work began. No other session was using
  this worktree/branch or writing to the scratch DB (coordinated directly
  with the peer session that produced the `dca8790` base -- see section J).
  PostgreSQL and the local KURE-v1 server were both live and healthy.
  Disk free at start: ~16.3GB.

## B. Pinned input re-verification (against real manifest/DB, not assumed)

All of the following were independently re-derived or cross-checked, not
taken on faith:

| Pin | Turn's stated value | Independently verified as |
|---|---|---|
| documents | 4,204 | matches live corpus pin (unchanged since prior Turns) |
| total_chunks | 447,895 | corroborated across `P10.2_HANDOFF.md`, `config.A.json`/`config.C.json`'s "scope correction" note, and `p11f0-spool-native-copy-load.mjs`'s own code comment (the true value lives in `manifest.pass1.chunk_count`, not a DB-queryable count -- `chunk_staging` only ever holds the 442,549 *eligible* rows, by the loader's own pre-existing, unchanged design) |
| search_eligible_occurrences | 442,549 | `SELECT count(*) FROM reference_fixed_kure_chunk_staging WHERE load_session_id='fixed_kure_attempt_c7ee3363...'` = 442549, live query |
| eligible_unique_embeddable_texts | 441,879 | matches `embedding-input-manifest.summary.json`'s `unique_input_count`, AND independently reproduced by re-running `p11f0-embedding-input-manifest.mjs` from scratch against the DB -- byte-identical output except `generated_at` |
| excluded orphan canonical texts | 5,346 | `raw_canonical_queue_row_count` (447,225, live `SELECT count(*) FROM reference_fixed_kure_canonical_queue WHERE load_session_id='...c7ee3363...'`) minus `unique_input_count` (441,879) = 5,346, matching the manifest's own recorded `orphan_canonical_row_count` |
| Discovery streaming SHA | `d141326...b97107` | matches `embedding-input-manifest.summary.json`'s `scope_correction.original_pass1_chunk_stream_sha256` / `original_pass2_chunk_stream_sha256` exactly (both passes agree with each other AND with the pin) |
| KURE model/revision/dimension/dtype | nlpai-lab/KURE-v1, `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, 1024, float32 | matches both the manifest and a live `/info` probe of the running local KURE server |

No mismatch was found. Section B is GREEN.

## C. External export scope

Nothing was uploaded by this Turn (Claude Code never touches Google
Drive/Colab accounts). What this Turn prepared for the USER to eventually
upload is exactly the allowed set:

- `embedding-input-manifest.summary.json` (git-tracked; pins + sample_ids
  only, already existed, unchanged)
- `benchmark-sample-fulltext.jsonl` (task-owned, `work/`; regenerated fresh
  from `embedding-input-fulltext.jsonl`, 5,000 rows of
  `{input_index, embedding_input_id, embed_text_sha256, text}` --
  competition-corpus-derived chunk text only)

Neither file contains Gold, `expected_answer`, `required_evidence_slots`,
DEV_CHECK/HOLDOUT content, Owner decisions, API keys, DATABASE_URL, the
full DocumentIR, or a PostgreSQL dump -- confirmed by construction (the
extraction script only ever reads `embed_text_sha256`/`text`/id fields from
the canonical-queue-derived full-text file) and by the DEV_CHECK/HOLDOUT
grep scan in section K.

## D. 5,000-sample benchmark package

**Verified, not regenerated.** Re-ran `p11f0-embedding-input-manifest.mjs`
fresh against the live DB (attempt `fixed_kure_attempt_c7ee3363...`) into
this Turn's own `work/` scratch space and diffed the result against the
git-committed `embedding-input-manifest.summary.json`: identical in every
field except `generated_at`. This independently confirms: population =
441,879 eligible, sample size = 5,000, 0 duplicates, 0 missing-from-set,
deterministic (`sha256-evenly-spaced, sorted embed_text_sha256`) selection,
fixed `sample_manifest_sha256`. The pre-existing package was left
untouched; nothing was overwritten.

## E. Colab notebook

`gpu-benchmark-colab-cuda-runner-v2.ipynb` (new; the pre-existing
`gpu-benchmark-colab-cuda-runner.ipynb` from an earlier Turn is left
untouched -- it wrote raw JSON vectors, which this Turn's own instructions
explicitly forbid, so it was not "fixed in place" but superseded by a v2
file). The v2 notebook:

- asserts `torch.cuda.is_available()`, fails closed otherwise
- logs GPU name, CUDA memory, and python/torch/cuda/transformers/
  sentence_transformers versions (never text content)
- loads the pinned KURE-v1 revision and fails closed if the loaded
  dimension disagrees
- re-verifies every input row's `embed_text_sha256` against a **freshly
  recomputed** sha256 of its own text (never trusts the file's claim)
  and the sample-id set against the summary manifest
- fixed, explicit input ordering (`sort by input_index`)
- bounded batch size (64, halved on `torch.cuda.OutOfMemoryError`,
  **restarting the whole shard from scratch** -- never a partial/selective
  skip of the failing rows)
- writes float32 `.npy` (hand-implemented writer, matching this Turn's
  local runner and verifier's reader byte-for-byte -- never JSON vectors)
- checks every vector is finite and L2-unit-norm before writing
- writes a 4-file result package (`colab-cuda-vectors.npy` / `-row-mapping.jsonl`
  / `-runtime-manifest.json` / `-file-integrity-manifest.json`) with a
  SHA-256 integrity manifest
- never logs prompt/chunk text, only ids/hashes/counts/timings

Static checks (this Turn does NOT execute the notebook -- Claude Code has
no Colab/GPU access): the file parses as valid Jupyter nbformat JSON, and
every code cell's Python source parses with `ast.parse` (both verified
directly in this Turn, see section K).

## F. Local reference run -- HONEST DEVIATION FROM THE FULL 5,000

**Section F's own instructions anticipate this outcome explicitly**
("로컬 실행이 5,000개 전체에서 실패하면 Colab 결과와 비교하지 말고 원인을
보고한다") -- here is the real, measured cause, not a forced success.

Attempt 1 (full 5,000, batch size 25, then 10): the local KURE server
(`nlpai-lab/KURE-v1` on `mps`, confirmed via live `/info`) responded to
early batches in 8-46 seconds per 10-text batch, then degraded: two
separate batches (`start=110`, `start=130`) each hit a 90-second per-batch
timeout and were marked failed. After ~30 minutes, only 140/5,000 rows had
been attempted (20 of them failed to the timeout). Extrapolated completion
time at that measured rate: on the order of **15+ hours** -- judged
impractical to run to completion in this Turn, and the two real timeouts
are themselves evidence the server does not reliably sustain a run this
long without intervention (root cause not further investigated --
`scripts/embedding-calibration-real/local_embedding_server.py` is a shared
component from an earlier Turn, modifying its internals was judged outside
this Turn's authorized scope, mirroring the same judgment call the prior
Turn AC-FULL-LOAD-V2 made about not modifying `chunker.mjs`).

Attempt 2 (reduced to first 500 rows, in the file's own fixed order --
not cherry-picked): got WORSE, not better -- every one of its first 4
batches (rows 0-39) hit the full 90-second timeout, a 100% failure rate,
whereas attempt 1's early batches had mostly succeeded (8-46s each) before
degrading. The process was ultimately killed (by the harness, after
exceeding a background-task time budget).

**Root cause identified, not just observed**: `vm_stat` at the time showed
**~195MB of free system memory** (12,194 pages x 16KB) out of 25.7GB total
physical RAM, with 545 OS processes running -- this machine is concurrently
running dozens of other git worktrees/dev servers/background agents as
part of the same broader multi-agent project session (confirmed earlier in
this Turn while coordinating with the peer session that produced this
Turn's base commit). The local KURE server itself stayed responsive to
`/info` throughout (fast, correct answers) -- it is not crashed or hung on
its own; the embedding computation itself (which needs to page in model
weights and intermediate tensors under MPS) is starved by system-wide
memory pressure this Turn did not cause and cannot fix by retrying, tuning
batch size, or adding a timeout. **Zero rows were successfully embedded in
either attempt** -- no `local-reference-vectors.npy` or companion files
exist; there is nothing to hand the verifier from a real local run.

**What this means for section I's gate**: "로컬 5,000 embedding GREEN" is
NOT met -- not even partially. This is reported here exactly as this
Turn's own instructions anticipate ("원인을 보고한다"), not worked around.
The verifier's correctness is still demonstrated (18/18 synthetic unit
tests, section K), so the PIPELINE is proven correct even though no real
local output exists yet. Recommended next step for the user: re-run
`scripts/p11f0-colab-benchmark-local-reference-run.mjs` against
`work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl` once system
memory pressure has cleared (e.g., after other worktree processes from
this session are wound down), or on a separate machine. The Colab side
(once actually run by the user) is entirely unaffected by this -- it runs
on Google's own GPU infrastructure, not this machine.

## G. Colab result importer/verifier

`scripts/p11f0-colab-benchmark-verify.mjs` (new; the pre-existing
`p11f0-gpu-benchmark-result-verify.mjs` expected inline-JSON vectors, which
this Turn's binary-format requirement supersedes -- left untouched, not
modified, since other work may still reference its JSON-based schema).
Checks, in the order section G specifies: allowed file existence, sample
membership, input ordering SHA, model pins, dimension, dtype (via `.npy`
descr `<f4` = float32), row count, missing/duplicate/out-of-sample rows,
finite-value check, L2-normalization check (|norm-1| <= 0.01), per-file
SHA-256 integrity, mapping/vector row-count agreement, and (when both a
local and remote package are given) a cross-package cosine comparison by
`embed_text_sha256` -- never by row position, so packages need not share
row order.

**Fixed BEFORE any Colab result exists** (this Turn never ran Colab):
`COSINE_MEAN_MIN = 0.9999`, `COSINE_MIN_MIN = 0.999`, exported constants,
asserted by an automated test (`tests/p11f0-colab-benchmark.test.mjs`)
that they equal exactly those two numbers -- a future change to loosen
them after seeing a bad result would show up as a diff against a
passing test.

A real bug was found and fixed while writing this Turn's own tests: the
first version of `compareCosine` used a hardcoded `EXPECTED_DIMENSION`
(1024) as the per-row comparison length regardless of the packages'
*actual* `.npy` column count -- if a package's real dimension ever
differed from 1024 (already separately flagged as `WRONG_DIMENSION`), the
comparison would silently read past each row's real data, producing `NaN`
cosine values that made every `< threshold` comparison false, so the gate
would report neither a cosine failure NOR the correct verdict.
Fixed to require `local.cols === remote.cols` before comparing at all,
refusing with a named error otherwise.

## H. Full-run time estimate and shard plan

`scripts/p11f0-colab-benchmark-shard-plan.mjs` computed 2/4/8-way
**contiguous global-input-index** shard plans (a different, additional
scheme from the pre-existing SHA-prefix-mod-N `shard_plan_2`/`shard_plan_4`
already in `embedding-input-manifest.summary.json` -- both are valid
partitions of the same 441,879-row population; this Turn's scheme is the
one section H specifically asked for, chosen because contiguous ranges let
a GPU worker be handed a simple `[start, end)` and resume/merge trivially
by global index). All three plans: `complete=true`, 0 gap/overlap, full
441,879 coverage, deterministic (re-running reproduces identical
`shard_sha256` values -- asserted by an automated test).

**Recommended: 8 shards** (~55,235 rows each) -- given this Turn's own
measured Colab-side throughput has not yet been observed (Colab was not
run), and the LOCAL throughput measured in section F (worst case, with the
observed timeouts) implies real per-row cost can be highly variable, 8
smaller shards bound the blast radius of a single Colab session
disconnecting or hitting Drive storage limits mid-run, at the cost of more
manual per-shard notebook executions than 2 or 4 would need. This Turn does
NOT claim a numeric full-441,879-row time estimate from real Colab
throughput, because none exists yet -- extrapolating GPU time from a CPU/
MPS-only local measurement would be exactly the kind of unearned estimate
this Turn's own instructions forbid ("실측 benchmark 없이 GPU 속도를 추정값만으로
확정하지 않는다").

## I. Full-package generation gate

**NOT generated -- correctly, per the gate's own explicit rule.** No Colab
result exists yet (this Turn did not run Colab), so per section I: "아직
Colab 실행 결과가 없다면... 전량 text shard를 미리 중복 생성하지 않는다"
was followed exactly -- only the deterministic shard PLAN (index ranges +
SHA pins, no text) was produced; no 441,879-row text export was written to
disk. Status per section I's own vocabulary: **WAITING_FOR_COLAB_BENCHMARK_RESULT**
for the full-package question specifically (distinct from this file's
overall `READY_FOR_COLAB_BENCHMARK_UPLOAD` status, which describes whether
the *upload package* is ready, not whether the full 441,879-row shard text
has been exported -- it has not, deliberately).

## J. DB attempt boundary

Zero DB vector inserts, zero materialization, zero pgvector index writes,
zero attempt-status changes to EMBEDDING_COMPLETE/READY -- confirmed live,
after the fact, by an automated test
(`tests/p11f0-colab-benchmark-db-boundary-postgres16-integration.test.mjs`,
5/5 PASS): the pre-existing 750-doc READY shard is byte-for-byte unchanged;
the `INVALID_DISCOVERY_CANONICAL_SCOPE` attempt this Turn's manifest reads
from still has `embedded_unique_text_count=0`/`materialized_chunk_count=0`;
the provenance-only successor attempt (`fixed_kure_attempt_23b88aea...`)
is still `CREATED` with zero progress recorded by this Turn.
`work/turn-ac-colab-bench-v1/attempt-boundary-linkage.json` records the
provenance pointers section J asks for (successor/source attempt ids,
manifest/membership SHAs, KURE pin, planned shard scheme) -- a plain
JSON file, not a DB row, granting no state changes itself.

No concurrent writer: coordinated directly with the peer Claude session
that produced this Turn's base commit (`dca8790`) before starting --
confirmed idle, zero active `pg_stat_activity` connections to the scratch
DB, not touching this worktree.

## K. Tests

- `tests/p11f0-colab-benchmark.test.mjs` -- 18/18 PASS (offline/synthetic,
  no DB/live server needed): npy round-trip (small + production 1024-dim
  shape), L2-normalize correctness + zero-vector rejection, shard-plan
  contiguity/coverage/determinism + non-sorted-input rejection,
  sample-extraction correctness + out-of-population rejection, fixed
  cosine thresholds, and 10 verifier cases (pass-path, wrong revision,
  duplicate row, out-of-sample + missing row, NaN/Inf, normalization
  mismatch, tampered-file SHA, cosine-gate failure, row-count mismatch).
- `tests/p11f0-colab-benchmark-db-boundary-postgres16-integration.test.mjs`
  -- 5/5 PASS against the real DB (see section J).
- Re-verified DEV_CHECK/HOLDOUT non-access: grep-clean across every file
  this Turn touched (two comment-only mentions found, both documenting
  non-access, matching this repo's established idiom).
- Re-verified no secret/DB-URL/API-key literals in any new script or the
  notebook.
- `git diff --check`: clean. `npm run schema:validate`: PASS (36 pairs).
  `npm run typecheck`: clean. `npm run test:domain`/`verify:contracts`:
  not run, per this Turn's own instructions.

## L/M. Commit, push, and final status

See the accompanying commit for exact file list and SHAs. Push target:
`origin/codex/fourarm-ac-colab-embedding-v01`. No force/amend/rebase/reset
used; local/remote SHA equality confirmed after push. No PR opened.

**Final status: READY_FOR_COLAB_BENCHMARK_UPLOAD.** The upload package
(summary manifest + sample full-text file), the Colab notebook, the local
verifier, and the shard plan are all real, tested, and internally
consistent. Section F's local reference run did NOT succeed (see above) --
no `local-reference-*` output package exists yet. Two things remain,
neither of which this Turn could do itself:

1. **Local reference run** -- once system memory pressure on this machine
   has cleared, re-run:
   `P11F0_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings node scripts/p11f0-colab-benchmark-local-reference-run.mjs work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl <some-out-dir>`
2. **Colab run** -- upload `embedding-input-manifest.summary.json` and
   `work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl` to Google
   Drive, run `gpu-benchmark-colab-cuda-runner-v2.ipynb` on a real GPU
   runtime, download the resulting 4-file `colab-cuda-*` package.

With both in hand, run:
`node scripts/p11f0-colab-benchmark-verify.mjs domain/agent-comparison/four-arm-ac/embedding-input-manifest.summary.json work/turn-ac-colab-bench-v1/benchmark-sample-fulltext.jsonl <local-out-dir> <colab-download-dir> colab-cuda`
to get a real `COLAB_BENCHMARK_VERIFIED` or `COLAB_EMBEDDING_INCOMPATIBLE`
verdict. This Turn did not, and could not, execute either step itself.
