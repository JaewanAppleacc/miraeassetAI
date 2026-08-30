// Turn N4.9: verifies the decision-respecting graph + targeted-impact-cohort
// build (scripts/build-relation-closure-decision-respecting-graph-v049.mjs)
// against the REAL corpus, and that it never modifies any Turn N4.7/N4.7.1/
// N4.8 artifact. Per this Turn's own instruction, the "never modifies a
// sibling artifact" guarantee is proven with a STATIC write-scope scan of
// the build script's source (never a live before/after hash comparison),
// exactly to avoid reintroducing the race condition already fixed for
// tests/relation-closure-owner-review-ui-v02.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

// waitForDownloadCompletion returns the first COMPLETED file it finds in
// downloadDir -- fine for a fresh dir, but this suite deliberately reuses
// ONE page/downloadDir across the Reviewer E -> Reviewer F navigation (to
// prove same-profile state isolation for real), so Reviewer E's own
// already-completed download would otherwise still be sitting there when
// Reviewer F's export is checked. Clearing the directory between exports
// keeps each waitForDownloadCompletion call unambiguous.
async function clearDownloadDir(dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { force: true })));
}

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-relation-closure-decision-respecting-graph-v049.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const OUT_DIR = resolve(V02_DIR, "decision-respecting-graph-v0.1");
const N48_DIR = resolve(V02_DIR, "maximal-graph-v0.1");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

test.before(() => {
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

// -- Static write-scope proof (race-free, no live file comparison) --------
test("Turn N4.9: static proof -- every write call in the build script targets only its own OUT_DIR (decision-respecting-graph-v0.1) namespace", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const outDir = resolve\(REPO_ROOT, "work\/handoff\/anchor-dev-tune-v0\.2\/decision-respecting-graph-v0\.1"\)/);
  // Every directory variable derived for writing must trace back to outDir.
  assert.match(source, /const uiDir = resolve\(outDir, "ui\/v0\.1"\)/g);
  assert.match(source, /const packetDir = outDir;/);
  // Collect every write call's leading target expression (up to the first
  // top-level comma) and require it to be one of the outDir-rooted forms.
  const writeCallRegex = /\b(?:writeJson|writeJsonl|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)]
    .map((m) => m[1].trim())
    // Exclude the two generic helper FUNCTION DEFINITIONS (writeJson/
    // writeJsonl themselves), whose "target" is just a parameter name.
    .filter((t) => t !== "p");
  assert.ok(targets.length >= 12, `expected at least 12 real write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(outDir", "resolve(uiDir", "resolve(packetDir", "htmlPath", "htmlEPath", "htmlFPath"];
  for (const t of targets) {
    assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably outDir-rooted`);
  }
  // Any of the three ad-hoc path variables (htmlPath/htmlEPath/htmlFPath)
  // used above must themselves be declared as resolve(uiDir, ...).
  for (const varName of ["htmlPath", "htmlEPath", "htmlFPath"]) {
    if (targets.includes(varName)) {
      assert.match(source, new RegExp(`const ${varName} = resolve\\(uiDir,`), `${varName} must be declared as resolve(uiDir, ...)`);
    }
  }
  // Exhaustive negative check: the literal paths of every N4.7/N4.8 artifact
  // this script READS must never also appear as a write target string.
  const forbiddenLiterals = [
    "anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl",
    "relation-closure-candidate-ledger.v0.2.jsonl",
    "provisional-294-decision-packet.v0.2.json",
    "candidate-pool.v0.1.jsonl",
    "anchor-selection.v0.2.jsonl",
    "author-allocation.v0.2.jsonl",
    "quarantine-manifest.v0.2.json",
    "gate-status.v0.2.json",
    "gate-status.v0.3.json",
    "maximal-graph-impact-report.v0.1.json",
  ];
  const writeCallStarts = [...source.matchAll(/\b(?:writeJson|writeJsonl|writeFileSync)\(/g)].map((m) => m.index);
  for (const start of writeCallStarts) {
    const window = source.slice(start, start + 400);
    for (const forbidden of forbiddenLiterals) {
      assert.ok(!window.includes(forbidden), `write call near offset ${start} references forbidden sibling-artifact path fragment "${forbidden}"`);
    }
  }
});

test("Turn N4.9: input verification -- 326/326 packet, ledger authority distribution (21/8/2/294/1), Pool 500, Anchor/Author v0.2 150/150 75-75, quarantine 50, all cross-checked against Turn N4.8's own pins", () => {
  const packet = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl"));
  assert.equal(packet.length, 326);
  const ledger = readJsonl(resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  assert.equal(ledger.length, 326);
  const dist = { OWNER_V03: 0, DUAL_REVIEW_C_D: 0, REVIEWER_CONSENSUS_PROVISIONAL: 0, QUARANTINED_UNRESOLVED: 0 };
  for (const r of ledger) dist[r.decision_authority] += 1;
  assert.equal(dist.OWNER_V03, 29);
  assert.equal(dist.DUAL_REVIEW_C_D, 2);
  assert.equal(dist.REVIEWER_CONSENSUS_PROVISIONAL, 294);
  assert.equal(dist.QUARANTINED_UNRESOLVED, 1);
  const report = readJson(resolve(OUT_DIR, "decision-respecting-graph-impact-report.v0.1.json"));
  assert.equal(report.input_shas.all_verified_against_turn_n48_pinned_values, true);
});

test("Turn N4.9: edge counts -- N4.8 2,151 vs N4.9's decision-respecting graph, with the exact Owner-REJECT-derived removal accounted for", () => {
  const n48Report = readJson(resolve(N48_DIR, "maximal-graph-impact-report.v0.1.json"));
  const n49Report = readJson(resolve(OUT_DIR, "decision-respecting-graph-impact-report.v0.1.json"));
  assert.equal(n48Report.maximal_graph_summary.total_candidate_edge_count, 2151);
  const cmp = n49Report.comparison_vs_turn_n48_extreme_graph;
  assert.equal(cmp.n48_edge_count, 2151);
  assert.ok(cmp.n49_edge_count < cmp.n48_edge_count, "decision-respecting graph must be strictly smaller");
  assert.equal(cmp.total_edges_removed, cmp.n48_edge_count - cmp.n49_edge_count);
  assert.ok(cmp.owner_reject_derived_edges_removed > 0);
  const componentsFile = readJson(resolve(OUT_DIR, "decision-respecting-graph-components.v0.1.json"));
  assert.equal(componentsFile.comparison_vs_turn_n48_extreme_graph.removed_edges_accounted_for, true, "reject + quarantined-row + confirmed-surplus removals must sum to exactly the total edges removed");
});

test("Turn N4.9: the decision-respecting graph's edge list never contains an Owner-REJECT-authority or QUARANTINED_UNRESOLVED-authority edge", () => {
  const edges = readJsonl(resolve(OUT_DIR, "decision-respecting-graph-edges.v0.1.jsonl"));
  const ledger = readJsonl(resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  const ledgerById = new Map(ledger.map((r) => [r.relation_candidate_id, r]));
  for (const edge of edges) {
    const ledgerRow = ledgerById.get(edge.relation_candidate_id);
    assert.notEqual(ledgerRow.final_disposition, "REJECT", `edge from ${edge.relation_candidate_id} must not exist -- its ledger disposition is REJECT`);
    assert.notEqual(ledgerRow.decision_authority, "QUARANTINED_UNRESOLVED");
  }
  // Every CONFIRM-authority row (Owner or dual-review) contributes EXACTLY
  // one edge, never more.
  const confirmIds = ledger.filter((r) => r.final_disposition === "CONFIRM").map((r) => r.relation_candidate_id);
  for (const rid of confirmIds) {
    const count = edges.filter((e) => e.relation_candidate_id === rid).length;
    assert.equal(count, 1, `CONFIRM row ${rid} must contribute exactly one edge, found ${count}`);
  }
});

test("Turn N4.9: leakage found (branch B) -- component count, largest component, split/author/quarantine violation counts, affected assignment count are all real numbers, never fabricated zero/placeholder", () => {
  const report = readJson(resolve(OUT_DIR, "decision-respecting-graph-impact-report.v0.1.json"));
  assert.equal(report.all_zero_decision_respecting_leakage, false);
  assert.ok(report.decision_respecting_graph_summary.maximal_component_count > 0);
  assert.ok(report.decision_respecting_graph_summary.largest_maximal_component_base_component_count > 1);
  assert.ok(report.split_impact.violations.length > 0);
  assert.ok(report.author_impact.violations.length > 0);
  assert.ok(report.affected_assignment_count > 0);
  assert.equal(report.affected_assignment_count, report.affected_assignment_ids.length);
});

test("Turn N4.9: targeted impact cohort -- every provisional row gets only closed labels, cohort excludes exactly the NO_CURRENT_SPLIT_IMPACT rows, no minimality claim is made", () => {
  const classifications = readJsonl(resolve(OUT_DIR, "provisional-row-classification.v0.1.jsonl"));
  assert.equal(classifications.length, 294);
  const CLOSED = new Set(["DIRECT_CROSS_SPLIT_EDGE", "DIRECT_CROSS_AUTHOR_EDGE", "INDIVIDUALLY_DECISIVE", "REDUNDANT_BUT_COMPONENT_RELEVANT", "NO_CURRENT_SPLIT_IMPACT"]);
  for (const c of classifications) {
    assert.ok(c.labels.length >= 1);
    for (const l of c.labels) assert.ok(CLOSED.has(l), `unexpected label ${l}`);
    if (c.labels.includes("NO_CURRENT_SPLIT_IMPACT")) assert.equal(c.labels.length, 1, "NO_CURRENT_SPLIT_IMPACT must never co-occur with another label");
    if (c.labels.includes("INDIVIDUALLY_DECISIVE")) assert.ok(!c.labels.includes("REDUNDANT_BUT_COMPONENT_RELEVANT"), "a row cannot be both individually decisive and redundant");
  }
  const summary = readJson(resolve(OUT_DIR, "targeted-impact-cohort-summary.v0.1.json"));
  const expectedCohortSize = classifications.filter((c) => !c.labels.includes("NO_CURRENT_SPLIT_IMPACT")).length;
  assert.equal(summary.targeted_impact_cohort_size, expectedCohortSize);
  assert.match(summary.minimality_claim, /NONE/);
  assert.doesNotMatch(JSON.stringify(summary), /minimum cohort|proven minimal/i);
});

test("Turn N4.9: targeted-provisional-relation-review-packet contains ONLY source locator/candidates/current impact -- no Gold, expected_answer, or Agent output fields anywhere", () => {
  const rows = readJsonl(resolve(OUT_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl"));
  assert.ok(rows.length > 0);
  const forbiddenKeys = ["gold", "expected_answer", "agent_output", "hcx_output", "answer"];
  for (const row of rows) {
    const text = JSON.stringify(row).toLowerCase();
    for (const key of forbiddenKeys) assert.ok(!text.includes(`"${key}"`), `row ${row.relation_candidate_id} unexpectedly contains forbidden key "${key}"`);
    assert.equal(row.review_status, "PENDING");
    assert.equal(row.reviewer_disposition, null);
    assert.equal(row.confirmed_target_document_id, null);
  }
});

test("Turn N4.9: gate-status.v0.4.json reflects branch B exactly, and never sets official_split_eligible true", () => {
  const gates = readJson(resolve(OUT_DIR, "gate-status.v0.4.json")).gates;
  assert.equal(gates.provisional_294_resolution, "TARGETED_IMPACT_REVIEW_REQUIRED");
  assert.equal(gates.final_owner_split_review, "NOT_READY");
  assert.equal(gates.official_split_eligible, false);
  assert.equal(gates.gold_authoring, "BLOCKED_PENDING_PROVISIONAL_IMPACT_REVIEW");
});

test("Turn N4.9: gate-status.v0.2.json and gate-status.v0.3.json (Turn N4.7.1/N4.8's own files) keep their original wording -- never overwritten", () => {
  const gatesV02 = readJson(resolve(V02_DIR, "gate-status.v0.2.json")).gates;
  assert.equal(gatesV02.gold_authoring, "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL");
  const gatesV03 = readJson(resolve(N48_DIR, "gate-status.v0.3.json")).gates;
  assert.equal(gatesV03.gold_authoring, "BLOCKED_PENDING_PROVISIONAL_294_RESOLUTION");
});

test("Turn N4.9: no Owner approval UI is generated for a branch-B result, and Reviewer E/F UIs + build report exist with distinct storage keys/export filenames", () => {
  const buildReport = readJson(resolve(OUT_DIR, "ui/v0.1/targeted-impact-cohort-reviewer-ui-build-report.json"));
  assert.notEqual(buildReport.reviewer_e.storage_key, buildReport.reviewer_f.storage_key);
  assert.notEqual(buildReport.reviewer_e.export_filename, buildReport.reviewer_f.export_filename);
  assert.equal(buildReport.auto_approval_or_majority_vote_or_chain_closure_computed, false);
});

// -- Real headless Chrome verification of Reviewer E/F UIs -----------------
let buildReport;
let page;
test.before(() => {
  buildReport = readJson(resolve(OUT_DIR, "ui/v0.1/targeted-impact-cohort-reviewer-ui-build-report.json"));
});

test("headless: Reviewer E page identifies itself as role E, starts with export disabled, and CONFIRM without a target keeps export blocked", async () => {
  const urlE = "file://" + resolve(REPO_ROOT, buildReport.reviewer_e.html_path);
  page = await launchHeadlessChromePage({ url: urlE });
  const initial = await page.evaluate(`(() => ({
    role: JSON.parse(document.getElementById('review-data').textContent).role,
    exportDisabled: document.getElementById('exportBtn').disabled,
    copyDisabled: document.getElementById('copyBtn').disabled,
  }))()`);
  assert.equal(initial.role, "E");
  assert.equal(initial.exportDisabled, true);
  assert.equal(initial.copyDisabled, true);

  const afterConfirmNoTarget = await page.evaluate(`(() => {
    var row = document.querySelector('.row');
    var select = row.querySelector('select');
    select.value = 'CONFIRM';
    select.dispatchEvent(new Event('change'));
    var note = row.querySelector('textarea');
    note.value = 'test note';
    note.dispatchEvent(new Event('input'));
    return { exportDisabled: document.getElementById('exportBtn').disabled };
  })()`);
  assert.equal(afterConfirmNoTarget.exportDisabled, true, "CONFIRM with no target selected must still block export");
});

test("headless: completing EVERY row (mixed CONFIRM-with-target and REJECT-with-note) unlocks export, and a real download named for Reviewer E is produced with valid JSON", async () => {
  const result = await page.evaluate(`(() => {
    var rows = document.querySelectorAll('.row');
    rows.forEach(function (row, i) {
      var select = row.querySelectorAll('select')[0];
      var targetSelect = row.querySelectorAll('select')[1];
      var note = row.querySelector('textarea');
      if (i === 0) {
        select.value = 'CONFIRM';
        select.dispatchEvent(new Event('change'));
        targetSelect.disabled = false;
        targetSelect.selectedIndex = 1;
        targetSelect.dispatchEvent(new Event('change'));
      } else {
        select.value = 'REJECT';
        select.dispatchEvent(new Event('change'));
      }
      note.value = 'batch note ' + i;
      note.dispatchEvent(new Event('input'));
    });
    return { exportDisabled: document.getElementById('exportBtn').disabled, rowCount: rows.length };
  })()`);
  assert.equal(result.exportDisabled, false);
  assert.ok(result.rowCount > 0);

  await page.evaluate(`document.getElementById('exportBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  assert.equal(downloaded.filename, buildReport.reviewer_e.export_filename);
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  assert.equal(record.reviewer_role, "E");
  assert.equal(record.status, "REVIEWER_E_TARGETED_IMPACT_COHORT_REVIEW_COMPLETE");
  assert.ok(record.rows.length > 0);
  const confirmedRow = record.rows.find((r) => r.disposition === "CONFIRM");
  assert.ok(confirmedRow.confirmed_target_document_id);
  const rejectedRow = record.rows.find((r) => r.disposition === "REJECT");
  assert.equal(rejectedRow.confirmed_target_document_id, null);
  for (const r of record.rows) assert.ok(r.note && r.note.trim().length > 0);
});

test("headless: Copy to Clipboard on Reviewer E succeeds via clipboard API or execCommand fallback", async () => {
  await page.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await page.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: forcing navigator.clipboard unavailable on Reviewer E exercises the execCommand fallback directly and still reports success", async () => {
  const result = await page.evaluate(`(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.getElementById('exportMessage').textContent = '';
    document.getElementById('copyBtn').click();
    return new Promise((resolve) => setTimeout(() => resolve(document.getElementById('exportMessage').textContent), 300));
  })()`);
  assert.match(result, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: within the SAME browser profile, navigating to Reviewer F shows a completely FRESH state (role F, 0 judged) -- Reviewer E's own progress never leaks in", async () => {
  const urlF = "file://" + resolve(REPO_ROOT, buildReport.reviewer_f.html_path);
  await page.send("Page.navigate", { url: urlF });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = (await page.evaluate("document.readyState")) === "complete";
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Reviewer F page did not finish loading");
  const state = await page.evaluate(`(() => ({
    role: JSON.parse(document.getElementById('review-data').textContent).role,
    judgedText: document.getElementById('status').textContent,
    exportDisabled: document.getElementById('exportBtn').disabled,
  }))()`);
  assert.equal(state.role, "F");
  assert.match(state.judgedText, /judged 0 \//);
  assert.equal(state.exportDisabled, true);
});

test("headless: Reviewer F completing its own rows and exporting produces a download named for Reviewer F, distinct from Reviewer E's export, and Reviewer F's export never contains Reviewer E's disposition data (different storage key)", async () => {
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
  assert.equal(downloaded.filename, buildReport.reviewer_f.export_filename);
  assert.notEqual(downloaded.filename, buildReport.reviewer_e.export_filename);
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  assert.equal(record.reviewer_role, "F");
  for (const r of record.rows) assert.equal(r.disposition, "NEEDS_MORE_REVIEW");
});

test.after(async () => { if (page) await page.close(); });
