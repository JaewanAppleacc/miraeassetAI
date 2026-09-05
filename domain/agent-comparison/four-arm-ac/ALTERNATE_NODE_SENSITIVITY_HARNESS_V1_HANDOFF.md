# FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1 — handoff

## Purpose and acceptance criteria

Implements a **general, packet-ID-blind harness** that will, in a future
turn, verify two independent arm-blind reviewer artifacts, compare them
without majority voting, and apply their agreed (CONSENSUS) decisions to a
separate, versioned sensitivity view of the frozen scorer's output — never
mutating the official vFINAL track.

This turn does **not**:
- read any real reviewer A/B output,
- apply any real sensitivity judgement to the 26-packet population,
- execute the frozen scorer,
- access DEV_CHECK/HOLDOUT,
- wire anything into production,
- write an Owner signature or `owner_confirmed=true`.

Everything below is exercised only against synthetic fixtures
(`alternate-node-sensitivity-fixture.mjs`).

## Source / branch

- Source worktree: `agent-fourarm-official-integration-v01`
- Source branch: `codex/fourarm-alternate-node-contract-v01`
- Source HEAD: `8678fea7255dde2a399a233a299f0d984966e42b`
- New branch: `codex/fourarm-alternate-node-harness-v01` (based on the source
  branch, same HEAD at creation time)

Required reading honored:
- `results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md`
- `official/alternate-node-sensitivity-policy.v1.json`
- `scripts/p11f0-fourarm-alternate-node-population.mjs`

## Files added

Implementation (`domain/agent-comparison/four-arm-ac/`):

- `alternate-node-sensitivity-population-guard.mjs` — fail-closed validator
  for the population template (the same shape
  `p11f0-fourarm-alternate-node-population.mjs` produces). Enforces the
  full-batch marker (`population_scope === "ALL_A_B_C_D_FULL_BATCH"`),
  `reason === "duplicate_evidence_different_node"`, exactly 26 packets (this
  round's frozen fact), no duplicate packet IDs, and no arm/rank/score/
  winner/candidate leakage. Its output (`packet_ids`, `packet_combined_sha256`)
  is the **only** legal source of packet IDs for every downstream module —
  no packet ID is ever hardcoded here or in any consumer.
- `alternate-node-sensitivity-reviewer-artifact-validator.mjs` — fail-closed
  validator for a single reviewer's artifact. Checks source_head, policy
  SHA-256, packet count (exactly 26), combined SHA-256, exact packet-ID-set
  equality against the population guard's output (rejects duplicate/missing/
  extra), the 4-value outcome vocabulary, the 6-key `acceptance_checks`
  structure, that `SUPPORTED_ALTERNATE_NODE` requires all 6 checks `true`,
  that `owner_confirmed` is `false` everywhere, and recursively rejects
  `arm`/`rank`/`score`/`winner` at any depth.
- `alternate-node-sensitivity-reviewer-comparison.mjs` — pure per-packet
  equality comparison between two validated reviewer artifacts. No
  majority vote (there are only ever two reviewers). Agreement →
  `CONSENSUS`; disagreement → `OWNER_REVIEW_REQUIRED`. Never writes or
  promotes anything to an Owner-confirmed file.
- `alternate-node-sensitivity-adjudication-adapter.v1.mjs` — the versioned,
  additive sensitivity adjudication adapter. Never imports or edits the
  frozen scorer or any results/run file. Maps CONSENSUS outcomes to
  actions: `SUPPORTED_ALTERNATE_NODE` → keep evidence,
  `ARM_SPECIFIC_CRITICAL` → invalidate + fail that arm's hard gate,
  `ARM_SPECIFIC_NON_CRITICAL` → invalidate only, `UNKNOWN` → mark that arm's
  selection pending. `OWNER_REVIEW_REQUIRED` packets are left at baseline,
  untouched. COMMON_SOURCE is outside this vocabulary entirely, so its
  existing meaning/resolution is structurally unaffected.
- `alternate-node-sensitivity-report.mjs` — builds the side-by-side
  official-vs-sensitivity report (per-arm hard gate, Recall@5/10/20, HIGH
  Recall@10, LOW Recall@10, LOW all-required-slots-found) and classifies
  `ROBUST` vs `POLICY_SENSITIVE`. `sensitivity_winner_promoted_to_official`
  is always `false`.
- `alternate-node-sensitivity-fixture.mjs` — SYNTHETIC-only fixture
  builders used by the tests. Packet IDs are generated from a loop counter,
  never copied from real data.

CLI wiring for a future real run (not executed this turn):

- `scripts/p11f0-fourarm-alternate-node-sensitivity-harness.mjs` — wires the
  five modules above behind a CLI that takes every input as an explicit
  path argument (no hardcoded path to any official/frozen artifact) and
  refuses to write its output anywhere that looks like an official/frozen
  location.

Tests (`tests/`):

- `four-arm-alternate-node-sensitivity-population-guard.test.mjs`
- `four-arm-alternate-node-sensitivity-reviewer-artifact-validator.test.mjs`
- `four-arm-alternate-node-sensitivity-reviewer-comparison.test.mjs`
- `four-arm-alternate-node-sensitivity-adjudication-adapter.test.mjs`
- `four-arm-alternate-node-sensitivity-report.test.mjs`
- `four-arm-alternate-node-sensitivity-harness-invariance.test.mjs` — hashes
  every protected original file (A/C `results.jsonl`/`run.json`, B/D
  `official/*.run.json`, `official/resolutions.owner.json`, the frozen
  scorer) before and after exercising the full pipeline and asserts byte
  identity; scans all harness source for DEV_CHECK/HOLDOUT references and
  hardcoded official file names outside comments; and verifies the
  pipeline's decisions are invariant under relabeling every packet ID (no
  packet-ID-specific branch exists).

## Test results

```
node --test tests/four-arm-alternate-node-sensitivity-*.test.mjs
ℹ tests 44
ℹ pass 44
ℹ fail 0
```

## Verification run

```
npm run schema:validate   -> {"status":"PASS","validated_pairs":36}
npx tsc --noEmit          -> clean, no output
git diff --check          -> clean
```

`npm run test:domain` was not run in full (it is a very large, long-running
suite unrelated to this change and pre-existing failures there are outside
this harness's scope); the scoped sensitivity tests above are the relevant
contract tests for this change and all pass.

## Known limitations / open follow-ups

- The CLI script (`p11f0-fourarm-alternate-node-sensitivity-harness.mjs`) is
  inert wiring: it has not been run against any real reviewer artifact,
  real baseline slot evidence, or real metrics in this turn, per
  instructions. A future turn must supply those and run it once the real
  26-packet population and both reviewer artifacts exist.
- `runSensitivityHarness()`'s `sensitivityResultStatus()` is a minimal
  placeholder (`NO_SELECTION_BLOCKED` if any arm's hard gate fails, else
  `EXECUTION_PENDING`) — actual winner selection for the sensitivity track
  should reuse the existing, unmodified `four-arm-winner-selection.mjs`
  (`deriveArmSelectionState`/`selectWinner`) fed by
  `buildSensitivityView(...).slot_view`/`.per_arm_hard_gate`, not a new
  selection algorithm. This harness deliberately does not implement that
  wiring yet, since doing so would require real per-arm quality metrics
  this turn does not have.
- `EXPECTED_POPULATION_PACKET_COUNT = 26` is a frozen constant for this
  specific sensitivity round, exported from both the population guard and
  the reviewer artifact validator. It is a round-level fact, not a
  packet-ID allowlist — no packet ID literal appears anywhere in the
  implementation.
