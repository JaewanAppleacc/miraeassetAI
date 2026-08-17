import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { evaluateSeedRuntimeV02Release } from "../scripts/audit-seed-runtime-v02-release.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const planText = `${Array.from({ length: 23 }, (_, index) => JSON.stringify({ question_id: `q${index}` })).join("\n")}\n`;
  const results = Array.from({ length: 25 }, (_, index) => ({
    question_id: index === 2 ? "question_seed_v07_03" : index === 21 ? "question_seed_v07_22" : `q${index}`,
    execution_mode_actual: index === 2 || index === 21 ? "EARLY_EXIT" : "STRUCTURED",
    response_usable: true,
  }));
  return {
    structuredManifest: { artifact_set_id: "seed-structured-artifacts-v0.2", corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x" },
    planManifest: { corpus_snapshot_id: "corpus_x", fact_coverage_snapshot_id: "coverage_x", artifact_sha256: sha256(planText), record_count: 23, forbidden_runtime_fields: ["expected_answer"] },
    planText,
    harnessSummary: { run_id: "run", git_commit: "a".repeat(40), total: 25, api_success: 25, contract_success: 25, response_usable: 25, metric_eligible: 23, metric_excluded: 2, timeouts: 0, http_errors: 0, contract_errors: 0, reservation_failures: 0, question_echo_mismatches: 0, metric_fail: 0, not_scored: 0, review_required: 0 },
    harnessResults: results,
    currentCommit: "a".repeat(40),
    sourceTreeClean: true,
  };
}

test("a clean, commit-bound 23+2 E2E can pass both release gates", () => {
  const report = evaluateSeedRuntimeV02Release(fixture());
  assert.equal(report.runtime_wiring_gate, "PASS");
  assert.equal(report.answer_quality_gate, "PASS");
  assert.equal(report.release_gate, "PASS");
});

test("a stale commit or dirty source tree blocks runtime promotion", () => {
  const input = fixture(); input.currentCommit = "b".repeat(40); input.sourceTreeClean = false;
  const report = evaluateSeedRuntimeV02Release(input);
  assert.equal(report.runtime_wiring_gate, "BLOCKED");
  assert.ok(report.wiring_blockers.includes("HARNESS_GIT_COMMIT_MISMATCH"));
  assert.ok(report.wiring_blockers.includes("SOURCE_TREE_NOT_CLEAN"));
});

test("transport success never hides unresolved answer-quality metrics", () => {
  const input = fixture(); input.harnessSummary.metric_fail = 29; input.harnessSummary.not_scored = 28; input.harnessSummary.review_required = 13;
  const report = evaluateSeedRuntimeV02Release(input);
  assert.equal(report.runtime_wiring_gate, "PASS");
  assert.equal(report.answer_quality_gate, "BLOCKED");
  assert.equal(report.release_gate, "BLOCKED");
});

test("unexpected modes, unusable responses, and plan hash drift fail closed", () => {
  const input = fixture(); input.harnessResults[0].execution_mode_actual = "RETRIEVAL"; input.harnessResults[1].response_usable = false; input.planText = input.planText.replace('"q0"', '"qx"');
  const report = evaluateSeedRuntimeV02Release(input);
  assert.equal(report.runtime_wiring_gate, "BLOCKED");
  assert.ok(report.wiring_blockers.some((item) => item.startsWith("HARNESS_MODE_MISMATCH")));
  assert.ok(report.wiring_blockers.some((item) => item.startsWith("HARNESS_RESPONSE_UNUSABLE")));
  assert.ok(report.wiring_blockers.includes("PLAN_HASH_MISMATCH"));
});
