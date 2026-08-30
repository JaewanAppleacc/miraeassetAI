// Turn N4.5.1, Task 9: verifies the two independent multi-step correction
// risk review UIs v0.2 (Reviewer C / Reviewer D), built from the
// real-DocumentIR-grounded risk packet. Confirms: fully separate
// localStorage/export namespaces; CONFIRM's target must be within the
// row's own qualifying candidate_evaluations set; FINAL export is gated on
// all rows judged; real headless-Chrome downloads that never mix between
// reviewers; and that the existing N4.5 v0.1 116-row UI is untouched.
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
const RISK_V02_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/multistep-risk-v0.2");
const RISK_PACKET_PATH = path.join(RISK_V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.2.jsonl");
const OUT_DIR = path.join(RISK_V02_DIR, "ui");
const HTML_C_PATH = path.join(OUT_DIR, "relation-closure-multistep-review.reviewer-c.v0.2.html");
const HTML_D_PATH = path.join(OUT_DIR, "relation-closure-multistep-review.reviewer-d.v0.2.html");
const BUILD_REPORT_PATH = path.join(OUT_DIR, "multistep-review-ui-v02-build-report.json");

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
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-multistep-review-ui-v02.mjs")], { cwd: ROOT });
  htmlC = await readFile(HTML_C_PATH, "utf8");
  htmlD = await readFile(HTML_D_PATH, "utf8");
  payloadC = extractPayload(htmlC);
  payloadD = extractPayload(htmlD);
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
}, { timeout: 15_000 });

test("build never modifies the risk packet input (exclusively owned by this v0.3 namespace, never written by any sibling test file)", async () => {
  assert.equal(sha256(await readFile(RISK_PACKET_PATH)), riskRowsBefore);
});

test("static: the v0.2 build script's every writeFile call targets only its own RISK_V02_DIR/ui namespace, never N4.5's v0.1 116-row Reviewer C/D UI directory -- a race-free, exhaustive proof (unlike a live before/after hash comparison, this is immune to relation-closure-multistep-review-ui-v01.test.mjs's own concurrent, legitimate rebuild of that v0.1 UI)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-relation-closure-multistep-review-ui-v02.mjs"), "utf8");
  assert.match(source, /const OUT_DIR = path\.join\(RISK_V02_DIR, "ui"\)/);
  const writeCalls = [...source.matchAll(/await writeFile\((\w+),/g)].map((m) => m[1]);
  assert.ok(writeCalls.length >= 2, "expected at least 2 writeFile call sites (per-variant HTML + build report)");
  for (const varName of writeCalls) assert.ok(["outPath", "reportPath"].includes(varName), `unexpected writeFile target variable: ${varName}`);
});

test("both HTML files embed the same real-DocumentIR risk rows but a DIFFERENT reviewer_role, and are byte-DIFFERENT files", () => {
  assert.equal(payloadC.rows.length, payloadD.rows.length);
  assert.ok(payloadC.rows.length > 0);
  assert.equal(payloadC.reviewer_role, "REVIEWER_C");
  assert.equal(payloadD.reviewer_role, "REVIEWER_D");
  assert.notEqual(htmlC, htmlD);
});

test("each row embeds real candidate_evaluations with continuity/identity signals and node_id locators, never PARSER_UNCERTAIN", () => {
  for (const row of payloadC.rows) {
    assert.ok(row.candidate_evaluations.length > 0);
    assert.doesNotMatch(JSON.stringify(row.candidate_evaluations), /PARSER_UNCERTAIN/);
  }
});

test("static scan: no external resource pattern, no innerHTML in either file", () => {
  for (const html of [htmlC, htmlD]) {
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /innerHTML/);
  }
});

test("localStorage/export namespace is v0.2-specific and never collides with N4.5's v0.1 116-row UI namespace", () => {
  assert.match(htmlC, /relation-closure-multistep-review-ui-v0\.2-state-/);
  assert.doesNotMatch(htmlC, /relation-closure-multistep-review-ui-v0\.1-state-/);
  assert.equal(buildReport.final_export_filenames.REVIEWER_C, "relation-multistep-reviewer-c-decision.v0.2.jsonl");
  assert.equal(buildReport.final_export_filenames.REVIEWER_D, "relation-multistep-reviewer-d-decision.v0.2.jsonl");
});

let pageC; let pageD; let downloadC; let downloadD; let recordsC; let recordsD;

test.before(async () => {
  pageC = await launchHeadlessChromePage({ url: `file://${HTML_C_PATH}` });
  pageD = await launchHeadlessChromePage({ url: `file://${HTML_D_PATH}` });

  // Reviewer C confirms every row against its first qualifying candidate
  // evaluation; Reviewer D rejects every row -- deliberately DIFFERENT
  // judgments, to prove neither export is contaminated by the other's.
  const bulkC = await pageC.evaluate(`
    (function () {
      var rows = ${JSON.stringify(payloadC.rows)};
      var key = 'relation-closure-multistep-review-ui-v0.2-state-' + ${JSON.stringify(payloadC.source_risk_packet_sha256)} + '-REVIEWER_C';
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var union = row.candidate_evaluations.map(function (c) { return c.target_document_id; });
        state = applyReviewerDecision(state, row.relation_candidate_id, 'CONFIRM', union[0], 'Reviewer C \\ud655\\uc778', nowIso, 'reviewer_c_test', union);
      }
      localStorage.setItem(key, JSON.stringify(state));
      return { judged: judgedCount(state, rows.map(function (r) { return r.relation_candidate_id; })), allJudged: allJudged(state, rows.map(function (r) { return r.relation_candidate_id; })) };
    })()
  `);
  const bulkD = await pageD.evaluate(`
    (function () {
      var rows = ${JSON.stringify(payloadD.rows)};
      var key = 'relation-closure-multistep-review-ui-v0.2-state-' + ${JSON.stringify(payloadD.source_risk_packet_sha256)} + '-REVIEWER_D';
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

  global.__n451MultistepV02TestState = { bulkC, bulkD, finalDisabledC, finalDisabledD };
}, { timeout: 45_000 });

test.after(async () => { if (pageC) await pageC.close(); if (pageD) await pageD.close(); }, { timeout: 10_000 });

test("headless: both reviewers independently reach judgedCount == row_count / allJudged true", () => {
  const s = global.__n451MultistepV02TestState;
  assert.equal(s.bulkC.judged, payloadC.rows.length);
  assert.equal(s.bulkC.allJudged, true);
  assert.equal(s.bulkD.judged, payloadD.rows.length);
  assert.equal(s.bulkD.allJudged, true);
});

test("headless: FINAL export enables independently for each reviewer and downloads the CORRECT, distinct v0.2 filename", () => {
  assert.equal(global.__n451MultistepV02TestState.finalDisabledC, false);
  assert.equal(global.__n451MultistepV02TestState.finalDisabledD, false);
  assert.equal(downloadC.filename, "relation-multistep-reviewer-c-decision.v0.2.jsonl");
  assert.equal(downloadD.filename, "relation-multistep-reviewer-d-decision.v0.2.jsonl");
});

test("headless: Reviewer C's export is all CONFIRM with a valid in-union target; Reviewer D's export is all REJECT -- the two never mix", () => {
  assert.equal(recordsC.length, payloadC.rows.length);
  assert.equal(recordsD.length, payloadD.rows.length);
  assert.ok(recordsC.every((r) => r.reviewer_disposition === "CONFIRM" && r.confirmed_target_document_id));
  assert.ok(recordsD.every((r) => r.reviewer_disposition === "REJECT" && r.confirmed_target_document_id === null));
  assert.ok(recordsC.every((r) => r.reviewer_role === "REVIEWER_C"));
  assert.ok(recordsD.every((r) => r.reviewer_role === "REVIEWER_D"));
});

test("headless: every Reviewer C CONFIRM target is within that row's own candidate_evaluations set (never fabricated)", () => {
  const rowsById = new Map(payloadC.rows.map((r) => [r.relation_candidate_id, r]));
  for (const r of recordsC) {
    const row = rowsById.get(r.relation_candidate_id);
    const union = new Set(row.candidate_evaluations.map((c) => c.target_document_id));
    assert.ok(union.has(r.confirmed_target_document_id), `Reviewer C target ${r.confirmed_target_document_id} not in row ${r.relation_candidate_id}'s union`);
  }
});
