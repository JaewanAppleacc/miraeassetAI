#!/usr/bin/env node
// Turn N4.20.1: builds the CORRECTED Gold-300 Authoring Owner review UI,
// replacing N4.20's v0.1 UI (marked superseded, never deleted). This UI
// separates plan approval from row-level authoring authorization: even a
// genuine APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING never authorizes
// the 81 currently-BLOCKED rows, HOLDOUT Agent access/evaluation,
// production wiring, Agent ranking, or relation-decision promotion --
// every one of those stays hard-coded false in every code path this
// script or its UI's JavaScript can produce.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const GOLD_300_DIR = resolve(V02_DIR, "gold-300-v0.1");
const AUTHORING_V02_DIR = resolve(V02_DIR, "gold-authoring-300-v0.2");
const ELIGIBILITY_BY_AUTHOR_PATH = resolve(AUTHORING_V02_DIR, "gold-300-eligibility-by-author-v0.2.json");
const PACKET_MANIFEST_V01_PATH = resolve(V02_DIR, "gold-authoring-300-v0.1/gold-authoring-300-packet-manifest.v0.1.json");
const OFFICIAL_SPLIT_DECISION_PATH = resolve(V02_DIR, "component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json");

export const OUT_DIR = resolve(AUTHORING_V02_DIR, "owner-review-v0.2");
export const UI_DIR = resolve(OUT_DIR, "ui/v0.2");

const APPROVE_DISPOSITION = "APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING";
const EXPORT_FILENAME = "gold-300-authoring-owner-decision.v0.2.json";

export function buildGold300OwnerReviewV02({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const eligByAuthor = readJson(ELIGIBILITY_BY_AUTHOR_PATH);
  if (!eligByAuthor.n4_20_inputs_unmodified) throw new Error("buildGold300OwnerReviewV02: N4.20.1 re-verification reported N4.20 inputs were modified -- refusing to build a UI on top of that");
  const packetManifest = readJson(PACKET_MANIFEST_V01_PATH);
  const officialSplitDecision = readJson(OFFICIAL_SPLIT_DECISION_PATH);

  const UI_DATA = {
    export_filename: EXPORT_FILENAME,
    approve_disposition: APPROVE_DISPOSITION,
    total_plan_count: eligByAuthor.total_plan_count,
    author_a_assigned_count: eligByAuthor.author_a_assigned_count,
    author_b_assigned_count: eligByAuthor.author_b_assigned_count,
    immediately_authorizable_count: eligByAuthor.immediately_authorizable_count,
    manual_review_required_count: eligByAuthor.manual_review_required_count,
    blocked_count: eligByAuthor.blocked_count,
    author_a_immediately_authorizable_count: eligByAuthor.author_a_immediately_authorizable_count,
    author_b_immediately_authorizable_count: eligByAuthor.author_b_immediately_authorizable_count,
    author_a_blocked_count: eligByAuthor.author_a_blocked_count,
    author_b_blocked_count: eligByAuthor.author_b_blocked_count,
    per_author: eligByAuthor.per_author,
    packet_a_sha256: packetManifest.author_a.sha256,
    packet_b_sha256: packetManifest.author_b.sha256,
    official_split_decision_id: officialSplitDecision.decision_id,
    checklist_items: [
      { id: "total_300_confirmed", label: `총 Gold 후보가 ${eligByAuthor.total_plan_count}건임을 확인했다` },
      { id: "author_ab_150_150_confirmed", label: `AUTHOR_A/AUTHOR_B가 각각 ${eligByAuthor.author_a_assigned_count}/${eligByAuthor.author_b_assigned_count}건임을 확인했다` },
      { id: "anchor_expansion_75_75_confirmed", label: "각 작업자의 Anchor 75 + Expansion 75 = 150 구성을 확인했다" },
      { id: "eligibility_distribution_confirmed", label: `eligible ${eligByAuthor.immediately_authorizable_count} / manual review ${eligByAuthor.manual_review_required_count} / blocked ${eligByAuthor.blocked_count} 분포를 확인했다 (A: eligible ${eligByAuthor.author_a_immediately_authorizable_count}/blocked ${eligByAuthor.author_a_blocked_count}, B: eligible ${eligByAuthor.author_b_immediately_authorizable_count}/blocked ${eligByAuthor.author_b_blocked_count})` },
      { id: "blocked_not_auto_authorized", label: `blocked ${eligByAuthor.blocked_count}건이 이 승인으로 자동 허가되지 않음을 이해했다` },
      { id: "provisional_relation_not_auto_confirmed", label: "provisional relation이 이 승인으로 자동 확정되지 않음을 이해했다" },
      { id: "parse_failed_not_auto_remediated", label: "parse failed 문서가 이 승인으로 자동 보완되지 않음을 이해했다" },
      { id: "holdout_authoring_vs_agent_eval_separated", label: "지정 작성자의 HOLDOUT Gold 작성과 Agent의 HOLDOUT 접근/평가가 분리되어 있음을 이해했다 (작성=허용 가능, Agent 접근/평가=항상 불허)" },
      { id: "production_ranking_not_authorized", label: "이 승인이 production 배선이나 Agent ranking을 허가하지 않음을 이해했다" },
      { id: "zero_authored_confirmed", label: "실제 질문·정답 작성은 아직 0건임을 확인했다" },
    ],
  };

  mkdirSync(UI_DIR, { recursive: true });

  const decisionTemplate = {
    schema_version: "0.2.0",
    decision_id: null, decided_at: null, owner: null, owner_disposition: "PENDING", owner_note: null,
    checklist: [],
    total_plan_count: UI_DATA.total_plan_count,
    author_a_assigned_count: UI_DATA.author_a_assigned_count,
    author_b_assigned_count: UI_DATA.author_b_assigned_count,
    immediately_authorizable_count: UI_DATA.immediately_authorizable_count,
    manual_review_required_count: UI_DATA.manual_review_required_count,
    blocked_count: UI_DATA.blocked_count,
    author_a_immediately_authorizable_count: UI_DATA.author_a_immediately_authorizable_count,
    author_b_immediately_authorizable_count: UI_DATA.author_b_immediately_authorizable_count,
    author_a_blocked_count: UI_DATA.author_a_blocked_count,
    author_b_blocked_count: UI_DATA.author_b_blocked_count,
    gold_300_plan_authorized: false,
    eligible_authoring_authorized: false,
    blocked_authoring_authorized: false,
    holdout_authoring_authorized: false,
    holdout_agent_access_authorized: false,
    holdout_evaluation_authorized: false,
    production_wiring_authorized: false,
    agent_ranking_authorized: false,
    relation_decisions_authorized: false,
    actual_official_promotion_applied: false,
    status: "TEMPLATE_NOT_A_REAL_DECISION",
  };
  writeJson(resolve(OUT_DIR, "gold-300-authoring-owner-decision-template.v0.2.json"), decisionTemplate);

  writeJson(resolve(OUT_DIR, "gold-300-authoring-owner-review-gate-status.v0.2.json"), {
    schema_version: "0.1.0", turn: "N4.20.1", generated_at: now,
    status: "GOLD_300_PLAN_REVIEW_READY_PENDING_DECISION",
    gold_300_plan_authorized: false, eligible_authoring_authorized: false, blocked_authoring_authorized: false,
    holdout_authoring_authorized: false, holdout_agent_access_authorized: false, holdout_evaluation_authorized: false,
    production_wiring_authorized: false, agent_ranking_authorized: false, relation_decisions_authorized: false,
    actual_official_promotion_applied: false,
    owner_approval_required: true,
    next_step: "Owner opens gold-300-authoring-owner-review.html (v0.2), reviews the plan-vs-row-authoring separation and the per-author eligible/blocked breakdown, and decides APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING / FIX_REQUIRED / REJECT_GOLD_300_PLAN. A genuine APPROVE only authorizes the plan and currently-ELIGIBLE rows -- BLOCKED rows, HOLDOUT Agent access/evaluation, production wiring, Agent ranking, and relation-decision promotion remain unauthorized in every case.",
  });

  const html = renderHtml(UI_DATA);
  const htmlPath = resolve(UI_DIR, "gold-300-authoring-owner-review.html");
  writeFileSync(htmlPath, html, "utf8");
  const htmlSha256 = sha256File(htmlPath);
  writeJson(resolve(UI_DIR, "gold-300-authoring-owner-review-build-report.v0.2.json"), {
    schema_version: "0.1.0", turn: "N4.20.1", generated_at: now,
    html_path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/owner-review-v0.2/ui/v0.2/gold-300-authoring-owner-review.html",
    html_sha256: htmlSha256, export_filename: EXPORT_FILENAME, checklist_item_count: UI_DATA.checklist_items.length,
    auto_approved: false,
    gold_300_plan_authorized_settable_by_this_ui: true,
    eligible_authoring_authorized_settable_by_this_ui: true,
    gold_300_plan_authorized_requires: "owner_disposition === APPROVE_GOLD_300_PLAN_AND_ELIGIBLE_AUTHORING AND every checklist item checked AND owner name/id provided",
    holdout_authoring_authorized_settable_by_this_ui: true,
    holdout_authoring_authorized_requires: "same as gold_300_plan_authorized -- a genuine APPROVE also permits the DESIGNATED author to write their own assigned HOLDOUT rows; it never grants Agent access or evaluation",
    blocked_authoring_authorized_settable_by_this_ui: false,
    holdout_agent_access_authorized_settable_by_this_ui: false,
    holdout_evaluation_authorized_settable_by_this_ui: false,
    production_wiring_authorized_settable_by_this_ui: false,
    agent_ranking_authorized_settable_by_this_ui: false,
    relation_decisions_authorized_settable_by_this_ui: false,
    actual_official_promotion_applied_settable_by_this_ui: false,
  });

  return Object.freeze({ outDir: OUT_DIR, uiDir: UI_DIR, htmlPath, htmlSha256, uiData: UI_DATA });
}

function renderHtml(DATA) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.20.1 Gold 300 Plan + Eligible Authoring Approval (v0.2)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:24px;}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;word-break:break-all;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
.infobox{background:#e6f4ea;border:1px solid #b6dfc0;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
fieldset{border:1px solid #ccc;border-radius:6px;margin:14px 0;padding:10px 14px;}
label.radio{display:block;margin:6px 0;font-size:14px;}
.checklist label{display:block;margin:6px 0;font-size:14px;}
textarea,input[type=text]{width:100%;box-sizing:border-box;padding:6px;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#downloadBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#downloadBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;width:100%;box-sizing:border-box;}
</style></head>
<body>
<h1>Turn N4.20.1 -- Gold 300 Plan Approval + Eligible-Row Authoring (v0.2)</h1>

<div class="infobox">
<b>이 결정의 의미:</b> Gold 후보 <b>${DATA.total_plan_count}건</b>과 AUTHOR_A/AUTHOR_B <b>${DATA.author_a_assigned_count}/${DATA.author_b_assigned_count}</b> 배정 <b>계획</b>을 승인하고, <b>현재 ELIGIBLE인 ${DATA.immediately_authorizable_count}건만</b> 즉시 작성을 허가한다. BLOCKED ${DATA.blocked_count}건은 이 승인으로 허가되지 않으며, manual review ${DATA.manual_review_required_count}건은 별도 검수 후 해제해야 한다. v0.1 UI(단일 gold_authoring_authorized)는 계획 승인과 행 단위 작성 권한을 혼동시켰기 때문에 폐기됐다 -- 이 UI가 그 구분을 명확히 한다.
</div>

<h2>전체 요약</h2>
<table><tr><th>지표</th><th>값</th></tr>
<tr><td>총 Plan</td><td>${DATA.total_plan_count}</td></tr>
<tr><td>AUTHOR_A / AUTHOR_B 배정</td><td>${DATA.author_a_assigned_count} / ${DATA.author_b_assigned_count}</td></tr>
<tr><td>즉시 작성 가능 (eligible)</td><td>${DATA.immediately_authorizable_count}</td></tr>
<tr><td>수동 검수 필요</td><td>${DATA.manual_review_required_count}</td></tr>
<tr><td>작성 불가 (blocked)</td><td>${DATA.blocked_count}</td></tr>
</table>

<h2>작업자별 분포</h2>
<table><tr><th>작업자</th><th>배정</th><th>eligible</th><th>manual review</th><th>blocked</th></tr>
<tr><td>AUTHOR_A</td><td>${DATA.per_author.AUTHOR_A.total}</td><td>${DATA.author_a_immediately_authorizable_count}</td><td>${DATA.per_author.AUTHOR_A.manual_review_count}</td><td>${DATA.author_a_blocked_count}</td></tr>
<tr><td>AUTHOR_B</td><td>${DATA.per_author.AUTHOR_B.total}</td><td>${DATA.author_b_immediately_authorizable_count}</td><td>${DATA.per_author.AUTHOR_B.manual_review_count}</td><td>${DATA.author_b_blocked_count}</td></tr>
</table>

<div class="warnbox">이 승인은 <b>계획 승인 + eligible 행 작성 허가</b>다. <b>blocked_authoring_authorized, holdout_agent_access_authorized, holdout_evaluation_authorized, production_wiring_authorized, agent_ranking_authorized, relation_decisions_authorized, actual_official_promotion_applied는 항상 false</b>로 내보내진다. 지정 작성자의 HOLDOUT Gold 작성(holdout_authoring_authorized)은 진짜 승인 시 허가되지만, Agent의 HOLDOUT 접근/평가는 별개로 항상 불허된다.</div>

<h2>Owner 선택</h2>
<fieldset>
<label class="radio"><input type="radio" name="ownerChoice" value="${esc(DATA.approve_disposition)}"/> ${esc(DATA.approve_disposition)}</label>
<label class="radio"><input type="radio" name="ownerChoice" value="FIX_REQUIRED"/> FIX_REQUIRED</label>
<label class="radio"><input type="radio" name="ownerChoice" value="REJECT_GOLD_300_PLAN"/> REJECT_GOLD_300_PLAN</label>
</fieldset>
<div id="approveChecklist" class="checklist" hidden></div>
<label>Owner 이름/ID (필수)</label>
<input type="text" id="ownerName"/>
<label>owner_note (FIX_REQUIRED/REJECT_GOLD_300_PLAN 시 필수)</label>
<textarea id="ownerNote"></textarea>
<div class="btnrow">
<button id="downloadBtn" disabled>Download Decision (JSON)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>

<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var downloadBtn = document.getElementById("downloadBtn");
  var copyBtn = document.getElementById("copyBtn");
  var checklistEl = document.getElementById("approveChecklist");
  var ownerNameEl = document.getElementById("ownerName");
  var ownerNoteEl = document.getElementById("ownerNote");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var checklistState = {};
  var lastExportText = "";

  function renderChecklist() {
    checklistEl.textContent = "";
    DATA.checklist_items.forEach(function (item) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checklistState[item.id];
      cb.addEventListener("change", function () { checklistState[item.id] = cb.checked; updateButtons(); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.label));
      checklistEl.appendChild(label);
    });
  }
  renderChecklist();

  function currentChoice() {
    var checked = document.querySelector('input[name="ownerChoice"]:checked');
    return checked ? checked.value : null;
  }
  function allChecklistChecked() { return DATA.checklist_items.every(function (item) { return !!checklistState[item.id]; }); }
  function readyToExport() {
    var choice = currentChoice();
    if (!choice) return false;
    if (!ownerNameEl.value.trim()) return false;
    if (choice === DATA.approve_disposition) return allChecklistChecked();
    if (choice === "FIX_REQUIRED" || choice === "REJECT_GOLD_300_PLAN") return !!ownerNoteEl.value.trim();
    return false;
  }
  function updateButtons() {
    checklistEl.hidden = currentChoice() !== DATA.approve_disposition;
    var ok = readyToExport();
    downloadBtn.disabled = !ok; downloadBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }
  document.querySelectorAll('input[name="ownerChoice"]').forEach(function (r) { r.addEventListener("change", updateButtons); });
  ownerNameEl.addEventListener("input", updateButtons);
  ownerNoteEl.addEventListener("input", updateButtons);
  updateButtons();

  function buildDecision() {
    var choice = currentChoice();
    var isGenuineApproval = choice === DATA.approve_disposition && allChecklistChecked();
    return {
      schema_version: "0.2.0",
      decision_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
      decided_at: new Date().toISOString(),
      owner: ownerNameEl.value.trim(),
      owner_disposition: choice,
      owner_note: ownerNoteEl.value.trim() || null,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: !!checklistState[item.id] }; }),
      total_plan_count: DATA.total_plan_count,
      author_a_assigned_count: DATA.author_a_assigned_count,
      author_b_assigned_count: DATA.author_b_assigned_count,
      immediately_authorizable_count: DATA.immediately_authorizable_count,
      manual_review_required_count: DATA.manual_review_required_count,
      blocked_count: DATA.blocked_count,
      author_a_immediately_authorizable_count: DATA.author_a_immediately_authorizable_count,
      author_b_immediately_authorizable_count: DATA.author_b_immediately_authorizable_count,
      author_a_blocked_count: DATA.author_a_blocked_count,
      author_b_blocked_count: DATA.author_b_blocked_count,
      packet_a_sha256: DATA.packet_a_sha256,
      packet_b_sha256: DATA.packet_b_sha256,
      official_split_decision_id: DATA.official_split_decision_id,
      gold_300_plan_authorized: isGenuineApproval,
      eligible_authoring_authorized: isGenuineApproval,
      blocked_authoring_authorized: false,
      holdout_authoring_authorized: isGenuineApproval,
      holdout_agent_access_authorized: false,
      holdout_evaluation_authorized: false,
      production_wiring_authorized: false,
      agent_ranking_authorized: false,
      relation_decisions_authorized: false,
      actual_official_promotion_applied: false,
    };
  }
  function triggerDownload(text, filename) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  downloadBtn.addEventListener("click", function () {
    if (!readyToExport()) return;
    var text = JSON.stringify(buildDecision(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.export_filename);
    msgEl.textContent = DATA.export_filename + " 다운로드를 시작했습니다.";
  });
  copyBtn.addEventListener("click", function () {
    if (!readyToExport()) return;
    var text = lastExportText || JSON.stringify(buildDecision(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    function fallbackCopy() {
      resultEl.focus(); resultEl.select();
      try { document.execCommand("copy"); msgEl.textContent = "클립보드에 복사했습니다."; }
      catch (e) { msgEl.textContent = "복사에 실패했습니다 -- 직접 선택해 복사해주세요."; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { msgEl.textContent = "클립보드에 복사했습니다."; }, fallbackCopy);
    } else { fallbackCopy(); }
  });
})();
</script>
</body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildGold300OwnerReviewV02();
  console.log(JSON.stringify({ status: "GOLD_300_OWNER_REVIEW_V02_UI_BUILT", htmlPath: result.htmlPath, htmlSha256: result.htmlSha256, gold_300_plan_authorized: false }, null, 2));
}
