// Records the Owner's human adjudication of the 4 real Harness metric_fail
// items (Q07/explicit_fact_value_slots, Q21/explicit_fact_value_slots,
// Q21/temporal_requirements, Q24/explicit_fact_value_slots) at the v0.19
// Seed data freeze point. This is a SEPARATE decision artifact, layered on
// top of -- never replacing -- the raw automatic Harness result:
//
//   work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl / .summary.json
//   still report metric_fail:4 and are NEVER modified by this script.
//
// This script authors NO new Fact, touches NO Gold/Evidence/Coverage/Plan/
// Thin Flow file, and does not change any answer the Runtime produces --
// it is a pure adjudication record explaining WHY each automatic FAIL is
// itself the correct, expected outcome (a real information limit, an
// out-of-corpus source correctly excluded, a confirmed correction
// timeline, or a withheld-then-disclosed counterparty) rather than a
// system defect, per the Owner's (최재완) explicit review.
//
// Outputs (all new, v0.1):
//   work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl
//   work/domain-seed/seed-metric-failure-owner-decision.v0.1.manifest.json
//   work/domain-seed/seed-metric-failure-owner-decision.v0.1.review.md
//   work/domain-seed/seed-metric-failure-adjudication-report.v0.1.json
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = "2026-08-13T19:44:11.000Z"; // real system clock at authoring time
const REVIEWER = "최재완";

const DECISION_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl";
const MANIFEST_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.1.manifest.json";
const REVIEW_MD_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.1.review.md";
const REPORT_PATH = "work/domain-seed/seed-metric-failure-adjudication-report.v0.1.json";

const PINNED_INPUT_PATHS = Object.freeze({
  release_manifest: "domain/releases/seed-release.v0.19.manifest.json",
  release_decision: "domain/releases/seed-release.v0.19.decision.json",
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  harness_result: "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl",
  harness_summary: "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json",
  fact: "work/domain-seed/seed-facts-verified.v0.7.jsonl",
  evidence: "work/domain-seed/seed-evidence-verified.v0.9.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.6.json",
});

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
function jsonl(records) { return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`; }

const RECORDS = [
  {
    question_id: "question_seed_v07_07",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE",
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "EXPECTED_INFORMATION_LIMIT_CONFIRMED",
    verified_meaning:
      "2025년 하반기 공시에서는 앱토즈마(app_tozma)를 포함한 5개 제품의 출시 및 매출 기여 사실만 확인된다. "
      + "앱토즈마 단독의 출시 월과 단독 매출액은 해당 공시 원문 어디에도 개별적으로 공개되어 있지 않다.",
    permitted_sources: "코퍼스 내 해당 반기/분기 공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만.",
    forbidden_inference: "5개 제품 합산 매출이나 다른 제품의 출시월로부터 앱토즈마 단독 출시월·단독 매출을 추정·안분·역산하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: true,
    requires_metric_change: false,
    notes:
      "app_tozma_specific_launch_month_status=NOT_FOUND, app_tozma_standalone_revenue_status=NOT_FOUND가 정답이다 -- "
      + "이는 시스템 결함이 아니라 코퍼스에 실제로 없는 정보를 있다고 지어내지 않은, 올바른 동작이다. "
      + "Gold의 explicit_fact_value_slots 채점 스펙이 이 두 슬롯에 대해 NOT_FOUND를 정답으로 인정하도록 "
      + "추후(이번 작업 범위 밖) 갱신되어야 metric_fail이 자동으로 해소된다. 신규 Fact는 만들지 않는다 -- "
      + "존재하지 않는 값을 만들어내는 것 자체가 근거 없는 환각이기 때문이다.",
  },
  {
    question_id: "question_seed_v07_21",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE",
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "IN_CORPUS_SECONDARY_ATTRIBUTION_CONFIRMED",
    verified_meaning:
      "연장공시(신탁계약 연장을 직접 공시한 문서) 원문 자체는 제공 코퍼스 밖에 있으므로 직접 근거로 사용하지 않는다. "
      + "다만 코퍼스 내부의 해지공시가 그 연장공시의 존재와 2024-03-12~2025-03-12라는 연장기간을 이차적으로 설명하고 있음을 확인했다.",
    permitted_sources: "코퍼스 내부 해지(termination)공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만. 코퍼스 밖 연장공시 원문은 근거로 인용하지 않는다.",
    forbidden_inference: "코퍼스 밖 연장공시의 내용을 직접 읽은 것처럼 인용하거나, extension_source_document_status를 OUTSIDE_CORPUS가 아닌 다른 값으로 바꿔 마치 원문을 확인한 것처럼 표시하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: true,
    requires_metric_change: false,
    notes:
      "extension_source_document_status=OUTSIDE_CORPUS는 유지되어야 하는 올바른 값이다 -- 코퍼스 경계를 정직하게 반영한 것이며 결함이 아니다. "
      + "Gold의 explicit_fact_value_slots 채점 스펙이 이 슬롯에 대해 OUTSIDE_CORPUS를 (코퍼스 내부 이차 자료로 존재·기간이 확인된 상태로) "
      + "정답으로 인정하도록 추후(이번 작업 범위 밖) 갱신되어야 한다. 신규 Fact는 만들지 않는다.",
  },
  {
    question_id: "question_seed_v07_21",
    metric_name: "temporal_requirements",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE",
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "TEMPORAL_SEQUENCE_CONFIRMED",
    verified_meaning:
      "최초 결정 당시 기간은 2023-02-27~2024-02-26이었으며 이때 신한투자증권과의 계약은 실제로 체결되지 않았다. "
      + "정정 공시상 실제 체결된 계약 기간은 2023-03-13~2024-03-12(하나증권)이다. "
      + "해지공시상 신탁계약 연장 기간은 2024-03-12~2025-03-12이다. "
      + "코퍼스 내부 문서만으로 '최초 결정 -> 정정(실제 계약) -> 해지공시상 연장'의 날짜 흐름이 서로 정합적으로 이어짐을 확인했다.",
    permitted_sources: "코퍼스 내부 최초 결정공시, 정정공시, 해지공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 날짜만.",
    forbidden_inference: "신한투자증권과의 미체결 최초 결정 기간을 실제 이행된 계약 기간처럼 취급하거나, 정정 전/후 날짜를 뒤섞어 하나의 연속 기간으로 재구성하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: true,
    requires_metric_change: false,
    notes:
      "original_decision_period_start/end 및 extension_period_end 등 일부 슬롯의 자동 FAIL은 Gold가 기대하는 날짜와 "
      + "실제 정정·해지 이력상 올바른 날짜가 다르기 때문으로 확인된다. 코퍼스 문서 자체의 날짜 흐름(최초 결정 -> 정정 실제계약 -> 해지공시 연장)은 "
      + "정합적이며 시스템 산출값이 아니라 Gold의 기대값 갱신이 필요한 사안이다(이번 작업 범위 밖). 신규 Fact는 만들지 않는다.",
  },
  {
    question_id: "question_seed_v07_24",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE",
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "WITHHELD_DISCLOSURE_CLASSIFICATION_CONFIRMED",
    verified_meaning:
      "정정 전 공시의 거래 상대방은 '글로벌 대형기업'으로 유보(WITHHELD)되어 있었다. "
      + "정정 후 공시에서 그 상대방이 테슬라(Tesla, Inc.)로 공개되었다. "
      + "금액·기간·비율 등 계약의 다른 조건은 정정 전후로 변경되지 않았다 -- 이는 계약조건 변경이 아니라 "
      + "이전에 유보되었던 상대방명이 뒤늦게 공개된 사건이다. 의미 판정: WITHHELD_COUNTERPARTY_DISCLOSURE_NOT_TERM_CHANGE.",
    permitted_sources: "코퍼스 내부 정정 전/후 공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만.",
    forbidden_inference: "상대방명 공개를 계약금액·기간·비율이 변경된 정정(계약조건 변경)으로 재분류하거나, '테슬라'라는 이름을 이 문서 밖의 다른 근거로 보강하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: true,
    requires_metric_change: false,
    notes:
      "counterparty_before/correction_nature 등 슬롯의 자동 FAIL은 Gold가 이 정정을 '계약조건 변경'으로 기대하기 때문으로 보인다. "
      + "실제로는 WITHHELD_COUNTERPARTY_DISCLOSURE_NOT_TERM_CHANGE(유보 상대방 공개, 조건 불변)가 올바른 의미 판정이다. "
      + "Gold의 correction_nature 기대값과 counterparty_before 채점 방식이 이 분류를 반영하도록 추후(이번 작업 범위 밖) 갱신되어야 한다. "
      + "신규 Fact는 만들지 않는다.",
  },
];

async function main() {
  for (const record of RECORDS) {
    if (record.owner_disposition !== "APPROVE") throw new Error(`unexpected disposition for ${record.question_id}/${record.metric_name}`);
    if (record.requires_new_fact !== false) throw new Error(`requires_new_fact must be false for ${record.question_id}/${record.metric_name}`);
  }

  const decisionText = jsonl(RECORDS);
  await writeFile(path.join(REPO, DECISION_PATH), decisionText, "utf8");
  const decisionSha256 = sha256(Buffer.from(decisionText, "utf8"));

  const pinnedInputs = {};
  for (const [key, relativePath] of Object.entries(PINNED_INPUT_PATHS)) {
    const bytes = await readAbs(relativePath);
    pinnedInputs[key] = { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
  }

  const harnessSummary = JSON.parse((await readAbs(PINNED_INPUT_PATHS.harness_summary)).toString("utf8"));
  if (harnessSummary.metric_fail !== 4) throw new Error(`expected raw harness metric_fail=4, found ${harnessSummary.metric_fail}`);
  if (harnessSummary.review_required !== 17) throw new Error(`expected raw harness review_required=17, found ${harnessSummary.review_required}`);

  const manifest = {
    schema_version: "0.1.0",
    artifact_id: "seed-metric-failure-owner-decision-v0.1",
    generated_at: REVIEWED_AT,
    reviewer: REVIEWER,
    scope:
      "v0.19 Seed 데이터 동결점(Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6)에서 관측된 "
      + "실제 Harness metric_fail 4건(Q07/explicit_fact_value_slots, Q21/explicit_fact_value_slots, "
      + "Q21/temporal_requirements, Q24/explicit_fact_value_slots)에 대한 사람 판정. Gold/Fact/Evidence/Coverage/"
      + "Plan/Thin Flow는 이 artifact가 생성되는 과정에서 전혀 수정되지 않았다. 신규 Fact도 생성되지 않았다.",
    decision_artifact: { path: DECISION_PATH, sha256: decisionSha256, record_count: RECORDS.length },
    pinned_inputs: pinnedInputs,
    raw_harness_metric_fail: harnessSummary.metric_fail,
    raw_harness_review_required: harnessSummary.review_required,
  };
  await writeFile(path.join(REPO, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const reviewMd = `# Seed Metric-Failure Owner Adjudication v0.1

**Reviewer:** ${REVIEWER}
**Reviewed at:** ${REVIEWED_AT}
**Data freeze point:** v0.19 (Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6 -- unmodified)
**Raw Harness metric_fail (unmodified, still on disk):** ${harnessSummary.metric_fail}
**Raw Harness review_required (unmodified, still on disk):** ${harnessSummary.review_required}

이 문서는 \`${DECISION_PATH}\`에 기록된 4건의 사람 판정을 사람이 읽기 좋은 형태로 정리한 것이다.
원본 자동 Harness 결과(\`${PINNED_INPUT_PATHS.harness_result}\` / \`${PINNED_INPUT_PATHS.harness_summary}\`)는
이 문서를 만드는 과정에서 전혀 수정되지 않았다.

${RECORDS.map((r, i) => `## ${i + 1}. ${r.question_id} / ${r.metric_name}

- **원시 자동 상태:** ${r.original_automatic_status}
- **Owner 판정:** ${r.owner_disposition}
- **판정 유형:** ${r.adjudication_type}
- **확인된 의미:** ${r.verified_meaning}
- **허용 근거 범위:** ${r.permitted_sources}
- **금지된 추론:** ${r.forbidden_inference}
- **신규 Fact 필요:** ${r.requires_new_fact}
- **Gold 변경 필요:** ${r.requires_gold_change} (이번 작업 범위 밖, 미실행)
- **Metric 로직 변경 필요:** ${r.requires_metric_change}
- **비고:** ${r.notes}
`).join("\n")}

## 결합 결과

| | 값 |
|---|---|
| raw_metric_fail (Harness, 불변) | 4 |
| owner_adjudicated | 4 |
| unadjudicated_metric_fail | 0 |

원시 결과는 절대 PASS로 덮어쓰지 않았다. 이 4건은 여전히 자동 채점 기준으로는 FAIL이며,
동시에 사람이 그 FAIL이 "코퍼스 정보 한계/코퍼스 범위/정정 이력/유보 공개"를 정확히 반영한
기대된 결과임을 확인했다는 별도 판정이 병기된다.

## Release Gate 표현

- automatic metric gate (raw): BLOCKED (metric_fail=4, 원시 결과 보존)
- metric adjudication gate: COMPLETE (4/4 사람 판정 완료)
- manual review gate: BLOCKED (REVIEW_REQUIRED 17건 미해결)
- deployment gate: BLOCKED
- **overall Release Gate: BLOCKED**
`;
  await writeFile(path.join(REPO, REVIEW_MD_PATH), reviewMd, "utf8");

  const report = {
    schema_version: "0.1.0",
    report_type: "METRIC_FAILURE_ADJUDICATION_REPORT",
    generated_at: REVIEWED_AT,
    data_freeze_point: "v0.19",
    raw_metric_fail: harnessSummary.metric_fail,
    owner_adjudicated: RECORDS.length,
    unadjudicated_metric_fail: harnessSummary.metric_fail - RECORDS.length,
    raw_results_modified: false,
    raw_harness_result_path: PINNED_INPUT_PATHS.harness_result,
    raw_harness_summary_path: PINNED_INPUT_PATHS.harness_summary,
    adjudication_decision_path: DECISION_PATH,
    adjudication_decision_sha256: decisionSha256,
    adjudicated_items: RECORDS.map((r) => ({
      question_id: r.question_id,
      metric_name: r.metric_name,
      original_automatic_status: r.original_automatic_status,
      owner_disposition: r.owner_disposition,
      adjudication_type: r.adjudication_type,
      requires_gold_change: r.requires_gold_change,
      requires_metric_change: r.requires_metric_change,
    })),
    release_gate: {
      automatic_metric_gate_raw: { status: "BLOCKED", metric_fail: harnessSummary.metric_fail, note: "raw Harness result, never modified" },
      metric_adjudication_gate: { status: "COMPLETE", adjudicated: RECORDS.length, unadjudicated: harnessSummary.metric_fail - RECORDS.length },
      manual_review_gate: { status: "BLOCKED", review_required: harnessSummary.review_required },
      deployment_gate: { status: "BLOCKED" },
      overall_release_gate: "BLOCKED",
      note:
        "metric adjudication gate가 4/4로 완료되었다고 해서 전체 Release Gate나 Deployment Gate가 열리지 않는다 -- "
        + "REVIEW_REQUIRED 17건이 여전히 미해결이며, Gold/Fact/Evidence/Coverage/Plan/Thin Flow 어느 것도 이 adjudication으로 변경되지 않았다.",
    },
  };
  await writeFile(path.join(REPO, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    decision_path: DECISION_PATH, decision_sha256: decisionSha256, record_count: RECORDS.length,
    manifest_path: MANIFEST_PATH, review_md_path: REVIEW_MD_PATH, report_path: REPORT_PATH,
    raw_metric_fail: harnessSummary.metric_fail, owner_adjudicated: RECORDS.length,
    unadjudicated_metric_fail: harnessSummary.metric_fail - RECORDS.length,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
