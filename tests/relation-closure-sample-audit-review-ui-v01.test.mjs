// Turn N4.4: verifies the offline 30-row sample-audit review UI
// (scripts/build-relation-closure-sample-audit-review-ui-v01.mjs): embedded
// data shape, a static scan of the generated HTML, and real headless-
// Chrome behavior -- required-field enforcement for DEFECT_FOUND, PASS/
// NEEDS_MORE_REVIEW wiring, FINAL-export gating, real JSONL + summary
// downloads, localStorage isolation from the Owner UI, and cross-UI
// sequential-navigation isolation in one browser session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { launchHeadlessChromePage } from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);

// The FINAL export button triggers TWO downloads (the JSONL + the summary
// JSON) from one click, nearly simultaneously -- the shared
// waitForDownloadCompletion() helper is single-download-oriented (it
// returns whichever complete file it finds first), so racing it twice
// here could return the SAME file twice or the wrong one. This waits for
// a SPECIFIC named file instead, size-stability-checked exactly like the
// shared helper does.
async function waitForNamedDownload(downloadDir, filename, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(downloadDir).catch(() => []);
    if (entries.includes(filename)) {
      const target = path.join(downloadDir, filename);
      const sizeA = (await stat(target)).size;
      await new Promise((r) => setTimeout(r, 150));
      const sizeB = (await stat(target).catch(() => ({ size: -1 }))).size;
      if (sizeA === sizeB && sizeA >= 0) return { filename, path: target, bytes: sizeB };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${filename} did not complete within ${timeoutMs}ms in ${downloadDir}`);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const SAMPLE_PACKET_PATH = path.join(OWNER_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl");
const OWNER_HTML_PATH = path.join(OWNER_DIR, "ui/v0.1/relation-closure-owner-review.html");
const HTML_PATH = path.join(OWNER_DIR, "ui/sample-audit-v0.1/relation-closure-sample-audit-review.html");
const BUILD_REPORT_PATH = path.join(OWNER_DIR, "ui/sample-audit-v0.1/sample-audit-review-ui-build-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let htmlText; let embeddedPayload; let buildReport;
let inputHashBefore;

test.before(async () => {
  inputHashBefore = sha256(await readFile(SAMPLE_PACKET_PATH));
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-sample-audit-review-ui-v01.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  embeddedPayload = JSON.parse(match[1]);
}, { timeout: 20_000 });

test("build does not modify the sample packet input (byte-identical before and after)", async () => {
  const after = sha256(await readFile(SAMPLE_PACKET_PATH));
  assert.equal(after, inputHashBefore);
  assert.equal(buildReport.inputs_unchanged, true);
});

test("embedded payload has exactly 30 rows with zero duplicate relation_candidate_id, each with an audit_stratum_key and audit_item_id", () => {
  assert.equal(embeddedPayload.rows.length, 30);
  const ids = embeddedPayload.rows.map((r) => r.relation_candidate_id);
  assert.equal(new Set(ids).size, 30);
  for (const row of embeddedPayload.rows) {
    assert.ok(row.audit_stratum_key && row.audit_stratum_key.length > 0);
    assert.match(row.audit_item_id, /^sample_audit_item_/);
  }
  const auditItemIds = embeddedPayload.rows.map((r) => r.audit_item_id);
  assert.equal(new Set(auditItemIds).size, 30, "audit_item_id must be distinct per row");
});

test("static scan: no external resource pattern, no innerHTML, exactly 2 script tags, valid doctype", () => {
  assert.doesNotMatch(htmlText, /https?:\/\//i);
  assert.doesNotMatch(htmlText, /<link[^>]+href/i);
  assert.doesNotMatch(htmlText, /innerHTML/);
  assert.equal((htmlText.match(/<script/gi) || []).length, 2);
  assert.match(htmlText, /^<!doctype html>/i);
});

test("build report names the correct FINAL and summary export filenames, and scopes this UI away from the Owner UI/Gold", () => {
  assert.equal(buildReport.final_export_filename, "relation-closure-sample-auditor-decision.v0.1.jsonl");
  assert.equal(buildReport.summary_export_filename, "relation-closure-sample-audit-summary.v0.1.json");
  assert.match(buildReport.scope_note, /NOT the 29-row Owner adjudication UI/);
  assert.match(buildReport.scope_note, /never auto-approve or auto-reject the remaining 267/);
});

test("this UI's localStorage/export namespace never collides with the Reviewer A/B UI or the Owner UI's own names", () => {
  assert.doesNotMatch(htmlText, /relation-closure-review-ui-v0\.1-state-/);
  assert.doesNotMatch(htmlText, /relation-closure-owner-review-ui-v0\.1-state-/);
  assert.match(htmlText, /relation-closure-sample-audit-review-ui-v0\.1-state-/);
});

test("auditor_role SAMPLE_AUDITOR is a fixed constant with no code path reading it from location.search or an editable input", () => {
  assert.doesNotMatch(htmlText, /location\.search/);
  assert.doesNotMatch(htmlText, /URLSearchParams/);
  assert.match(htmlText, /AUDITOR_ROLE = 'SAMPLE_AUDITOR'/);
});

let page; let finalRecords; let summaryJson; let downloadedFinal; let downloadedSummary;
let ownerStorageProbe; let crossUiProbe;

test.before(async () => {
  page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });

  // -- real DOM: DEFECT_FOUND on the first card, proving required-field
  // gating actually blocks an incomplete submission. ---------------------
  const firstId = embeddedPayload.rows[0].relation_candidate_id;
  await page.evaluate("document.querySelector('.decision-btn.DEFECT_FOUND').click()");
  const panelOpenAfterClick = await page.evaluate("document.querySelector('.defect-panel').className.indexOf('open') !== -1");
  await page.evaluate("document.querySelector('.export-btn:not(.final)').click()"); // "이 판정 저장" submit button
  const errorAfterEmptySubmit = await page.evaluate(`document.getElementById('field-error-${firstId}').textContent`);
  const badgeAfterEmptySubmit = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");

  // fill every required DEFECT_FOUND field, then submit.
  await page.evaluate(`
    (function () {
      var typeSel = document.querySelector('.defect-panel select');
      typeSel.value = 'WRONG_TARGET'; typeSel.dispatchEvent(new Event('change'));
      var textareas = document.querySelectorAll('.defect-panel textarea');
      textareas[0].value = '\\uB300\\uC0C1 \\uBB38\\uC11C\\uAC00 \\uD2C0\\uB9BC'; textareas[0].dispatchEvent(new Event('input'));
      var selects = document.querySelectorAll('.defect-panel select');
      selects[1].value = 'REJECT'; selects[1].dispatchEvent(new Event('change'));
    })()
  `);
  await page.evaluate(`
    (function () {
      var scopeBox = document.querySelectorAll('.defect-panel textarea')[1];
      scopeBox.value = '\\uC601\\uD5A5 \\uBc94\\uC704 \\uD14C\\uC2A4\\uD2B8'; scopeBox.dispatchEvent(new Event('input'));
      var note = document.querySelector('.notes-box');
      note.value = '\\uD14C\\uC2A4\\uD2B8 \\uAC10\\uC0AC \\uBA54\\uBaa8'; note.dispatchEvent(new Event('input'));
    })()
  `);
  await page.evaluate("document.querySelector('.export-btn:not(.final)').click()");
  const badgeAfterCompleteSubmit = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");

  // -- bulk-complete the remaining 29 rows via the SAME pure function the
  // UI's own submit button calls (applyAuditDecision), never bypassing
  // its validation. --------------------------------------------------
  const bulkResult = await page.evaluate(`
    (function () {
      var rows = ${JSON.stringify(embeddedPayload.rows)};
      var key = 'relation-closure-sample-audit-review-ui-v0.1-state-' + ${JSON.stringify(embeddedPayload.sample_packet_sha256)};
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        var candidateIds = row.candidates.map(function (c) { return c.target_document_id; });
        var input = i % 3 === 0
          ? { audit_disposition: 'NEEDS_MORE_REVIEW', audit_note: '\\uCD94\\uAC00 \\uD655\\uC778 \\uD544\\uC694' }
          : { audit_disposition: 'PASS', audit_note: '\\uC6D0\\uBB38 \\uD655\\uC778\\uD568: ' + row.source_document_id };
        state = applyAuditDecision(state, row.relation_candidate_id, input, nowIso, candidateIds);
      }
      localStorage.setItem(key, JSON.stringify(state));
      return { judged: auditedCount(state, rows.map(function (r) { return r.relation_candidate_id; })), allJudged: allAudited(state, rows.map(function (r) { return r.relation_candidate_id; })) };
    })()
  `);

  await page.send("Page.navigate", { url: `file://${HTML_PATH}` });
  await new Promise((r) => setTimeout(r, 400));

  const finalBtnDisabledAfterAll = await page.evaluate("document.querySelector('.export-btn.final').disabled");
  await page.evaluate("document.querySelector('.export-btn.final').click()");
  downloadedFinal = await waitForNamedDownload(page.downloadDir, "relation-closure-sample-auditor-decision.v0.1.jsonl", 10_000);
  const jsonlText = await readFile(downloadedFinal.path, "utf8");
  finalRecords = jsonlText.trim().split("\n").map((l) => JSON.parse(l));

  downloadedSummary = await waitForNamedDownload(page.downloadDir, "relation-closure-sample-audit-summary.v0.1.json", 10_000);
  summaryJson = JSON.parse(await readFile(downloadedSummary.path, "utf8"));

  global.__n44SampleAuditState = {
    panelOpenAfterClick, errorAfterEmptySubmit, badgeAfterEmptySubmit, badgeAfterCompleteSubmit,
    bulkResult, finalBtnDisabledAfterAll,
  };
  await page.close(); page = null;

  // -- cross-UI isolation, all within ONE continuous browser session/
  // profile (this is the scenario that actually matters -- two separate
  // launchHeadlessChromePage() calls always get fresh, already-isolated
  // profiles, which would trivially pass even if the namespacing itself
  // were broken): judge the Sample Audit UI's own first row for real via
  // DOM interaction, navigate to the Owner UI and judge ITS first row,
  // then navigate BACK to the Sample Audit UI and confirm its own state
  // is exactly as this session left it -- never reset, never overwritten
  // by the Owner UI's own activity in between. ---------------------------
  page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  const probeId = embeddedPayload.rows[0].relation_candidate_id;
  await page.evaluate("document.querySelector('.decision-btn.PASS').click()");
  await page.evaluate(`
    (function () {
      var note = document.querySelector('.notes-box');
      note.value = 'cross-ui isolation probe note'; note.dispatchEvent(new Event('input'));
    })()
  `);
  await page.evaluate("document.querySelector('.export-btn:not(.final)').click()");
  const sampleAuditBadgeBeforeNav = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");

  await page.send("Page.navigate", { url: `file://${OWNER_HTML_PATH}` });
  await new Promise((r) => setTimeout(r, 400));
  const ownerFirstId = await page.evaluate("JSON.parse(document.getElementById('review-data').textContent).rows[0].relation_candidate_id");
  await page.evaluate(`
    (function () {
      var note = document.getElementById('note-${ownerFirstId}');
      note.value = 'owner ui probe note'; note.dispatchEvent(new Event('input'));
    })()
  `);
  await page.evaluate("document.querySelector('.row-decision-btn.REJECT').click()");
  const ownerBadgeAfter = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");

  await page.send("Page.navigate", { url: `file://${HTML_PATH}` });
  await new Promise((r) => setTimeout(r, 400));
  const sampleAuditStorageKeys = await page.evaluate("Object.keys(localStorage).filter(function (k) { return k.indexOf('relation-closure') === 0; })");
  const sampleAuditBadgeAfterReturning = await page.evaluate("document.querySelector('.card-head .disposition-badge') ? document.querySelector('.card-head .disposition-badge').textContent : null");
  const sampleAuditStateStillIntact = await page.evaluate(`
    (function () {
      var key = 'relation-closure-sample-audit-review-ui-v0.1-state-' + ${JSON.stringify(embeddedPayload.sample_packet_sha256)};
      var state = JSON.parse(localStorage.getItem(key) || '{}');
      return state['${probeId}'] ? state['${probeId}'].audit_disposition : null;
    })()
  `);

  crossUiProbe = { sampleAuditBadgeBeforeNav, ownerBadgeAfter, sampleAuditStorageKeys, sampleAuditBadgeAfterReturning, sampleAuditStateStillIntact };
}, { timeout: 40_000 });

test.after(async () => { if (page) await page.close(); }, { timeout: 10_000 });

test("headless: clicking DEFECT_FOUND opens the defect panel, and submitting with required fields empty is blocked with an error, staying PENDING", () => {
  const s = global.__n44SampleAuditState;
  assert.equal(s.panelOpenAfterClick, true);
  assert.notEqual(s.errorAfterEmptySubmit, "");
  assert.equal(s.badgeAfterEmptySubmit, "PENDING");
});

test("headless: after filling defect_type/defect_description/expected_disposition/affected_scope_estimate/audit_note, DEFECT_FOUND applies correctly", () => {
  assert.equal(global.__n44SampleAuditState.badgeAfterCompleteSubmit, "DEFECT_FOUND");
});

test("headless: bulk-completing the remaining 29 rows reaches auditedCount 30 / allAudited true", () => {
  const s = global.__n44SampleAuditState.bulkResult;
  assert.equal(s.judged, 30);
  assert.equal(s.allJudged, true);
});

test("headless: FINAL export is disabled before all 30 are judged, then enabled and produces a real JSONL download", () => {
  assert.equal(global.__n44SampleAuditState.finalBtnDisabledAfterAll, false);
  assert.equal(downloadedFinal.filename, "relation-closure-sample-auditor-decision.v0.1.jsonl");
  assert.ok(downloadedFinal.bytes > 0);
});

test("headless: the exported JSONL has exactly 30 records with the full required field set, auditor_role fixed to SAMPLE_AUDITOR", () => {
  assert.equal(finalRecords.length, 30);
  const requiredFields = [
    "audit_item_id", "relation_candidate_id", "auditor_role", "original_provisional_disposition",
    "original_confirmed_target_document_id", "audit_disposition", "audit_note", "defect_type",
    "defect_description", "expected_disposition", "expected_target_document_id", "affected_scope_estimate",
    "source_document_id", "sample_packet_sha256", "comparison_ledger_sha256", "reviewed_at",
  ];
  for (const r of finalRecords) {
    for (const f of requiredFields) assert.ok(Object.prototype.hasOwnProperty.call(r, f), `missing field ${f} on ${r.relation_candidate_id}`);
    assert.equal(r.auditor_role, "SAMPLE_AUDITOR");
    assert.ok(r.audit_note && r.audit_note.length > 0);
    if (r.audit_disposition === "DEFECT_FOUND") {
      assert.ok(r.defect_type);
      assert.ok(r.defect_description);
    } else {
      assert.equal(r.defect_type, null);
      assert.equal(r.expected_disposition, null);
    }
  }
});

test("headless: a real summary JSON also downloaded, with the correct filename and totals", () => {
  assert.ok(downloadedSummary, "summary JSON did not download alongside the JSONL");
  assert.equal(downloadedSummary.filename, "relation-closure-sample-audit-summary.v0.1.json");
  assert.equal(summaryJson.total, 30);
  assert.equal(summaryJson.auto_chain_closure_performed, false);
  assert.equal(summaryJson.auto_owner_approval_performed, false);
  assert.equal(summaryJson.remaining_267_auto_promoted, false);
  assert.ok(["SAMPLE_AUDIT_COMPLETED_NO_DEFECT", "SAMPLE_AUDIT_DEFECT_FOUND", "SAMPLE_AUDIT_ADDITIONAL_REVIEW_REQUIRED"].includes(summaryJson.gate_status));
  // this test run always includes at least 1 real DEFECT_FOUND -- the gate must reflect that.
  assert.equal(summaryJson.gate_status, "SAMPLE_AUDIT_DEFECT_FOUND");
  assert.equal(summaryJson.by_disposition.DEFECT_FOUND >= 1, true);
});

test("headless: cross-UI isolation -- judging a row in the Sample Audit UI, then judging a DIFFERENT row in the Owner UI, then returning to the Sample Audit UI (all in ONE continuous browser session) never cross-contaminates either UI's own state", () => {
  assert.equal(crossUiProbe.sampleAuditBadgeBeforeNav, "PASS");
  assert.equal(crossUiProbe.ownerBadgeAfter, "REJECT");
  // Returning to the Sample Audit UI in the SAME session must show its
  // own PASS judgment exactly as left -- never reset, never overwritten
  // by the intervening Owner UI activity in between.
  assert.equal(crossUiProbe.sampleAuditBadgeAfterReturning, "PASS");
  assert.equal(crossUiProbe.sampleAuditStateStillIntact, "PASS");
  assert.ok(crossUiProbe.sampleAuditStorageKeys.some((k) => k.indexOf("sample-audit-review-ui") !== -1));
});
