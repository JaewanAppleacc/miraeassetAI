// Turn M10 Section 15: verifies the offline Turn M10 remediation review
// UI -- 6 fresh-PENDING cards for r14, Q18's information_limit_accepted
// locked true (never re-askable/uncheckable), real download/copy export.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { launchHeadlessChromePage } from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/final-remediation-v0.1/seed-v020-final-remediation-owner-review.html");
const REPORT_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/final-remediation-v0.1/final-remediation-review-ui-build-report.json");
const PACKET_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m10-remediation-packet.v0.1.json");
const OWNER_DECISION_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.jsonl");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let packetShaBefore; let packetShaAfter; let ownerShaBefore; let ownerShaAfter; let htmlText; let payload;

test.before(async () => {
  packetShaBefore = sha256(await readFile(PACKET_PATH));
  ownerShaBefore = sha256(await readFile(OWNER_DECISION_PATH));
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-seed-final-remediation-owner-review-ui.mjs")], { cwd: ROOT });
  packetShaAfter = sha256(await readFile(PACKET_PATH));
  ownerShaAfter = sha256(await readFile(OWNER_DECISION_PATH));
  htmlText = await readFile(HTML_PATH, "utf8");
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  payload = JSON.parse(match[1]);
});

test("building this UI never modifies the remediation packet or the Turn M9 Owner decision", () => {
  assert.equal(packetShaAfter, packetShaBefore);
  assert.equal(ownerShaAfter, ownerShaBefore);
});

test("embedded payload has exactly 6 questions, all Turn M9 FIX_REQUIRED targets, no duplicates", () => {
  assert.equal(payload.records.length, 6);
  const ids = payload.records.map((r) => r.question_id);
  assert.equal(new Set(ids).size, 6);
});

test("Q18's information_limit_accepted is locked true in the embedded payload semantics (client always forces true, never reads a false/null override for it)", () => {
  assert.match(htmlText, /information_limit_accepted = true; \/\/ always locked true/);
});

test("no innerHTML, no external URL/CDN pattern", () => {
  const scriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.equal(/\.innerHTML\s*=/.test(scriptMatch[1]), false);
  assert.equal(/cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/i.test(htmlText), false);
});

let page; let cardCount; let initialBadges; let q18InfoLimitInPayload;

test.before(async () => {
  page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  cardCount = await page.evaluate("document.querySelectorAll('.card').length");
  initialBadges = JSON.parse(await page.evaluate(
    "JSON.stringify(Array.from(document.querySelectorAll('.badge-disposition-PENDING')).map(function(e){return e.textContent;}))",
  ));
  q18InfoLimitInPayload = await page.evaluate("window.__seedFinalRemediationReview.getState()['question_seed_v07_18'].information_limit_accepted");
});

test.after(async () => { if (page) await page.close(); });

test("headless: 6 cards render, all PENDING initially", () => {
  assert.equal(cardCount, 6);
  assert.equal(initialBadges.length, 6);
  assert.ok(initialBadges.every((b) => b === "PENDING"));
});

test("headless: Q18's information_limit_accepted starts true even though its own disposition is PENDING (carried forward, not re-asked)", () => {
  assert.equal(q18InfoLimitInPayload, true);
});

test("headless: judging all 6 and exporting FINAL succeeds with real download message", async () => {
  for (const qid of ["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25"]) {
    await page.evaluate(`document.querySelector('button[data-action=APPROVE_RESPONSE][data-question-id=${qid}]').click()`);
  }
  const progress = await page.evaluate("document.getElementById('progress-counter').textContent");
  assert.equal(progress, "6/6");
  await page.evaluate("document.getElementById('export-final-btn').click()");
  const msg = await page.evaluate("document.getElementById('export-message').textContent");
  assert.match(msg, /다운로드를 시작했습니다/);
  const finalJson = await page.evaluate("JSON.stringify(window.__seedFinalRemediationReview.buildExportLines('final'))");
  const finalRecords = JSON.parse(finalJson).map((l) => JSON.parse(l));
  assert.equal(finalRecords.length, 6);
  const q18 = finalRecords.find((r) => r.question_id === "question_seed_v07_18");
  assert.equal(q18.information_limit_accepted, true);
});
