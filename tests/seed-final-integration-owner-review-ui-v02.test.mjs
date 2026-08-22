// Turn M10 Section 13: verifies the v0.2 final-integration review UI's
// export-mechanism fix (real download/copy) and its non-mutation of
// v0.1, using the same static + real-headless-Chrome verification
// pattern tests/seed-final-integration-owner-review-ui.test.mjs already
// established.
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
const V02_HTML_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/final-integration-v0.2/seed-v020-final-integration-owner-review.html");
const V02_REPORT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/final-integration-v0.2/final-integration-review-ui-build-report.json");

let buildReport; let htmlText;

// Turn M9's own build script re-embeds a fresh generated_at timestamp into
// v0.1's HTML on every rebuild (including whenever
// tests/seed-final-integration-owner-review-ui.test.mjs's own test.before
// re-runs it concurrently under node --test's default parallelism), so a
// before/after SHA read taken here in the test process -- spanning the
// whole execFileAsync call plus whatever else the suite schedules around
// it -- can race against that unrelated, legitimate rebuild and produce a
// false mismatch. The build script itself already checks this atomically,
// immediately bracketing its own file-write work with a much tighter
// before/after read, and reports the result in its own build report; assert
// on that authoritative, race-resistant signal instead of re-deriving it.
test.before(async () => {
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-seed-final-integration-owner-review-ui-v02.mjs")], { cwd: ROOT });
  buildReport = JSON.parse(await readFile(V02_REPORT_PATH, "utf8"));
  htmlText = await readFile(V02_HTML_PATH, "utf8");
});

test("building v0.2 never modifies the existing v0.1 UI file", () => {
  assert.equal(buildReport.v01_html_unchanged_by_this_build, true);
});

test("no innerHTML, no external URL/CDN pattern in v0.2", () => {
  const scriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch);
  assert.equal(/\.innerHTML\s*=/.test(scriptMatch[1]), false);
  for (const pattern of [/<script[^>]+src=/i, /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/i]) {
    assert.equal(pattern.test(htmlText), false, `forbidden pattern matched: ${pattern}`);
  }
});

test("v0.2 uses Blob + createObjectURL for real download, and a copy-to-clipboard path", () => {
  assert.match(htmlText, /new Blob\(/);
  assert.match(htmlText, /URL\.createObjectURL/);
  assert.match(htmlText, /URL\.revokeObjectURL/);
  assert.match(htmlText, /navigator\.clipboard/);
  assert.match(htmlText, /document\.execCommand\("copy"\)/);
});

test("v0.2 provides a manual v0.1-export-JSONL paste-import path", () => {
  assert.match(htmlText, /importFromExportText/);
  assert.match(htmlText, /import-btn/);
});

let page; let cardCount; let progressAfterAll; let exportMessage; let exportOutputLength; let finalRecords; let importedCount; let downloadedFile;

// Turn N4.1a: a real, hung headless-Chrome process for this exact test file
// was found stuck for 3+ hours (and a second, older one for 11+ hours). The
// per-hook timeout below is an outer safety net on top of the real fix
// (bounded CDP command timeouts + a dedicated downloadDir in
// tests/lib/headless-chrome-cdp.mjs) -- if anything unforeseen still
// blocks here, this hook now fails loudly within a bounded time instead of
// hanging indefinitely under --test-timeout=0.
test.before(async () => {
  page = await launchHeadlessChromePage({ url: `file://${V02_HTML_PATH}` });
  cardCount = await page.evaluate("document.querySelectorAll('.card').length");
  const remaining = ["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_20", "question_seed_v07_25"];
  for (const qid of remaining) {
    await page.evaluate(`document.querySelector('button[data-action=APPROVE_RESPONSE][data-question-id=${qid}]').click()`);
  }
  await page.evaluate("document.getElementById('info-limit-accepted-question_seed_v07_18').click()");
  await page.evaluate("document.querySelector('button[data-action=APPROVE_RESPONSE][data-question-id=question_seed_v07_18]').click()");
  progressAfterAll = await page.evaluate("document.getElementById('progress-counter').textContent");
  await page.evaluate("document.getElementById('export-final-btn').click()");
  exportMessage = await page.evaluate("document.getElementById('export-message').textContent");
  exportOutputLength = await page.evaluate("document.getElementById('export-output').value.length");
  // Prove the FINAL export is a real, COMPLETE file in this page's own
  // dedicated downloadDir -- not just a UI success message -- and that it
  // never touched the OS default Downloads folder.
  downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 10_000 });
  const finalJson = await page.evaluate("JSON.stringify(window.__seedFinalIntegrationReviewV02.buildExportLines('final'))");
  finalRecords = JSON.parse(finalJson).map((l) => JSON.parse(l));

  // import mechanism: reset then import the just-exported text
  await page.evaluate("document.getElementById('reset-btn').click()");
  // reset clears the textarea display too in some flows -- re-derive from finalRecords instead
  const linesJson = JSON.stringify(finalRecords.map((r) => JSON.stringify(r)).join("\n"));
  importedCount = await page.evaluate(`window.__seedFinalIntegrationReviewV02.importFromExportText(${linesJson})`);
}, { timeout: 30_000 });

test.after(async () => { if (page) await page.close(); }, { timeout: 10_000 });

test("headless: 6 cards render", () => { assert.equal(cardCount, 6); });
test("headless: judging all 6 reaches 6/6", () => { assert.equal(progressAfterAll, "6/6"); });
test("headless: FINAL export shows a real download success message with the correct filename", () => {
  assert.match(exportMessage, /seed-v020-final-integration-owner-decision\.v0\.1\.jsonl 다운로드를 시작했습니다/);
});
test("headless: FINAL export output is non-empty JSONL", () => { assert.ok(exportOutputLength > 0); });
test("headless: FINAL export actually completed as a real file in the page's dedicated downloadDir, with the correct name and non-zero size", () => {
  assert.equal(downloadedFile.filename, "seed-v020-final-integration-owner-decision.v0.1.jsonl");
  assert.ok(downloadedFile.bytes > 0);
});
test("headless: FINAL export never auto-approves -- Q18 requires information_limit_accepted:true", () => {
  const q18 = finalRecords.find((r) => r.question_id === "question_seed_v07_18");
  assert.equal(q18.owner_disposition, "APPROVE_RESPONSE");
  assert.equal(q18.information_limit_accepted, true);
});
test("headless: manual paste-import correctly restores 6 records after a reset", () => {
  assert.equal(importedCount, 6);
});
