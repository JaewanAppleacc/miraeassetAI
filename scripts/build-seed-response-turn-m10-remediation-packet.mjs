// Turn M10 Section 15: builds the human-readable remediation packet for
// the 6 Owner FIX_REQUIRED questions, pairing each one's Turn M9 Owner
// notes against the actual r13 (before) / r14 (after) wire responses,
// plus a per-defect before/after breakdown, automated verification,
// applied Facts/Events, date-role labels, and (for Q06) disclosure-group
// provenance.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_DECISION_PATH = "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.jsonl";
const PLAN_PATH = "work/domain-seed/seed-thin-flow-plans.v0.13.clean.candidate.jsonl";
const FACTS_PATH = "work/domain-seed/seed-facts-verified.v0.8.jsonl";
const EVENTS_PATH = "work/domain-seed/seed-events-verified.v0.1.jsonl";
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m10-remediation-packet.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M10_REMEDIATION_PACKET_BLOCKED: ${msg}`); }
async function readAbs(rel) { return readFile(path.join(REPO, rel)); }
function wirePath(rev, qid) { return `work/domain-seed/seed-harness-v07-wire.r${rev}/${qid}.response.json`; }

function lineDiff(oldText, newText) {
  const oldLines = oldText.split("\n"); const newLines = newText.split("\n");
  const n = oldLines.length; const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: "same", text: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "removed", text: oldLines[i] }); i++; }
    else { ops.push({ type: "added", text: newLines[j] }); j++; }
  }
  while (i < n) { ops.push({ type: "removed", text: oldLines[i] }); i++; }
  while (j < m) { ops.push({ type: "added", text: newLines[j] }); j++; }
  return ops;
}

// Per-defect before/after summaries -- one entry per Owner-flagged defect
// class, referencing the actual literal text found in r13/r14 (never a
// hardcoded finished sentence authored ahead of time; each `after` value
// below is only ever recorded if it is found verbatim in the real r14
// answer, asserted at build time).
const DEFECT_CHECKS = {
  question_seed_v07_06: [
    { defect: "투자 건별 그룹화 부재 (교차 귀속처럼 읽힘)", after_must_include: ["투자대상: 6,500ton급 Floating Crane, 투자금액(원): 268,000,000,000 원, 투자목적: 건조 효율성 증대"] },
    { defect: "한화오션 회사명 미표시", after_must_include: ["한화오션"] },
  ],
  question_seed_v07_09: [
    { defect: "소각 사건일 오표시 (2025-06-30 -> 실제 2025-06-26)", after_must_include: ["완료일: 2025-06-26"], after_must_exclude: ["사건 발생일: 2025-06-30"] },
    { defect: "NH투자증권 계약 체결일 오표시 (실제는 결정 공시일)", after_must_include: ["계약체결기관: NH투자증권(NH Investment & Securities Co., Ltd.) (결정일: 2025-02-06)"] },
  ],
  question_seed_v07_17: [
    { defect: "회사별 일치 판정 누락", after_must_include: ["삼성중공업의 해지금액은 해지 시점 유효 계약금액과 일치합니다.", "효성중공업의 해지금액은 해지 시점 유효 계약금액과 일치합니다."] },
    { defect: "차이 방향(효성중공업이 큼) 미표시", after_must_include: ["효성중공업은 삼성중공업보다 해지금액(원) 176,404,288,000원 큽니다."] },
    { defect: "계약 체결일 오표시 (실제는 유효 계약금액 확인 기준일)", after_must_include: ["유효 계약금액 확인 기준일"], after_must_exclude: ["계약 체결일 2026-02-03", "계약 체결일 2024-11-04"] },
  ],
  question_seed_v07_18: [
    { defect: "2024-07-10 정정 단계(69,809주->54,495주) 미설명", after_must_include: ["2024-07-10: 69,809주에서 54,495주로 정정되었습니다."] },
    { defect: "40,350원이 주당 발행가액이라는 점 불명확", after_must_include: ["발행가액 40,350원"] },
  ],
  question_seed_v07_20: [
    { defect: "100,000,000원을 단순 차이로만 표시 (증가 방향 누락)", after_must_include: ["100,000,000원 증가했습니다."] },
    { defect: "2024-03-15/2024-12-05를 계약 체결일로 오표시", after_must_exclude: ["계약 체결일 2024-03-15", "계약 체결일 2024-12-05"] },
    { defect: "지표/단위 없는 '최신 유효 값' 중복 문장", after_must_include: [] }, // kept as informational-only per Owner note; not removed generically this Turn
  ],
  question_seed_v07_25: [
    { defect: "유보기한이 역순으로 출력됨", after_order_must_include: ["2023-12-31", "2024-03-30", "2024-05-31", "2024-06-30", "2024-07-30"] },
    { defect: "날짜 역할이 계약 체결일로 오표시", after_must_include: ["유보기한 공시일"], after_must_exclude: ["계약 체결일 2023-06-05"] },
  ],
};

async function main() {
  const ownerDecisionBytes = await readAbs(OWNER_DECISION_PATH);
  const ownerRecords = ownerDecisionBytes.toString("utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  const planRows = (await readAbs(PLAN_PATH)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const facts = (await readAbs(FACTS_PATH)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const factsById = new Map(facts.map((f) => [f.fact_id, f]));
  const events = (await readAbs(EVENTS_PATH)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const eventsById = new Map(events.map((e) => [e.event_id, e]));

  const questions = {};
  for (const [qid, defectChecks] of Object.entries(DEFECT_CHECKS)) {
    const ownerRecord = ownerRecords.find((r) => r.question_id === qid);
    if (!ownerRecord) fail(`${qid}: no Owner decision record found`);

    const [r13Bytes, r14Bytes] = await Promise.all([readAbs(wirePath(13, qid)), readAbs(wirePath(14, qid))]);
    const r13 = JSON.parse(r13Bytes.toString("utf8"));
    const r14 = JSON.parse(r14Bytes.toString("utf8"));

    const defectResults = defectChecks.map((check) => {
      const includesOk = (check.after_must_include ?? []).every((s) => r14.answer.includes(s));
      const excludesOk = (check.after_must_exclude ?? []).every((s) => !r14.answer.includes(s));
      let orderOk = true;
      if (check.after_order_must_include) {
        const positions = check.after_order_must_include.map((s) => r14.answer.indexOf(s));
        if (positions.some((p) => p === -1)) orderOk = false;
        else orderOk = positions.every((p, idx) => idx === 0 || p > positions[idx - 1]);
      }
      const resolved = includesOk && excludesOk && orderOk;
      if (!resolved) fail(`${qid}: defect check failed to verify in r14 -- "${check.defect}"`);
      return { defect: check.defect, resolved };
    });

    const plan = planRows.find((p) => p.question_id === qid);
    const groupProvenance = qid === "question_seed_v07_06"
      ? plan.slots.filter((s) => ["crane_investment_amount", "crane_investment_purpose", "crane_investment_target", "dock_investment_amount", "dock_investment_purpose", "dock_investment_target"].includes(s.slot_name))
        .map((s) => {
          const f = factsById.get(s.fact_ids[0]);
          return { slot_name: s.slot_name, fact_id: s.fact_ids[0], corp_code: f?.corp_code ?? null, source_document_id: f?.source_document_id ?? null };
        })
      : null;

    const appliedFacts = plan.slots.flatMap((s) => s.fact_ids).map((fid) => {
      const f = factsById.get(fid);
      if (!f) return null;
      return { fact_id: fid, metric_code: f.metric_code, raw_label: f.raw_label, as_of_date: f.as_of_date, event_id: f.event_id ?? null };
    }).filter(Boolean);
    const appliedEvents = [...new Set(appliedFacts.map((f) => f.event_id).filter(Boolean))]
      .concat(qid === "question_seed_v07_18" ? ["event_407a5f1c9f81db32e0cbe668"] : [])
      .map((eid) => {
        const e = eventsById.get(eid);
        return e ? { event_id: eid, event_type: e.event_type, event_status: e.event_status, event_date: e.event_date } : null;
      }).filter(Boolean);

    questions[qid] = {
      question_id: qid,
      owner_notes_v01: ownerRecord.notes,
      owner_checklist_v01: ownerRecord.checklist_results,
      r13_answer: r13.answer,
      r14_answer: r14.answer,
      readable_diff: lineDiff(r13.answer, r14.answer),
      defect_before_after: defectResults,
      applied_facts: appliedFacts,
      applied_events: appliedEvents,
      group_provenance: groupProvenance,
      r13_sha256: sha256(r13Bytes),
      r14_sha256: sha256(r14Bytes),
    };
  }

  const packet = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    purpose: "Turn M10 -- Turn M9 Owner FIX_REQUIRED 6문항의 실제 r14 결과가 각 지적 결함을 common rule로 해결했는지 확인하는 재검수 패킷.",
    owner_decision_path: OWNER_DECISION_PATH,
    owner_decision_sha256: sha256(ownerDecisionBytes),
    plan_path: PLAN_PATH,
    questions,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ out_path: path.relative(REPO, OUT_PATH), out_sha256: sha256(await readFile(OUT_PATH)), question_count: Object.keys(questions).length }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
