// v0.2 correction of the metric-failure owner adjudication
// (work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl,
// preserved untouched as audit history). Cross-checking the real Gold
// (v0.17) against the real v0.5-profile Harness HTTP responses found that
// v0.1's judgment fields were wrong in a specific way: Gold ALREADY
// carries the correct expected values (NOT_FOUND for the two Aptos-only
// slots in Q07, OUTSIDE_CORPUS for Q21's extension_source_document_status,
// the correct date sequence for Q21's temporal fields, and the correct
// WITHHELD_INFO_DISCLOSURE_NOT_TERM_CHANGE semantics for Q24) -- so the
// automatic FAIL is not a Gold-vs-reality mismatch at all. It is the
// CURRENT AGENT RESPONSE that is incomplete: it never states these
// already-correct data points. v0.1 incorrectly recorded
// requires_gold_change:true; that was wrong. v0.2 corrects this: Gold and
// the metric logic both need NO change, the underlying data meaning is
// confirmed correct, but the response text itself must be extended to
// actually say these things before metric_fail can resolve.
//
// This script authors NO new Fact, touches NO Gold/Fact/Evidence/Coverage/
// Plan/Thin Flow/Runtime file, and adds no per-question response template
// -- it is a pure, separate decision-artifact revision. v0.1 stays exactly
// as it was.
//
// Outputs (all new, v0.2):
//   work/domain-seed/seed-metric-failure-owner-decision.v0.2.jsonl
//   work/domain-seed/seed-metric-failure-owner-decision.v0.2.manifest.json
//   work/domain-seed/seed-metric-failure-owner-decision.v0.2.review.md
//   work/domain-seed/seed-metric-failure-adjudication-report.v0.2.json
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWED_AT = "2026-08-13T19:53:05.000Z"; // real system clock at authoring time
const REVIEWER = "최재완";

const DECISION_V01_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.1.jsonl";
const DECISION_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.2.jsonl";
const MANIFEST_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.2.manifest.json";
const REVIEW_MD_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.2.review.md";
const REPORT_PATH = "work/domain-seed/seed-metric-failure-adjudication-report.v0.2.json";

const PINNED_INPUT_PATHS = Object.freeze({
  release_manifest: "domain/releases/seed-release.v0.19.manifest.json",
  release_decision: "domain/releases/seed-release.v0.19.decision.json",
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
  harness_result: "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl",
  harness_summary: "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json",
  fact: "work/domain-seed/seed-facts-verified.v0.7.jsonl",
  evidence: "work/domain-seed/seed-evidence-verified.v0.9.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-verified.v0.6.json",
  prior_decision_v01: DECISION_V01_PATH,
});

const OWNER_DISPOSITION_NOTE =
  "이 owner_disposition은 Gold/원문의 의미 판정(data semantics)에 대한 승인이다. "
  + "현재 Agent 응답(HTTP 답변)을 PASS로 승인한다는 뜻이 아니다 -- 응답은 여전히 불완전하며 "
  + "metric_fail은 response 구현이 완료되기 전까지 계속 유효하다.";

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
function jsonl(records) { return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`; }

const RECORDS = [
  {
    question_id: "question_seed_v07_07",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE_DATA_SEMANTICS_ONLY",
    owner_disposition_note: OWNER_DISPOSITION_NOTE,
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "EXPECTED_INFORMATION_LIMIT_CONFIRMED",
    verified_meaning:
      "Gold는 이미 app_tozma_specific_launch_month_status와 app_tozma_standalone_revenue_status를 NOT_FOUND로 정확히 "
      + "가지고 있다 -- 앱토즈마 단독 출시월·단독 매출은 공시 원문에 없다는 사실이 Gold에 이미 올바르게 반영되어 있다.",
    permitted_sources: "코퍼스 내 해당 반기/분기 공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만.",
    forbidden_inference: "5개 제품 합산 매출이나 다른 제품의 출시월로부터 앱토즈마 단독 출시월·단독 매출을 추정·안분·역산하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: false,
    requires_metric_change: false,
    data_semantics_confirmed: true,
    current_response_complete: false,
    metric_failure_valid: true,
    resolution_status: "RESPONSE_IMPLEMENTATION_REQUIRED",
    required_response_change:
      "현재 Agent 응답은 이 정보한계를 누락한다. app_tozma_specific_launch_month_status와 "
      + "app_tozma_standalone_revenue_status 두 항목이 확인되지 않았다(NOT_FOUND)는 사실을 응답에 명시해야 한다.",
    notes:
      "v0.1은 이 항목에 requires_gold_change:true를 잘못 기록했다. 실제 Gold와 v0.5 프로파일 HTTP 응답을 대조한 결과, "
      + "Gold는 이미 정답을 가지고 있고 문제는 현재 응답이 그 정보한계를 말하지 않는다는 데 있다. Gold/Metric 로직은 "
      + "변경할 필요가 없다 -- 필요한 것은 응답 구현이다. 신규 Fact는 만들지 않는다.",
  },
  {
    question_id: "question_seed_v07_21",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE_DATA_SEMANTICS_ONLY",
    owner_disposition_note: OWNER_DISPOSITION_NOTE,
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "IN_CORPUS_SECONDARY_ATTRIBUTION_CONFIRMED",
    verified_meaning:
      "Gold는 이미 extension_source_document_status=OUTSIDE_CORPUS를 정확히 가지고 있다 -- 연장공시 원문이 "
      + "코퍼스 밖에 있다는 사실과, 그 존재·연장기간이 코퍼스 내부 해지공시를 통해 이차적으로 확인된다는 점이 "
      + "Gold에 이미 올바르게 반영되어 있다.",
    permitted_sources: "코퍼스 내부 해지(termination)공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만. 코퍼스 밖 연장공시 원문은 근거로 인용하지 않는다.",
    forbidden_inference: "코퍼스 밖 연장공시의 내용을 직접 읽은 것처럼 인용하거나, extension_source_document_status를 OUTSIDE_CORPUS가 아닌 다른 값으로 바꿔 마치 원문을 확인한 것처럼 표시하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: false,
    requires_metric_change: false,
    data_semantics_confirmed: true,
    current_response_complete: false,
    metric_failure_valid: true,
    resolution_status: "RESPONSE_IMPLEMENTATION_REQUIRED",
    required_response_change:
      "현재 응답은 연장공시 원문이 코퍼스 밖에 있으며 해지공시를 통해 그 존재와 연장기간을 확인했다는 귀속 설명"
      + "(secondary attribution)을 누락한다. 이 설명을 응답에 포함해야 한다.",
    notes:
      "v0.1은 이 항목에 requires_gold_change:true를 잘못 기록했다. Gold는 이미 정확하다. 필요한 것은 "
      + "코퍼스 밖 원문을 직접 근거로 쓰지 않으면서도 그 존재와 기간을 해지공시로 귀속시켜 설명하는 응답 구현이다. "
      + "신규 Fact는 만들지 않는다.",
  },
  {
    question_id: "question_seed_v07_21",
    metric_name: "temporal_requirements",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE_DATA_SEMANTICS_ONLY",
    owner_disposition_note: OWNER_DISPOSITION_NOTE,
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "TEMPORAL_SEQUENCE_CONFIRMED",
    verified_meaning:
      "Gold는 이미 최초 결정(2023-02-27~2024-02-26, 신한투자증권 미체결) -> 정정 실제 계약(2023-03-13~2024-03-12, 하나증권) "
      + "-> 해지공시상 연장(2024-03-12~2025-03-12) -> 해지 -> 소각으로 이어지는 날짜 흐름을 정확히 가지고 있다.",
    permitted_sources: "코퍼스 내부 최초 결정공시, 정정공시, 해지공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 날짜만.",
    forbidden_inference: "신한투자증권과의 미체결 최초 결정 기간을 실제 이행된 계약 기간처럼 취급하거나, 정정 전/후 날짜를 뒤섞어 하나의 연속 기간으로 재구성하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: false,
    requires_metric_change: false,
    data_semantics_confirmed: true,
    current_response_complete: false,
    metric_failure_valid: true,
    resolution_status: "RESPONSE_IMPLEMENTATION_REQUIRED",
    required_response_change:
      "현재 응답은 최초 결정 -> 정정(실제 계약) -> 연장 -> 해지 -> 소각 순서를 완전하게 설명하지 않는다. "
      + "이 다섯 단계 흐름을 응답에서 완전하게 설명해야 한다.",
    notes:
      "v0.1은 이 항목에 requires_gold_change:true를 잘못 기록했다. Gold의 날짜 흐름은 이미 정확하다. 필요한 것은 "
      + "다섯 단계(최초 결정/정정 실제 계약/연장/해지/소각) 전체를 응답에서 빠짐없이 설명하는 응답 구현이다. "
      + "신규 Fact는 만들지 않는다.",
  },
  {
    question_id: "question_seed_v07_24",
    metric_name: "explicit_fact_value_slots",
    original_automatic_status: "FAIL",
    owner_disposition: "APPROVE_DATA_SEMANTICS_ONLY",
    owner_disposition_note: OWNER_DISPOSITION_NOTE,
    reviewer: REVIEWER,
    reviewed_at: REVIEWED_AT,
    adjudication_type: "WITHHELD_DISCLOSURE_CLASSIFICATION_CONFIRMED",
    verified_meaning:
      "Gold의 WITHHELD_INFO_DISCLOSURE_NOT_TERM_CHANGE 분류는 의미상 정확하다 -- 정정 전 '글로벌 대형기업'(유보)에서 "
      + "정정 후 '테슬라(Tesla, Inc.)'로 상대방명이 공개되었을 뿐, 금액·기간·비율 등 계약조건은 변경되지 않았다.",
    permitted_sources: "코퍼스 내부 정정 전/후 공시 원문 및 현재 VERIFIED Fact/Evidence 집합(Fact v0.7 / Evidence v0.9)에 실제로 존재하는 문구만.",
    forbidden_inference: "상대방명 공개를 계약금액·기간·비율이 변경된 정정(계약조건 변경)으로 재분류하거나, '테슬라'라는 이름을 이 문서 밖의 다른 근거로 보강하지 않는다.",
    requires_new_fact: false,
    requires_gold_change: false,
    requires_metric_change: false,
    data_semantics_confirmed: true,
    current_response_complete: false,
    metric_failure_valid: true,
    resolution_status: "RESPONSE_IMPLEMENTATION_REQUIRED",
    required_response_change:
      "현재 응답은 정정 전후 상대방 값(글로벌 대형기업 -> 테슬라)만 나열할 뿐, 금액·기간·비율이 변경되지 않았다는 사실과 "
      + "'유보 정보 공개일 뿐 계약조건 변경이 아니다'라는 결론을 누락한다. 이 두 가지를 응답에 포함해야 한다.",
    notes:
      "v0.1은 이 항목에 requires_gold_change:true를 잘못 기록했다. Gold의 WITHHELD_INFO_DISCLOSURE_NOT_TERM_CHANGE 분류는 "
      + "이미 정확하다. 필요한 것은 조건 불변 사실과 '유보 공개' 결론까지 포함하는 응답 구현이다. 신규 Fact는 만들지 않는다.",
  },
];

async function main() {
  for (const record of RECORDS) {
    if (record.requires_new_fact !== false) throw new Error(`requires_new_fact must be false for ${record.question_id}/${record.metric_name}`);
    if (record.requires_gold_change !== false) throw new Error(`requires_gold_change must be false for ${record.question_id}/${record.metric_name}`);
    if (record.requires_metric_change !== false) throw new Error(`requires_metric_change must be false for ${record.question_id}/${record.metric_name}`);
    if (record.data_semantics_confirmed !== true) throw new Error(`data_semantics_confirmed must be true for ${record.question_id}/${record.metric_name}`);
    if (record.current_response_complete !== false) throw new Error(`current_response_complete must be false for ${record.question_id}/${record.metric_name}`);
    if (record.metric_failure_valid !== true) throw new Error(`metric_failure_valid must be true for ${record.question_id}/${record.metric_name}`);
    if (record.resolution_status !== "RESPONSE_IMPLEMENTATION_REQUIRED") throw new Error(`unexpected resolution_status for ${record.question_id}/${record.metric_name}`);
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
    schema_version: "0.2.0",
    artifact_id: "seed-metric-failure-owner-decision-v0.2",
    generated_at: REVIEWED_AT,
    reviewer: REVIEWER,
    supersedes: { path: DECISION_V01_PATH, sha256: pinnedInputs.prior_decision_v01.sha256 },
    supersession_note:
      "v0.1은 4건 모두 requires_gold_change:true로 잘못 기록했다. 실제 Gold(v0.17)와 v0.5 프로파일 HTTP 응답을 "
      + "대조한 결과, Gold는 이미 올바른 기대값(NOT_FOUND / OUTSIDE_CORPUS / 정확한 날짜 흐름 / "
      + "WITHHELD_INFO_DISCLOSURE_NOT_TERM_CHANGE)을 가지고 있으며, 문제는 현재 Agent 응답이 이 값들을 텍스트로 "
      + "표현하지 않는다는 데 있다. v0.1은 파일 그대로 보존되며(감사 이력), 이 v0.2가 올바른 판단을 대체한다.",
    scope:
      "v0.19 Seed 데이터 동결점(Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6)에서 관측된 "
      + "실제 Harness metric_fail 4건에 대한 수정된 사람 판정. Gold/Fact/Evidence/Coverage/Plan/Thin Flow/Runtime은 "
      + "이 artifact가 생성되는 과정에서 전혀 수정되지 않았다. 신규 Fact도, 질문별 응답 템플릿도 추가되지 않았다.",
    decision_artifact: { path: DECISION_PATH, sha256: decisionSha256, record_count: RECORDS.length },
    pinned_inputs: pinnedInputs,
    raw_harness_metric_fail: harnessSummary.metric_fail,
    raw_harness_review_required: harnessSummary.review_required,
  };
  await writeFile(path.join(REPO, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const reviewMd = `# Seed Metric-Failure Owner Adjudication v0.2 (corrects v0.1)

**Reviewer:** ${REVIEWER}
**Reviewed at:** ${REVIEWED_AT}
**Supersedes:** \`${DECISION_V01_PATH}\` (preserved untouched as audit history -- NOT modified)
**Data freeze point:** v0.19 (Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6 -- unmodified)
**Raw Harness metric_fail (unmodified, still on disk):** ${harnessSummary.metric_fail}
**Raw Harness review_required (unmodified, still on disk):** ${harnessSummary.review_required}

## 왜 v0.2인가

v0.1은 4건 모두 \`requires_gold_change: true\`로 기록했다. 실제 Gold(v0.17)와 v0.5 프로파일 HTTP 응답을
직접 대조한 결과 이는 틀렸다: **Gold는 이미 올바른 기대값을 가지고 있다.** 실패의 원인은 현재 Agent 응답이
그 값들을 텍스트로 말하지 않는다는 데 있다. v0.2는 이 판단 오류를 바로잡는다.

${RECORDS.map((r, i) => `## ${i + 1}. ${r.question_id} / ${r.metric_name}

- **원시 자동 상태:** ${r.original_automatic_status}
- **owner_disposition:** ${r.owner_disposition}
  - ${r.owner_disposition_note}
- **판정 유형:** ${r.adjudication_type}
- **확인된 의미(Gold는 이미 정확함):** ${r.verified_meaning}
- **data_semantics_confirmed:** ${r.data_semantics_confirmed}
- **current_response_complete:** ${r.current_response_complete}
- **metric_failure_valid:** ${r.metric_failure_valid}
- **resolution_status:** ${r.resolution_status}
- **필요한 응답 수정 (required_response_change):** ${r.required_response_change}
- **requires_gold_change / requires_metric_change / requires_new_fact:** ${r.requires_gold_change} / ${r.requires_metric_change} / ${r.requires_new_fact}
- **비고:** ${r.notes}
`).join("\n")}

## 집계

| | 값 |
|---|---|
| raw_metric_fail (Harness, 불변) | 4 |
| data_semantics_reviewed | 4 |
| response_implementation_required | 4 |
| owner_adjudicated_as_pass | 0 |
| unadjudicated_data_meaning | 0 |
| unresolved_response_metric_fail | 4 |

원시 결과는 절대 PASS로 덮어쓰지 않았다. 4건 모두 데이터 의미(Gold)는 확인되었지만,
응답 구현이 없는 한 metric_fail은 4건 그대로 유효하게 남는다.

## Release Gate 표현

- automatic metric gate (raw): BLOCKED (metric_fail=4, 원시 결과 보존)
- data semantics review gate: COMPLETE (4/4 -- Gold/원문 의미는 확인됨)
- response implementation gate: BLOCKED (4/4 응답 구현 필요, 미착수)
- manual review gate: BLOCKED (REVIEW_REQUIRED 17건 미해결)
- deployment gate: BLOCKED
- **overall Release Gate: BLOCKED**
`;
  await writeFile(path.join(REPO, REVIEW_MD_PATH), reviewMd, "utf8");

  const report = {
    schema_version: "0.2.0",
    report_type: "METRIC_FAILURE_ADJUDICATION_REPORT",
    generated_at: REVIEWED_AT,
    data_freeze_point: "v0.19",
    supersedes_report: "work/domain-seed/seed-metric-failure-adjudication-report.v0.1.json",
    supersession_note: "v0.1's requires_gold_change:true / owner_adjudicated:4(as-resolved) framing was wrong. Gold is already correct; the gap is in the current Agent response. v0.1 is preserved unmodified as audit history.",
    raw_metric_fail: harnessSummary.metric_fail,
    data_semantics_reviewed: RECORDS.length,
    response_implementation_required: RECORDS.filter((r) => r.resolution_status === "RESPONSE_IMPLEMENTATION_REQUIRED").length,
    owner_adjudicated_as_pass: 0,
    unadjudicated_data_meaning: 0,
    unresolved_response_metric_fail: harnessSummary.metric_fail,
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
      data_semantics_confirmed: r.data_semantics_confirmed,
      current_response_complete: r.current_response_complete,
      metric_failure_valid: r.metric_failure_valid,
      resolution_status: r.resolution_status,
      requires_gold_change: r.requires_gold_change,
      requires_metric_change: r.requires_metric_change,
    })),
    release_gate: {
      automatic_metric_gate_raw: { status: "BLOCKED", metric_fail: harnessSummary.metric_fail, note: "raw Harness result, never modified" },
      data_semantics_review_gate: { status: "COMPLETE", reviewed: RECORDS.length },
      response_implementation_gate: { status: "BLOCKED", required: RECORDS.length, note: "no response implementation has been made in this or any prior turn" },
      manual_review_gate: { status: "BLOCKED", review_required: harnessSummary.review_required },
      deployment_gate: { status: "BLOCKED" },
      overall_release_gate: "BLOCKED",
      note:
        "data_semantics_review_gate가 4/4로 완료되었다고 해서 metric_fail이 해소되거나 전체 Release Gate/Deployment Gate가 "
        + "열리지 않는다. 4건 모두 response_implementation_required 상태이며, Gold/Fact/Evidence/Coverage/Plan/Thin Flow/"
        + "Runtime 어느 것도 이 adjudication으로 변경되지 않았다. REVIEW_REQUIRED 17건도 여전히 미해결이다.",
    },
  };
  await writeFile(path.join(REPO, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    decision_path: DECISION_PATH, decision_sha256: decisionSha256, record_count: RECORDS.length,
    manifest_path: MANIFEST_PATH, review_md_path: REVIEW_MD_PATH, report_path: REPORT_PATH,
    raw_metric_fail: harnessSummary.metric_fail,
    data_semantics_reviewed: RECORDS.length,
    response_implementation_required: RECORDS.length,
    owner_adjudicated_as_pass: 0,
    unadjudicated_data_meaning: 0,
    unresolved_response_metric_fail: harnessSummary.metric_fail,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
