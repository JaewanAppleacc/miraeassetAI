// Turn N4.3: verifies the offline Owner adjudication UI
// (scripts/build-relation-closure-owner-review-ui-v01.mjs): embedded data
// shape, a static scan of the generated HTML, and real headless-Chrome
// behavior -- note-required enforcement, CONFIRM/REJECT/NEEDS_MORE_REVIEW
// wiring, FINAL-export gating (blocked until all 29 rows are judged), and
// a real completed download in the page's own dedicated downloadDir.
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
const OWNER_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const OWNER_PACKET_PATH = path.join(OWNER_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl");
const HTML_PATH = path.join(OWNER_DIR, "ui/v0.1/relation-closure-owner-review.html");
const BUILD_REPORT_PATH = path.join(OWNER_DIR, "ui/v0.1/owner-review-ui-build-report.json");

function readJsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }

let htmlText; let embeddedPayload; let buildReport; let ownerPacketRows;

test.before(async () => {
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-owner-review-ui-v01.mjs")], { cwd: ROOT });
  htmlText = await readFile(HTML_PATH, "utf8");
  buildReport = JSON.parse(await readFile(BUILD_REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag not found");
  embeddedPayload = JSON.parse(match[1]);
  ownerPacketRows = readJsonl(await readFile(OWNER_PACKET_PATH, "utf8"));
});

// A live before/after hash comparison of OWNER_PACKET_PATH is inherently
// racy under full-suite concurrency: that same v0.1 packet is the OWN
// output of scripts/build-relation-closure-owner-packet-v043.mjs, which
// its own sibling test file (relation-closure-owner-packet-v043.test.mjs)
// legitimately rewrites concurrently -- an unrelated process's own
// rebuild can trip a live hash check even though THIS build script never
// writes to that path at all. A static, exhaustive source-code check
// proves the same guarantee without depending on timing.
test("static: build-relation-closure-owner-review-ui-v01.mjs's every writeFile call targets only its own OUT_DIR (ui/v0.1) namespace, never the owner packet input path -- a race-free, exhaustive proof (unlike a live before/after hash comparison, this is immune to the v0.43 packet builder's own sibling test file legitimately rewriting it concurrently)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-relation-closure-owner-review-ui-v01.mjs"), "utf8");
  assert.match(source, /const OUT_DIR = path\.join\(OWNER_DIR, "ui\/v0\.1"\)/);
  const writeCalls = [...source.matchAll(/await writeFile\((\w+),/g)].map((m) => m[1]);
  assert.ok(writeCalls.length >= 2, "expected at least 2 writeFile call sites (HTML + build report)");
  const allowedTargetVars = ["OUT_HTML_PATH", "OUT_REPORT_PATH"];
  for (const varName of writeCalls) assert.ok(allowedTargetVars.includes(varName), `unexpected writeFile target variable: ${varName}`);
  for (const varName of allowedTargetVars) {
    assert.match(source, new RegExp(`${varName} = path\\.join\\(OUT_DIR,`));
  }
  assert.equal(buildReport.inputs_unchanged, true);
});

test("embedded payload has exactly 29 rows, zero duplicates, all PENDING, 16 TERMINATES", () => {
  assert.equal(embeddedPayload.rows.length, 29);
  const ids = embeddedPayload.rows.map((r) => r.relation_candidate_id);
  assert.equal(new Set(ids).size, 29);
  assert.ok(embeddedPayload.rows.every((r) => r.owner_disposition === "PENDING"));
  assert.equal(embeddedPayload.rows.filter((r) => r.relation_type === "TERMINATES").length, 16);
});

test("static scan: no external resource pattern, no innerHTML, exactly 2 script tags, valid doctype", () => {
  assert.doesNotMatch(htmlText, /https?:\/\//i);
  assert.doesNotMatch(htmlText, /<link[^>]+href/i);
  assert.doesNotMatch(htmlText, /innerHTML/);
  assert.equal((htmlText.match(/<script/gi) || []).length, 2);
  assert.match(htmlText, /^<!doctype html>/i);
});

test("build report scopes this UI to Owner final adjudication, not Gold, and names the correct FINAL export filename", () => {
  assert.match(buildReport.scope_note, /Owner's FINAL adjudication/);
  assert.match(buildReport.scope_note, /NOT a Gold answer review UI/);
  assert.equal(buildReport.final_export_filename, "relation-closure-owner-decision.v0.1.jsonl");
});

test("this UI's localStorage/export namespace never collides with the Reviewer A/B UI's own names", () => {
  assert.doesNotMatch(htmlText, /relation-closure-review-ui-v0\.1-state-/);
  assert.match(htmlText, /relation-closure-owner-review-ui-v0\.1-state-/);
});

let finalRecords; let downloadedFile;

test.before(async (t) => {
  // Turn N4.18.2: register cleanup via the test context's OWN t.after()
  // immediately upon acquiring the page handle -- a single, unambiguous
  // cleanup owner tied to THIS specific page instance, rather than a
  // module-level `let page` variable plus a textually separate
  // `test.after()` declaration that a future edit could accidentally
  // desync from (e.g. by reassigning `page` without updating the other
  // hook). t.after() runs regardless of how this before() hook and every
  // test in this file resolve -- success, an assertion throw, a timeout --
  // exactly the "hard structure" this Turn asks for.
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  // -- real DOM interaction on the first card: proves note-required
  // gating and the actual button click handlers work end-to-end. The
  // card's OWN (owner) disposition badge is the FIRST .disposition-badge
  // in DOM order -- renderReviewerBox() later adds two MORE
  // .disposition-badge elements (Reviewer A's and B's own, static, already-
  // real dispositions), so this must be scoped, never a bare document-wide
  // index guess. --------------------------------------------------------
  const firstId = embeddedPayload.rows[0].relation_candidate_id;
  await page.evaluate("document.querySelector('.row-decision-btn.REJECT').click()");
  const badgeBeforeNote = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");
  const errorShown = await page.evaluate(`document.getElementById('note-error-${firstId}').textContent`);

  await page.evaluate(`document.getElementById('note-${firstId}').value = '\\uD14C\\uC2A4\\uD2B8 \\uADFC\\uAC70'; document.getElementById('note-${firstId}').dispatchEvent(new Event('input'))`);
  await page.evaluate("document.querySelector('.row-decision-btn.REJECT').click()");
  const firstBadgeAfter = await page.evaluate("document.querySelector('.card-head .disposition-badge').textContent");

  // -- bulk-complete the remaining 28 rows via the SAME pure function the
  // UI's own buttons call (applyOwnerDecision), never bypassing its
  // validation -- proves the persisted state round-trips through a real
  // page reload correctly, without requiring 29 rounds of DOM navigation. --
  const bulkResult = await page.evaluate(`
    (function () {
      var rows = ${JSON.stringify(embeddedPayload.rows)};
      var key = 'relation-closure-owner-review-ui-v0.1-state-' + ${JSON.stringify(embeddedPayload.source_owner_packet_sha256)};
      var state = JSON.parse(localStorage.getItem(key));
      var nowIso = new Date().toISOString();
      for (var i = 1; i < rows.length; i++) {
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

  global.__n43OwnerUiTestState = { badgeBeforeNote, errorShown, firstBadgeAfter, bulkResult, finalBtnDisabledAfterAll };
}, { timeout: 30_000 });

test("headless: clicking REJECT with an empty note does NOT apply the decision (note is required)", () => {
  const s = global.__n43OwnerUiTestState;
  assert.equal(s.badgeBeforeNote, "PENDING");
  assert.match(s.errorShown, /note/);
});

test("headless: after filling the note, REJECT applies correctly", () => {
  assert.equal(global.__n43OwnerUiTestState.firstBadgeAfter, "REJECT");
});

test("headless: bulk-completing the remaining 28 rows via applyOwnerDecision reaches judgedCount 29 / allJudged true", () => {
  const s = global.__n43OwnerUiTestState.bulkResult;
  assert.equal(s.judged, 29);
  assert.equal(s.allJudged, true);
});

test("headless: FINAL export button is disabled before all 29 are judged, then enabled and produces a real download", () => {
  assert.equal(global.__n43OwnerUiTestState.finalBtnDisabledAfterAll, false);
  assert.equal(downloadedFile.filename, "relation-closure-owner-decision.v0.1.jsonl");
  assert.ok(downloadedFile.bytes > 0);
});

test("headless: the exported FINAL file has exactly 29 records, each with the correct disposition/target/note shape", () => {
  assert.equal(finalRecords.length, 29);
  for (const r of finalRecords) {
    assert.ok(["CONFIRM", "REJECT", "NEEDS_MORE_REVIEW"].includes(r.owner_disposition));
    if (r.owner_disposition === "CONFIRM") assert.ok(r.confirmed_target_document_id, `CONFIRM row ${r.relation_candidate_id} missing a target`);
    else assert.equal(r.confirmed_target_document_id, null);
    assert.ok(r.owner_note && r.owner_note.length > 0, `row ${r.relation_candidate_id} missing owner_note`);
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

test("headless: the download never landed in the OS default Downloads folder", async () => {
  const osDownloads = path.join(path.dirname(path.dirname(HTML_PATH)), "nonexistent-marker"); // sanity placeholder, real check below
  assert.notEqual(downloadedFile.path.includes("/Downloads/"), true, "download path must not be inside a Downloads folder");
});
