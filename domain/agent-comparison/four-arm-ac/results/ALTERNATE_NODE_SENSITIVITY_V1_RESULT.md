# `FOURARM-ALTERNATE-NODE-SENSITIVITY-V1` — Result

## Verdict

`NO_SELECTION_BLOCKED`: after applying the full-population alternate-node
policy, no arm passes the zero-critical hard safety gate.

This is a sensitivity result, not a replacement for the original vFINAL
result. No retrieval, embedding, or ranking was rerun, and no original
A/B/C/D result/run file or frozen scorer file was modified.

## Review and Owner resolution

- Population: all 26 `duplicate_evidence_different_node` packets from the same
  A/B/C/D DEV_TUNE batch.
- Population combined SHA-256:
  `20b6b943a6b8d71f88fe9b347010f2dd41f598e034bc36aae1c3a842b5315e2e`.
- Reviewer artifacts validated independently against the population and policy.
- Reviewer consensus: 24/26.
- Human Owner overrides: 2/26, both resolving a 400-character review-export
  truncation misunderstanding after the original frozen retrieval chunks were
  verified to contain the complete required values.
- Final sensitivity outcomes: 19 `SUPPORTED_ALTERNATE_NODE`, 4
  `ARM_SPECIFIC_CRITICAL`, 3 `ARM_SPECIFIC_NON_CRITICAL`, 0 `UNKNOWN`.
- Final-decision artifact SHA-256:
  `04b3628c7e58d8a864c94315ccabe0d0f2b4835d91595d6eb4edd5656d6246d1`.

## Sensitivity scoring result

| arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all-found@10 | critical | minor | unresolved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 0.7552 | 0.8217 | 0.8531 | 0.808 | 0.9167 | 16/19 | 2 | 20 | 0 |
| B | 0.4790 | 0.5769 | 0.6608 | 0.576 | 0.5833 | 10/19 | 2 | 12 | 0 |
| C | 0.7238 | 0.7587 | 0.8636 | 0.748 | 0.8333 | 14/19 | 1 | 15 | 1 |
| D | 0.4860 | 0.5839 | 0.6678 | 0.576 | 0.6389 | 9/19 | 2 | 11 | 0 |

The 19 supported packet IDs occur in 34 arm-specific slot instances because
the same arm-blind packet can be surfaced by more than one arm. Accepted
alternate-node evidence is reported as sensitivity-only minor evidence and no
longer contributes to unresolved counts.

## Hard-gate result

- A: two genuine consolidated/separate-scope evidence mismatches
  (`u-47511cac6428`, `u-e4b7183bc619`).
- B: two previously confirmed consolidated/separate-scope mismatches
  (`u-1b6cd184a87f`, `u-8564414f6080`).
- C: one pre-existing row/column critical mismatch; one unrelated
  non-alternate-node unresolved packet also remains.
- D: the same two confirmed scope mismatches as B.

Because every arm has at least one critical violation, the selection chain
stops before quality/LOW comparison. A remains the strongest retrieval arm by
Recall@10, but it is not a valid winner under the frozen zero-critical safety
gate.

## Reproducibility and boundaries

- Sensitivity judgement SHA-256:
  `df2201a62a889d31e3137e5237993b131a9a35a9da1cf85558538acfc7ae3cab`.
- Per-arm sensitivity score SHA-256:
  - A: `3c00a371259ba96877cbf4bd6c985512ba9744bed488fbe0da33578aec49efdb`
  - B: `38418a2ea9d11f66460e7f92e0126903caae6b2bf9a34a28e2f4897d30876eec`
  - C: `bab16594bc97b8366d45bb747904b5f0b8857c5d7b6ac81b6739689c703c4d7f`
  - D: `435a956fb7a64890500ef50b1def0bfa5dd0ef53444ec605e491ae1121904c02`
- Original A/B/C/D result/run SHA comparison before and after: byte-identical.
- DEV_CHECK/HOLDOUT: not accessed.
- DEV_CHECK one-shot: not executed because no provisional winner exists.
- Production wiring: none.

## Next decision

The current four arms cannot be finalized under the hard safety contract.
Continuing requires a separately pre-registered remediation candidate that
prevents consolidated/separate and row/column scope confusion before evidence
is accepted. The present result must not be relabeled as a successful A
selection merely because A has the highest Recall@10.
