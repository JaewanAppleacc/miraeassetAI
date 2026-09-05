# Scorer patch: `ac_scorer_50cc1aa+multinode-fix-v1`

Locally-patched fork of the frozen scorer's `fourarm.py`, applied per
`../results/SCORER_MULTINODE_FIX_V1_AMENDMENT.md`. The upstream frozen commit
is never modified; this directory records the patch, the diff, and both SHAs
so the patched fork is never confused with the upstream pin.

| | |
|---|---|
| Upstream frozen scorer commit | `50cc1aac57145ab7fdb825cbb054842cb993c395` (`ac_scorer_50cc1aa`) |
| Upstream `fourarm.py` SHA-256 (unmodified) | `d62499328a43e5b9811c98c8fd810d423abc746152843db93880638f4a9dad0e` |
| Patched `fourarm.py` SHA-256 | `4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804` |
| Patch scope | `check_locators()`'s `claim_text_not_in_node` branch only, plus one new pure helper (`_table_aware_norm`) |
| `score.py` (unchanged by this patch) | `4f2a4c1063cabbd698e3f548b1ce87d957252736b7f1f34a4e5db77c598de124` |

`fourarm.patch.diff` is the exact, minimal unified diff against the upstream
file. `fourarm.patched.py` is the full patched file, committed for audit and
byte-for-byte reproducibility — it is a reference copy; the copy actually
executed for local scoring lives under gitignored
`work/bd_handoff/scorer/src/dart_corpus/evaluation/fourarm.py` and must match
this file's SHA-256 exactly whenever scoring is run.

See the amendment for the full root-cause analysis, the exact fix rule, and
why the patch cannot affect `duplicate_evidence_different_node` or any of
B/D's own unresolved population.
