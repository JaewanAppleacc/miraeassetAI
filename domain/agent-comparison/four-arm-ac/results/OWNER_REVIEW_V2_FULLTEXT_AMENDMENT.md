# FOURARM-OWNER-REVIEW-V2 — full-text review amendment

This amendment records a review-surface defect found before any of the 22 new
Owner decisions was finalized.

## Defect and correction

The frozen scorer exports `chunk_text` into each unresolved packet using
`r.get("text", "")[:400]`. The 400-character value is sufficient as an identity
prefix, but it is not sufficient evidence for human adjudication when the
relevant table row, period, or figure occurs later in the retrieved chunk.

The scorer and the original A/C result/run artifacts remain frozen. Local-only
review material is rebuilt from the already-produced A/C hydrated scoring views.
Each complete text is accepted only when all of the following hold:

1. question, document, and primary node identity match the unresolved packet;
2. the scorer-exported text is a prefix of the complete text;
3. the complete text exactly equals one hydrated result item; and
4. its SHA-256 equals that result item's frozen `chunk_text_sha256`.

Any mismatch aborts the whole review build. Partial hydration and fallback to
the 400-character value are forbidden. Review artifacts containing raw text
remain under gitignored `work/` and are not committed.

## Supersession and frozen semantics

- Every recommendation or draft derived from the 400-character packet view is
  superseded and must not be ratified.
- The rebuilt local draft SHA-256 is
  `e73e5b909f1d215c265f51a034c445379f98cf05c3b866bfa00d95c6c3293408`.
- The rebuilt recommendation distribution is 2 `COMMON_SOURCE`, 20 `UNKNOWN`,
  and 0 `ARM_SPECIFIC`. These remain non-binding recommendations.
- The frozen scorer's `ARM_SPECIFIC` behavior is unchanged: it denotes a slot
  failure for the affected arm; only `critical=true` additionally fails the
  hard safety gate. Existing automatic locator `minor` handling is unchanged.
- No `EQUIVALENT_EVIDENCE` class or equivalent fourth resolution state is
  introduced.
- `COMMON_SOURCE` means arm-independent exclusion of a defective or incomplete
  Gold/source item; it is not interchangeable with a minor locator difference.

No rescoring, retrieval rerun, Owner decision, DEV_CHECK access, or winner
declaration is authorized by this amendment. The next permitted step is a human
Owner's arm-blind review of the corrected full-text material.

