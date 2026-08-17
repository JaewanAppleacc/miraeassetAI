// Turn K: locks in the real-corpus consequence of projectWinnerField --
// Q13/Q16's calculationValue now carries the resolver-derived
// revenue_winner/operating_profit_winner/larger_change_magnitude_company
// fields again (never a literal -- see thin-structured-flow.mjs), and
// Q13's structured "value" harness metric (Gold expects these exact
// fields) is expected to recover to PASS as a consequence -- verified
// here directly against the real v0.19-gated services + real APPROVED
// Company Directory decision, never against Gold's raw expected_answer
// text (this test only inspects the SAME think_trace.calculation.value
// the real /answer API would return).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createThinStructuredFlow } from "../domain/flows/thin-structured-flow.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 });

async function runQuestion(question_id) {
  const gold = (await readFile(path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const { context, serviceAdapters } = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json"),
    canonicalReleaseManifestPath: path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json"),
    planPath: path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
    planManifestPath: path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
    root: REPO, expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6", requireOwnerBatchDecision: true,
    companyDirectoryArtifactPath: path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
    companyDirectoryManifestPath: path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
    companyDirectoryOwnerDecisionPath: path.join(REPO, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedCompanyDirectoryOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
  });
  const planStore = await createSeedQuestionPlanStore({
    planPath: path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"),
    manifestPath: path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json"),
  });
  const flow = createThinStructuredFlow();
  const g = gold.find((x) => x.question_id === question_id);
  const plan = planStore.resolve(g.question_id, g.question);
  return runAgentFlow(flow, { question: g.question, question_id: g.question_id, plan: { ...plan, context } }, { ...context, as_of_date: plan.as_of_date, signal: undefined }, LIMITS, serviceAdapters);
}

test("Q13: revenue_winner/operating_profit_winner are resolver-derived real names (never a literal, never a bare corp_code), and synthesis stays PASS", async () => {
  const outcome = await runQuestion("question_seed_v07_13");
  const value = outcome.final_response.think_trace.calculation.value;
  assert.equal(value.revenue_winner, "HD현대중공업");
  assert.equal(value.operating_profit_winner, "HD현대중공업");
  assert.equal(value.revenue_winner_corp_code, "01390344");
  assert.equal(outcome.final_response.think_trace.validation.synthesis.status, "PASS");
  assert.equal(outcome.final_response.answer.includes("01390344"), false);
  assert.equal(outcome.final_response.answer.includes("미해결 기업"), false);
});

test("Q16: larger_change_magnitude_company is resolver-derived, and synthesis stays PASS", async () => {
  const outcome = await runQuestion("question_seed_v07_16");
  const value = outcome.final_response.think_trace.calculation.value;
  assert.equal(value.larger_change_magnitude_company, "HMM");
  assert.equal(value.larger_change_magnitude_company_corp_code, "00164645");
  assert.equal(outcome.final_response.think_trace.validation.synthesis.status, "PASS");
});
