// Turn M7 Section 0: records the Owner's final Q18 policy decision as a
// standalone artifact. This is authored directly from the Owner's own
// verbatim Turn M7 instruction (not inferred/paraphrased) -- it never
// edits Turn M6's raw-cell verification or blocker/remediation reports,
// only references their path/SHA. This decision is final for v0.20: no
// new ISSUANCE_AMOUNT Fact, no Calculator PRODUCT extension, no DERIVED
// Fact -- v0.20 renders the two VERIFIED inputs plus an information
// limit; PRODUCT-based derivation is deferred to v0.21 backlog.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const M6_RAW_CELL_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-q18-raw-cell-verification.v0.1.json");
const M6_BLOCKER_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-q18-blocker-remediation.v0.1.json");
const M6_STATUS_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-status-report.v0.1.json");
const CANDIDATE_DECISION_PATH = path.join(RESULTS_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl");
const OUT_PATH = path.join(RESULTS_DIR, "seed-response-q18-owner-policy-decision.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`Q18_POLICY_DECISION_BLOCKED: ${msg}`); }

async function main() {
  const rawCellBytes = await readFile(M6_RAW_CELL_PATH);
  const rawCell = JSON.parse(rawCellBytes.toString("utf8"));
  if (rawCell.finding.branch !== "B") fail("Turn M6 raw-cell verification does not conclude Branch B -- policy decision text assumes Branch B");
  const blockerBytes = await readFile(M6_BLOCKER_PATH);
  const statusBytes = await readFile(M6_STATUS_PATH);
  const candidateDecisionBytes = await readFile(CANDIDATE_DECISION_PATH);

  const decision = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    decision_type: "OWNER_POLICY_DECISION",
    owner_disposition: "APPROVE_INFORMATION_LIMIT_FOR_V020",
    reviewer: "최재완",
    reviewed_at: new Date().toISOString(),
    applies_to: { question_id: "question_seed_v07_18", metric_code: "ISSUANCE_AMOUNT" },
    direct_fact_status: "NOT_DIRECTLY_DISCLOSED_AS_ISSUANCE_AMOUNT",
    calculation_status: "DEFERRED_TO_V021_PRODUCT_CONTRACT",
    v020_response_policy: "VERIFIED_INPUTS_AND_INFORMATION_LIMIT",
    requires_new_fact: false,
    requires_calculator_change: false,
    requires_gold_change: false,
    release_blocking: false,
    rationale: "2,198,873,250원은 major_20240710000577의 원문 라벨상 '자금조달의 목적 - 기타자금(원)'이며 '발행총액'으로 직접 라벨링된 항목이 아님을 Turn M6 raw-cell 재검증에서 확인함(row=2, col=3). 정정 후 발행주식 수 54,495주(같은 문서 row=1, col=3) x 주당 발행가액 40,350원(다른 문서 periodic_20241113000191, row=6, col=5)의 곱과 정확히 일치하지만, 이 일치는 계산 결과이지 원문의 직접 공시가 아니다. v0.20에서는 이 값을 발행총액 Fact로 재분류하지 않고, raw_label을 임의로 '발행총액'으로 만들지 않으며, Calculator PRODUCT 계약을 확장하지 않고, provenance가 불명확한 DERIVED Fact도 만들지 않는다. 대신 검증된 두 입력(주식 수, 주당 발행가액)을 제시하고 발행총액이 원문 직접 공시 항목이 아니라는 정보한계를 명시한다.",
    v021_backlog_item: "Calculator PRODUCT formula contract version bump (shares x price_per_share) -- 이번 Turn 범위 밖, 별도 version bump + 계약 테스트 + Codex 검수 필요.",
    combines_prior_artifacts: [
      { path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-q18-raw-cell-verification.v0.1.json", sha256: sha256(rawCellBytes) },
      { path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-q18-blocker-remediation.v0.1.json", sha256: sha256(blockerBytes) },
      { path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-status-report.v0.1.json", sha256: sha256(statusBytes) },
      { path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl", sha256: sha256(candidateDecisionBytes) },
    ],
    prior_files_modified: false,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ owner_disposition: decision.owner_disposition, applies_to: decision.applies_to, reviewed_at: decision.reviewed_at }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
