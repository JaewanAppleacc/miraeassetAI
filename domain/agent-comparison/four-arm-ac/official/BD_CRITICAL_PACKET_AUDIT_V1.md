# B/D Critical-Packet Hard-Gate Semantics Audit (sanitized, read-only)

**Scope**: `u-1b6cd184a87f`, `u-8564414f6080` — the two `ARM_SPECIFIC`
critical packets shared by both B and D per the Owner-ratified
`resolutions.owner.json`. Independent root-cause audit, not a re-score.
**No B/D result/run/scorer/resolutions file was modified. Nothing was
re-searched, re-scored, or re-executed.**

This is the sanitized version committed to git. It carries only the
allowed fields below — no raw question text, no Gold answer values, no
raw chunk text, no exact figures, no DEV_CHECK/HOLDOUT content. The full
version (which quotes the packets' own chunk text and the Owner's
resolution notes verbatim, including Gold's required node/value) is
preserved locally, untracked, at `work/audit/BD_CRITICAL_PACKET_AUDIT_V1.RAW.md`
(`work/` is git-ignored) for anyone with local access to this worktree.

## Method (unchanged from the full audit)

For each packet: checked whether the packet's own claimed
`doc_id`/`node_index` locator matches an actual, real region of the named
document (cross-referenced against this repo's own independently-built
Fixed-512 chunking of the identical document — a different chunking
strategy from B/D's own LINE_WINDOW, built from the same underlying
DocumentIR, used only as a cross-reference, never as B/D's own
retrieval); whether that retrieved content satisfies the question's
required evidence; and whether either arm's result schema carries any
final answer claim at all.

## Findings (sanitized)

| field | `u-1b6cd184a87f` | `u-8564414f6080` |
|---|---|---|
| `question_id` | `author_14dfddbe1d41275533ae3945` | `author_a538b0e2240fe01d1a71ebb7` |
| `slot_name` | `evidence_1` | `evidence_2` |
| locator resolves to a real document region | yes | yes |
| locator identity matches the actual retrieved chunk | **match** | **match** |
| retrieved content satisfies the question's required evidence | **mismatch** (wrong financial-statement variant retrieved) | **mismatch** (wrong financial-statement variant retrieved) |
| final answer claim exists in either arm's result | no (retrieval-only; `external_services: []` in both `B.run.json`/`D.run.json`) | no |
| failure mechanism | `RETRIEVAL_SLOT_FAILURE` | `RETRIEVAL_SLOT_FAILURE` |
| vFINAL severity | `CRITICAL` (`ARM_SPECIFIC`, `critical=true`, per `resolutions.owner.json`) | `CRITICAL` |
| B/D `results.jsonl`/`run.json` SHA unchanged from before this audit | yes | yes |

## Classification

Neither packet is `LOCATOR_INTEGRITY_FAILURE` (locator/chunk-identity
match confirmed), `CLAIM_SUPPORT_FAILURE` (no answer claim exists to
check), or `UNRESOLVED_INSUFFICIENT_EVIDENCE` (on-topic evidence WAS
retrieved — the wrong one of two same-document candidates). Both are
`RETRIEVAL_SLOT_FAILURE`: the locator is accurate, but the retriever
surfaced the wrong required-slot candidate (a different, real table in
the same filing) under vFINAL's own strict required-evidence rule, which
is exactly why vFINAL classifies this severity as `CRITICAL`.

## Relationship to the existing, Owner-ratified vFINAL judgement

This audit's mechanism finding (`RETRIEVAL_SLOT_FAILURE`) is consistent
with, and does not contradict, the adopted scorer package's own stated
reasoning for keeping both packets `ARM_SPECIFIC`/`critical=true`. **This
audit surfaces no technical basis for an erratum.** No vFINAL judgement,
resolution, or hard-gate state was changed. `resolutions.owner.json`'s
classification for both packets, and the resulting `HARD_GATE_FAILED`
state for B and D, are preserved exactly as ratified. Any rule erratum
remains pending explicit Owner confirmation before any further action.
