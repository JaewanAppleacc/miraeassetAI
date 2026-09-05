import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const resultPath = new URL("../domain/agent-comparison/four-arm-ac/results/alternate-node-sensitivity-v1-result.json", import.meta.url);
const reportPath = new URL("../domain/agent-comparison/four-arm-ac/results/ALTERNATE_NODE_SENSITIVITY_V1_RESULT.md", import.meta.url);

test("real sensitivity result is blocked with no fabricated winner", async () => {
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.status, "NO_SELECTION_BLOCKED");
  assert.equal(result.winner, null);
  assert.equal(result.population_packet_count, 26);
  assert.equal(result.reviewer_consensus_count, 24);
  assert.equal(result.owner_override_count, 2);
  assert.equal(result.owner_review_required_count, 0);
  assert.deepEqual(result.outcome_distribution, {
    SUPPORTED_ALTERNATE_NODE: 19,
    ARM_SPECIFIC_CRITICAL: 4,
    ARM_SPECIFIC_NON_CRITICAL: 3,
    UNKNOWN: 0,
  });
  assert.ok(Object.values(result.metrics).every((arm) => arm.critical > 0));
});

test("result preserves evaluation and data boundaries", async () => {
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.original_result_run_files_modified, false);
  assert.equal(result.frozen_scorer_modified, false);
  assert.equal(result.retrieval_embedding_ranking_rerun, false);
  assert.equal(result.dev_check_holdout_access, false);
  assert.equal(result.dev_check_executed, false);
  assert.equal(result.production_wiring, false);
});

test("published report contains no raw evidence, personal path, email, or secret", async () => {
  const report = await readFile(reportPath, "utf8");
  assert.doesNotMatch(report, /"chunk_text"|"evidence_span"/);
  assert.doesNotMatch(report, /\/Users\/[a-z0-9_-]+/i);
  assert.doesNotMatch(report, /[\w.+-]+@[\w-]+\.[\w.-]+/);
  assert.doesNotMatch(report, /postgres(?:ql)?:\/\//i);
  assert.match(report, /NO_SELECTION_BLOCKED/);
});
