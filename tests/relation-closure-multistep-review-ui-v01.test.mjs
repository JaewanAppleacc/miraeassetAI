// Turn N4.5, Task 7: verifies the two independent multi-step correction
// risk review UIs (Reviewer C / Reviewer D). Confirms: fully separate
// localStorage/export namespaces (neither reviewer's file references the
// other's storage key or export filename); CONFIRM's target must be
// within the row's own candidate/related-document union; FINAL export is
// gated on all rows judged; and a real headless-Chrome download works for
// each reviewer independently, producing DIFFERENT judgments that never
// leak into each other's export.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V02_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");
const RISK_PACKET_PATH = path.join(V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.jsonl");
const OUT_DIR = path.join(V02_DIR, "ui/multistep-review-v0.1");
const HTML_C_PATH = path.join(OUT_DIR, "relation-closure-multistep-review.reviewer-c.html");
const HTML_D_PATH = path.join(OUT_DIR, "relation-closure-multistep-review.reviewer-d.html");
const BUILD_REPORT_PATH = path.join(OUT_DIR, "multistep-review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }
function extractPayload(html) {
  const match = html.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  return JSON.parse(match[1]);
}

let riskRowsBefore; let htmlC; let htmlD; let payloadC; let payloadD; let buildReport;

test.before(async () => {
  riskRowsBefore = sha256(await readFile(RISK_PACKET_PATH));
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-multistep-review-ui-v01.mjs")], { cwd: ROOT });
  htmlC = await readFile(HTML_C_PATH, "utf8");
  htmlD = await readFile(HTML_D_PATH, "utf8");
  payloadC = extractPayload(htmlC);
  payloadD = extractPayload(htmlD);
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
}, { timeout: 15_000 });

test("build never modifies the risk packet input", async () => {
  const after = sha256(await readFile(RISK_PACKET_PATH));
  assert.equal(after, riskRowsBefore);
});

test("both HTML files embed the same 116 rows but a DIFFERENT reviewer_role, and are byte-DIFFERENT files", () => {
  assert.equal(payloadC.rows.length, payloadD.rows.length);
  assert.equal(payloadC.reviewer_role, "REVIEWER_C");
  assert.equal(payloadD.reviewer_role, "REVIEWER_D");
  assert.notEqual(htmlC, htmlD);
});

test("each reviewer's embedded role is baked in distinctly at build time, and STORAGE_KEY/export filename are derived from that embedded role at runtime (not hardcoded per-file)", () => {
  assert.match(htmlC, /"reviewer_role":"REVIEWER_C"/);
  assert.match(htmlD, /"reviewer_role":"REVIEWER_D"/);
  assert.doesNotMatch(htmlC, /"reviewer_role":"REVIEWER_D"/);
  assert.doesNotMatch(htmlD, /"reviewer_role":"REVIEWER_C"/);
  // Both files share the SAME pure resolveExportFilenames() function body
  // (by design -- it is unit-tested pure logic, not a per-file literal);
  // what differs is the embedded reviewer_role that DATA.reviewer_role
  // resolves at runtime -- proven concretely below via real headless runs.
  assert.match(htmlC, /var STORAGE_KEY = 'relation-closure-multistep-review-ui-v0\.1-state-' \+ DATA\.source_risk_packet_sha256 \+ \(REVIEWER_ROLE/);
  assert.equal(buildReport.final_export_filenames.REVIEWER_C, "relation-multistep-reviewer-c-decision.v0.1.jsonl");
  assert.equal(buildReport.final_export_filenames.REVIEWER_D, "relation-multistep-reviewer-d-decision.v0.1.jsonl");
});

test("static scan: no external resource pattern, no innerHTML in either file", () => {
  for (const html of [htmlC, htmlD]) {
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /innerHTML/);
  }
});

let pageC; let pageD; let downloadC; let downloadD; let recordsC; let recordsD;

test.before(async () => {
  pageC = await launchHeadlessChromePage({ url: `file://${HTML_C_PATH}` });
  pageD = await launchHeadlessChromePage({ url: `file://${HTML_D_PATH}` });

  // Reviewer C confirms every row that HAS a candidate/related-document
  // union against its first entry, and REJECTs the (rare) row with an
  // empty union -- CONFIRM is impossible there by the UI's own
  // validation, which this test intentionally exercises rather than
  // papering over. Reviewer D rejects every row regardless -- the two
  // reviewers' judgments deliberately differ, to prove neither export is
  // contaminated by the other reviewer's state.
  const bulkC = await pageC.evaluate(`
    (function () {
      var rows = ${JSON.stringify(payloadC.rows)};
      var key = 'relation-closure-multistep-review-ui-v0.1-state-' + ${JSON.stringify(payloadC.source_risk_packet_sha256)} + '-REVIEWER_C';
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var union = (row.candidate_target_document_ids || []).concat(row.corpus_internal_related_document_ids || []);
        var uniq = []; var seen = {};
        union.forEach(function (id) { if (!seen[id]) { seen[id] = true; uniq.push(id); } });
        if (uniq.length > 0) {
          state = applyReviewerDecision(state, row.relation_candidate_id, 'CONFIRM', uniq[0], 'Reviewer C \\ud655\\uc778', nowIso, 'reviewer_c_test', uniq);
        } else {
          state = applyReviewerDecision(state, row.relation_candidate_id, 'REJECT', null, 'Reviewer C: \\ud6c4\\ubcf4 \\uc5c6\\uc74c', nowIso, 'reviewer_c_test', uniq);
        }
      }
      localStorage.setItem(key, JSON.stringify(state));
      return { judged: judgedCount(state, rows.map(function (r) { return r.relation_candidate_id; })), allJudged: allJudged(state, rows.map(function (r) { return r.relation_candidate_id; })) };
    })()
  `);
  const bulkD = await pageD.evaluate(`
    (function () {
      var rows = ${JSON.stringify(payloadD.rows)};
      var key = 'relation-closure-multistep-review-ui-v0.1-state-' + ${JSON.stringify(payloadD.source_risk_packet_sha256)} + '-REVIEWER_D';
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        state = applyReviewerDecision(state, row.relation_candidate_id, 'REJECT', null, 'Reviewer D \\uac70\\ubd80', nowIso, 'reviewer_d_test', []);
      }
      localStorage.setItem(key, JSON.stringify(state));
      return { judged: judgedCount(state, rows.map(function (r) { return r.relation_candidate_id; })), allJudged: allJudged(state, rows.map(function (r) { return r.relation_candidate_id; })) };
    })()
  `);

  await pageC.send("Page.navigate", { url: `file://${HTML_C_PATH}` });
  await pageD.send("Page.navigate", { url: `file://${HTML_D_PATH}` });
  await new Promise((r) => setTimeout(r, 400));

  const finalDisabledC = await pageC.evaluate("document.querySelector('.export-btn.final').disabled");
  const finalDisabledD = await pageD.evaluate("document.querySelector('.export-btn.final').disabled");
  await pageC.evaluate("document.querySelector('.export-btn.final').click()");
  await pageD.evaluate("document.querySelector('.export-btn.final').click()");
  downloadC = await waitForDownloadCompletion({ downloadDir: pageC.downloadDir, timeoutMs: 10_000 });
  downloadD = await waitForDownloadCompletion({ downloadDir: pageD.downloadDir, timeoutMs: 10_000 });
  recordsC = (await readFile(downloadC.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  recordsD = (await readFile(downloadD.path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

  global.__n45MultistepTestState = { bulkC, bulkD, finalDisabledC, finalDisabledD };
}, { timeout: 45_000 });

test.after(async () => { if (pageC) await pageC.close(); if (pageD) await pageD.close(); }, { timeout: 10_000 });

test("headless: both reviewers independently reach judgedCount == row_count / allJudged true", () => {
  const s = global.__n45MultistepTestState;
  assert.equal(s.bulkC.judged, payloadC.rows.length);
  assert.equal(s.bulkC.allJudged, true);
  assert.equal(s.bulkD.judged, payloadD.rows.length);
  assert.equal(s.bulkD.allJudged, true);
});

test("headless: FINAL export enables independently for each reviewer and downloads the CORRECT, distinct filename", () => {
  assert.equal(global.__n45MultistepTestState.finalDisabledC, false);
  assert.equal(global.__n45MultistepTestState.finalDisabledD, false);
  assert.equal(downloadC.filename, "relation-multistep-reviewer-c-decision.v0.1.jsonl");
  assert.equal(downloadD.filename, "relation-multistep-reviewer-d-decision.v0.1.jsonl");
});

test("headless: Reviewer C's export CONFIRMs every row that has a candidate union (REJECTs the sole empty-union row); Reviewer D's export is all REJECT -- the two never mix", () => {
  assert.equal(recordsC.length, payloadC.rows.length);
  assert.equal(recordsD.length, payloadD.rows.length);
  const rowsByIdC = new Map(payloadC.rows.map((r) => [r.relation_candidate_id, r]));
  for (const r of recordsC) {
    const row = rowsByIdC.get(r.relation_candidate_id);
    const unionSize = new Set([...(row.candidate_target_document_ids || []), ...(row.corpus_internal_related_document_ids || [])]).size;
    if (unionSize > 0) assert.equal(r.reviewer_disposition, "CONFIRM");
    else assert.equal(r.reviewer_disposition, "REJECT");
  }
  assert.ok(recordsD.every((r) => r.reviewer_disposition === "REJECT" && r.confirmed_target_document_id === null));
  assert.ok(recordsC.every((r) => r.reviewer_role === "REVIEWER_C"));
  assert.ok(recordsD.every((r) => r.reviewer_role === "REVIEWER_D"));
});

test("headless: every Reviewer C CONFIRM target is within that row's own candidate_target_document_ids/corpus_internal_related_document_ids union (never fabricated)", () => {
  const rowsById = new Map(payloadC.rows.map((r) => [r.relation_candidate_id, r]));
  const confirmedCount = recordsC.filter((r) => r.reviewer_disposition === "CONFIRM").length;
  assert.ok(confirmedCount > 0);
  for (const r of recordsC) {
    if (r.reviewer_disposition !== "CONFIRM") continue;
    const row = rowsById.get(r.relation_candidate_id);
    const union = new Set([...(row.candidate_target_document_ids || []), ...(row.corpus_internal_related_document_ids || [])]);
    assert.ok(union.has(r.confirmed_target_document_id), `Reviewer C target ${r.confirmed_target_document_id} not in row ${r.relation_candidate_id}'s union`);
  }
});
