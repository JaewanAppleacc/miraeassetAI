// Turn M10 regression guard: calculationInput() must project each Fact's
// OWN real, unmodified `unit` (the Validator independently re-verifies
// every submitted calculation input field-for-field against its real
// corpus record, including unit -- a canonicalized/altered unit fails
// that check with FACT_UNIT_MISMATCH even though the Fact itself is
// perfectly valid). Unit canonicalization for the Calculator's own
// separate, stricter raw-string unit-equality gate must apply to a
// dedicated copy built only AFTER Validator acceptance, never to what the
// Validator itself sees.
//
// This is exercised here against the REAL production release (v0.19 /
// Plan v0.6 / structured-artifacts v0.6) exactly as
// tests/seed-q13-q16-winner-field-recovery.test.mjs already does -- the
// bug this guards against was a real, reproduced regression in the
// actual configured-seed-runtime.mjs path (Q02 and Q17 both fell back to
// EARLY_EXIT before the fix), not merely a synthetic fixture concern.
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

test("Turn M10 regression: a question whose ONLY structured facts include a lone INVESTMENT_AMOUNT (no purpose/target pair) still resolves as a real STRUCTURED answer, never EARLY_EXIT", async () => {
  const outcome = await runQuestion("question_seed_v07_02");
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.notEqual(outcome.final_response.answer, "정보 한계로 답변할 수 없습니다.");
  assert.match(outcome.final_response.answer, /268,000,000,000/);
});

test("Turn M10 regression: a termination-amount comparison whose real corpus units are spelled differently (KRW vs 원) across its Facts resolves as a real STRUCTURED answer, never EARLY_EXIT", async () => {
  // Against the production release (v0.19 / Plan v0.6), Q17 does not yet
  // carry the Turn M8-promoted LATEST_CONTRACT_AMOUNT facts (those are
  // only connected via the clean-Plan Candidate lineage, v0.12/v0.13) --
  // so this only asserts the regression-critical invariant (no crash/
  // EARLY_EXIT from the unit-spelling mismatch), not the "일치합니다"
  // match-check wording, which requires the Candidate Plan's own facts to
  // be present.
  const outcome = await runQuestion("question_seed_v07_17");
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.notEqual(outcome.final_response.answer, "정보 한계로 답변할 수 없습니다.");
  // Turn M10.1: the comparison sentence shape changed to a single
  // directional statement ("A의 해지금액(원)은 B보다 N원 큽니다") -- this
  // still proves the KRW/원 unit-alias comparison resolved to a real,
  // non-EARLY_EXIT STRUCTURED answer, which is the actual regression this
  // test guards.
  assert.match(outcome.final_response.answer, /해지금액\(원\)은 .+보다 .+원 큽니다/);
});
