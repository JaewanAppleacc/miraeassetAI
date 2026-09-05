# Turn AC-OFFICIAL-INTEGRATION-V1 — Handoff

## Purpose / acceptance criteria

Scaffold the unified four-arm (A/B/C/D) official evaluation integration on
top of the closed-out AC vector-import work (`codex/fourarm-ac-vector-import-v01`
@ `44f05231de8b9a3b6fdb6ff422435d0586937941`), without executing DEV_TUNE,
without touching DEV_CHECK/HOLDOUT, and without any production wiring.

## Plan used

1. Re-verify `ac_scorer_50cc1aa.zip` (package sha256, `MANIFEST.sha256`,
   embedded commit sha) as the adopted authoritative B/D package.
2. Import the official `devtune101_conditions.v2.jsonl` + `universe.csv`
   artifacts, SHA-gated against the given pins.
3. Flip `metadata_filter.source` to `OFFICIAL_CONDITIONS_ARTIFACT` in both
   `config.A.json`/`config.C.json`, keeping the block byte-identical between
   the two (required by `pair-diff.mjs`'s `ALLOWED_PAIR_DIFF_KEYS`, which
   does not list `metadata_filter`).
4. Build a common run-ledger/checkpoint contract and cutoff contract, then
   a pure preflight assembler and a real (DB-backed) preflight runner.
5. Run the real preflight once, commit its output as
   `official/four-arm-preflight-manifest.json`.
6. Record the Owner-pending policy verbatim (no relaxation).

## Files changed/added

```
domain/agent-comparison/four-arm-ac/official/
  devtune101_conditions.v2.jsonl        (imported, sha256=83d5b8a0...)
  devtune101_conditions.v2.meta.json    (imported)
  universe.csv                          (imported, sha256=96560165...)
  B.run.json / D.run.json               (imported, run metadata only -- no results/eval content)
  IMPORT_MANIFEST.json                  (lineage + all SHA pins, written this Turn)
  four-arm-preflight-manifest.json      (real preflight output, written this Turn)
domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs   (new)
domain/agent-comparison/four-arm-ac/four-arm-cutoff-contract.mjs          (new)
domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs               (new)
domain/agent-comparison/four-arm-ac/four-arm-preflight.mjs                (new)
scripts/p11f0-fourarm-preflight.mjs                                       (new)
domain/agent-comparison/four-arm-ac/config.A.json                        (metadata_filter + readiness note updated)
domain/agent-comparison/four-arm-ac/config.C.json                        (same, identical block)
tests/four-arm-official-conditions-v2-importer.test.mjs   (new)
tests/four-arm-cutoff-contract.test.mjs                   (new)
tests/four-arm-run-ledger.test.mjs                        (new)
tests/four-arm-preflight.test.mjs                         (new)
tests/four-arm-preflight-manifest-artifact.test.mjs       (new)
```

`domain/agent-comparison/four-arm-ac/official-conditions-importer.mjs`
(the existing, pre-Turn module) is **untouched** -- its
`OFFICIAL_ALLOWED_FIELDS`/`validateOfficialConditionsArtifact` assumed a
flat per-question row shape a hypothetical `conditions.py` would produce.
The REAL delivered artifact nests a `conditions` object with a different
field set entirely (`corps`/`years`/`year_months`/`correction`/... instead
of `corp_codes`/`base_years`/`base_months`/`is_correction`/...) -- this was
only discoverable by reading the actual file, not assumed in advance.
Rather than bend the old validator to fit a shape it was never designed
for, `official-conditions-v2-importer.mjs` is a new, additive module for
the real shape. Both modules can coexist; the old one is simply unused
for this artifact.

## B/D package re-verification (this Turn)

- `ac_scorer_50cc1aa.zip` sha256 re-checked: `91cbd21800ea67a3f6943dad7f5ecf719a4d32da6cfbe4ad35ef296b2e1bb279` (matches the prior Turn's record).
- `MANIFEST.sha256` inside the extracted package: all files OK.
- `README.txt` embedded commit: `50cc1aac57145ab7fdb825cbb054842cb993c395`, branch `share/dart-qa-handoff` -- matches the zip filename's short SHA.
- B.results.jsonl/D.results.jsonl/B.run.json/D.run.json byte-identical across `ac_scoring_649d1cd` -> `ac_scorer_f2e2c38` -> `ac_scorer_034b04a` (re-verified via direct `shasum`, not just trusting the earlier session's notes) -- **no retrieval was re-run** anywhere in this lineage.
- Judgement re-confirmed: `results/fourarm/judgement.json` status=`BLOCKED`, reason="no hard-safe arm". Both B and D carry the same 2 `ARM_SPECIFIC` critical packets (`u-1b6cd184a87f`, `u-8564414f6080`) per `resolutions.json`'s Owner arm-blind adjudication; 15 packets remain `UNKNOWN` by deliberate Owner choice, not automatic classification.

## What this Turn does NOT do (explicit)

- **No DEV_TUNE execution.** `scripts/p11f0-fourarm-preflight.mjs` calls
  only `readiness()` on the live DB (bm25 index doc-count from the cached
  index's own header line, dense/session/provenance checks) -- it never
  calls `search()`, never calls HCX, never scores anything.
- **No DEV_CHECK/HOLDOUT access.** Grepped for both terms across every file
  touched this Turn; zero references.
- **No production wiring.** `metadata_filter.source` is now
  `OFFICIAL_CONDITIONS_ARTIFACT` (satisfies `assertOfficialExecutionReady`'s
  string check and is an honest description of "the artifact is imported
  and SHA-verified"), but `runtime_wiring_status: "ARTIFACT_IMPORTED_NOT_WIRED"`
  is recorded explicitly next to it. The real gap: the artifact's
  `conditions.corps` field holds Korean company **display names**
  (e.g. "아모레퍼시픽"), not the 8-digit `corp_codes`
  `buildMetadataFiltersFromConditions`/`passesMetadataFilters` actually
  compare against. Resolving name->code needs
  `domain/adapters/seed-company-resolver.mjs`'s `createGatedSeedCompanyResolver`,
  which is explicitly marked CANDIDATE-only and requires an Owner-APPROVED
  decision file that does not exist yet -- wiring it up without that gate
  would itself be unauthorized production wiring. `doc_subtype` taxonomy
  alignment (`exchange_subtypes`/`major_labels`/`periodic_subtypes` vs. the
  chunker's own vocabulary) is unresolved for the same reason: not
  verified, not guessed. `conditions-fixture.mjs`'s
  `SYNTHETIC_CONDITIONS_FIXTURES` remain the only thing this repo's own
  tests actually call `search()` with.
- **No Owner-decision relaxation.** `OWNER_PENDING_POLICY` in
  `four-arm-preflight.mjs` hard-codes
  `hard_safe_declaration_before_owner_decision: "FORBIDDEN"` and
  `ordinary_slot_failure_relaxation_forbidden: true` -- the preflight
  assembler structurally cannot report `official_4arm_execution_ready:true`
  while `bdJudgementStatus !== "SUPPORTED_HARD_SAFE"`.
- **`public.experiment_runs` (frozen Experiment Run v0.3) is untouched.**
  The new run ledger is a plain, additive, namespaced object contract
  (`four-arm-run-ledger.mjs`), not a write into the frozen common
  Source-of-Record table -- that table's FK dependencies
  (`corpus_snapshot_id` -> `corpus_snapshots`, which has no row for
  `corpus_04750795e1a2d5c3` in this scratch DB) belong to the common track,
  not this candidate-comparison track. Graduating the ledger to a
  `disclosure_reference`-schema Postgres table (mirroring how migration 013
  added AC-scoped tables without touching frozen `public.*` tables) is a
  natural next step if concurrent writers are ever needed -- not done this
  Turn.

## Real preflight result (this Turn)

`scripts/p11f0-fourarm-preflight.mjs` was actually run against the live
scratch Postgres (`p11f0_scratch`). Output committed verbatim as
`official/four-arm-preflight-manifest.json`. Summary:

- Arm A: `official_experiment_ready: true` (BM25 doc_count=442549, dense pin
  matches KURE_PIN, materialized=442549/442549, unresolved locator spans=0).
- Arm C: `official_experiment_ready: true` (same, dense-off structurally
  verified).
- Arm B / D: `status: REUSED_VERIFIED`, `results_sha256` matches the
  imported, byte-verified `B.results.jsonl`/`D.results.jsonl` pins exactly.
- Ledger: one complete batch (`batch_id` derived from
  conditions+universe+cutoff-contract SHAs), exactly one entry per arm,
  `assertSingleCompleteBatch` passes.
- `official_4arm_execution_ready: false`. The **only** blockers are
  `BD_JUDGEMENT_NOT_HARD_SAFE` and `OWNER_DECISION_PENDING` -- every other
  gate (artifact SHAs, A/C infra, ledger completeness, cutoff contract) is
  green.
- `dev_tune_executed: false`, `dev_check_holdout_accessed: false`,
  `production_wiring_performed: false`.

## Tests / verification run this Turn

```
node --test tests/four-arm-official-conditions-v2-importer.test.mjs \
             tests/four-arm-cutoff-contract.test.mjs \
             tests/four-arm-run-ledger.test.mjs \
             tests/four-arm-preflight.test.mjs \
             tests/four-arm-preflight-manifest-artifact.test.mjs \
             tests/four-arm-fixed-ac.test.mjs \
             tests/p11f0-precomputed-vector-import.test.mjs
npm run schema:validate
npx tsc --noEmit
git diff --check
```

See the commit message / final report for actual pass counts.

## Known limitations / next steps (not blockers for this Turn's scope)

1. Real per-question metadata-filter wiring (corp-name resolution +
   doc_subtype taxonomy alignment) -- needs an Owner-approved
   CompanyResolver decision first.
2. Run ledger is currently file/object-level, not persisted to Postgres --
   fine for a single-writer preflight, would need a
   `disclosure_reference`-schema migration to survive concurrent writers.
3. The two Owner decisions in `OWNER_PENDING_POLICY.open_owner_decisions`
   are the actual, sole remaining gate to `official_4arm_execution_ready`.
