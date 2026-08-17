// Runs all 25 real Seed questions through the REAL Runtime services
// (the same release-authorized VERIFIED Fact/Event/Evidence stores the
// v0.19 production runtime uses -- v0.19 itself is never modified, and
// no new release is created here) with the Plan v0.8 CANDIDATE's
// sub_requests substituted in, in-process (no HTTP server), to determine
// each sub_request's REAL COVERED/EXPLICIT_INFORMATION_LIMIT/MISSING
// status against the actual corpus data -- not a guess. Produces a
// review packet classifying every sub_request as SATISFIABLE (COVERED or
// EXPLICIT_INFORMATION_LIMIT with real data) or DATA_GAP (MISSING against
// real data), with a short rationale, and leaves every Owner-approval
// field PENDING (never self-approved). Q17/Q22 are additionally cross-
// checked against the existing Owner decision v0.2 for consistency.
//
// This is a SANDBOX-only audit script: it reads the v0.6-pinned,
// release-authorized structured stores (same ones the real v0.19
// production runtime reads) but resolves its PLAN from the v0.8
// candidate plan store instead of the release-pinned v0.6 plan path --
// v0.8 is not part of any release binding, so this never touches
// configured-seed-runtime.mjs or creates a new release.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSeedRuntimeServiceAdapters } from "../domain/adapters/seed-runtime-service-adapters.mjs";
import { createSeedQuestionPlanStore } from "../domain/adapters/seed-question-plan-store.mjs";
import { createThinStructuredFlow } from "../domain/flows/thin-structured-flow.mjs";
import { runAgentFlow } from "../domain/runtime/agent-runtime.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const PLAN_V06_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const PLAN_V08_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl");
const PLAN_V08_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.manifest.json");
const OWNER_DECISION_PATH = path.join(REPO, "work/domain-seed/seed-response-owner-decision.v0.2.jsonl");
const STRUCTURED_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-structured-artifacts.v0.6.manifest.json");
const CANONICAL_RELEASE_MANIFEST_PATH = path.join(REPO, "domain/releases/seed-release.v0.19.manifest.json");
const OUT_REVIEW_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.semantic-review.pending.jsonl");
const OUT_REPORT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.semantic-review.summary.json");

const LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 200, timeoutMs: 280000 });

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// Short, generic rationale text per intent -- describes WHY this kind of
// sub_request exists for this question, derived only from the question's
// own text/slot shape (never the answer value).
function rationale(subRequest, question) {
  const slotList = subRequest.required_slot_names.join(", ") || "(no slot-bound output; capability-checked only)";
  return `intent=${subRequest.intent}; grouped slots=[${slotList}]; derived from the question's own ask, not from Gold's expected_answer.`;
}

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
  const v08Store = await createSeedQuestionPlanStore({ planPath: PLAN_V08_PATH, manifestPath: PLAN_V08_MANIFEST_PATH });
  if (context.corpus_snapshot_id !== v08Store.context.corpus_snapshot_id || context.fact_coverage_snapshot_id !== v08Store.context.fact_coverage_snapshot_id) {
    throw new Error("v0.8 candidate plan snapshot does not match the release-authorized runtime snapshot");
  }

  const flow = createThinStructuredFlow();
  const reviewLines = [];
  const perQuestionSummary = [];

  for (const g of gold) {
    const plan = v08Store.resolve(g.question_id, g.question);
    if (!plan) throw new Error(`${g.question_id}: v0.8 candidate plan did not resolve for the real Gold question text`);
    const outcome = await runAgentFlow(
      flow,
      { question: g.question, question_id: g.question_id, plan: { ...plan, context } },
      { ...context, as_of_date: plan.as_of_date, signal: undefined },
      LIMITS,
      serviceAdapters,
    );
    const synthesis = outcome.final_response.think_trace.validation.synthesis;
    const coverageBySubRequestId = new Map((synthesis.covered_sub_requests ?? []).map((r) => [r.sub_request_id, r.status]));

    const relatedOwnerItems = ownerDecisions.filter((d) => d.question_id === g.question_id);
    for (const subRequest of plan.sub_requests) {
      const status = coverageBySubRequestId.get(subRequest.sub_request_id) ?? "MISSING";
      const satisfiable = status === "COVERED" || status === "EXPLICIT_INFORMATION_LIMIT";
      const record = {
        schema_version: "0.1.0",
        question_id: g.question_id,
        question: g.question,
        sub_request_id: subRequest.sub_request_id,
        intent: subRequest.intent,
        required_slot_names: subRequest.required_slot_names,
        required_event_types: subRequest.required_event_types,
        required_output_kinds: subRequest.required_output_kinds,
        required_capabilities: subRequest.required_capabilities,
        rationale: rationale(subRequest, g.question),
        connected_slots: subRequest.required_slot_names,
        connected_output_bindings: subRequest.required_output_bindings,
        connected_capabilities: subRequest.required_capabilities,
        runtime_coverage_status: status,
        satisfiability: satisfiable ? "SATISFIABLE" : "DATA_GAP",
        owner_related_review_items: relatedOwnerItems.map((d) => d.review_item_id),
        owner_approval_status: "PENDING",
        owner_reviewer: null,
        owner_reviewed_at: null,
        owner_notes: null,
      };
      reviewLines.push(JSON.stringify(record));
    }

    perQuestionSummary.push({
      question_id: g.question_id,
      sub_request_count: plan.sub_requests.length,
      satisfiable_count: plan.sub_requests.filter((sr) => {
        const s = coverageBySubRequestId.get(sr.sub_request_id) ?? "MISSING";
        return s === "COVERED" || s === "EXPLICIT_INFORMATION_LIMIT";
      }).length,
      data_gap_count: plan.sub_requests.filter((sr) => (coverageBySubRequestId.get(sr.sub_request_id) ?? "MISSING") === "MISSING").length,
      synthesis_status: synthesis.status,
    });
  }

  // Q17/Q22 cross-check against the existing Owner decision -- these must
  // not silently contradict a real human judgment already on record.
  const reviewRecords = reviewLines.map((line) => JSON.parse(line));
  const crossCheck = [];
  for (const questionId of ["question_seed_v07_17", "question_seed_v07_22"]) {
    const ownerItems = ownerDecisions.filter((d) => d.question_id === questionId);
    const ownerRequiredCapabilities = new Set(ownerItems.flatMap((d) => d.required_response_capabilities ?? []));
    const auditedRequiredCapabilities = new Set(
      reviewRecords.filter((r) => r.question_id === questionId).flatMap((r) => r.required_capabilities)
    );
    const missingFromAudit = [...ownerRequiredCapabilities].filter((c) => !auditedRequiredCapabilities.has(c));
    crossCheck.push({
      question_id: questionId,
      owner_required_capabilities: [...ownerRequiredCapabilities],
      v08_audited_capabilities_union: [...auditedRequiredCapabilities],
      owner_capabilities_not_covered_by_v08_sub_requests: missingFromAudit,
      consistent: missingFromAudit.length === 0,
    });
  }

  const reviewText = reviewLines.join("\n") + "\n";
  const totalSubRequests = perQuestionSummary.reduce((sum, entry) => sum + entry.sub_request_count, 0);
  const totalSatisfiable = perQuestionSummary.reduce((sum, entry) => sum + entry.satisfiable_count, 0);
  const totalDataGap = perQuestionSummary.reduce((sum, entry) => sum + entry.data_gap_count, 0);
  const summary = {
    generated_at: new Date().toISOString(),
    review_artifact: "work/domain-seed/seed-thin-flow-plans.v0.8.semantic-review.pending.jsonl",
    review_artifact_sha256: sha256(Buffer.from(reviewText, "utf8")),
    total_questions: perQuestionSummary.length,
    total_sub_requests: totalSubRequests,
    satisfiable_count: totalSatisfiable,
    data_gap_count: totalDataGap,
    owner_approval_status_of_all_records: "PENDING",
    q17_q22_owner_cross_check: crossCheck,
    per_question: perQuestionSummary,
  };

  await writeFile(OUT_REVIEW_PATH, reviewText, "utf8");
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
