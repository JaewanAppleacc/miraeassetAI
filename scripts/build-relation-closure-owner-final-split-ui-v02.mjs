#!/usr/bin/env node
// Turn N4.7 (corrected in N4.7.1): builds the OFFLINE Owner
// final-split-approval review page for the v0.2 PROVISIONAL SPLIT
// CANDIDATE. This is a gate, not a report: every checklist item must be
// checked by a human before the "FINAL Approve & Export" button unlocks.
// No code path in this script (or the exported page) marks approval
// automatically, and checking every box here never flips
// official_split_eligible to true or resolves the 294
// REVIEWER_CONSENSUS_PROVISIONAL rows -- see provisional-294-decision-
// packet.v0.2.json for what actually would.
//
// Turn N4.7.1 fixes: (1) the export button now triggers a REAL file
// download (Blob + createObjectURL + <a download>, the same pattern
// scripts/build-seed-final-integration-owner-review-ui-v02.mjs already
// uses) with a FIXED filename, plus a copy-to-clipboard button with a
// navigator.clipboard.writeText -> document.execCommand("copy") fallback
// and an explicit success/failure status message; (2) the page's own
// banner and checklist now state plainly that this is a PROVISIONAL split
// candidate, not an official one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const uiDir = resolve(outDir, "ui/v0.2");
mkdirSync(uiDir, { recursive: true });

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const finalPacket = readJson(resolve(outDir, "final-integration-packet.v0.2.json"));
const gateStatus = readJson(resolve(outDir, "gate-status.v0.2.json"));
const diff = readJson(resolve(outDir, "anchor-v01-to-v02-replacement-diff.json"));
const quarantineManifest = readJson(resolve(outDir, "quarantine/quarantine-manifest.v0.2.json"));
const provisionalPacket = readJson(resolve(outDir, "provisional-294-decision-packet.v0.2.json"));

const FINAL_EXPORT_FILENAME = "relation-closure-owner-final-split-approval.v0.2.json";

const DATA = {
  final_integration_packet: finalPacket,
  gate_status: gateStatus,
  removed_assignments: diff.removed_assignments,
  added_assignments: diff.added_assignments,
  quarantine_document_count: quarantineManifest.quarantine_document_count,
  owner_note: quarantineManifest.owner_note,
  provisional_294: provisionalPacket.current_state,
  final_export_filename: FINAL_EXPORT_FILENAME,
  input_shas: {
    owner_decision_sha256: finalPacket.owner_decision.sha256,
    cd_risk_packet_sha256: finalPacket.cd_dual_review.risk_packet_sha256,
  },
  checklist_items: [
    { id: "dist_21_8_1", label: "Owner v0.3 결정 21 CONFIRM / 8 REJECT / 1 NEEDS_MORE_REVIEW가 그대로 반영되었다" },
    { id: "cd_dual_confirm", label: "Reviewer C/D 다단계 정정 2건이 동일 target CONFIRM으로 반영되었다" },
    { id: "quarantine_applied", label: "미확정 TERMINATES 1건과 그 영향 component가 공식 평가 대상에서 격리되었다" },
    { id: "excluded_anchor_reviewed", label: "실제로 제외된 Anchor 목록(4건)을 확인했다" },
    { id: "backfilled_anchor_reviewed", label: "보충된 Anchor 목록(4건)을 확인했다" },
    { id: "count_150", label: "Anchor 총원이 150건으로 유지된다" },
    { id: "balance_75_75", label: "AUTHOR_A/AUTHOR_B가 75/75로 유지된다" },
    { id: "leakage_zero_provisional_scope", label: "leakage(체인/저자/문서/평가그룹/격리유입)가 CURRENT_PROVISIONAL_GRAPH_ONLY 범위에서 전부 0임을 확인했다 -- 이것이 공식 chain closure 증명이 아님을 이해했다" },
    { id: "provisional_294_understood", label: "294건의 REVIEWER_CONSENSUS_PROVISIONAL 관계가 아직 승인/기각되지 않았고, 이 승인만으로 official_split_eligible이 true가 되지 않는다는 점을 이해했다" },
    { id: "gold_not_started", label: "Gold 작성이 아직 시작되지 않았음을 확인했다" },
  ],
};

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.7 Owner Final Split Approval v0.2 (PROVISIONAL_SPLIT_CANDIDATE)</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:920px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:16px;margin-top:28px;}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;}
.pass{background:#e6f4ea;color:#1a7f37;} .pending{background:#fff3cd;color:#8a6100;} .fail{background:#fde2e1;color:#c0362c;}
.checklist label{display:block;margin:6px 0;font-size:14px;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:12px 14px;margin:14px 0;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#approveBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#approveBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;}
</style></head>
<body>
<h1>Turn N4.7.1 -- Owner Final Split Approval (v0.2, PROVISIONAL_SPLIT_CANDIDATE)</h1>
<div class="warnbox">이 결과물은 <b>PROVISIONAL_SPLIT_CANDIDATE</b>이며 OFFICIAL_SPLIT_CANDIDATE가 아니다. leakage=0은 Owner CONFIRM 21건 + Reviewer C/D dual-CONFIRM 2건, 총 23개 confirmed edge만 사용한 CURRENT_PROVISIONAL_GRAPH_ONLY 범위에서 증명된 것이다. 나머지 294건(REVIEWER_CONSENSUS_PROVISIONAL)은 아직 승인도 기각도 되지 않았다. 아래 체크리스트를 전부 확인하고 FINAL export를 실행해도 <b>official_split_eligible은 false로, gold_authoring은 BLOCKED_PENDING_FINAL_SPLIT_APPROVAL로 유지</b>된다 -- 294건 해소는 별도의 후속 Owner 결정이 필요하다 (provisional-294-decision-packet.v0.2.json 참고).</div>

<h2>Owner v0.3 결정</h2>
<p>SHA-256: <code>${finalPacket.owner_decision.sha256}</code> / 30행 / CONFIRM ${finalPacket.owner_decision.distribution.CONFIRM} · REJECT ${finalPacket.owner_decision.distribution.REJECT} · NEEDS_MORE_REVIEW ${finalPacket.owner_decision.distribution.NEEDS_MORE_REVIEW}</p>

<h2>Reviewer C/D 다단계 정정 병합</h2>
<p>risk packet SHA-256: <code>${finalPacket.cd_dual_review.risk_packet_sha256}</code> / 2행 / all_confirmed=${finalPacket.cd_dual_review.all_confirmed}</p>

<h2>격리 (Quarantine)</h2>
<p>미확정 관계: <code>${finalPacket.quarantine.unresolved_relation_candidate_id}</code><br/>
격리 문서 수: ${DATA.quarantine_document_count}건<br/>
Owner note: ${esc(DATA.owner_note ?? "")}</p>

<h2>294건 REVIEWER_CONSENSUS_PROVISIONAL (미해소)</h2>
<p>row_count: ${DATA.provisional_294.row_count} / contributes_edge_to_official_graph: ${DATA.provisional_294.contributes_edge_to_official_graph} / auto_rejected_this_turn: ${DATA.provisional_294.auto_rejected_this_turn} / auto_promoted_this_turn: ${DATA.provisional_294.auto_promoted_this_turn}</p>

<h2>실제 제외된 Anchor (${DATA.removed_assignments.length}건)</h2>
<table><tr><th>assignment_id</th><th>anchor_document_ids</th><th>author</th><th>tags</th></tr>
${DATA.removed_assignments.map((r) => `<tr><td>${esc(r.assignment_id)}</td><td>${esc(r.anchor_document_ids.join(", "))}</td><td>${esc(r.author_allocation)}</td><td>${esc(r.tags.join(", "))}</td></tr>`).join("\n")}
</table>

<h2>보충된 Anchor (${DATA.added_assignments.length}건)</h2>
<table><tr><th>assignment_id</th><th>anchor_document_ids</th><th>bucket</th><th>tags</th></tr>
${DATA.added_assignments.map((r) => `<tr><td>${esc(r.assignment_id)}</td><td>${esc(r.anchor_document_ids.join(", "))}</td><td>${esc(r.bucket)}</td><td>${esc(r.tags.join(", "))}</td></tr>`).join("\n")}
</table>

<h2>Anchor 150 / Author 75-75 / Leakage</h2>
<p>Anchor 총원: ${finalPacket.anchor_v02.count} / AUTHOR_A: ${finalPacket.anchor_v02.author_used.AUTHOR_A} / AUTHOR_B: ${finalPacket.anchor_v02.author_used.AUTHOR_B} / leakage all_zero (CURRENT_PROVISIONAL_GRAPH_ONLY): ${finalPacket.leakage.all_zero}</p>

<h2>Gate 상태</h2>
<table><tr><th>gate</th><th>value</th></tr>
${Object.entries(gateStatus.gates).map(([k, v]) => `<tr><td>${esc(k)}</td><td><span class="badge ${v === true || v === "PASS" || v === "PASS_CURRENT_PROVISIONAL_GRAPH_ONLY" ? "pass" : v === false || v === "PENDING" || v === "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL" || v === "UNRESOLVED_NOT_AUTO_ADJUDICATED" ? "pending" : "fail"}">${esc(String(v))}</span></td></tr>`).join("\n")}
</table>

<h2>Owner 체크리스트</h2>
<div class="checklist" id="checklist"></div>
<div class="btnrow">
<button id="approveBtn" disabled>FINAL Approve &amp; Download (JSON)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>

<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var STORAGE_KEY = "n4.7-owner-final-split-checklist-v0.2";
  var checklistEl = document.getElementById("checklist");
  var approveBtn = document.getElementById("approveBtn");
  var copyBtn = document.getElementById("copyBtn");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { state = {}; }
  var lastExportText = "";

  function render() {
    checklistEl.textContent = "";
    DATA.checklist_items.forEach(function (item) {
      var label = document.createElement("label");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state[item.id];
      cb.addEventListener("change", function () {
        state[item.id] = cb.checked;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
        updateButtons();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + item.label));
      checklistEl.appendChild(label);
    });
    updateButtons();
  }
  function allChecked() {
    return DATA.checklist_items.every(function (item) { return !!state[item.id]; });
  }
  function updateButtons() {
    var ok = allChecked();
    approveBtn.disabled = !ok; approveBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }

  function buildRecord() {
    return {
      schema_version: "0.1.0",
      status: "OWNER_FINAL_SPLIT_CHECKLIST_APPROVED",
      note: "This records that a human checked every item below in a browser. It does NOT resolve the 294 REVIEWER_CONSENSUS_PROVISIONAL rows and does NOT set official_split_eligible=true -- see provisional-294-decision-packet.v0.2.json.",
      official_split_eligible: false,
      approved_at: new Date().toISOString(),
      input_shas: DATA.input_shas,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: true }; }),
      final_integration_packet_snapshot: DATA.final_integration_packet,
      gate_status_snapshot: DATA.gate_status,
      provisional_294_snapshot: DATA.provisional_294,
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

  approveBtn.addEventListener("click", function () {
    if (!allChecked()) return;
    var record = buildRecord();
    var text = JSON.stringify(record, null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.final_export_filename);
    msgEl.textContent = DATA.final_export_filename + " 다운로드를 시작했습니다.";
  });

  copyBtn.addEventListener("click", function () {
    if (!allChecked()) return;
    var text = lastExportText || JSON.stringify(buildRecord(), null, 2);
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    function fallbackCopy() {
      resultEl.focus(); resultEl.select();
      try { document.execCommand("copy"); msgEl.textContent = "클립보드에 복사했습니다."; }
      catch (e) { msgEl.textContent = "복사에 실패했습니다 -- 직접 선택해 복사해주세요."; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        msgEl.textContent = "클립보드에 복사했습니다.";
      }, fallbackCopy);
    } else {
      fallbackCopy();
    }
  });

  render();
})();
</script>
</body></html>
`;

const htmlPath = resolve(uiDir, "relation-closure-owner-final-split-approval.v0.2.html");
writeFileSync(htmlPath, html, "utf8");
writeFileSync(resolve(uiDir, "owner-final-split-ui-build-report.json"), `${JSON.stringify({
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  html_path: "work/handoff/anchor-dev-tune-v0.2/ui/v0.2/relation-closure-owner-final-split-approval.v0.2.html",
  html_sha256: sha256File(htmlPath),
  checklist_item_count: DATA.checklist_items.length,
  storage_key: "n4.7-owner-final-split-checklist-v0.2",
  final_export_filename: FINAL_EXPORT_FILENAME,
  auto_approved: false,
  status_label: "PROVISIONAL_SPLIT_CANDIDATE",
  official_split_eligible_settable_by_this_ui: false,
  note: "No code path in this build script or the exported HTML marks approval automatically, or ever sets official_split_eligible to true. The export JSON/download/clipboard only exist after a human checks every checklist box in a browser and clicks a button themselves. Resolving the 294 REVIEWER_CONSENSUS_PROVISIONAL rows requires a separate, later decision -- see provisional-294-decision-packet.v0.2.json.",
}, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ status: "PASS", html_path: htmlPath, sha256: sha256File(htmlPath) }, null, 2));
