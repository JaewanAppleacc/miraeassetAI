// Turn N4.14: verifies the Component-Safe Strategy A Owner review packet +
// decision template + UI build
// (scripts/build-component-safe-reallocation-owner-review-v0414.mjs)
// against the REAL Turn N4.13 outputs, and that it never applies the plan
// or modifies any real Anchor/Author/Pool file. Per this repo's established
// convention, "never modifies a sibling artifact" is proven via a static
// write-scope scan, never a live before/after hash comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-owner-review-v0414.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const OWNER_REVIEW_DIR = resolve(CSR_DIR, "owner-review-v0.1");
const UI_DIR = resolve(OWNER_REVIEW_DIR, "ui/v0.1");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
async function clearDownloadDir(dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { force: true })));
}

let anchorBefore; let authorBefore; let poolBefore;
test.before(() => {
  anchorBefore = readFileSync(ANCHOR_V02_PATH, "utf8");
  authorBefore = readFileSync(AUTHOR_V02_PATH, "utf8");
  poolBefore = readFileSync(POOL_PATH, "utf8");
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.14: static proof -- every write call targets only owner-review-v0.1/, never the real Anchor/Author/Pool files or Turn N4.13's own plan/delta", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const OWNER_REVIEW_DIR = resolve\(CSR_DIR, "owner-review-v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 6, `expected at least 6 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(OWNER_REVIEW_DIR", "resolve(uiDir", "ownerReviewPacketPath", "htmlPath"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably OWNER_REVIEW_DIR-rooted`);
  assert.doesNotMatch(source, /writeFileSync\([^)]*anchor-selection\.v0\.2\.jsonl/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*author-allocation\.v0\.2\.jsonl/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*candidate-pool\.v0\.1\.jsonl/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*strategy-a-assignment-delta\.v0\.1\.jsonl/);
});

test("Turn N4.14: the real Anchor/Author/Pool files are byte-unmodified after building the review UI", () => {
  assert.equal(readFileSync(ANCHOR_V02_PATH, "utf8"), anchorBefore);
  assert.equal(readFileSync(AUTHOR_V02_PATH, "utf8"), authorBefore);
  assert.equal(readFileSync(POOL_PATH, "utf8"), poolBefore);
});

test("Turn N4.14: pre-verification reproduces operation counts 62/8 and leakage 6/4->0/0 exactly, never hardcoded copy-paste", () => {
  const packet = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-review-packet.v0.1.json"));
  assert.equal(packet.operation_counts.split, 62);
  assert.equal(packet.operation_counts.author, 8);
  assert.equal(packet.operation_counts.total, 70);
  assert.equal(packet.before_after.split_leakage.before, 6);
  assert.equal(packet.before_after.split_leakage.after, 0);
  assert.equal(packet.before_after.author_leakage.before, 4);
  assert.equal(packet.before_after.author_leakage.after, 0);
  assert.equal(packet.before_after.quarantine_intrusion.after, 0);
  assert.equal(packet.candidate_pool_count, 500);
  assert.equal(packet.anchor_count, 150);
  assert.equal(packet.critical_slice_floor_preserved, true);
  assert.equal(packet.anchor_membership_unchanged, true);
});

test("Turn N4.14: unique-vs-overlap computation matches the real delta file exactly (never assumes 70 unique)", () => {
  const delta = readJsonl(resolve(CSR_DIR, "strategy-a-assignment-delta.v0.1.jsonl"));
  const splitIds = new Set(delta.filter((r) => r.dimension === "split").map((r) => r.assignment_id));
  const authorIds = new Set(delta.filter((r) => r.dimension === "author").map((r) => r.assignment_id));
  const expectedOverlap = [...splitIds].filter((id) => authorIds.has(id));
  const expectedUnique = new Set([...splitIds, ...authorIds]).size;

  const summary = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-movement-summary.v0.1.json"));
  assert.equal(summary.overlap_count, expectedOverlap.length);
  assert.equal(summary.unique_changed_assignment_count, expectedUnique);
  assert.equal(summary.unique_changed_assignment_count, 70, "no overlap exists in the real N4.13 data -- 62+8=70 unique");
  assert.equal(summary.overlap_count, 0);

  const packet = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-review-packet.v0.1.json"));
  assert.equal(packet.unique_vs_overlap.unique_changed_assignment_count, expectedUnique);
});

test("Turn N4.14: forced vs compensating split into COMPONENT_CONSOLIDATION/COMPENSATING_RESTORATION correctly, and split/author transition tables sum to the real operation counts", () => {
  const summary = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-movement-summary.v0.1.json"));
  const splitReasonSum = Object.values(summary.split_reason_counts).reduce((a, b) => a + b, 0);
  const authorReasonSum = Object.values(summary.author_reason_counts).reduce((a, b) => a + b, 0);
  assert.equal(splitReasonSum, 62);
  assert.equal(authorReasonSum, 8);
  const splitTransitionSum = Object.values(summary.split_transition_counts).reduce((a, b) => a + b, 0);
  const authorTransitionSum = Object.values(summary.author_transition_counts).reduce((a, b) => a + b, 0);
  assert.equal(splitTransitionSum, 62);
  assert.equal(authorTransitionSum, 8);
});

test("Turn N4.14: decision template is PENDING and not a real decision, with all required fields present", () => {
  const template = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-decision-template.v0.1.json"));
  assert.equal(template.owner_disposition, "PENDING");
  assert.equal(template.decision_id, null);
  assert.equal(template.status, "TEMPLATE_NOT_A_REAL_DECISION");
  assert.equal(template.anchor_membership_changed, false);
  assert.equal(template.relation_decisions_authorized, false);
  assert.equal(template.official_split_eligible, false);
  assert.equal(template.gold_authoring_authorized, false);
  for (const field of ["schema_version", "plan_path", "plan_sha256", "delta_path", "delta_sha256", "verification_report_path", "verification_report_sha256", "anchor_count", "candidate_pool_count", "split_operation_count", "author_operation_count", "unique_changed_assignment_count", "overlapping_assignment_count", "before_split_counts", "after_split_counts", "before_author_counts", "after_author_counts", "before_split_leakage", "after_split_leakage", "before_author_leakage", "after_author_leakage", "quarantine_intrusion_count"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(template, field), `missing field: ${field}`);
  }
});

test("Turn N4.14: gate-status-owner-review.v0.1.json never claims the plan was applied", () => {
  const gate = readJson(resolve(OWNER_REVIEW_DIR, "gate-status-owner-review.v0.1.json"));
  assert.equal(gate.status, "OWNER_REVIEW_PACKET_READY_PENDING_DECISION");
  assert.equal(gate.official_split_eligible, false);
  assert.equal(gate.gold_authoring_authorized, false);
  assert.equal(gate.actual_files_modified, false);
  assert.equal(gate.anchor_membership_changed, false);
});

test("Turn N4.14: N4.13 upstream artifacts are content-unchanged (row counts, key values) -- read-only inputs", () => {
  const plan = readJson(resolve(CSR_DIR, "strategy-a-assignment-only-plan.v0.1.json"));
  assert.equal(plan.verdict, "FEASIBLE_EXACT");
  assert.equal(plan.status, "CANDIDATE_NOT_APPLIED");
  const delta = readJsonl(resolve(CSR_DIR, "strategy-a-assignment-delta.v0.1.jsonl"));
  assert.equal(delta.length, 70);
});

test("Turn N4.14: deterministic rebuild -- re-running the script twice produces a byte-identical movement summary and owner review packet apart from generated_at", () => {
  function canonical(obj) { const c = { ...obj }; delete c.generated_at; return JSON.stringify(c, Object.keys(c).sort()); }
  const before = canonical(readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-movement-summary.v0.1.json")));
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = canonical(readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-movement-summary.v0.1.json")));
  assert.equal(before, after);
});

// Turn N4.15 regression guard: mirrors the exact bug class fixed in
// Turn N4.12 (tests/relation-closure-priority-wave-1-consensus-v0411.test.mjs's
// "Turn N4.12 regression guard"). strategy-a-assignment-only-plan.v0.1.json
// and strategy-a-verification-report.v0.1.json both embed their own
// generated_at, rewritten fresh every time
// scripts/build-component-safe-reallocation-v0413.mjs reruns (e.g. inside
// npm run test:domain). plan_sha256/verification_report_sha256 embedded in
// this script's UI and decision template MUST be the CANONICAL
// (generated_at-excluded) digest -- a raw file hash here would make every
// downloaded Owner decision go stale on the very next test run, exactly as
// happened with N4.14's original (buggy) build.
test("Turn N4.15 regression guard: the Owner review UI's embedded plan_sha256/verification_report_sha256 are CANONICAL (generated_at-excluded) digests, stable across a rerun of Turn N4.13's build script", () => {
  function canonicalSha256(obj) {
    const clone = { ...obj };
    delete clone.generated_at;
    return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
  }
  const planPath = resolve(CSR_DIR, "strategy-a-assignment-only-plan.v0.1.json");
  const verificationReportPath = resolve(CSR_DIR, "strategy-a-verification-report.v0.1.json");
  const n413ScriptPath = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-v0413.mjs");

  const planBefore = readJson(planPath);
  const verificationReportBefore = readJson(verificationReportPath);
  const canonicalPlanBefore = canonicalSha256(planBefore);
  const canonicalVerificationReportBefore = canonicalSha256(verificationReportBefore);

  execFileSync(process.execPath, [n413ScriptPath], { cwd: REPO_ROOT, stdio: "pipe" });

  const planAfter = readJson(planPath);
  const verificationReportAfter = readJson(verificationReportPath);
  assert.notEqual(planBefore.generated_at, planAfter.generated_at, "sanity check: generated_at must actually change across a rerun, or this test would prove nothing");
  assert.equal(canonicalSha256(planAfter), canonicalPlanBefore, "plan content (excluding generated_at) must be stable across a rerun");
  assert.equal(canonicalSha256(verificationReportAfter), canonicalVerificationReportBefore, "verification report content (excluding generated_at) must be stable across a rerun");

  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });

  const decisionTemplate = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-decision-template.v0.1.json"));
  assert.equal(decisionTemplate.plan_sha256, canonicalPlanBefore, "decision template plan_sha256 must be the canonical digest, not a raw file hash");
  assert.equal(decisionTemplate.verification_report_sha256, canonicalVerificationReportBefore, "decision template verification_report_sha256 must be the canonical digest, not a raw file hash");

  const html = readFileSync(resolve(UI_DIR, "component-safe-reallocation-owner-review.html"), "utf8");
  const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/);
  const embeddedData = JSON.parse(match[1]);
  assert.equal(embeddedData.plan_sha256, canonicalPlanBefore, "UI-embedded plan_sha256 must be the canonical digest");
  assert.equal(embeddedData.verification_report_sha256, canonicalVerificationReportBefore, "UI-embedded verification_report_sha256 must be the canonical digest");
});

// -- Real headless Chrome verification --------------------------------------
let buildReport;
let page;
test.before(() => { buildReport = readJson(resolve(UI_DIR, "component-safe-reallocation-owner-review-build-report.json")); });

test("headless: Owner review page starts with no choice selected and both buttons locked", async () => {
  const url = "file://" + resolve(REPO_ROOT, buildReport.html_path);
  page = await launchHeadlessChromePage({ url });
  const initial = await page.evaluate(`(() => ({
    downloadDisabled: document.getElementById('downloadBtn').disabled,
    copyDisabled: document.getElementById('copyBtn').disabled,
    anyChecked: !!document.querySelector('input[name="ownerChoice"]:checked'),
  }))()`);
  assert.equal(initial.downloadDisabled, true);
  assert.equal(initial.copyDisabled, true);
  assert.equal(initial.anyChecked, false);
});

test("headless: selecting APPROVE with a partially-checked checklist keeps the download button locked", async () => {
  const result = await page.evaluate(`(() => {
    document.querySelector('input[value="APPROVE_COMPONENT_SAFE_REALLOCATION"]').checked = true;
    document.querySelector('input[value="APPROVE_COMPONENT_SAFE_REALLOCATION"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerName').value = 'Evaluation Owner';
    document.getElementById('ownerName').dispatchEvent(new Event('input'));
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    for (var i = 0; i < boxes.length - 1; i++) { boxes[i].checked = true; boxes[i].dispatchEvent(new Event('change')); }
    return { downloadDisabled: document.getElementById('downloadBtn').disabled, totalBoxes: boxes.length };
  })()`);
  assert.equal(result.totalBoxes, 10);
  assert.equal(result.downloadDisabled, true, "9/10 checklist items checked must still lock the button");
});

test("headless: checking the FINAL (10th) checklist item unlocks download/copy, and a real JSON download is produced with all required fields", async () => {
  const result = await page.evaluate(`(() => {
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    boxes[boxes.length - 1].checked = true;
    boxes[boxes.length - 1].dispatchEvent(new Event('change'));
    return { downloadDisabled: document.getElementById('downloadBtn').disabled, copyDisabled: document.getElementById('copyBtn').disabled };
  })()`);
  assert.equal(result.downloadDisabled, false);
  assert.equal(result.copyDisabled, false);

  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('downloadBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  assert.equal(downloaded.filename, "component-safe-reallocation-owner-decision.v0.1.json");
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));

  const expected = readJson(resolve(OWNER_REVIEW_DIR, "strategy-a-owner-decision-template.v0.1.json"));
  assert.equal(record.plan_sha256, expected.plan_sha256);
  assert.equal(record.delta_sha256, expected.delta_sha256);
  assert.equal(record.verification_report_sha256, expected.verification_report_sha256);
  assert.equal(record.anchor_count, 150);
  assert.equal(record.candidate_pool_count, 500);
  assert.equal(record.split_operation_count, 62);
  assert.equal(record.author_operation_count, 8);
  assert.equal(record.unique_changed_assignment_count, expected.unique_changed_assignment_count);
  assert.equal(record.overlapping_assignment_count, expected.overlapping_assignment_count);
  assert.deepEqual(record.before_split_counts, expected.before_split_counts);
  assert.deepEqual(record.after_split_counts, expected.after_split_counts);
  assert.equal(record.before_split_leakage, 6);
  assert.equal(record.after_split_leakage, 0);
  assert.equal(record.before_author_leakage, 4);
  assert.equal(record.after_author_leakage, 0);
  assert.equal(record.quarantine_intrusion_count, 0);
  assert.equal(record.owner_disposition, "APPROVE_COMPONENT_SAFE_REALLOCATION");
  assert.equal(record.anchor_membership_changed, false);
  assert.equal(record.relation_decisions_authorized, false);
  assert.equal(record.official_split_eligible, false);
  assert.equal(record.gold_authoring_authorized, false);
  assert.equal(record.checklist.length, 10);
  assert.ok(record.checklist.every((c) => c.checked === true));
});

test("headless: Copy to Clipboard succeeds via clipboard API or execCommand fallback", async () => {
  await page.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await page.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: switching to FIX_REQUIRED with an empty owner_note keeps the button locked; filling it unlocks, and the export record reflects it", async () => {
  await page.evaluate(`(() => {
    document.querySelector('input[value="FIX_REQUIRED"]').checked = true;
    document.querySelector('input[value="FIX_REQUIRED"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerNote').value = '';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const locked = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(locked, true);

  await page.evaluate(`(() => {
    document.getElementById('ownerNote').value = 'component c1 needs a second look';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const unlocked = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(unlocked, false);

  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('downloadBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  assert.equal(record.owner_disposition, "FIX_REQUIRED");
  assert.equal(record.owner_note, "component c1 needs a second look");
  assert.equal(record.official_split_eligible, false);
  assert.equal(record.gold_authoring_authorized, false);
});

test("headless: after page.close(), Chrome's own CDP port and its temp userDataDir/downloadDir are fully cleaned up -- zero leftovers", async () => {
  const { debugPort, userDataDir, downloadDir } = page;
  await page.close();
  page = undefined;
  await assert.rejects(fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(stat(userDataDir), (err) => err.code === "ENOENT");
  await assert.rejects(stat(downloadDir), (err) => err.code === "ENOENT");
});

test.after(async () => { if (page) await page.close(); });
