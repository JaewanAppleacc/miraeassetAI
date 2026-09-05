# `FOURARM-ALTERNATE-NODE-SENSITIVITY-V1` — Post-result amendment

This amendment freezes a **separate sensitivity analysis** for valid evidence
repeated at a node that is not listed in Gold's `acceptable_sources`. It does
not rewrite the vFINAL experiment, its frozen scorer result, or its hard-gate
judgement.

## Why this amendment exists

Two independent arm-blind reviews agreed on the three unambiguous packets but
disagreed on six packets whose retrieved node contains complete, correctly
scoped evidence while Gold designates another node in the same document.

- Reviewer A applied the existing vFINAL rule literally: a different node is
  `ARM_SPECIFIC/critical`.
- Reviewer B found that calling correct, independently supporting evidence a
  retrieval failure would measure Gold-locator exclusivity rather than factual
  retrieval quality. Because the existing three-class vocabulary has no honest
  label for this case, those packets remained `UNKNOWN + CONTRACT_GAP`.

This disagreement exposes a real contract gap. It is not permission to create
packet-specific exceptions after seeing the results.

## Frozen inputs

- Base source HEAD: `ae8c80a11141f2d2335990d0b443d887d9c3c3f4`
- v3 raw-packet combined SHA-256:
  `3b662957dffcaa2a71f183b1a62b0f2e6e8fc887f9b9bd7c6d09927c498d5d09`
- Reviewer A output SHA-256:
  `74bb396daa8c028964e2fd1ecc9d790bd3cbe8c79c594a4018d28871d7f11a20`
- Reviewer B output SHA-256:
  `71c38fdb5e12355eadccd770381952cb98367833808016fa4ba8e64da5e890b0`
- Both reviewer artifacts are non-binding and have `owner_confirmed=false`.

## Official track remains immutable

The official vFINAL track keeps the frozen three classes:
`COMMON_SOURCE`, `ARM_SPECIFIC`, and `UNKNOWN`. No original A/B/C/D result or
run file, Gold source list, upstream scorer, prior Owner resolution, score, or
judgement is overwritten. Until its remaining packets are resolved under that
contract, its status remains `PENDING_UNRESOLVED`.

The sensitivity result must never be presented as the original pre-registered
winner.

## Sensitivity population

The alternate-node rule must be applied to **every**
`duplicate_evidence_different_node` packet produced by the same full-batch
DEV_TUNE scoring view for A, B, C, and D. It may not be restricted to the six
packets that motivated this amendment, to one arm, to one question, or to
packets whose treatment changes the winner.

No retrieval, embedding, ranking, or result-file edit is permitted. The same
already-retrieved batch is rescored through a separately versioned sensitivity
view.

## Alternate-node acceptance rule

An alternate node is `SUPPORTED_ALTERNATE_NODE` only when all of the following
are established from the frozen Gold and SHA-verified corpus/retrieval text:

1. The document identity is identical and every referenced node exists.
2. The retrieved chunk is verified as an exact or normalization-only excerpt
   of its declared node.
3. Every value or fact required by the slot is present; a chunk truncated before
   any required element fails this condition.
4. Entity, metric, document subtype, consolidated/separate scope, period,
   unit, sign, and calculation meaning are compatible with the Gold evidence.
5. The retrieved context contains no contradictory value or qualifier for the
   required slot.
6. The conclusion is arm-blind and reproducible from the evidence itself, not
   from rank, score, latency, arm identity, or winner impact.

Exact numeric-string overlap alone is insufficient. In particular, a
consolidated/separate mismatch or a different period is a critical failure even
when one line item happens to match.

## Sensitivity outcomes

`SUPPORTED_ALTERNATE_NODE` is an audit outcome used only by this sensitivity
track; it is not silently inserted into the frozen vFINAL resolution file.

- All six acceptance conditions pass: keep the slot found and report the
  alternate locator separately.
- Wrong document, scope, period, entity, metric, unit, or contradictory value:
  `ARM_SPECIFIC`, `critical=true`.
- Correct source but incomplete/truncated before required evidence:
  `ARM_SPECIFIC`, `critical=false` and recompute the slot as not found.
- Available evidence cannot establish the conditions: `UNKNOWN`; selection
  remains pending for the affected arm.
- `COMMON_SOURCE` retains its existing narrow meaning and is not used merely
  because a valid fact is repeated in another node.

## Reporting and decision boundary

The report must show official-vFINAL and sensitivity results side by side,
including per-arm hard gate, Recall@5/10/20, HIGH Recall@10, LOW Recall@10, and
LOW all-required-slots-found. Thresholds and tie rules remain unchanged.

If both tracks select the same arm, the result is robust to the locator-policy
gap. If they differ, or the official track remains blocked while the
sensitivity track selects an arm, the result is `POLICY_SENSITIVE`; the
sensitivity winner is not promoted automatically. Owner approval and a future
prospective contract version are required before using the alternate-node rule
as the official evaluation contract.

## Prohibitions

- No packet-ID-specific branches or allowlists.
- No use of arm/rank/score/winner fields during evidence adjudication.
- No partial arm or favorable-question rerun.
- No modification of A/B/C/D original result/run files or frozen scorer files.
- No DEV_CHECK or HOLDOUT access.
- No Owner signature or `owner_confirmed=true` written by an agent.
