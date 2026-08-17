import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedThinFlowPlans } from "./build-seed-thin-flow-plans.mjs";

// Rebuilt against Coverage v0.6 (88 slots -- v0.4's 82 + the v0.7-batch 6,
// Owner-approved via work/domain-seed/seed-structured-owner-decision.v0.7-batch.decision.jsonl,
// period-semantics fixed for the two Q10 slots) -- v0.5's plan is bound to
// Coverage v0.5 (the self-approved, superseded revision) and is stale the
// moment Coverage changes underneath it. Gold stays v0.17 (unchanged
// content, already Owner-approved).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V06_PLAN_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.6.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json",
});

export function buildSeedThinFlowPlansV06(options = {}) {
  return buildSeedThinFlowPlans({
    root, paths: V06_PLAN_PATHS, expectedPlanCount: 25, excludedQuestionIds: [], ...options,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlansV06();
  console.log(JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }));
}
