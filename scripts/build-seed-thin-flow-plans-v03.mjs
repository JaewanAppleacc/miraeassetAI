import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedThinFlowPlans } from "./build-seed-thin-flow-plans.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V03_PLAN_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.15.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.3.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.3.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.3.manifest.json",
});

export function buildSeedThinFlowPlansV03(options = {}) {
  return buildSeedThinFlowPlans({
    root, paths: V03_PLAN_PATHS, expectedPlanCount: 25, excludedQuestionIds: [], ...options,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlansV03();
  console.log(JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }));
}
