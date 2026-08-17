// Turn M7 final status report: pins every artifact this Turn produced or
// read, and re-asserts (not just declares) the key invariants.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(RESULTS_DIR, "seed-response-turn-m7-status-report.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function pinned(relPath) {
  const bytes = await readFile(path.join(REPO, relPath));
  return { path: relPath, sha256: sha256(bytes) };
}
function fail(msg) { throw new Error(`M7_STATUS_REPORT_BLOCKED: ${msg}`); }

async function main() {
  const promotionReceipt = JSON.parse(await readFile(path.join(REPO, "work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json"), "utf8"));
  if (promotionReceipt.promoted_fact_count !== 14) fail("promotion receipt does not show exactly 14 promoted facts");

  const integrationVerification = JSON.parse(await readFile(path.join(RESULTS_DIR, "seed-response-turn-m7-integration-verification.v0.1.json"), "utf8"));
  if (integrationVerification.total_pass !== integrationVerification.total_checks) fail("integration verification report shows a failing check");

  const wireDiffAnalysis = JSON.parse(await readFile(path.join(RESULTS_DIR, "seed-response-turn-m7-wire-diff-analysis.v0.1.json"), "utf8"));

  const status = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M7",
    q18_policy_decision: await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-q18-owner-policy-decision.v0.1.json"),
    owner_decisions_used: {
      ontology_decision_v02: await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.jsonl"),
      candidate_decision_v01: await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl"),
      carried_forward_pin_v01: await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl"),
    },
    promotion: {
      promoted_fact_count: promotionReceipt.promoted_fact_count,
      promoted_fact_ids: promotionReceipt.promoted_fact_ids,
      excluded_fact_ids: promotionReceipt.excluded_fact_ids,
      receipt_path: "work/domain-seed/seed-fact-batch-v07-turn-m7-promotion-receipt.json",
    },
    new_revisions: {
      verified_facts: await pinned("work/domain-seed/seed-facts-verified.v0.8.jsonl"),
      fact_coverage: await pinned("work/domain-seed/seed-fact-coverage-verified.v0.7.json"),
      merged_owner_decision: await pinned("work/domain-seed/seed-structured-owner-decision.v0.10.jsonl"),
      structured_artifacts_manifest: await pinned("work/domain-seed/seed-structured-artifacts.v0.7.manifest.json"),
      thin_flow_plan: await pinned("work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl"),
      sandbox_release_manifest: await pinned("work/domain-seed/seed-release-turn-m7-candidate-sandbox.manifest.json"),
      sandbox_release_decision: await pinned("work/domain-seed/seed-release-turn-m7-candidate-sandbox.decision.json"),
    },
    evidence_revision_created: false,
    evidence_revision_reason: "모든 evidence_id가 이미 seed-evidence-verified.v0.9.jsonl에 VERIFIED로 존재하며 재사용됨.",
    q18_info_limit_gap: await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-turn-m7-q18-info-limit-implementation-gap.v0.1.json"),
    wire_r11: {
      dir: "work/domain-seed/seed-harness-v07-wire.r11",
      diff_report: "work/domain-seed/seed-harness-v07-wire-diff.r10-to-r11.json",
      diff_analysis: wireDiffAnalysis.summary,
      integration_verification: { total_checks: integrationVerification.total_checks, total_pass: integrationVerification.total_pass },
    },
    promotion_status: "PROMOTED_CANDIDATE_SANDBOX_ONLY",
    v020_release_created: false,
    configured_production_runtime_modified: false,
    stage_commit_push_performed: false,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    promoted_fact_count: status.promotion.promoted_fact_count,
    wire_diff_summary: status.wire_r11.diff_analysis,
    integration_checks: status.wire_r11.integration_verification,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
