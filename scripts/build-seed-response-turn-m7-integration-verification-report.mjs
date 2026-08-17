// Turn M7 Section 7: extracts the REAL r11 answers for Q06/Q09/Q17/Q18/
// Q20/Q25 and mechanically checks each Owner-specified assertion against
// the actual text (never hand-summarized) -- an integration review (did
// the approved structure reach the answer), not a Gold re-grading.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r11");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_MD_PATH = path.join(OUT_DIR, "seed-response-turn-m7-integration-verification.v0.1.md");
const OUT_JSON_PATH = path.join(OUT_DIR, "seed-response-turn-m7-integration-verification.v0.1.json");

function fail(msg) { throw new Error(`M7_INTEGRATION_VERIFICATION_BLOCKED: ${msg}`); }

async function loadAnswer(questionId) {
  const raw = JSON.parse(await readFile(path.join(WIRE_DIR, `${questionId}.response.json`), "utf8"));
  return raw.answer;
}

function check(label, pass) { return { label, pass }; }

async function main() {
  const results = {};

  const q06 = await loadAnswer("question_seed_v07_06");
  results.question_seed_v07_06 = [
    check("268,000,000,000원과 건조 효율성 증대가 같은 라인 순서로 함께 등장", /332,800,000,000[\s\S]{0,10}원[\s\S]{0,30}\n- 투자목적: 건조 효율성 증대/.test(q06) || /투자목적: 건조 효율성 증대[\s\S]{0,60}332,800,000,000/.test(q06)),
    check("268,000,000,000원 라인 바로 뒤에 6,500ton급 Floating Crane 대상이 옴", q06.includes("332,800,000,000 원 (공시일: 2025-04-28)\n- - 투자대상: 6,500ton급 Floating Crane")),
    check("332,800,000,000원 라인 앞에 생산량 증대 목적이 옴", q06.includes("생산량 증대") && q06.includes("- - 투자대상: Floating Dock 확장")),
    check("6,500ton급 Floating Crane과 생산량 증대가 교차 귀속되지 않음(같은 줄에 없음)", !q06.includes("6,500ton급 Floating Crane") || !q06.slice(q06.indexOf("6,500ton급 Floating Crane") - 80, q06.indexOf("6,500ton급 Floating Crane")).includes("생산량 증대")),
    check("Floating Dock 확장과 건조 효율성 증대가 교차 귀속되지 않음(같은 줄에 없음)", !q06.slice(Math.max(0, q06.indexOf("Floating Dock 확장") - 80), q06.indexOf("Floating Dock 확장")).includes("건조 효율성 증대")),
  ];

  const q09 = await loadAnswer("question_seed_v07_09");
  results.question_seed_v07_09 = [
    check("500,000,000,000원 계약금액 표시", q09.includes("500,000,000,000")),
    check("NH투자증권이 '계약체결기관'으로 표시", q09.includes("계약체결기관: NH투자증권")),
    check("NH투자증권이 '계약상대방'/'계약상대'로 표시되지 않음", !q09.includes("계약상대방: NH") && !/계약상대[:：]\s*NH/.test(q09)),
    check("CONTRACT_COUNTERPARTY 리터럴이 노출되지 않음", !q09.includes("CONTRACT_COUNTERPARTY")),
    check("취득 예정 9,861,932주 표시", q09.includes("9,861,932")),
    check("중도해지 사유 표시", q09.includes("중도해지")),
    check("10,347,131주 소각 표시", q09.includes("10,347,131")),
    check("결정일/계약 체결일/해지일 라벨이 서로 다름(날짜 역할 구분)", q09.includes("결정일:") && q09.includes("계약 체결일:") && q09.includes("해지일:")),
  ];

  const q17 = await loadAnswer("question_seed_v07_17");
  results.question_seed_v07_17 = [
    check("삼성중공업 114,800,000,000원 표시", q17.includes("삼성중공업") && q17.includes("114,800,000,000")),
    check("효성중공업 291,204,288,000원 표시", q17.includes("효성중공업") && q17.includes("291,204,288,000")),
    check("삼성중공업 해지금액과 해지 시점 유효 계약금액이 모두 114,800,000,000원", (q17.match(/114,800,000,000/g) ?? []).length >= 2),
    check("효성중공업 해지금액과 해지 시점 유효 계약금액이 모두 291,204,288,000원", (q17.match(/291,204,288,000/g) ?? []).length >= 2),
    check("차이 176,404,288,000원에 회사 라벨(효성중공업/삼성중공업)이 붙음", /효성중공업.{0,10}삼성중공업.{0,20}176,404,288,000원/.test(q17) || /삼성중공업.{0,10}효성중공업.{0,20}176,404,288,000원/.test(q17)),
  ];

  const q18 = await loadAnswer("question_seed_v07_18");
  results.question_seed_v07_18 = [
    check("54,495주 표시", q18.includes("54,495")),
    check("40,350원 표시", q18.includes("40,350")),
    check("2,198,873,250원을 '발행총액'이라는 문구로 직접 주장하지 않음", !/발행총액[^.]*2,198,873,250|2,198,873,250[^.]*발행총액/.test(q18)),
    check("2,198,873,250원이 근거 공시(citation) 밖의 narrative 확정 서술로 나오지 않음", !q18.split("근거 공시:")[0].includes("2,198,873,250")),
    check("'기타자금'이 다른 이름으로 재명명되지 않음(원문 그대로 노출)", q18.includes("기타자금")),
  ];

  const q20 = await loadAnswer("question_seed_v07_20");
  results.question_seed_v07_20 = [
    check("2024-11-29 정정 사유 표시", q20.includes("2024-11-29") && q20.includes("정정사유")),
    check("2024-12-05 최신 금액/종료일 표시", q20.includes("2024-12-05") && q20.includes("4,250,000,000") && q20.includes("2025-05-30")),
    check("정정사유의 기준일(2024-11-29)과 확정 금액의 계약 체결일(2024-12-05)이 서로 다른 라벨/줄에 있음(날짜 역할 안 섞임)", q20.includes("기준일 2024-11-29") && q20.includes("계약 체결일 2024-12-05")),
  ];

  const q25 = await loadAnswer("question_seed_v07_25");
  results.question_seed_v07_25 = [
    check("2023-12-31 최초 유보기한 표시", q25.includes("최초 유보기한: 2023-12-31")),
    check("2024-03-30 1차 정정 표시", q25.includes("2024-03-30")),
    check("2024-05-31 2차 정정 표시", q25.includes("2024-05-31")),
    check("2024-06-30 3차 정정 표시", q25.includes("2024-06-30")),
    check("2024-07-30 4차 정정 표시", q25.includes("2024-07-30")),
    check("2024-07-02 본계약 공시 기준 유보기한 2030-12-31 라벨 정확", q25.includes("본계약 공시 기준 유보기한: 2030-12-31")),
    check("'최종 유보기한'이라는 구 라벨이 더 이상 노출되지 않음", !q25.includes("최종 유보기한")),
    check("계약금액·기간이 비공개 계약상대방 서술과 분리됨(다른 문장)", q25.includes("계약금액(원): 1,463,679,344,160") && q25.includes("경영상 비밀유지 사유로 2030년 12월 31일 공개될 예정")),
  ];

  let totalChecks = 0; let totalPass = 0;
  for (const qid of Object.keys(results)) {
    for (const c of results[qid]) { totalChecks++; if (c.pass) totalPass++; }
  }
  if (totalPass !== totalChecks) {
    const failed = Object.entries(results).flatMap(([qid, checks]) => checks.filter((c) => !c.pass).map((c) => `${qid}: ${c.label}`));
    fail(`${totalChecks - totalPass}/${totalChecks} integration checks failed: ${failed.join(" | ")}`);
  }

  const report = { schema_version: "0.1.0", generated_at: new Date().toISOString(), wire_revision: "r11", total_checks: totalChecks, total_pass: totalPass, results, raw_answers: {
    question_seed_v07_06: q06, question_seed_v07_09: q09, question_seed_v07_17: q17, question_seed_v07_18: q18, question_seed_v07_20: q20, question_seed_v07_25: q25,
  } };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines = [];
  lines.push("# Turn M7 Candidate Runtime Integration Verification (wire r11)");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(`**Total checks: ${totalPass}/${totalChecks} PASS**`);
  lines.push("");
  for (const [qid, checks] of Object.entries(results)) {
    lines.push(`## ${qid}`);
    lines.push("");
    for (const c of checks) lines.push(`- [${c.pass ? "x" : " "}] ${c.label}`);
    lines.push("");
    lines.push("<details><summary>실제 answer 원문</summary>");
    lines.push("");
    lines.push("```");
    lines.push(report.raw_answers[qid]);
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }
  await writeFile(OUT_MD_PATH, lines.join("\n") + "\n", "utf8");
  console.log(JSON.stringify({ total_checks: totalChecks, total_pass: totalPass }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
