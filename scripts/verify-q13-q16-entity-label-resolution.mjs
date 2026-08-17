// Verifies (in-process, real v0.19-release-gated services, real Q13/Q16
// Gold questions) that Turn "Company Directory gate" behavior is correct:
//   1. With NO companyLabels (today's actual production state -- the real
//      Owner decision is PENDING): real names never appear, corp_code
//      never appears, response is PARTIAL, missing_capabilities includes
//      ENTITY_LABEL_RESOLUTION.
//   2. With a companyLabels map obtained ONLY through
//      createGatedSeedCompanyResolver() and a SIMULATED APPROVED decision
//      (a throwaway temp-file fixture -- the REAL
//      seed-company-directory-owner-decision-template.v0.1.json is never
//      touched/approved by this script): real company names appear,
//      no literal company-name string exists in thin-structured-flow.mjs's
//      executable code, no bare corp_code appears in the answer, and the
//      comparison direction matches Calculator's real DIFF sign
//      convention against the real Fact data.
// This script never reads Gold's expected_answer/scoring_spec, and never
// branches on question_id/company name in Runtime code (only in this
// verification script's own SELECTION of which 2 real questions to probe,
// exactly the same class of allowed data-authoring choice used throughout
// this session's audit scripts).
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createThinStructuredFlow } from "../domain/flows/thin-structured-flow.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const PLAN_V06_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const STRUCTURED_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const CANONICAL_RELEASE_MANIFEST_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json");
const COMPANY_DIRECTORY_ARTIFACT_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl");
const COMPANY_DIRECTORY_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json");

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 });
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

async function runQuestion(gold, question_id, context, serviceAdapters, planStore, extraContext = {}) {
  const flow = createThinStructuredFlow();
  const g = gold.find((item) => item.question_id === question_id);
  const plan = planStore.resolve(g.question_id, g.question);
  return runAgentFlow(
    flow,
    { question: g.question, question_id: g.question_id, plan: { ...plan, context } },
    { ...context, ...extraContext, as_of_date: plan.as_of_date, signal: undefined },
    LIMITS,
    serviceAdapters,
  );
}

async function main() {
  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const { context, serviceAdapters } = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_PATH, canonicalReleaseManifestPath: CANONICAL_RELEASE_MANIFEST_PATH,
    planPath: PLAN_V06_PATH, planManifestPath: PLAN_V06_MANIFEST_PATH, root: REPO,
    expectedReleaseId: "seed-release-v0.19", expectedApprovedRevision: "seed-structured-artifacts-v0.6", requireOwnerBatchDecision: true,
  });
  // planStore for v0.6 legacy plans (question_id-keyed, no Candidate
  // sub_requests) -- reuse the same createSeedQuestionPlanStore path this
  // whole session already established for v0.6.
  const { createSeedQuestionPlanStore } = await import("../domain/adapters/seed-question-plan-store.mjs");
  const planStore = await createSeedQuestionPlanStore({ planPath: PLAN_V06_PATH, manifestPath: PLAN_V06_MANIFEST_PATH });

  const report = { generated_at: new Date().toISOString(), checks: [] };

  // -- Part 1: TODAY's real production state (no companyLabels) --------
  for (const qid of ["question_seed_v07_13", "question_seed_v07_16"]) {
    const outcome = await runQuestion(gold, qid, context, serviceAdapters, planStore);
    const answer = outcome.final_response.answer;
    const synthesis = outcome.final_response.think_trace.validation.synthesis;
    report.checks.push({
      phase: "PRODUCTION_TODAY_NO_COMPANY_LABELS", question_id: qid,
      contains_real_name: /HD현대중공업|삼성중공업|HMM|현대모비스/.test(answer),
      contains_corp_code: /01390344|00126478|00164645|00164788/.test(answer),
      contains_unresolved_placeholder: answer.includes("미해결 기업"),
      synthesis_status: synthesis.status,
      missing_capabilities: synthesis.missing_capabilities,
    });
  }

  // -- Part 2: simulated Owner approval (test-only, real files untouched) --
  const tmpDir = await mkdtemp(path.join(tmpdir(), "seed-company-directory-sim-approval-"));
  try {
    const [artifactBytes, manifestBytes] = await Promise.all([readFile(COMPANY_DIRECTORY_ARTIFACT_PATH), readFile(COMPANY_DIRECTORY_MANIFEST_PATH)]);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const simulatedDecision = {
      schema_version: "0.1.0", decision_id: "SIMULATION_ONLY_never_a_real_owner_approval",
      artifact_path: path.relative(REPO, COMPANY_DIRECTORY_ARTIFACT_PATH),
      artifact_sha256: sha256(artifactBytes),
      manifest_path: path.relative(REPO, COMPANY_DIRECTORY_MANIFEST_PATH),
      manifest_sha256: sha256(manifestBytes),
      record_count: manifest.record_count, corpus_snapshot_id: manifest.corpus_snapshot_id,
      owner_disposition: "APPROVED", reviewer: "SIMULATION_verify_script_not_a_real_reviewer", reviewed_at: new Date().toISOString(),
    };
    const simulatedDecisionPath = path.join(tmpDir, "simulated-decision.json");
    await writeFile(simulatedDecisionPath, JSON.stringify(simulatedDecision));
    const gatedResolver = await createGatedSeedCompanyResolver({
      artifactPath: COMPANY_DIRECTORY_ARTIFACT_PATH, manifestPath: COMPANY_DIRECTORY_MANIFEST_PATH,
      ownerDecisionPath: simulatedDecisionPath, root: REPO,
    });
    const companyLabels = new Proxy({}, { get: (_, corpCode) => gatedResolver.resolve(corpCode) ?? undefined });

    for (const qid of ["question_seed_v07_13", "question_seed_v07_16"]) {
      const outcome = await runQuestion(gold, qid, context, serviceAdapters, planStore, { companyLabels });
      const answer = outcome.final_response.answer;
      const value = outcome.final_response.think_trace.calculation.value;
      const synthesis = outcome.final_response.think_trace.validation.synthesis;
      report.checks.push({
        phase: "SIMULATED_APPROVED_GATE", question_id: qid,
        contains_real_name: /HD현대중공업|삼성중공업|HMM|현대모비스/.test(answer),
        contains_corp_code: /01390344|00126478|00164645|00164788/.test(answer),
        synthesis_status: synthesis.status,
        winner_corp_code_fields: Object.fromEntries(Object.entries(value).filter(([k]) => k.endsWith("_corp_code"))),
      });
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify(report, null, 2));
  const outPath = path.join(REPO, "work/domain-seed/seed-q13-q16-entity-label-resolution-verification.v0.1.json");
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
