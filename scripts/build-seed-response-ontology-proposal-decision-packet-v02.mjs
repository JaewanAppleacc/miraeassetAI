// Turn M5 Section 4: a NEW ontology proposal decision packet revision
// (v0.2) -- never overwrites v0.1. 5 cards total: the same 4 from v0.1
// (Q06/Q09 planned-shares/Q20/Q18) PLUS a 5th (Q09 TRUST_CONTRACT_
// INSTITUTION, the direct consequence of the Owner's FIX_REQUIRED
// decision on fact_74a2b743fee3b410295be924). Card 1 (Q06) explicitly
// corrects v0.1's record_count_if_approved error (2 -> 4: two investment
// disclosures x two tokens each = 4 Candidate records, not 2).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_V01_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const FACTS_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.7.jsonl");
const OWNER_DECISION_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
const CALCULATOR_CONTRACT_PATH = path.join(REPO, "domain/runtime/agent-runtime.mjs");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_JSON_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-decision-packet.v0.2.json");
const OUT_MD_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-decision-packet.v0.2.md");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`ONTOLOGY_PACKET_V02_BLOCKED: ${msg}`); }

async function main() {
  const packetV01Bytes = await readFile(PACKET_V01_PATH);
  const packetV01 = JSON.parse(packetV01Bytes.toString("utf8"));
  const evidenceRows = jsonl((await readFile(EVIDENCE_VERIFIED_PATH)).toString("utf8"));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const factRows = jsonl((await readFile(FACTS_VERIFIED_PATH)).toString("utf8"));
  const ownerDecisionBytes = await readFile(OWNER_DECISION_V02_PATH);
  const ownerDecisionRows = jsonl(ownerDecisionBytes.toString("utf8"));

  const q09CounterpartyDecision = ownerDecisionRows.find((r) => r.fact_id === "fact_74a2b743fee3b410295be924");
  if (!q09CounterpartyDecision || q09CounterpartyDecision.owner_disposition !== "FIX_REQUIRED") {
    fail("expected fact_74a2b743fee3b410295be924 to be FIX_REQUIRED in the v0.2 Owner decision -- card 5 depends on this exact decision existing");
  }

  const calculatorSource = (await readFile(CALCULATOR_CONTRACT_PATH)).toString("utf8");
  const calculatorFormulasMatch = calculatorSource.match(/CALCULATOR_FORMULAS = Object\.freeze\((\[[^\]]+\])\)/);
  if (!calculatorFormulasMatch) fail("could not locate CALCULATOR_FORMULAS in agent-runtime.mjs");
  const calculatorFormulas = JSON.parse(calculatorFormulasMatch[1].replace(/'/g, '"'));

  // -- Card 1 (Q06) re-verification: 2 evidence pairs (target+purpose)
  // per investment, each cross-checked against VERIFIED Evidence + the
  // paired VERIFIED INVESTMENT_AMOUNT Fact it must link to -------------
  const craneAmountFact = factRows.find((f) => f.fact_id === "fact_5f6fa474ce3099876b32e4c5");
  const dockAmountFact = factRows.find((f) => f.fact_id === "fact_7c4d7fb184e153896c1c44af");
  if (!craneAmountFact || !dockAmountFact) fail("Q06 paired INVESTMENT_AMOUNT Facts not found in VERIFIED facts");
  const q06Evidence = {
    crane_purpose: evidenceById.get("evidence_1a8e753b5c667abbf2a60d73"),
    crane_target: evidenceById.get("evidence_441902d5bf9434beed4da64d"),
    dock_purpose: evidenceById.get("evidence_ab530df40bc10feff4d8f7e7"),
    dock_target: evidenceById.get("evidence_ee0081fbf5f0e705b2989ef1"),
  };
  for (const [key, ev] of Object.entries(q06Evidence)) {
    if (!ev || ev.verification_status !== "VERIFIED") fail(`Q06 evidence for ${key} not VERIFIED`);
  }
  if (craneAmountFact.source_document_id === dockAmountFact.source_document_id) {
    fail("Q06 crane/dock INVESTMENT_AMOUNT facts unexpectedly share one source_document_id -- the whole point of same-document linkage is that they differ");
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
      source_evidence_basis: "이미 VERIFIED된 Evidence 텍스트를 그대로 인용하며, 새 원문 발췌 없음. Turn M5 재검증: crane 목적/대상, dock 목적/대상 총 4건 Evidence 모두 VERIFIED 재확인.",
      applies_to_candidate_value: `크레인 투자(${craneAmountFact.source_document_id}, INVESTMENT_AMOUNT ${craneAmountFact.fact_id} = 268,000,000,000원) -> INVESTMENT_PURPOSE '건조 효율성 증대' + INVESTMENT_TARGET_ASSET '6,500ton급 Floating Crane'; Dock 투자(${dockAmountFact.source_document_id}, INVESTMENT_AMOUNT ${dockAmountFact.fact_id} = 332,800,000,000원) -> INVESTMENT_PURPOSE '생산량 증대' + INVESTMENT_TARGET_ASSET 'Floating Dock 확장'.`,
      why_existing_ontology_cannot_express_it: "기존 metric_code 중 투자 목적/대상자산을 나타내는 토큰이 없음. INVESTMENT_AMOUNT는 금액만 표현하며 목적/대상을 담을 필드가 없음.",
      reuse_examples_elsewhere: "CAPEX/투자 결정 공시 전반에서 금액과 함께 목적·대상이 재사용 가능 (이 회사·이 질문에 한정되지 않음).",
      overfitting_risk: "낮음 -- 두 토큰 모두 실제 공시 문구를 그대로 인용하는 TEXT 타입이며, 특정 회사/연도에 종속된 값이 아님. 두 투자를 같은 문서 내에서 잘못 교차 연결(cross-attribute)할 위험이 있어 same-document linkage 규칙이 필수 -- 아래 preview에서 각 목적·대상은 자신의 INVESTMENT_AMOUNT fact_id/source_document_id를 명시적으로 연결한다.",
      migration_impact: "Additive만 (새 metric_code 2개 추가). 기존 Fact 의미 변경 없음. metric_code는 패턴 타입(비고정 enum)이라 formal schema migration 불필요, project-policy 승인만 필요.",
      record_count_if_approved: 4,
      record_count_correction_note: "v0.1은 이 카드의 record_count_if_approved를 2로 잘못 기재했음 (토큰 개수만 셈). 실제로는 두 투자 공시 x 두 토큰 = 4건의 개별 Candidate Fact record가 생성됨 (목적 2건 + 대상 2건). v0.2에서 4로 정정.",
      preview_fact_ids: ["preview 4 records -- see seed-structured-gap-candidate-preview.v0.1.jsonl"],
      owner_decision: "PENDING",
    },
    packetV01.cards.find((c) => c.card_id === 2), // Q09 ACQUISITION_PLANNED_SHARES -- unchanged from v0.1
    {
      card_id: 3,
      question_ids: ["question_seed_v07_09"],
      title: "신탁계약 계약체결기관 (Q09)",
      proposed_tokens: [
        { token: "TRUST_CONTRACT_INSTITUTION", value_type: "TEXT", unit: null, scope: "COMPANY" },
      ],
      applies_to_candidate_value: "NH투자증권(NH Investment & Securities Co., Ltd.) (evidence_4bb201438fab0e23e64ec747, VERIFIED, 자기주식취득 신탁계약 계약체결기관, 실제 원문 행 라벨 '4. 계약체결기관').",
      why_existing_ontology_cannot_express_it: "CONTRACT_COUNTERPARTY는 일반 공급계약의 상대방을 뜻하는 metric_code로, 신탁계약의 계약체결기관·위탁투자중개업자라는 다른 역할(브로커/수탁기관)을 정확히 표현하지 못함. Turn M4에서 CONTRACT_COUNTERPARTY 재사용으로 authored된 Candidate(fact_74a2b743fee3b410295be924)는 Owner가 이 이유로 FIX_REQUIRED 판정함 (owner_disposition FIX_REQUIRED, seed-structured-gap-candidate-owner-decision.v0.2.jsonl).",
      contract_counterparty_reuse_explicitly_rejected_because: "CONTRACT_COUNTERPARTY로 표현하면 '일반 공급계약 상대방'으로 오독되어, 실제로는 자기주식취득 신탁계약을 체결·운용하는 금융기관(브로커/수탁기관) 역할이라는 사실이 사라짐. Owner가 명시적으로 재사용을 거부함.",
      owner_fix_required_decision_linkage: {
        original_candidate_fact_id: "fact_74a2b743fee3b410295be924",
        owner_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
        owner_decision_sha256: sha256(ownerDecisionBytes),
        owner_reviewer: q09CounterpartyDecision.reviewer,
        owner_reviewed_at: q09CounterpartyDecision.reviewed_at,
        owner_notes: q09CounterpartyDecision.notes,
      },
      reuse_examples_elsewhere: "모든 자기주식취득 신탁계약의 계약체결기관 공시에서 재사용 가능 (이 회사·이 질문 전용이 아님).",
      overfitting_risk: "낮음 -- 신탁계약이라는 명확한 계약 유형에 한정된 role 이름이며, 기존 CONTRACT_COUNTERPARTY의 의미를 바꾸지 않는 별도 additive token.",
      migration_impact: "Additive만. 기존 Fact 의미 변경 없음.",
      record_count_if_approved: 1,
      related_but_independent_gap: "Q09의 ACQUISITION_PLANNED_SHARES(카드 2)와 독립적인 별도 gap -- 하나가 승인되어도 다른 하나는 해결되지 않음.",
      owner_decision: "PENDING",
    },
    packetV01.cards.find((c) => c.card_id === 3) ? { ...packetV01.cards.find((c) => c.card_id === 3), card_id: 4 } : null, // Q20 CORRECTION_REASON, renumbered
    packetV01.cards.find((c) => c.card_id === 4) ? { ...packetV01.cards.find((c) => c.card_id === 4), card_id: 5 } : null, // Q18 ISSUANCE_AMOUNT, renumbered
  ];

  if (cards.some((c) => c === null || c === undefined)) fail("failed to carry forward one or more v0.1 cards -- card_id lookup mismatch");
  if (cards.length !== 5) fail(`expected exactly 5 cards, built ${cards.length}`);

  const packet = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    turn: "M5",
    supersedes_note: "이 패킷은 v0.1(4카드)을 대체하는 새 revision이다 -- v0.1 자체는 수정하지 않는다(FORBIDDEN). 5번째 카드(TRUST_CONTRACT_INSTITUTION)는 Owner의 fact_74a2b743fee3b410295be924 FIX_REQUIRED 판정의 직접적인 결과로 추가됨. 카드 1(Q06)의 record_count_if_approved가 2 -> 4로 정정됨.",
    input_artifacts: {
      ontology_packet_v01_path: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json",
      ontology_packet_v01_sha256: sha256(packetV01Bytes),
      owner_decision_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
      owner_decision_v02_sha256: sha256(ownerDecisionBytes),
      calculator_formulas_observed: calculatorFormulas,
    },
    card_count: cards.length,
    ai_auto_approval: false,
    cards,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD_PATH, renderMarkdown(packet), "utf8");
  console.log(JSON.stringify({ card_count: cards.length, cards: cards.map((c) => ({ id: c.card_id, title: c.title, decision: c.owner_decision, record_count: c.record_count_if_approved })) }, null, 2));
}

function renderMarkdown(packet) {
  const lines = [];
  lines.push("# Seed Ontology Proposal Decision Packet v0.2 (Turn M5)");
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
    lines.push(`**Record count if approved:** ${c.record_count_if_approved}`);
    if (c.record_count_correction_note) lines.push(`\n**Correction from v0.1:** ${c.record_count_correction_note}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

main().catch((error) => { console.error(error.message); process.exit(1); });
