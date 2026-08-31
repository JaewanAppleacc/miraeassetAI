#!/usr/bin/env node
// Turn N4.20 (corrected): builds the Gold-300 Authoring Owner review UI.
// This is the gate deciding whether AUTHOR_A/AUTHOR_B may start writing
// their 150 assigned Gold-300 candidates each. This script NEVER grants
// that itself: every artifact it writes carries gold_authoring_authorized
// =false, authorized_scope=NONE, status PENDING. The UI's own JavaScript
// can only ever set gold_authoring_authorized=true (authorized_scope=
// GOLD_300_AUTHOR_A_150_AUTHOR_B_150) inside a DOWNLOADED decision record,
// on a genuine APPROVE_GOLD_300_AUTHORING with every checklist item
// checked -- holdout_evaluation_authorized, production_wiring_authorized,
// actual_official_promotion_applied, relation_decisions_authorized, and
// agent_ranking_authorized stay false in every code path, with no UI
// control that can ever flip them.
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
const AUTHORING_DIR = resolve(V02_DIR, "gold-authoring-300-v0.1");
const APPLIED_V03_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1/applied-v0.3");
const OFFICIAL_SPLIT_DECISION_PATH = resolve(V02_DIR, "component-safe-reallocation-v0.1/official-split-approval-v0.1/results/owner-v0.1/official-split-approval-decision.v0.1.json");

const SELECTION_MANIFEST_PATH = resolve(GOLD_300_DIR, "gold-300-selection-manifest.v0.1.json");
const AUTHOR_MANIFEST_PATH = resolve(GOLD_300_DIR, "gold-300-author-allocation-manifest.v0.1.json");
const ELIGIBILITY_PATH = resolve(GOLD_300_DIR, "gold-300-eligibility-report.v0.1.json");
const PACKET_MANIFEST_PATH = resolve(AUTHORING_DIR, "gold-authoring-300-packet-manifest.v0.1.json");

export const OUT_DIR = resolve(AUTHORING_DIR, "owner-review-v0.1");
export const UI_DIR = resolve(OUT_DIR, "ui/v0.1");

const APPROVE_DISPOSITION = "APPROVE_GOLD_300_AUTHORING";
const EXPORT_FILENAME = "gold-300-authoring-owner-decision.v0.1.json";

export function buildGold300OwnerReview({ generatedAt } = {}) {
  const now = generatedAt ?? new Date().toISOString();

  const selectionManifest = readJson(SELECTION_MANIFEST_PATH);
  const authorManifest = readJson(AUTHOR_MANIFEST_PATH);
  const eligibility = readJson(ELIGIBILITY_PATH);
  const packetManifest = readJson(PACKET_MANIFEST_PATH);
  const officialSplitDecision = readJson(OFFICIAL_SPLIT_DECISION_PATH);

  if (selectionManifest.status !== "CANDIDATE_NOT_OWNER_APPROVED") throw new Error("buildGold300OwnerReview: selection manifest status must be CANDIDATE_NOT_OWNER_APPROVED");
  if (authorManifest.total_gold_count !== 300) throw new Error("buildGold300OwnerReview: author manifest total_gold_count must be 300");
  if (officialSplitDecision.owner_disposition !== "APPROVE_OFFICIAL_SPLIT_V0.3") throw new Error("buildGold300OwnerReview: official split decision is not a genuine approval");

  const anchorV03Sha256 = sha256File(resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl"));

  const UI_DATA = {
    export_filename: EXPORT_FILENAME,
    approve_disposition: APPROVE_DISPOSITION,
    total_gold_count: authorManifest.total_gold_count,
    author_a_count: authorManifest.author_a_count,
    author_b_count: authorManifest.author_b_count,
    existing_anchor_count: authorManifest.existing_anchor_count,
    expansion_count: authorManifest.expansion_count,
    author_a_anchor_count: authorManifest.author_a_anchor_count,
    author_a_expansion_count: authorManifest.author_a_expansion_count,
    author_b_anchor_count: authorManifest.author_b_anchor_count,
    author_b_expansion_count: authorManifest.author_b_expansion_count,
    split_counts: selectionManifest.split_counts,
    eligible_count: eligibility.eligible_count,
    blocked_count: eligibility.blocked_count,
    eligibility_distribution: eligibility.eligibility_distribution,
    packet_a_sha256: packetManifest.author_a.sha256,
    packet_b_sha256: packetManifest.author_b.sha256,
    packet_manifest_sha256: sha256File(PACKET_MANIFEST_PATH),
    selection_manifest_sha256: sha256File(SELECTION_MANIFEST_PATH),
    author_allocation_manifest_sha256: sha256File(AUTHOR_MANIFEST_PATH),
    official_split_decision_id: officialSplitDecision.decision_id,
    official_split_eligible: true,
    anchor_selection_v03_sha256: anchorV03Sha256,
    checklist_items: [
      { id: "total_300_understood", label: `최종 Gold 총수가 ${authorManifest.total_gold_count}건임을 확인했다` },
      { id: "author_ab_150_150", label: `AUTHOR_A/AUTHOR_B가 각각 ${authorManifest.author_a_count}/${authorManifest.author_b_count}건(기존 Anchor 75 + 신규 Expansion 75 = 150)임을 확인했다` },
      { id: "not_gold_300_full_yet", label: "이 승인이 Gold 작성 착수 승인이며, 실제 작성 완료를 뜻하지 않음을 이해했다" },
      { id: "not_holdout_eval", label: "이 승인이 HOLDOUT 평가 사용 승인이 아님을 이해했다 (holdout_evaluation_authorized는 계속 false)" },
      { id: "provisional_not_auto_released", label: `provisional relation blocker(${eligibility.eligibility_distribution.BLOCKED_PROVISIONAL_RELATION}건)가 이 승인으로 자동 해제되지 않음을 확인했다` },
      { id: "blocked_not_authored", label: `BLOCKED 항목(총 ${eligibility.blocked_count}건: parse_failed ${eligibility.eligibility_distribution.BLOCKED_PARSE_FAILED} + provisional_relation ${eligibility.eligibility_distribution.BLOCKED_PROVISIONAL_RELATION})은 근거가 해소되기 전까지 작성 완료로 처리하지 않을 것임을 확인했다` },
      { id: "not_production_wiring", label: "이 승인이 production Runtime/PostgreSQL/v0.20 배선 승인이 아님을 이해했다" },
      { id: "not_official_promotion", label: "이 승인이 actual official promotion이 아님을 이해했다" },
      { id: "not_relation_decisions", label: "이 승인이 나머지 provisional relation 판정을 승인하는 것이 아님을 이해했다" },
      { id: "not_agent_ranking", label: "이 승인이 Agent ranking/성능 비교를 승인하는 것이 아님을 이해했다" },
      { id: "official_split_prereq", label: `공식 split(decision_id ${officialSplitDecision.decision_id})이 이미 APPROVE_OFFICIAL_SPLIT_V0.3로 승인되었음을 전제로 함을 확인했다` },
    ],
  };

  mkdirSync(UI_DIR, { recursive: true });

  const decisionTemplate = {
    schema_version: "0.1.0",
    decision_id: null, decided_at: null, owner: null, owner_disposition: "PENDING", owner_note: null,
    checklist: [],
    total_gold_count: UI_DATA.total_gold_count, author_a_count: UI_DATA.author_a_count, author_b_count: UI_DATA.author_b_count,
    existing_anchor_count: UI_DATA.existing_anchor_count, expansion_count: UI_DATA.expansion_count,
    author_a_anchor_count: UI_DATA.author_a_anchor_count, author_a_expansion_count: UI_DATA.author_a_expansion_count,
    author_b_anchor_count: UI_DATA.author_b_anchor_count, author_b_expansion_count: UI_DATA.author_b_expansion_count,
    eligible_count: UI_DATA.eligible_count, blocked_count: UI_DATA.blocked_count, eligibility_distribution: UI_DATA.eligibility_distribution,
    packet_a_sha256: UI_DATA.packet_a_sha256, packet_b_sha256: UI_DATA.packet_b_sha256, packet_manifest_sha256: UI_DATA.packet_manifest_sha256,
    official_split_decision_id: UI_DATA.official_split_decision_id, official_split_eligible: UI_DATA.official_split_eligible,
    gold_authoring_authorized: false, authorized_scope: "NONE",
    holdout_access_authorized: false, holdout_evaluation_authorized: false,
    phase2_authoring_authorized: false, production_wiring_authorized: false,
    actual_official_promotion_applied: false, relation_decisions_authorized: false, agent_ranking_authorized: false,
    status: "TEMPLATE_NOT_A_REAL_DECISION",
  };
  writeJson(resolve(OUT_DIR, "gold-300-authoring-owner-decision-template.v0.1.json"), decisionTemplate);

  writeJson(resolve(OUT_DIR, "gold-300-authoring-owner-review-gate-status.v0.1.json"), {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now,
    status: "GOLD_300_AUTHORING_REVIEW_READY_PENDING_DECISION",
    gold_authoring_authorized: false, authorized_scope: "NONE",
    holdout_evaluation_authorized: false, production_wiring_authorized: false,
    actual_official_promotion_applied: false, relation_decisions_authorized: false, agent_ranking_authorized: false,
    owner_approval_required: true,
    next_step: "Owner opens gold-300-authoring-owner-review.html, reviews the 300-count/150-150 author split/eligibility distribution, and decides APPROVE_GOLD_300_AUTHORING / FIX_REQUIRED / REJECT_GOLD_300_PLAN. Even a genuine APPROVE only produces a downloaded decision record and never authorizes HOLDOUT evaluation, production wiring, official promotion, relation decisions, or Agent ranking.",
  });

  const html = renderHtml(UI_DATA);
  const htmlPath = resolve(UI_DIR, "gold-300-authoring-owner-review.html");
  writeFileSync(htmlPath, html, "utf8");
  const htmlSha256 = sha256File(htmlPath);
  writeJson(resolve(UI_DIR, "gold-300-authoring-owner-review-build-report.json"), {
    schema_version: "0.1.0", turn: "N4.20", generated_at: now,
    html_path: "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/owner-review-v0.1/ui/v0.1/gold-300-authoring-owner-review.html",
    html_sha256: htmlSha256, export_filename: EXPORT_FILENAME, checklist_item_count: UI_DATA.checklist_items.length,
    auto_approved: false,
    gold_authoring_authorized_settable_by_this_ui: true,
    gold_authoring_authorized_requires: "owner_disposition === APPROVE_GOLD_300_AUTHORING AND every checklist item checked AND owner name/id provided",
    holdout_evaluation_authorized_settable_by_this_ui: false,
    production_wiring_authorized_settable_by_this_ui: false,
    actual_official_promotion_applied_settable_by_this_ui: false,
    relation_decisions_authorized_settable_by_this_ui: false,
    agent_ranking_authorized_settable_by_this_ui: false,
  });

  return Object.freeze({ outDir: OUT_DIR, uiDir: UI_DIR, htmlPath, htmlSha256, uiData: UI_DATA });
}

function renderHtml(DATA) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.20 Gold 300 Authoring Approval (v0.1)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
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
<h1>Turn N4.20 -- Gold 300 Authoring Approval</h1>

<div class="infobox">
<b>이 결정의 의미:</b> 최종 Gold <b>300건</b>(AUTHOR_A ${DATA.author_a_count} / AUTHOR_B ${DATA.author_b_count}) 작성 착수를 승인할지 결정하는 게이트다. 기존 Anchor 150(A ${DATA.author_a_anchor_count}/B ${DATA.author_b_anchor_count})은 그대로 유지되고, 신규 Expansion 150(A ${DATA.author_a_expansion_count}/B ${DATA.author_b_expansion_count})이 추가된다. 여기서 APPROVE해도 <b>HOLDOUT 평가 사용, production 배선, official promotion, 나머지 relation 판정, Agent ranking은 전혀 승인되지 않는다.</b>
</div>

<h2>Gold 300 요약</h2>
<table><tr><th>지표</th><th>값</th></tr>
<tr><td>총 Gold</td><td>${DATA.total_gold_count}</td></tr>
<tr><td>AUTHOR_A / AUTHOR_B</td><td>${DATA.author_a_count} / ${DATA.author_b_count}</td></tr>
<tr><td>기존 Anchor / 신규 Expansion</td><td>${DATA.existing_anchor_count} / ${DATA.expansion_count}</td></tr>
<tr><td>AUTHOR_A (Anchor+Expansion)</td><td>${DATA.author_a_anchor_count} + ${DATA.author_a_expansion_count} = ${DATA.author_a_count}</td></tr>
<tr><td>AUTHOR_B (Anchor+Expansion)</td><td>${DATA.author_b_anchor_count} + ${DATA.author_b_expansion_count} = ${DATA.author_b_count}</td></tr>
<tr><td>split 카운트</td><td>${esc(JSON.stringify(DATA.split_counts))}</td></tr>
<tr><td>eligible / blocked</td><td>${DATA.eligible_count} / ${DATA.blocked_count}</td></tr>
<tr><td>eligibility 분포</td><td>${esc(JSON.stringify(DATA.eligibility_distribution))}</td></tr>
<tr><td>공식 split 결정 ID (선행조건)</td><td>${esc(DATA.official_split_decision_id)}</td></tr>
</table>

<div class="warnbox">이 승인은 <b>Gold 작성 착수 승인</b>이며, <b>HOLDOUT 평가 승인이 아니다</b>. provisional relation blocker(${DATA.eligibility_distribution.BLOCKED_PROVISIONAL_RELATION}건)는 자동 해제되지 않으며, BLOCKED 항목(parse_failed ${DATA.eligibility_distribution.BLOCKED_PARSE_FAILED}건 포함, 총 ${DATA.blocked_count}건)은 근거가 해소되기 전까지 작성 완료로 처리하지 않는다. <b>holdout_evaluation_authorized/production_wiring_authorized/actual_official_promotion_applied/relation_decisions_authorized/agent_ranking_authorized는 항상 false</b>로 내보내진다.</div>

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
      schema_version: "0.1.0",
      decision_id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2)),
      decided_at: new Date().toISOString(),
      owner: ownerNameEl.value.trim(),
      owner_disposition: choice,
      owner_note: ownerNoteEl.value.trim() || null,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: !!checklistState[item.id] }; }),
      total_gold_count: DATA.total_gold_count,
      author_a_count: DATA.author_a_count,
      author_b_count: DATA.author_b_count,
      existing_anchor_count: DATA.existing_anchor_count,
      expansion_count: DATA.expansion_count,
      author_a_anchor_count: DATA.author_a_anchor_count,
      author_a_expansion_count: DATA.author_a_expansion_count,
      author_b_anchor_count: DATA.author_b_anchor_count,
      author_b_expansion_count: DATA.author_b_expansion_count,
      eligible_count: DATA.eligible_count,
      blocked_count: DATA.blocked_count,
      eligibility_distribution: DATA.eligibility_distribution,
      packet_a_sha256: DATA.packet_a_sha256,
      packet_b_sha256: DATA.packet_b_sha256,
      packet_manifest_sha256: DATA.packet_manifest_sha256,
      official_split_decision_id: DATA.official_split_decision_id,
      official_split_eligible: DATA.official_split_eligible,
      gold_authoring_authorized: isGenuineApproval,
      authorized_scope: isGenuineApproval ? "GOLD_300_AUTHOR_A_150_AUTHOR_B_150" : "NONE",
      holdout_access_authorized: false,
      holdout_evaluation_authorized: false,
      phase2_authoring_authorized: false,
      production_wiring_authorized: false,
      actual_official_promotion_applied: false,
      relation_decisions_authorized: false,
      agent_ranking_authorized: false,
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
  const result = buildGold300OwnerReview();
  console.log(JSON.stringify({ status: "GOLD_300_OWNER_REVIEW_UI_BUILT", htmlPath: result.htmlPath, htmlSha256: result.htmlSha256, gold_authoring_authorized: false }, null, 2));
}
