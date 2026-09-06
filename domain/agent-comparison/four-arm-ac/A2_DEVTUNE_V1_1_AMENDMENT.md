# FOURARM-A2-DOCUMENTIR-NODESTORE-V1.1 — amendment

Committed before opening any new A2 score, any new critical-item result, or
Gold, for this turn. Supersedes only the specific factual error named below
in `A2_INTEGRATION_AND_DEVTUNE_V1_RESULT.md`'s `BLOCKED_CONTRACT` verdict —
every metric, limit, threshold, and validator rule fixed by
`A2_DEVTUNE_V1_AMENDMENT.md` remains unchanged.

## Reason for this amendment

`A2_INTEGRATION_AND_DEVTUNE_V1_RESULT.md` concluded no canonical DocumentIR
snapshot existed on disk anywhere in this session, and therefore no real
`fetchNode` could be built. That search was scoped only to the current
worktree (`agent-fourarm-a2-integration-v01`) and to local Postgres/D1. It
did not check other checkouts' `work/` directories (gitignored, so
invisible to `git`/`find`-from-repo-root searches run from inside this
worktree) or `~/Downloads`.

The canonical DocumentIR **does** exist, confirmed this turn by direct,
read-only inspection (Section 1 below):

- Logical source: `/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai/work/a-document-ir/source`
  (a symlink) -> resolved source: `/Users/jaewan/Downloads/drive-download-20260804T043134Z-1-002/`
- Files: `exchange.jsonl`, `holding.jsonl`, `major.jsonl`, `periodic-001.jsonl`
- All four files' SHA-256 match `A.run.json`'s `input_sha256.document_ir`
  pins exactly (the on-disk `periodic-001.jsonl` matches the pin recorded
  under the key `periodic.jsonl` — a filename label difference only, byte
  content identical, hash-verified).
- Manifest pin `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`
  matches `A.run.json`'s `manifest_sha256` exactly, and matches the
  `corpus_snapshot_id` (`corpus_04750795e1a2d5c3`, a 16-hex-char prefix of
  the same pin) recorded on every one of the 4,204 rows of
  `work/domain-seed/documents.jsonl`.
- Total document count: 1,054 (periodic) + 598 (major) + 1,469 (exchange) +
  1,083 (holding) = 4,204 — matches both `documents.jsonl`'s own line count
  and `CLAUDE.md` section 9's recorded corpus facts.
- A sampled DocumentIR record (`major.jsonl`, first line) has `doc_id`,
  `nodes[]`; a sampled node has `node_id` (format
  `{doc_id}::{rel_path}::n{order_index}`, matching `A.results.jsonl`'s own
  `locator` format), `raw_cells` (flat) and, in `periodic-001.jsonl`,
  `raw_rows` (nested) table representations, `period_text`/`unit_text`
  (both present as real schema fields but observed **null on every sampled
  occurrence** — the parser did not populate them; this is not something
  this amendment can change, and downstream validation must treat their
  absence as `UNRESOLVED` per the pre-existing, unmodified scope-validator
  design, never as an implicit PASS), `consolidation_basis` (observed
  populated with real `"연결"`/`"별도"` values on sampled periodic table
  nodes), and `section_hierarchy`.

## What is not changed

- Every limit, threshold, and rule fixed by `A2_DEVTUNE_V1_AMENDMENT.md`
  (max 8 candidate nodes, 12,000/6,000 char budgets, PASS-only adoption,
  stable refill over the original top-20 order, top-k=10, Recall@5/10/20
  reporting, single 101-item batch, no partial re-run, the pass/fail
  thresholds, and the Q2–Q4 unqualified-period UNRESOLVED rule) is
  unchanged by this amendment.
- The DB-shaped adapter added last turn (`a2-real-node-store-adapter.mjs`)
  is not deleted or changed in meaning — it remains available for a future
  live-DB deployment. This turn adds a separate module,
  `a2-documentir-node-store.mjs`, that reads the canonical DocumentIR
  files directly as a read-only NodeStore instead of a database.
- `arm-retriever-adapter.mjs`'s existing `fetch_node()` is unchanged.

## What this amendment fixes

The prior turn's `REAL_FETCH_NODE_GREEN = FAIL` finding is corrected:
`fetchNode` is now backed by the pinned, verified, real DocumentIR
(`a2-documentir-node-store.mjs`) instead of a database. All of Section C's
original constraints (exact `document_id`+`node_index` match, no fallback
to another document/node, `UNRESOLVED` when the exact node is not found, no
DB writes — none exist here to write to, no Gold as a lookup key, no
lookup outside frozen A top-20 provenance candidates, fetched text never
used for ranking) continue to hold and are enforced in code, not just
documented — see the new module's own header and this turn's contract
tests.

## Fixed before results (pre-registered)

- The condition-extraction gap flagged in the prior result (no existing
  extractor produces `scope`/`unit`/`row_column`) is fixed this turn by a
  new, Gold-blind, deterministic extractor
  (`a2-question-condition-extractor.mjs`) over question text + the
  existing `devtune101_conditions.v2.jsonl` + `documents.jsonl` metadata
  only. Its extraction rules are fixed and synthetic-tested before any real
  DEV_TUNE-101 conditions are extracted or scored.
- A question whose text does not name a dimension leaves that dimension
  `null` (the validator then trivially `PASS`es it, per its own
  pre-existing design) — this amendment does not add a default or inferred
  value for an unstated dimension. Missing an explicitly-stated 연결/별도
  marker in the question text is treated as an extractor defect, not an
  acceptable gap.
- The real-corpus, non-scored smoke test (Section 5 of the task) checks
  only exact node lookup and deterministic rendering against a handful of
  arbitrary, already-fixed documents drawn from `A.results.jsonl`'s own
  frozen top-20 — it does not open Gold or any score.
