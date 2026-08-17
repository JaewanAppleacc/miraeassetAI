// Generic single-question in-process answer inspector (real v0.19-gated
// services, real Gold question text). Pass a question_id as argv[2].
// Read-only audit tool, never touches Gold's expected_answer/scoring_spec.
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createThinStructuredFlow } from "../domain/flows/thin-structured-flow.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const g = gold.find((x) => x.question_id === process.argv[2]);
const plan = planStore.resolve(g.question_id, g.question);
const outcome = await runAgentFlow(
  flow, { question: g.question, question_id: g.question_id, plan: { ...plan, context } },
  { ...context, as_of_date: plan.as_of_date, signal: undefined },
  { maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 }, serviceAdapters,
);
console.log("QUESTION:", g.question);
console.log("---ANSWER---");
console.log(outcome.final_response.answer);
console.log("---SYNTHESIS---");
console.log(JSON.stringify(outcome.final_response.think_trace.validation.synthesis, null, 2));
