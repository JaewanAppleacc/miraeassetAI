# FOURARM-A2-DOCUMENTIR-NODESTORE-V1.1 — result

## Verdict

```
NO_SELECTION_BLOCKED
```

A2's locator/provenance hard gate fails (123 `unresolved` locator-check
violations vs. the pre-registered requirement of 0), which per Section G of
the task takes precedence over the quality-gate outcome (also failed, badly
— see below). DEV_CHECK/HOLDOUT were not opened; A2 did not become the
provisional winner.

## 1. Correction of the prior "DocumentIR not found" finding

`A2_INTEGRATION_AND_DEVTUNE_V1_RESULT.md` concluded `REAL_FETCH_NODE_GREEN
= FAIL` because no DocumentIR/NodeStore was found from inside this worktree
or the local DB. That search never checked other checkouts' gitignored
`work/` directories. This turn found and read-only-verified the canonical
DocumentIR at:

- Logical: `.../ai-ai-festival-agent-1-ai/work/a-document-ir/source`
  (symlink) -> resolved: `~/Downloads/drive-download-20260804T043134Z-1-002/`
- Files and SHA-256 (all four match `A.run.json`'s own
  `input_sha256.document_ir` pins exactly):

| file (on disk) | pin key | SHA-256 match |
|---|---|---|
| `exchange.jsonl` | `exchange.jsonl` | ✅ `80000c1c...02c2a` |
| `holding.jsonl` | `holding.jsonl` | ✅ `fd88d83c...8cbc09` |
| `major.jsonl` | `major.jsonl` | ✅ `5c58da7a...d25d3ba` |
| `periodic-001.jsonl` | `periodic.jsonl` | ✅ `0aee5463...23076be852` |

- Manifest pin `04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364`
  matches `A.run.json`'s `manifest_sha256` exactly, and matches the
  `corpus_snapshot_id` prefix on every one of the 4,204 rows of
  `work/domain-seed/documents.jsonl` (1,054 periodic + 598 major + 1,469
  exchange + 1,083 holding = 4,204, matching `CLAUDE.md` §9 and the
  `documents.jsonl` line count exactly).
- A sampled DocumentIR record has `doc_id`, `nodes[]`; sampled nodes have
  `node_id` (`{doc_id}::{rel_path}::n{order_index}`, matching
  `A.results.jsonl`'s own `locator` format), `raw_cells`/`raw_rows`,
  `period_text`/`unit_text` (present as real fields, **observed null on
  every sampled occurrence** — the parser never populated them),
  `consolidation_basis` (observed populated with real `"연결"`/`"별도"`
  values), and `section_hierarchy`.
- BLOCKED_INPUT_PIN never triggered — every preflight check passed.

## 2. Amendment

`A2_DEVTUNE_V1_1_AMENDMENT.md` — commit `35114e0`, written and committed
before opening any new A2 score, any critical-item result, or Gold this
turn. Every threshold, limit, and validator rule from
`A2_DEVTUNE_V1_AMENDMENT.md` is unchanged.

## 3. Real, read-only fetchNode: `a2-documentir-node-store.mjs`

A new, separate module (does not modify `arm-retriever-adapter.mjs`'s
existing `fetch_node()` or last turn's DB-shaped
`a2-real-node-store-adapter.mjs`). Backed by the canonical DocumentIR
files, not a database:

- **Exact match only.** `document_id`+`node_index` must resolve to a real
  `nodes[nodeIndex]` entry whose own `node_id` ends in `::n{nodeIndex}`
  (cross-checked); any mismatch, out-of-range index, or missing document
  is `UNRESOLVED` (`found: false`), never a fallback to a different
  document/node.
- **No Gold as a lookup key.** The function signature is
  `fetchNode({documentId, nodeIndex, row, col})` — no Gold-shaped parameter
  exists anywhere in the call path (asserted by a source-scan test).
- **No lookup outside frozen A candidates.** `run-a2-devtune101.mjs`
  builds a per-question `allowedLookupKeys` set from that question's own
  frozen top-20 `node_index`/`node_indices` and passes it in; any lookup
  outside that set is refused (`OUTSIDE_FROZEN_A_CANDIDATE_SET`).
- **Bounded, not full-file, reads.** Preferred path: a pre-built
  `{doc_id -> {file, offset, length}}` byte-offset index (the same shape
  the frozen scorer's own `dart_corpus.retrieval.node_store.NodeStore`
  already builds and consumes — reused as the "기존 검증된 raw-corpus
  extractor", verified against the *live* DocumentIR files' SHA-256 before
  trusting it, never blindly). Fallback: one bounded, buffer-based
  streaming pass per file that decodes only a small line-prefix to test for
  a needed `doc_id`, fully parsing only matching lines — the 7.6GB
  periodic file is never loaded whole into memory either way.
- **DB writes: 0** — there is no database in this path at all; every
  operation is a read-only file open/read.
- **Deterministic rendering, no fabrication.** Mirrors the existing
  verified `node_dict_to_text`/`table_dict_to_text` rule (section ->
  `title_text`, paragraph -> `text`, table -> row-ordered cells) and
  additionally surfaces `period_text`/`unit_text`/`consolidation_basis`
  when the parser populated them (frequently null — never invented). A
  node whose rendering has no real content resolves `UNRESOLVED`
  (`NODE_TEXT_UNAVAILABLE`), never `found: true` with empty text.
- **Read-only guarantee for the underlying file operations**: only
  `fs.createReadStream`/`fs.open(..., "r")`/`fh.read` are used; no
  `writeFile`/`appendFile`/`unlink` call exists in the module (source-scan
  tested).

**Real-corpus, non-scored smoke test** (Section 5): 5 arbitrary fixed
`(doc_id, node_index)` pairs drawn from `A.results.jsonl`'s own frozen
top-20 (not Gold-selected) — all 5 resolved correctly and deterministically
(1–18ms each via the reused byte-offset index), including one genuine
table row showing `구분: 연결` correctly detected from real
`consolidation_basis` data. No Gold or score was opened for this check.

22 new offline unit tests (synthetic fixtures) + the smoke test above; see
Tests section.

## 4. Question-condition extractor: `a2-question-condition-extractor.mjs`

Fills the gap flagged in the prior turn (no existing extractor produced
`scope`/`unit`/`row_column`). Gold-blind: takes only question text +
the existing `devtune101_conditions.v2.jsonl`'s own `corps` output; imports
nothing Gold-shaped (source-scan tested).

- **scope**: literal 연결/별도/개별 marker detection — the one hard
  requirement (an explicit marker must never be missed). Both markers or
  neither -> `null`.
- **period**: reuses the scope validator's own `normalizePeriodLabel` on
  period-shaped substrings; a Korean "A와(과) B" cross-year comparison
  phrasing is explicitly detected and forced to `null` (found and fixed
  this turn — the naive regex could otherwise bind only to the later of two
  compared years).
- **unit**: only an explicitly marked denomination (`(백만원)`, `단위: 원`)
  — never inferred from a bare currency word.
- **row_column**: a small, fixed set of canonical role phrases
  (정정전/후, 변경전/후, 직전, 전기/당기) — conservative by design, since
  `checkRowColumn` is an exact string match, not fuzzy.
- **entity**: reuses `devtune101_conditions.v2.jsonl`'s own `corps`; `null`
  when zero or more than one company is named.

Coverage over the real 101 questions (question text only, no Gold, no
score — legitimate to measure before results): scope 12/101, period 0/101
(every period-phrase match in this batch turned out to be a two-year
comparison, correctly nulled), unit 25/101, row_column 37/101, entity
94/101.

21 new offline unit tests + the two Section-5 critical-type reproductions
(연결-required/별도-evidence and 별도-required/연결-evidence, both
generic, no packet ID) in `four-arm-a2-critical-type-reproduction.test.mjs`.

## 5. A defect found and fixed before any score was opened

Neither `A.results.jsonl`'s own result items nor
`buildNodeGroundedEvidence`'s output ever carried an `entity` field — so
with no additional wiring, any question requiring an entity match would be
permanently `UNRESOLVED` regardless of how well every other dimension
matched. Found during this turn's own pre-execution real-corpus batch
smoke run (before any Gold was opened) and fixed by adding an optional
`resolveEntity(docId)` hook to `a2-integration-pipeline.mjs`, wired in
`run-a2-devtune101.mjs` to the existing `documents.jsonl`'s own
`filer_name` — restricted to self-filed doc types (`periodic`/`major`/
`exchange`); `holding` (대량보유상황보고, filed by a third-party
shareholder about a different subject company) is deliberately left
unresolved rather than guessed, since `filer_name` there names the
*reporter*, not the company the question is about, and no other structured
subject-company field exists in the available metadata. This is a real,
disclosed limitation, not a fabricated fix: for `holding`-type questions
that require an entity match, the entity dimension will predominantly stay
`UNRESOLVED` rather than incorrectly `PASS` or `REJECT`.

No threshold, validator rule, or limit was changed — this was pipeline
wiring completed before the first Gold-based score existed.

## 6. Execution (Section 6)

Single batch run, `run-a2-devtune101.mjs`, all 101 questions, one pass, no
partial re-run:

```
pass:        1010 evidence items
reject:      5 evidence items
unresolved:  854 evidence items
shortfall_questions: 49 / 101 (finalTopK.length < 10)
  of which 44 / 101 have ZERO passing evidence at all
```

The 44 zero-evidence questions are, on inspection, dominated by cases where
Arm A's own frozen top-20 for that question does not contain
verifiably-correct evidence in the first place (e.g. one inspected
`holding`-type question's top-20 consisted of shareholding tables for a
different reporting date/reporter than the question asked about) — A2 is
constrained to filter/reorder that same top-20, never to search again, so
it cannot manufacture a correct answer out of an already-off-target
candidate set. This is an accepted, pre-registered structural limit of the
whole "frozen top-20 + validate + refill" approach, not a defect in this
turn's code — but it is the single largest driver of A2's recall
regression below.

BM25/dense/RRF/KURE calls made: **0** (source-scan tested; the whole run
only performs file reads against the pinned DocumentIR).
DB write queries: **0** (no database is involved in this path at all).

## 7. Scoring (frozen, patched scorer — `fourarm.py`, unmodified)

`score-a2.py` (a new, separate script; does not modify `score.py` or
`fourarm.py`) re-verifies `fourarm.py`'s SHA-256
(`4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804`) before
importing it, then calls the exact same `fourarm.score_arm()` function
`score.py` calls per arm, with the same `NodeStore`-backed locator check
(`store=NodeStore(index_dir)`, i.e. `locator_checked: true` — not
`--no-locator-check`), the same Gold file, and the same
`devtune101_conditions.v2.jsonl` (byte-identical SHA-256 to this
worktree's own copy, verified before scoring).

| metric | **A (baseline)** | **A2 (this turn)** | pre-registered threshold |
|---|---|---|---|
| critical | 0 | **0** | = 0 |
| minor | 13 | **0** | (reported) |
| **unresolved (locator)** | 9 | **123** | **= 0 (hard gate)** |
| coarse | 159 | 0 | (reported) |
| Recall@5 (ALL) | 0.7587 | **0.4196** | (reported) |
| **Recall@10 (ALL)** | 0.8287 | **0.4301** | **>= 0.8117** |
| Recall@20 (ALL) | 0.8566 | 0.4301 | (reported) |
| all_found@10 (ALL) | 73/100 | 44/100 | (reported) |
| **Recall@10 (HIGH)** | 0.816 | **0.432** | **>= 0.798** |
| **LOW all_found@10** | 16/19 | **10/19** | **>= 15/19** |

**Every hard/quality threshold fails**, and the hard locator gate fails
first: `unresolved` violations rose from 9 (A) to 123 (A2) against a
required `= 0`. Per Section G, a critical/locator hard-gate failure decides
the verdict outright, ahead of the quality-gate comparison (which also
fails on all three counted thresholds — overall and HIGH Recall@10, LOW
all-found@10 — each roughly half of A's own value or worse).

No threshold, validator rule, or expansion limit was changed after seeing
this score, and nothing will be — DEV_TUNE-101 is not re-run.

## Verdict logic applied (Section G)

```
critical == 0                         -> true
locator/provenance hard gate == 0     -> FALSE (123 unresolved)
=> NO_SELECTION_BLOCKED
```

DEV_CHECK/HOLDOUT: **not accessed** — A2 did not become
`PROVISIONAL_WINNER`/pass the hard gate, so per the task's own rule
("A2가 provisional winner가 되기 전에는 DEV_CHECK/HOLDOUT을 열지 않는다")
they remain untouched this turn.

## Tests / schema / typecheck

```
node --test tests/four-arm-a2-*.test.mjs tests/four-arm-fixed-ac.test.mjs
# 171 pass, 0 fail (22 documentir-node-store + 21 question-condition-extractor
# + 9 critical-type-reproduction, new this turn; 119 pre-existing A2 tests +
# 52 pre-existing fixed-ac tests, all still green)
npm run schema:validate      # {"status":"PASS","validated_pairs":36}
npx tsc --noEmit              # clean (no output)
git diff --check              # clean
```

## Original-file invariance (final check, after the run)

```
git diff --name-only 622759a39681f96d00d103eca53d07276b705a29 -- \
  results/A.results.jsonl results/A.run.json results/C.results.jsonl \
  results/C.run.json official/B.run.json official/D.run.json \
  scorer-patch-multinode-v1/fourarm.patched.py \
  scorer-patch-multinode-v1/fourarm.patch.diff
# (empty)
```

## Known limitations / open items

- `holding`-type documents' entity dimension is structurally unresolvable
  with the currently available metadata (see §5) — a real, disclosed gap,
  not a defect to silently patch.
- `period_text`/`unit_text` are real DocumentIR fields but were observed
  null on every sampled node in this corpus; period/unit evidence-side
  context for tables comes only from `consolidation_basis` plus whatever a
  free-text scope scan picks up from the rendered cell text — the
  structured `checkUnit`/`checkPeriod` dimensions stay `UNRESOLVED` far
  more often than `PASS` for tables, by design (fail-closed), not by
  omission.
- The dominant driver of A2's recall regression is Arm A's own frozen
  top-20 lacking verifiably-correct evidence for a large fraction of
  questions (44/101 ended with zero passing evidence) — a limitation of
  the "filter-only, never re-search" A2 design itself, confirmed but not
  fixable within this turn's scope.
- A2 is **not** provisionally selected. No further remediation attempt was
  made this turn per the "no threshold/rule change after seeing results"
  freeze; a future turn would need to either accept a different base arm,
  loosen no pre-registered rule but supply better upstream retrieval, or
  propose a new pre-registered amendment before trying again.
