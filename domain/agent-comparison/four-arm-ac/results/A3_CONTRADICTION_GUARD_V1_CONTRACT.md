# FOURARM-A3-CONTRADICTION-GUARD-V1 — contract / result schema

## Scope of this turn

`Turn A3-CONTRADICTION-GUARD-V1` implements a general, Gold-blind **pure
ContradictionGuard** that decides whether a question's explicit dimension
requirements and a candidate evidence item's observed facts contain an
obvious, decidable contradiction. This is a standalone classification
primitive, not the A3 pipeline itself and not a search-candidate remover.

This turn does **not**:
- read or execute against real A results (`A.results.jsonl` / `A.run.json`),
- run DEV_TUNE,
- read Gold, `acceptable_sources`, or any existing critical packet,
- perform any actual candidate removal or A3 scoring,
- connect this module to QA, retrieval, a DB, KURE, or an LLM,
- declare any winner,
- reuse `a2-evidence-scope-validator.mjs` or `a2-stable-evidence-filter.mjs`
  (A2's PASS-only removal logic) — this module is implemented independently,
  with zero imports.

Everything is exercised only against hand-authored synthetic fixtures.

## Entry point

```js
import { detectEvidenceContradictions } from
  "./a3-evidence-contradiction-guard.mjs";

detectEvidenceContradictions({ questionConditions, evidenceFacts });
```

Pure function. Never mutates either argument (both are read-only). Same
input always produces a structurally identical (JSON-serializes to
byte-identical) output. No I/O of any kind: no network call, no DB read, no
file read, no embedding/rerank/LLM call.

## Input shape

`questionConditions` (every field optional; an absent/null field means the
question does not state that dimension, and its check trivially `PASS`es):

```text
{
  scope?:    "CONSOLIDATED" | "SEPARATE"
  period?:   { fiscal_year, start_month, end_month } | { label: string }
  unit?:     "KRW" | "THOUSAND_KRW" | "MILLION_KRW" | "HUNDRED_MILLION_KRW"
             | "PERCENT" | "SHARE"
             | { required_unit: <one of the above> }
  revision?: "PRE_REVISION" | "POST_REVISION"
  entity?:   string | { required_name: string, approved_aliases?: string[] }
  row_column?: {
    required_table_title?: string,
    required_row_label?: string,
    required_column_label?: string,
  }
}
```

`evidenceFacts` (the facts actually observed on the candidate evidence item):

```text
{
  scope?: "CONSOLIDATED" | "SEPARATE"     scope_hint?: string (raw text)
  period?: { fiscal_year, start_month, end_month }   period_hint?: string
  unit?: <one of the unit tokens above>              unit_hint?: string
  revision?: "PRE_REVISION" | "POST_REVISION"        revision_hint?: string
  entity?: string
  table_title?: string   row_label?: string   column_label?: string
}
```

A structured field (`scope`, `period`, `unit`, `revision`) always wins over
its `*_hint` free-text counterpart when both are given. Free-text hints are
parsed with fixed marker/regex rules (§ Detection rules below) — never with
an LLM, embedding similarity, or fuzzy heuristic.

## Output shape

```text
{
  status:  "PASS" | "REJECT" | "KEEP_UNKNOWN"
  reasons: string[]        // deduplicated, drawn from CONTRADICTION_REASONS
  expected: { scope, period, unit, revision, entity, row_column }
  observed: { scope, period, unit, revision, entity, row_column }
  checks:   { scope, period, unit, revision, entity, row_column }  // per-dimension detail
}
```

`CONTRADICTION_REASONS`: `SCOPE_CONTRADICTION`, `PERIOD_CONTRADICTION`,
`UNIT_CONTRADICTION`, `REVISION_CONTRADICTION`, `ENTITY_CONTRADICTION`,
`ROW_COLUMN_CONTRADICTION`, `INSUFFICIENT_CONTEXT`.

### Status priority (fixed)

1. Any dimension `REJECT` → overall `REJECT`.
2. Else, all explicitly-stated dimensions matched → overall `PASS`.
3. Else (some stated dimension could not be resolved from the given
   evidence facts, and no dimension conflicted) → overall `KEEP_UNKNOWN`.

**`KEEP_UNKNOWN` is a classification only.** It is not, by itself, a reason
for any downstream caller to remove a search candidate. A caller that wants
to drop KEEP_UNKNOWN candidates is making its own separate policy decision,
outside this module's contract.

## Per-dimension rules

- **scope** — `연결` marker → `CONSOLIDATED`; `별도`/`개별` marker →
  `SEPARATE`. Both present, or neither present → undetermined
  (`KEEP_UNKNOWN` if the question requires a scope). Absence of a marker is
  never inferred as the opposite scope.
- **period** — a raw Korean period phrase normalizes to a canonical
  `{fiscal_year, start_month, end_month}` range using fixed calendar
  boundaries (halves: 1–6 / 7–12; quarters: fixed end months 3/6/9/12). A
  bare `"YYYY년"` with no quarter/half marker is treated as the full fiscal
  year (months 1–12) — this matches how such a phrase is ordinarily meant in
  a disclosure question. A quarter named without an explicit 누적
  (year-to-date) or 3개월 (single-quarter) qualifier resolves to
  undetermined on **both** sides independently — disclosures routinely carry
  both columns for the same quarter label, so guessing either one is
  unsafe. Equal ranges → `PASS`; differing ranges (including 누적 vs 3개월
  for the same quarter) → `REJECT`; either side unresolvable → `KEEP_UNKNOWN`.
- **unit** — recognizes `억원` / `백만원` / `천원` / `원` (fixed
  power-of-ten currency family) and `%` / `주` (two separate non-currency
  families). Same family, different denomination → `PASS` with a recorded
  `conversion` (`from_unit`, `to_unit`, `multiply_observed_value_by` — a
  deterministic ratio only, per the task's principle that an exact
  conversion must never cause a `REJECT`). Different family (e.g. currency
  required vs. `%` or `주` observed) → `REJECT` (the values are not
  comparable at all, so this is a genuine incompatibility, not merely a unit
  difference). Unparseable unit hint → `KEEP_UNKNOWN`.
- **revision** — `정정 전` marker → `PRE_REVISION`; `정정 후` marker →
  `POST_REVISION`. Both or neither present → undetermined. Mismatch →
  `REJECT`.
- **entity** — normalized-label (`NFKC` + whitespace/punctuation-insensitive)
  string comparison against the required name. A different string is
  treated as the same entity **only** when it appears in the question's own
  `approved_aliases` list — this module never infers that two different
  company-name strings refer to the same company on its own; alias
  resolution must be an explicit, approved input from the caller.
- **row_column** — compares `table_title` / `row_label` / `column_label`
  against the question's required values (only the fields the question
  actually states) after the same normalized-label comparison. A
  same-node/same-table evidence item with a different row or column meaning
  still `REJECT`s — node/table identity is never used as a shortcut to
  `PASS`. Any required field the evidence does not state →
  `KEEP_UNKNOWN`.

## Determinism and purity

- No dimension check ever reads or writes `questionConditions` or
  `evidenceFacts`; every returned object is `Object.freeze`d, and inputs are
  read through local `const` destructuring only.
- No dimension check depends on iteration order, `Date.now()`, randomness,
  or any global/module-level mutable state.
- No packet ID, company name, or question sentence is hardcoded anywhere in
  the module; the only "constants" are universal accounting/denomination
  facts (quarter month boundaries, KRW power-of-ten ratios) applied
  uniformly to every input.

## Files

- `domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs`
  — the guard. Exports `detectEvidenceContradictions`, `normalizePeriodLabel`,
  `CONTRADICTION_STATUS`, `CONTRADICTION_REASONS`,
  `CONTRADICTION_GUARD_VERSION`, `ContradictionGuardInputError`.
- `tests/four-arm-a3-contradiction-guard.test.mjs` — 29 synthetic tests.
- This file.
- `results/A3_CONTRADICTION_GUARD_V1_HANDOFF.md` — handoff for the next
  integrator.
