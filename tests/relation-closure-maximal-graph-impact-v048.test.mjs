// Turn N4.8: verifies the Path 2 conservative-maximal-plausible-graph
// mechanical impact analysis (scripts/build-relation-closure-maximal-graph-
// impact-v048.mjs) against the REAL corpus artifacts -- and, critically,
// that it never modifies any Turn N4.7/N4.7.1 artifact, never adjudicates any
// of the 294 REVIEWER_CONSENSUS_PROVISIONAL rows, and never sets
// official_split_eligible to true regardless of the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMaximalPlausibleGraph, computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact } from "../domain/evaluation/relation-closure-maximal-graph.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const OUT_DIR = resolve(V02_DIR, "maximal-graph-v0.1");
const PACKET_326_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const LEDGER_V02_PATH = resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl");
const FINAL_INTEGRATION_PACKET_V02_PATH = resolve(V02_DIR, "final-integration-packet.v0.2.json");
const GATE_STATUS_V02_PATH = resolve(V02_DIR, "gate-status.v0.2.json");
const SPLIT_LEAKAGE_V02_PATH = resolve(V02_DIR, "split-leakage-report.v0.2.json");
const QUARANTINE_MANIFEST_PATH = resolve(V02_DIR, "quarantine/quarantine-manifest.v0.2.json");
const OWNER_DECISION_PATH = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3/inputs/owner-final-v0.3/relation-closure-owner-decision.v0.3.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

const PROTECTED_ARTIFACTS = [PACKET_326_PATH, POOL_PATH, ANCHOR_V02_PATH, AUTHOR_V02_PATH, LEDGER_V02_PATH, FINAL_INTEGRATION_PACKET_V02_PATH, GATE_STATUS_V02_PATH, SPLIT_LEAKAGE_V02_PATH, QUARANTINE_MANIFEST_PATH, OWNER_DECISION_PATH];

let shasBefore;
test.before(() => {
  shasBefore = PROTECTED_ARTIFACTS.map((p) => sha256File(p));
  execFileSync(process.execPath, [resolve(REPO_ROOT, "scripts/build-relation-closure-maximal-graph-impact-v048.mjs")], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.8: every Turn N4.7/N4.7.1 artifact this script reads is byte-identical before and after -- nothing is overwritten", () => {
  const shasAfter = PROTECTED_ARTIFACTS.map((p) => sha256File(p));
  assert.deepEqual(shasAfter, shasBefore);
});

test("Turn N4.8: the maximal graph includes EVERY one of the 326 packet's candidate edges (2,151), never a top-candidate-only subset", () => {
  const packet326 = readJsonl(PACKET_326_PATH);
  assert.equal(packet326.length, 326);
  const expectedEdgeCount = packet326.reduce((sum, r) => sum + (r.candidates ?? []).length, 0);
  const components = readJson(resolve(OUT_DIR, "maximal-graph-components.v0.1.json"));
  assert.equal(components.total_candidate_edge_count, expectedEdgeCount);
  const edgeLines = readFileSync(resolve(OUT_DIR, "maximal-graph-edges.v0.1.jsonl"), "utf8").trim().split("\n");
  assert.equal(edgeLines.length, expectedEdgeCount);
});

test("Turn N4.8: the maximal graph unions REJECT and REVIEWER_CONSENSUS_PROVISIONAL candidates too -- disposition is never read", () => {
  const ledger = readJsonl(LEDGER_V02_PATH);
  const provisionalCount = ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length;
  const rejectCount = ledger.filter((r) => r.final_disposition === "REJECT").length;
  assert.equal(provisionalCount, 294);
  assert.equal(rejectCount, 8);
  // The impact report's total_candidate_edge_count already includes every
  // row regardless of disposition (proven above); this test additionally
  // confirms the ledger itself still shows exactly these known dispositions
  // unresolved by this Turn (no auto-adjudication happened as a side effect).
  const decisionPacket = readJson(resolve(OUT_DIR, "provisional-294-maximal-graph-decision-packet.v0.1.json"));
  assert.equal(decisionPacket.no_auto_adjudication_of_294_rows, true);
});

test("Turn N4.8: real-data order independence -- shuffling the 326 packet's row and candidate order produces the identical maximal component partition and identical violation set", () => {
  const packet326 = readJsonl(PACKET_326_PATH);
  const poolRecords = readJsonl(POOL_PATH);
  const shuffled = [...packet326].reverse().map((row) => ({ ...row, candidates: [...row.candidates].reverse() }));

  const graphOriginal = buildMaximalPlausibleGraph({ packetRows: packet326 });
  const graphShuffled = buildMaximalPlausibleGraph({ packetRows: shuffled });
  assert.equal(graphOriginal.maximalComponents.length, graphShuffled.maximalComponents.length);
  assert.equal(graphOriginal.totalCandidateEdgeCount, graphShuffled.totalCandidateEdgeCount);

  const impactOriginal = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graphOriginal.resolveMaximalComponentId });
  const impactShuffled = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graphShuffled.resolveMaximalComponentId });
  assert.equal(impactOriginal.violations.length, impactShuffled.violations.length);
  const digest = (impact) => impact.violations.map((v) => `${v.maximal_component_id}:${v.splits.join(",")}:${v.assignment_ids.join(",")}`).sort().join("|");
  assert.equal(digest(impactOriginal), digest(impactShuffled));
});

test("Turn N4.8: real-data duplicate-edge invariance -- doubling every packet row changes nothing", () => {
  const packet326 = readJsonl(PACKET_326_PATH);
  const doubled = [...packet326, ...packet326.map((r) => ({ ...r, relation_candidate_id: `${r.relation_candidate_id}_dup` }))];
  const graphOnce = buildMaximalPlausibleGraph({ packetRows: packet326 });
  const graphDoubled = buildMaximalPlausibleGraph({ packetRows: doubled });
  assert.equal(graphOnce.maximalComponents.length, graphDoubled.maximalComponents.length);
  assert.equal(graphOnce.distinctCrossComponentPairCount, graphDoubled.distinctCrossComponentPairCount);
});

test("Turn N4.8: the real corpus's maximal graph DOES leak (branch B) -- report names exact components/splits/assignments, and quarantine intrusion is separately clean", () => {
  const report = readJson(resolve(OUT_DIR, "maximal-graph-impact-report.v0.1.json"));
  assert.equal(report.scope, "MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE_NOT_CONFIRMED");
  assert.equal(report.all_zero_maximal_graph_leakage, false);
  assert.ok(report.split_impact.violations.length > 0);
  assert.ok(report.author_impact.violations.length > 0);
  for (const v of report.split_impact.violations) {
    assert.ok(v.maximal_component_id);
    assert.ok(v.splits.length >= 2);
    assert.ok(v.assignment_ids.length >= 2);
  }
  assert.equal(report.quarantine_impact.ok, true, "the real 50-document quarantine set should already be isolated even under the maximal graph -- if this ever flips false, that is real news for the Owner");
});

test("Turn N4.8: branch B decision packet reports exact violations, computes replacement suggestions WITHOUT applying them, and never triggers full 294 review", () => {
  const packet = readJson(resolve(OUT_DIR, "provisional-294-maximal-graph-decision-packet.v0.1.json"));
  assert.equal(packet.status, "PATH_2_LEAKAGE_FOUND_NOT_RESOLVED");
  assert.ok(packet.split_violations.length > 0);
  assert.equal(packet.replacement_suggestions_are_computed_only_not_applied, true);
  assert.equal(packet.no_actual_anchor_replacement_performed_this_turn, true);
  assert.equal(packet.no_full_manual_review_of_294_triggered_by_this_turn, true);
  assert.equal(packet.official_split_eligible_set_by_this_script, false);
  // Every suggested replacement must be a REAL Pool 500 assignment id, never
  // fabricated, and must never be one of the violating assignments itself.
  const poolIds = new Set(readJsonl(POOL_PATH).map((r) => r.assignment_id));
  const violatingIds = new Set(packet.affected_assignment_ids);
  for (const suggestions of Object.values(packet.computed_replacement_suggestions_by_maximal_component_id)) {
    for (const s of suggestions) {
      assert.ok(poolIds.has(s.assignment_id));
      assert.ok(!violatingIds.has(s.assignment_id));
    }
  }
});

test("Turn N4.8: no Owner approval UI is generated for a branch-B (leakage found) result", () => {
  assert.equal(existsSync(resolve(OUT_DIR, "ui")), false);
});

test("Turn N4.8: gate-status.v0.3.json corrects the wording without lying about the actual (leakage-found) state, and official_split_eligible stays false", () => {
  const gates = readJson(resolve(OUT_DIR, "gate-status.v0.3.json")).gates;
  assert.equal(gates.final_owner_split_review, "PENDING");
  assert.equal(gates.provisional_294_resolution, "PENDING");
  assert.equal(gates.provisional_294_resolution_path, null);
  assert.equal(gates.chain_leakage_maximal_plausible_graph, "FAIL_MAXIMAL_PLAUSIBLE_GRAPH_WORST_CASE");
  assert.equal(gates.official_split_eligible, false);
  assert.equal(gates.gold_authoring, "BLOCKED_PENDING_PROVISIONAL_294_RESOLUTION");
  assert.match(gates.official_split_eligible_blocked_by, /Maximal-graph leakage/);
});

test("Turn N4.8: gate-status.v0.2.json (Turn N4.7.1's own gate file) is left completely unmodified", () => {
  const gatesV02 = readJson(GATE_STATUS_V02_PATH).gates;
  assert.equal(gatesV02.gold_authoring, "BLOCKED_PENDING_FINAL_SPLIT_APPROVAL", "the OLD wording must still be exactly what Turn N4.7.1 wrote -- this Turn only adds a NEW v0.3 file, it never edits v0.2's wording in place");
});

test("Turn N4.8: split-leakage-report.v0.2.json (the 23-confirmed-edge result) is preserved separately and still reports all_zero=true, independent of the maximal-graph result", () => {
  const confirmedEdgeReport = readJson(SPLIT_LEAKAGE_V02_PATH);
  assert.equal(confirmedEdgeReport.all_zero, true);
  const maximalReport = readJson(resolve(OUT_DIR, "maximal-graph-impact-report.v0.1.json"));
  assert.equal(maximalReport.all_zero_maximal_graph_leakage, false);
  assert.notEqual(confirmedEdgeReport.all_zero, maximalReport.all_zero_maximal_graph_leakage, "the two scopes must be reported separately, never conflated into one boolean");
});

test("Turn N4.8: re-running the script is deterministic -- edge list is byte-identical and the impact report is identical apart from generated_at", () => {
  const edgesBefore = readFileSync(resolve(OUT_DIR, "maximal-graph-edges.v0.1.jsonl"), "utf8");
  const reportBefore = readJson(resolve(OUT_DIR, "maximal-graph-impact-report.v0.1.json"));
  delete reportBefore.generated_at;
  execFileSync(process.execPath, [resolve(REPO_ROOT, "scripts/build-relation-closure-maximal-graph-impact-v048.mjs")], { cwd: REPO_ROOT, stdio: "pipe" });
  const edgesAfter = readFileSync(resolve(OUT_DIR, "maximal-graph-edges.v0.1.jsonl"), "utf8");
  const reportAfter = readJson(resolve(OUT_DIR, "maximal-graph-impact-report.v0.1.json"));
  delete reportAfter.generated_at;
  assert.equal(edgesAfter, edgesBefore);
  assert.deepEqual(reportAfter, reportBefore);
});
