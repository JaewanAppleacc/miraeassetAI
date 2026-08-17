// Turn M3 item 10: a fully offline, single-file HTML review UI for the 8
// NEW CANDIDATE Facts authored by scripts/build-seed-structured-gap-fact-batch-m3.mjs.
// Shows, side by side, exactly what Turn M3 item 10 asks for: the real
// quoted_text, the Candidate Fact itself (metric_code/value_type/period/
// scope/unit), full provenance (source_document_id/evidence_id/
// as_of_date/known_at), and the relevant existing Owner note (v0.7) --
// so the Owner never has to re-read the original filing to judge these.
// Decision buttons APPROVE/FIX_REQUIRED/REJECT, all starting PENDING, no
// AI auto-approval. Read-only over the Candidate/decision artifacts --
// never modifies them.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidates as buildFactBatchM3 } from "./build-seed-structured-gap-fact-batch-m3.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/ui/data-candidates-v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "review-ui-build-report.json");
const FINAL_EXPORT_FILENAME = "seed-structured-gap-candidate-owner-decision.v0.1.jsonl";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

const QUESTION_ID_BY_METRIC = {
  CONTRACT_COUNTERPARTY: "question_seed_v07_09",
  LATEST_CONTRACT_AMOUNT: "question_seed_v07_17",
  CONTRACT_RESERVATION_DEADLINE: "question_seed_v07_25",
};

async function main() {
  const { facts, linkages } = await buildFactBatchM3();
  const decisionBytes = await readFile(DECISION_PATH);
  const decisionRows = decisionBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const decisionByQid = new Map(decisionRows.map((r) => [r.question_id, r]));
  const evidenceBytes = await readFile(EVIDENCE_VERIFIED_PATH);
  const evidenceRows = evidenceBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));
  const linkageByFactId = new Map(linkages.map((l) => [l.fact_id, l]));

  const records = facts.map((fact) => {
    const linkage = linkageByFactId.get(fact.fact_id);
    const evidence = evidenceById.get(fact.evidence_ids[0]);
    const questionId = QUESTION_ID_BY_METRIC[fact.metric_code];
    const decision = decisionByQid.get(questionId);
    return {
      fact_id: fact.fact_id,
      question_id: questionId,
      owner_note: decision?.notes ?? null,
      corp_code: fact.corp_code,
      metric_code: fact.metric_code,
      raw_label: fact.raw_label,
      value_type: fact.value_type,
      value_certainty: fact.value_certainty,
      normalized_value: fact.normalized_value,
      unit: fact.unit,
      scope: fact.scope,
      period_type: fact.period_type,
      as_of_date: fact.as_of_date,
      known_at: fact.known_at,
      source_document_id: fact.source_document_id,
      evidence_id: fact.evidence_ids[0],
      quoted_text: evidence?.quoted_text ?? null,
      source_locator: evidence?.source_locator ?? null,
      evidence_verification_status: evidence?.verification_status ?? null,
      ontology_reuse_basis: fact.attributes.review_provenance.ontology_reuse_basis,
      gap_basis: fact.attributes.review_provenance.audit_basis,
      review_note: linkage?.notes ?? null,
    };
  });

  const payload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(decisionBytes),
    fact_candidates_path: "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
    final_export_filename: FINAL_EXPORT_FILENAME,
    records,
  };

  const html = buildHtml(payload);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_HTML_PATH, html, "utf8");

  const htmlBytes = Buffer.from(html, "utf8");
  const report = {
    schema_version: "0.1.0",
    generated_at: payload.generated_at,
    output_html_path: path.relative(REPO, OUT_HTML_PATH),
    output_html_sha256: sha256(htmlBytes),
    record_count: records.length,
    final_export_filename: FINAL_EXPORT_FILENAME,
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output_html_sha256: report.output_html_sha256, record_count: records.length }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Turn M3 구조화 Candidate 검수</title>",
    "<style>", CSS_TEXT, "</style>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    '<script type="application/json" id="review-data">' + dataJson + "</script>",
    "<script>", LOGIC_SCRIPT, "</script>",
    "</body>", "</html>", "",
  ].join("\n");
}

const CSS_TEXT = [
  ":root { --border:#d0d0d0; --bg:#fafafa; --card-bg:#fff; --accent:#2b579a; --ok:#166534; --warn:#92400e; --danger:#991b1b; --muted:#666; }",
  "* { box-sizing: border-box; }",
  "body { margin:0; font-family:-apple-system,'Malgun Gothic','Apple SD Gothic Neo',sans-serif; background:var(--bg); color:#1a1a1a; }",
  "#app { max-width: 900px; margin: 0 auto; padding: 16px; padding-bottom: 120px; }",
  "header.topbar { position: sticky; top:0; background:var(--bg); padding: 10px 0; border-bottom: 1px solid var(--border); z-index: 10; }",
  "header.topbar h1 { font-size: 16px; margin: 0 0 6px; }",
  ".meta-line { font-size: 11px; color: var(--muted); margin-bottom: 6px; word-break: break-all; }",
  ".progress-wrap { background:#e5e5e5; border-radius: 6px; height: 10px; overflow:hidden; margin-bottom: 6px; }",
  ".progress-bar { background: var(--accent); height: 100%; }",
  ".progress-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }",
  ".toolbar { display:flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }",
  ".nav-btn, .export-btn, .reset-btn { font-size: 13px; padding: 6px 12px; border: 1px solid var(--border); background:#fff; border-radius: 6px; cursor:pointer; }",
  ".export-btn.final { border-color: var(--ok); color: var(--ok); font-weight:600; }",
  ".export-btn:disabled { opacity:.4; cursor:default; border-color:var(--border); color:var(--muted); }",
  ".reset-btn { border-color: var(--danger); color: var(--danger); }",
  ".card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin: 14px 0; }",
  ".card-head { display:flex; justify-content: space-between; align-items:flex-start; gap: 8px; flex-wrap: wrap; }",
  ".qid { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }",
  ".disposition-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight:600; background:#f3f4f6; color:#4b5563; }",
  ".disposition-badge.APPROVE { background:#dcfce7; color:var(--ok); }",
  ".disposition-badge.FIX_REQUIRED { background:#fef3c7; color:var(--warn); }",
  ".disposition-badge.REJECT { background:#fee2e2; color:var(--danger); }",
  ".quote-box { white-space: pre-wrap; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px; padding:10px; font-size: 13px; line-height:1.5; margin: 8px 0; }",
  ".fact-table { width:100%; border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }",
  ".fact-table td { padding: 4px 8px; border-bottom: 1px solid #eee; vertical-align: top; }",
  ".fact-table td.k { color: var(--muted); white-space: nowrap; width: 160px; }",
  ".owner-note-box { white-space: pre-wrap; background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:10px; font-size: 12px; line-height:1.5; margin: 8px 0; }",
  ".basis-box { font-size: 11.5px; color:#4b5563; margin: 6px 0; }",
  ".decision-row { display:flex; flex-wrap:wrap; gap: 6px; margin: 10px 0 6px; }",
  ".decision-btn { font-size: 13px; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background:#fff; cursor:pointer; }",
  ".decision-btn.APPROVE.selected { background: var(--ok); color:#fff; border-color: var(--ok); }",
  ".decision-btn.FIX_REQUIRED.selected { background: var(--warn); color:#fff; border-color: var(--warn); }",
  ".decision-btn.REJECT.selected { background: var(--danger); color:#fff; border-color: var(--danger); }",
  ".notes-box { width:100%; min-height: 50px; font-size: 13px; font-family: inherit; border:1px solid var(--border); border-radius:6px; padding: 6px; margin-top:4px; }",
  ".decision-meta { font-size: 11px; color: var(--muted); margin-top: 4px; }",
  ".footer-nav { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 10px 0; display:flex; justify-content: space-between; align-items:center; gap: 8px; }",
].join("\n");

const LOGIC_SCRIPT = [
"(function () {",
"  'use strict';",
"  var REVIEWER_NAME = '\\uCD5C\\uC7AC\\uC644';",
"  var DATA = JSON.parse(document.getElementById('review-data').textContent);",
"  var FINAL_EXPORT_FILENAME = DATA.final_export_filename;",
"  var RECORDS = DATA.records;",
"  var IDS = RECORDS.map(function (r) { return r.fact_id; });",
"  var BY_ID = {};",
"  RECORDS.forEach(function (r) { BY_ID[r.fact_id] = r; });",
"  var STORAGE_KEY = 'seed-structured-gap-candidate-review-v0.1-state-' + DATA.source_decision_sha256;",
"",
"  function buildInitialState() {",
"    var state = {};",
"    IDS.forEach(function (id) { state[id] = { disposition: 'PENDING', reviewer: null, reviewed_at: null, notes: null }; });",
"    return state;",
"  }",
"  function loadState() {",
"    var fresh = buildInitialState();",
"    var raw;",
"    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }",
"    if (!raw) return fresh;",
"    var parsed;",
"    try { parsed = JSON.parse(raw); } catch (e) { return fresh; }",
"    IDS.forEach(function (id) { if (parsed[id]) fresh[id] = parsed[id]; });",
"    return fresh;",
"  }",
"  var reviewState = loadState();",
"  var currentIndex = 0;",
"  function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(reviewState)); } catch (e) {} }",
"  function judgedCount() { var n = 0; IDS.forEach(function (id) { if (reviewState[id].disposition !== 'PENDING') n++; }); return n; }",
"  function allJudged() { return judgedCount() === IDS.length; }",
"",
"  function el(tag, attrs, children) {",
"    var node = document.createElement(tag);",
"    if (attrs) { for (var k in attrs) { if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;",
"      if (k === 'className') node.className = attrs[k];",
"      else if (k === 'text') node.textContent = attrs[k];",
"      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);",
"      else node.setAttribute(k, attrs[k]); } }",
"    (children || []).forEach(function (c) { if (c) node.appendChild(c); });",
"    return node;",
"  }",
"  function text(tag, className, str) { return el(tag, { className: className, text: str }); }",
"",
"  function downloadText(filename, content) {",
"    var blob = new Blob([content], { type: 'application/x-ndjson' });",
"    var url = URL.createObjectURL(blob);",
"    var a = document.createElement('a'); a.href = url; a.download = filename;",
"    document.body.appendChild(a); a.click(); document.body.removeChild(a);",
"    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);",
"  }",
"",
"  function buildRecord(id) {",
"    var record = BY_ID[id]; var entry = reviewState[id];",
"    return {",
"      fact_id: id, question_id: record.question_id, metric_code: record.metric_code,",
"      owner_disposition: entry.disposition, reviewer: entry.reviewer, reviewed_at: entry.reviewed_at, notes: entry.notes,",
"    };",
"  }",
"  function buildExportLines() { return IDS.map(function (id) { return JSON.stringify(buildRecord(id)); }).join('\\n') + '\\n'; }",
"",
"  function applyDecision(id, disposition) {",
"    var now = new Date().toISOString();",
"    reviewState[id] = { disposition: disposition, reviewer: REVIEWER_NAME, reviewed_at: now, notes: reviewState[id].notes };",
"    saveState(); render();",
"  }",
"",
"  function renderHeader() {",
"    var judged = judgedCount();",
"    var pct = Math.round((judged / IDS.length) * 100);",
"    var header = el('header', { className: 'topbar' }, [",
"      text('h1', null, 'Turn M3 \\uAD6C\\uC870\\uD654 Candidate \\uAC80\\uC218 (' + IDS.length + '\\uAC74)'),",
"      text('div', 'meta-line', 'source: ' + DATA.fact_candidates_path),",
"      el('div', { className: 'progress-wrap' }, [el('div', { className: 'progress-bar', style: 'width:' + pct + '%' })]),",
"      text('div', 'progress-label', '\\uC9C4\\uD589\\uB960: ' + judged + ' / ' + IDS.length + ' (' + pct + '%)'),",
"    ]);",
"    var exportRow = el('div', { className: 'toolbar' });",
"    var draftBtn = text('button', 'export-btn', 'Draft JSONL \\uB2E4\\uC6B4\\uB85C\\uB4DC');",
"    draftBtn.addEventListener('click', function () { downloadText('seed-structured-gap-candidate-review-draft.jsonl', buildExportLines()); });",
"    var finalBtn = text('button', 'export-btn final', 'FINAL \\uB0B4\\uBCF4\\uB0B4\\uAE30 (' + FINAL_EXPORT_FILENAME + ')');",
"    finalBtn.disabled = !allJudged();",
"    finalBtn.addEventListener('click', function () {",
"      if (!allJudged()) { alert(IDS.length + '\\uAC74 \\uC804\\uBD80 \\uD310\\uC815\\uD574\\uC57C FINAL \\uB0B4\\uBCF4\\uB0B4\\uAE30\\uAC00 \\uAC00\\uB2A5\\uD569\\uB2C8\\uB2E4.'); return; }",
"      downloadText(FINAL_EXPORT_FILENAME, buildExportLines());",
"    });",
"    var resetBtn = text('button', 'reset-btn', '\\uCD08\\uAE30\\uD654');",
"    resetBtn.addEventListener('click', function () {",
"      if (!confirm('\\uBAA8\\uB4E0 \\uAC80\\uC218 \\uC0C1\\uD0DC\\uB97C \\uCD08\\uAE30\\uD654\\uD569\\uB2C8\\uB2E4. \\uACC4\\uC18D\\uD558\\uC2DC\\uACA0\\uC2B5\\uB2C8\\uAE4C?')) return;",
"      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}",
"      reviewState = buildInitialState(); currentIndex = 0; render();",
"    });",
"    exportRow.appendChild(draftBtn); exportRow.appendChild(finalBtn); exportRow.appendChild(resetBtn);",
"    header.appendChild(exportRow);",
"    return header;",
"  }",
"",
"  function factRow(k, v) {",
"    return el('tr', {}, [text('td', 'k', k), text('td', '', v === null || v === undefined ? '-' : String(v))]);",
"  }",
"",
"  function renderCard(id) {",
"    var record = BY_ID[id]; var entry = reviewState[id];",
"    var card = el('div', { className: 'card' });",
"    card.appendChild(el('div', { className: 'card-head' }, [",
"      el('div', {}, [text('div', 'qid', record.fact_id), text('div', 'qid', record.question_id + ' \\u2192 ' + record.metric_code)]),",
"      text('span', 'disposition-badge ' + entry.disposition, entry.disposition),",
"    ]));",
"    if (record.owner_note) card.appendChild(el('div', { className: 'owner-note-box' }, [text('b', null, 'Owner note (v0.7): '), document.createTextNode(record.owner_note)]));",
"    card.appendChild(text('h4', null, '\\uC6D0\\uBB38 quoted_text (VERIFIED Evidence)'));",
"    var quoteBox = el('div', { className: 'quote-box' }); quoteBox.textContent = record.quoted_text; card.appendChild(quoteBox);",
"    card.appendChild(text('h4', null, '\\uC0C8 Candidate Fact'));",
"    var table = el('table', { className: 'fact-table' });",
"    table.appendChild(factRow('corp_code', record.corp_code));",
"    table.appendChild(factRow('metric_code', record.metric_code));",
"    table.appendChild(factRow('raw_label', record.raw_label));",
"    table.appendChild(factRow('value_type / certainty', record.value_type + ' / ' + record.value_certainty));",
"    table.appendChild(factRow('normalized_value', record.normalized_value));",
"    table.appendChild(factRow('unit', record.unit));",
"    table.appendChild(factRow('scope / period_type', record.scope + ' / ' + record.period_type));",
"    table.appendChild(factRow('as_of_date', record.as_of_date));",
"    table.appendChild(factRow('known_at', record.known_at));",
"    table.appendChild(factRow('source_document_id', record.source_document_id));",
"    table.appendChild(factRow('evidence_id', record.evidence_id));",
"    table.appendChild(factRow('source_locator', record.source_locator));",
"    table.appendChild(factRow('evidence verification_status', record.evidence_verification_status));",
"    card.appendChild(table);",
"    card.appendChild(el('div', { className: 'basis-box' }, [text('b', null, 'ontology reuse basis: '), document.createTextNode(record.ontology_reuse_basis)]));",
"    card.appendChild(el('div', { className: 'basis-box' }, [text('b', null, 'gap basis: '), document.createTextNode(record.gap_basis)]));",
"",
"    var decisionRow = el('div', { className: 'decision-row' });",
"    [['APPROVE','APPROVE'],['FIX_REQUIRED','FIX_REQUIRED'],['REJECT','REJECT']].forEach(function (pair) {",
"      var btn = text('button', 'decision-btn ' + pair[0] + (entry.disposition === pair[0] ? ' selected' : ''), pair[1]);",
"      btn.addEventListener('click', function () { applyDecision(id, pair[0]); });",
"      decisionRow.appendChild(btn);",
"    });",
"    card.appendChild(decisionRow);",
"    var notes = el('textarea', { className: 'notes-box', placeholder: 'notes (\\uC120\\uD0DD)' });",
"    notes.value = entry.notes || '';",
"    notes.addEventListener('input', function () { entry.notes = notes.value === '' ? null : notes.value; saveState(); });",
"    card.appendChild(notes);",
"    var metaLine = entry.disposition === 'PENDING' ? '\\uD310\\uC815 \\uC804' : ('reviewer: ' + entry.reviewer + ' | reviewed_at: ' + entry.reviewed_at);",
"    card.appendChild(text('div', 'decision-meta', metaLine));",
"    return card;",
"  }",
"",
"  function renderNav() {",
"    var nav = el('div', { className: 'footer-nav' });",
"    var prevBtn = text('button', 'nav-btn', '\\u2190 \\uC774\\uC804');",
"    prevBtn.disabled = currentIndex <= 0;",
"    prevBtn.addEventListener('click', function () { if (currentIndex > 0) { currentIndex--; render(); } });",
"    var posLabel = text('span', null, (currentIndex + 1) + ' / ' + IDS.length);",
"    var nextBtn = text('button', 'nav-btn', '\\uB2E4\\uC74C \\u2192');",
"    nextBtn.disabled = currentIndex >= IDS.length - 1;",
"    nextBtn.addEventListener('click', function () { if (currentIndex < IDS.length - 1) { currentIndex++; render(); } });",
"    nav.appendChild(prevBtn); nav.appendChild(posLabel); nav.appendChild(nextBtn);",
"    return nav;",
"  }",
"",
"  function render() {",
"    var app = document.getElementById('app');",
"    while (app.firstChild) app.removeChild(app.firstChild);",
"    app.appendChild(renderHeader());",
"    app.appendChild(renderCard(IDS[currentIndex]));",
"    app.appendChild(renderNav());",
"  }",
"",
"  document.addEventListener('keydown', function (ev) {",
"    var tag = document.activeElement && document.activeElement.tagName;",
"    if (tag === 'TEXTAREA' || tag === 'INPUT') return;",
"    if (ev.key === 'ArrowLeft') { if (currentIndex > 0) { currentIndex--; render(); } }",
"    else if (ev.key === 'ArrowRight') { if (currentIndex < IDS.length - 1) { currentIndex++; render(); } }",
"    else if ((ev.key === 'a' || ev.key === 'A')) applyDecision(IDS[currentIndex], 'APPROVE');",
"    else if ((ev.key === 'f' || ev.key === 'F')) applyDecision(IDS[currentIndex], 'FIX_REQUIRED');",
"    else if ((ev.key === 'r' || ev.key === 'R')) applyDecision(IDS[currentIndex], 'REJECT');",
"  });",
"",
"  render();",
"})();",
].join("\n");

main().catch((error) => { console.error(error.message); process.exit(1); });
