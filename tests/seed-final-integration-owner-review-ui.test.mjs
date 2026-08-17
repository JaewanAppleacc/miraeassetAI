// Turn M9: verifies the offline Turn M8 final-integration Owner review
// UI -- both statically (HTML text / embedded JSON structure) and via a
// real headless Chrome instance (rendering + click-driven state
// transitions + export gating), per this Turn's explicit "실제 headless
// browser로 file:// 렌더링을 확인해" requirement.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { escapeForScriptEmbedding } from "../scripts/build-seed-final-integration-owner-review-ui.mjs";
import { launchHeadlessChromePage } from "./lib/headless-chrome-cdp.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "work/handoff/seed-final-response-owner-review/ui/final-integration-v0.1");
const HTML_PATH = path.join(OUT_DIR, "seed-v020-final-integration-owner-review.html");
const REPORT_PATH = path.join(OUT_DIR, "final-integration-review-ui-build-report.json");

const TARGET_QUESTION_IDS = [
  "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17",
  "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
];

const PINNED_INPUTS = [
  "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-integration-packet.v0.1.json",
  "work/handoff/seed-final-response-owner-review/results/seed-response-turn-m8-wire-diff-analysis.v0.1.json",
  "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl",
  "work/domain-seed/seed-facts-verified.v0.8.jsonl",
  "work/domain-seed/seed-fact-coverage-verified.v0.7.json",
  "work/domain-seed/seed-structured-owner-decision.v0.10.jsonl",
  "work/handoff/seed-final-response-owner-review/results/seed-response-q18-owner-policy-decision.v0.1.json",
  "domain/releases/bundles/seed-release-v0.20-r2.candidate/bundle-manifest.json",
  "domain/releases/seed-release.v0.20-r2.candidate.manifest.json",
  "domain/releases/seed-release.v0.20-r2.candidate.owner-decision-template.json",
  "domain/releases/seed-release.v0.20-r2.candidate.RELEASE_GATE_STATUS.json",
];

const EXISTING_UI_DIRS = [
  "work/handoff/seed-final-response-owner-review/ui/v0.1",
  "work/handoff/seed-final-response-owner-review/ui/v0.2",
  "work/handoff/seed-final-response-owner-review/ui/v0.3",
  "work/handoff/seed-final-response-owner-review/ui/v0.4",
  "work/handoff/seed-final-response-owner-review/ui/ontology-proposals-v0.1",
  "work/handoff/seed-final-response-owner-review/ui/ontology-proposals-v0.2",
  "work/handoff/seed-final-response-owner-review/ui/data-candidates-v0.1",
  "work/handoff/seed-final-response-owner-review/ui/data-candidates-v0.2",
  "work/handoff/seed-final-response-owner-review/ui/final-candidates-v0.1",
];

const SPECIFIC_CHECKLIST_COUNTS = {
  question_seed_v07_06: 5, question_seed_v07_09: 7, question_seed_v07_17: 6,
  question_seed_v07_18: 7, question_seed_v07_20: 6, question_seed_v07_25: 6,
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function hashDirFiles(relDir) {
  const abs = path.join(ROOT, relDir);
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const out = {};
  for (const entry of entries) {
    if (entry.isFile()) out[entry.name] = sha256(await readFile(path.join(abs, entry.name)));
  }
  return out;
}

let pinnedBefore; let pinnedAfter;
let existingUiBefore; let existingUiAfter;
let htmlText; let payload; let report;

test.before(async () => {
  pinnedBefore = {};
  for (const rel of PINNED_INPUTS) pinnedBefore[rel] = sha256(await readFile(path.join(ROOT, rel)));
  existingUiBefore = {};
  for (const dir of EXISTING_UI_DIRS) existingUiBefore[dir] = await hashDirFiles(dir);

  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-seed-final-integration-owner-review-ui.mjs")], { cwd: ROOT });

  pinnedAfter = {};
  for (const rel of PINNED_INPUTS) pinnedAfter[rel] = sha256(await readFile(path.join(ROOT, rel)));
  existingUiAfter = {};
  for (const dir of EXISTING_UI_DIRS) existingUiAfter[dir] = await hashDirFiles(dir);

  htmlText = await readFile(HTML_PATH, "utf8");
  report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
  const match = htmlText.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "embedded review-data script tag must exist");
  payload = JSON.parse(match[1]);
});

// ---- 8. integrity: pinned inputs / existing UI+packet files unchanged ----

test("every pinned input file is byte-identical before and after the build", () => {
  for (const rel of PINNED_INPUTS) assert.equal(pinnedAfter[rel], pinnedBefore[rel], `${rel} changed during build`);
});

test("no existing review UI file (v0.1-v0.4, ontology/data/final-candidates) was modified by this build", () => {
  for (const dir of EXISTING_UI_DIRS) {
    assert.deepEqual(existingUiAfter[dir], existingUiBefore[dir], `${dir} changed during build`);
  }
});

test("build report's output_html_sha256 matches the real generated file", async () => {
  const htmlBytes = await readFile(HTML_PATH);
  assert.equal(sha256(htmlBytes), report.output_html_sha256);
  assert.equal(report.final_export_filename, "seed-v020-final-integration-owner-decision.v0.1.jsonl");
  assert.equal(report.localstorage_key, `seed-v020-final-integration-review::${payload.integration_packet_sha256}`);
});

// ---- 1. target scope: exactly 6, no dup, no missing ----

test("embedded payload contains exactly the 6 target questions, no duplicates, no extras", () => {
  assert.equal(payload.records.length, 6);
  const ids = payload.records.map((r) => r.question_id);
  assert.equal(new Set(ids).size, 6);
  assert.deepEqual([...ids].sort(), [...TARGET_QUESTION_IDS].sort());
});

// ---- static HTML safety ----

test("no external URL / CDN / network-loading pattern anywhere in the HTML", () => {
  for (const pattern of [/<script[^>]+src=/i, /\bfetch\s*\(/, /XMLHttpRequest/, /cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com/i, /https?:\/\//]) {
    assert.equal(pattern.test(htmlText), false, `forbidden pattern matched: ${pattern}`);
  }
});

test("no innerHTML assignment anywhere in the client script", () => {
  const scriptMatch = htmlText.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(scriptMatch);
  assert.equal(/\.innerHTML\s*=/.test(scriptMatch[1]), false);
});

test("embedded JSON escaping: escapeForScriptEmbedding neutralizes a synthetic </script> / <!-- payload (self-check, no real literal)", () => {
  const adversarial = JSON.stringify({ note: "</script><script>alert(1)</script><!-- injected -->" });
  const escaped = escapeForScriptEmbedding(adversarial);
  assert.equal(escaped.includes("</script>"), false);
  assert.equal(escaped.includes("<!--"), false);
  assert.deepEqual(JSON.parse(escaped), JSON.parse(adversarial), "escaping must round-trip through JSON.parse unchanged");
});

test("the actual embedded review-data script tag contains no literal </script> or <!-- boundary", () => {
  const scriptOpenCount = (htmlText.match(/<script/g) || []).length;
  const scriptCloseCount = (htmlText.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpenCount, 2);
  assert.equal(scriptCloseCount, 2);
});

// ---- checklists ----

test("every question's specific checklist exists with the exact item count from Turn M9 Section 4", () => {
  for (const record of payload.records) {
    const expected = SPECIFIC_CHECKLIST_COUNTS[record.question_id];
    assert.equal(record.specific_checklist.length, expected, `${record.question_id} specific checklist count`);
  }
});

test("Q18's specific checklist includes the exact 발행총액/기타자금 items verbatim", () => {
  const q18 = payload.records.find((r) => r.question_id === "question_seed_v07_18");
  assert.ok(q18.specific_checklist.includes("발행총액은 원문 직접 공시 항목으로 확인되지 않는다고 표시됐는가"));
  assert.ok(q18.specific_checklist.includes("2,198,873,250원을 발행총액이라고 주장하지 않는가"));
  assert.ok(q18.specific_checklist.includes("'기타자금'을 발행총액으로 재명명하지 않았는가"));
});

test("common checklist has exactly the 6 items from Section 4", () => {
  assert.equal(payload.common_checklist.length, 6);
  assert.ok(payload.common_checklist.includes("내부 enum/snake_case/corp_code가 없는가"));
});

test("Q18's r13 answer text (embedded) already states the information-limit sentence and never claims 2,198,873,250 as 발행총액 in narrative", () => {
  const q18 = payload.records.find((r) => r.question_id === "question_seed_v07_18");
  assert.ok(q18.r13_answer.includes("발행총액은 원문에서 직접 공시된 항목으로 확인되지 않습니다"));
  const narrative = q18.r13_answer.split("근거 공시:")[0];
  assert.doesNotMatch(narrative, /2,198,873,250\s*원(은|이)?\s*발행총액/);
});

// ---- headless Chrome: initial render ----

let page;
let initialCardCount; let initialProgress; let initialDispositionBadges; let initialAnswerText;
let q18BeforeGate; let q18AfterProperApprove; let q18DispositionAfterBlockedAttempt;
let progressAfterOneApprove; let finalExportBlockedMessage;
let finalRecords; let draftRecords; let resetProgress; let localStorageKeysBeforeReset;

test.before(async () => {
  page = await launchHeadlessChromePage({ url: `file://${HTML_PATH}` });

  initialCardCount = await page.evaluate("document.querySelectorAll('.card').length");
  initialProgress = await page.evaluate("document.getElementById('progress-counter').textContent");
  initialDispositionBadges = await page.evaluate(
    "Array.from(document.querySelectorAll('[data-role=badge-disposition]')).map(function(e){return e.textContent;})",
  );
  initialAnswerText = await page.evaluate(
    "document.querySelector('[data-question-id=question_seed_v07_06] .answer-box').textContent",
  );

  // Q18 gate: blocked attempt without checking the box
  await page.evaluate("document.querySelector('button[data-action=APPROVE_RESPONSE][data-question-id=question_seed_v07_18]').click()");
  q18DispositionAfterBlockedAttempt = await page.evaluate(
    "window.__seedFinalIntegrationReview.getState()['question_seed_v07_18'].owner_disposition",
  );
  q18BeforeGate = await page.evaluate(
    "JSON.stringify(window.__seedFinalIntegrationReview.getState()['question_seed_v07_18'])",
  );

  // check the box, approve properly
  await page.evaluate("document.getElementById('info-limit-accepted-question_seed_v07_18').click()");
  await page.evaluate("document.querySelector('button[data-action=APPROVE_RESPONSE][data-question-id=question_seed_v07_18]').click()");
  q18AfterProperApprove = await page.evaluate(
    "JSON.stringify(window.__seedFinalIntegrationReview.getState()['question_seed_v07_18'])",
  );
  progressAfterOneApprove = await page.evaluate("document.getElementById('progress-counter').textContent");

  // FINAL export must be fail-closed at 1/6
  finalExportBlockedMessage = await page.evaluate(
    "(function(){ try { window.__seedFinalIntegrationReview.buildExportLines('final'); return 'NO_THROW'; } catch(e) { return e.message; } })()",
  );

  // Draft export must always work, even partial
  const draftLinesJson = await page.evaluate("JSON.stringify(window.__seedFinalIntegrationReview.buildExportLines('draft'))");
  draftRecords = JSON.parse(draftLinesJson).map((l) => JSON.parse(l));

  // judge the remaining 5 questions with a mix of dispositions
  const remaining = ["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_20", "question_seed_v07_25"];
  const dispositions = ["APPROVE_RESPONSE", "FIX_REQUIRED", "REJECT", "APPROVE_RESPONSE", "APPROVE_RESPONSE"];
  for (let i = 0; i < remaining.length; i++) {
    await page.evaluate(`document.querySelector('button[data-action=${dispositions[i]}][data-question-id=${remaining[i]}]').click()`);
  }
  const progressAfterAll = await page.evaluate("document.getElementById('progress-counter').textContent");
  assert.equal(progressAfterAll, "6/6");

  const finalLinesJson = await page.evaluate("JSON.stringify(window.__seedFinalIntegrationReview.buildExportLines('final'))");
  finalRecords = JSON.parse(finalLinesJson).map((l) => JSON.parse(l));

  const localStorageKeysJson = await page.evaluate("JSON.stringify(Object.keys(window.localStorage))");
  localStorageKeysBeforeReset = JSON.parse(localStorageKeysJson);

  // reset flow (confirm() auto-accepted by the CDP helper)
  await page.evaluate("document.getElementById('reset-btn').click()");
  await new Promise((r) => setTimeout(r, 200));
  resetProgress = await page.evaluate("document.getElementById('progress-counter').textContent");
});

test.after(async () => { if (page) await page.close(); });

test("headless render: exactly 6 cards", () => { assert.equal(initialCardCount, 6); });
test("headless render: progress starts at 0/6", () => { assert.equal(initialProgress, "0/6"); });
test("headless render: all 6 disposition badges start as PENDING", () => {
  assert.equal(initialDispositionBadges.length, 6);
  assert.ok(initialDispositionBadges.every((b) => b === "PENDING"));
});
test("headless render: the r13 answer text is actually shown for Q06", () => {
  const q06 = payload.records.find((r) => r.question_id === "question_seed_v07_06");
  assert.equal(initialAnswerText, q06.r13_answer);
});

test("Q18 information_limit_accepted gate: APPROVE_RESPONSE is blocked before the checkbox is checked", () => {
  assert.equal(q18DispositionAfterBlockedAttempt, "PENDING");
  const parsed = JSON.parse(q18BeforeGate);
  assert.equal(parsed.reviewer, null);
  assert.equal(parsed.reviewed_at, null);
});

test("Q18 information_limit_accepted gate: succeeds once the checkbox is checked, and records information_limit_accepted:true", () => {
  const parsed = JSON.parse(q18AfterProperApprove);
  assert.equal(parsed.owner_disposition, "APPROVE_RESPONSE");
  assert.equal(parsed.information_limit_accepted, true);
  assert.equal(parsed.reviewer, "최재완");
  assert.ok(parsed.reviewed_at && !Number.isNaN(Date.parse(parsed.reviewed_at)));
});

test("progress updates to 1/6 after a single real click", () => { assert.equal(progressAfterOneApprove, "1/6"); });

test("FINAL export is fail-closed at the function level when fewer than 6 are judged (not just UI-disabled)", () => {
  assert.match(finalExportBlockedMessage, /requires all 6 questions to be judged/);
});

test("Draft export works at any time and returns all 6 records regardless of PENDING status", () => {
  assert.equal(draftRecords.length, 6);
  assert.equal(new Set(draftRecords.map((r) => r.question_id)).size, 6);
});

test("Draft export records carry the minimum required FINAL-record fields", () => {
  for (const r of draftRecords) {
    for (const field of ["review_item_id", "question_id", "integration_packet_path", "integration_packet_sha256", "r13_response_sha256", "owner_disposition", "reviewer", "reviewed_at", "notes", "checklist_results", "information_limit_accepted", "release_recommendation"]) {
      assert.ok(Object.hasOwn(r, field), `draft record missing field ${field}`);
    }
  }
});

test("FINAL export succeeds once all 6 are judged, producing exactly 6 records with no PENDING left", () => {
  assert.equal(finalRecords.length, 6);
  assert.ok(finalRecords.every((r) => r.owner_disposition !== "PENDING"));
  assert.equal(new Set(finalRecords.map((r) => r.question_id)).size, 6);
});

test("FINAL export's Q18 record has information_limit_accepted:true because it was APPROVE_RESPONSE", () => {
  const q18 = finalRecords.find((r) => r.question_id === "question_seed_v07_18");
  assert.equal(q18.owner_disposition, "APPROVE_RESPONSE");
  assert.equal(q18.information_limit_accepted, true);
});

test("FINAL export never auto-approves: dispositions reflect exactly what was clicked, including FIX_REQUIRED and REJECT", () => {
  const byId = Object.fromEntries(finalRecords.map((r) => [r.question_id, r.owner_disposition]));
  assert.equal(byId.question_seed_v07_06, "APPROVE_RESPONSE");
  assert.equal(byId.question_seed_v07_09, "FIX_REQUIRED");
  assert.equal(byId.question_seed_v07_17, "REJECT");
  assert.equal(byId.question_seed_v07_20, "APPROVE_RESPONSE");
  assert.equal(byId.question_seed_v07_25, "APPROVE_RESPONSE");
});

test("localStorage key includes the integration packet SHA-256 (namespace)", () => {
  assert.ok(localStorageKeysBeforeReset.some((k) => k.includes(payload.integration_packet_sha256)));
});

test("reset button (with confirm() accepted) clears state back to 0/6", () => { assert.equal(resetProgress, "0/6"); });
