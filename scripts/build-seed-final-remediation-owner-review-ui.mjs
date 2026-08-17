// Turn M10 Section 15: a NEW offline Owner review UI for the 6-question
// Turn M10 remediation packet (r13 before / r14 after, per-defect
// before/after, applied Facts/Events, disclosure-group provenance for
// Q06). Initial disposition is PENDING for all 6 -- this is a FRESH
// judgement surface for r14, never a resurfacing of the ALREADY-DECIDED
// Turn M9 FINAL judgement. Q18's information_limit_accepted:true is
// carried forward READ-ONLY from the Turn M9 Owner decision -- the
// checkbox is pre-checked and disabled, never re-askable and never
// uncheckable, per Turn M10 Section 15's explicit instruction.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "work/handoff/seed-final-response-owner-review/ui/final-remediation-v0.1";
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-v020-final-remediation-owner-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "final-remediation-review-ui-build-report.json");

const REMEDIATION_PACKET_PATH = "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m10-remediation-packet.v0.1.json";
const OWNER_DECISION_V01_PATH = "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.jsonl";

const TARGET_QUESTION_IDS = Object.freeze([
  "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17",
  "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M10_REMEDIATION_UI_BUILD_BLOCKED: ${msg}`); }
async function readAbs(rel) { return readFile(path.join(REPO, rel)); }
export function escapeForScriptEmbedding(jsonText) { return jsonText.replace(/</g, "\\u003c"); }

async function main() {
  const packetBytes = await readAbs(REMEDIATION_PACKET_PATH);
  const packet = JSON.parse(packetBytes.toString("utf8"));
  const ownerDecisionBytes = await readAbs(OWNER_DECISION_V01_PATH);
  const ownerRecords = ownerDecisionBytes.toString("utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

  const packetQids = Object.keys(packet.questions);
  if (new Set(packetQids).size !== packetQids.length) fail("remediation packet has duplicate question_id keys");
  const missing = TARGET_QUESTION_IDS.filter((qid) => !packetQids.includes(qid));
  const extra = packetQids.filter((qid) => !TARGET_QUESTION_IDS.includes(qid));
  if (missing.length > 0) fail(`remediation packet missing target question(s): ${missing.join(",")}`);
  if (extra.length > 0) fail(`remediation packet has unexpected extra question(s): ${extra.join(",")}`);

  const q18OwnerRecord = ownerRecords.find((r) => r.question_id === "question_seed_v07_18");
  if (!q18OwnerRecord || q18OwnerRecord.information_limit_accepted !== true) {
    fail("Q18's Turn M9 Owner decision does not have information_limit_accepted:true -- cannot carry forward");
  }

  const records = TARGET_QUESTION_IDS.map((qid) => {
    const q = packet.questions[qid];
    return {
      question_id: qid,
      owner_notes_v01: q.owner_notes_v01,
      r13_answer: q.r13_answer,
      r14_answer: q.r14_answer,
      readable_diff: q.readable_diff,
      defect_before_after: q.defect_before_after,
      applied_facts: q.applied_facts,
      applied_events: q.applied_events,
      group_provenance: q.group_provenance,
      r13_sha256: q.r13_sha256,
      r14_sha256: q.r14_sha256,
    };
  });

  const payload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    remediation_packet_path: REMEDIATION_PACKET_PATH,
    remediation_packet_sha256: sha256(packetBytes),
    owner_decision_v01_path: OWNER_DECISION_V01_PATH,
    owner_decision_v01_sha256: sha256(ownerDecisionBytes),
    final_export_filename: "seed-v020-final-remediation-owner-decision.v0.1.jsonl",
    localstorage_key_prefix: "seed-v020-final-remediation-review::",
    default_reviewer: "최재완",
    q18_information_limit_accepted_locked: true,
    records,
  };

  const html = renderHtml(payload);
  await mkdir(path.join(REPO, OUT_DIR), { recursive: true });
  await writeFile(path.join(REPO, OUT_HTML_PATH), html, "utf8");

  const packetShaAfter = sha256(await readAbs(REMEDIATION_PACKET_PATH));
  const ownerDecisionShaAfter = sha256(await readAbs(OWNER_DECISION_V01_PATH));
  if (packetShaAfter !== payload.remediation_packet_sha256) fail("remediation packet changed during build");
  if (ownerDecisionShaAfter !== payload.owner_decision_v01_sha256) fail("Turn M9 Owner decision changed during build");

  const htmlBytes = await readAbs(OUT_HTML_PATH);
  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    output_html_path: OUT_HTML_PATH,
    output_html_sha256: sha256(htmlBytes),
    output_html_bytes: htmlBytes.length,
    final_export_filename: payload.final_export_filename,
    localstorage_key: `${payload.localstorage_key_prefix}${payload.remediation_packet_sha256}`,
    target_question_ids: TARGET_QUESTION_IDS,
    inputs: [
      { path: REMEDIATION_PACKET_PATH, sha256: payload.remediation_packet_sha256, unchanged_after_build: true },
      { path: OWNER_DECISION_V01_PATH, sha256: payload.owner_decision_v01_sha256, unchanged_after_build: true },
    ],
  };
  await writeFile(path.join(REPO, OUT_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    output_html_path: OUT_HTML_PATH, output_html_sha256: report.output_html_sha256, output_html_bytes: report.output_html_bytes,
    build_report_path: OUT_REPORT_PATH,
  }, null, 2));
}

function renderHtml(payload) {
  const escapedJson = escapeForScriptEmbedding(JSON.stringify(payload));
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Turn M10 재검수 (r14)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${CSS}
</style>
</head>
<body>
<header id="app-header">
  <h1>Turn M10 재검수 -- Owner FIX_REQUIRED 6문항의 r14 결과</h1>
  <div id="progress-bar"><span id="progress-counter">0/6</span> 판정 완료</div>
  <div id="header-actions">
    <button id="export-draft-btn" type="button">Draft JSONL export</button>
    <button id="export-final-btn" type="button" disabled>FINAL export (6/6 필요)</button>
    <button id="reset-btn" type="button">초기화</button>
  </div>
  <p class="hint">완전 오프라인, localStorage 저장, 자동 승인 없음. Q18의 information_limit_accepted=true는 Turn M9 Owner 결정에서 이월된 값이며 이 화면에서 재검수하거나 해제할 수 없습니다.</p>
</header>
<main id="app"></main>
<section id="export-panel" hidden>
  <h2 id="export-panel-title"></h2>
  <div id="export-actions">
    <button id="download-btn" type="button">파일로 다운로드</button>
    <button id="copy-btn" type="button">클립보드에 복사</button>
    <span id="export-message" role="status"></span>
  </div>
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
:root { color-scheme: light; --border:#d0d5dd; --bg:#f8f9fb; --card-bg:#ffffff; --danger:#b42318; --warn:#b54708; --ok:#067647; }
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
.card-body { padding: 18px; }
.section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin: 18px 0 8px; }
.section-title:first-of-type { margin-top: 0; }
.owner-notes { font-size: 13px; background: #fffaeb; border: 1px solid #fed7aa; border-radius: 8px; padding: 10px; white-space: pre-wrap; }
.answer-box { font-size: 16px; white-space: pre-wrap; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
.diff-box { font-size: 13px; white-space: pre-wrap; border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #fafafa; }
.diff-same { color: #374151; }
.diff-added { background: #dcfce7; color: #065f46; display: block; }
.diff-removed { background: #fee2e2; color: #991b1b; text-decoration: line-through; display: block; }
.defect-list { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.defect-list li::before { content: "RESOLVED "; color: var(--ok); font-weight: 700; }
table.fact-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
table.fact-table th, table.fact-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
.judgement-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.judgement-actions button { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-size: 13px; }
button.act-approve { background: #ecfdf3; border-color: #a6f4c5; color: var(--ok); }
button.act-fix { background: #fffaeb; border-color: #fed7aa; color: var(--warn); }
button.act-reject { background: #fef3f2; border-color: #fda29b; color: var(--danger); }
textarea.notes { width: 100%; min-height: 60px; font-size: 13px; padding: 8px; border-radius: 6px; border: 1px solid var(--border); }
.info-limit-gate { font-size: 13px; margin: 8px 0; color: #6b7280; }
.judgement-error { color: var(--danger); font-size: 13px; margin: 6px 0; min-height: 16px; }
#export-panel { max-width: 1100px; margin: 0 auto 40px; padding: 0 16px; }
#export-actions { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
#export-actions button { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border); background: #fff; cursor: pointer; }
#export-message { font-size: 13px; color: var(--ok); }
#export-output { width: 100%; font-family: monospace; font-size: 12px; }
`;

const CLIENT_SCRIPT = String.raw`
(function () {
  "use strict";
  var dataEl = document.getElementById("review-data");
  var payload = JSON.parse(dataEl.textContent);
  var STORAGE_KEY = payload.localstorage_key_prefix + payload.remediation_packet_sha256;
  var DISPOSITIONS = ["APPROVE_RESPONSE", "FIX_REQUIRED", "REJECT"];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) { for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]); } }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function txt(s) { return document.createTextNode(s == null ? "" : String(s)); }

  function defaultRecordState(qid) {
    return { owner_disposition: "PENDING", reviewer: null, reviewed_at: null, notes: null,
      information_limit_accepted: qid === "question_seed_v07_18" ? true : null };
  }
  function loadState() {
    var out = {};
    payload.records.forEach(function (r) { out[r.question_id] = defaultRecordState(r.question_id); });
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        payload.records.forEach(function (r) {
          if (parsed[r.question_id]) {
            var merged = Object.assign(defaultRecordState(r.question_id), parsed[r.question_id]);
            if (r.question_id === "question_seed_v07_18") merged.information_limit_accepted = true; // always locked true
            out[r.question_id] = merged;
          }
        });
      }
    } catch (e) { /* corrupted localStorage -- fall back to defaults */ }
    return out;
  }
  var state = loadState();
  function saveState() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function lcsRenderDiff(ops) {
    var box = el("div", { class: "diff-box" });
    ops.forEach(function (op) {
      if (op.type === "same") { box.appendChild(el("span", { class: "diff-same" }, [txt(op.text)])); box.appendChild(document.createElement("br")); }
      else if (op.type === "added") { box.appendChild(el("span", { class: "diff-added" }, [txt("+ " + op.text)])); }
      else { box.appendChild(el("span", { class: "diff-removed" }, [txt("- " + op.text)])); }
    });
    return box;
  }

  function renderFactTable(facts) {
    var table = el("table", { class: "fact-table" });
    var thead = el("tr", null, ["fact_id", "metric_code", "raw_label", "as_of_date"].map(function (h) { return el("th", null, [txt(h)]); }));
    table.appendChild(el("thead", null, [thead]));
    var tbody = el("tbody");
    (facts || []).forEach(function (f) {
      tbody.appendChild(el("tr", null, [
        el("td", null, [txt(f.fact_id)]), el("td", null, [txt(f.metric_code)]), el("td", null, [txt(f.raw_label)]), el("td", null, [txt(f.as_of_date)]),
      ]));
    });
    table.appendChild(tbody);
    return table;
  }

  function buildRecord(qid) {
    var s = state[qid];
    var record = payload.records.filter(function (r) { return r.question_id === qid; })[0];
    var releaseRecommendation = s.owner_disposition === "APPROVE_RESPONSE" ? "READY_FOR_V020_CONSIDERATION"
      : s.owner_disposition === "FIX_REQUIRED" ? "NEEDS_FIX_BEFORE_V020"
      : s.owner_disposition === "REJECT" ? "BLOCKS_V020" : "PENDING_REVIEW";
    return {
      review_item_id: "turn_m10_final_remediation_" + qid,
      question_id: qid,
      remediation_packet_path: payload.remediation_packet_path,
      remediation_packet_sha256: payload.remediation_packet_sha256,
      r14_response_sha256: record.r14_sha256,
      owner_disposition: s.owner_disposition,
      reviewer: s.reviewer,
      reviewed_at: s.reviewed_at,
      notes: s.notes,
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
    var badgeDisposition = el("span", { class: "badge badge-disposition-" + s.owner_disposition }, [txt(s.owner_disposition)]);
    var header = el("div", { class: "card-header" }, [el("h2", null, [txt(qid)]), badgeDisposition]);

    var body = el("div", { class: "card-body" });
    body.appendChild(el("div", { class: "section-title" }, [txt("Owner v0.1 FIX_REQUIRED notes")]));
    body.appendChild(el("div", { class: "owner-notes" }, [txt(record.owner_notes_v01)]));

    body.appendChild(el("div", { class: "section-title" }, [txt("r14 최종 답변")]));
    body.appendChild(el("div", { class: "answer-box" }, [txt(record.r14_answer)]));

    body.appendChild(el("div", { class: "section-title" }, [txt("결함별 before -> after (전부 검증 완료)")]));
    var defectUl = el("ul", { class: "defect-list" });
    record.defect_before_after.forEach(function (d) { defectUl.appendChild(el("li", null, [txt(d.defect)])); });
    body.appendChild(defectUl);

    body.appendChild(el("div", { class: "section-title" }, [txt("r13 -> r14 readable diff")]));
    body.appendChild(lcsRenderDiff(record.readable_diff));

    body.appendChild(el("div", { class: "section-title" }, [txt("적용된 Fact")]));
    body.appendChild(renderFactTable(record.applied_facts));

    if (record.applied_events && record.applied_events.length) {
      body.appendChild(el("div", { class: "section-title" }, [txt("적용된 Event")]));
      var evUl = el("ul");
      record.applied_events.forEach(function (e) { evUl.appendChild(el("li", null, [txt(e.event_id + " -- " + e.event_type + "(" + e.event_status + ") " + e.event_date)])); });
      body.appendChild(evUl);
    }

    if (record.group_provenance) {
      body.appendChild(el("div", { class: "section-title" }, [txt("Group provenance (corp_code + source_document_id)")]));
      var gpUl = el("ul");
      record.group_provenance.forEach(function (g) { gpUl.appendChild(el("li", null, [txt(g.slot_name + " -- " + g.fact_id + " -- " + g.corp_code + " / " + g.source_document_id)])); });
      body.appendChild(gpUl);
    }

    body.appendChild(el("div", { class: "section-title" }, [txt("Owner 판정")]));
    var errorBox = el("div", { class: "judgement-error" });
    if (qid === "question_seed_v07_18") {
      var gate = el("div", { class: "info-limit-gate" }, [
        txt("information_limit_accepted = true (Turn M9 Owner 결정에서 이월, 이 화면에서 재검수/해제 불가)"),
      ]);
      body.appendChild(gate);
    }
    var notes = el("textarea", { class: "notes", id: "notes-" + qid, placeholder: "notes (선택)" });
    notes.value = s.notes || "";
    var actions = el("div", { class: "judgement-actions" });
    var classMap = { APPROVE_RESPONSE: "act-approve", FIX_REQUIRED: "act-fix", REJECT: "act-reject" };
    DISPOSITIONS.forEach(function (disp) {
      var btn = el("button", { type: "button", class: classMap[disp], "data-action": disp, "data-question-id": qid }, [txt(disp)]);
      btn.addEventListener("click", function () {
        errorBox.textContent = "";
        state[qid].owner_disposition = disp;
        state[qid].reviewer = payload.default_reviewer;
        state[qid].reviewed_at = new Date().toISOString();
        state[qid].notes = notes.value || null;
        if (qid === "question_seed_v07_18") state[qid].information_limit_accepted = true;
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

    var card = el("div", { class: "card", "data-question-id": qid });
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

  var lastExportText = ""; var lastExportFilename = "";
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

  function doExport(mode) {
    var panel = document.getElementById("export-panel");
    var title = document.getElementById("export-panel-title");
    var output = document.getElementById("export-output");
    var msg = document.getElementById("export-message");
    msg.textContent = "";
    try {
      var lines = buildExportLines(mode);
      var text = lines.join("\n");
      var filename = mode === "final" ? payload.final_export_filename : "seed-v020-final-remediation-owner-decision.draft.jsonl";
      panel.hidden = false;
      title.textContent = filename;
      output.value = text;
      lastExportText = text; lastExportFilename = filename;
      triggerDownload(text, filename);
      msg.textContent = filename + " 다운로드를 시작했습니다.";
    } catch (e) {
      panel.hidden = false;
      title.textContent = "export blocked";
      output.value = "ERROR: " + e.message;
      lastExportText = ""; lastExportFilename = "";
    }
  }

  document.getElementById("export-draft-btn").addEventListener("click", function () { doExport("draft"); });
  document.getElementById("export-final-btn").addEventListener("click", function () { doExport("final"); });
  document.getElementById("download-btn").addEventListener("click", function () {
    var msg = document.getElementById("export-message");
    if (!lastExportText) { msg.textContent = "먼저 Draft 또는 FINAL export를 눌러주세요."; return; }
    triggerDownload(lastExportText, lastExportFilename);
    msg.textContent = lastExportFilename + " 다운로드를 시작했습니다.";
  });
  document.getElementById("copy-btn").addEventListener("click", function () {
    var msg = document.getElementById("export-message");
    var output = document.getElementById("export-output");
    if (!lastExportText) { msg.textContent = "먼저 Draft 또는 FINAL export를 눌러주세요."; return; }
    function fallbackCopy() {
      output.focus(); output.select();
      try { document.execCommand("copy"); msg.textContent = "클립보드에 복사했습니다."; }
      catch (e) { msg.textContent = "복사에 실패했습니다."; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lastExportText).then(function () { msg.textContent = "클립보드에 복사했습니다."; }, fallbackCopy);
    } else { fallbackCopy(); }
  });
  document.getElementById("reset-btn").addEventListener("click", function () {
    var ok = window.confirm("정말 초기화하시겠습니까? 모든 판정이 삭제됩니다.");
    if (!ok) return;
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state = {};
    payload.records.forEach(function (r) { state[r.question_id] = defaultRecordState(r.question_id); });
    renderAll();
  });

  window.__seedFinalRemediationReview = { buildExportLines: buildExportLines, buildRecord: buildRecord, getState: function () { return state; } };

  renderAll();
})();
`;

main().catch((error) => { console.error(error.message); process.exit(1); });
