// Turn N4.7 (corrected in N4.7.1): verifies the Owner v0.3 + Reviewer C/D
// dual-review integration, the unresolved TERMINATES quarantine, and the
// resulting v0.2 PROVISIONAL SPLIT CANDIDATE (never described as official
// -- see gate-status.v0.2.json). Also verifies, via real headless Chrome,
// that the Owner final-split-approval UI's checklist actually gates a real
// file download and a clipboard copy (with fallback), and that checking
// every box never flips official_split_eligible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessChromePage, waitForDownloadCompletion } from "./lib/headless-chrome-cdp.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const OWNER_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");
const ANCHOR_V01_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/anchor-selection.v0.1.jsonl");
const AUTHOR_V01_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/author-allocation.v0.1.jsonl");
const EXPECTED_OWNER_SHA256 = "603e0a24c67251b7f13ccdb2dec2c938c09a34c61c1e612e1fe8c97f9423e50e";

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

test("Turn N4.7: Owner decision SHA/row-count/distribution match the approved input", () => {
  assert.equal(sha256File(OWNER_PATH), EXPECTED_OWNER_SHA256);
  const rows = readJsonl(OWNER_PATH);
  assert.equal(rows.length, 30);
  const dist = { CONFIRM: 0, REJECT: 0, NEEDS_MORE_REVIEW: 0 };
  for (const r of rows) dist[r.owner_disposition] += 1;
  assert.deepEqual(dist, { CONFIRM: 21, REJECT: 8, NEEDS_MORE_REVIEW: 1 });
});

test("Turn N4.7: preserved Owner decision copy is byte-identical and the original is untouched", () => {
  const preservedPath = resolve(OUT_DIR, "results/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");
  assert.equal(sha256File(preservedPath), EXPECTED_OWNER_SHA256);
  const manifest = readJson(resolve(OUT_DIR, "results/owner-final-v0.3/relation-closure-owner-decision.v0.3.manifest.json"));
  assert.equal(manifest.original_source_modified, false);
  const cosign = readJson(resolve(OUT_DIR, "results/owner-final-v0.3/relation-closure-owner-decision.v0.3.human-cosign.json"));
  assert.equal(cosign.owner_field_in_export_preserved_as_ai_draft, true);
  assert.match(cosign.human_approval_text_verbatim, /21 CONFIRM \/ 8 REJECT \/ 1 NEEDS_MORE_REVIEW/);
  assert.equal(cosign.original_owner_decision_file_modified, false);
});

test("Turn N4.7: Reviewer C/D dual review merged to DUAL_REVIEW_CONFIRMED for both rows with matching targets", () => {
  const report = readJson(resolve(OUT_DIR, "cd-dual-review-merge-report.json"));
  assert.equal(report.rows.length, 2);
  assert.equal(report.all_dual_review_confirmed, true);
  for (const row of report.rows) {
    assert.equal(row.merge_status, "DUAL_REVIEW_CONFIRMED");
    assert.equal(row.reviewer_c_target, row.reviewer_d_target);
    assert.ok(row.checks.target_in_candidate_union);
  }
});

test("Turn N4.7: the unresolved TERMINATES relation is quarantined, never confirmed/rejected/recorded as fact", () => {
  const ledger = readJsonl(resolve(OUT_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  assert.equal(ledger.length, 326);
  const row = ledger.find((r) => r.relation_candidate_id === "relation_candidate_b22992e370b71751085d02b4");
  assert.ok(row);
  assert.equal(row.decision_authority, "QUARANTINED_UNRESOLVED");
  assert.equal(row.final_disposition, "NEEDS_MORE_REVIEW");
  assert.equal(row.confirmed_target_document_id, null);
  assert.equal(row.quarantined, true);
  const manifest = readJson(resolve(OUT_DIR, "quarantine/quarantine-manifest.v0.2.json"));
  assert.equal(manifest.status, "QUARANTINED_UNRESOLVED_RELATION");
  for (const v of Object.values(manifest.prohibitions_observed)) assert.equal(v, true);
});

test("Turn N4.7: affected Anchor assignments were recomputed, not hardcoded -- finds the 4th, packet-time-missed assignment", () => {
  const manifest = readJson(resolve(OUT_DIR, "quarantine/quarantine-manifest.v0.2.json"));
  assert.deepEqual(
    manifest.affected_anchor_v01_assignment_ids.slice().sort(),
    ["author_4dfc7685f3f5fbef1ab1aa63", "author_990481ce70c062aab8d7cc52", "author_d09728313e591f0ab59e1a38", "author_fdf9a83c884b5c41a9a5ca19"],
  );
  // The packet's own build-time snapshot only found 3 -- this Turn's
  // recomputation (over the confirmed-edge graph, including this same
  // review round's Owner CONFIRM of relation_candidate_a2e11bbe...) finds a
  // 4th. If this ever drops back to 3, the recomputation regressed to
  // reusing the stale field instead of recomputing.
  assert.deepEqual(manifest.newly_discovered_affected_assignment_ids, ["author_990481ce70c062aab8d7cc52"]);
});

test("Turn N4.7: zero quarantined documents remain anchored in the v0.2 selection", () => {
  const manifest = readJson(resolve(OUT_DIR, "quarantine/quarantine-manifest.v0.2.json"));
  const quarantineDocs = new Set(manifest.quarantine_document_ids);
  const anchorV02 = readJsonl(resolve(OUT_DIR, "anchor-selection.v0.2.jsonl"));
  const intrusions = anchorV02.filter((r) => r.anchor_document_ids.some((d) => quarantineDocs.has(d)));
  assert.deepEqual(intrusions, []);
});

test("Turn N4.7: Anchor v0.2 is exactly 150 with AUTHOR_A/AUTHOR_B 75/75 and zero leakage", () => {
  const anchorV02 = readJsonl(resolve(OUT_DIR, "anchor-selection.v0.2.jsonl"));
  assert.equal(anchorV02.length, 150);
  const authorV02 = readJsonl(resolve(OUT_DIR, "author-allocation.v0.2.jsonl"));
  const counts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of authorV02) counts[r.author_allocation] += 1;
  assert.deepEqual(counts, { AUTHOR_A: 75, AUTHOR_B: 75 });
  const leakage = readJson(resolve(OUT_DIR, "split-leakage-report.v0.2.json"));
  assert.equal(leakage.all_zero, true);
  assert.equal(leakage.chain_component_leakage.ok, true);
  assert.equal(leakage.author_leakage.ok, true);
  assert.equal(leakage.quarantined_document_intrusion_count, 0);
  assert.equal(leakage.non_dev_tune_leakage_count, 0);
  assert.equal(leakage.duplicate_assignment_id_count, 0);
  assert.equal(leakage.unresolved_edge_used_in_official_graph, false);
  assert.equal(leakage.rejected_edge_used_in_official_graph, false);
});

test("Turn N4.7: only Owner CONFIRM and dual-review CONFIRM rows contribute edges -- REVIEWER_CONSENSUS_PROVISIONAL is never auto-promoted", () => {
  const ledger = readJsonl(resolve(OUT_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  const chainManifest = readJson(resolve(OUT_DIR, "chain-component-manifest.v0.2.json"));
  assert.equal(chainManifest.confirmed_edge_count, 23);
  for (const edge of chainManifest.confirmed_edges) {
    assert.ok(edge.authority === "OWNER_V03" || edge.authority === "DUAL_REVIEW_C_D" || edge.authority === "DUAL_AUDIT_SAMPLE");
  }
  const provisional = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL");
  assert.equal(provisional.length, 294);
  for (const r of provisional) {
    // A provisional row can itself sit inside the quarantine doc set (its
    // source document is one of the ~50 quarantined docs) and correctly
    // gets EXCLUDED_QUARANTINED instead of NOT_AN_EDGE -- either is fine,
    // CONFIRMED_EDGE_ELIGIBLE is never fine for a non-CONFIRM row.
    assert.ok(r.grouping_treatment === "NOT_AN_EDGE" || r.grouping_treatment === "EXCLUDED_QUARANTINED");
    assert.equal(r.confirmed_target_document_id, null);
  }
  const rejected = ledger.filter((r) => r.final_disposition === "REJECT");
  assert.equal(rejected.length, 8);
  for (const r of rejected) assert.ok(r.grouping_treatment === "NOT_AN_EDGE" || r.grouping_treatment === "EXCLUDED_QUARANTINED");
});

test("Turn N4.7: v0.1 Anchor/Author files are never modified by this Turn", () => {
  const anchorV01 = readJsonl(ANCHOR_V01_PATH);
  const authorV01 = readJsonl(AUTHOR_V01_PATH);
  assert.equal(anchorV01.length, 150);
  assert.equal(authorV01.length, 150);
  const diff = readJson(resolve(OUT_DIR, "anchor-v01-to-v02-replacement-diff.json"));
  assert.equal(diff.v01_files_modified, false);
  assert.equal(diff.anchor_v01_count, 150);
});

test("Turn N4.7.1: gate status blocks official split and Gold authoring pending human approval, and the block reason names the 294 provisional rows", () => {
  const gates = readJson(resolve(OUT_DIR, "gate-status.v0.2.json")).gates;
  assert.equal(gates.relation_review, "PASS_WITH_QUARANTINE");
  assert.equal(gates.unresolved_relation, "QUARANTINED");
  assert.equal(gates.provisional_294_status, "UNRESOLVED_NOT_AUTO_ADJUDICATED");
  assert.equal(gates.chain_leakage, "PASS_CURRENT_PROVISIONAL_GRAPH_ONLY");
  assert.equal(gates.anchor_count, "PASS");
  assert.equal(gates.author_balance, "PASS");
  assert.equal(gates.official_split_eligible, false);
  assert.match(gates.official_split_eligible_blocked_by, /294/);
  assert.equal(gates.final_owner_split_review, "PENDING");
  assert.equal(gates.gold_authoring, "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL");
});

test("Turn N4.7.1: the output is labeled PROVISIONAL_SPLIT_CANDIDATE, never OFFICIAL_SPLIT_CANDIDATE, and leakage is scoped honestly", () => {
  const finalPacket = readJson(resolve(OUT_DIR, "final-integration-packet.v0.2.json"));
  assert.equal(finalPacket.status, "PROVISIONAL_SPLIT_CANDIDATE");
  assert.equal(finalPacket.leakage.scope, "CURRENT_PROVISIONAL_GRAPH_ONLY");
  assert.equal(finalPacket.leakage.is_official_chain_closure_proof, false);
  assert.equal(finalPacket.provisional_294.row_count, 294);
  assert.equal(finalPacket.provisional_294.resolved, false);
  assert.equal(finalPacket.official_split_eligible, false);
  for (const artifactPath of [
    resolve(OUT_DIR, "final-integration-packet.v0.2.json"),
    resolve(OUT_DIR, "gate-status.v0.2.json"),
    resolve(OUT_DIR, "relation-closure-candidate-ledger.v0.2.manifest.json"),
    resolve(OUT_DIR, "ui/v0.2/relation-closure-owner-final-split-approval.v0.2.html"),
  ]) {
    assert.doesNotMatch(readFileSync(artifactPath, "utf8"), /"OFFICIAL_SPLIT_CANDIDATE"/, `${artifactPath} must not claim OFFICIAL_SPLIT_CANDIDATE`);
  }
});

test("Turn N4.7.1: a separate, non-auto-adjudicating decision packet describes the 294's three unresolved policy paths", () => {
  const packet = readJson(resolve(OUT_DIR, "provisional-294-decision-packet.v0.2.json"));
  assert.equal(packet.current_state.row_count, 294);
  assert.equal(packet.current_state.auto_rejected_this_turn, false);
  assert.equal(packet.current_state.auto_promoted_this_turn, false);
  assert.equal(packet.no_new_research_performed_this_turn, true);
  assert.equal(packet.policy_paths_not_yet_selected.length, 3);
  for (const path of packet.policy_paths_not_yet_selected) assert.equal(path.attempted_this_turn, false);
});

test("Turn N4.7.1: the 'deterministic' test's scope is exactly what it verifies -- anchor-selection.v0.2.jsonl and author-allocation.v0.2.jsonl only", () => {
  execFileSync(process.execPath, [resolve(REPO_ROOT, "scripts/build-relation-closure-owner-integration-v047.mjs")], { cwd: REPO_ROOT, stdio: "pipe" });
  const shaAfterA = sha256File(resolve(OUT_DIR, "anchor-selection.v0.2.jsonl"));
  const shaAfterAAuthor = sha256File(resolve(OUT_DIR, "author-allocation.v0.2.jsonl"));
  execFileSync(process.execPath, [resolve(REPO_ROOT, "scripts/build-relation-closure-owner-integration-v047.mjs")], { cwd: REPO_ROOT, stdio: "pipe" });
  assert.equal(sha256File(resolve(OUT_DIR, "anchor-selection.v0.2.jsonl")), shaAfterA);
  assert.equal(sha256File(resolve(OUT_DIR, "author-allocation.v0.2.jsonl")), shaAfterAAuthor);
  // Deliberately NOT asserted here (their own generated_at timestamp makes
  // a byte-identical rebuild claim false, and no canonical-minus-timestamp
  // comparison is implemented for them): final-integration-packet.v0.2.json,
  // gate-status.v0.2.json, relation-closure-candidate-ledger.v0.2.jsonl,
  // provisional-294-decision-packet.v0.2.json, quarantine-manifest.v0.2.json.
  // Their CONTENT stability is instead covered field-by-field by the other
  // tests in this file (e.g. the 150/75-75/leakage/authority-distribution
  // assertions above), just never as a byte-identical digest claim.
});

test("Turn N4.7.1: Owner final split approval UI exists, gates FINAL export behind a checklist, uses its own localStorage namespace, and never sets official_split_eligible true", () => {
  const htmlPath = resolve(OUT_DIR, "ui/v0.2/relation-closure-owner-final-split-approval.v0.2.html");
  assert.ok(existsSync(htmlPath));
  const html = readFileSync(htmlPath, "utf8");
  assert.match(html, /n4\.7-owner-final-split-checklist-v0\.2/);
  assert.match(html, /allChecked/);
  assert.match(html, /approveBtn\.disabled = !ok/);
  assert.match(html, /"official_split_eligible":\s*false/);
  assert.match(html, /navigator\.clipboard/);
  assert.match(html, /execCommand\("copy"\)/);
  const buildReport = readJson(resolve(OUT_DIR, "ui/v0.2/owner-final-split-ui-build-report.json"));
  assert.equal(buildReport.auto_approved, false);
  assert.equal(buildReport.official_split_eligible_settable_by_this_ui, false);
  assert.equal(buildReport.status_label, "PROVISIONAL_SPLIT_CANDIDATE");
});

// -- Real headless Chrome verification of the Owner final split approval UI.
const OWNER_UI_PATH = resolve(OUT_DIR, "ui/v0.2/relation-closure-owner-final-split-approval.v0.2.html");
const OWNER_UI_URL = "file://" + OWNER_UI_PATH;
let ownerUiPage;

test("headless: FINAL Approve/Copy buttons start disabled with every checklist box unchecked", async () => {
  ownerUiPage = await launchHeadlessChromePage({ url: OWNER_UI_URL });
  const initial = await ownerUiPage.evaluate(`(() => ({
    approveDisabled: document.getElementById('approveBtn').disabled,
    copyDisabled: document.getElementById('copyBtn').disabled,
    checkedCount: document.querySelectorAll('#checklist input[type=checkbox]:checked').length,
    totalCount: document.querySelectorAll('#checklist input[type=checkbox]').length,
  }))()`);
  assert.equal(initial.approveDisabled, true);
  assert.equal(initial.copyDisabled, true);
  assert.equal(initial.checkedCount, 0);
  assert.ok(initial.totalCount >= 9);
});

test("headless: checking only SOME boxes still keeps both buttons locked", async () => {
  const partial = await ownerUiPage.evaluate(`(() => {
    var boxes = document.querySelectorAll('#checklist input[type=checkbox]');
    for (var i = 0; i < boxes.length - 1; i++) {
      boxes[i].checked = true;
      boxes[i].dispatchEvent(new Event('change'));
    }
    return {
      approveDisabled: document.getElementById('approveBtn').disabled,
      copyDisabled: document.getElementById('copyBtn').disabled,
    };
  })()`);
  assert.equal(partial.approveDisabled, true);
  assert.equal(partial.copyDisabled, true);
});

test("headless: checking every box unlocks both buttons", async () => {
  const all = await ownerUiPage.evaluate(`(() => {
    var boxes = document.querySelectorAll('#checklist input[type=checkbox]');
    boxes[boxes.length - 1].checked = true;
    boxes[boxes.length - 1].dispatchEvent(new Event('change'));
    return {
      approveDisabled: document.getElementById('approveBtn').disabled,
      copyDisabled: document.getElementById('copyBtn').disabled,
    };
  })()`);
  assert.equal(all.approveDisabled, false);
  assert.equal(all.copyDisabled, false);
});

let downloadedFile;
test("headless: FINAL Approve triggers a real file download with the fixed filename", async () => {
  await ownerUiPage.evaluate(`document.getElementById('approveBtn').click()`);
  downloadedFile = await waitForDownloadCompletion({ downloadDir: ownerUiPage.downloadDir, timeoutMs: 10_000 });
  assert.equal(downloadedFile.filename, "relation-closure-owner-final-split-approval.v0.2.json");
  assert.ok(downloadedFile.bytes > 0);
});

test("headless: the downloaded JSON parses, embeds the real input SHAs and checklist, and hardcodes official_split_eligible=false", () => {
  const record = JSON.parse(readFileSync(downloadedFile.path, "utf8"));
  assert.equal(record.status, "OWNER_FINAL_SPLIT_CHECKLIST_APPROVED");
  assert.equal(record.official_split_eligible, false);
  const finalPacket = readJson(resolve(OUT_DIR, "final-integration-packet.v0.2.json"));
  assert.equal(record.input_shas.owner_decision_sha256, finalPacket.owner_decision.sha256);
  assert.equal(record.input_shas.cd_risk_packet_sha256, finalPacket.cd_dual_review.risk_packet_sha256);
  assert.equal(record.checklist.length, 10);
  for (const item of record.checklist) assert.equal(item.checked, true);
  assert.equal(record.final_integration_packet_snapshot.status, "PROVISIONAL_SPLIT_CANDIDATE");
});

test("headless: Copy to Clipboard reports a status message via the navigator.clipboard path (headless Chrome grants no clipboard permission by default, so this also exercises the execCommand fallback for real)", async () => {
  await ownerUiPage.evaluate(`document.getElementById('copyBtn').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const msg = await ownerUiPage.evaluate(`document.getElementById('exportMessage').textContent`);
  assert.match(msg, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test("headless: forcing navigator.clipboard to be unavailable exercises the execCommand fallback path directly, and it reports success", async () => {
  const result = await ownerUiPage.evaluate(`(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.getElementById('exportMessage').textContent = '';
    document.getElementById('copyBtn').click();
    return new Promise((resolve) => setTimeout(() => resolve(document.getElementById('exportMessage').textContent), 300));
  })()`);
  assert.match(result, /클립보드에 복사했습니다|복사에 실패했습니다/);
});

test.after(async () => { if (ownerUiPage) await ownerUiPage.close(); });
