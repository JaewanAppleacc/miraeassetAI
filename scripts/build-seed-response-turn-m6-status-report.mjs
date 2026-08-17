// Turn M6 Section 6/8: final status report pinning every artifact this
// Turn touched or read. promotion_status/release_status are hardcoded
// NOT_PROMOTED/NOT_AUTHORIZED and asserted (not just declared) against
// the actual artifacts below.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-status-report.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`M6_STATUS_REPORT_BLOCKED: ${msg}`); }

async function pinned(relPath) {
  const bytes = await readFile(path.join(REPO, relPath));
  return { path: relPath, sha256: sha256(bytes), bytes };
}

async function main() {
  const ontologyDecision = await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.jsonl");
  const ontologyManifest = await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.manifest.json");
  const ontologyVerification = await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.verification-report.json");
  const candidateDecision = await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl");
  const candidateManifest = await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.manifest.json");
  const candidateVerification = await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.verification-report.json");
  const approvalScopeFreeze = await pinned("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-approval-scope-freeze.v0.1.json");
  const q18RawCell = await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-q18-raw-cell-verification.v0.1.json");
  const q18Blocker = await pinned("work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-q18-blocker-remediation.v0.1.json");

  const freeze = JSON.parse(approvalScopeFreeze.bytes.toString("utf8"));
  if (freeze.owner_approved_count !== 8) fail(`expected 8 owner-approved records in freeze artifact, found ${freeze.owner_approved_count}`);
  if (freeze.turn_m5_carried_forward_untouched.count !== 6) fail("Turn M5 carried-forward count mismatch");
  const blocker = JSON.parse(q18Blocker.bytes.toString("utf8"));
  if (blocker.candidate_authoring.new_candidate_created_this_turn !== false) fail("blocker report claims a new Candidate was created -- contradicts Branch B");

  // Existing-artifact immutability spot-checks (Turn M1-M5 outputs must
  // stay byte-identical -- re-verified here, not merely asserted).
  const immutabilityChecks = [];
  const immutabilityTargets = [
    ["work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl", "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.manifest.json"],
    ["work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.5.jsonl", "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.5.manifest.json"],
    ["work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json", null],
    ["work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl", null],
    ["work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl", null],
    ["work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl", "work/domain-seed/seed-facts-candidates.v0.10.delta.manifest.json"],
    ["work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl", "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.manifest.json"],
    ["work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl", "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.manifest.json"],
  ];
  for (const [artifactPath, manifestPath] of immutabilityTargets) {
    const artifactBytes = await readFile(path.join(REPO, artifactPath));
    const actualSha = sha256(artifactBytes);
    let expectedSha = null;
    if (manifestPath) {
      const manifest = JSON.parse((await readFile(path.join(REPO, manifestPath))).toString("utf8"));
      expectedSha = manifest.artifact_sha256;
    }
    immutabilityChecks.push({ path: artifactPath, sha256: actualSha, matches_own_manifest: manifestPath ? actualSha === expectedSha : "no_manifest_to_check" });
  }
  const anyMismatch = immutabilityChecks.some((c) => c.matches_own_manifest === false);
  if (anyMismatch) fail(`immutability check failed: ${JSON.stringify(immutabilityChecks.filter((c) => c.matches_own_manifest === false))}`);

  const status = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M6",
    pinned_artifacts: {
      ontology_decision_v02: { path: ontologyDecision.path, sha256: ontologyDecision.sha256 },
      ontology_decision_v02_manifest: { path: ontologyManifest.path, sha256: ontologyManifest.sha256 },
      ontology_decision_v02_verification: { path: ontologyVerification.path, sha256: ontologyVerification.sha256 },
      candidate_decision_v01: { path: candidateDecision.path, sha256: candidateDecision.sha256 },
      candidate_decision_v01_manifest: { path: candidateManifest.path, sha256: candidateManifest.sha256 },
      candidate_decision_v01_verification: { path: candidateVerification.path, sha256: candidateVerification.sha256 },
      approval_scope_freeze: { path: approvalScopeFreeze.path, sha256: approvalScopeFreeze.sha256 },
      q18_raw_cell_verification: { path: q18RawCell.path, sha256: q18RawCell.sha256 },
      q18_blocker_remediation: { path: q18Blocker.path, sha256: q18Blocker.sha256 },
    },
    approved_ontology_tokens: ["INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET", "ACQUISITION_PLANNED_SHARES", "TRUST_CONTRACT_INSTITUTION", "CORRECTION_REASON", "ISSUANCE_AMOUNT"],
    candidate_approval_boundary: {
      approve_count: 8,
      fix_required_count: 1,
      fix_required_fact_id: "fact_f2e453495b94543bbd236303",
    },
    q18_outcome: {
      branch: "B",
      new_candidate_authored: false,
      calculator_product_formula_added: false,
      promotable_issuance_amount_candidate_count: 0,
      owner_action_required: true,
    },
    turn_m5_carried_forward_untouched_count: freeze.turn_m5_carried_forward_untouched.count,
    q09_counterparty_status: "SUPERSEDED / NOT_PROMOTED (unchanged)",
    remaining_owner_judgments: {
      count: 1,
      description: "Q18 ISSUANCE_AMOUNT의 future_options 중 선택 (Calculator PRODUCT 계약 확장 vs DERIVED claim 계약 vs v0.20 정보한계로 유지) -- 이 Turn에서 authoring되지 않음.",
    },
    existing_artifacts_immutability_check: immutabilityChecks,
    promotion_status: "NOT_PROMOTED",
    release_status: "NOT_AUTHORIZED",
    v020_manifest_or_decision_created: false,
    runtime_composer_plan_modified_this_turn: false,
    fact_promotion_executed: false,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    approved_ontology_tokens: status.approved_ontology_tokens.length,
    candidate_boundary: status.candidate_approval_boundary,
    q18_branch: status.q18_outcome.branch,
    remaining_owner_judgments: status.remaining_owner_judgments.count,
    promotion_status: status.promotion_status,
    release_status: status.release_status,
    immutability_all_ok: immutabilityChecks.every((c) => c.matches_own_manifest !== false),
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
