#!/usr/bin/env node
// Turn N4.17: builds the FINAL official-split approval Owner review UI for
// Turn N4.16's v0.3 candidate assignment. This is the single, separate gate
// that -- if and only if the Owner completes it with a genuine APPROVE and a
// fully-checked checklist -- would designate v0.3 as officially split-
// eligible. This script itself NEVER grants that: every artifact this
// script writes carries official_split_eligible=false, status PENDING. It
// also NEVER writes to anchor-selection.v0.2/v0.3, author-allocation.v0.2/
// v0.3, candidate-pool.v0.1/v0.3, the official 326-row ledger, or any
// Relation/Fact/Evidence/Gold store, and NEVER touches Runtime/PostgreSQL/
// v0.20. gold_authoring_authorized and actual_official_promotion_applied
// are hardcoded false everywhere this script writes, and the UI's own
// JavaScript can never set them true either -- approving here only ever
// produces a DOWNLOADED decision record; applying it to any real release
// artifact is a separate, not-yet-built future action.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function canonicalSha256File(p) {
  const obj = JSON.parse(readFileSync(p, "utf8"));
  const clone = { ...obj };
  delete clone.generated_at;
  return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const APPLIED_V03_DIR = resolve(CSR_DIR, "applied-v0.3");
const OFFICIAL_SPLIT_DIR = resolve(CSR_DIR, "official-split-approval-v0.1");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");

const MANIFEST_PATH = resolve(APPLIED_V03_DIR, "v0.3-application-manifest.v0.1.json");
const POOL_V03_PATH = resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl");
const ANCHOR_V03_PATH = resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl");
const AUTHOR_V03_PATH = resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl");

mkdirSync(OFFICIAL_SPLIT_DIR, { recursive: true });

// == 1. Pre-verification -- ABORT before writing anything ===================
const manifest = readJson(MANIFEST_PATH);
if (manifest.status !== "V0.3_CANDIDATE_BUILT_NOT_OFFICIAL") { console.error(`BLOCKER: v0.3 manifest status is not V0.3_CANDIDATE_BUILT_NOT_OFFICIAL (actual ${manifest.status})`); process.exit(1); }
if (!manifest.all_invariants_passed) { console.error("BLOCKER: v0.3 manifest all_invariants_passed is not true"); process.exit(1); }
if (manifest.official_split_eligible !== false) { console.error("BLOCKER: v0.3 manifest official_split_eligible is not false"); process.exit(1); }

const poolV03 = readJsonl(POOL_V03_PATH);
if (poolV03.length !== 500) { console.error(`BLOCKER: v0.3 pool count ${poolV03.length} !== 500`); process.exit(1); }
const anchorV03 = readJsonl(ANCHOR_V03_PATH);
if (anchorV03.length !== 150) { console.error(`BLOCKER: v0.3 anchor count ${anchorV03.length} !== 150`); process.exit(1); }
const authorV03 = readJsonl(AUTHOR_V03_PATH);
if (authorV03.length !== 150) { console.error(`BLOCKER: v0.3 author count ${authorV03.length} !== 150`); process.exit(1); }

const splitCountsV03 = {};
for (const s of ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"]) splitCountsV03[s] = poolV03.filter((r) => r.planned_split === s).length;
if (JSON.stringify(splitCountsV03) !== JSON.stringify(manifest.live_recomputed_values.split_counts)) { console.error("BLOCKER: recomputed v0.3 split counts do not match the manifest"); process.exit(1); }
const authorCountsV03 = { AUTHOR_A: 0, AUTHOR_B: 0 };
for (const r of authorV03) authorCountsV03[r.author_allocation] += 1;
if (JSON.stringify(authorCountsV03) !== JSON.stringify(manifest.live_recomputed_values.author_counts)) { console.error("BLOCKER: recomputed v0.3 author counts do not match the manifest"); process.exit(1); }

const ledgerRows = readJsonl(LEDGER_PATH);
if (ledgerRows.length !== 326) { console.error(`BLOCKER: ledger row count ${ledgerRows.length} !== 326`); process.exit(1); }
const provisionalCount = ledgerRows.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
if (provisionalCount !== 294) { console.error(`BLOCKER: provisional relation count ${provisionalCount} !== 294`); process.exit(1); }

// == 2. Decision inputs (SHAs) ===============================================
const manifestSha256 = canonicalSha256File(MANIFEST_PATH); // manifest embeds generated_at
const poolV03Sha256 = sha256File(POOL_V03_PATH); // v0.3 jsonl files carry no generated_at -- raw hash is stable
const anchorV03Sha256 = sha256File(ANCHOR_V03_PATH);
const authorV03Sha256 = sha256File(AUTHOR_V03_PATH);

// == 3. Official-split approval packet =======================================
const packet = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.17",
  meaning: {
    what_this_decision_is: "The FINAL, SEPARATE gate deciding whether Turn N4.16's v0.3 candidate assignment (Strategy A applied) becomes the officially split-eligible Pool500/Anchor150/Author150 assignment.",
    not_a_gold_authoring_approval: true,
    not_a_relation_281_decision: true,
    not_an_automatic_runtime_cutover: true,
    approving_here_only_produces_a_downloaded_decision_record: true,
    applying_to_any_real_release_artifact_or_runtime_v0_20_requires_a_separate_future_action: true,
  },
  v03_summary: {
    anchor_count: anchorV03.length,
    candidate_pool_count: poolV03.length,
    author_count: authorV03.length,
    split_counts: splitCountsV03,
    author_counts: authorCountsV03,
    split_leakage_after: manifest.live_recomputed_values.split_leakage_after,
    author_leakage_after: manifest.live_recomputed_values.author_leakage_after,
    quarantine_intrusion_after: manifest.live_recomputed_values.quarantine_intrusion_after,
    critical_slice_floors_preserved: manifest.invariant_checks.critical_slice_floors_preserved,
    anchor_membership_unchanged: manifest.invariant_checks.anchor_membership_unchanged,
  },
  source_chain: {
    n413_strategy_a_plan: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/strategy-a-assignment-only-plan.v0.1.json",
    n415_owner_decision: manifest.source_authorization,
    n416_v03_manifest: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/v0.3-application-manifest.v0.1.json", sha256: manifestSha256 },
  },
  status: "PENDING_OFFICIAL_SPLIT_DECISION",
  official_split_eligible: false,
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  remaining_281_provisional_untouched: true,
};
const packetPath = resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-packet.v0.1.json");
writeJson(packetPath, packet);
const packetSha256 = sha256File(packetPath);
writeJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-packet.v0.1.manifest.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.17",
  inputs: {
    v03_application_manifest: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/v0.3-application-manifest.v0.1.json", sha256: manifestSha256 },
    v03_pool: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl", sha256: poolV03Sha256, row_count: poolV03.length },
    v03_anchor: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl", sha256: anchorV03Sha256, row_count: anchorV03.length },
    v03_author: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/author-allocation.v0.3.jsonl", sha256: authorV03Sha256, row_count: authorV03.length },
    relation_closure_candidate_ledger_v02: { path: "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl", sha256: sha256File(LEDGER_PATH), row_count: ledgerRows.length },
  },
  pre_verification_all_passed: true,
  output: { path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/official-split-approval-packet.v0.1.json", sha256: packetSha256 },
});

// == 4. Decision template (schema only, PENDING) ============================
const decisionTemplate = {
  schema_version: "0.1.0",
  decision_id: null,
  owner: null,
  decided_at: null,
  owner_disposition: "PENDING",
  owner_note: null,
  v03_manifest_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/v0.3-application-manifest.v0.1.json",
  v03_manifest_sha256: manifestSha256,
  v03_pool_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/candidate-pool.v0.3.jsonl",
  v03_pool_sha256: poolV03Sha256,
  v03_anchor_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/anchor-selection.v0.3.jsonl",
  v03_anchor_sha256: anchorV03Sha256,
  v03_author_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/applied-v0.3/author-allocation.v0.3.jsonl",
  v03_author_sha256: authorV03Sha256,
  anchor_count: anchorV03.length,
  candidate_pool_count: poolV03.length,
  author_count: authorV03.length,
  split_counts: splitCountsV03,
  author_counts: authorCountsV03,
  split_leakage_after: manifest.live_recomputed_values.split_leakage_after,
  author_leakage_after: manifest.live_recomputed_values.author_leakage_after,
  quarantine_intrusion_after: manifest.live_recomputed_values.quarantine_intrusion_after,
  critical_slice_floors_preserved: manifest.invariant_checks.critical_slice_floors_preserved,
  anchor_membership_unchanged: manifest.invariant_checks.anchor_membership_unchanged,
  anchor_membership_changed: false,
  relation_decisions_authorized: false,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  remaining_281_provisional_untouched: true,
  checklist: [],
  status: "TEMPLATE_NOT_A_REAL_DECISION",
};
writeJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-decision-template.v0.1.json"), decisionTemplate);

// == 5. Gate status ==========================================================
writeJson(resolve(OFFICIAL_SPLIT_DIR, "gate-status-official-split.v0.1.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.17",
  status: "OFFICIAL_SPLIT_APPROVAL_PACKET_READY_PENDING_DECISION",
  official_split_eligible: false,
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  anchor_membership_changed: false,
  owner_approval_required: true,
  remaining_281_provisional_rows_untouched: true,
  next_step: "Owner opens official-split-approval.html, reviews v0.3's zero-leakage/zero-quarantine-intrusion state, and decides APPROVE_OFFICIAL_SPLIT_V0.3 / FIX_REQUIRED / REJECT_PLAN. Even a genuine APPROVE only produces a downloaded decision record -- applying it to any real release/runtime artifact is a separate future action, never performed by this script or UI.",
});

// == 6. Official split approval UI ===========================================
const uiDir = resolve(OFFICIAL_SPLIT_DIR, "ui/v0.1");
mkdirSync(uiDir, { recursive: true });
const EXPORT_FILENAME = "official-split-approval-decision.v0.1.json";
const APPROVE_DISPOSITION = "APPROVE_OFFICIAL_SPLIT_V0.3";
const UI_DATA = {
  v03_manifest_path: decisionTemplate.v03_manifest_path, v03_manifest_sha256: manifestSha256,
  v03_pool_path: decisionTemplate.v03_pool_path, v03_pool_sha256: poolV03Sha256,
  v03_anchor_path: decisionTemplate.v03_anchor_path, v03_anchor_sha256: anchorV03Sha256,
  v03_author_path: decisionTemplate.v03_author_path, v03_author_sha256: authorV03Sha256,
  anchor_count: anchorV03.length,
  candidate_pool_count: poolV03.length,
  author_count: authorV03.length,
  split_counts: splitCountsV03,
  author_counts: authorCountsV03,
  split_leakage_after: manifest.live_recomputed_values.split_leakage_after,
  author_leakage_after: manifest.live_recomputed_values.author_leakage_after,
  quarantine_intrusion_after: manifest.live_recomputed_values.quarantine_intrusion_after,
  critical_slice_floors_preserved: manifest.invariant_checks.critical_slice_floors_preserved,
  anchor_membership_unchanged: manifest.invariant_checks.anchor_membership_unchanged,
  export_filename: EXPORT_FILENAME,
  approve_disposition: APPROVE_DISPOSITION,
  checklist_items: [
    { id: "v03_leakage_zero", label: `split/author leakage가 v0.3에서 모두 0임을 확인했다 (split=${manifest.live_recomputed_values.split_leakage_after}, author=${manifest.live_recomputed_values.author_leakage_after})` },
    { id: "v03_quarantine_zero", label: `quarantine 침범이 없음을 확인했다 (${manifest.live_recomputed_values.quarantine_intrusion_after})` },
    { id: "v03_split_counts", label: `split 수 DEV_TUNE ${splitCountsV03.DEV_TUNE}/DEV_CHECK ${splitCountsV03.DEV_CHECK}/HOLDOUT ${splitCountsV03.HOLDOUT}이 유지됨을 확인했다` },
    { id: "v03_author_balance", label: `AUTHOR_A/AUTHOR_B ${authorCountsV03.AUTHOR_A}/${authorCountsV03.AUTHOR_B}이 유지됨을 확인했다` },
    { id: "v03_critical_slice", label: "critical slice floor가 v0.3에서도 유지됨을 확인했다" },
    { id: "v03_anchor_unchanged", label: "Anchor 150 멤버십과 내용이 v0.2 대비 전혀 바뀌지 않았음을 확인했다" },
    { id: "v02_files_not_overwritten", label: "v0.2/v0.1 기존 파일은 전혀 덮어쓰지 않고, v0.3는 완전히 새 파일로 생성되었음을 확인했다" },
    { id: "not_281_approval", label: "이 승인이 나머지 281건 관계를 의미상 승인하는 결정이 아님을 이해했다" },
    { id: "gold_not_authorized", label: "이 승인이 Gold 작성을 허가하는 것이 아님을 이해했다" },
    { id: "no_automatic_runtime_cutover", label: "이 승인이 Runtime/PostgreSQL/v0.20에 자동으로 반영되지 않으며, 실제 적용은 별도의 향후 조치가 필요함을 이해했다" },
  ],
};
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.17 Official Split Approval (v0.1)</title>
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
<h1>Turn N4.17 -- Final Official Split Approval (v0.3 candidate)</h1>

<div class="infobox">
<b>이 결정의 의미:</b> Turn N4.16에서 만든 v0.3 candidate 배정(Strategy A 적용됨)을 공식 split으로 지정할지 결정하는 <b>별도의 최종 게이트</b>다. 여기서 APPROVE해도 <b>Gold 작성은 허가되지 않으며</b>, <b>Runtime/PostgreSQL/v0.20에 자동 반영되지 않는다</b> -- 실제 적용은 별도의 향후 조치가 필요하다.
</div>

<h2>v0.3 검증 요약</h2>
<table><tr><th>지표</th><th>값</th></tr>
<tr><td>Anchor 수</td><td>${UI_DATA.anchor_count}</td></tr>
<tr><td>Candidate Pool 수</td><td>${UI_DATA.candidate_pool_count}</td></tr>
<tr><td>Author 수</td><td>${UI_DATA.author_count}</td></tr>
<tr><td>split 카운트</td><td>${esc(JSON.stringify(UI_DATA.split_counts))}</td></tr>
<tr><td>author 카운트</td><td>${esc(JSON.stringify(UI_DATA.author_counts))}</td></tr>
<tr><td>split leakage (after)</td><td>${UI_DATA.split_leakage_after}</td></tr>
<tr><td>author leakage (after)</td><td>${UI_DATA.author_leakage_after}</td></tr>
<tr><td>quarantine 침범 (after)</td><td>${UI_DATA.quarantine_intrusion_after}</td></tr>
<tr><td>critical slice floor 유지</td><td>${UI_DATA.critical_slice_floors_preserved}</td></tr>
<tr><td>Anchor 멤버십 불변</td><td>${UI_DATA.anchor_membership_unchanged}</td></tr>
</table>

<div class="warnbox">이 승인은 <b>나머지 281건 관계를 승인/거부하는 결정이 아니며</b>, <b>Gold 작성 승인도 아니다</b>. 아래 버튼을 눌러도 <b>gold_authoring_authorized와 actual_official_promotion_applied는 항상 false</b>로 내보내진다. official_split_eligible은 이 결정이 실제로 승인되었는지에 따라서만 정확히 결정된다.</div>

<h2>Owner 선택</h2>
<fieldset>
<label class="radio"><input type="radio" name="ownerChoice" value="${esc(APPROVE_DISPOSITION)}"/> ${esc(APPROVE_DISPOSITION)}</label>
<label class="radio"><input type="radio" name="ownerChoice" value="FIX_REQUIRED"/> FIX_REQUIRED</label>
<label class="radio"><input type="radio" name="ownerChoice" value="REJECT_PLAN"/> REJECT_PLAN</label>
</fieldset>
<div id="approveChecklist" class="checklist" hidden></div>
<label>Owner 이름/ID (필수)</label>
<input type="text" id="ownerName"/>
<label>owner_note (FIX_REQUIRED/REJECT_PLAN 시 필수)</label>
<textarea id="ownerNote"></textarea>
<div class="btnrow">
<button id="downloadBtn" disabled>Download Decision (JSON)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>

<script id="review-data" type="application/json">${JSON.stringify(UI_DATA)}</script>
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
    if (choice === "FIX_REQUIRED" || choice === "REJECT_PLAN") return !!ownerNoteEl.value.trim();
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
      owner: ownerNameEl.value.trim(),
      decided_at: new Date().toISOString(),
      owner_disposition: choice,
      owner_note: ownerNoteEl.value.trim() || null,
      v03_manifest_path: DATA.v03_manifest_path, v03_manifest_sha256: DATA.v03_manifest_sha256,
      v03_pool_path: DATA.v03_pool_path, v03_pool_sha256: DATA.v03_pool_sha256,
      v03_anchor_path: DATA.v03_anchor_path, v03_anchor_sha256: DATA.v03_anchor_sha256,
      v03_author_path: DATA.v03_author_path, v03_author_sha256: DATA.v03_author_sha256,
      anchor_count: DATA.anchor_count,
      candidate_pool_count: DATA.candidate_pool_count,
      author_count: DATA.author_count,
      split_counts: DATA.split_counts,
      author_counts: DATA.author_counts,
      split_leakage_after: DATA.split_leakage_after,
      author_leakage_after: DATA.author_leakage_after,
      quarantine_intrusion_after: DATA.quarantine_intrusion_after,
      critical_slice_floors_preserved: DATA.critical_slice_floors_preserved,
      anchor_membership_unchanged: DATA.anchor_membership_unchanged,
      anchor_membership_changed: false,
      relation_decisions_authorized: false,
      official_split_eligible: isGenuineApproval,
      gold_authoring_authorized: false,
      actual_official_promotion_applied: false,
      remaining_281_provisional_untouched: true,
      checklist: DATA.checklist_items.map(function (item) { return { id: item.id, label: item.label, checked: !!checklistState[item.id] }; }),
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
const htmlPath = resolve(uiDir, "official-split-approval.html");
writeFileSync(htmlPath, html, "utf8");
const htmlSha256 = sha256File(htmlPath);
writeJson(resolve(uiDir, "official-split-approval-build-report.json"), {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  html_path: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/ui/v0.1/official-split-approval.html",
  html_sha256: htmlSha256,
  export_filename: EXPORT_FILENAME,
  checklist_item_count: UI_DATA.checklist_items.length,
  auto_approved: false,
  gold_authoring_authorized_settable_by_this_ui: false,
  actual_official_promotion_applied_settable_by_this_ui: false,
  anchor_membership_changed_settable_by_this_ui: false,
  official_split_eligible_settable_by_this_ui: true,
  official_split_eligible_requires: "owner_disposition === APPROVE_OFFICIAL_SPLIT_V0.3 AND every checklist item checked",
});

console.log(JSON.stringify({
  status: "OFFICIAL_SPLIT_APPROVAL_PACKET_AND_UI_BUILT",
  v03_split_leakage_after: manifest.live_recomputed_values.split_leakage_after,
  v03_author_leakage_after: manifest.live_recomputed_values.author_leakage_after,
  v03_quarantine_intrusion_after: manifest.live_recomputed_values.quarantine_intrusion_after,
  html_sha256: htmlSha256,
  official_split_eligible: false,
  gold_authoring_authorized: false,
  actual_official_promotion_applied: false,
  output_dir: "work/handoff/anchor-dev-tune-v0.2/component-safe-reallocation-v0.1/official-split-approval-v0.1/",
}, null, 2));
