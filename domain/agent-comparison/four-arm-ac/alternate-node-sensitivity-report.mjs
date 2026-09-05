// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: builds the side-by-side
// official-vFINAL vs. sensitivity report required by
// results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md#reporting-and-decision-boundary.
// This module only assembles and classifies already-computed metrics -- it
// never runs the scorer, never mutates official results, and never
// promotes a sensitivity-track winner into the official one. Promotion (if
// it ever happens) is a distinct, explicit, Owner-approved action outside
// this harness entirely; `sensitivity_winner_promoted_to_official` below is
// therefore always `false`, structurally, not merely by convention.
export const SENSITIVITY_REPORT_SCHEMA_VERSION = "fourarm.alternate-node-sensitivity-report.v1";

const ARMS = Object.freeze(["A", "B", "C", "D"]);
const REQUIRED_METRIC_KEYS = Object.freeze([
  "recall_at_5",
  "recall_at_10",
  "recall_at_20",
  "high_recall_at_10",
  "low_recall_at_10",
  "low_all_required_slots_found",
]);

export class SensitivityReportError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SensitivityReportError";
    this.code = code;
    Object.assign(this, details);
  }
}

function assertMetrics(metricsByArm, label) {
  if (!metricsByArm || typeof metricsByArm !== "object") {
    throw new SensitivityReportError(`${label} must be an object keyed by arm`, "SENSITIVITY_REPORT_INVALID_METRICS", { label });
  }
  for (const arm of ARMS) {
    const metrics = metricsByArm[arm];
    if (!metrics || typeof metrics !== "object") {
      throw new SensitivityReportError(`${label}.${arm} is required`, "SENSITIVITY_REPORT_MISSING_ARM_METRICS", { label, arm });
    }
    for (const key of REQUIRED_METRIC_KEYS) {
      const value = metrics[key];
      if (value !== null && typeof value !== "number") {
        throw new SensitivityReportError(`${label}.${arm}.${key} must be a number or null`, "SENSITIVITY_REPORT_INVALID_METRIC_VALUE", { label, arm, key });
      }
    }
  }
}

function assertHardGate(perArmHardGate) {
  if (!perArmHardGate || typeof perArmHardGate !== "object") {
    throw new SensitivityReportError("perArmHardGate must be an object keyed by arm", "SENSITIVITY_REPORT_INVALID_HARD_GATE");
  }
  for (const arm of ARMS) {
    if (!perArmHardGate[arm]) {
      throw new SensitivityReportError(`perArmHardGate.${arm} is required`, "SENSITIVITY_REPORT_MISSING_ARM_HARD_GATE", { arm });
    }
  }
}

// officialResult/sensitivityResult: { status, winner } (winner is an arm
// string or null), matching the shape four-arm-winner-selection.mjs's
// selectWinner() already returns. This function never selects a winner
// itself -- both are supplied pre-computed by their own tracks.
export function classifyRobustness(officialResult, sensitivityResult) {
  if (!officialResult || typeof officialResult !== "object") {
    throw new SensitivityReportError("officialResult is required", "SENSITIVITY_REPORT_MISSING_OFFICIAL_RESULT");
  }
  if (!sensitivityResult || typeof sensitivityResult !== "object") {
    throw new SensitivityReportError("sensitivityResult is required", "SENSITIVITY_REPORT_MISSING_SENSITIVITY_RESULT");
  }

  const sameWinner = officialResult.winner !== null
    && sensitivityResult.winner !== null
    && officialResult.winner === sensitivityResult.winner;
  // ROBUST only when both tracks agree on a real (non-null) winner. Any
  // other combination -- differing winners, or the official track still
  // blocked while sensitivity selects one -- is POLICY_SENSITIVE per the
  // amendment's explicit decision boundary.
  const classification = sameWinner ? "ROBUST" : "POLICY_SENSITIVE";

  return Object.freeze({
    classification,
    official_winner: officialResult.winner,
    sensitivity_winner: sensitivityResult.winner,
    sensitivity_winner_auto_promoted: false,
  });
}

export function buildSideBySideReport({
  officialMetricsByArm,
  sensitivityMetricsByArm,
  perArmHardGate,
  officialResult,
  sensitivityResult,
}) {
  assertMetrics(officialMetricsByArm, "officialMetricsByArm");
  assertMetrics(sensitivityMetricsByArm, "sensitivityMetricsByArm");
  assertHardGate(perArmHardGate);
  const robustness = classifyRobustness(officialResult, sensitivityResult);

  return Object.freeze({
    schema_version: SENSITIVITY_REPORT_SCHEMA_VERSION,
    arms: Object.freeze(ARMS.map((arm) => Object.freeze({
      arm,
      official_metrics: officialMetricsByArm[arm],
      sensitivity_metrics: sensitivityMetricsByArm[arm],
      hard_gate: perArmHardGate[arm],
    }))),
    official_result: Object.freeze({ ...officialResult }),
    sensitivity_result: Object.freeze({ ...sensitivityResult }),
    robustness,
    sensitivity_winner_promoted_to_official: false,
  });
}
