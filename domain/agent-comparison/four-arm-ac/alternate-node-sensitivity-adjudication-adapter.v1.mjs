// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: versioned sensitivity
// adjudication adapter. This is a SEPARATE, ADDITIVE fork of how slot
// evidence is interpreted -- it never imports, patches, or otherwise
// touches the frozen scorer
// (domain/agent-comparison/four-arm-ac/scorer-patch-multinode-v1/fourarm.patched.py)
// or any A/B/C/D results.jsonl/run.json file. It is a pure function over
// already-computed baseline slot evidence plus a reviewer CONSENSUS
// comparison (see alternate-node-sensitivity-reviewer-comparison.mjs) and
// returns a new, separate "sensitivity view" object. Nothing it returns is
// ever written back into an official vFINAL artifact by this module.
//
// Outcome -> action mapping (frozen by
// official/alternate-node-sensitivity-policy.v1.json and
// results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md):
//   SUPPORTED_ALTERNATE_NODE     -> keep the slot's baseline evidence as-is
//   ARM_SPECIFIC_CRITICAL        -> invalidate the slot AND fail that arm's hard gate
//   ARM_SPECIFIC_NON_CRITICAL    -> invalidate the slot only (no hard-gate effect)
//   UNKNOWN                      -> leave the slot's evidence untouched; mark that arm's selection pending
//   (reviewer disagreement)      -> leave the slot's evidence untouched; pending Owner review
//
// COMMON_SOURCE is not part of this vocabulary at all -- this adapter never
// produces, consumes, or reinterprets it, so the existing official
// COMMON_SOURCE meaning and resolution are structurally unaffected.
export const SENSITIVITY_ADAPTER_VERSION = "fourarm.alternate-node-sensitivity-adapter.v1";

export const SENSITIVITY_ACTIONS = Object.freeze([
  "KEEP_EVIDENCE_ALTERNATE_LOCATOR",
  "INVALIDATE_AND_HARD_GATE_FAIL",
  "INVALIDATE_ONLY",
  "SELECTION_PENDING",
  "PENDING_OWNER_REVIEW",
  "NOT_IN_SENSITIVITY_POPULATION",
]);

const ARMS = Object.freeze(["A", "B", "C", "D"]);

export class SensitivityAdjudicationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SensitivityAdjudicationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function actionForConsensusOutcome(outcome) {
  switch (outcome) {
    case "SUPPORTED_ALTERNATE_NODE": return "KEEP_EVIDENCE_ALTERNATE_LOCATOR";
    case "ARM_SPECIFIC_CRITICAL": return "INVALIDATE_AND_HARD_GATE_FAIL";
    case "ARM_SPECIFIC_NON_CRITICAL": return "INVALIDATE_ONLY";
    case "UNKNOWN": return "SELECTION_PENDING";
    default: return null;
  }
}

// comparisonResult: output of compareReviewerArtifacts(...).
// baselineSlotEvidence: array of { packet_id, arm, question_id, slot_name,
// baseline_found } describing, for each arm where a duplicate-evidence-
// different-node match occurred, whether the frozen scorer's official view
// currently counts that slot as found. This adapter reads that array only
// as opaque data -- it never branches on packet_id, question_id, or
// slot_name values, only on the (outcome, arm) pair.
export function buildSensitivityView({ comparisonResult, baselineSlotEvidence }) {
  if (!comparisonResult || !Array.isArray(comparisonResult.per_packet)) {
    throw new SensitivityAdjudicationError("comparisonResult.per_packet is required", "SENSITIVITY_ADAPTER_MISSING_COMPARISON");
  }
  if (!Array.isArray(baselineSlotEvidence)) {
    throw new SensitivityAdjudicationError("baselineSlotEvidence must be an array", "SENSITIVITY_ADAPTER_INVALID_BASELINE");
  }

  const decisionByPacketId = new Map();
  for (const entry of comparisonResult.per_packet) {
    if (entry.status === "CONSENSUS") {
      const action = actionForConsensusOutcome(entry.agreed_outcome);
      if (!action) {
        throw new SensitivityAdjudicationError(
          `unrecognized consensus outcome ${JSON.stringify(entry.agreed_outcome)} for packet ${entry.packet_id}`,
          "SENSITIVITY_ADAPTER_UNKNOWN_OUTCOME",
          { packet_id: entry.packet_id },
        );
      }
      decisionByPacketId.set(entry.packet_id, { outcome: entry.agreed_outcome, action });
    } else if (entry.status === "OWNER_REVIEW_REQUIRED") {
      // Disagreement is never auto-resolved -- the slot stays at baseline,
      // and the packet is surfaced as pending, not silently dropped.
      decisionByPacketId.set(entry.packet_id, { outcome: null, action: "PENDING_OWNER_REVIEW" });
    } else {
      throw new SensitivityAdjudicationError(`unrecognized comparison status for packet ${entry.packet_id}`, "SENSITIVITY_ADAPTER_UNKNOWN_STATUS", { packet_id: entry.packet_id });
    }
  }

  const hardGateFailuresByArm = Object.fromEntries(ARMS.map((arm) => [arm, new Set()]));
  const selectionPendingByArm = Object.fromEntries(ARMS.map((arm) => [arm, new Set()]));

  const slotView = baselineSlotEvidence.map((slot, index) => {
    if (!slot || typeof slot !== "object") {
      throw new SensitivityAdjudicationError(`baselineSlotEvidence[${index}] must be an object`, "SENSITIVITY_ADAPTER_INVALID_SLOT_ENTRY");
    }
    if (typeof slot.packet_id !== "string") {
      throw new SensitivityAdjudicationError(`baselineSlotEvidence[${index}].packet_id must be a string`, "SENSITIVITY_ADAPTER_INVALID_SLOT_ENTRY");
    }
    if (!ARMS.includes(slot.arm)) {
      throw new SensitivityAdjudicationError(`baselineSlotEvidence[${index}].arm must be one of ${JSON.stringify(ARMS)}`, "SENSITIVITY_ADAPTER_INVALID_SLOT_ARM", { packet_id: slot.packet_id });
    }
    if (typeof slot.baseline_found !== "boolean") {
      throw new SensitivityAdjudicationError(`baselineSlotEvidence[${index}].baseline_found must be a boolean`, "SENSITIVITY_ADAPTER_INVALID_SLOT_BASELINE_FOUND", { packet_id: slot.packet_id });
    }

    const decision = decisionByPacketId.get(slot.packet_id);
    if (!decision) {
      return Object.freeze({
        ...slot,
        sensitivity_outcome: null,
        sensitivity_action: "NOT_IN_SENSITIVITY_POPULATION",
        sensitivity_found: slot.baseline_found,
      });
    }

    let sensitivityFound = slot.baseline_found;
    if (decision.action === "INVALIDATE_AND_HARD_GATE_FAIL" || decision.action === "INVALIDATE_ONLY") {
      sensitivityFound = false;
    }
    if (decision.action === "INVALIDATE_AND_HARD_GATE_FAIL") {
      hardGateFailuresByArm[slot.arm].add(slot.packet_id);
    }
    if (decision.action === "SELECTION_PENDING") {
      selectionPendingByArm[slot.arm].add(slot.packet_id);
    }

    return Object.freeze({
      ...slot,
      sensitivity_outcome: decision.outcome,
      sensitivity_action: decision.action,
      sensitivity_found: sensitivityFound,
    });
  });

  const perArmHardGate = {};
  for (const arm of ARMS) {
    const criticalPacketIds = Object.freeze([...hardGateFailuresByArm[arm]].sort());
    perArmHardGate[arm] = Object.freeze({
      arm,
      hard_gate_state: criticalPacketIds.length > 0 ? "HARD_GATE_FAILED" : "HARD_GATE_PASSED",
      critical_packet_ids: criticalPacketIds,
      selection_pending_packet_ids: Object.freeze([...selectionPendingByArm[arm]].sort()),
    });
  }

  return Object.freeze({
    schema_version: SENSITIVITY_ADAPTER_VERSION,
    generated_from: "REVIEWER_CONSENSUS_ONLY",
    slot_view: Object.freeze(slotView),
    per_arm_hard_gate: Object.freeze(perArmHardGate),
    common_source_meaning_unchanged: true,
    original_result_run_files_modified: false,
    frozen_scorer_modified: false,
    owner_confirmed: false,
    official_vfinal_result_mutable: false,
    sensitivity_can_auto_replace_official_result: false,
  });
}
