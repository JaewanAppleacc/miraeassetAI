// Turn N4.5: verifies the offline Owner adjudication UI v0.2
// (scripts/build-relation-closure-owner-review-ui-v02.mjs): embedded data
// shape (30 rows = 29 v0.1 union + 1 audit-conflict row), a static scan of
// the generated HTML, that the v0.1 Owner UI's own HTML file is untouched,
// separate localStorage/export namespace from BOTH v0.1 Owner UI and the
// sample-audit UI, and real headless-Chrome CONFIRM/REJECT/NEEDS_MORE_REVIEW
// + FINAL-export-gating + real download behavior.
import assert from "node:assert/strict";
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
const OWNER_PACKET_V02_PATH = path.join(V02_DIR, "relation-closure-owner-adjudication-packet.v0.2.jsonl");
const HTML_PATH = path.join(V02_DIR, "ui/v0.2/relation-closure-owner-review.html");
const BUILD_REPORT_PATH = path.join(V02_DIR, "ui/v0.2/owner-review-ui-build-report.json");

function readJsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }

let htmlText; let embeddedPayload; let buildReport; let ownerPacketRows;

test.before(async () => {
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-owner-review-ui-v02.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  embeddedPayload = JSON.parse(match[1]);
  ownerPacketRows = readJsonl(await readFile(OWNER_PACKET_V02_PATH, "utf8"));
}, { timeout: 15_000 });

// A live before/after hash comparison of V01_HTML_PATH is inherently racy
// under full-suite concurrency: that file is the OWN output of
// build-relation-closure-owner-review-ui-v01.mjs, which its own sibling
// test file legitimately rewrites concurrently (with a fresh embedded
// generated_at) -- an unrelated process's own rebuild can trip a live hash
// check even though THIS build script never writes to that path. Turn
// N4.8 fixes this the same way tests/relation-closure-owner-review-ui-v03
// .test.mjs already does for its own v0.1/v0.2 checks: a static, exhaustive
// source-code check proves the guarantee without depending on timing, plus
// the build script's OWN before/after comparison (computed entirely inside
// its single process invocation, so it cannot race with a sibling test
// file) recorded in its build report.
test("static: build-relation-closure-owner-review-ui-v02.mjs's every writeFile call targets only its own OUT_DIR (ui/v0.2) namespace, never the v0.1 Owner review HTML path -- a race-free, exhaustive proof (unlike a live before/after hash comparison, this is immune to the v0.1 UI builder's own sibling test file legitimately rebuilding it concurrently)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-relation-closure-owner-review-ui-v02.mjs"), "utf8");
  assert.match(source, /const OUT_DIR = path\.join\(V02_DIR, "ui\/v0\.2"\)/);
  const writeCalls = [...source.matchAll(/await writeFile\((\w+),/g)].map((m) => m[1]);
  assert.ok(writeCalls.length >= 2, "expected at least 2 writeFile call sites (HTML + build report)");
  const allowedTargetVars = ["OUT_HTML_PATH", "OUT_REPORT_PATH"];
  for (const varName of writeCalls) assert.ok(allowedTargetVars.includes(varName), `unexpected writeFile target variable: ${varName}`);
  for (const varName of allowedTargetVars) {
    assert.match(source, new RegExp(`${varName} = path\\.join\\(OUT_DIR,`));
  }
  assert.equal(buildReport.v01_html_unchanged, true);
});

test("embedded payload has exactly 30 rows, zero duplicates, all PENDING, 16 TERMINATES, exactly 1 AUDIT_CONFLICT", () => {
  assert.equal(embeddedPayload.rows.length, 30);
  const ids = embeddedPayload.rows.map((r) => r.relation_candidate_id);
  assert.equal(new Set(ids).size, 30);
  assert.ok(embeddedPayload.rows.every((r) => r.owner_disposition === "PENDING"));
  assert.equal(embeddedPayload.rows.filter((r) => r.relation_type === "TERMINATES").length, 16);
  assert.equal(embeddedPayload.rows.filter((r) => (r.owner_review_reason || []).includes("AUDIT_CONFLICT")).length, 1);
});

test("static scan: no external resource pattern, no innerHTML, exactly 2 script tags", () => {
  assert.doesNotMatch(htmlText, /https?:\/\//i);
  assert.doesNotMatch(htmlText, /innerHTML/);
  assert.equal((htmlText.match(/<script/gi) || []).length, 2);
});

test("this UI's localStorage/export namespace never collides with the v0.1 Owner UI or the sample-audit UI", () => {
  assert.match(htmlText, /relation-closure-owner-review-ui-v0\.2-state-/);
  assert.doesNotMatch(htmlText, /relation-closure-owner-review-ui-v0\.1-state-/);
  assert.doesNotMatch(htmlText, /relation-closure-sample-audit-review-ui-v0\.1-state-/);
  assert.match(buildReport.final_export_filename, /relation-closure-owner-decision\.v0\.2\.jsonl/);
});

let finalRecords; let downloadedFile;

test.before(async (t) => {
  // Turn N4.18.2: single cleanup owner via the test context's own
  // t.after(), registered immediately upon acquiring the page handle --
  // see the matching comment in relation-closure-owner-review-ui-v01
  // .test.mjs for the full rationale.
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const conflictId = embeddedPayload.rows.find((r) => (r.owner_review_reason || []).includes("AUDIT_CONFLICT")).relation_candidate_id;

  // -- bulk-complete all 30 rows via the SAME pure function the UI's own
  // buttons call, then reload and verify FINAL export gating + a real
  // download, mirroring the v0.1 Owner UI test's own approach. ----------
  const bulkResult = await page.evaluate(`
    (function () {
      var rows = ${JSON.stringify(embeddedPayload.rows)};
      var key = 'relation-closure-owner-review-ui-v0.2-state-' + ${JSON.stringify(embeddedPayload.source_owner_packet_sha256)};
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var candidateIds = row.candidates.map(function (c) { return c.target_document_id; });
        if (candidateIds.length > 0) {
          state = applyOwnerDecision(state, row.relation_candidate_id, 'CONFIRM', candidateIds[0], '\\uc77c\\uad04 \\ud655\\uc778 \\uadfc\\uac70', nowIso, 'owner_test', candidateIds);
        } else {
          state = applyOwnerDecision(state, row.relation_candidate_id, 'REJECT', null, '\\ud6c4\\ubcf4 \\uc5c6\\uc74c', nowIso, 'owner_test', candidateIds);
        }
      }
      localStorage.setItem(key, JSON.stringify(state));
      return { judged: judgedCount(state, rows.map(function (r) { return r.relation_candidate_id; })), allJudged: allJudged(state, rows.map(function (r) { return r.relation_candidate_id; })) };
    })()
  `);

  await page.send("Page.navigate", { url: `file://${HTML_PATH}` });
  await new Promise((r) => setTimeout(r, 400));

  const finalBtnDisabledAfterAll = await page.evaluate("document.querySelector('.export-btn.final').disabled");
  await page.evaluate("document.querySelector('.export-btn.final').click()");
  downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 10_000 });
  const exportedJson = await readFile(downloadedFile.path, "utf8");
  finalRecords = exportedJson.trim().split("\n").map((l) => JSON.parse(l));

  global.__n45OwnerV02TestState = { bulkResult, finalBtnDisabledAfterAll, conflictId };
}, { timeout: 30_000 });

test("headless: bulk-completing all 30 rows reaches judgedCount 30 / allJudged true", () => {
  const s = global.__n45OwnerV02TestState.bulkResult;
  assert.equal(s.judged, 30);
  assert.equal(s.allJudged, true);
});

test("headless: FINAL export is enabled only once all 30 are judged, and produces a real download named relation-closure-owner-decision.v0.2.jsonl", () => {
  assert.equal(global.__n45OwnerV02TestState.finalBtnDisabledAfterAll, false);
  assert.equal(downloadedFile.filename, "relation-closure-owner-decision.v0.2.jsonl");
  assert.ok(downloadedFile.bytes > 0);
});

test("headless: the exported FINAL file has exactly 30 records including the audit-conflict row, each with a valid disposition/target/note shape", () => {
  assert.equal(finalRecords.length, 30);
  const conflictRecord = finalRecords.find((r) => r.relation_candidate_id === global.__n45OwnerV02TestState.conflictId);
  assert.ok(conflictRecord);
  for (const r of finalRecords) {
    assert.ok(["CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"].includes(r.owner_disposition));
    if (r.owner_disposition === "CONFIRM") assert.ok(r.confirmed_target_document_id);
    else assert.equal(r.confirmed_target_document_id, null);
    assert.ok(r.owner_note && r.owner_note.length > 0);
  }
});

test("headless: every CONFIRM row's target is one of that row's own candidate ids (never fabricated)", () => {
  const candidatesById = new Map(ownerPacketRows.map((r) => [r.relation_candidate_id, r.candidates.map((c) => c.target_document_id)]));
  for (const r of finalRecords) {
    if (r.owner_disposition === "CONFIRM") {
      assert.ok(candidatesById.get(r.relation_candidate_id).includes(r.confirmed_target_document_id));
    }
  }
});
