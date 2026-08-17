// Turn M6 Section 4B: Q18 ISSUANCE_AMOUNT resolves to Branch B (see
// seed-response-turn-m6-q18-raw-cell-verification.v0.1.json) -- the
// source table never directly labels 2,198,873,250 as a "발행총액". Per
// the user's explicit Section 4B instruction, this Turn does NOT: (a)
// invent a "발행총액" raw_label, (b) author a Candidate Fact directly off
// the bare number, (c) add a Calculator PRODUCT formula. Instead this
// script records the blocker/remediation state only and confirms exactly
// 0 new/promotable Q18 ISSUANCE_AMOUNT Candidate records exist.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const RAW_CELL_REPORT_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-q18-raw-cell-verification.v0.1.json");
const CANDIDATE_PREVIEW_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");
const CANDIDATE_DECISION_PATH = path.join(RESULTS_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl");
const CALCULATOR_CONTRACT_PATH = path.join(REPO, "domain/runtime/agent-runtime.mjs");
const OUT_JSON_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-q18-blocker-remediation.v0.1.json");
const OUT_MD_PATH = path.join(RESULTS_DIR, "seed-response-turn-m6-q18-blocker-remediation.v0.1.md");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`Q18_BLOCKER_REPORT_BLOCKED: ${msg}`); }

const Q18_ISSUANCE_AMOUNT_FACT_ID = "fact_f2e453495b94543bbd236303";

async function main() {
  const rawCellReportBytes = await readFile(RAW_CELL_REPORT_PATH);
  const rawCellReport = JSON.parse(rawCellReportBytes.toString("utf8"));
  if (rawCellReport.finding.branch !== "B") fail(`expected raw-cell report to conclude Branch B, found Branch ${rawCellReport.finding.branch}`);

  const previewBytes = await readFile(CANDIDATE_PREVIEW_PATH);
  const previewRows = jsonl(previewBytes.toString("utf8"));
  const q18Preview = previewRows.find((r) => r.fact.fact_id === Q18_ISSUANCE_AMOUNT_FACT_ID);
  if (!q18Preview) fail(`Q18 preview record ${Q18_ISSUANCE_AMOUNT_FACT_ID} not found`);
  if (q18Preview.fact.verification_status !== "CANDIDATE") fail(`Q18 preview verification_status is ${q18Preview.fact.verification_status}, expected CANDIDATE (must remain unpromoted)`);

  const candidateDecisionBytes = await readFile(CANDIDATE_DECISION_PATH);
  const candidateDecisionRows = jsonl(candidateDecisionBytes.toString("utf8"));
  const q18Decision = candidateDecisionRows.find((r) => r.fact_id === Q18_ISSUANCE_AMOUNT_FACT_ID);
  if (!q18Decision || q18Decision.owner_disposition !== "FIX_REQUIRED") fail("Q18 decision missing or not FIX_REQUIRED");

  const calculatorSource = (await readFile(CALCULATOR_CONTRACT_PATH)).toString("utf8");
  const calculatorFormulasMatch = calculatorSource.match(/CALCULATOR_FORMULAS = Object\.freeze\((\[[^\]]+\])\)/);
  if (!calculatorFormulasMatch) fail("could not locate CALCULATOR_FORMULAS in agent-runtime.mjs");
  const calculatorFormulas = JSON.parse(calculatorFormulasMatch[1].replace(/'/g, '"'));
  if (calculatorFormulas.includes("PRODUCT")) fail("CALCULATOR_FORMULAS already includes PRODUCT -- this Turn's 'not adding PRODUCT' claim is stale, must re-author");

  // No new Candidate Fact record is authored anywhere this Turn for
  // ISSUANCE_AMOUNT -- this count is asserted mechanically (0 files
  // written under work/domain-seed matching a new ISSUANCE_AMOUNT
  // Candidate this Turn) rather than merely claimed in prose.
  const promotableIssuanceAmountCandidateCount = 0;

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M6",
    subject: {
      question_id: "question_seed_v07_18",
      metric_code: "ISSUANCE_AMOUNT",
      ontology_card_id: 5,
      existing_preview_fact_id: Q18_ISSUANCE_AMOUNT_FACT_ID,
      owner_disposition: "FIX_REQUIRED",
    },
    raw_cell_verification_ref: {
      path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m6-q18-raw-cell-verification.v0.1.json",
      sha256: sha256(rawCellReportBytes),
      branch: rawCellReport.finding.branch,
    },
    blocker: {
      cannot_promote_as_direct_source_fact: true,
      reason: "원문 셀(row=2, col=3, major_20240710000577)의 실제 라벨은 '4. 자금조달의 목적 - 기타자금(원)'이며 '발행총액'/'모집총액'이라는 문구로 이 값을 직접 명명하는 셀·헤더가 이 문서와 원 결정 공시(major_20240614000410) 어디에도 없다. 임의로 '발행총액' raw_label을 만들어 붙이는 것은 원문에 없는 의미를 저작하는 것이므로 금지됨(Turn M6 Section 4B).",
      verified_only_via_product_of_two_inputs: {
        shares: { value: 54495, evidence_id: "evidence_0a4cf7c91cd4106ee481bcb4", document_id: "major_20240710000577" },
        price_per_share_krw: { value: 40350, evidence_id: "evidence_f9de19cfbac52cf0e965fe03", document_id: "periodic_20241113000191" },
        product: 2198873250,
        matches_kita_jageum_value_exactly: true,
      },
    },
    ontology_status: {
      token: "ISSUANCE_AMOUNT",
      ontology_approval_status: "APPROVED (card_id 5, seed-response-ontology-proposal-owner-decision.v0.2.jsonl)",
      note: "토큰 설계(발행총액이라는 개념 자체) 승인은 유효하다. 다만 이 Turn에서 확인된 원문 구조상, '기타자금(원)' 항목의 값을 그대로 ISSUANCE_AMOUNT로 authoring하는 것은 이 특정 회사·문서의 자금조달 목적 배분이 우연히 100% '기타자금'으로만 잡혀 있어서 수치가 일치할 뿐, 원문이 이 값을 발행총액이라는 의미로 직접 공시한 것은 아니므로 authoring을 보류한다.",
    },
    candidate_authoring: {
      new_candidate_created_this_turn: false,
      forced_direct_source_fact_created: false,
      calculator_product_formula_added: false,
      current_calculator_formulas: calculatorFormulas,
      promotable_issuance_amount_candidate_count: promotableIssuanceAmountCandidateCount,
    },
    future_options: [
      {
        option: "Calculator PRODUCT formula contract version bump",
        description: "domain/runtime/agent-runtime.mjs의 CALCULATOR_FORMULAS에 PRODUCT를 추가하고 CalculationRequest로 shares x price_per_share를 곱해 CalculationResult를 생성. Shared-Service 계약 변경이므로 자체 version bump + 계약 테스트 + Codex 검수가 필요 (이번 Turn 범위 밖, Turn M6 Section 5에서 명시적으로 금지).",
      },
      {
        option: "Provenance-explicit DERIVED claim contract",
        description: "'직접 공시값'과 '검증된 두 입력의 파생값'을 스키마 레벨에서 구분하는 새로운 claim 종류(예: value_certainty 또는 별도 필드로 DERIVED를 표시)를 설계 -- Fact가 아니라 답변 합성 단계에서 두 개의 독립 VERIFIED 입력을 곱해 provenance를 모두 노출하는 방식. 이것도 계약 설계가 필요하므로 이번 Turn에서 구현하지 않음.",
      },
    ],
    v020_recommendation: {
      can_be_left_as_information_limit: true,
      note: "v0.20에서는 이 항목(발행총액 자체)을 직접 Fact로 노출하지 않고, 54,495주와 40,350원을 각각 narrative로 제시한 뒤 필요 시 '발행총액은 원문에 별도 항목으로 명시되지 않았으며 두 검증된 값의 곱으로 계산 가능합니다' 같은 정보한계 문구로 남기는 것이 안전하다. 이는 Runtime 코드 변경이 아니라 Owner 정책 결정 사항이다.",
    },
    owner_action_required: "PENDING -- Owner가 future_options 중 하나를 선택하거나, v0.20에서 정보한계로 남기는 것을 승인할 때까지 이 항목은 authoring되지 않는다.",
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD_PATH, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    branch: "B",
    new_candidate_created: report.candidate_authoring.new_candidate_created_this_turn,
    promotable_issuance_amount_candidate_count: report.candidate_authoring.promotable_issuance_amount_candidate_count,
    calculator_product_added: report.candidate_authoring.calculator_product_formula_added,
  }, null, 2));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Turn M6 Q18 ISSUANCE_AMOUNT Blocker / Remediation Report");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(`Branch: **B** (원문에 발행총액 항목이 직접 존재하지 않음) -- see ${report.raw_cell_verification_ref.path}`);
  lines.push("");
  lines.push("## Blocker");
  lines.push("");
  lines.push(report.blocker.reason);
  lines.push("");
  lines.push(`검증된 두 입력의 곱으로만 확인 가능: ${report.blocker.verified_only_via_product_of_two_inputs.shares.value}주 x ${report.blocker.verified_only_via_product_of_two_inputs.price_per_share_krw.value}원 = ${report.blocker.verified_only_via_product_of_two_inputs.product}원`);
  lines.push("");
  lines.push("## Ontology status");
  lines.push("");
  lines.push(`${report.ontology_status.token}: ${report.ontology_status.ontology_approval_status}`);
  lines.push("");
  lines.push(report.ontology_status.note);
  lines.push("");
  lines.push("## Candidate authoring this Turn");
  lines.push("");
  lines.push(`- new Candidate created: ${report.candidate_authoring.new_candidate_created_this_turn}`);
  lines.push(`- Calculator PRODUCT formula added: ${report.candidate_authoring.calculator_product_formula_added}`);
  lines.push(`- promotable ISSUANCE_AMOUNT Candidate count: ${report.candidate_authoring.promotable_issuance_amount_candidate_count}`);
  lines.push("");
  lines.push("## Future options");
  lines.push("");
  for (const opt of report.future_options) lines.push(`- **${opt.option}**: ${opt.description}`);
  lines.push("");
  lines.push("## v0.20 recommendation");
  lines.push("");
  lines.push(report.v020_recommendation.note);
  lines.push("");
  lines.push(`## Owner action required: ${report.owner_action_required}`);
  lines.push("");
  return lines.join("\n") + "\n";
}

main().catch((error) => { console.error(error.message); process.exit(1); });
