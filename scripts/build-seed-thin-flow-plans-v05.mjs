import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedThinFlowPlans } from "./build-seed-thin-flow-plans.mjs";

// Rebuilt against Coverage v0.5 (88 slots, includes the 6 new
// metric-gap-closure slots for Q02/Q04/Q05/Q10) -- v0.4's plan is bound to
// Coverage v0.4 and is stale the moment Coverage changes underneath it.
// Gold stays v0.17 (unchanged content, already Owner-approved).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V05_PLAN_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.5.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.5.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.5.manifest.json",
});

export function buildSeedThinFlowPlansV05(options = {}) {
  return buildSeedThinFlowPlans({
    root, paths: V05_PLAN_PATHS, expectedPlanCount: 25, excludedQuestionIds: [], ...options,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlansV05();
  console.log(JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }));
}
