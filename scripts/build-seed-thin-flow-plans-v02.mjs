import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSeedThinFlowPlans } from "./build-seed-thin-flow-plans.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V02_PLAN_PATHS = Object.freeze({
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.14.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.2.json",
  plans: "work/domain-seed/seed-thin-flow-plans.v0.2.jsonl",
  manifest: "work/domain-seed/seed-thin-flow-plans.v0.2.manifest.json",
});

export function buildSeedThinFlowPlansV02(options = {}) {
  return buildSeedThinFlowPlans({ root, paths: V02_PLAN_PATHS, ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSeedThinFlowPlansV02();
  console.log(JSON.stringify({ plan_count: result.plans.length, artifact_sha256: result.manifest.artifact_sha256 }));
}
