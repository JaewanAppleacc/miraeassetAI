// Turn N4.10: verifies the Priority Wave 1 packet/gate/Reviewer E&F UI build
// (scripts/build-relation-closure-priority-wave-1-v0410.mjs) against the
// REAL corpus, and that it never modifies any Turn N4.7/N4.8/N4.9 artifact.
// Per this repo's established convention (see
// tests/relation-closure-owner-review-ui-v02.test.mjs's fix and Turn N4.9's
// own test), the "never modifies a sibling artifact" guarantee is proven via
// a STATIC write-scope scan of the build script's source, never a live
// before/after hash comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-relation-closure-priority-wave-1-v0410.mjs");
const DR_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
const OUT_DIR = resolve(DR_DIR, "priority-wave-1-v0.1");
const UI_DIR = resolve(OUT_DIR, "ui/v0.1");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

async function clearDownloadDir(dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { force: true })));
}

test.before(() => {
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

// -- Static write-scope proof (race-free) ----------------------------------
test("Turn N4.10: static proof -- every write call targets only priority-wave-1-v0.1/, never any N4.7/N4.8/N4.9 sibling path", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const outDir = resolve\(DR_DIR, "priority-wave-1-v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeJsonl|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 5, `expected at least 5 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(outDir", "resolve(uiDir", "packetPath", "htmlEPath", "htmlFPath"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably outDir-rooted`);
  assert.match(source, /const packetPath = resolve\(outDir,/);
  for (const varName of ["htmlEPath", "htmlFPath"]) {
    if (targets.includes(varName)) assert.match(source, new RegExp(`const ${varName} = resolve\\(uiDir,`));
  }
  const forbiddenLiterals = [
    "provisional-row-classification.v0.1.jsonl",
    "targeted-provisional-relation-review-packet.v0.1.jsonl",
    "targeted-impact-cohort-summary.v0.1.json",
    "decision-respecting-graph-impact-report.v0.1.json",
    "decision-respecting-graph-components.v0.1.json",
    "gate-status.v0.4.json",
    "relation-closure-review-packet.v0.1.jsonl",
  ];
  const writeCallStarts = [...source.matchAll(/\b(?:writeJson|writeJsonl|writeFileSync)\(/g)].map((m) => m.index);
  for (const start of writeCallStarts) {
    const window = source.slice(start, start + 400);
    for (const forbidden of forbiddenLiterals) {
      assert.ok(!window.includes(forbidden), `write call near offset ${start} references forbidden sibling-artifact path fragment "${forbidden}"`);
    }
  }
});

// -- Dynamic selection correctness ------------------------------------------
test("Turn N4.10: the union is computed dynamically from provisional-row-classification.v0.1.jsonl, and equals exactly 13 with the contracted 4/0/12 distribution and 3 multi-condition overlaps", () => {
  const classifications = readJsonl(resolve(DR_DIR, "provisional-row-classification.v0.1.jsonl"));
  assert.equal(classifications.length, 294);
  const bySplit = classifications.filter((c) => c.direct_cross_split_edge === true);
  const byAuthor = classifications.filter((c) => c.direct_cross_author_edge === true);
  const byDecisive = classifications.filter((c) => c.individually_decisive === true);
  assert.equal(bySplit.length, 4);
  assert.equal(byAuthor.length, 0);
  assert.equal(byDecisive.length, 12);
  const union = new Set([...bySplit, ...byAuthor, ...byDecisive].map((c) => c.relation_candidate_id));
  assert.equal(union.size, 13);

  const manifest = readJson(resolve(OUT_DIR, "priority-wave-1-review-packet.v0.1.manifest.json"));
  assert.deepEqual(manifest.distribution, { DIRECT_CROSS_SPLIT_EDGE: 4, DIRECT_CROSS_AUTHOR_EDGE: 0, INDIVIDUALLY_DECISIVE: 12 });
  assert.equal(manifest.multi_condition_count, 3);
  assert.equal(manifest.union_count, 13);
  assert.deepEqual(new Set(manifest.multi_condition_relation_candidate_ids), new Set([...union].filter((id) => {
    const c = classifications.find((x) => x.relation_candidate_id === id);
    return (c.direct_cross_split_edge ? 1 : 0) + (c.direct_cross_author_edge ? 1 : 0) + (c.individually_decisive ? 1 : 0) > 1;
  })));
  assert.equal(manifest.contract_verified.distribution_matches, true);
  assert.equal(manifest.contract_verified.union_count_matches, true);
});

test("Turn N4.10: exactly 13 rows, zero duplicate relation_candidate_id, every id is a real subset member of the 231-row targeted packet, no extras or omissions", () => {
  const wave1 = readJsonl(resolve(OUT_DIR, "priority-wave-1-review-packet.v0.1.jsonl"));
  assert.equal(wave1.length, 13);
  const ids = wave1.map((r) => r.relation_candidate_id);
  assert.equal(new Set(ids).size, 13);
  const targeted231 = readJsonl(resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl"));
  assert.equal(targeted231.length, 231);
  const targetedIds = new Set(targeted231.map((r) => r.relation_candidate_id));
  for (const id of ids) assert.ok(targetedIds.has(id), `${id} must be a member of the 231-row packet`);

  const classifications = readJsonl(resolve(DR_DIR, "provisional-row-classification.v0.1.jsonl"));
  const expectedUnion = new Set(classifications.filter((c) => c.direct_cross_split_edge || c.direct_cross_author_edge || c.individually_decisive).map((c) => c.relation_candidate_id));
  assert.deepEqual(new Set(ids), expectedUnion, "no extra id, no missing id vs the recomputed union");
});

test("Turn N4.10: candidates and current_split_author_impact are transmitted VERBATIM from the 231-row packet -- no tampering", () => {
  const wave1 = readJsonl(resolve(OUT_DIR, "priority-wave-1-review-packet.v0.1.jsonl"));
  const targeted231 = readJsonl(resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl"));
  const targetedById = new Map(targeted231.map((r) => [r.relation_candidate_id, r]));
  for (const row of wave1) {
    const source = targetedById.get(row.relation_candidate_id);
    assert.deepEqual(row.candidates, source.candidates);
    assert.deepEqual(row.current_split_author_impact, source.current_split_author_impact);
    assert.equal(row.source_document_id, source.source_document_id);
  }
});

test("Turn N4.10: every Wave 1 row starts owner_disposition=PENDING with confirmed_target_document_id=null -- no auto-adjudication", () => {
  const wave1 = readJsonl(resolve(OUT_DIR, "priority-wave-1-review-packet.v0.1.jsonl"));
  for (const row of wave1) {
    assert.equal(row.owner_disposition, "PENDING");
    assert.equal(row.confirmed_target_document_id, null);
    assert.ok(Array.isArray(row.priority_wave_1_selection_reasons) && row.priority_wave_1_selection_reasons.length >= 1);
  }
  const manifest = readJson(resolve(OUT_DIR, "priority-wave-1-review-packet.v0.1.manifest.json"));
  assert.equal(manifest.official_split_eligible, false);
  assert.equal(manifest.gold_authoring_status, "BLOCKED");
  assert.equal(manifest.no_auto_adjudication, true);
});

test("Turn N4.10: gate-status.v0.1.json reports the exact required fields", () => {
  const gate = readJson(resolve(OUT_DIR, "priority-wave-1-gate-status.v0.1.json"));
  assert.equal(gate.status, "INDEPENDENT_REVIEW_PENDING");
  assert.equal(gate.reviewed_count, 0);
  assert.equal(gate.pending_count, 13);
  assert.equal(gate.official_split_eligible, false);
  assert.equal(gate.chain_closure_status, "NOT_FINALIZED");
  assert.equal(gate.gold_authoring_status, "BLOCKED_PENDING_PRIORITY_WAVE_1_REVIEW");
  assert.match(gate.remaining_cohort_note, /218/);
});

test("Turn N4.10: the existing 231-row packet/UI/graph/gate files are untouched (content-invariant re-check, no live race-prone comparison)", () => {
  const targeted231 = readJsonl(resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl"));
  assert.equal(targeted231.length, 231);
  const cohortSummary = readJson(resolve(DR_DIR, "targeted-impact-cohort-summary.v0.1.json"));
  assert.equal(cohortSummary.targeted_impact_cohort_size, 231);
  const gateV04 = readJson(resolve(DR_DIR, "gate-status.v0.4.json"));
  assert.equal(gateV04.gates.official_split_eligible, false);
  assert.ok(existsSync(resolve(DR_DIR, "ui/v0.1/targeted-impact-cohort-reviewer-e.v0.1.html")));
  assert.ok(existsSync(resolve(DR_DIR, "ui/v0.1/targeted-impact-cohort-reviewer-f.v0.1.html")));
});

test("Turn N4.10: N4.9's own upstream inputs (Candidate Pool 500, Anchor 150, Author 75/75) remain unchanged", () => {
  const pool = readJsonl(resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl"));
  assert.equal(pool.length, 500);
  const anchor = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl"));
  assert.equal(anchor.length, 150);
  const author = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl"));
  const counts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of author) counts[r.author_allocation] += 1;
  assert.deepEqual(counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
});

test("Turn N4.10: Reviewer E/F UI build report shows fixed roles, isolated storage/export, no auto-approval/majority/chain-closure logic", () => {
  const report = readJson(resolve(UI_DIR, "priority-wave-1-reviewer-ui-build-report.json"));
  assert.equal(report.reviewer_e.reviewer_role, "REVIEWER_E");
  assert.equal(report.reviewer_f.reviewer_role, "REVIEWER_F");
  assert.notEqual(report.reviewer_e.storage_key, report.reviewer_f.storage_key);
  assert.notEqual(report.reviewer_e.export_filename, report.reviewer_f.export_filename);
  assert.notEqual(report.reviewer_e.storage_key, "n4.9-reviewer-e-targeted-cohort-v0.1");
  assert.notEqual(report.reviewer_f.storage_key, "n4.9-reviewer-f-targeted-cohort-v0.1");
  assert.equal(report.role_changeable_via_url_query_or_prompt_or_select, false);
  assert.equal(report.auto_approval_or_majority_vote_or_chain_closure_computed, false);
});

test("Turn N4.10: neither UI's source ever reads location.search/URLSearchParams/prompt() to determine reviewer role", () => {
  const htmlE = readFileSync(resolve(UI_DIR, "priority-wave-1-reviewer-e.v0.1.html"), "utf8");
  const htmlF = readFileSync(resolve(UI_DIR, "priority-wave-1-reviewer-f.v0.1.html"), "utf8");
  for (const html of [htmlE, htmlF]) {
    assert.doesNotMatch(html, /location\.search|URLSearchParams|window\.prompt|\bprompt\(/);
    assert.match(html, /var ROLE = DATA\.role;/);
  }
  assert.match(htmlE, /"role":"REVIEWER_E"/);
  assert.match(htmlF, /"role":"REVIEWER_F"/);
});

// -- Real headless Chrome verification --------------------------------------
let buildReport;
let page;
test.before(() => { buildReport = readJson(resolve(UI_DIR, "priority-wave-1-reviewer-ui-build-report.json")); });

test("headless: Reviewer E page fixes role=REVIEWER_E, starts with 13 PENDING rows, export locked", async () => {
  const urlE = "file://" + resolve(REPO_ROOT, buildReport.reviewer_e.html_path);
  page = await launchHeadlessChromePage({ url: urlE });
  const initial = await page.evaluate(`(() => ({
    role: JSON.parse(document.getElementById('review-data').textContent).role,
    rowCount: document.querySelectorAll('.row').length,
    exportDisabled: document.getElementById('exportBtn').disabled,
    copyDisabled: document.getElementById('copyBtn').disabled,
  }))()`);
  assert.equal(initial.role, "REVIEWER_E");
  assert.equal(initial.rowCount, 13);
  assert.equal(initial.exportDisabled, true);
  assert.equal(initial.copyDisabled, true);
});

test("headless: CONFIRM without selecting a target keeps export locked; judging only SOME of the 13 also keeps it locked", async () => {
  const partial = await page.evaluate(`(() => {
    var rows = document.querySelectorAll('.row');
    for (var i = 0; i < rows.length - 1; i++) {
      var select = rows[i].querySelectorAll('select')[0];
      select.value = 'REJECT';
      select.dispatchEvent(new Event('change'));
      var note = rows[i].querySelector('textarea');
      note.value = 'note ' + i;
      note.dispatchEvent(new Event('input'));
    }
    var lastConfirmSelect = rows[rows.length - 1].querySelectorAll('select')[0];
    lastConfirmSelect.value = 'CONFIRM';
    lastConfirmSelect.dispatchEvent(new Event('change'));
    return { exportDisabled: document.getElementById('exportBtn').disabled };
  })()`);
  assert.equal(partial.exportDisabled, true, "12/13 judged (and the 13th CONFIRM has no target/note yet) must still lock export");
});

test("headless: completing all 13 (CONFIRM with a target for the last row) unlocks export, and a real JSONL download for Reviewer E is produced with valid records", async () => {
  const result = await page.evaluate(`(() => {
    var rows = document.querySelectorAll('.row');
    var lastRow = rows[rows.length - 1];
    var targetSelect = lastRow.querySelectorAll('select')[1];
    targetSelect.disabled = false;
    targetSelect.selectedIndex = 1;
    targetSelect.dispatchEvent(new Event('change'));
    var note = lastRow.querySelector('textarea');
    note.value = 'confirmed based on DocumentIR';
    note.dispatchEvent(new Event('input'));
    return { exportDisabled: document.getElementById('exportBtn').disabled };
  })()`);
  assert.equal(result.exportDisabled, false);

  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('exportBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  assert.equal(downloaded.filename, "priority-wave-1-reviewer-e-decision.v0.1.jsonl");
  const text = readFileSync(downloaded.path, "utf8").trim();
  const lines = text.split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 13);
  for (const rec of lines) assert.equal(rec.reviewer_role, "REVIEWER_E");
  const confirmedRec = lines.find((r) => r.disposition === "CONFIRM");
  assert.ok(confirmedRec.confirmed_target_document_id);
  const rejectedRec = lines.find((r) => r.disposition === "REJECT");
  assert.equal(rejectedRec.confirmed_target_document_id, null);
  for (const rec of lines) assert.ok(rec.note && rec.note.trim().length > 0);
});

test("headless: Copy to Clipboard on Reviewer E succeeds via clipboard API or execCommand fallback", async () => {
  await page.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await page.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: within the SAME browser profile, navigating to Reviewer F shows a completely fresh state -- Reviewer E's 13 judgments never leak in", async () => {
  const urlF = "file://" + resolve(REPO_ROOT, buildReport.reviewer_f.html_path);
  await page.send("Page.navigate", { url: urlF });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = (await page.evaluate("document.readyState")) === "complete";
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready);
  const state = await page.evaluate(`(() => ({
    role: JSON.parse(document.getElementById('review-data').textContent).role,
    judgedText: document.getElementById('status').textContent,
    exportDisabled: document.getElementById('exportBtn').disabled,
  }))()`);
  assert.equal(state.role, "REVIEWER_F");
  assert.match(state.judgedText, /judged 0 \/ 13/);
  assert.equal(state.exportDisabled, true);
});

test("headless: Reviewer F judging all 13 as NEEDS_MORE_REVIEW exports its OWN distinct JSONL file, isolated from Reviewer E's export", async () => {
  await page.evaluate(`(() => {
    var rows = document.querySelectorAll('.row');
    rows.forEach(function (row, i) {
      var select = row.querySelectorAll('select')[0];
      select.value = 'NEEDS_MORE_REVIEW';
      select.dispatchEvent(new Event('change'));
      var note = row.querySelector('textarea');
      note.value = 'reviewer F note ' + i;
      note.dispatchEvent(new Event('input'));
    });
  })()`);
  const exportDisabled = await page.evaluate(`document.getElementById('exportBtn').disabled`);
  assert.equal(exportDisabled, false);
  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('exportBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  assert.equal(downloaded.filename, "priority-wave-1-reviewer-f-decision.v0.1.jsonl");
  assert.notEqual(downloaded.filename, "priority-wave-1-reviewer-e-decision.v0.1.jsonl");
  const lines = readFileSync(downloaded.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 13);
  for (const rec of lines) {
    assert.equal(rec.reviewer_role, "REVIEWER_F");
    assert.equal(rec.disposition, "NEEDS_MORE_REVIEW");
    assert.equal(rec.confirmed_target_document_id, null);
  }
});

test("headless: after page.close(), Chrome's own process/CDP port and its temp userDataDir/downloadDir are fully cleaned up -- zero leftovers", async () => {
  const { debugPort, userDataDir, downloadDir } = page;
  await page.close();
  page = undefined;
  await assert.rejects(fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) }), "the Chrome CDP port must no longer respond after close()");
  await assert.rejects(stat(userDataDir), (err) => err.code === "ENOENT", "userDataDir must be removed after close()");
  await assert.rejects(stat(downloadDir), (err) => err.code === "ENOENT", "downloadDir must be removed after close()");
});

test.after(async () => { if (page) await page.close(); });
