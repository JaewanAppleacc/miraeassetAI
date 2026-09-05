import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSideBySideReport,
  classifyRobustness,
  SensitivityReportError,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-report.mjs";

function metrics(overrides = {}) {
  return {
    recall_at_5: 0.5, recall_at_10: 0.6, recall_at_20: 0.7,
    high_recall_at_10: 0.6, low_recall_at_10: 0.6, low_all_required_slots_found: 0.5,
    ...overrides,
  };
}

function fullMetrics(perArmOverrides = {}) {
  return Object.fromEntries(["A", "B", "C", "D"].map((arm) => [arm, metrics(perArmOverrides[arm])]));
}

function fullHardGate() {
  return Object.fromEntries(["A", "B", "C", "D"].map((arm) => [arm, { arm, hard_gate_state: "HARD_GATE_PASSED", critical_packet_ids: [] }]));
}

test("ROBUST when both tracks select the same non-null winner", () => {
  const robustness = classifyRobustness({ status: "PROVISIONAL_WINNER", winner: "A" }, { status: "PROVISIONAL_WINNER", winner: "A" });
  assert.equal(robustness.classification, "ROBUST");
  assert.equal(robustness.sensitivity_winner_auto_promoted, false);
});

test("POLICY_SENSITIVE when the tracks select different winners", () => {
  const robustness = classifyRobustness({ status: "PROVISIONAL_WINNER", winner: "A" }, { status: "PROVISIONAL_WINNER", winner: "B" });
  assert.equal(robustness.classification, "POLICY_SENSITIVE");
});

test("POLICY_SENSITIVE when the official track is blocked but sensitivity selects a winner", () => {
  const robustness = classifyRobustness({ status: "PENDING_UNRESOLVED", winner: null }, { status: "PROVISIONAL_WINNER", winner: "C" });
  assert.equal(robustness.classification, "POLICY_SENSITIVE");
  assert.equal(robustness.sensitivity_winner_auto_promoted, false);
});

test("POLICY_SENSITIVE (not ROBUST) when both tracks are blocked with no winner", () => {
  const robustness = classifyRobustness({ status: "NO_SELECTION_BLOCKED", winner: null }, { status: "NO_SELECTION_BLOCKED", winner: null });
  assert.equal(robustness.classification, "POLICY_SENSITIVE");
});

test("builds a full side-by-side report with per-arm hard gate and never promotes the sensitivity winner", () => {
  const report = buildSideBySideReport({
    officialMetricsByArm: fullMetrics(),
    sensitivityMetricsByArm: fullMetrics(),
    perArmHardGate: fullHardGate(),
    officialResult: { status: "PENDING_UNRESOLVED", winner: null },
    sensitivityResult: { status: "PROVISIONAL_WINNER", winner: "A" },
  });
  assert.equal(report.arms.length, 4);
  for (const armReport of report.arms) {
    assert.ok(armReport.official_metrics);
    assert.ok(armReport.sensitivity_metrics);
    assert.ok(armReport.hard_gate);
  }
  assert.equal(report.robustness.classification, "POLICY_SENSITIVE");
  assert.equal(report.sensitivity_winner_promoted_to_official, false);
});

test("rejects a report missing metrics for one arm", () => {
  const incomplete = fullMetrics();
  delete incomplete.D;
  assert.throws(
    () => buildSideBySideReport({
      officialMetricsByArm: incomplete,
      sensitivityMetricsByArm: fullMetrics(),
      perArmHardGate: fullHardGate(),
      officialResult: { status: "PROVISIONAL_WINNER", winner: "A" },
      sensitivityResult: { status: "PROVISIONAL_WINNER", winner: "A" },
    }),
    (error) => error instanceof SensitivityReportError && error.code === "SENSITIVITY_REPORT_MISSING_ARM_METRICS",
  );
});
