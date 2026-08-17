// Turn M5 Section 7B: the FINAL Candidate review UI -- shows ONLY the 9
// new/corrected records that still need a judgment (8 ontology-dependent
// previews + 1 Q25 corrected revision), each with its real quoted_text
// and Candidate fields side by side. The 6 Owner-APPROVED carried-
// forward Candidates are shown as a read-only "승계됨" summary list --
// no decision controls, no re-judgment possible. All 9 judgable records
// start PENDING, no AI auto-approval.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTION_PIN_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");
const PREVIEW_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");
const CANDIDATES_V10_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
const CANDIDATES_V08_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const OWNER_DECISION_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/ui/final-candidates-v0.1");
const OUT_HTML_PATH = path.join(OUT_DIR, "seed-structured-gap-final-candidate-review.html");
const OUT_REPORT_PATH = path.join(OUT_DIR, "review-ui-build-report.json");
const FINAL_EXPORT_FILENAME = "seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`FINAL_CANDIDATE_UI_BLOCKED: ${msg}`); }
function escapeForScriptEmbed(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function main() {
  const promotionPinBytes = await readFile(PROMOTION_PIN_PATH);
  const promotionPinRows = jsonl(promotionPinBytes.toString("utf8"));
  const previewBytes = await readFile(PREVIEW_PATH);
  const previewRows = jsonl(previewBytes.toString("utf8"));
  const v10Bytes = await readFile(CANDIDATES_V10_PATH);
  const v10Rows = jsonl(v10Bytes.toString("utf8"));
  const v08Bytes = await readFile(CANDIDATES_V08_PATH);
  const v08Rows = jsonl(v08Bytes.toString("utf8"));
  const v08ByFactId = new Map(v08Rows.map((r) => [r.fact_id, r]));
  const ownerDecisionV02Bytes = await readFile(OWNER_DECISION_V02_PATH);

  if (promotionPinRows.length !== 6) fail(`expected 6 carried-forward records, found ${promotionPinRows.length}`);
  if (previewRows.length !== 8) fail(`expected 8 ontology-dependent previews, found ${previewRows.length}`);
  if (v10Rows.length !== 1) fail(`expected 1 Q25 corrected record, found ${v10Rows.length}`);

  const carriedForward = promotionPinRows.map((r) => ({
    fact_id: r.fact_id, question_id: r.question_id, metric_code: r.metric_code,
    status: r.status, owner_reviewer: r.owner_reviewer, owner_reviewed_at: r.owner_reviewed_at, owner_notes: r.owner_notes,
  }));

  const judgable = [];
  for (const p of previewRows) {
    judgable.push({
      kind: "ONTOLOGY_DEPENDENT_PREVIEW",
      fact_id: p.fact.fact_id,
      question_id: p.fact.metric_code === "TRUST_CONTRACT_INSTITUTION" || p.fact.metric_code === "ACQUISITION_PLANNED_SHARES" ? "question_seed_v07_09"
        : p.fact.metric_code.startsWith("INVESTMENT") ? "question_seed_v07_06"
        : p.fact.metric_code === "CORRECTION_REASON" ? "question_seed_v07_20"
        : p.fact.metric_code === "ISSUANCE_AMOUNT" ? "question_seed_v07_18" : null,
      metric_code: p.fact.metric_code,
      raw_label: p.fact.raw_label,
      value_type: p.fact.value_type,
      value_certainty: p.fact.value_certainty,
      normalized_value: p.fact.normalized_value,
      unit: p.fact.unit,
      scope: p.fact.scope,
      period_type: p.fact.period_type,
      as_of_date: p.fact.as_of_date,
      known_at: p.fact.known_at,
      valid_from: p.fact.valid_from,
      source_document_id: p.fact.source_document_id,
      evidence_id: p.evidence_id,
      source_locator: p.source_locator,
      quoted_text: p.quoted_text,
      quote_sha256: p.quote_sha256,
      linked_existing_fact_id: p.linked_existing_fact_id,
      ontology_proposal_card_id: p.ontology_proposal_card_id,
      previous_decision_note: p.previous_decision_note,
      preview_status: p.preview_status,
    });
  }
  const q25Corrected = v10Rows[0];
  const q25Original = v08ByFactId.get(q25Corrected.fact_id);
  if (!q25Original) fail(`Q25 original v0.8 record not found for ${q25Corrected.fact_id}`);
  judgable.push({
    kind: "CORRECTED_CANDIDATE_REVISION",
    fact_id: q25Corrected.fact_id,
    question_id: "question_seed_v07_25",
    metric_code: q25Corrected.metric_code,
    raw_label: q25Corrected.raw_label,
    raw_label_before: q25Original.raw_label,
    value_type: q25Corrected.value_type,
    value_certainty: q25Corrected.value_certainty,
    value_certainty_before: q25Original.value_certainty,
    normalized_value: q25Corrected.normalized_value,
    unit: q25Corrected.unit,
    scope: q25Corrected.scope,
    period_type: q25Corrected.period_type,
    as_of_date: q25Corrected.as_of_date,
    known_at: q25Corrected.known_at,
    valid_from: q25Corrected.valid_from,
    source_document_id: q25Corrected.source_document_id,
    evidence_id: q25Corrected.evidence_ids[0],
    source_locator: null,
    quoted_text: q25Corrected.raw_value_text,
    quote_sha256: null,
    linked_existing_fact_id: null,
    ontology_proposal_card_id: null,
    previous_decision_note: q25Corrected.attributes.review_provenance.turn_m5_correction.note,
    preview_status: "CORRECTED_CANDIDATE_PENDING_REVIEW",
  });

  if (judgable.length !== 9) fail(`expected 9 judgable records, built ${judgable.length}`);

  const payload = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_promotion_pin_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl",
    source_promotion_pin_sha256: sha256(promotionPinBytes),
    source_preview_path: "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl",
    source_preview_sha256: sha256(previewBytes),
    source_candidates_v10_path: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl",
    source_candidates_v10_sha256: sha256(v10Bytes),
    owner_decision_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
    owner_decision_v02_sha256: sha256(ownerDecisionV02Bytes),
    final_export_filename: FINAL_EXPORT_FILENAME,
    carried_forward: carriedForward,
    judgable,
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
    carried_forward_count: carriedForward.length,
    judgable_count: judgable.length,
    final_export_filename: FINAL_EXPORT_FILENAME,
  };
  await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output_html_sha256: report.output_html_sha256, carried_forward_count: carriedForward.length, judgable_count: judgable.length }, null, 2));
}

function buildHtml(payload) {
  const dataJson = escapeForScriptEmbed(JSON.stringify(payload));
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Turn M5 최종 Candidate 검수</title>",
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
  "#app { max-width: 960px; margin: 0 auto; padding: 16px; padding-bottom: 120px; }",
  "header.topbar { position: sticky; top:0; background:var(--bg); padding: 10px 0; border-bottom: 1px solid var(--border); z-index: 10; }",
  "header.topbar h1 { font-size: 16px; margin: 0 0 6px; }",
  ".meta-line { font-size: 11px; color: var(--muted); margin-bottom: 6px; word-break: break-all; }",
  ".progress-wrap { background:#e5e5e5; border-radius: 6px; height: 10px; overflow:hidden; margin-bottom: 6px; }",
  ".progress-bar { background: var(--accent); height: 100%; }",
  ".progress-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }",
  ".toolbar { display:flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }",
  ".nav-btn, .export-btn, .reset-btn, .tab-btn { font-size: 13px; padding: 6px 12px; border: 1px solid var(--border); background:#fff; border-radius: 6px; cursor:pointer; }",
  ".tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }",
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
  ".kind-badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background:#ede9fe; color:#5b21b6; font-weight:600; }",
  ".quote-box { white-space: pre-wrap; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px; padding:10px; font-size: 13px; line-height:1.5; margin: 8px 0; }",
  ".diff-box { background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:10px; font-size: 12.5px; line-height:1.6; margin: 8px 0; }",
  ".diff-box .before { color: var(--danger); text-decoration: line-through; }",
  ".diff-box .after { color: var(--ok); font-weight:600; }",
  ".fact-table { width:100%; border-collapse: collapse; margin: 8px 0; font-size: 12.5px; }",
  ".fact-table td { padding: 4px 8px; border-bottom: 1px solid #eee; vertical-align: top; }",
  ".fact-table td.k { color: var(--muted); white-space: nowrap; width: 180px; }",
  ".basis-box { font-size: 11.5px; color:#4b5563; margin: 6px 0; }",
  ".decision-row { display:flex; flex-wrap:wrap; gap: 6px; margin: 10px 0 6px; }",
  ".decision-btn { font-size: 13px; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background:#fff; cursor:pointer; }",
  ".decision-btn.APPROVE.selected { background: var(--ok); color:#fff; border-color: var(--ok); }",
  ".decision-btn.FIX_REQUIRED.selected { background: var(--warn); color:#fff; border-color: var(--warn); }",
  ".decision-btn.REJECT.selected { background: var(--danger); color:#fff; border-color: var(--danger); }",
  ".notes-box { width:100%; min-height: 50px; font-size: 13px; font-family: inherit; border:1px solid var(--border); border-radius:6px; padding: 6px; margin-top:4px; }",
  ".decision-meta { font-size: 11px; color: var(--muted); margin-top: 4px; }",
  ".footer-nav { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 10px 0; display:flex; justify-content: space-between; align-items:center; gap: 8px; }",
  ".summary-row { display:flex; justify-content: space-between; align-items:center; padding: 8px 10px; border-bottom: 1px solid #eee; font-size: 12.5px; }",
  ".summary-row:last-child { border-bottom: none; }",
  ".carried-badge { font-size: 10px; padding: 1px 8px; border-radius: 999px; background:#dcfce7; color:var(--ok); font-weight:600; }",
].join("\n");

const LOGIC_SCRIPT = [
"(function () {",
"  'use strict';",
"  var REVIEWER_NAME = '\\uCD5C\\uC7AC\\uC644';",
"  var DATA = JSON.parse(document.getElementById('review-data').textContent);",
"  var FINAL_EXPORT_FILENAME = DATA.final_export_filename;",
"  var RECORDS = DATA.judgable;",
"  var IDS = RECORDS.map(function (r) { return r.fact_id; });",
"  var BY_ID = {};",
"  RECORDS.forEach(function (r) { BY_ID[r.fact_id] = r; });",
"  var STORAGE_KEY = 'seed-structured-gap-final-candidate-review-v0.1-state-' + DATA.source_preview_sha256;",
"  var activeTab = 'judgable';",
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
"      fact_id: id, question_id: record.question_id, metric_code: record.metric_code, kind: record.kind,",
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
"      text('h1', null, 'Turn M5 \\uCD5C\\uC885 Candidate \\uAC80\\uC218 (\\uC2E0\\uADDC/\\uC218\\uC815 ' + IDS.length + '\\uAC74 + \\uC2B9\\uACC4 ' + DATA.carried_forward.length + '\\uAC74)'),",
"      text('div', 'meta-line', 'preview: ' + DATA.source_preview_path + ' | promotion-pin: ' + DATA.source_promotion_pin_path),",
"      el('div', { className: 'progress-wrap' }, [el('div', { className: 'progress-bar', style: 'width:' + pct + '%' })]),",
"      text('div', 'progress-label', '\\uD310\\uC815 \\uB300\\uC0C1 \\uC9C4\\uD589\\uB960: ' + judged + ' / ' + IDS.length + ' (' + pct + '%)'),",
"    ]);",
"    var tabRow = el('div', { className: 'toolbar' });",
"    var judgeTab = text('button', 'tab-btn' + (activeTab === 'judgable' ? ' active' : ''), '\\uD310\\uC815 \\uB300\\uC0C1 (' + IDS.length + ')');",
"    judgeTab.addEventListener('click', function () { activeTab = 'judgable'; currentIndex = 0; render(); });",
"    var carriedTab = text('button', 'tab-btn' + (activeTab === 'carried' ? ' active' : ''), '\\uC2B9\\uACC4\\uB428 \\uC694\\uC57D (' + DATA.carried_forward.length + ')');",
"    carriedTab.addEventListener('click', function () { activeTab = 'carried'; render(); });",
"    tabRow.appendChild(judgeTab); tabRow.appendChild(carriedTab);",
"    header.appendChild(tabRow);",
"    var exportRow = el('div', { className: 'toolbar' });",
"    var draftBtn = text('button', 'export-btn', 'Draft JSONL \\uB2E4\\uC6B4\\uB85C\\uB4DC');",
"    draftBtn.addEventListener('click', function () { downloadText('seed-structured-gap-final-candidate-review-draft.jsonl', buildExportLines()); });",
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
"  function renderCarriedSummary() {",
"    var wrap = el('div', { className: 'card' });",
"    wrap.appendChild(text('h4', null, '\\uC774\\uBBF8 Owner APPROVE\\uB41C \\uC2B9\\uACC4 Candidate -- \\uC7AC\\uD310\\uC815 \\uBD88\\uD544\\uC694'));",
"    DATA.carried_forward.forEach(function (r) {",
"      var row = el('div', { className: 'summary-row' }, [",
"        el('div', {}, [text('div', 'qid', r.fact_id), text('div', 'qid', r.question_id + ' \\u2192 ' + r.metric_code)]),",
"        text('span', 'carried-badge', r.status),",
"      ]);",
"      wrap.appendChild(row);",
"    });",
"    return wrap;",
"  }",
"",
"  function renderCard(id) {",
"    var record = BY_ID[id]; var entry = reviewState[id];",
"    var card = el('div', { className: 'card' });",
"    card.appendChild(el('div', { className: 'card-head' }, [",
"      el('div', {}, [",
"        el('div', {}, [text('span', 'kind-badge', record.kind), text('span', 'qid', ' ' + record.fact_id)]),",
"        text('div', 'qid', record.question_id + ' \\u2192 ' + record.metric_code),",
"      ]),",
"      text('span', 'disposition-badge ' + entry.disposition, entry.disposition),",
"    ]));",
"    if (record.kind === 'CORRECTED_CANDIDATE_REVISION') {",
"      var diffBox = el('div', { className: 'diff-box' });",
"      diffBox.appendChild(el('div', {}, [text('b', null, 'raw_label: '), el('span', { className: 'before', text: record.raw_label_before }), document.createTextNode(' \\u2192 '), el('span', { className: 'after', text: record.raw_label })]));",
"      diffBox.appendChild(el('div', {}, [text('b', null, 'value_certainty: '), el('span', { className: 'before', text: record.value_certainty_before }), document.createTextNode(' \\u2192 '), el('span', { className: 'after', text: record.value_certainty })]));",
"      card.appendChild(diffBox);",
"    }",
"    card.appendChild(text('h4', null, '\\uC6D0\\uBB38 (VERIFIED Evidence)'));",
"    var quoteBox = el('div', { className: 'quote-box' }); quoteBox.textContent = record.quoted_text; card.appendChild(quoteBox);",
"    card.appendChild(text('h4', null, 'Candidate (' + record.preview_status + ')'));",
"    var table = el('table', { className: 'fact-table' });",
"    table.appendChild(factRow('raw_label', record.raw_label));",
"    table.appendChild(factRow('value_type / certainty', record.value_type + ' / ' + record.value_certainty));",
"    table.appendChild(factRow('normalized_value', record.normalized_value));",
"    table.appendChild(factRow('unit / scope / period_type', (record.unit || '-') + ' / ' + record.scope + ' / ' + record.period_type));",
"    table.appendChild(factRow('as_of_date', record.as_of_date));",
"    table.appendChild(factRow('known_at', record.known_at));",
"    table.appendChild(factRow('valid_from', record.valid_from));",
"    table.appendChild(factRow('source_document_id', record.source_document_id));",
"    table.appendChild(factRow('evidence_id', record.evidence_id));",
"    table.appendChild(factRow('source_locator', record.source_locator));",
"    table.appendChild(factRow('quote_sha256', record.quote_sha256));",
"    table.appendChild(factRow('linked existing fact_id/event_id', record.linked_existing_fact_id));",
"    table.appendChild(factRow('ontology_proposal_card_id', record.ontology_proposal_card_id));",
"    card.appendChild(table);",
"    if (record.previous_decision_note) card.appendChild(el('div', { className: 'basis-box' }, [text('b', null, '\\uC774\\uC804 \\uD310\\uC815 \\uC5F0\\uACB0: '), document.createTextNode(record.previous_decision_note)]));",
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
"    if (activeTab === 'carried') {",
"      app.appendChild(renderCarriedSummary());",
"    } else {",
"      app.appendChild(renderCard(IDS[currentIndex]));",
"      app.appendChild(renderNav());",
"    }",
"  }",
"",
"  document.addEventListener('keydown', function (ev) {",
"    if (activeTab !== 'judgable') return;",
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
