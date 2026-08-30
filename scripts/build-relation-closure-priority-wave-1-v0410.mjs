#!/usr/bin/env node
// Turn N4.10: extracts "Priority Wave 1" -- the DYNAMICALLY computed union
// of Turn N4.9's 294-row provisional classification satisfying
// direct_cross_split_edge, direct_cross_author_edge, or
// individually_decisive -- from the existing 231-row
// targeted-provisional-relation-review-packet.v0.1.jsonl, and builds an
// independent double-review packet + Reviewer E/F UIs + gate status for
// JUST those rows.
//
// This script performs NO adjudication, NO auto-CONFIRM/REJECT, NO chain
// closure, and writes NO Gold. It never touches Turn N4.7/N4.8/N4.9's
// existing artifacts (the 231-row packet/UI/graph/gate files are read-only
// inputs here) and never writes outside its own
// work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/
// priority-wave-1-v0.1/ namespace.
//
// The selection distribution is NEVER hardcoded -- it is recomputed fresh
// from provisional-row-classification.v0.1.jsonl every run via
// domain/evaluation/relation-closure-priority-wave-selection.mjs, and this
// script FAILS CLOSED (exits 1, writes nothing) if the recomputed
// distribution or union size does not match the contract this Turn's
// instructions specified (4 / 0 / 12, 3 multi-condition, union 13) for the
// CURRENT real corpus data -- a genuine defense against silent drift, not
// a decorative check.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectPriorityWave1 } from "../domain/evaluation/relation-closure-priority-wave-selection.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function writeJson(p, obj) { writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8"); }
function writeJsonl(p, rows) { writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8"); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// -- 0. Fixed inputs (all read-only). ---------------------------------
const DR_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
const CLASSIFICATION_PATH = resolve(DR_DIR, "provisional-row-classification.v0.1.jsonl");
const TARGETED_PACKET_PATH = resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl");
const TARGETED_PACKET_MANIFEST_PATH = resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.manifest.json");
const COHORT_SUMMARY_PATH = resolve(DR_DIR, "targeted-impact-cohort-summary.v0.1.json");
const IMPACT_REPORT_PATH = resolve(DR_DIR, "decision-respecting-graph-impact-report.v0.1.json");
const COMPONENTS_PATH = resolve(DR_DIR, "decision-respecting-graph-components.v0.1.json");
const GATE_V04_PATH = resolve(DR_DIR, "gate-status.v0.4.json");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");

const outDir = resolve(DR_DIR, "priority-wave-1-v0.1");

// == 1. Input verification -- recompute SHA/row counts, cross-check against
// each artifact's own recorded manifest, ABORT before writing anything on
// mismatch. ==================================================================
const packet326 = readJsonl(PACKET_326_PATH);
if (packet326.length !== 326) { console.error(`BLOCKER: 326-packet row count ${packet326.length} !== 326`); process.exit(1); }
const packet326Sha256 = sha256File(PACKET_326_PATH);
const impactReport = readJson(IMPACT_REPORT_PATH);
if (impactReport.input_shas.relation_closure_review_packet_v01_sha256 !== packet326Sha256) { console.error("BLOCKER: 326-packet sha256 does not match Turn N4.9's own pin"); process.exit(1); }

const classifications = readJsonl(CLASSIFICATION_PATH);
if (classifications.length !== 294) { console.error(`BLOCKER: classification row count ${classifications.length} !== 294`); process.exit(1); }
const classificationSha256 = sha256File(CLASSIFICATION_PATH);
const cohortSummary = readJson(COHORT_SUMMARY_PATH);
if (cohortSummary.total_provisional_rows !== 294) { console.error("BLOCKER: targeted-impact-cohort-summary total_provisional_rows is not 294"); process.exit(1); }
const recomputedLabelCounts = {
  DIRECT_CROSS_SPLIT_EDGE: classifications.filter((c) => c.direct_cross_split_edge === true).length,
  DIRECT_CROSS_AUTHOR_EDGE: classifications.filter((c) => c.direct_cross_author_edge === true).length,
  INDIVIDUALLY_DECISIVE: classifications.filter((c) => c.individually_decisive === true).length,
  REDUNDANT_BUT_COMPONENT_RELEVANT: classifications.filter((c) => (c.labels ?? []).includes("REDUNDANT_BUT_COMPONENT_RELEVANT")).length,
  NO_CURRENT_SPLIT_IMPACT: classifications.filter((c) => (c.labels ?? []).includes("NO_CURRENT_SPLIT_IMPACT")).length,
};
for (const key of Object.keys(cohortSummary.label_counts)) {
  if (recomputedLabelCounts[key] !== cohortSummary.label_counts[key]) {
    console.error(`BLOCKER: recomputed label count for ${key} (${recomputedLabelCounts[key]}) does not match targeted-impact-cohort-summary.v0.1.json (${cohortSummary.label_counts[key]}) -- classification data has drifted`);
    process.exit(1);
  }
}

const targetedPacket = readJsonl(TARGETED_PACKET_PATH);
const targetedPacketManifest = readJson(TARGETED_PACKET_MANIFEST_PATH);
if (targetedPacket.length !== targetedPacketManifest.row_count) { console.error(`BLOCKER: targeted packet row count ${targetedPacket.length} !== manifest's ${targetedPacketManifest.row_count}`); process.exit(1); }
const targetedPacketSha256 = sha256File(TARGETED_PACKET_PATH);
if (targetedPacketSha256 !== targetedPacketManifest.sha256) { console.error("BLOCKER: targeted packet sha256 does not match its own manifest -- possible drift or tampering"); process.exit(1); }
if (targetedPacket.length !== 231) { console.error(`BLOCKER: targeted packet row count ${targetedPacket.length} !== 231 (Turn N4.9's own contract)`); process.exit(1); }

const components = readJson(COMPONENTS_PATH);
const gateV04 = readJson(GATE_V04_PATH);
if (gateV04.gates.official_split_eligible !== false) { console.error("BLOCKER: gate-status.v0.4.json's official_split_eligible is not false"); process.exit(1); }

// == 2. Dynamic Priority Wave 1 selection -- FAIL CLOSED before any write ===
const selection = selectPriorityWave1({ classifications });
const EXPECTED_DISTRIBUTION = { DIRECT_CROSS_SPLIT_EDGE: 4, DIRECT_CROSS_AUTHOR_EDGE: 0, INDIVIDUALLY_DECISIVE: 12 };
const EXPECTED_MULTI_CONDITION_COUNT = 3;
const EXPECTED_UNION_COUNT = 13;
const distributionMatches = Object.keys(EXPECTED_DISTRIBUTION).every((k) => selection.distribution[k] === EXPECTED_DISTRIBUTION[k]);
if (!distributionMatches) {
  console.error(`BLOCKER: recomputed Priority Wave 1 distribution ${JSON.stringify(selection.distribution)} does not match the contracted ${JSON.stringify(EXPECTED_DISTRIBUTION)} -- refusing to write any output`);
  process.exit(1);
}
if (selection.multiConditionCount !== EXPECTED_MULTI_CONDITION_COUNT) {
  console.error(`BLOCKER: recomputed multi-condition overlap count ${selection.multiConditionCount} !== ${EXPECTED_MULTI_CONDITION_COUNT} -- refusing to write any output`);
  process.exit(1);
}
if (selection.unionCount !== EXPECTED_UNION_COUNT) {
  console.error(`BLOCKER: recomputed Priority Wave 1 union size ${selection.unionCount} !== ${EXPECTED_UNION_COUNT} -- refusing to write any output`);
  process.exit(1);
}

// Every selected id must exist in the 231-row targeted packet (subset proof).
const targetedById = new Map(targetedPacket.map((r) => [r.relation_candidate_id, r]));
const missingFromTargeted = selection.relationCandidateIds.filter((id) => !targetedById.has(id));
if (missingFromTargeted.length > 0) {
  console.error(`BLOCKER: Priority Wave 1 ids not found in the 231-row targeted packet: ${missingFromTargeted.join(", ")}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// == 3. Build the 13-row Priority Wave 1 review packet (verbatim subset of
// the 231-row packet's own fields, plus dynamically computed selection
// reasons; owner_disposition/confirmed_target_document_id start fresh). ===
const priorityWave1Rows = selection.relationCandidateIds.map((rid) => {
  const sourceRow = targetedById.get(rid);
  return {
    relation_candidate_id: sourceRow.relation_candidate_id,
    source_document_id: sourceRow.source_document_id,
    relation_type: sourceRow.relation_type,
    source_report_name: sourceRow.source_report_name,
    source_receipt_date: sourceRow.source_receipt_date,
    source_info: sourceRow.source_info,
    candidates: sourceRow.candidates,
    current_split_author_impact: sourceRow.current_split_author_impact,
    priority_wave_1_selection_reasons: selection.reasonsById.get(rid),
    owner_disposition: "PENDING",
    confirmed_target_document_id: null,
  };
});
if (priorityWave1Rows.length !== 13) { console.error(`BLOCKER: built ${priorityWave1Rows.length} rows, expected 13`); process.exit(1); }
if (new Set(priorityWave1Rows.map((r) => r.relation_candidate_id)).size !== 13) { console.error("BLOCKER: duplicate relation_candidate_id in Priority Wave 1 packet"); process.exit(1); }

const packetPath = resolve(outDir, "priority-wave-1-review-packet.v0.1.jsonl");
writeJsonl(packetPath, priorityWave1Rows);
const packetSha256 = sha256File(packetPath);

// == 4. Manifest ============================================================
const manifest = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.10",
  status: "PRIORITY_WAVE_1_REVIEW_PACKET_BUILT_NO_ADJUDICATION",
  selection_rule: {
    description: "The union of every REVIEWER_CONSENSUS_PROVISIONAL row (from Turn N4.9's 294-row decision-respecting-graph classification) satisfying AT LEAST ONE of: direct_cross_split_edge===true, direct_cross_author_edge===true, individually_decisive===true. Computed dynamically from the input file every run -- never a hardcoded id list or count.",
    conditions: ["direct_cross_split_edge", "direct_cross_author_edge", "individually_decisive"],
    semantics_note: "Priority Wave 1 rows are NOT '틀린 관계'. They are the rows most likely to directly affect current split/author leakage IF a real relation is later confirmed at one of their candidate targets. Selection never implies or suggests a CONFIRM or REJECT outcome; DocumentIR content alone determines the correct disposition.",
  },
  inputs: {
    provisional_row_classification_v01: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/provisional-row-classification.v0.1.jsonl", sha256: classificationSha256, row_count: classifications.length },
    targeted_provisional_relation_review_packet_v01: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/targeted-provisional-relation-review-packet.v0.1.jsonl", sha256: targetedPacketSha256, row_count: targetedPacket.length },
    targeted_impact_cohort_summary_v01: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/targeted-impact-cohort-summary.v0.1.json", sha256: sha256File(COHORT_SUMMARY_PATH) },
    decision_respecting_graph_impact_report_v01: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/decision-respecting-graph-impact-report.v0.1.json", sha256: sha256File(IMPACT_REPORT_PATH) },
    decision_respecting_graph_components_v01: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/decision-respecting-graph-components.v0.1.json", sha256: sha256File(COMPONENTS_PATH) },
    gate_status_v04: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/gate-status.v0.4.json", sha256: sha256File(GATE_V04_PATH) },
    relation_closure_review_packet_v01: { path: "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl", sha256: packet326Sha256, row_count: packet326.length },
  },
  distribution: selection.distribution,
  multi_condition_count: selection.multiConditionCount,
  multi_condition_relation_candidate_ids: selection.multiConditionRelationCandidateIds,
  union_count: selection.unionCount,
  contract_verified: { distribution_matches: distributionMatches, multi_condition_count_matches: selection.multiConditionCount === EXPECTED_MULTI_CONDITION_COUNT, union_count_matches: selection.unionCount === EXPECTED_UNION_COUNT },
  output: { path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/priority-wave-1-review-packet.v0.1.jsonl", sha256: packetSha256, row_count: priorityWave1Rows.length },
  remaining_231_row_cohort_not_auto_processed: 231 - priorityWave1Rows.length,
  official_split_eligible: false,
  gold_authoring_status: "BLOCKED",
  no_auto_adjudication: true,
  no_confirm_reject_needs_more_review_assigned_by_this_script: true,
  existing_231_row_packet_and_ui_preserved_unmodified: true,
};
writeJson(resolve(outDir, "priority-wave-1-review-packet.v0.1.manifest.json"), manifest);

// == 5. Gate status =========================================================
const gate = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  turn: "N4.10",
  status: "INDEPENDENT_REVIEW_PENDING",
  reviewed_count: 0,
  pending_count: 13,
  official_split_eligible: false,
  chain_closure_status: "NOT_FINALIZED",
  gold_authoring_status: "BLOCKED_PENDING_PRIORITY_WAVE_1_REVIEW",
  remaining_cohort_note: `The other ${231 - 13} of the 231-row TARGETED_IMPACT_COHORT (REDUNDANT_BUT_COMPONENT_RELEVANT rows not otherwise direct/decisive) are NOT auto-approved, NOT auto-rejected, and NOT included in this Wave -- they remain PENDING in the existing 231-row packet, unmodified.`,
  next_step: "Reviewer E and Reviewer F independently adjudicate these 13 rows via priority-wave-1-reviewer-e.v0.1.html and priority-wave-1-reviewer-f.v0.1.html. A future Turn reconciles their exports -- this Turn performs no reconciliation.",
};
writeJson(resolve(outDir, "priority-wave-1-gate-status.v0.1.json"), gate);

// == 6. Reviewer E/F UIs (fixed role, isolated storage/export, JSONL download) =
function buildReviewerUi({ role, storageKey, exportFilename }) {
  const DATA = { role, rows: priorityWave1Rows, export_filename: exportFilename, packet_sha256: packetSha256 };
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<title>N4.10 Priority Wave 1 Review -- Reviewer ${esc(role)}</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1a1a1a;}
h1{font-size:20px;} h2{font-size:15px;}
.row{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0;}
.row h3{margin:0 0 6px;font-size:14px;}
.cand{border:1px solid #eee;border-radius:6px;padding:8px;margin:4px 0;font-size:13px;background:#fafafa;}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#eef;margin:0 4px 4px 0;}
.warnbox{background:#fff3cd;border:1px solid #e0c674;border-radius:6px;padding:10px 12px;margin:10px 0;font-size:12px;}
label{display:block;margin:6px 0;font-size:13px;}
select,textarea,input[type=text]{width:100%;box-sizing:border-box;padding:6px;font-size:13px;}
.btnrow{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;position:sticky;bottom:0;background:#fff;padding:10px 0;}
button{padding:10px 20px;font-size:15px;border-radius:6px;cursor:pointer;}
#exportBtn{border:1px solid #1a7f37;background:#1a7f37;color:#fff;cursor:not-allowed;opacity:.5;}
#exportBtn.enabled{cursor:pointer;opacity:1;}
#copyBtn{border:1px solid #555;background:#fff;color:#1a1a1a;cursor:not-allowed;opacity:.5;}
#copyBtn.enabled{cursor:pointer;opacity:1;}
#status{font-size:13px;margin-top:8px;}
#exportMessage{margin-top:10px;font-size:13px;}
#exportResult{margin-top:14px;font-size:12px;white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px;display:none;max-height:400px;overflow:auto;width:100%;box-sizing:border-box;}
</style></head>
<body>
<h1>Turn N4.10 -- Priority Wave 1 Review (Reviewer ${esc(role)})</h1>
<div class="warnbox">이 13건은 "틀린 관계"가 아니라 현재 split/author leakage에 가장 직접적으로 영향을 줄 가능성이 큰 관계다. CONFIRM을 유도하거나 REJECT를 유도하지 않는다 -- 실제 DocumentIR 원문 근거만으로 판정한다. 역할은 <b>Reviewer ${esc(role)}</b>로 빌드 시 고정되었으며 이 페이지 어디에서도 바꿀 수 없다.</div>
<div id="rows"></div>
<div class="btnrow">
<button id="exportBtn" disabled>FINAL Export (Reviewer ${esc(role)}) &amp; Download (JSONL)</button>
<button id="copyBtn" disabled>Copy to Clipboard</button>
</div>
<div id="status"></div>
<div id="exportMessage"></div>
<textarea id="exportResult" readonly></textarea>
<script id="review-data" type="application/json">${JSON.stringify(DATA)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById("review-data").textContent);
  var ROLE = DATA.role;
  var STORAGE_KEY = "${storageKey}";
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { state = {}; }

  var rowsEl = document.getElementById("rows");
  var exportBtn = document.getElementById("exportBtn");
  var copyBtn = document.getElementById("copyBtn");
  var statusEl = document.getElementById("status");
  var msgEl = document.getElementById("exportMessage");
  var resultEl = document.getElementById("exportResult");
  var lastExportText = "";

  function rowState(rid) {
    return state[rid] || { disposition: "PENDING", confirmed_target_document_id: null, note: "" };
  }
  function setRowState(rid, patch) {
    var current = rowState(rid);
    state[rid] = Object.assign({}, current, patch);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    updateStatus();
  }
  function isJudged(r) {
    var s = rowState(r.relation_candidate_id);
    if (s.disposition === "PENDING") return false;
    if (!s.note || !s.note.trim()) return false;
    if (s.disposition === "CONFIRM" && !s.confirmed_target_document_id) return false;
    if (s.disposition !== "CONFIRM" && s.confirmed_target_document_id) return false;
    return true;
  }
  function allJudged() { return DATA.rows.every(isJudged); }
  function updateStatus() {
    var judged = DATA.rows.filter(isJudged).length;
    statusEl.textContent = "judged " + judged + " / " + DATA.rows.length;
    var ok = allJudged();
    exportBtn.disabled = !ok; exportBtn.classList.toggle("enabled", ok);
    copyBtn.disabled = !ok; copyBtn.classList.toggle("enabled", ok);
  }

  function render() {
    rowsEl.textContent = "";
    DATA.rows.forEach(function (row) {
      var s = rowState(row.relation_candidate_id);
      var div = document.createElement("div");
      div.className = "row";
      var h3 = document.createElement("h3");
      h3.textContent = row.relation_candidate_id + " -- " + row.source_document_id + " (" + row.relation_type + ")";
      div.appendChild(h3);
      (row.priority_wave_1_selection_reasons || []).forEach(function (l) {
        var b = document.createElement("span"); b.className = "badge"; b.textContent = l; div.appendChild(b);
      });
      var candWrap = document.createElement("div");
      row.candidates.forEach(function (c) {
        var cdiv = document.createElement("div"); cdiv.className = "cand";
        cdiv.textContent = c.target_document_id + " (score " + c.score + ") " + (c.target_report_name || "");
        candWrap.appendChild(cdiv);
      });
      div.appendChild(candWrap);

      var dispLabel = document.createElement("label");
      dispLabel.textContent = "판정 (CONFIRM/REJECT/NEEDS_MORE_REVIEW)";
      var dispSelect = document.createElement("select");
      ["PENDING", "CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"].forEach(function (opt) {
        var o = document.createElement("option"); o.value = opt; o.textContent = opt;
        if (s.disposition === opt) o.selected = true;
        dispSelect.appendChild(o);
      });
      dispLabel.appendChild(dispSelect);
      div.appendChild(dispLabel);

      var targetLabel = document.createElement("label");
      targetLabel.textContent = "target (CONFIRM일 때만 정확히 1개 필수)";
      var targetSelect = document.createElement("select");
      var emptyOpt = document.createElement("option"); emptyOpt.value = ""; emptyOpt.textContent = "(none)";
      targetSelect.appendChild(emptyOpt);
      row.candidates.forEach(function (c) {
        var o = document.createElement("option"); o.value = c.target_document_id; o.textContent = c.target_document_id;
        if (s.confirmed_target_document_id === c.target_document_id) o.selected = true;
        targetSelect.appendChild(o);
      });
      targetSelect.disabled = dispSelect.value !== "CONFIRM";
      targetLabel.appendChild(targetSelect);
      div.appendChild(targetLabel);

      var noteLabel = document.createElement("label");
      noteLabel.textContent = "note (필수, DocumentIR 근거)";
      var noteInput = document.createElement("textarea");
      noteInput.value = s.note || "";
      noteLabel.appendChild(noteInput);
      div.appendChild(noteLabel);

      dispSelect.addEventListener("change", function () {
        var isConfirm = dispSelect.value === "CONFIRM";
        targetSelect.disabled = !isConfirm;
        if (!isConfirm) targetSelect.value = "";
        setRowState(row.relation_candidate_id, { disposition: dispSelect.value, confirmed_target_document_id: isConfirm ? (targetSelect.value || null) : null, note: noteInput.value });
      });
      targetSelect.addEventListener("change", function () {
        setRowState(row.relation_candidate_id, { confirmed_target_document_id: targetSelect.value || null });
      });
      noteInput.addEventListener("input", function () {
        setRowState(row.relation_candidate_id, { note: noteInput.value });
      });

      rowsEl.appendChild(div);
    });
    updateStatus();
  }

  function buildRecords() {
    return DATA.rows.map(function (r) {
      var s = rowState(r.relation_candidate_id);
      return {
        schema_version: "0.1.0",
        reviewer_role: ROLE,
        relation_candidate_id: r.relation_candidate_id,
        disposition: s.disposition,
        confirmed_target_document_id: s.confirmed_target_document_id,
        note: s.note,
        packet_sha256: DATA.packet_sha256,
        exported_at: new Date().toISOString(),
      };
    });
  }
  function buildJsonlText() {
    return buildRecords().map(function (r) { return JSON.stringify(r); }).join("\\n") + "\\n";
  }
  function triggerDownload(text, filename) {
    var blob = new Blob([text], { type: "application/x-ndjson" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  exportBtn.addEventListener("click", function () {
    if (!allJudged()) return;
    var text = buildJsonlText();
    lastExportText = text;
    resultEl.style.display = "block";
    resultEl.value = text;
    triggerDownload(text, DATA.export_filename);
    msgEl.textContent = DATA.export_filename + " 다운로드를 시작했습니다.";
  });
  copyBtn.addEventListener("click", function () {
    if (!allJudged()) return;
    var text = lastExportText || buildJsonlText();
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

  render();
})();
</script>
</body></html>
`;
}

const uiDir = resolve(outDir, "ui/v0.1");
mkdirSync(uiDir, { recursive: true });
const htmlE = buildReviewerUi({ role: "REVIEWER_E", storageKey: "n4.10-reviewer-e-priority-wave-1-v0.1", exportFilename: "priority-wave-1-reviewer-e-decision.v0.1.jsonl" });
const htmlF = buildReviewerUi({ role: "REVIEWER_F", storageKey: "n4.10-reviewer-f-priority-wave-1-v0.1", exportFilename: "priority-wave-1-reviewer-f-decision.v0.1.jsonl" });
const htmlEPath = resolve(uiDir, "priority-wave-1-reviewer-e.v0.1.html");
const htmlFPath = resolve(uiDir, "priority-wave-1-reviewer-f.v0.1.html");
writeFileSync(htmlEPath, htmlE, "utf8");
writeFileSync(htmlFPath, htmlF, "utf8");
const reviewerUiReport = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  reviewer_e: { html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/ui/v0.1/priority-wave-1-reviewer-e.v0.1.html", html_sha256: sha256File(htmlEPath), storage_key: "n4.10-reviewer-e-priority-wave-1-v0.1", export_filename: "priority-wave-1-reviewer-e-decision.v0.1.jsonl", reviewer_role: "REVIEWER_E" },
  reviewer_f: { html_path: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1/ui/v0.1/priority-wave-1-reviewer-f.v0.1.html", html_sha256: sha256File(htmlFPath), storage_key: "n4.10-reviewer-f-priority-wave-1-v0.1", export_filename: "priority-wave-1-reviewer-f-decision.v0.1.jsonl", reviewer_role: "REVIEWER_F" },
  row_count: priorityWave1Rows.length,
  role_fixed_at_build_time: true,
  role_changeable_via_url_query_or_prompt_or_select: false,
  auto_approval_or_majority_vote_or_chain_closure_computed: false,
};
writeJson(resolve(uiDir, "priority-wave-1-reviewer-ui-build-report.json"), reviewerUiReport);

console.log(JSON.stringify({
  status: "PRIORITY_WAVE_1_REVIEW_PACKET_BUILT_NO_ADJUDICATION",
  out_dir: "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1/priority-wave-1-v0.1",
  distribution: selection.distribution,
  multi_condition_count: selection.multiConditionCount,
  union_count: selection.unionCount,
  packet_sha256: packetSha256,
  reviewer_ui: reviewerUiReport,
}, null, 2));
