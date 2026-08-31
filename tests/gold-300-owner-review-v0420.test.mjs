// Turn N4.20 (corrected): regression coverage for the Gold-300 Authoring
// Owner review UI. Runs the real builders (selection -> packets -> owner
// review UI) against real, read-only v0.3 data, then drives the real
// HTML/JS in a real headless Chrome page via tests/lib/headless-chrome-cdp.mjs
// (the same harness every other Owner-review UI test in this repo uses).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import test from "node:test";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";
import { buildGold300Selection } from "../scripts/build-gold-300-selection-v0420.mjs";
import { buildGold300AuthoringPackets } from "../scripts/build-gold-300-authoring-packets-v0420.mjs";
import { buildGold300OwnerReview } from "../scripts/build-gold-300-owner-review-v0420.mjs";

let HTML_PATH;
let UI_DATA;

test.before(() => {
  buildGold300Selection();
  buildGold300AuthoringPackets();
  const result = buildGold300OwnerReview();
  HTML_PATH = result.htmlPath;
  UI_DATA = result.uiData;
});

test("static: the build never generates or reveals any actual question/expected_answer content in the HTML source", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.doesNotMatch(html, /"question":\s*"[^n]/, "the embedded review-data JSON must never carry a real question string");
  assert.doesNotMatch(html, /expected_answer/, "the UI must never embed expected_answer content");
});

test("static scan: no external resource pattern, no innerHTML, exactly 2 script tags, valid doctype", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//, "no external resource URL");
  assert.doesNotMatch(html, /innerHTML/);
  const scriptTagCount = (html.match(/<script/g) || []).length;
  assert.equal(scriptTagCount, 2); // the embedded JSON data script + the logic script
});

test("headless: UI starts with no choice selected, checklist hidden, and both buttons locked", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const state = await page.evaluate(`(function () {
    return {
      anyChecked: !!document.querySelector('input[name="ownerChoice"]:checked'),
      checklistHidden: document.getElementById("approveChecklist").hidden,
      downloadDisabled: document.getElementById("downloadBtn").disabled,
      copyDisabled: document.getElementById("copyBtn").disabled,
    };
  })()`);
  assert.equal(state.anyChecked, false);
  assert.equal(state.checklistHidden, true);
  assert.equal(state.downloadDisabled, true);
  assert.equal(state.copyDisabled, true);
});

test("headless: selecting APPROVE with a partially-checked checklist keeps the download button locked", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const downloadDisabled = await page.evaluate(`(function () {
    document.querySelector('input[value="${UI_DATA.approve_disposition}"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    for (var i = 0; i < boxes.length - 1; i++) { boxes[i].checked = true; boxes[i].dispatchEvent(new Event("change")); }
    return document.getElementById("downloadBtn").disabled;
  })()`);
  assert.equal(downloadDisabled, true);
});

test("headless: checking every checklist item plus Owner name enables APPROVE download; the real downloaded JSON parses and matches the real SHA/count pins", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const enabled = await page.evaluate(`(function () {
    document.querySelector('input[value="${UI_DATA.approve_disposition}"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    boxes.forEach(function (b) { b.checked = true; b.dispatchEvent(new Event("change")); });
    return !document.getElementById("downloadBtn").disabled;
  })()`);
  assert.equal(enabled, true);

  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));

  assert.equal(decision.owner, "Test Owner");
  assert.equal(decision.owner_disposition, UI_DATA.approve_disposition);
  assert.equal(decision.gold_authoring_authorized, true);
  assert.equal(decision.authorized_scope, "GOLD_300_AUTHOR_A_150_AUTHOR_B_150");
  assert.equal(decision.total_gold_count, 300);
  assert.equal(decision.author_a_count, 150);
  assert.equal(decision.author_b_count, 150);
  assert.equal(decision.existing_anchor_count, 150);
  assert.equal(decision.expansion_count, 150);
  assert.equal(decision.author_a_anchor_count, 75);
  assert.equal(decision.author_a_expansion_count, 75);
  assert.equal(decision.author_b_anchor_count, 75);
  assert.equal(decision.author_b_expansion_count, 75);
  assert.equal(decision.packet_a_sha256, UI_DATA.packet_a_sha256);
  assert.equal(decision.packet_b_sha256, UI_DATA.packet_b_sha256);
  assert.equal(decision.official_split_decision_id, UI_DATA.official_split_decision_id);
  assert.equal(decision.checklist.length, UI_DATA.checklist_items.length);
  assert.ok(decision.checklist.every((c) => c.checked === true));
});

test("headless: even a genuine APPROVE never sets HOLDOUT/Phase2/production/relation/ranking authorization -- all stay false", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  await page.evaluate(`(function () {
    document.querySelector('input[value="${UI_DATA.approve_disposition}"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    document.querySelectorAll('#approveChecklist input[type=checkbox]').forEach(function (b) { b.checked = true; b.dispatchEvent(new Event("change")); });
  })()`);
  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));

  assert.equal(decision.holdout_access_authorized, false);
  assert.equal(decision.holdout_evaluation_authorized, false);
  assert.equal(decision.phase2_authoring_authorized, false);
  assert.equal(decision.production_wiring_authorized, false);
  assert.equal(decision.actual_official_promotion_applied, false);
  assert.equal(decision.relation_decisions_authorized, false);
  assert.equal(decision.agent_ranking_authorized, false);
});

test("headless: FIX_REQUIRED requires a non-empty owner_note before the download unlocks, and the exported record's disposition/note update accordingly", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const disabledWithoutNote = await page.evaluate(`(function () {
    document.querySelector('input[value="FIX_REQUIRED"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    return document.getElementById("downloadBtn").disabled;
  })()`);
  assert.equal(disabledWithoutNote, true);

  const enabledWithNote = await page.evaluate(`(function () {
    document.getElementById("ownerNote").value = "eligibility distribution needs another look";
    document.getElementById("ownerNote").dispatchEvent(new Event("input"));
    return !document.getElementById("downloadBtn").disabled;
  })()`);
  assert.equal(enabledWithNote, true);

  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));
  assert.equal(decision.owner_disposition, "FIX_REQUIRED");
  assert.equal(decision.owner_note, "eligibility distribution needs another look");
  assert.equal(decision.gold_authoring_authorized, false);
  assert.equal(decision.authorized_scope, "NONE");
});

test("headless: REJECT_GOLD_300_PLAN also requires a non-empty owner_note, and never authorizes anything", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  await page.evaluate(`(function () {
    document.querySelector('input[value="REJECT_GOLD_300_PLAN"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    document.getElementById("ownerNote").value = "selection needs rework";
    document.getElementById("ownerNote").dispatchEvent(new Event("input"));
  })()`);
  const enabled = await page.evaluate(`!document.getElementById("downloadBtn").disabled`);
  assert.equal(enabled, true);

  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));
  assert.equal(decision.owner_disposition, "REJECT_GOLD_300_PLAN");
  assert.equal(decision.gold_authoring_authorized, false);
});

test("headless: the download never landed in the OS default Downloads folder, and after page.close() the Chrome process/profile/downloadDir are fully cleaned up", async () => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  await page.evaluate(`(function () {
    document.querySelector('input[value="${UI_DATA.approve_disposition}"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    document.querySelectorAll('#approveChecklist input[type=checkbox]').forEach(function (b) { b.checked = true; b.dispatchEvent(new Event("change")); });
  })()`);
  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  assert.equal(downloadedFile.path.includes(page.downloadDir), true);
  assert.equal(downloadedFile.path.includes("/Downloads/"), false);

  const { debugPort, userDataDir, downloadDir } = page;
  await page.close();

  await assert.rejects(fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(stat(userDataDir), (err) => err.code === "ENOENT");
  await assert.rejects(stat(downloadDir), (err) => err.code === "ENOENT");
});
