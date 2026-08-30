// Turn N4.11: verifies the Reviewer E/F consensus overlay, prospective
// graph recompute, and Owner batch-ratification UI build
// (scripts/build-relation-closure-priority-wave-1-consensus-v0411.mjs)
// against the REAL corpus. Per this repo's established convention, "never
// modifies a sibling artifact" is proven via a STATIC write-scope scan of
// the build script's source, never a live before/after hash comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-relation-closure-priority-wave-1-consensus-v0411.mjs");
const DR_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/decision-respecting-graph-v0.1");
const PW1_DIR = resolve(DR_DIR, "priority-wave-1-v0.1");
const CONSENSUS_DIR = resolve(PW1_DIR, "consensus-integration-v0.1");
const UI_DIR = resolve(CONSENSUS_DIR, "ui/v0.1");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
async function clearDownloadDir(dir) {
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(entries.map((name) => rm(path.join(dir, name), { force: true })));
}

test.before(() => {
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

// -- Static write-scope proof -----------------------------------------------
test("Turn N4.11: static proof -- every write call targets only consensus-integration-v0.1/, never a Reviewer E/F results file, the Wave 1 packet, or any N4.9 sibling path", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const CONSENSUS_DIR = resolve\(PW1_DIR, "consensus-integration-v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeJsonl|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 8, `expected at least 8 write call sites, found ${targets.length}`);
  const allowedPrefixes = ["resolve(CONSENSUS_DIR", "resolve(uiDir", "consensusLedgerPath", "prospectiveImpactReportPath", "wave2PacketPath", "htmlPath"];
  for (const t of targets) assert.ok(allowedPrefixes.some((p) => t.startsWith(p)), `write target "${t}" is not provably CONSENSUS_DIR-rooted`);
  assert.match(source, /const uiDir = resolve\(CONSENSUS_DIR, "ui\/v0\.1"\)/);
  for (const varName of ["consensusLedgerPath", "prospectiveImpactReportPath", "wave2PacketPath", "htmlPath"]) {
    if (targets.includes(varName)) assert.match(source, new RegExp(`const ${varName} = resolve\\((CONSENSUS_DIR|uiDir),`));
  }
  // Note: a secondary "no forbidden literal near the write call" scan was
  // considered here, but the consensus/verification manifests legitimately
  // EMBED the real input file paths (packet/Reviewer E/F/etc.) as metadata
  // fields describing what was READ -- those are data, not write targets,
  // and a substring scan cannot tell the two apart reliably. The captured-
  // target allowlist check above is the actual proof; it already verifies
  // every real fs write() call's own path argument is CONSENSUS_DIR-rooted.
});

// -- E/F exact agreement mechanical verification ----------------------------
test("Turn N4.11: E/F 13-row exact agreement is mechanically verified (disposition AND target), matching the real corpus's known 6/7/0 distribution", () => {
  const eDecisions = readJsonl(resolve(PW1_DIR, "results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl"));
  const fDecisions = readJsonl(resolve(PW1_DIR, "results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl"));
  assert.equal(eDecisions.length, 13);
  assert.equal(fDecisions.length, 13);
  const eById = new Map(eDecisions.map((d) => [d.relation_candidate_id, d]));
  let agree = 0;
  const dist = { CONFIRM: 0, REJECT: 0, NEEDS_MORE_REVIEW: 0 };
  for (const f of fDecisions) {
    const e = eById.get(f.relation_candidate_id);
    if (e && e.owner_disposition === f.owner_disposition && e.confirmed_target_document_id === f.confirmed_target_document_id) {
      agree += 1;
      dist[e.owner_disposition] += 1;
    }
  }
  assert.equal(agree, 13);
  assert.deepEqual(dist, { CONFIRM: 6, REJECT: 7, NEEDS_MORE_REVIEW: 0 });

  const report = readJson(resolve(CONSENSUS_DIR, "priority-wave-1-consensus-verification-report.v0.1.json"));
  assert.equal(report.all_checks_passed, true);
  assert.equal(report.agreement_summary.exact_agreement, 13);
  assert.equal(report.agreement_summary.disagreement, 0);
  for (const [check, passed] of Object.entries(report.checks)) assert.equal(passed, true, `check ${check} must pass`);
});

test("Turn N4.11: target-level agreement is 13/13 (never just disposition-level)", () => {
  const manifest = readJson(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.manifest.json"));
  assert.equal(manifest.exact_agreement_count, 13);
  assert.equal(manifest.total_count, 13);
  assert.equal(manifest.disagreement_count, 0);
  assert.deepEqual(manifest.distribution, { CONFIRM: 6, REJECT: 7, NEEDS_MORE_REVIEW: 0 });
});

test("Turn N4.11: consensus ledger has exactly 13 rows, zero duplicate ids, and is never mislabeled as an official approval", () => {
  const rows = readJsonl(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.jsonl"));
  assert.equal(rows.length, 13);
  assert.equal(new Set(rows.map((r) => r.relation_candidate_id)).size, 13);
  for (const r of rows) {
    assert.equal(r.consensus_status, "DUAL_REVIEW_CONSENSUS_PENDING_OWNER");
    assert.equal(r.official_relation_status, "NOT_YET_OWNER_APPROVED");
    assert.equal(r.auto_promoted_to_official_relation, false);
    assert.equal(r.official_split_eligible, false);
    assert.ok(r.reviewer_e.disposition);
    assert.ok(r.reviewer_f.disposition);
    assert.equal(r.reviewer_e.disposition, r.reviewer_f.disposition);
    assert.equal(r.reviewer_e.confirmed_target_document_id, r.reviewer_f.confirmed_target_document_id);
  }
  const confirmRows = rows.filter((r) => r.consensus_disposition === "CONFIRM");
  const rejectRows = rows.filter((r) => r.consensus_disposition === "REJECT");
  assert.equal(confirmRows.length, 6);
  assert.equal(rejectRows.length, 7);
  for (const r of confirmRows) assert.ok(r.consensus_target_document_id);
  for (const r of rejectRows) assert.equal(r.consensus_target_document_id, null);
});

// -- Prospective graph overlay correctness -----------------------------------
test("Turn N4.11: prospective graph overlay -- each CONFIRM consensus row contributes EXACTLY ONE edge (the consensus target), each REJECT contributes ZERO", () => {
  const edges = readJsonl(resolve(CONSENSUS_DIR, "prospective-graph-edges-after-wave1.v0.1.jsonl"));
  const consensusRows = readJsonl(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.jsonl"));
  for (const r of consensusRows) {
    const rowEdges = edges.filter((e) => e.relation_candidate_id === r.relation_candidate_id);
    if (r.consensus_disposition === "CONFIRM") {
      assert.equal(rowEdges.length, 1);
      assert.equal(rowEdges[0].target_document_id, r.consensus_target_document_id);
    } else if (r.consensus_disposition === "REJECT") {
      assert.equal(rowEdges.length, 0);
    }
  }
});

test("Turn N4.12 regression guard: the Owner ratification UI's embedded prospective_graph_report_sha256 is a CANONICAL (generated_at-excluded) digest, stable across reruns -- a raw file hash here would make every downloaded Owner decision go stale on the very next test run", () => {
  function canonicalSha256(obj, omitKeys = []) {
    const clone = { ...obj };
    for (const k of omitKeys) delete clone[k];
    return createHash("sha256").update(JSON.stringify(clone, Object.keys(clone).sort())).digest("hex");
  }
  const reportPath = resolve(CONSENSUS_DIR, "prospective-graph-impact-after-wave1.v0.1.json");
  const before = readJson(reportPath);
  const canonicalBefore = canonicalSha256(before, ["generated_at"]);
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = readJson(reportPath);
  const canonicalAfter = canonicalSha256(after, ["generated_at"]);
  assert.notEqual(before.generated_at, after.generated_at, "the rerun must actually regenerate generated_at, otherwise this test proves nothing");
  assert.equal(canonicalBefore, canonicalAfter, "canonical content must be stable across reruns");

  const html = readFileSync(resolve(UI_DIR, "priority-wave-1-owner-ratification.html"), "utf8");
  const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/);
  const embeddedData = JSON.parse(match[1]);
  assert.equal(embeddedData.prospective_graph_report_sha256, canonicalAfter, "the UI must embed the CANONICAL digest, not a raw file hash");
});

test("Turn N4.11: the remaining 281 provisional rows are NEVER auto-adjudicated -- their prospective edges still cover ALL their real packet candidates, unchanged from N4.9's rule", () => {
  const packet326 = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl"));
  const ledger = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl"));
  const consensusIds = new Set(readJsonl(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.jsonl")).map((r) => r.relation_candidate_id));
  const provisionalIds = new Set(ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").map((r) => r.relation_candidate_id));
  const remaining281Ids = [...provisionalIds].filter((id) => !consensusIds.has(id));
  assert.equal(remaining281Ids.length, 281);
  const edges = readJsonl(resolve(CONSENSUS_DIR, "prospective-graph-edges-after-wave1.v0.1.jsonl"));
  const packetById = new Map(packet326.map((r) => [r.relation_candidate_id, r]));
  for (const id of remaining281Ids) {
    const rowEdges = edges.filter((e) => e.relation_candidate_id === id);
    const realCandidateCount = (packetById.get(id)?.candidates ?? []).length;
    assert.equal(rowEdges.length, realCandidateCount, `row ${id} must still contribute ALL its real candidates, not a subset -- proves no auto-adjudication happened`);
  }
});

test("Turn N4.11: Owner REJECT (8 rows) and the quarantined row contribute ZERO edges in the prospective graph too -- never re-activated", () => {
  const ledger = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/relation-closure-candidate-ledger.v0.2.jsonl"));
  const edges = readJsonl(resolve(CONSENSUS_DIR, "prospective-graph-edges-after-wave1.v0.1.jsonl"));
  const rejectIds = ledger.filter((r) => r.decision_authority === "OWNER_V03" && r.final_disposition === "REJECT").map((r) => r.relation_candidate_id);
  assert.equal(rejectIds.length, 8);
  const quarantinedIds = ledger.filter((r) => r.decision_authority === "QUARANTINED_UNRESOLVED").map((r) => r.relation_candidate_id);
  assert.equal(quarantinedIds.length, 1);
  for (const id of [...rejectIds, ...quarantinedIds]) {
    assert.equal(edges.filter((e) => e.relation_candidate_id === id).length, 0);
  }
  const quarantineManifest = readJson(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/quarantine/quarantine-manifest.v0.2.json"));
  assert.equal(quarantineManifest.quarantine_document_count, 50);
});

test("Turn N4.11: leakage and component counts are computed for real (not fabricated), and the N4.9->N4.11 diff is internally consistent", () => {
  const diff = readJson(resolve(CONSENSUS_DIR, "n4.9-to-n4.11-graph-diff.v0.1.json"));
  assert.equal(diff.n49.total_candidate_edge_count, 1483);
  assert.equal(diff.n411.total_candidate_edge_count, diff.n49.total_candidate_edge_count + diff.deltas.total_candidate_edge_count_delta);
  assert.ok(diff.deltas.wave1_edges_removed > 0, "resolving 7 REJECT + narrowing 6 CONFIRM rows to single edges must remove SOME edges vs the fully-provisional N4.9 baseline");
  assert.equal(diff.n411.split_violation_count, diff.n49.split_violation_count + diff.deltas.split_violation_count_delta);
  assert.equal(diff.n411.author_violation_count, diff.n49.author_violation_count + diff.deltas.author_violation_count_delta);
  assert.ok(diff.n411.split_violation_count <= diff.n49.split_violation_count, "resolving real edges should never INCREASE split leakage");
  assert.ok(diff.n411.author_violation_count <= diff.n49.author_violation_count, "resolving real edges should never INCREASE author leakage");
});

// -- Gate branch verification -------------------------------------------
test("Turn N4.11: gate-status-after-wave1.v0.1.json reflects the ACTUAL computed leakage state, official_split_eligible is always false", () => {
  const gate = readJson(resolve(CONSENSUS_DIR, "gate-status-after-wave1.v0.1.json"));
  const impact = readJson(resolve(CONSENSUS_DIR, "prospective-graph-impact-after-wave1.v0.1.json"));
  assert.equal(gate.official_split_eligible, false);
  if (impact.all_zero_prospective_leakage) {
    assert.equal(gate.status, "PROSPECTIVE_LEAKAGE_FREE_PENDING_OWNER_RATIFICATION");
    assert.equal(gate.gold_authoring_status, "BLOCKED_PENDING_WAVE1_OWNER_RATIFICATION");
    assert.equal(gate.wave2_created, false);
  } else {
    assert.equal(gate.status, "LEAKAGE_REMAINS_AFTER_PRIORITY_WAVE_1");
    assert.equal(gate.gold_authoring_status, "BLOCKED_PENDING_NEXT_PRIORITY_WAVE");
    assert.equal(gate.wave2_created, true);
  }
});

test("Turn N4.11: Wave 2 candidate branch -- if generated, the union is computed dynamically (never hardcoded), no Reviewer UI exists, and the packet is a real subset of the remaining 281 rows", () => {
  const gate = readJson(resolve(CONSENSUS_DIR, "gate-status-after-wave1.v0.1.json"));
  const wave2PacketPath = resolve(CONSENSUS_DIR, "priority-wave-2-candidate-packet.v0.1.jsonl");
  if (!gate.wave2_created) {
    assert.equal(existsSync(wave2PacketPath), false);
    return;
  }
  const wave2Manifest = readJson(resolve(CONSENSUS_DIR, "priority-wave-2-candidate-packet.v0.1.manifest.json"));
  assert.equal(wave2Manifest.reviewer_ui_created_this_turn, false);
  assert.equal(wave2Manifest.remaining_281_not_all_auto_reviewed, true);
  assert.doesNotMatch(JSON.stringify(wave2Manifest), /minimum set|smallest possible set has been proven|proven minimal/i);
  const wave2Rows = readJsonl(wave2PacketPath);
  assert.equal(wave2Rows.length, wave2Manifest.union_count);
  const consensusIds = new Set(readJsonl(resolve(CONSENSUS_DIR, "priority-wave-1-dual-review-consensus.v0.1.jsonl")).map((r) => r.relation_candidate_id));
  for (const row of wave2Rows) {
    assert.equal(row.owner_disposition, "PENDING");
    assert.equal(row.confirmed_target_document_id, null);
    assert.ok(!consensusIds.has(row.relation_candidate_id), "Wave 2 must never re-select a Wave 1 row");
  }
  assert.doesNotMatch(JSON.stringify(readFileSync(resolve(REPO_ROOT, "scripts/build-relation-closure-priority-wave-1-consensus-v0411.mjs"), "utf8")), /reviewer-g|reviewer-h/i, "no Wave 2 Reviewer UI must be referenced anywhere in this script");
});

// -- Existing artifact preservation -------------------------------------
test("Turn N4.11: N4.9/N4.10 artifacts' content invariants are unchanged (row counts, key SHAs) -- read-only inputs, never modified", () => {
  const packet13 = readJsonl(resolve(PW1_DIR, "priority-wave-1-review-packet.v0.1.jsonl"));
  assert.equal(packet13.length, 13);
  const eDecisionSha = createHash("sha256").update(readFileSync(resolve(PW1_DIR, "results/reviewer-e-v0.1/priority-wave-1-reviewer-e-decision.v0.1.jsonl"))).digest("hex");
  assert.equal(eDecisionSha, "6dab48af2204ed8c4ffe45a1002c1f9478e1fd36d2c8c1e41e2fa00e962a72e1");
  const fDecisionSha = createHash("sha256").update(readFileSync(resolve(PW1_DIR, "results/reviewer-f-v0.1/priority-wave-1-reviewer-f-decision.v0.1.jsonl"))).digest("hex");
  assert.equal(fDecisionSha, "6c93be0bb35f5da15f4bc1146198e8e7cb98334310929160b370837f303c7d49");
  const targeted231 = readJsonl(resolve(DR_DIR, "targeted-provisional-relation-review-packet.v0.1.jsonl"));
  assert.equal(targeted231.length, 231);
});

test("Turn N4.11: Candidate Pool 500 / Anchor 150 / AUTHOR_A 75 / AUTHOR_B 75 remain unchanged", () => {
  const pool = readJsonl(resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl"));
  assert.equal(pool.length, 500);
  const anchor = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/anchor-selection.v0.2.jsonl"));
  assert.equal(anchor.length, 150);
  const author = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/author-allocation.v0.2.jsonl"));
  const counts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of author) counts[r.author_allocation] += 1;
  assert.deepEqual(counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
});

test("Turn N4.11: v0.20 release assets and the 25-question answer set remain untouched by this Turn's script", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /v0\.20|seed-harness|question_seed_v07/i);
});

// -- Owner ratification UI: static checks ------------------------------
test("Turn N4.11: Owner ratification UI build report and HTML exist, and export/consensus fields never set official_split_eligible/gold_authoring_authorized to true", () => {
  const buildReport = readJson(resolve(UI_DIR, "priority-wave-1-owner-ratification-ui-build-report.json"));
  assert.equal(buildReport.auto_approved, false);
  assert.equal(buildReport.official_split_eligible_settable_by_this_ui, false);
  assert.equal(buildReport.gold_authoring_authorized_settable_by_this_ui, false);
  const html = readFileSync(resolve(UI_DIR, "priority-wave-1-owner-ratification.html"), "utf8");
  assert.match(html, /official_split_eligible:\s*false/);
  assert.match(html, /gold_authoring_authorized:\s*false/);
  assert.match(html, /APPROVE_DUAL_REVIEW_CONSENSUS/);
  assert.match(html, /FIX_REQUIRED/);
  assert.match(html, /REJECT_BATCH/);
});

// -- Real headless Chrome verification of the Owner ratification UI -------
let buildReport;
let page;
test.before(() => { buildReport = readJson(resolve(UI_DIR, "priority-wave-1-owner-ratification-ui-build-report.json")); });

test("headless: Owner ratification page starts with no choice selected and both buttons locked", async () => {
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
    document.querySelector('input[value="APPROVE_DUAL_REVIEW_CONSENSUS"]').checked = true;
    document.querySelector('input[value="APPROVE_DUAL_REVIEW_CONSENSUS"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerName').value = 'Evaluation Owner';
    document.getElementById('ownerName').dispatchEvent(new Event('input'));
    var boxes = document.querySelectorAll('#approveChecklist input[type=checkbox]');
    for (var i = 0; i < boxes.length - 1; i++) { boxes[i].checked = true; boxes[i].dispatchEvent(new Event('change')); }
    return { downloadDisabled: document.getElementById('downloadBtn').disabled, checklistVisible: !document.getElementById('approveChecklist').hidden, totalBoxes: boxes.length };
  })()`);
  assert.equal(result.checklistVisible, true);
  assert.ok(result.totalBoxes >= 8);
  assert.equal(result.downloadDisabled, true, "N-1 of N checklist items checked must still lock the button");
});

test("headless: checking the FINAL checklist item unlocks download/copy, and a real JSON download is produced with all required fields", async () => {
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
  assert.equal(downloaded.filename, "priority-wave-1-owner-ratification-decision.v0.1.json");
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  for (const field of ["schema_version", "decision_id", "owner", "decided_at", "owner_disposition", "owner_note", "consensus_manifest_path", "consensus_manifest_sha256", "reviewer_e_decision_path", "reviewer_e_decision_sha256", "reviewer_f_decision_path", "reviewer_f_decision_sha256", "reviewed_relation_candidate_ids", "confirm_count", "reject_count", "needs_more_review_count", "prospective_graph_report_path", "prospective_graph_report_sha256", "official_split_eligible", "gold_authoring_authorized"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(record, field), `decision record missing required field: ${field}`);
  }
  assert.equal(record.owner_disposition, "APPROVE_DUAL_REVIEW_CONSENSUS");
  assert.equal(record.official_split_eligible, false);
  assert.equal(record.gold_authoring_authorized, false);
  assert.equal(record.confirm_count, 6);
  assert.equal(record.reject_count, 7);
  assert.equal(record.needs_more_review_count, 0);
  assert.equal(record.reviewed_relation_candidate_ids.length, 13);
  assert.equal(record.reviewer_e_decision_sha256, "6dab48af2204ed8c4ffe45a1002c1f9478e1fd36d2c8c1e41e2fa00e962a72e1");
  assert.equal(record.reviewer_f_decision_sha256, "6c93be0bb35f5da15f4bc1146198e8e7cb98334310929160b370837f303c7d49");
});

test("headless: Copy to Clipboard succeeds via clipboard API or execCommand fallback", async () => {
  await page.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await page.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: switching to FIX_REQUIRED with an empty owner_note keeps the button locked; filling the note unlocks it, and the exported record's owner_disposition/owner_note update accordingly", async () => {
  await page.evaluate(`(() => {
    document.querySelector('input[value="FIX_REQUIRED"]').checked = true;
    document.querySelector('input[value="FIX_REQUIRED"]').dispatchEvent(new Event('change'));
    document.getElementById('ownerNote').value = '';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const lockedState = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(lockedState, true, "FIX_REQUIRED with empty owner_note must stay locked");

  await page.evaluate(`(() => {
    document.getElementById('ownerNote').value = 'Row X needs re-check of candidate score.';
    document.getElementById('ownerNote').dispatchEvent(new Event('input'));
  })()`);
  const unlockedState = await page.evaluate(`document.getElementById('downloadBtn').disabled`);
  assert.equal(unlockedState, false);

  await clearDownloadDir(page.downloadDir);
  await page.evaluate(`document.getElementById('downloadBtn').click()`);
  const downloaded = await waitForDownloadCompletion({ downloadDir: page.downloadDir, timeoutMs: 15_000 });
  const record = JSON.parse(readFileSync(downloaded.path, "utf8"));
  assert.equal(record.owner_disposition, "FIX_REQUIRED");
  assert.equal(record.owner_note, "Row X needs re-check of candidate score.");
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
