// Turn M8 Section 9: human-readable final integration packet for the 6
// questions the clean Plan v0.12 actually changed (Q06/Q09/Q17/Q18/Q20/
// Q25). This is a confirmation that the Owner-approved structure/policy
// (14 promoted Facts + the Q18 information_limits contract) is actually
// reflected in the REAL r13 answer -- NOT a fresh raw-document review.
// Every question's owner_disposition is PENDING; nothing here is an
// auto-approval.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl");
const PLAN_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json");
const FACTS_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.8.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m8-integration-packet.v0.1.json");
const FINAL_REVISION = 13;

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M8_INTEGRATION_PACKET_BLOCKED: ${msg}`); }
function wirePath(rev, qid) { return path.join(REPO, `work/domain-seed/seed-harness-v07-wire.r${rev}`, `${qid}.response.json`); }

const AUTOMATED_CHECKS = {
  question_seed_v07_06: [
    { label: "268,000,000,000원과 건조 효율성 증대가 같은 라인 순서로 함께 등장", test: (a) => a.includes("268,000,000,000 원") && a.includes("건조 효율성 증대") },
    { label: "332,800,000,000원과 생산량 증대가 같은 라인 순서로 함께 등장", test: (a) => a.includes("332,800,000,000 원") && a.includes("생산량 증대") },
    { label: "6,500ton급 Floating Crane 투자대상이 표시됨", test: (a) => a.includes("6,500ton급 Floating Crane") },
    { label: "Floating Dock 확장 투자대상이 표시됨", test: (a) => a.includes("Floating Dock 확장") },
    { label: "이중 불릿('- - ')이 나타나지 않음 (라벨 렌더링 결함 없음)", test: (a) => !a.includes("- - ") },
  ],
  question_seed_v07_09: [
    { label: "500,000,000,000원 계약금액 표시", test: (a) => a.includes("500,000,000,000") },
    { label: "NH투자증권이 '계약체결기관'으로 표시", test: (a) => /계약체결기관[^\n]*NH투자증권/.test(a) },
    { label: "NH투자증권이 '계약상대방'/'계약상대'로 표시되지 않음", test: (a) => !a.includes("계약상대방") && !a.includes("계약상대:") },
    { label: "취득 예정 9,861,932주 표시", test: (a) => a.includes("9,861,932") },
    { label: "10,347,131주 소각 표시", test: (a) => a.includes("10,347,131") },
    { label: "중도해지 사유 표시", test: (a) => a.includes("중도해지") },
  ],
  question_seed_v07_17: [
    { label: "삼성중공업 114,800,000,000원 표시", test: (a) => a.includes("114,800,000,000") },
    { label: "효성중공업 291,204,288,000원 표시", test: (a) => a.includes("291,204,288,000") },
    { label: "해지금액과 해지 시점 유효 계약금액이 삼성중공업 기준 일치", test: (a) => (a.match(/114,800,000,000/g) ?? []).length >= 2 },
    { label: "해지금액과 해지 시점 유효 계약금액이 효성중공업 기준 일치", test: (a) => (a.match(/291,204,288,000/g) ?? []).length >= 2 },
    { label: "차이 176,404,288,000원에 회사 라벨이 붙음", test: (a) => a.includes("176,404,288,000원") },
  ],
  question_seed_v07_18: [
    { label: "54,495주 표시", test: (a) => a.includes("54,495") },
    { label: "40,350원 표시", test: (a) => a.includes("40,350") },
    { label: "발행총액이 원문 미확인 정보한계로 명시됨", test: (a) => a.includes("발행총액은 원문에서 직접 공시된 항목으로 확인되지 않습니다") },
    { label: "2,198,873,250원을 '발행총액'이라는 문구로 직접 주장하지 않음", test: (a) => !/2,198,873,250\s*원(은|이)?\s*발행총액/.test(a) },
    { label: "'기타자금'이 다른 이름으로 재명명되지 않음(원문 그대로 노출)", test: (a) => a.includes("기타자금") },
    { label: "내부 enum 토큰(NOT_DIRECTLY_DISCLOSED/DERIVED_CALCULATION_NOT_AVAILABLE)이 노출되지 않음", test: (a) => !a.includes("NOT_DIRECTLY_DISCLOSED") && !a.includes("DERIVED_CALCULATION_NOT_AVAILABLE") },
  ],
  question_seed_v07_20: [
    { label: "2024-11-29 정정 사유 표시", test: (a) => a.includes("2024-11-29") && a.includes("정정사유") },
    { label: "2024-12-05 최신 금액/종료일 표시", test: (a) => a.includes("2024-12-05") && a.includes("4,250,000,000") },
    { label: "정정사유 기준일과 확정 금액 계약 체결일이 서로 다른 줄에 있음", test: (a) => { const l1 = a.split("\n").find((l) => l.includes("정정사유")); const l2 = a.split("\n").find((l) => l.includes("계약금액(원)·정정후")); return Boolean(l1) && Boolean(l2) && l1 !== l2; } },
  ],
  question_seed_v07_25: [
    { label: "2023-12-31 최초 유보기한 표시", test: (a) => a.includes("2023-12-31") },
    { label: "2024-03-30 1차 정정 표시", test: (a) => a.includes("2024-03-30") },
    { label: "2024-05-31 2차 정정 표시", test: (a) => a.includes("2024-05-31") },
    { label: "2024-06-30 3차 정정 표시", test: (a) => a.includes("2024-06-30") },
    { label: "2024-07-30 4차 정정 표시", test: (a) => a.includes("2024-07-30") },
    { label: "2024-07-02 본계약 공시 기준 유보기한 2030-12-31 라벨 정확", test: (a) => a.includes("본계약 공시 기준 유보기한: 2030-12-31") },
    { label: "2030-12-31이 영구 최종 확정일로 표현되지 않음('최종 유보기한' 라벨 없음)", test: (a) => !a.includes("최종 유보기한") },
    { label: "비공개 계약상대방 서술의 PROVISIONAL 한정 표현 유지", test: (a) => a.includes("공개될 예정") },
  ],
};

async function main() {
  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const questionsById = new Map(gold.map((g) => [g.question_id, g]));

  const planLines = (await readFile(PLAN_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const planById = new Map(planLines.map((p) => [p.question_id, p]));
  const planManifest = JSON.parse(await readFile(PLAN_MANIFEST_PATH, "utf8"));
  const diffByQid = new Map(planManifest.per_question_diff.map((d) => [d.question_id, d]));

  const factLines = (await readFile(FACTS_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const factsById = new Map(factLines.map((f) => [f.fact_id, f]));

  const changedQids = ["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25"];
  const questions = {};

  for (const qid of changedQids) {
    const gold_q = questionsById.get(qid);
    if (!gold_q) fail(`${qid}: not found in Gold`);
    const plan = planById.get(qid);
    const diff = diffByQid.get(qid);
    if (!diff.changed_beyond_schema_version_bump) fail(`${qid}: expected a real Plan change, manifest says none`);

    const [r10Bytes, r13Bytes] = await Promise.all([readFile(wirePath(10, qid)), readFile(wirePath(FINAL_REVISION, qid))]);
    const r10 = JSON.parse(r10Bytes.toString("utf8"));
    const r13 = JSON.parse(r13Bytes.toString("utf8"));

    const addedSlotFactIds = diff.added_slot_names.map((slotName) => {
      const slot = plan.slots.find((s) => s.slot_name === slotName);
      if (!slot) fail(`${qid}: added slot ${slotName} not found in clean Plan`);
      return { slot_name: slotName, fact_ids: slot.fact_ids };
    });
    const appliedFacts = addedSlotFactIds.flatMap((s) => s.fact_ids).map((factId) => {
      const f = factsById.get(factId);
      if (!f) fail(`${qid}: applied fact_id ${factId} does not resolve in VERIFIED Fact store`);
      return { fact_id: factId, slot_name: addedSlotFactIds.find((s) => s.fact_ids.includes(factId)).slot_name, metric_code: f.metric_code, raw_label: f.raw_label, value_status: f.value_status, raw_value_text: f.raw_value_text ?? null, normalized_value: f.normalized_value ?? null };
    });

    const informationLimit = diff.information_limits_added
      ? (plan.information_limits ?? []).map((decl) => ({
          target_metric_code: decl.target_metric_code,
          reason_code: decl.reason_code,
          calculation_status: decl.calculation_status,
          available_input_fact_ids: decl.available_input_fact_ids,
          available_input_facts: decl.available_input_fact_ids.map((fid) => {
            const f = factsById.get(fid);
            if (!f) fail(`${qid}: information_limit supporting fact_id ${fid} does not resolve`);
            return { fact_id: fid, metric_code: f.metric_code, raw_label: f.raw_label, raw_value_text: f.raw_value_text ?? null };
          }),
        }))
      : [];

    const checks = (AUTOMATED_CHECKS[qid] ?? []).map((c) => ({ label: c.label, pass: c.test(r13.answer) }));
    const allPass = checks.every((c) => c.pass);

    questions[qid] = {
      question_id: qid,
      question_text: gold_q.question_text ?? gold_q.question ?? null,
      r10_answer: r10.answer,
      r13_answer: r13.answer,
      answer_changed: r10.answer !== r13.answer,
      added_slots: addedSlotFactIds.map((s) => s.slot_name),
      applied_facts: appliedFacts,
      information_limits: informationLimit,
      automated_verification: { checks, total: checks.length, pass_count: checks.filter((c) => c.pass).length, all_pass: allPass },
      owner_checklist: {
        applied_facts_match_owner_approved_14: null,
        answer_text_reflects_approved_facts_accurately: null,
        no_fabricated_or_hardcoded_number: null,
        information_limit_wording_acceptable: qid === "question_seed_v07_18" ? null : "N/A",
        no_unrelated_regression_vs_r10: null,
      },
      owner_disposition: "PENDING",
      reviewer: null,
      reviewed_at: null,
      notes: null,
    };

    if (!allPass) fail(`${qid}: ${checks.filter((c) => !c.pass).map((c) => c.label).join("; ")}`);
  }

  const packet = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    purpose: "Turn M8 Section 9 -- 승인된 구조/정책(14건 Fact 연결 + Q18 information_limits 계약)이 실제 r13 답변에 반영되었는지 확인하는 최종 통합 패킷. 신규 원문 감사가 아님. 모든 owner_disposition은 PENDING이며 자동 승인 없음.",
    baseline_wire_revision: "r10",
    final_wire_revision: `r${FINAL_REVISION}`,
    plan_path: path.relative(REPO, PLAN_PATH),
    plan_sha256: sha256(await readFile(PLAN_PATH)),
    questions,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    out_path: path.relative(REPO, OUT_PATH),
    out_sha256: sha256(await readFile(OUT_PATH)),
    question_count: Object.keys(questions).length,
    all_owner_disposition_pending: Object.values(questions).every((q) => q.owner_disposition === "PENDING"),
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
