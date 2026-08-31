// Turn N4.20.1: regression coverage for the corrected Gold-300 Owner
// review UI (v0.2), which separates plan approval from row-level
// authoring authorization. Runs the real builder chain (N4.20 selection
// -> N4.20.1 reverification -> v0.1 supersede -> v0.2 UI) against real,
// read-only data, then drives the real HTML/JS in a real headless Chrome
// page via tests/lib/headless-chrome-cdp.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import test from "node:test";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";
import { buildGold300PlanReverification } from "../scripts/build-gold-300-plan-reverification-v04201.mjs";
import { buildGold300V01UiSupersede } from "../scripts/build-gold-300-v01-ui-supersede-v04201.mjs";
import { buildGold300OwnerReviewV02 } from "../scripts/build-gold-300-owner-review-v0.2-v04201.mjs";

let HTML_PATH;
let UI_DATA;

test.before(() => {
  buildGold300PlanReverification();
  buildGold300V01UiSupersede();
  const result = buildGold300OwnerReviewV02();
  HTML_PATH = result.htmlPath;
  UI_DATA = result.uiData;
});

test("static: no actual question/expected_answer content is embedded", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.doesNotMatch(html, /expected_answer/);
  assert.doesNotMatch(html, /"question":\s*"[^n]/);
});

test("static scan: valid doctype, no external resource pattern, no innerHTML, exactly 2 script tags", () => {
  const html = readFileSync(HTML_PATH, "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /innerHTML/);
  assert.equal((html.match(/<script/g) || []).length, 2);
});

test("headless: UI starts with no choice selected, checklist hidden, both buttons locked", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });
  const state = await page.evaluate(`(function () {
    return {
      anyChecked: !!document.querySelector('input[name="ownerChoice"]:checked'),
      checklistHidden: document.getElementById("approveChecklist").hidden,
      downloadDisabled: document.getElementById("downloadBtn").disabled,
    };
  })()`);
  assert.equal(state.anyChecked, false);
  assert.equal(state.checklistHidden, true);
  assert.equal(state.downloadDisabled, true);
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

test("headless: full checklist + owner name unlocks download; the real downloaded JSON matches schema/counts/SHA exactly, and gold_300_plan_authorized/eligible_authoring_authorized/holdout_authoring_authorized are true while every other authorization field is false", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  await page.evaluate(`(function () {
    document.querySelector('input[value="${UI_DATA.approve_disposition}"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    document.querySelectorAll('#approveChecklist input[type=checkbox]').forEach(function (b) { b.checked = true; b.dispatchEvent(new Event("change")); });
  })()`);
  const enabled = await page.evaluate(`!document.getElementById("downloadBtn").disabled`);
  assert.equal(enabled, true);

  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));

  assert.equal(decision.schema_version, "0.2.0");
  assert.equal(decision.owner, "Test Owner");
  assert.equal(decision.owner_disposition, UI_DATA.approve_disposition);
  assert.equal(decision.total_plan_count, 300);
  assert.equal(decision.author_a_assigned_count, 150);
  assert.equal(decision.author_b_assigned_count, 150);
  assert.equal(decision.immediately_authorizable_count, UI_DATA.immediately_authorizable_count);
  assert.equal(decision.manual_review_required_count, UI_DATA.manual_review_required_count);
  assert.equal(decision.blocked_count, UI_DATA.blocked_count);
  assert.equal(decision.author_a_immediately_authorizable_count, UI_DATA.author_a_immediately_authorizable_count);
  assert.equal(decision.author_b_immediately_authorizable_count, UI_DATA.author_b_immediately_authorizable_count);
  assert.equal(decision.author_a_blocked_count, UI_DATA.author_a_blocked_count);
  assert.equal(decision.author_b_blocked_count, UI_DATA.author_b_blocked_count);
  assert.equal(decision.packet_a_sha256, UI_DATA.packet_a_sha256);
  assert.equal(decision.packet_b_sha256, UI_DATA.packet_b_sha256);

  assert.equal(decision.gold_300_plan_authorized, true);
  assert.equal(decision.eligible_authoring_authorized, true);
  assert.equal(decision.holdout_authoring_authorized, true);

  assert.equal(decision.blocked_authoring_authorized, false);
  assert.equal(decision.holdout_agent_access_authorized, false);
  assert.equal(decision.holdout_evaluation_authorized, false);
  assert.equal(decision.production_wiring_authorized, false);
  assert.equal(decision.agent_ranking_authorized, false);
  assert.equal(decision.relation_decisions_authorized, false);
  assert.equal(decision.actual_official_promotion_applied, false);

  assert.equal(decision.checklist.length, UI_DATA.checklist_items.length);
  assert.ok(decision.checklist.every((c) => c.checked === true));

  // no deprecated ambiguous field ever appears in the real exported record
  for (const deprecated of ["gold_authoring_authorized", "authorized_scope", "holdout_access_authorized", "phase2_authoring_authorized"]) {
    assert.equal(deprecated in decision, false, `${deprecated} must not appear in the v0.2 decision`);
  }
});

test("headless: expansion rows are not silently excluded from the approved plan -- the downloaded decision's assigned counts (150/150) include both Anchor and Expansion role rows", async (t) => {
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
  // 150 = 75 Anchor + 75 Expansion per author; if Expansion were dropped, this would be 75, not 150
  assert.equal(decision.author_a_assigned_count, 150);
  assert.equal(decision.author_b_assigned_count, 150);
});

test("headless: FIX_REQUIRED requires a non-empty owner_note; the exported record's disposition/note update accordingly and no authorization field is true", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });

  const disabledWithoutNote = await page.evaluate(`(function () {
    document.querySelector('input[value="FIX_REQUIRED"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    return document.getElementById("downloadBtn").disabled;
  })()`);
  assert.equal(disabledWithoutNote, true);

  await page.evaluate(`(function () {
    document.getElementById("ownerNote").value = "counts need re-check";
    document.getElementById("ownerNote").dispatchEvent(new Event("input"));
  })()`);
  const enabled = await page.evaluate(`!document.getElementById("downloadBtn").disabled`);
  assert.equal(enabled, true);

  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));
  assert.equal(decision.owner_disposition, "FIX_REQUIRED");
  assert.equal(decision.owner_note, "counts need re-check");
  assert.equal(decision.gold_300_plan_authorized, false);
  assert.equal(decision.eligible_authoring_authorized, false);
  assert.equal(decision.holdout_authoring_authorized, false);
});

test("headless: REJECT_GOLD_300_PLAN also requires a non-empty owner_note and authorizes nothing", async (t) => {
  const page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });
  t.after(async () => { await page.close(); });
  await page.evaluate(`(function () {
    document.querySelector('input[value="REJECT_GOLD_300_PLAN"]').click();
    document.getElementById("ownerName").value = "Test Owner";
    document.getElementById("ownerName").dispatchEvent(new Event("input"));
    document.getElementById("ownerNote").value = "plan rework needed";
    document.getElementById("ownerNote").dispatchEvent(new Event("input"));
  })()`);
  const enabled = await page.evaluate(`!document.getElementById("downloadBtn").disabled`);
  assert.equal(enabled, true);
  await page.evaluate(`document.getElementById("downloadBtn").click();`);
  const downloadedFile = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const decision = JSON.parse(readFileSync(downloadedFile.path, "utf8"));
  assert.equal(decision.owner_disposition, "REJECT_GOLD_300_PLAN");
  assert.equal(decision.gold_300_plan_authorized, false);
});

test("headless: the download never landed in the OS default Downloads folder, and after page.close() Chrome's CDP port/userDataDir/downloadDir are fully cleaned up", async () => {
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
