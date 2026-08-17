// Runs all 25 real Seed questions through the REAL Runtime services (same
// v0.19 release-authorized stores the production runtime reads -- v0.19
// itself is never modified, no new release is created) with the Plan
// v0.9 CANDIDATE's sub_requests, in-process, and records each
// sub_request's FULL typed `missing_reasons` diagnostic (see
// domain/flows/synthesis/sub-request-coverage-v2.mjs) plus a
// deterministic top-level classification (see
// domain/flows/synthesis/gap-classification.mjs): SATISFIABLE /
// IMPLEMENTATION_GAP / STRUCTURED_DATA_GAP / PLAN_AUTHORING_REVIEW_REQUIRED
// / OWNER_POLICY_DECISION_REQUIRED. Every record's Owner-approval fields
// stay PENDING/null -- this script never self-approves anything.
//
// v0.8 (plan/manifest/review/summary) is read-only history here and is
// never rewritten; v0.9 is a NEW file produced by
// scripts/build-seed-thin-flow-plans-v09-candidate.mjs.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { createThinStructuredFlow } from "../domain/flows/thin-structured-flow.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { classifyMissingReasons } from "../domain/flows/synthesis/gap-classification.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const PLAN_V09_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl");
const PLAN_V09_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.manifest.json");
const OWNER_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-response-owner-decision.v0.2.jsonl");
const STRUCTURED_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const CANONICAL_RELEASE_MANIFEST_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json");
const PLAN_V06_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const OUT_DIAGNOSTIC_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.gap-diagnostic.jsonl");
const OUT_SUMMARY_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.gap-diagnostic.summary.json");

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 });

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  const [gold, ownerDecisions] = await Promise.all([
    readFile(GOLD_PATH, "utf8").then((text) => text.trim().split("\n").map(JSON.parse)),
    readFile(OWNER_DECISION_PATH, "utf8").then((text) => text.trim().split("\n").map(JSON.parse)),
  ]);

  const { context, serviceAdapters } = await createSeedRuntimeServiceAdapters({
    structuredManifestPath: STRUCTURED_MANIFEST_PATH,
    canonicalReleaseManifestPath: CANONICAL_RELEASE_MANIFEST_PATH,
    planPath: PLAN_V06_PATH,
    planManifestPath: PLAN_V06_MANIFEST_PATH,
    root: REPO,
    expectedReleaseId: "seed-release-v0.19",
    expectedApprovedRevision: "seed-structured-artifacts-v0.6",
    requireOwnerBatchDecision: true,
  });
  const v09Store = await createSeedQuestionPlanStore({ planPath: PLAN_V09_PATH, manifestPath: PLAN_V09_MANIFEST_PATH });
  if (context.corpus_snapshot_id !== v09Store.context.corpus_snapshot_id || context.fact_coverage_snapshot_id !== v09Store.context.fact_coverage_snapshot_id) {
    throw new Error("v0.9 candidate plan snapshot does not match the release-authorized runtime snapshot");
  }

  const flow = createThinStructuredFlow();
  const diagnosticLines = [];
  const perQuestionSummary = [];
  const classificationTotals = {};

  for (const g of gold) {
    const plan = v09Store.resolve(g.question_id, g.question);
    if (!plan) throw new Error(`${g.question_id}: v0.9 candidate plan did not resolve for the real Gold question text`);
    const outcome = await runAgentFlow(
      flow,
      { question: g.question, question_id: g.question_id, plan: { ...plan, context } },
      { ...context, as_of_date: plan.as_of_date, signal: undefined },
      LIMITS,
      serviceAdapters,
    );
    const synthesis = outcome.final_response.think_trace.validation.synthesis;
    const coverageBySubRequestId = new Map((synthesis.covered_sub_requests ?? []).map((r) => [r.sub_request_id, r]));
    const relatedOwnerItems = ownerDecisions.filter((d) => d.question_id === g.question_id);

    let questionSatisfiable = 0;
    for (const subRequest of plan.sub_requests) {
      const coverage = coverageBySubRequestId.get(subRequest.sub_request_id) ?? { status: "MISSING", missing_reasons: [] };
      const classification = classifyMissingReasons(coverage.missing_reasons);
      classificationTotals[classification] = (classificationTotals[classification] ?? 0) + 1;
      if (classification === "SATISFIABLE") questionSatisfiable += 1;
      diagnosticLines.push(JSON.stringify({
        schema_version: "0.1.0",
        question_id: g.question_id,
        sub_request_id: subRequest.sub_request_id,
        intent: subRequest.intent,
        required_slot_names: subRequest.required_slot_names,
        required_output_bindings: subRequest.required_output_bindings,
        required_capabilities: subRequest.required_capabilities,
        runtime_coverage_status: coverage.status,
        missing_reasons: coverage.missing_reasons,
        classification,
        owner_related_review_items: relatedOwnerItems.map((d) => d.review_item_id),
        owner_approval_status: "PENDING",
        owner_reviewer: null,
        owner_reviewed_at: null,
        owner_notes: null,
      }));
    }
    perQuestionSummary.push({ question_id: g.question_id, sub_request_count: plan.sub_requests.length, satisfiable_count: questionSatisfiable, synthesis_status: synthesis.status });
  }

  const diagnosticText = diagnosticLines.join("\n") + "\n";
  const summary = {
    generated_at: new Date().toISOString(),
    diagnostic_artifact: "work/domain-seed/seed-thin-flow-plans.v0.9.gap-diagnostic.jsonl",
    diagnostic_artifact_sha256: sha256(Buffer.from(diagnosticText, "utf8")),
    total_questions: perQuestionSummary.length,
    total_sub_requests: diagnosticLines.length,
    classification_totals: classificationTotals,
    owner_approval_status_of_all_records: "PENDING",
    per_question: perQuestionSummary,
  };

  await writeFile(OUT_DIAGNOSTIC_PATH, diagnosticText, "utf8");
  await writeFile(OUT_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
