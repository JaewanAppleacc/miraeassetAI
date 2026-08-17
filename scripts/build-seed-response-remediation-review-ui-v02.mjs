// Turn M item 5: builds a fully offline, single-file HTML "before/after"
// review UI for exactly the 24 FIX_REQUIRED items so the Owner does not
// need to re-read the full 25-question packet. Reads-only against the
// remediation matrix / r4 (before) / r7 (after) wire / preserved decision
// -- never modifies them. Output is two brand-new files under
// work/handoff/seed-final-response-owner-review/ui/v0.2/ -- the existing
// v0.1 UI/packet/decision files are untouched.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const WIRE_R4_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r4");
const WIRE_R7_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r7");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/ui/v0.2");
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-response-remediation-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function readWireAnswer(dir, questionId) {
  const bytes = await readFile(path.join(dir, `${questionId}.response.json`));
  const wire = JSON.parse(bytes.toString("utf8"));
  return { answer: wire.answer, sha256: sha256(bytes) };
}

async function main() {
  const beforeMatrixBytes = await readFile(MATRIX_PATH);
  const matrixRows = beforeMatrixBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const decisionBytes = await readFile(DECISION_PATH);
  const decisionRows = decisionBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const decisionByQid = new Map(decisionRows.map((r) => [r.question_id, r]));

  if (matrixRows.length !== 24) throw new Error(`BLOCKER: expected 24 remediation rows, found ${matrixRows.length}`);

  const records = [];
  for (const row of matrixRows) {
    const decision = decisionByQid.get(row.question_id);
    if (!decision) throw new Error(`BLOCKER: no decision record for ${row.question_id}`);
    const before = await readWireAnswer(WIRE_R4_DIR, row.question_id);
    const after = await readWireAnswer(WIRE_R7_DIR, row.question_id);
    if (before.sha256 !== row.pre_fix_observation.wire_sha256) throw new Error(`BLOCKER: ${row.question_id} before-wire sha256 mismatch`);
    if (after.sha256 !== row.post_fix_observation.wire_sha256) throw new Error(`BLOCKER: ${row.question_id} after-wire sha256 mismatch`);
    records.push({
      question_id: row.question_id,
      question: decision.review_tier === undefined ? null : null, // filled below from wire
      owner_note: row.owner_note,
      capability_ids: row.remediation_capability_ids,
      status: row.status,
      summary: row.post_fix_observation.summary,
      before_answer: before.answer,
      after_answer: after.answer,
      before_sha256: before.sha256,
      after_sha256: after.sha256,
    });
  }
  // Fill question text from the after-wire response (has `question` field).
  for (const record of records) {
    const wire = JSON.parse((await readFile(path.join(WIRE_R7_DIR, `${record.question_id}.response.json`))).toString("utf8"));
    record.question = wire.question;
  }

  const payload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_matrix_path: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl",
    source_matrix_sha256: sha256(beforeMatrixBytes),
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(decisionBytes),
    before_wire_revision: "r4",
    after_wire_revision: "r7",
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
    status_counts: records.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}),
    final_export_filename: "seed-response-remediation-owner-decision.v0.1.jsonl",
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output_html_sha256: report.output_html_sha256, record_count: records.length, status_counts: report.status_counts }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  const parts = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Seed FIX_REQUIRED Before/After 검수</title>",
    "<style>",
    CSS_TEXT,
    "</style>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    '<script type="application/json" id="review-data">' + dataJson + "</script>",
    "<script>",
    LOGIC_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
    "",
  ];
  return parts.join("\n");
}

const CSS_TEXT = [
  ":root { --border:#d0d0d0; --bg:#fafafa; --card-bg:#fff; --accent:#2b579a; --ok:#166534; --warn:#92400e; --danger:#991b1b; --muted:#666; }",
  "* { box-sizing: border-box; }",
  "body { margin:0; font-family:-apple-system,'Malgun Gothic','Apple SD Gothic Neo',sans-serif; background:var(--bg); color:#1a1a1a; }",
  "#app { max-width: 980px; margin: 0 auto; padding: 16px; padding-bottom: 120px; }",
  "header.topbar { position: sticky; top:0; background:var(--bg); padding: 10px 0; border-bottom: 1px solid var(--border); z-index: 10; }",
  "header.topbar h1 { font-size: 16px; margin: 0 0 6px; }",
  ".meta-line { font-size: 11px; color: var(--muted); margin-bottom: 6px; word-break: break-all; }",
  ".progress-wrap { background:#e5e5e5; border-radius: 6px; height: 10px; overflow:hidden; margin-bottom: 6px; }",
  ".progress-bar { background: var(--accent); height: 100%; }",
  ".progress-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }",
  ".toolbar { display:flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }",
  ".filter-btn { font-size: 12px; padding: 4px 10px; border: 1px solid var(--border); background:#fff; border-radius: 999px; cursor:pointer; }",
  ".filter-btn.active { background: var(--accent); color:#fff; border-color: var(--accent); }",
  ".nav-btn, .export-btn, .reset-btn { font-size: 13px; padding: 6px 12px; border: 1px solid var(--border); background:#fff; border-radius: 6px; cursor:pointer; }",
  ".export-btn.final { border-color: var(--ok); color: var(--ok); font-weight:600; }",
  ".export-btn:disabled { opacity:.4; cursor:default; border-color:var(--border); color:var(--muted); }",
  ".reset-btn { border-color: var(--danger); color: var(--danger); }",
  ".card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin: 14px 0; }",
  ".card-head { display:flex; justify-content: space-between; align-items:flex-start; gap: 8px; flex-wrap: wrap; }",
  ".qid { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }",
  ".status-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight:600; }",
  ".status-badge.RESOLVED { background:#dcfce7; color:var(--ok); }",
  ".status-badge.PARTIAL { background:#fef3c7; color:var(--warn); }",
  ".status-badge.BLOCKED { background:#fee2e2; color:var(--danger); }",
  ".disposition-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight:600; background:#f3f4f6; color:#4b5563; }",
  ".disposition-badge.APPROVE_FIX { background:#dcfce7; color:var(--ok); }",
  ".disposition-badge.FIX_REQUIRED { background:#fef3c7; color:var(--warn); }",
  ".disposition-badge.REJECT { background:#fee2e2; color:var(--danger); }",
  ".question-text { font-weight:600; margin: 8px 0; }",
  ".owner-note-box { white-space: pre-wrap; background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:10px; font-size: 12.5px; line-height:1.5; margin: 8px 0; }",
  ".summary-box { font-size: 12.5px; color:#333; margin: 8px 0; }",
  ".diff-columns { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0; }",
  "@media (max-width: 720px) { .diff-columns { grid-template-columns: 1fr; } }",
  ".diff-col h4 { font-size: 12px; margin: 0 0 4px; color: var(--muted); }",
  ".answer-box { white-space: pre-wrap; background:#f8fafc; border:1px solid var(--border); border-radius:6px; padding:10px; font-size: 12px; line-height:1.5; max-height: 420px; overflow:auto; }",
  ".chips { display:flex; flex-wrap:wrap; gap:4px; margin: 6px 0; }",
  ".chip { font-size: 10.5px; background:#eef2ff; color:#3730a3; padding: 1px 7px; border-radius: 999px; }",
  ".decision-row { display:flex; flex-wrap:wrap; gap: 6px; margin: 10px 0 6px; }",
  ".decision-btn { font-size: 13px; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background:#fff; cursor:pointer; }",
  ".decision-btn.APPROVE_FIX.selected { background: var(--ok); color:#fff; border-color: var(--ok); }",
  ".decision-btn.FIX_REQUIRED.selected { background: var(--warn); color:#fff; border-color: var(--warn); }",
  ".decision-btn.REJECT.selected { background: var(--danger); color:#fff; border-color: var(--danger); }",
  ".notes-box { width:100%; min-height: 50px; font-size: 13px; font-family: inherit; border:1px solid var(--border); border-radius:6px; padding: 6px; margin-top:4px; }",
  ".decision-meta { font-size: 11px; color: var(--muted); margin-top: 4px; }",
  ".footer-nav { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 10px 0; display:flex; justify-content: space-between; align-items:center; gap: 8px; }",
  ".empty-state { text-align:center; color: var(--muted); padding: 40px 0; }",
].join("\n");

const LOGIC_SCRIPT = [
"(function () {",
"  'use strict';",
"  var REVIEWER_NAME = '\\uCD5C\\uC7AC\\uC644';",
"  var FINAL_EXPORT_FILENAME = 'seed-response-remediation-owner-decision.v0.1.jsonl';",
"  var DATA = JSON.parse(document.getElementById('review-data').textContent);",
"  var RECORDS = DATA.records;",
"  var QIDS = RECORDS.map(function (r) { return r.question_id; });",
"  var BY_QID = {};",
"  RECORDS.forEach(function (r) { BY_QID[r.question_id] = r; });",
"  var STORAGE_KEY = 'seed-remediation-review-v0.2-state-' + DATA.source_matrix_sha256;",
"",
"  function buildInitialState() {",
"    var state = {};",
"    QIDS.forEach(function (qid) { state[qid] = { disposition: 'PENDING', reviewer: null, reviewed_at: null, notes: null }; });",
"    return state;",
"  }",
"  function loadState() {",
"    var fresh = buildInitialState();",
"    var raw;",
"    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }",
"    if (!raw) return fresh;",
"    var parsed;",
"    try { parsed = JSON.parse(raw); } catch (e) { return fresh; }",
"    QIDS.forEach(function (qid) { if (parsed[qid]) fresh[qid] = parsed[qid]; });",
"    return fresh;",
"  }",
"  var reviewState = loadState();",
"  var currentFilter = 'ALL';",
"  var currentIndex = 0;",
"  function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(reviewState)); } catch (e) {} }",
"",
"  function judgedCount() {",
"    var n = 0;",
"    QIDS.forEach(function (qid) { if (reviewState[qid].disposition !== 'PENDING') n++; });",
"    return n;",
"  }",
"  function allJudged() { return judgedCount() === QIDS.length; }",
"",
"  function matchesFilter(qid) {",
"    var record = BY_QID[qid]; var entry = reviewState[qid];",
"    if (currentFilter === 'ALL') return true;",
"    if (currentFilter === 'RESOLVED') return record.status === 'RESOLVED';",
"    if (currentFilter === 'PARTIAL') return record.status === 'PARTIAL';",
"    if (currentFilter === 'BLOCKED') return record.status === 'BLOCKED';",
"    if (currentFilter === 'PENDING') return entry.disposition === 'PENDING';",
"    return true;",
"  }",
"  function filteredIds() { return QIDS.filter(matchesFilter); }",
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
"  function buildRecord(qid) {",
"    var record = BY_QID[qid]; var entry = reviewState[qid];",
"    return {",
"      question_id: qid,",
"      status: record.status,",
"      capability_ids: record.capability_ids,",
"      before_sha256: record.before_sha256,",
"      after_sha256: record.after_sha256,",
"      owner_disposition: entry.disposition,",
"      reviewer: entry.reviewer,",
"      reviewed_at: entry.reviewed_at,",
"      notes: entry.notes,",
"    };",
"  }",
"  function buildExportLines() {",
"    return QIDS.map(function (qid) { return JSON.stringify(buildRecord(qid)); }).join('\\n') + '\\n';",
"  }",
"",
"  function applyDecision(qid, disposition) {",
"    var now = new Date().toISOString();",
"    reviewState[qid] = { disposition: disposition, reviewer: REVIEWER_NAME, reviewed_at: now, notes: reviewState[qid].notes };",
"    saveState(); render();",
"  }",
"",
"  function renderHeader() {",
"    var judged = judgedCount();",
"    var pct = Math.round((judged / QIDS.length) * 100);",
"    var header = el('header', { className: 'topbar' }, [",
"      text('h1', null, 'Seed FIX_REQUIRED Before/After \\uAC80\\uC218 (24\\uAC74)'),",
"      text('div', 'meta-line', 'matrix: ' + DATA.source_matrix_path + ' (' + DATA.source_matrix_sha256.slice(0,16) + '\\u2026)'),",
"      text('div', 'meta-line', 'before: r' + '4' + ' \\u2192 after: r' + '7' + ' | generated_at: ' + DATA.generated_at),",
"      el('div', { className: 'progress-wrap' }, [el('div', { className: 'progress-bar', style: 'width:' + pct + '%' })]),",
"      text('div', 'progress-label', '\\uC9C4\\uD589\\uB960: ' + judged + ' / ' + QIDS.length + ' (' + pct + '%)'),",
"    ]);",
"    var toolbar = el('div', { className: 'toolbar' });",
"    [['ALL','\\uC804\\uCCB4'],['RESOLVED','RESOLVED'],['PARTIAL','PARTIAL'],['BLOCKED','BLOCKED'],['PENDING','\\uBBF8\\uAC80\\uC218']].forEach(function (pair) {",
"      var btn = text('button', 'filter-btn' + (currentFilter === pair[0] ? ' active' : ''), pair[1]);",
"      btn.addEventListener('click', function () { currentFilter = pair[0]; currentIndex = 0; render(); });",
"      toolbar.appendChild(btn);",
"    });",
"    header.appendChild(toolbar);",
"    var exportRow = el('div', { className: 'toolbar' });",
"    var draftBtn = text('button', 'export-btn', 'Draft JSONL \\uB2E4\\uC6B4\\uB85C\\uB4DC');",
"    draftBtn.addEventListener('click', function () { downloadText('seed-response-remediation-review-draft.jsonl', buildExportLines()); });",
"    var judged2 = allJudged();",
"    var finalBtn = text('button', 'export-btn final', 'FINAL \\uB0B4\\uBCF4\\uB0B4\\uAE30 (' + FINAL_EXPORT_FILENAME + ')');",
"    finalBtn.disabled = !judged2;",
"    finalBtn.addEventListener('click', function () {",
"      if (!allJudged()) { alert('24\\uAC74 \\uC804\\uBD80 \\uD310\\uC815\\uD574\\uC57C FINAL \\uB0B4\\uBCF4\\uB0B4\\uAE30\\uAC00 \\uAC00\\uB2A5\\uD569\\uB2C8\\uB2E4.'); return; }",
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
"  function renderCard(qid) {",
"    var record = BY_QID[qid]; var entry = reviewState[qid];",
"    var card = el('div', { className: 'card' });",
"    card.appendChild(el('div', { className: 'card-head' }, [",
"      el('div', {}, [text('div', 'qid', qid), text('span', 'status-badge ' + record.status, record.status)]),",
"      text('span', 'disposition-badge ' + entry.disposition, entry.disposition),",
"    ]));",
"    card.appendChild(text('div', 'question-text', record.question));",
"    var chips = el('div', { className: 'chips' });",
"    record.capability_ids.forEach(function (c) { chips.appendChild(text('span', 'chip', 'capability ' + c)); });",
"    card.appendChild(chips);",
"    card.appendChild(text('div', 'owner-note-box', record.owner_note));",
"    var summary = el('div', { className: 'summary-box' }, [text('b', null, '\\uCF54\\uB4DC\\uAC00 \\uC8FC\\uC7A5\\uD558\\uB294 remediation: '), text('span', null, record.summary)]);",
"    card.appendChild(summary);",
"    var diffCols = el('div', { className: 'diff-columns' });",
"    var beforeCol = el('div', { className: 'diff-col' }, [text('h4', null, 'Before (r4)')]);",
"    var beforeBox = el('div', { className: 'answer-box' }); beforeBox.textContent = record.before_answer; beforeCol.appendChild(beforeBox);",
"    var afterCol = el('div', { className: 'diff-col' }, [text('h4', null, 'After (r7)')]);",
"    var afterBox = el('div', { className: 'answer-box' }); afterBox.textContent = record.after_answer; afterCol.appendChild(afterBox);",
"    diffCols.appendChild(beforeCol); diffCols.appendChild(afterCol);",
"    card.appendChild(diffCols);",
"",
"    var decisionRow = el('div', { className: 'decision-row' });",
"    [['APPROVE_FIX','APPROVE_FIX'],['FIX_REQUIRED','FIX_REQUIRED'],['REJECT','REJECT']].forEach(function (pair) {",
"      var btn = text('button', 'decision-btn ' + pair[0] + (entry.disposition === pair[0] ? ' selected' : ''), pair[1]);",
"      btn.addEventListener('click', function () { applyDecision(qid, pair[0]); });",
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
"  function renderNav(ids) {",
"    var nav = el('div', { className: 'footer-nav' });",
"    var prevBtn = text('button', 'nav-btn', '\\u2190 \\uC774\\uC804');",
"    prevBtn.disabled = currentIndex <= 0;",
"    prevBtn.addEventListener('click', function () { if (currentIndex > 0) { currentIndex--; render(); } });",
"    var posLabel = text('span', null, ids.length ? (currentIndex + 1) + ' / ' + ids.length : '0 / 0');",
"    var nextBtn = text('button', 'nav-btn', '\\uB2E4\\uC74C \\u2192');",
"    nextBtn.disabled = currentIndex >= ids.length - 1;",
"    nextBtn.addEventListener('click', function () { if (currentIndex < ids.length - 1) { currentIndex++; render(); } });",
"    nav.appendChild(prevBtn); nav.appendChild(posLabel); nav.appendChild(nextBtn);",
"    return nav;",
"  }",
"",
"  function render() {",
"    var app = document.getElementById('app');",
"    while (app.firstChild) app.removeChild(app.firstChild);",
"    app.appendChild(renderHeader());",
"    var ids = filteredIds();",
"    if (currentIndex >= ids.length) currentIndex = Math.max(0, ids.length - 1);",
"    if (ids.length === 0) app.appendChild(text('div', 'empty-state', '\\uD574\\uB2F9 \\uD544\\uD130\\uC5D0 \\uD574\\uB2F9\\uD558\\uB294 \\uBB38\\uD56D\\uC774 \\uC5C6\\uC2B5\\uB2C8\\uB2E4.'));",
"    else app.appendChild(renderCard(ids[currentIndex]));",
"    app.appendChild(renderNav(ids));",
"  }",
"",
"  document.addEventListener('keydown', function (ev) {",
"    var tag = document.activeElement && document.activeElement.tagName;",
"    if (tag === 'TEXTAREA' || tag === 'INPUT') return;",
"    var ids = filteredIds();",
"    if (ev.key === 'ArrowLeft') { if (currentIndex > 0) { currentIndex--; render(); } }",
"    else if (ev.key === 'ArrowRight') { if (currentIndex < ids.length - 1) { currentIndex++; render(); } }",
"    else if ((ev.key === 'a' || ev.key === 'A') && ids[currentIndex]) applyDecision(ids[currentIndex], 'APPROVE_FIX');",
"    else if ((ev.key === 'f' || ev.key === 'F') && ids[currentIndex]) applyDecision(ids[currentIndex], 'FIX_REQUIRED');",
"    else if ((ev.key === 'r' || ev.key === 'R') && ids[currentIndex]) applyDecision(ids[currentIndex], 'REJECT');",
"  });",
"",
"  render();",
"})();",
].join("\n");

main().catch((error) => { console.error(error.message); process.exit(1); });
