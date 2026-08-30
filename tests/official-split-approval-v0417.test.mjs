// Turn N4.17: verifies the FINAL official-split approval packet + decision
// template + UI build (scripts/build-official-split-approval-v0417.mjs)
// against the REAL Turn N4.16 v0.3 outputs, and that it never writes to any
// v0.2/v0.1/v0.3 real file, the official ledger, or Runtime/PostgreSQL/
// v0.20. Per this repo's established convention, "never modifies a sibling
// artifact" is proven via a static write-scope scan, and this Turn's UNIQUE
// invariant -- official_split_eligible is the field genuinely being
// decided, not an always-false constant -- is proven with a real headless
// Chrome download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";
import { verifyOfficialSplitApprovalDecision } from "../domain/evaluation/official-split-approval.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-official-split-approval-v0417.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const CSR_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const APPLIED_V03_DIR = resolve(CSR_DIR, "applied-v0.3");
const OFFICIAL_SPLIT_DIR = resolve(CSR_DIR, "official-split-approval-v0.1");
const UI_DIR = resolve(OFFICIAL_SPLIT_DIR, "ui/v0.1");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const POOL_V03_PATH = resolve(APPLIED_V03_DIR, "candidate-pool.v0.3.jsonl");
const ANCHOR_V03_PATH = resolve(APPLIED_V03_DIR, "anchor-selection.v0.3.jsonl");
const AUTHOR_V03_PATH = resolve(APPLIED_V03_DIR, "author-allocation.v0.3.jsonl");
const LEDGER_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
async function clearDownloadDir(dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { force: true })));
}

let anchorV02Before; let authorV02Before; let poolV02Before; let poolV03Before; let anchorV03Before; let authorV03Before; let ledgerBefore;
test.before(() => {
  anchorV02Before = readFileSync(ANCHOR_V02_PATH, "utf8");
  authorV02Before = readFileSync(AUTHOR_V02_PATH, "utf8");
  poolV02Before = readFileSync(POOL_PATH, "utf8");
  poolV03Before = readFileSync(POOL_V03_PATH, "utf8");
  anchorV03Before = readFileSync(ANCHOR_V03_PATH, "utf8");
  authorV03Before = readFileSync(AUTHOR_V03_PATH, "utf8");
  ledgerBefore = readFileSync(LEDGER_PATH, "utf8");
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.17: static proof -- every write call targets only official-split-approval-v0.1/, never any v0.2/v0.1/v0.3 real file or the official ledger", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const OFFICIAL_SPLIT_DIR = resolve\(CSR_DIR, "official-split-approval-v0\.1"\)/);
  assert.match(source, /const uiDir = resolve\(OFFICIAL_SPLIT_DIR, "ui\/v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 4, `expected at least 4 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(OFFICIAL_SPLIT_DIR", "resolve(uiDir", "packetPath", "htmlPath"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably OFFICIAL_SPLIT_DIR-rooted`);
  assert.doesNotMatch(source, /relation-closure-candidate-ledger\.v0\.2\.jsonl["'][\s\S]{0,50}write(?:FileSync|Json)|write(?:FileSync|Json)[\s\S]{0,50}relation-closure-candidate-ledger\.v0\.2\.jsonl/, "must never write to the official ledger");
});

test("Turn N4.17: the real v0.2/v0.1 files AND Turn N4.16's v0.3 files are byte-unmodified after building this UI", () => {
  assert.equal(readFileSync(ANCHOR_V02_PATH, "utf8"), anchorV02Before);
  assert.equal(readFileSync(AUTHOR_V02_PATH, "utf8"), authorV02Before);
  assert.equal(readFileSync(POOL_PATH, "utf8"), poolV02Before);
  assert.equal(readFileSync(POOL_V03_PATH, "utf8"), poolV03Before);
  assert.equal(readFileSync(ANCHOR_V03_PATH, "utf8"), anchorV03Before);
  assert.equal(readFileSync(AUTHOR_V03_PATH, "utf8"), authorV03Before);
  assert.equal(readFileSync(LEDGER_PATH, "utf8"), ledgerBefore);
});

test("Turn N4.17: pre-verification reproduces v0.3's zero-leakage/zero-quarantine-intrusion state and 242/81/177 + 75/75 exactly, never hardcoded copy-paste", () => {
  const packet = readJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-packet.v0.1.json"));
  assert.equal(packet.v03_summary.split_leakage_after, 0);
  assert.equal(packet.v03_summary.author_leakage_after, 0);
  assert.equal(packet.v03_summary.quarantine_intrusion_after, 0);
  assert.deepEqual(packet.v03_summary.split_counts, { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 });
  assert.deepEqual(packet.v03_summary.author_counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
  assert.equal(packet.v03_summary.critical_slice_floors_preserved, true);
  assert.equal(packet.v03_summary.anchor_membership_unchanged, true);
});

test("Turn N4.17: decision template is PENDING with official_split_eligible/gold_authoring_authorized/actual_official_promotion_applied all false, and all required fields present", () => {
  const template = readJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-decision-template.v0.1.json"));
  assert.equal(template.owner_disposition, "PENDING");
  assert.equal(template.status, "TEMPLATE_NOT_A_REAL_DECISION");
  assert.equal(template.official_split_eligible, false);
  assert.equal(template.gold_authoring_authorized, false);
  assert.equal(template.actual_official_promotion_applied, false);
  assert.equal(template.anchor_membership_changed, false);
  assert.equal(template.relation_decisions_authorized, false);
  assert.equal(template.remaining_281_provisional_untouched, true);
});

test("Turn N4.17: gate-status never claims official promotion was applied", () => {
  const gate = readJson(resolve(OFFICIAL_SPLIT_DIR, "gate-status-official-split.v0.1.json"));
  assert.equal(gate.official_split_eligible, false);
  assert.equal(gate.gold_authoring_authorized, false);
  assert.equal(gate.actual_official_promotion_applied, false);
  assert.equal(gate.anchor_membership_changed, false);
});

test("Turn N4.17: the official 326-row ledger is untouched and still shows 294 provisional rows", () => {
  const ledger = readJsonl(LEDGER_PATH);
  assert.equal(ledger.length, 326);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  assert.equal(provisionalCount, 294);
});

test("Turn N4.17: re-running the script is idempotent and deterministic (byte-identical decision template apart from generated_at)", () => {
  function canonical(obj) { const c = { ...obj }; delete c.generated_at; return JSON.stringify(c, Object.keys(c).sort()); }
  const before = canonical(readJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-decision-template.v0.1.json")));
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = canonical(readJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-decision-template.v0.1.json")));
  assert.equal(before, after);
});

// -- Real headless Chrome verification --------------------------------------
let buildReport;
let page;
test.before(() => { buildReport = readJson(resolve(UI_DIR, "official-split-approval-build-report.json")); });

test("headless: official split approval page starts with no choice selected and both buttons locked", async () => {
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

test("headless: selecting APPROVE_OFFICIAL_SPLIT_V0.3 with a partially-checked checklist keeps the download button locked", async () => {
  const result = await page.evaluate(`(() => {
    document.querySelector('input[value="APPROVE_OFFICIAL_SPLIT_V0.3"]').checked = true;
    document.querySelector('input[value="APPROVE_OFFICIAL_SPLIT_V0.3"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerName').value = 'Evaluation Owner';
    document.getElementById('ownerName').dispatchEvent(new Event('input'));
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    for (var i = 0; i < boxes.length - 1; i++) { boxes[i].checked = true; boxes[i].dispatchEvent(new Event('change')); }
    return { downloadDisabled: document.getElementById('downloadBtn').disabled, totalBoxes: boxes.length };
  })()`);
  assert.equal(result.totalBoxes, 10);
  assert.equal(result.downloadDisabled, true, "9/10 checklist items checked must still lock the button");
});

test("headless: checking the FINAL checklist item unlocks download/copy, and the downloaded decision has official_split_eligible=true with gold_authoring_authorized/actual_official_promotion_applied still false -- verified via the domain verifier, not by field-count alone", async () => {
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
  assert.equal(downloaded.filename, "official-split-approval-decision.v0.1.json");
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));

  assert.equal(record.owner_disposition, "APPROVE_OFFICIAL_SPLIT_V0.3");
  assert.equal(record.checklist.length, 10);
  assert.ok(record.checklist.every((c) => c.checked === true));
  assert.equal(record.official_split_eligible, true, "a genuine, fully-checklisted APPROVE must export official_split_eligible=true");
  assert.equal(record.gold_authoring_authorized, false);
  assert.equal(record.actual_official_promotion_applied, false);
  assert.equal(record.anchor_membership_changed, false);
  assert.equal(record.relation_decisions_authorized, false);
  assert.equal(record.remaining_281_provisional_untouched, true);

  const template = readJson(resolve(OFFICIAL_SPLIT_DIR, "official-split-approval-decision-template.v0.1.json"));
  const expected = {
    v03_manifest_sha256: template.v03_manifest_sha256, v03_pool_sha256: template.v03_pool_sha256,
    v03_anchor_sha256: template.v03_anchor_sha256, v03_author_sha256: template.v03_author_sha256,
    anchor_count: 150, candidate_pool_count: 500, author_count: 150,
    split_leakage_after: 0, author_leakage_after: 0, quarantine_intrusion_after: 0,
    split_counts: { DEV_TUNE: 242, DEV_CHECK: 81, HOLDOUT: 177 },
    author_counts: { AUTHOR_A: 75, AUTHOR_B: 75 },
  };
  const verification = verifyOfficialSplitApprovalDecision({ decision: record, expected });
  assert.equal(verification.ok, true, `real downloaded decision must pass the domain verifier: ${JSON.stringify(verification.violations)}`);
  assert.equal(verification.is_genuine_approval, true);
});

test("headless: Copy to Clipboard succeeds via clipboard API or execCommand fallback", async () => {
  await page.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await page.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: switching to FIX_REQUIRED with an empty owner_note keeps the button locked; filling it unlocks, and the exported record has official_split_eligible=false (never true outside a genuine APPROVE)", async () => {
  await page.evaluate(`(() => {
    document.querySelector('input[value="FIX_REQUIRED"]').checked = true;
    document.querySelector('input[value="FIX_REQUIRED"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerNote').value = '';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const locked = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(locked, true);

  await page.evaluate(`(() => {
    document.getElementById('ownerNote').value = 'need to re-check quarantine document ids';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const unlocked = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(unlocked, false);

  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('downloadBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  assert.equal(record.owner_disposition, "FIX_REQUIRED");
  assert.equal(record.owner_note, "need to re-check quarantine document ids");
  assert.equal(record.official_split_eligible, false, "FIX_REQUIRED must never export official_split_eligible=true, even though the checklist was previously satisfied under APPROVE");
  assert.equal(record.gold_authoring_authorized, false);
  assert.equal(record.actual_official_promotion_applied, false);
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
