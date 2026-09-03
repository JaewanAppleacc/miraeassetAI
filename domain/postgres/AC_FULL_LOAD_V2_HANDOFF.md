# Turn AC-FULL-LOAD-V2 handoff

Status: **BLOCKED** (not FULL_LOAD_READY). The v2 identity contract (sections
A-D of the Turn) is complete, tested, and GREEN. Full-corpus DISCOVERY
(section E) does not complete against the real 4,204-document corpus, for a
reason rooted in existing (pre-this-Turn) chunking/discovery code, not in
anything this Turn changed. Sections F/G (GPU offload manifest, 5,000-doc
benchmark package) are gated by the Turn's own instructions on DISCOVERY
being GREEN, and were therefore not built -- doing so from partial/crashed
DISCOVERY output would mean reporting fabricated counts as real ones.

## A. Workspace

- Branch: `codex/fourarm-ac-full-load-v2-v01`, new worktree (no reuse of an
  existing one).
- Base (loader): `6d4261822e27ab331bc5c4c85979163c8d6da700`
  (`origin/codex/fourarm-full-load-prep-v01`)
- Merged (locator): `3c5c09d33256eeb784688997f5915a3795baf005`
  (`origin/codex/fourarm-ac-locator-ready-v01`), `--no-ff`
- Merge commit: `4c9db8dca840134e9237598a8d539f937e64e168` -- clean, zero
  conflicts, `git diff --check` clean.

## B. Infrastructure (verified live, not assumed)

- PostgreSQL 16 reachable at the given scratch DB; KURE-v1 embedding server
  reachable and confirmed serving `nlpai-lab/KURE-v1` revision
  `4ed4540949c70b7da2c74004a915e1f2d5e46e4f`, dimension 1024 (live
  `/v1/embeddings` probe).
- `fixed_kure_session_21f4fafafafe8f7c38e8cd94897bc583`: confirmed READY,
  750/750 documents, 1144/1144 chunks, matching KURE pin -- this is the
  pre-existing 750-doc **validation shard**, not the 4,204-document corpus.
  Verified byte-for-byte unchanged before/after this Turn's work
  (`updated_at`, digests, and `reference_retrieval_chunks` row count for its
  index all identical).
- Locator live integration: **5/5 PASS**, run for real against the live DB
  and KURE server in this Turn
  (`tests/four-arm-fixed-ac-postgres16-integration.test.mjs`). The prior
  handoff (`AC_LOCATOR_READY_REPORT.md`) explicitly could not re-verify this
  ("no live DATABASE_URL/KURE server was available in that session") -- this
  Turn closes that gap.
- No concurrent writer: checked `pg_stat_activity` (zero other connections
  to the scratch DB) and coordinated with the other live Claude session
  working in this same overall project, which confirmed it never touches
  this database.

## C. v2 identity (logical_load_id / execution_attempt_id)

New migrations (additive only, transactional, tracked in
`schema_migrations`):

- `007_reference_fixed_kure_superseded_status.sql` -- adds enum value
  `SUPERSEDED_ZERO_PROGRESS` to
  `disclosure_reference.fixed_kure_load_session_status`, in its own
  transaction (PostgreSQL forbids using a freshly-added enum label in the
  same transaction that added it).
- `008_reference_fixed_kure_load_sessions_v2_identity.sql` -- adds
  `logical_load_id`, `execution_attempt_id`, `loader_contract_version`,
  `supersedes_load_session_id` to
  `reference_fixed_kure_load_sessions`; backfills the first two to the
  row's own pre-existing `load_session_id` for every one of the 28
  pre-existing rows (this is not a guess -- it is what v1's own identity
  already meant, one attempt per logical load); replaces the plain
  `UNIQUE(retrieval_index_id)` with a partial unique index scoped to
  non-superseded rows; updates the transition-guard trigger to recognize
  `SUPERSEDED_ZERO_PROGRESS` as a new terminal/immutable status, reachable
  only from `CREATED`/`DISCOVERING`, and ONLY when every discovery/embed/
  materialize counter is independently re-verified as exactly zero
  **inside the trigger itself** (never trusted from the calling code).

`domain/postgres/reference-fixed-kure-load-session-repository.mjs` additions
(all additive; existing exports/behavior unchanged -- see the fixed bug
below):

- `computeFixedKureLogicalLoadId` (alias of the unchanged v1 hash),
  `computeFixedKureExecutionAttemptId` (folds in `loaderContractVersion` +
  `codeRevision`, which v1's identity hash deliberately excluded).
- `createOrGetAttempt` -- v2 session creation; a fresh attempt of a logical
  load already claimed by an active (non-superseded) row is refused at the
  DB level (unique-index violation), by design -- only one attempt may be
  active per logical load at a time.
- `supersedeZeroProgressSession` -- the "official API" for section D;
  refuses (via the DB trigger, not just application logic) unless progress
  is genuinely all-zero.
- `resetDiscoveryCheckpoint` -- added during section E work (see below);
  only legal while `DISCOVERING`.

**Bug found and fixed by the new test suite before merge**: the v1
`createOrGetSession` INSERT did not populate the new NOT-NULL
`logical_load_id`/`execution_attempt_id` columns, so creating a *new* v1
session (not just reading an old one) started failing after migration 008.
Fixed by setting both columns to the row's own `load_session_id` on insert,
matching the backfill invariant exactly. Caught by
`tests/reference-fixed-kure-v2-identity-postgres16-integration.test.mjs`
("v1 backward compatibility: createOrGetSession... still fail-closes"),
which would otherwise have shipped this regression.

## D. Superseding the 0%-progress session

`fixed_kure_session_8fe191342205848d1d6a6123f38a54e7` was independently
re-confirmed live (status=DISCOVERING, every discovered/embedded/
materialized counter = 0, `code_revision=536a69eb7e3c82ab60850fbf8ed4c9a7173c8f80`)
before touching it. Superseded via the official
`supersedeZeroProgressSession` API (not a raw SQL UPDATE) -- now
`SUPERSEDED_ZERO_PROGRESS`, `last_error_code=SUPERSEDED_ZERO_PROGRESS`,
still present (never deleted), now immutable. The row was never reused.

New attempt: `fixed_kure_attempt_f40dc66a8daf48a12397353dd65bc0c6`
(`logical_load_id=fixed_kure_session_8fe19...`,
`supersedes_load_session_id=fixed_kure_session_8fe19...`,
`code_revision=4c9db8dca840134e9237598a8d539f937e64e168`,
`loader_contract_version=fixed-kure-loader-contract-v2.0`).

## E. Full discovery -- ACTUAL RESULT: does not complete (root cause found, not fixed)

Three real attempts were made against the real 4,204-document corpus
(8,615,531,403 bytes, live-verified byte-for-byte and document-count-exact
against the pinned expectation each time):

1. Default V8 heap, `DISCOVERY_BATCH_SIZE=200` (v1's own constant, unchanged):
   crashed after 3,200/4,204 documents (`FATAL ERROR: ... heap out of
   memory`), peak RSS ~4.1GB.
2. `--max-old-space-size=16384`, batch size 200: got further (3,400/4,204)
   before a *different* crash -- `FATAL ERROR: Invalid string length`
   (a hard V8 string-length ceiling, not an OOM), peak RSS ~7.0GB / peak
   footprint ~18.1GB.
3. `--max-old-space-size=8192`, batch size reduced to 10 (a new, additive,
   backward-compatible `discoveryBatchSize` parameter added to
   `runDiscoveryPass` -- v1's own CLI never passes it, so v1 behavior is
   byte-for-byte unchanged): crashed *earlier* in document count (3,270)
   but consistent with the *same* heap ceiling given (peak RSS ~6.0GB,
   footprint ~9.1GB) -- i.e. reducing batch size did NOT fix it.

Diagnosis: `exchange.jsonl` (1,469/1,469), `major.jsonl` (598/598), and
`holding.jsonl` (1,083/1,083) discover completely and correctly, every
single time, exactly matching CLAUDE.md's own per-category counts. Every
failure happens partway into `periodic-001.jsonl` (8.1GB across 1,054
documents, average ~7.7MB/doc but with individual documents observed up to
~40MB, several 30-40MB documents clustered together around lines 250-400).
`domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs` was
read in full and confirmed to be genuinely bounded, one-line-at-a-time
streaming (`createReadStream` + `readline`, not a whole-file read) -- it is
NOT the source of the growth. That growth tracks the *heap ceiling given*
(bigger heap -> gets further before crashing) rather than tracking batch
size (smaller batch did not delay the crash), which points at something in
the per-document chunking path (`domain/chunking/chunker.mjs` and/or the
per-chunk digest path it feeds) retaining memory disproportionate to a
single document's own text size for this corpus's largest documents --
this was NOT further root-caused inside `chunker.mjs` itself, because that
module is shared, already-tested, relied on elsewhere, and outside this
Turn's authorized scope to modify without review.

This Turn's own instructions are explicit that a mismatch between expected
and actual must be reported as-is rather than forced to match --
accordingly: **DISCOVERY IS NOT GREEN for the full corpus.** Checkpointed,
resumable progress exists in the DB (harmless, accurate, not fabricated):
attempt `fixed_kure_attempt_f40dc66a8daf48a12397353dd65bc0c6` is currently
`DISCOVERING` with partial `source_files_progress` reflecting whichever of
the three runs above last touched it; re-running
`scripts/p11f0-corpus-discovery-v2.mjs` (via `resetDiscoveryCheckpoint`
first, to avoid double-counting -- this session's own DISCOVERY pass is NOT
resumable mid-stream, see `resetDiscoveryCheckpoint`'s own docstring) will
reproduce the same failure until the chunking-path memory growth is fixed.

Also newly added (crash-recovery necessity, not originally planned):
`resetDiscoveryCheckpoint` on the repository, because `runDiscoveryPass`
always restreams the corpus from the start and `updateDiscoveryCheckpoint`
increments counters -- resuming without first zeroing a crashed attempt's
partial counters would double-count.

## F/G/H. Not built

Per the Turn's own gate ("Discovery가 GREEN일 때만 생성한다"), the GPU
offload manifest (2-shard/4-shard plans) and the 5,000-document benchmark
package were **not** built -- section E never reached DISCOVERY_COMPLETE
for the full corpus, so there is no real unique-embeddable manifest to
shard or sample from. Building either from the partial/crashed run's data
would mean presenting fabricated counts as real ones, which this Turn's own
instructions explicitly forbid. No external upload attempted (also
consistent with section H's own gate, which required this regardless).

## I. Full-load path comparison

Not attempted -- explicitly conditioned on section E, and this Turn's own
instructions forbid confirming GPU speed from estimates without a real
benchmark run, which itself required section G's package.

## J. Forbidden actions -- confirmed not taken

No full embedding run (zero `/v1/embeddings` calls beyond the single
manual identity-probe call in section B, which is not corpus data). No
materialization. No BM25/pgvector final index build beyond what the
pre-existing 750-doc shard already had. No DEV_TUNE 4-arm run. No
DEV_CHECK/HOLDOUT access (grep-confirmed clean across every file this Turn
touched; two comment-only mentions found are both *documenting*
non-access, not access). No HCX calls. No use of partial results as
official. No mixing of model revisions/runtimes.

## K. Tests

New: `tests/reference-fixed-kure-v2-identity-postgres16-integration.test.mjs`
-- 11/11 PASS against the real DB (v1 backward compatibility x2, attempt-id
determinism, cross-attempt isolation + concurrent-attempt rejection,
attempt-id idempotency, 0%-progress supersession success, non-zero-progress
supersession rejection, `resetDiscoveryCheckpoint` success + illegal-reset
rejection, malformed-vector-dimension rejection, migration idempotency,
and a final consistency check against this Turn's own real fixture rows).

Re-run and confirmed: `tests/four-arm-fixed-ac-postgres16-integration.test.mjs`
(locator live integration) 5/5 PASS.

Not written: shard-partition dedup/no-overlap, shard-merge-order
determinism, wrong-revision/dimension/input-SHA rejection for a GPU
manifest, and partial-shard-resume tests for the benchmark runner -- there
is no manifest/benchmark code to test (see F/G above); writing tests against
code that does not exist would be vacuous.

`git diff --check`: clean. `npm run schema:validate`: PASS (36 pairs).
`npm run typecheck`: clean. `npm run test:domain`/`verify:contracts`: not
run, per this Turn's own instructions.

## M. Result

**BLOCKED**, not FULL_LOAD_READY. Sections A-D (v2 identity contract) are
complete, tested, and safe to build on. Section E's root cause is
identified precisely enough to hand to whoever owns
`domain/chunking/chunker.mjs` next: memory growth while chunking
`periodic-001.jsonl`'s largest documents (up to ~40MB), NOT explained by
the corpus streamer (verified bounded) or by `DISCOVERY_BATCH_SIZE` alone
(reducing it did not fix the crash). No fabricated manifest, benchmark
package, or GPU-time estimate was produced in place of the real thing.
