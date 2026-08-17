// Turn M4 Section 6: a single decision packet the Owner can judge on one
// screen -- exactly 4 ontology proposal cards, each PENDING, no AI auto-
// approval. This corrects Turn M3's own report error (it stated 3
// proposals; there are actually 4 -- see
// seed-response-turn-m3-correction-report.v0.1.json for the full
// rationale). Read-only over the ontology audit v0.1 and VERIFIED
// artifacts it cites -- never modifies seed-response-structured-gap-
// ontology-audit.v0.1.json itself.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONTOLOGY_AUDIT_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const FACTS_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl");
const CALCULATOR_CONTRACT_PATH = path.join(REPO, "domain/runtime/agent-runtime.mjs");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_JSON_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-decision-packet.v0.1.json");
const OUT_MD_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-decision-packet.v0.1.md");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }

async function main() {
  const auditBytes = await readFile(ONTOLOGY_AUDIT_PATH);
  const audit = JSON.parse(auditBytes.toString("utf8"));
  const evidenceRows = jsonl((await readFile(EVIDENCE_VERIFIED_PATH)).toString("utf8"));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const factRows = jsonl((await readFile(FACTS_VERIFIED_PATH)).toString("utf8"));
  const calculatorSource = (await readFile(CALCULATOR_CONTRACT_PATH)).toString("utf8");
  const calculatorFormulasMatch = calculatorSource.match(/CALCULATOR_FORMULAS = Object\.freeze\((\[[^\]]+\])\)/);
  if (!calculatorFormulasMatch) throw new Error("BLOCKER: could not locate CALCULATOR_FORMULAS in agent-runtime.mjs -- ontology card #4's PRODUCT-vs-Fact comparison depends on this being read from the REAL current contract, never assumed.");
  const calculatorFormulas = JSON.parse(calculatorFormulasMatch[1].replace(/'/g, '"'));
  if (calculatorFormulas.includes("PRODUCT")) {
    throw new Error("BLOCKER: PRODUCT already exists in CALCULATOR_FORMULAS -- card #4's reasoning (recommend ISSUANCE_AMOUNT Fact because PRODUCT requires a contract version bump) is STALE and must be re-authored, never assumed unchanged.");
  }

  const q18Evidence = evidenceById.get("evidence_ce757058c68b8932b0b7c7e0");
  if (!q18Evidence || q18Evidence.verification_status !== "VERIFIED") {
    throw new Error("BLOCKER: card #4's grounding evidence (evidence_ce757058c68b8932b0b7c7e0) is not VERIFIED -- cannot recommend an ISSUANCE_AMOUNT Fact against it.");
  }
  const q18SharesFact = factRows.find((f) => f.fact_id === "fact_4b5dc7b1e4bb34969ad7a51e");
  if (!q18SharesFact) throw new Error("BLOCKER: fact_4b5dc7b1e4bb34969ad7a51e (corrected shares/price) not found in VERIFIED facts.");
  const shares = q18SharesFact.attributes?.corrected_actual_shares;
  const pricePerShare = q18SharesFact.attributes?.issue_price_per_share_krw;
  const product = shares * pricePerShare;
  const targetAmount = Number(String(q18Evidence.quoted_text).replace(/,/g, ""));
  if (product !== targetAmount) {
    throw new Error(`BLOCKER: card #4's cross-check failed -- ${shares} x ${pricePerShare} = ${product}, but VERIFIED evidence states ${targetAmount}. Never propose an ISSUANCE_AMOUNT Fact against a value that does not mechanically reconcile.`);
  }

  const cards = [
    {
      card_id: 1,
      question_ids: ["question_seed_v07_06"],
      title: "투자 목적 / 투자 대상자산 (Q06)",
      proposed_tokens: [
        { token: "INVESTMENT_PURPOSE", value_type: "TEXT", unit: null, scope: "COMPANY" },
        { token: "INVESTMENT_TARGET_ASSET", value_type: "TEXT", unit: null, scope: "COMPANY" },
      ],
      grouping_note: "두 토큰은 같은 투자 결정 공시 1건에서 함께 나오는 짝이므로 이 카드 안에 함께 제시하지만, 서로 다른 metric_code로 남아 별도 Fact가 된다 (하나로 합치지 않음).",
      source_evidence_basis: "이미 VERIFIED된 Evidence 텍스트('건조 효율성 증대'/'6,500ton급 Floating Crane', '생산량 증대'/'Floating Dock 확장')를 그대로 인용하며, 새 원문 발췌 없음.",
      applies_to_candidate_value: "268,000,000,000원 -> INVESTMENT_PURPOSE '건조 효율성 증대' + INVESTMENT_TARGET_ASSET '6,500ton급 Floating Crane'; 332,800,000,000원 -> INVESTMENT_PURPOSE '생산량 증대' + INVESTMENT_TARGET_ASSET 'Floating Dock 확장'.",
      why_existing_ontology_cannot_express_it: "기존 metric_code 중 투자 목적/대상자산을 나타내는 토큰이 없음. INVESTMENT_AMOUNT는 금액만 표현하며 목적/대상을 담을 필드가 없음.",
      reuse_examples_elsewhere: "CAPEX/투자 결정 공시 전반에서 금액과 함께 목적·대상이 재사용 가능 (이 회사·이 질문에 한정되지 않음).",
      overfitting_risk: "낮음 -- 두 토큰 모두 실제 공시 문구를 그대로 인용하는 TEXT 타입이며, 특정 회사/연도에 종속된 값이 아님. 다만 두 투자를 같은 문서 내에서 잘못 교차 연결(cross-attribute)할 위험이 있어 same-document linkage 규칙이 필요.",
      migration_impact: "Additive만 (새 metric_code 2개 추가). 기존 Fact 의미 변경 없음. metric_code는 패턴 타입(비고정 enum)이라 formal schema migration 불필요, project-policy 승인만 필요.",
      record_count_if_approved: 2,
      owner_decision: "PENDING",
    },
    {
      card_id: 2,
      question_ids: ["question_seed_v07_09"],
      title: "신탁계약 예정 취득 주식수 (Q09)",
      proposed_tokens: [
        { token: "ACQUISITION_PLANNED_SHARES", value_type: "NUMERIC", unit: "주", scope: "COMPANY" },
      ],
      applies_to_candidate_value: "9,861,932주 (evidence_b673a282e3406174077c7456, VERIFIED, 신탁계약 예정 취득 수량).",
      why_existing_ontology_cannot_express_it: "DISPOSAL_SHARES가 존재하지만 방향이 반대(처분, 취득 아님)이므로 재사용 시 값의 의미가 뒤바뀜. 다른 어떤 기존 metric_code도 '취득 예정'이라는 시점적 성격(계획값 vs 실제값)을 안전하게 표현하지 못함.",
      disposal_shares_reuse_explicitly_rejected_because: "DISPOSAL_SHARES를 재사용하면 '처분 예정 주식수'로 읽혀 실제 값(취득 예정)과 정반대 의미가 되므로, 값 자체는 맞아도 metric_code가 거짓 진술이 된다. 절대 재사용하지 않는다.",
      reuse_examples_elsewhere: "신탁계약·공개매수 등 '예정 수량 vs 실제 수량'을 모두 공시하는 모든 취득 공시에서 재사용 가능.",
      overfitting_risk: "낮음 -- 방향(취득)과 상태(예정)를 명시적으로 이름에 담아 다른 회사/계약에도 안전하게 재사용 가능.",
      migration_impact: "Additive만. 기존 Fact 의미 변경 없음.",
      record_count_if_approved: 1,
      related_but_independent_gap: "이 질문(Q09)은 이 ontology 제안과 별개로 CONTRACT_COUNTERPARTY Candidate(fact_74a2b743fee3b410295be924, v0.9로 raw_label 정정됨)에 대한 Owner 검수도 필요하다 -- 두 gap은 서로 독립적이며 하나를 승인해도 다른 하나는 해결되지 않는다 (matrix v0.4 참고).",
      owner_decision: "PENDING",
    },
    {
      card_id: 3,
      question_ids: ["question_seed_v07_20"],
      title: "정정 사유 (Q20)",
      proposed_tokens: [
        { token: "CORRECTION_REASON", value_type: "TEXT", unit: null, scope: "COMPANY" },
      ],
      applies_to_candidate_value: "'변경계약 체결 지연으로 인한 계약종료일 정정' (evidence_fb63f3d8238a3177b7ecef68, VERIFIED, 2024-11-29 공시).",
      why_existing_ontology_cannot_express_it: "정정 사유 문서 자체는 새 종료일/금액 등 확정값을 담고 있지 않음(실제 정정된 값은 6일 뒤 다른 문서에서 공시됨). 기존 CONTRACT_PERIOD_END(DATE 타입)에 부착하면 value_type을 오용하게 되고, 나중 문서의 Fact에 부착하면 provenance를 오귀속하게 됨.",
      event_attribute_vs_standalone_fact_comparison: {
        event_attribute_option: "기존 Event의 attributes.reason 키에 부착 -- 장점: 새 metric_code 불필요. 단점: 이 정정 사유 공시는 그 자체로 독립된 문서/시점을 가지므로 Event attribute에 넣으면 source_document_id/as_of_date 같은 개별 provenance가 Event 레벨로 압축되어 손실됨.",
        standalone_fact_option: "CORRECTION_REASON을 별도 Fact로 신설 -- 장점: 이 정정 사유 공시 고유의 source_document_id/as_of_date/evidence_id를 그대로 보존. 단점: 새 metric_code 1개 추가.",
        recommendation: "standalone Fact 권장 -- provenance 보존이 이 프로젝트의 최우선 불변식(Section 4)과 직접 부합하며, Event attribute로 압축하면 '어느 문서에서 나온 사유인지'를 잃는다.",
      },
      reuse_examples_elsewhere: "계약금액/계약기간 정정 공시 전반에서 재사용 가능 (이 회사에 한정되지 않음).",
      overfitting_risk: "낮음 -- 기존 metric_code와 의미가 겹치지 않는 새 독립 토큰.",
      migration_impact: "Additive만.",
      record_count_if_approved: 1,
      owner_decision: "PENDING",
    },
    {
      card_id: 4,
      question_ids: ["question_seed_v07_18"],
      title: "유상증자 발행총액 (Q18)",
      proposed_tokens: [
        { token: "ISSUANCE_AMOUNT", value_type: "NUMERIC", unit: "원", scope: "COMPANY" },
      ],
      applies_to_candidate_value: `2,198,873,250원 (evidence_ce757058c68b8932b0b7c7e0, VERIFIED, 이미 이 질문에 linked_question_ids로 연결됨). 기계적 교차검증: 정정 후 발행주식수 ${shares}주 x 주당 발행가액 ${pricePerShare}원 = ${product}원 (VERIFIED evidence 값과 정확히 일치, fact_4b5dc7b1e4bb34969ad7a51e의 attributes.corrected_actual_shares/issue_price_per_share_krw로부터 계산).`,
      why_existing_ontology_cannot_express_it: "현재 답변은 발행주식수(54,495주)와 주당 발행가액(40,350원)을 각각 별도 문장으로만 서술하며 그 곱(발행총액)을 어떤 Fact/계산도 명시적으로 담지 않음.",
      product_contract_vs_issuance_amount_fact_comparison: {
        product_contract_option: {
          description: "Calculator에 PRODUCT(곱셈) formula를 추가하고 CalculationRequest로 두 값을 곱해 CalculationResult를 생성.",
          current_calculator_formulas: calculatorFormulas,
          blocker: "PRODUCT는 현재 CALCULATOR_FORMULAS(domain/runtime/agent-runtime.mjs)에 없음 -- Calculator는 검증된 CalculationRequest만 수락하는 Shared Service 계약이므로(CLAUDE.md Section 5), formula enum 확장은 계약 변경이며 자체 version bump + 계약 테스트 + Codex 검수가 필요함. 이번 Turn의 고정 범위(v0.20 종료 준비) 밖.",
        },
        issuance_amount_fact_option: {
          description: "PRODUCT 계산 없이, 이미 VERIFIED된 evidence_ce757058c68b8932b0b7c7e0을 직접 근거로 ISSUANCE_AMOUNT Fact를 신설.",
          advantage: "Shared Service 계약 변경 없음. Additive-only. 이미 VERIFIED된 Evidence를 그대로 재사용 (새 원문 발췌 없음).",
        },
        recommendation: "ISSUANCE_AMOUNT Fact 권장 -- Calculator 계약을 이번 Turn에 건드리지 않고도 원문에 이미 있는 값을 안전하게 노출할 수 있음. PRODUCT formula 확장은 향후 Turn에서 별도 version bump + 계약 테스트로 정식 검토 가능 (지금 당장 필요하지는 않음, 이 값 자체가 이미 VERIFIED Evidence에 원문 그대로 존재하므로).",
      },
      trust_boundary_impact: "ISSUANCE_AMOUNT를 채택하면 이 값은 계산이 아니라 원문 인용(NARRATIVE_SOURCE_DISCLOSURE와 동일한 신뢰 경계)이 되어 Citation Validator가 그대로 원문 대조 검증 가능. PRODUCT를 채택하면 신뢰 경계가 '검증된 CalculationRequest만 수락'이라는 Calculator 불변식으로 이동하며 별도 계약 테스트가 새로 필요해짐.",
      reuse_examples_elsewhere: "유상증자/전환사채 등 '수량 x 단가'로 총액을 표현하는 모든 발행 공시에서 재사용 가능.",
      overfitting_risk: "낮음 -- 금액 단위(원)의 일반 NUMERIC 토큰, 특정 회사에 종속되지 않음.",
      migration_impact: "Additive만. 기존 Fact 의미 변경 없음.",
      record_count_if_approved: 1,
      owner_decision: "PENDING",
    },
  ];

  const packet = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M4",
    supersedes_note: "Turn M3의 ontology audit v0.1은 gap_classification에 3개 ONTOLOGY_PROPOSAL_REQUIRED 항목만 나열했으나(Q06/Q09/Q20), 이 패킷은 Turn M4 Section 2C 재확인을 반영해 Q18(발행총액)을 4번째 카드로 추가한다. ontology audit v0.1 자체는 수정하지 않으며(FORBIDDEN), 이 패킷이 최신 4-카드 정본이다.",
    input_artifacts: {
      ontology_audit_v01_path: "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json",
      ontology_audit_v01_sha256: sha256(auditBytes),
      calculator_formulas_observed: calculatorFormulas,
    },
    card_count: cards.length,
    ai_auto_approval: false,
    cards,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD_PATH, renderMarkdown(packet), "utf8");
  console.log(JSON.stringify({ card_count: cards.length, cards: cards.map((c) => ({ id: c.card_id, title: c.title, decision: c.owner_decision })) }, null, 2));
}

function renderMarkdown(packet) {
  const lines = [];
  lines.push("# Seed Ontology Proposal Decision Packet v0.1 (Turn M4)");
  lines.push("");
  lines.push(`Generated: ${packet.generated_at}`);
  lines.push("");
  lines.push(packet.supersedes_note);
  lines.push("");
  for (const c of packet.cards) {
    lines.push(`## Card ${c.card_id}: ${c.title} -- ${c.owner_decision}`);
    lines.push("");
    lines.push(`**Questions:** ${c.question_ids.join(", ")}`);
    lines.push("");
    lines.push(`**Proposed token(s):** ${c.proposed_tokens.map((t) => `${t.token} (${t.value_type}${t.unit ? `, ${t.unit}` : ""})`).join(", ")}`);
    lines.push("");
    lines.push(`**Applies to:** ${c.applies_to_candidate_value}`);
    lines.push("");
    lines.push(`**Why existing ontology can't express it:** ${c.why_existing_ontology_cannot_express_it}`);
    lines.push("");
    if (c.disposal_shares_reuse_explicitly_rejected_because) {
      lines.push(`**DISPOSAL_SHARES reuse explicitly rejected:** ${c.disposal_shares_reuse_explicitly_rejected_because}`);
      lines.push("");
    }
    if (c.event_attribute_vs_standalone_fact_comparison) {
      lines.push("**Event-attribute vs standalone-Fact comparison:**");
      lines.push(`- Event attribute: ${c.event_attribute_vs_standalone_fact_comparison.event_attribute_option}`);
      lines.push(`- Standalone Fact: ${c.event_attribute_vs_standalone_fact_comparison.standalone_fact_option}`);
      lines.push(`- Recommendation: ${c.event_attribute_vs_standalone_fact_comparison.recommendation}`);
      lines.push("");
    }
    if (c.product_contract_vs_issuance_amount_fact_comparison) {
      const cmp = c.product_contract_vs_issuance_amount_fact_comparison;
      lines.push("**PRODUCT-contract vs ISSUANCE_AMOUNT-Fact comparison:**");
      lines.push(`- PRODUCT contract: ${cmp.product_contract_option.description} Blocker: ${cmp.product_contract_option.blocker} (current CALCULATOR_FORMULAS: ${cmp.product_contract_option.current_calculator_formulas.join(", ")})`);
      lines.push(`- ISSUANCE_AMOUNT Fact: ${cmp.issuance_amount_fact_option.description} ${cmp.issuance_amount_fact_option.advantage}`);
      lines.push(`- Recommendation: ${cmp.recommendation}`);
      lines.push("");
      lines.push(`**Trust boundary impact:** ${c.trust_boundary_impact}`);
      lines.push("");
    }
    lines.push(`**Reusable elsewhere:** ${c.reuse_examples_elsewhere}`);
    lines.push("");
    lines.push(`**Overfitting risk:** ${c.overfitting_risk}`);
    lines.push("");
    lines.push(`**Migration impact:** ${c.migration_impact}`);
    lines.push("");
    lines.push(`**Record count if approved:** ${c.record_count_if_approved}`);
    if (c.related_but_independent_gap) {
      lines.push("");
      lines.push(`**Related but independent gap:** ${c.related_but_independent_gap}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

main().catch((error) => { console.error(error.message); process.exit(1); });
