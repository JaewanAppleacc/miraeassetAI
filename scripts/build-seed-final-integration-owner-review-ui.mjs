// Turn M9: builds a fully offline, single-file HTML Owner review UI for
// Turn M8's final integration packet (the 6 questions the clean Plan
// v0.12 actually changed: Q06/Q09/Q17/Q18/Q20/Q25). This script ONLY
// generates a review tool -- it never touches Runtime/Composer/Plan/
// Fact/Evidence/Bundle/Release artifacts, and never creates or implies
// a v0.20 approval.
//
// Every input this script reads is hash-pinned twice: once before
// reading (asserted against the expected SHA-256 recorded in Turn M8's
// own report) and once after writing the HTML (to prove this script
// never mutated any of its own inputs). See buildReport.inputs below --
// that array is also the audit trail embedded in the build report JSON.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "work/handoff/seed-final-response-owner-review/ui/final-integration-v0.1";
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-v020-final-integration-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "final-integration-review-ui-build-report.json");

const TARGET_QUESTION_IDS = Object.freeze([
  "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17",
  "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
]);

// path -> expected sha256. Every one of these is re-hashed AFTER the
// build too (see verifyInputsUnchanged below) -- this script must never
// be the reason any of them changes.
const PINNED_INPUTS = Object.freeze({
  "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json":
    "cda1cb4a25d0462f470e0e0ec5551fb4c1262aec888e56e14c0ba8e2f61847e5",
  "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-wire-diff-analysis.v0.1.json":
    "103e022434575c9070f5129f8e80f304857e740e503c8181b22c986aa86703e5",
  "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl":
    "79e87d20982ef2c86eaaa64e8dddda68ce91e1d7d448a56f04426d1ce18298f2",
  "work/domain-seed/seed-facts-verified.v0.8.jsonl":
    "0492ece83ea65f08cc030ce5f4a1cf3cc408a3041b3c778975aa63f8ecbe057c",
  "work/domain-seed/seed-fact-coverage-verified.v0.7.json":
    "690b34bda825b7bebd9c975cdc77b3a55121e860b6cb54cb49c01aa1924b4a5d",
  "work/domain-seed/seed-structured-owner-decision.v0.10.jsonl":
    "9921417b1b0c26eef02dea3b32cb7fabcc0db2fae45c52883f3edeab20b75bcc",
  "work/handoff/seed-final-response-owner-review/results/seed-response-q18-owner-policy-decision.v0.1.json":
    "28d477f4eedd2d3c32221406095f7fdb1aa91f8c9300b5bfabcf641bb03fc80d",
  "domain/releases/bundles/seed-release-v0.20-r2.candidate/bundle-manifest.json":
    "126fbd3730b789fc9de904ba8fa5c37c734b7d97e1c0b8628d4a47d112d96025",
  "domain/releases/seed-release.v0.20-r2.candidate.manifest.json":
    "6c0c1706f68e40ae25c38ab4204f2c00d37143838401c57e28bfe3f15b5e3069",
  "domain/releases/seed-release.v0.20-r2.candidate.owner-decision-template.json":
    "580b0976eb790e0b004c949ebfda6acbe12b5b0decc20950e1c04a633ab67946",
  "domain/releases/seed-release.v0.20-r2.candidate.RELEASE_GATE_STATUS.json":
    "16db0f9faeaf38bb30822383a72c7627d3d692d46e7d9fc8af7298139edb5fe0",
});

// Section 4's literal per-question checklists -- reproduced verbatim
// from the Turn M9 instruction, never paraphrased, so the Owner sees
// exactly the text that was specified.
const SPECIFIC_CHECKLISTS = Object.freeze({
  question_seed_v07_06: [
    "2,680억원 ↔ 6,500ton급 Floating Crane ↔ 건조 효율성 증대가 한 묶음인가",
    "3,328억원 ↔ Floating Dock 확장 ↔ 생산량 증대가 한 묶음인가",
    "두 투자 건이 교차 귀속되지 않았는가",
    "투자 대상과 목적이 본문에 직접 표시됐는가",
    "이중 대시 등 부자연스러운 라벨이 없는가",
  ],
  question_seed_v07_09: [
    "신탁계약 금액 5,000억원이 표시됐는가",
    "NH투자증권이 계약상대방이 아니라 계약체결기관으로 표시됐는가",
    "취득 예정 수량 9,861,932주가 표시됐는가",
    "취득 완료에 따른 중도해지가 표시됐는가",
    "10,347,131주 소각이 표시됐는가",
    "결정일·계약 시작일·해지일·소각일이 구분됐는가",
    "내부 enum이 없는가",
  ],
  question_seed_v07_17: [
    "삼성중공업 114,800,000,000원이 표시됐는가",
    "효성중공업 291,204,288,000원이 표시됐는가",
    "각 유효 계약금액과 해지금액의 일치 여부를 회사별로 판정했는가",
    "차이 176,404,288,000원이 어느 회사 간 차이인지 명확한가",
    "정보한계와 회사 주장 귀속이 유지됐는가",
    "내부 enum이 없는가",
  ],
  question_seed_v07_18: [
    "정정 후 발행주식 수 54,495주가 표시됐는가",
    "주당 발행가액 40,350원이 표시됐는가",
    "발행 완료 여부와 날짜가 명확한가",
    "발행총액은 원문 직접 공시 항목으로 확인되지 않는다고 표시됐는가",
    "2,198,873,250원을 발행총액이라고 주장하지 않는가",
    "'기타자금'을 발행총액으로 재명명하지 않았는가",
    "파생 계산 미지원 한계가 자연스러운가",
  ],
  question_seed_v07_20: [
    "최초 계약금액 4,150,000,000원과 최신 4,250,000,000원이 구분되는가",
    "최신 종료일 2025-05-30이 명확한가",
    "최초 대비 100,000,000원 증가가 명확한가",
    "2024-11-29 정정 사유가 표시됐는가",
    "2024-12-05 최신 조건과 날짜 역할이 섞이지 않았는가",
    "내부 enum이 없는가",
  ],
  question_seed_v07_25: [
    "유보기한이 2023-12-31→2024-03-30→2024-05-31→2024-06-30→2024-07-30 순서로 표시됐는가",
    "2024-07-02 본계약 공시 기준 2030-12-31 공개 예정이 구분됐는가",
    "2030-12-31을 영구 확정된 최종 유보기한으로 표현하지 않는가",
    "본계약 체결·계약금액·계약기간이 명확한가",
    "여전히 비공개인 계약상대방이 구분되는가",
    "내부 enum이 없는가",
  ],
});

const COMMON_CHECKLIST = Object.freeze([
  "질문의 모든 요구에 답했는가",
  "숫자·날짜·회사·단위가 명확한가",
  "내부 enum/snake_case/corp_code가 없는가",
  "반복·부자연스러운 문장이 없는가",
  "승인하지 않은 사실이 추가되지 않았는가",
  "정보한계와 귀속이 정직한가",
]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M9_UI_BUILD_BLOCKED: ${msg}`); }
async function readAbs(rel) { return readFile(path.join(REPO, rel)); }

async function verifyPinnedInputs() {
  const hashes = {};
  for (const [rel, expected] of Object.entries(PINNED_INPUTS)) {
    const bytes = await readAbs(rel);
    const actual = sha256(bytes);
    if (actual !== expected) fail(`${rel}: sha256 mismatch (expected ${expected}, actual ${actual})`);
    hashes[rel] = actual;
  }
  return hashes;
}

function wirePath(rev, qid) { return `work/domain-seed/seed-harness-v07-wire.r${rev}/${qid}.response.json`; }

async function loadWireRecord(rev, qid) {
  const relPath = wirePath(rev, qid);
  const bytes = await readAbs(relPath);
  const sha = sha256(bytes);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const thinkTrace = typeof parsed.think_trace === "string" ? JSON.parse(parsed.think_trace) : parsed.think_trace;
  const retrievedContext = typeof parsed.retrieved_context === "string" ? JSON.parse(parsed.retrieved_context) : parsed.retrieved_context;
  return { path: relPath, sha256: sha, raw: parsed, thinkTrace, retrievedContext };
}

// Safe embedding: JSON.stringify never emits a raw "<" outside a quoted
// string (JSON's own syntax characters are {}[]:,"and value literals,
// none of which contain "<"), so blanket-replacing "<" with its unicode
// escape is always still valid JSON afterward, and structurally cannot
// leave a "</script" or "<!--" boundary anywhere in the embedded text.
export function escapeForScriptEmbedding(jsonText) {
  return jsonText.replace(/</g, "\\u003c");
}

async function main() {
  const inputHashesBefore = await verifyPinnedInputs();

  const packet = JSON.parse((await readAbs("work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json")).toString("utf8"));
  const diffAnalysis = JSON.parse((await readAbs("work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-wire-diff-analysis.v0.1.json")).toString("utf8"));

  const packetQids = Object.keys(packet.questions);
  const packetQidSet = new Set(packetQids);
  if (packetQidSet.size !== packetQids.length) fail("integration packet has duplicate question_id keys");
  const targetSet = new Set(TARGET_QUESTION_IDS);
  if (targetSet.size !== TARGET_QUESTION_IDS.length) fail("TARGET_QUESTION_IDS has an internal duplicate");
  const missing = TARGET_QUESTION_IDS.filter((qid) => !packetQidSet.has(qid));
  const extra = packetQids.filter((qid) => !targetSet.has(qid));
  if (missing.length > 0) fail(`integration packet is missing target question(s): ${missing.join(",")}`);
  if (extra.length > 0) fail(`integration packet has unexpected extra question(s) beyond the 6-question scope: ${extra.join(",")}`);
  if (packetQids.length !== 6) fail(`expected exactly 6 questions, found ${packetQids.length}`);

  const diffByQid = new Map(diffAnalysis.rows.map((r) => [r.question_id, r]));
  for (const qid of TARGET_QUESTION_IDS) {
    if (!diffByQid.has(qid)) fail(`${qid}: not found in wire diff analysis rows`);
    if (!SPECIFIC_CHECKLISTS[qid] || SPECIFIC_CHECKLISTS[qid].length === 0) fail(`${qid}: no specific checklist defined`);
  }

  const records = [];
  for (const qid of TARGET_QUESTION_IDS) {
    const q = packet.questions[qid];
    const diffRow = diffByQid.get(qid);
    const r10 = await loadWireRecord(10, qid);
    const r13 = await loadWireRecord(13, qid);
    if (r10.sha256 !== diffRow.r10_sha256) fail(`${qid}: r10 wire sha256 does not match diff analysis pin`);
    if (r13.sha256 !== diffRow.r13_sha256) fail(`${qid}: r13 wire sha256 does not match diff analysis pin`);
    if (r13.raw.answer !== q.r13_answer) fail(`${qid}: wire r13 answer does not match integration packet's r13_answer`);
    if (r10.raw.answer !== q.r10_answer) fail(`${qid}: wire r10 answer does not match integration packet's r10_answer`);

    records.push({
      question_id: qid,
      question_text: q.question_text,
      r10_answer: q.r10_answer,
      r13_answer: q.r13_answer,
      answer_changed: q.answer_changed,
      r10_sha256: r10.sha256,
      r13_sha256: r13.sha256,
      added_slots: q.added_slots,
      applied_facts: q.applied_facts,
      information_limits: q.information_limits,
      automated_verification: q.automated_verification,
      diff_category: diffRow.category,
      diff_reason: diffRow.reason,
      synthesis: r13.thinkTrace?.validation?.synthesis ?? null,
      answerability: r13.thinkTrace?.validation?.answerability ?? null,
      execution_mode: r13.thinkTrace?.execution_mode ?? null,
      evidence: (r13.retrievedContext ?? []).map((e) => ({
        evidence_id: e.evidence_id, document_id: e.document_id, source_locator: e.source_locator, quoted_text: e.quoted_text,
      })),
      raw_r10_wire: r10.raw,
      raw_r13_wire: { ...r13.raw, think_trace: r13.thinkTrace, retrieved_context: r13.retrievedContext },
      specific_checklist: SPECIFIC_CHECKLISTS[qid],
    });
  }

  const payload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    integration_packet_path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json",
    integration_packet_sha256: PINNED_INPUTS["work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json"],
    wire_diff_analysis_path: "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-wire-diff-analysis.v0.1.json",
    wire_diff_analysis_sha256: PINNED_INPUTS["work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-wire-diff-analysis.v0.1.json"],
    plan_path: "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl",
    plan_sha256: PINNED_INPUTS["work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl"],
    common_checklist: COMMON_CHECKLIST,
    final_export_filename: "seed-v020-final-integration-owner-decision.v0.1.jsonl",
    localstorage_key_prefix: "seed-v020-final-integration-review::",
    default_reviewer: "최재완",
    records,
  };

  const html = renderHtml(payload);
  await mkdir(path.join(REPO, OUT_DIR), { recursive: true });
  await writeFile(path.join(REPO, OUT_HTML_PATH), html, "utf8");

  const inputHashesAfter = await verifyPinnedInputs();
  for (const rel of Object.keys(PINNED_INPUTS)) {
    if (inputHashesBefore[rel] !== inputHashesAfter[rel]) fail(`${rel}: sha256 changed during build -- this script must never mutate its own inputs`);
  }

  const htmlBytes = await readAbs(OUT_HTML_PATH);
  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    output_html_path: OUT_HTML_PATH,
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    final_export_filename: payload.final_export_filename,
    localstorage_key: `${payload.localstorage_key_prefix}${payload.integration_packet_sha256}`,
    target_question_ids: TARGET_QUESTION_IDS,
    inputs: Object.entries(PINNED_INPUTS).map(([relPath, expectedSha256]) => ({
      path: relPath, sha256: expectedSha256, unchanged_after_build: inputHashesBefore[relPath] === inputHashesAfter[relPath],
    })),
  };
  await writeFile(path.join(REPO, OUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    output_html_path: OUT_HTML_PATH, output_html_sha256: report.output_html_sha256, output_html_bytes: report.output_html_bytes,
    build_report_path: OUT_REPORT_PATH, target_question_count: TARGET_QUESTION_IDS.length,
  }, null, 2));
}

function renderHtml(payload) {
  const escapedJson = escapeForScriptEmbedding(JSON.stringify(payload));
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Turn M8 v0.20-r2 Candidate 최종 통합 검수</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${CSS}
</style>
</head>
<body>
<header id="app-header">
  <h1>v0.20-r2 Candidate 최종 통합 검수 (Turn M8 산출물)</h1>
  <div id="progress-bar"><span id="progress-counter">0/6</span> 판정 완료</div>
  <div id="header-actions">
    <button id="export-draft-btn" type="button">Draft JSONL export</button>
    <button id="export-final-btn" type="button" disabled>FINAL export (6/6 필요)</button>
    <button id="reset-btn" type="button">초기화</button>
  </div>
  <p class="hint">이 페이지는 완전 오프라인이며, 판정은 이 브라우저의 localStorage에만 저장됩니다. 자동 승인은 없습니다.</p>
</header>
<main id="app"></main>
<section id="export-panel" hidden>
  <h2 id="export-panel-title"></h2>
  <textarea id="export-output" readonly rows="10"></textarea>
</section>
<script type="application/json" id="review-data">${escapedJson}</script>
<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}

const CSS = `
:root { color-scheme: light; --border:#d0d5dd; --bg:#f8f9fb; --card-bg:#ffffff; --accent:#1d4ed8; --danger:#b42318; --warn:#b54708; --ok:#067647; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; margin: 0; background: var(--bg); color: #111827; line-height: 1.5; }
header#app-header { position: sticky; top: 0; z-index: 10; background: #111827; color: #fff; padding: 12px 20px; }
header h1 { font-size: 16px; margin: 0 0 6px; }
#progress-bar { font-size: 14px; margin-bottom: 8px; }
#progress-counter { font-weight: 700; font-size: 16px; }
#header-actions button { margin-right: 8px; padding: 6px 12px; border-radius: 6px; border: 1px solid #374151; background: #1f2937; color: #fff; cursor: pointer; }
#header-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.hint { font-size: 12px; color: #cbd5e1; margin: 4px 0 0; }
main#app { max-width: 1100px; margin: 20px auto; padding: 0 16px; }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 24px; overflow: hidden; }
.card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); background: #f2f4f7; }
.card-header h2 { font-size: 15px; margin: 0; font-family: monospace; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge-disposition-PENDING { background: #eef2ff; color: #3730a3; }
.badge-disposition-APPROVE_RESPONSE { background: #ecfdf3; color: var(--ok); }
.badge-disposition-FIX_REQUIRED { background: #fffaeb; color: var(--warn); }
.badge-disposition-REJECT { background: #fef3f2; color: var(--danger); }
.badge-status-PASS { background: #ecfdf3; color: var(--ok); }
.badge-status-PARTIAL { background: #fffaeb; color: var(--warn); }
.badge-status-FAIL_CLOSED { background: #fef3f2; color: var(--danger); }
.card-body { padding: 18px; }
.question-text { font-size: 15px; font-weight: 600; margin: 0 0 14px; }
.section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin: 18px 0 8px; }
.section-title:first-of-type { margin-top: 0; }
.answer-box { font-size: 17px; white-space: pre-wrap; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
.checklist { list-style: none; margin: 0 0 8px; padding: 0; }
.checklist li { padding: 4px 0; font-size: 14px; display: flex; align-items: flex-start; gap: 8px; }
.checklist input { margin-top: 3px; }
.auto-checks { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.auto-checks li { padding: 3px 0; }
.check-pass::before { content: "PASS "; color: var(--ok); font-weight: 700; }
.check-fail::before { content: "FAIL "; color: var(--danger); font-weight: 700; }
.diff-box { font-size: 13px; white-space: pre-wrap; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #fafafa; }
.diff-same { color: #374151; }
.diff-added { background: #dcfce7; color: #065f46; display: block; }
.diff-removed { background: #fee2e2; color: #991b1b; text-decoration: line-through; display: block; }
table.fact-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
table.fact-table th, table.fact-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
.warning-badge { display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: #fffaeb; color: var(--warn); border: 1px solid #fed7aa; }
.evidence-item { font-size: 13px; border-bottom: 1px dashed var(--border); padding: 6px 0; }
details.raw-json { margin-top: 10px; }
details.raw-json pre { max-height: 320px; overflow: auto; background: #111827; color: #d1fae5; padding: 10px; border-radius: 6px; font-size: 11px; }
.judgement-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.judgement-actions button { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-size: 13px; }
button.act-approve { background: #ecfdf3; border-color: #a6f4c5; color: var(--ok); }
button.act-fix { background: #fffaeb; border-color: #fed7aa; color: var(--warn); }
button.act-reject { background: #fef3f2; border-color: #fda29b; color: var(--danger); }
textarea.notes { width: 100%; min-height: 60px; font-size: 13px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); }
.info-limit-gate { font-size: 13px; margin: 8px 0; }
.judgement-error { color: var(--danger); font-size: 13px; margin: 6px 0; min-height: 16px; }
#export-panel { max-width: 1100px; margin: 0 auto 40px; padding: 0 16px; }
#export-output { width: 100%; font-family: monospace; font-size: 12px; }
`;

// Embedded verbatim as a plain string (no template-literal interpolation
// of user data -- this is the ENTIRE client script, self-contained, zero
// network calls, zero innerHTML). Kept as one string so the build script
// can inject it byte-for-byte without any escaping concerns of its own.
const CLIENT_SCRIPT = String.raw`
(function () {
  "use strict";
  var dataEl = document.getElementById("review-data");
  var payload = JSON.parse(dataEl.textContent);
  var STORAGE_KEY = payload.localstorage_key_prefix + payload.integration_packet_sha256;
  var DISPOSITIONS = ["APPROVE_RESPONSE", "FIX_REQUIRED", "REJECT"];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.indexOf("data-") === 0) node.setAttribute(k, attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function txt(s) { return document.createTextNode(s == null ? "" : String(s)); }

  // ---- state -------------------------------------------------------
  function defaultRecordState() {
    return { owner_disposition: "PENDING", reviewer: null, reviewed_at: null, notes: null, checklist: {}, information_limit_accepted: null };
  }
  function loadState() {
    var out = {};
    payload.records.forEach(function (r) { out[r.question_id] = defaultRecordState(); });
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        payload.records.forEach(function (r) {
          if (parsed[r.question_id]) out[r.question_id] = Object.assign(defaultRecordState(), parsed[r.question_id]);
        });
      }
    } catch (e) { /* corrupted localStorage -- fall back to defaults, never throw */ }
    return out;
  }
  var state = loadState();
  function saveState() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable -- in-memory state still works */ }
  }

  // ---- diff (line-level LCS) ----------------------------------------
  function lcsDiffLines(a, b) {
    var al = a.split("\n"); var bl = b.split("\n");
    var n = al.length; var m = bl.length;
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (al[i] === bl[j]) { out.push({ type: "same", text: al[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "removed", text: al[i] }); i++; }
      else { out.push({ type: "added", text: bl[j] }); j++; }
    }
    while (i < n) { out.push({ type: "removed", text: al[i] }); i++; }
    while (j < m) { out.push({ type: "added", text: bl[j] }); j++; }
    return out;
  }

  // ---- automated warning detectors (Section 7 -- display only, never
  // auto-change disposition) ------------------------------------------
  function detectWarnings(record) {
    var answer = record.r13_answer;
    var narrative = answer.split("근거 공시:")[0];
    var warnings = [];
    function add(code, label, matched, detail) { if (matched) warnings.push({ code: code, label: label, detail: detail || "" }); }

    var snakeMatches = answer.match(/\b[a-z]{2,}(?:_[a-z0-9]{2,})+\b/g);
    add("SNAKE_CASE", "snake_case 토큰", !!snakeMatches, snakeMatches ? snakeMatches.join(", ") : "");

    var corpCodeMatches = answer.match(/\b\d{8}\b/g);
    add("CORP_CODE_8DIGIT", "8자리 corp_code 의심", !!corpCodeMatches, corpCodeMatches ? corpCodeMatches.join(", ") : "");

    var enumMatches = answer.match(/\b[A-Z]{2,}(?:_[A-Z0-9]{2,})+\b/g);
    add("RAW_ENUM", "raw enum 토큰", !!enumMatches, enumMatches ? enumMatches.join(", ") : "");

    var particleMatches = answer.match(/(와\(과\)|은\(는\)|이\(가\)|을\(를\))/g);
    add("UNRESOLVED_PARTICLE", "와(과) 등 미해소 조사", !!particleMatches, particleMatches ? particleMatches.join(", ") : "");

    var lines = answer.split("\n").filter(function (l) { return l.trim().length > 0; });
    var seen = {}; var dup = [];
    lines.forEach(function (l) { if (seen[l]) dup.push(l); else seen[l] = true; });
    add("DUPLICATE_SENTENCE", "중복 문장", dup.length > 0, dup.join(" | "));

    var synthStatus = record.synthesis ? record.synthesis.status : null;
    add("SYNTHESIS_NOT_PASS", "synthesis status가 PASS가 아님 (" + synthStatus + ")", synthStatus !== "PASS", synthStatus || "");
    var reasons = (record.synthesis && record.synthesis.reasons) || [];
    var failClosed = reasons.some(function (rs) { return String(rs.code || rs).indexOf("FAIL_CLOSED") !== -1; });
    add("FAIL_CLOSED_REASON", "FAIL_CLOSED 사유 존재", failClosed, JSON.stringify(reasons));

    var missingCaps = (record.synthesis && record.synthesis.missing_capabilities) || [];
    add("MISSING_CAPABILITIES", "missing_capabilities 존재", missingCaps.length > 0, missingCaps.join(", "));

    var numberMatches = answer.match(/\d{1,3}(,\d{3})+/g) || [];
    var unclear = numberMatches.filter(function (num) {
      var idx = answer.indexOf(num);
      var after = answer.slice(idx + num.length, idx + num.length + 3);
      return !/^\s*(원|%|주|건|년|월|일|개|명|톤|ton)/.test(after);
    });
    add("UNCLEAR_NUMBER_LABEL", "숫자 라벨 불명확 의심", unclear.length > 0, unclear.join(", "));

    if (record.question_id === "question_seed_v07_18") {
      add("Q18_ISSUANCE_AMOUNT_NARRATIVE_NUMBER", "Q18 서술부에 2,198,873,250 등장", narrative.indexOf("2,198,873,250") !== -1);
    }
    if (record.question_id === "question_seed_v07_09") {
      var counterpartyLine = answer.split("\n").some(function (l) { return l.indexOf("계약상대방") !== -1 && l.indexOf("NH투자증권") !== -1; });
      add("Q09_COUNTERPARTY_WORDING", "'계약상대방 NH투자증권' 표현 의심", counterpartyLine);
    }
    if (record.question_id === "question_seed_v07_25") {
      add("Q25_FINAL_RESERVATION_WORDING", "'최종 확정 유보기한' 표현 의심", answer.indexOf("최종 확정 유보기한") !== -1);
    }
    return warnings;
  }

  // ---- card rendering -------------------------------------------------
  function renderChecklist(items, kind, qid) {
    var ul = el("ul", { className: "checklist", "data-checklist-kind": kind });
    items.forEach(function (itemText, idx) {
      var checkboxId = "chk-" + kind + "-" + qid + "-" + idx;
      var checked = !!(state[qid].checklist[kind] && state[qid].checklist[kind][idx]);
      var input = el("input", { type: "checkbox", id: checkboxId, "data-kind": kind, "data-idx": String(idx) });
      input.checked = checked;
      input.addEventListener("change", function () {
        if (!state[qid].checklist[kind]) state[qid].checklist[kind] = {};
        state[qid].checklist[kind][idx] = input.checked;
        saveState();
      });
      var label = el("label", { for: checkboxId }, [txt(itemText)]);
      ul.appendChild(el("li", null, [input, label]));
    });
    return ul;
  }

  function renderDiff(r10, r13) {
    var ops = lcsDiffLines(r10, r13);
    var box = el("div", { className: "diff-box" });
    ops.forEach(function (op) {
      if (op.type === "same") { box.appendChild(el("span", { className: "diff-same" }, [txt(op.text)])); box.appendChild(document.createElement("br")); }
      else if (op.type === "added") { box.appendChild(el("span", { className: "diff-added" }, [txt("+ " + op.text)])); }
      else { box.appendChild(el("span", { className: "diff-removed" }, [txt("- " + op.text)])); }
    });
    return box;
  }

  function renderFactTable(facts) {
    var table = el("table", { className: "fact-table" });
    var thead = el("tr", null, ["fact_id", "slot_name", "metric_code", "raw_label", "값", "value_status"].map(function (h) { return el("th", null, [txt(h)]); }));
    table.appendChild(el("thead", null, [thead]));
    var tbody = el("tbody");
    (facts || []).forEach(function (f) {
      var value = f.normalized_value != null ? String(f.normalized_value) : (f.raw_value_text || "");
      tbody.appendChild(el("tr", null, [
        el("td", null, [txt(f.fact_id)]), el("td", null, [txt(f.slot_name)]), el("td", null, [txt(f.metric_code)]),
        el("td", null, [txt(f.raw_label)]), el("td", null, [txt(value)]), el("td", null, [txt(f.value_status)]),
      ]));
    });
    table.appendChild(tbody);
    return table;
  }

  function renderInformationLimits(limits) {
    if (!limits || limits.length === 0) return el("p", null, [txt("(information_limits 없음)")]);
    var wrap = el("div");
    limits.forEach(function (decl) {
      wrap.appendChild(el("p", null, [txt("target_metric_code: " + decl.target_metric_code + " / reason_code: " + decl.reason_code + " / calculation_status: " + decl.calculation_status)]));
      var ul = el("ul");
      (decl.available_input_facts || []).forEach(function (f) {
        ul.appendChild(el("li", null, [txt(f.fact_id + " -- " + f.raw_label + ": " + (f.raw_value_text || ""))]));
      });
      wrap.appendChild(ul);
    });
    return wrap;
  }

  function renderEvidence(evidence) {
    var wrap = el("div");
    (evidence || []).forEach(function (e) {
      wrap.appendChild(el("div", { className: "evidence-item" }, [
        txt(e.document_id + " | " + e.source_locator + " -- “" + e.quoted_text + "”"),
      ]));
    });
    return wrap;
  }

  function renderRawJson(record) {
    var details = el("details", { className: "raw-json" });
    details.appendChild(el("summary", null, [txt("think_trace / validation / 원본 wire JSON 펼치기")]));
    var pre = el("pre");
    pre.textContent = JSON.stringify({ r10: record.raw_r10_wire, r13: record.raw_r13_wire }, null, 2);
    details.appendChild(pre);
    return details;
  }

  function buildRecord(qid) {
    var record = payload.records.filter(function (r) { return r.question_id === qid; })[0];
    var s = state[qid];
    var checklistResults = { common: payload.common_checklist.map(function (text, idx) { return { text: text, checked: !!(s.checklist.common && s.checklist.common[idx]) }; }),
      specific: record.specific_checklist.map(function (text, idx) { return { text: text, checked: !!(s.checklist.specific && s.checklist.specific[idx]) }; }) };
    var releaseRecommendation = s.owner_disposition === "APPROVE_RESPONSE" ? "READY_FOR_V020_CONSIDERATION"
      : s.owner_disposition === "FIX_REQUIRED" ? "NEEDS_FIX_BEFORE_V020"
      : s.owner_disposition === "REJECT" ? "BLOCKS_V020" : "PENDING_REVIEW";
    return {
      review_item_id: "turn_m9_final_integration_" + qid,
      question_id: qid,
      integration_packet_path: payload.integration_packet_path,
      integration_packet_sha256: payload.integration_packet_sha256,
      r13_response_sha256: record.r13_sha256,
      owner_disposition: s.owner_disposition,
      reviewer: s.reviewer,
      reviewed_at: s.reviewed_at,
      notes: s.notes,
      checklist_results: checklistResults,
      information_limit_accepted: s.information_limit_accepted,
      release_recommendation: releaseRecommendation,
    };
  }

  function buildExportLines(mode) {
    if (mode === "final") {
      var notDone = payload.records.filter(function (r) { return state[r.question_id].owner_disposition === "PENDING"; });
      if (notDone.length > 0) {
        throw new Error("FINAL export requires all 6 questions to be judged (PENDING remaining: " + notDone.map(function (r) { return r.question_id; }).join(",") + ")");
      }
      var q18State = state["question_seed_v07_18"];
      if (q18State.owner_disposition === "APPROVE_RESPONSE" && q18State.information_limit_accepted !== true) {
        throw new Error("FINAL export blocked: Q18 is APPROVE_RESPONSE but information_limit_accepted is not true");
      }
    }
    return payload.records.map(function (r) { return JSON.stringify(buildRecord(r.question_id)); });
  }

  function updateProgress() {
    var done = payload.records.filter(function (r) { return state[r.question_id].owner_disposition !== "PENDING"; }).length;
    document.getElementById("progress-counter").textContent = done + "/6";
    var finalBtn = document.getElementById("export-final-btn");
    finalBtn.disabled = done < 6;
    finalBtn.textContent = done < 6 ? "FINAL export (6/6 필요)" : "FINAL export";
  }

  function renderCard(record) {
    var qid = record.question_id;
    var s = state[qid];

    var badgeDisposition = el("span", { className: "badge badge-disposition-" + s.owner_disposition, "data-role": "badge-disposition" }, [txt(s.owner_disposition)]);
    var synthStatus = record.synthesis ? record.synthesis.status : "UNKNOWN";
    var badgeStatus = el("span", { className: "badge badge-status-" + synthStatus }, [txt("synthesis: " + synthStatus)]);
    var passCount = record.automated_verification.pass_count + "/" + record.automated_verification.total;
    var badgePass = el("span", { className: "badge" }, [txt("자동검사 " + passCount)]);

    var header = el("div", { className: "card-header" }, [
      el("h2", null, [txt(qid)]), badgeDisposition, badgeStatus, badgePass,
    ]);

    var body = el("div", { className: "card-body" });
    body.appendChild(el("p", { className: "question-text" }, [txt(record.question_text)]));

    // B. most important
    body.appendChild(el("div", { className: "section-title" }, [txt("r13 최종 답변")]));
    body.appendChild(el("div", { className: "answer-box" }, [txt(record.r13_answer)]));

    body.appendChild(el("div", { className: "section-title" }, [txt("Owner 체크리스트 (질문별)")]));
    body.appendChild(renderChecklist(record.specific_checklist, "specific", qid));
    body.appendChild(el("div", { className: "section-title" }, [txt("Owner 체크리스트 (공통)")]));
    body.appendChild(renderChecklist(payload.common_checklist, "common", qid));

    body.appendChild(el("div", { className: "section-title" }, [txt("자동검증 결과")]));
    var autoUl = el("ul", { className: "auto-checks" });
    record.automated_verification.checks.forEach(function (c) {
      autoUl.appendChild(el("li", { className: c.pass ? "check-pass" : "check-fail" }, [txt(c.label)]));
    });
    body.appendChild(autoUl);

    var warnings = detectWarnings(record);
    if (warnings.length > 0) {
      body.appendChild(el("div", { className: "section-title" }, [txt("자동 경고 (판정 자동 변경 없음)")]));
      var warnWrap = el("div");
      warnings.forEach(function (w) { warnWrap.appendChild(el("span", { className: "warning-badge", title: w.detail }, [txt(w.label)])); });
      body.appendChild(warnWrap);
    }

    // C. comparison
    body.appendChild(el("div", { className: "section-title" }, [txt("r10 -> r13 비교 (변경 사유: " + record.diff_reason + ")")]));
    body.appendChild(renderDiff(record.r10_answer, record.r13_answer));

    body.appendChild(el("div", { className: "section-title" }, [txt("적용된 승인 Fact (추가 슬롯: " + (record.added_slots.join(", ") || "없음") + ")")]));
    body.appendChild(renderFactTable(record.applied_facts));

    body.appendChild(el("div", { className: "section-title" }, [txt("information_limits")]));
    body.appendChild(renderInformationLimits(record.information_limits));

    // D. evidence
    body.appendChild(el("div", { className: "section-title" }, [txt("근거 Evidence")]));
    body.appendChild(renderEvidence(record.evidence));
    body.appendChild(renderRawJson(record));

    // judgement
    body.appendChild(el("div", { className: "section-title" }, [txt("Owner 판정")]));
    var errorBox = el("div", { className: "judgement-error", "data-role": "judgement-error" });

    var infoLimitCheckbox = null;
    if (qid === "question_seed_v07_18") {
      var gate = el("div", { className: "info-limit-gate" });
      infoLimitCheckbox = el("input", { type: "checkbox", id: "info-limit-accepted-" + qid, "data-role": "info-limit-accepted" });
      infoLimitCheckbox.checked = s.information_limit_accepted === true;
      infoLimitCheckbox.addEventListener("change", function () {
        state[qid].information_limit_accepted = infoLimitCheckbox.checked ? true : (s.owner_disposition === "PENDING" ? null : state[qid].information_limit_accepted);
        saveState();
      });
      gate.appendChild(infoLimitCheckbox);
      gate.appendChild(el("label", { for: "info-limit-accepted-" + qid }, [txt(" 발행총액 정보한계 문구를 승인합니다 (information_limit_accepted) -- APPROVE_RESPONSE 선택 전 필수")]));
      body.appendChild(gate);
    }

    var notes = el("textarea", { className: "notes", id: "notes-" + qid, placeholder: "notes (선택)", "data-role": "notes" });
    notes.value = s.notes || "";

    var actions = el("div", { className: "judgement-actions" });
    var classMap = { APPROVE_RESPONSE: "act-approve", FIX_REQUIRED: "act-fix", REJECT: "act-reject" };
    DISPOSITIONS.forEach(function (disp) {
      var btn = el("button", { type: "button", className: classMap[disp], "data-action": disp, "data-question-id": qid }, [txt(disp)]);
      btn.addEventListener("click", function () {
        errorBox.textContent = "";
        if (qid === "question_seed_v07_18" && disp === "APPROVE_RESPONSE") {
          var accepted = infoLimitCheckbox && infoLimitCheckbox.checked === true;
          if (!accepted) {
            errorBox.textContent = "Q18은 information_limit_accepted 체크 없이 APPROVE_RESPONSE 할 수 없습니다.";
            return;
          }
          state[qid].information_limit_accepted = true;
        }
        state[qid].owner_disposition = disp;
        state[qid].reviewer = payload.default_reviewer;
        state[qid].reviewed_at = new Date().toISOString();
        state[qid].notes = notes.value || null;
        saveState();
        badgeDisposition.className = "badge badge-disposition-" + disp;
        badgeDisposition.textContent = disp;
        updateProgress();
      });
      actions.appendChild(btn);
    });
    notes.addEventListener("input", function () { state[qid].notes = notes.value || null; saveState(); });

    body.appendChild(notes);
    body.appendChild(actions);
    body.appendChild(errorBox);

    var card = el("div", { className: "card", "data-question-id": qid });
    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function renderAll() {
    var app = document.getElementById("app");
    while (app.firstChild) app.removeChild(app.firstChild);
    payload.records.forEach(function (r) { app.appendChild(renderCard(r)); });
    updateProgress();
  }

  function doExport(mode) {
    var panel = document.getElementById("export-panel");
    var title = document.getElementById("export-panel-title");
    var output = document.getElementById("export-output");
    try {
      var lines = buildExportLines(mode);
      panel.hidden = false;
      title.textContent = mode === "final" ? payload.final_export_filename : "draft.jsonl";
      output.value = lines.join("\n");
    } catch (e) {
      panel.hidden = false;
      title.textContent = "export blocked";
      output.value = "ERROR: " + e.message;
    }
  }

  document.getElementById("export-draft-btn").addEventListener("click", function () { doExport("draft"); });
  document.getElementById("export-final-btn").addEventListener("click", function () { doExport("final"); });
  document.getElementById("reset-btn").addEventListener("click", function () {
    var ok = window.confirm("정말 초기화하시겠습니까? 모든 판정이 삭제됩니다.");
    if (!ok) return;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state = {};
    payload.records.forEach(function (r) { state[r.question_id] = defaultRecordState(); });
    renderAll();
  });

  window.__seedFinalIntegrationReview = { buildExportLines: buildExportLines, buildRecord: buildRecord, getState: function () { return state; } };

  renderAll();
})();
`;

main().catch((error) => { console.error(error.message); process.exit(1); });
