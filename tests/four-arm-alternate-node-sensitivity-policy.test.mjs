import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const policyPath = path.join(
  root,
  "domain/agent-comparison/four-arm-ac/official/alternate-node-sensitivity-policy.v1.json",
);
const amendmentPath = path.join(
  root,
  "domain/agent-comparison/four-arm-ac/results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md",
);

async function loadPolicy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

test("alternate-node sensitivity is explicitly post-result and cannot replace vFINAL", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.status, "FROZEN_FOR_POST_RESULT_SENSITIVITY_ONLY");
  assert.equal(policy.official_vfinal_result_mutable, false);
  assert.equal(policy.sensitivity_can_auto_replace_official_result, false);
  assert.equal(policy.owner_confirmed, false);
});

test("policy applies to the complete four-arm duplicate-node population", async () => {
  const policy = await loadPolicy();
  assert.deepEqual(policy.population.arms, ["A", "B", "C", "D"]);
  assert.equal(policy.population.reason, "duplicate_evidence_different_node");
  assert.equal(policy.population.full_batch_required, true);
  assert.equal(policy.population.motivating_packet_allowlist_permitted, false);
  assert.equal(policy.packet_id_specific_logic_permitted, false);
});

test("alternate evidence requires semantic compatibility, not numeric overlap", async () => {
  const policy = await loadPolicy();
  assert.deepEqual(policy.acceptance_conditions, [
    "SAME_DOCUMENT_AND_REAL_NODES",
    "DECLARED_NODE_TEXT_INTEGRITY_VERIFIED",
    "ALL_REQUIRED_SLOT_EVIDENCE_PRESENT",
    "ENTITY_METRIC_SUBTYPE_SCOPE_PERIOD_UNIT_SIGN_CALCULATION_COMPATIBLE",
    "NO_CONTRADICTORY_VALUE_OR_QUALIFIER",
    "ARM_BLIND_REPRODUCIBLE_DECISION",
  ]);
  assert.equal(policy.outcomes.semantic_or_locator_contradiction, "ARM_SPECIFIC_CRITICAL");
  assert.equal(policy.outcomes.correct_but_incomplete, "ARM_SPECIFIC_NON_CRITICAL");
  assert.equal(policy.outcomes.insufficient_evidence, "UNKNOWN");
});

test("execution boundaries prohibit retrieval reruns and held-out access", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.original_result_run_files_immutable, true);
  assert.equal(policy.retrieval_embedding_ranking_rerun, false);
  assert.equal(policy.dev_check_holdout_access, false);
  assert.equal(policy.thresholds_unchanged, true);
  assert.equal(policy.common_source_meaning_unchanged, true);
});

test("amendment contains no packet-specific exception or personal/secret material", async () => {
  const text = await readFile(amendmentPath, "utf8");
  assert.doesNotMatch(text, /u-[0-9a-f]{12}/);
  assert.doesNotMatch(text, /\/Users\/[a-z0-9_-]+/i);
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/);
  assert.match(text, /every.*duplicate_evidence_different_node/is);
  assert.match(text, /sensitivity result must never be presented as the original pre-registered\s+winner/i);
});
