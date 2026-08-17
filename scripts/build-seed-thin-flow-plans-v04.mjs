import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedThinFlowPlans } from "./build-seed-thin-flow-plans.mjs";

// Bound to the NEW Owner-approved Gold (v0.17) and the NEW VERIFIED
// Coverage Snapshot (v0.4) -- NOT v0.3's plan, which is bound to Gold
// v0.15 + Coverage v0.3 and therefore still reflects the pre-promotion
// (row=16-linked) grounding. All 25 questions, no exclusions: Q3/Q22 are
// fully approved as of seed-structured-owner-decision.v0.4.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V04_PLAN_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.4.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.4.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.4.manifest.json",
});

export function buildSeedThinFlowPlansV04(options = {}) {
  return buildSeedThinFlowPlans({
    root, paths: V04_PLAN_PATHS, expectedPlanCount: 25, excludedQuestionIds: [], ...options,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlansV04();
  console.log(JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }));
}
