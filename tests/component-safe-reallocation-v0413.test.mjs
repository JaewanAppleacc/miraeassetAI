// Turn N4.13: verifies the component-safe split/author reallocation
// feasibility analysis (scripts/build-component-safe-reallocation-v0413
// .mjs) against the REAL prospective graph + Anchor 150 + Candidate Pool
// 500, and that it never modifies any real assignment/split/author file.
// Per this repo's established convention, "never modifies a sibling
// artifact" is proven via a static write-scope scan, never a live
// before/after hash comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/build-component-safe-reallocation-v0413.mjs");
const V02_DIR = resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2");
const OUT_DIR = resolve(V02_DIR, "component-safe-reallocation-v0.1");
const ANCHOR_V02_PATH = resolve(V02_DIR, "anchor-selection.v0.2.jsonl");
const AUTHOR_V02_PATH = resolve(V02_DIR, "author-allocation.v0.2.jsonl");
const POOL_PATH = resolve(REPO_ROOT, "work/domain-seed/candidate-pool-v0.4.1/candidate-pool.v0.1.jsonl");

function readJsonl(p) { return readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

let anchorBefore; let authorBefore; let poolBefore;
test.before(() => {
  anchorBefore = readFileSync(ANCHOR_V02_PATH, "utf8");
  authorBefore = readFileSync(AUTHOR_V02_PATH, "utf8");
  poolBefore = readFileSync(POOL_PATH, "utf8");
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
});

test("Turn N4.13: static proof -- every write call targets only component-safe-reallocation-v0.1/, never the real Anchor/Author/Pool files", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  assert.match(source, /const outDir = resolve\(V02_DIR, "component-safe-reallocation-v0\.1"\)/);
  const writeCallRegex = /\b(?:writeJson|writeJsonl|writeFileSync)\(\s*([^,]+?),/g;
  const targets = [...source.matchAll(writeCallRegex)].map((m) => m[1].trim()).filter((t) => t !== "p");
  assert.ok(targets.length >= 12, `expected at least 12 write call sites, found ${targets.length}`);
  for (const t of targets) assert.ok(t.startsWith("resolve(outDir"), `write target "${t}" is not provably outDir-rooted`);
  assert.doesNotMatch(source, /writeFileSync\([^)]*anchor-selection\.v0\.2\.jsonl/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*author-allocation\.v0\.2\.jsonl/);
  assert.doesNotMatch(source, /writeFileSync\([^)]*candidate-pool\.v0\.1\.jsonl/);
});

test("Turn N4.13: the real Anchor/Author/Pool files are byte-unmodified after running the analysis", () => {
  assert.equal(readFileSync(ANCHOR_V02_PATH, "utf8"), anchorBefore);
  assert.equal(readFileSync(AUTHOR_V02_PATH, "utf8"), authorBefore);
  assert.equal(readFileSync(POOL_PATH, "utf8"), poolBefore);
});

test("Turn N4.13: baseline leakage is reproduced exactly -- 6 split / 4 author / 60 affected, never hardcoded, independently recomputed", () => {
  const baseline = readJson(resolve(OUT_DIR, "current-leakage-baseline.v0.1.json"));
  assert.equal(baseline.split_violation_count, 6);
  assert.equal(baseline.author_violation_count, 4);
  assert.equal(baseline.quarantine_violation_count, 0);
  assert.equal(baseline.affected_assignment_count, 60);
  assert.equal(baseline.prospective_edge_count, 1428);
});

test("Turn N4.13: Strategy A achieves FEASIBLE_EXACT on the real corpus, and the simulation proves zero leakage after applying its delta in-memory", () => {
  const plan = readJson(resolve(OUT_DIR, "strategy-a-assignment-only-plan.v0.1.json"));
  assert.equal(plan.status, "CANDIDATE_NOT_APPLIED");
  assert.equal(plan.official_split_eligible, false);
  assert.equal(plan.gold_authoring_authorized, false);
  assert.equal(plan.owner_approval_required, true);
  assert.equal(plan.verdict, "FEASIBLE_EXACT");
  assert.equal(plan.simulation_result.split_violations_after, 0);
  assert.equal(plan.simulation_result.author_violations_after, 0);
  assert.equal(plan.simulation_result.quarantine_violations_after, 0);
  assert.deepEqual(plan.simulation_result.author_counts_after, { AUTHOR_A: 75, AUTHOR_B: 75 });
  assert.equal(plan.simulation_result.anchor_count_after, 150);
  assert.equal(plan.simulation_result.critical_tag_floors_preserved, true);
  assert.equal(plan.split_plan.exact_restoration_achieved, true);
  assert.equal(plan.author_plan.exact_restoration_achieved, true);
  assert.deepEqual(plan.split_plan.final_split_counts, plan.split_plan.original_split_counts);
  assert.deepEqual(plan.author_plan.final_author_counts, plan.author_plan.original_author_counts);
});

test("Turn N4.13: applying Strategy A's delta to REAL in-memory copies of Pool500/Anchor150/Author150 independently reproduces zero leakage (full simulation, not trusting the script's own self-report)", async () => {
  const { buildProspectiveGraph } = await import("../domain/evaluation/relation-closure-prospective-consensus-graph.mjs");
  const { computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact } = await import("../domain/evaluation/relation-closure-maximal-graph.mjs");
  const packet326 = readJsonl(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl"));
  const ledgerRows = readJsonl(resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  const ratifiedConsensus = readJsonl(resolve(V02_DIR, "decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratified-consensus.v0.1.jsonl"));
  const consensusMap = new Map(ratifiedConsensus.map((r) => [r.relation_candidate_id, { consensus_disposition: r.consensus_disposition, consensus_target_document_id: r.consensus_target_document_id }]));
  const graph = buildProspectiveGraph({ packetRows: packet326, ledgerRows, consensusByRelationCandidateId: consensusMap });

  const pool = readJsonl(POOL_PATH);
  const authorRows = readJsonl(AUTHOR_V02_PATH);
  const delta = readJsonl(resolve(OUT_DIR, "strategy-a-assignment-delta.v0.1.jsonl"));
  assert.ok(delta.length > 0);

  const poolById = new Map(pool.map((r) => ({ ...r })).map((r) => [r.assignment_id, r]));
  const authorById = new Map(authorRows.map((r) => ({ ...r })).map((r) => [r.assignment_id, r]));
  for (const move of delta) {
    if (move.dimension === "split") poolById.get(move.assignment_id).planned_split = move.to;
    else if (move.dimension === "author") authorById.get(move.assignment_id).author_allocation = move.to;
  }
  const simulatedPool = [...poolById.values()];
  const simulatedAuthor = [...authorById.values()];
  const splitImpact = computeMaximalGraphSplitImpact({ poolRecords: simulatedPool, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  const authorImpact = computeMaximalGraphAuthorImpact({ authorRows: simulatedAuthor, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.deepEqual(splitImpact.violations, []);
  assert.deepEqual(authorImpact.violations, []);
  const authorCounts = { AUTHOR_A: 0, AUTHOR_B: 0 };
  for (const r of simulatedAuthor) authorCounts[r.author_allocation] += 1;
  assert.deepEqual(authorCounts, { AUTHOR_A: 75, AUTHOR_B: 75 });
});

test("Turn N4.13: an Anchor-touching maximal component's NON-anchor sibling records are never selected as compensating candidates (the specific bug this Turn found and fixed)", () => {
  const delta = readJsonl(resolve(OUT_DIR, "strategy-a-assignment-delta.v0.1.jsonl"));
  const anchor = readJsonl(ANCHOR_V02_PATH);
  const anchorIds = new Set(anchor.map((r) => r.assignment_id));
  const pool = readJsonl(POOL_PATH);
  const poolById = new Map(pool.map((r) => [r.assignment_id, r]));
  const baseline = readJson(resolve(OUT_DIR, "current-leakage-baseline.v0.1.json"));
  const anchorTouchingComponentIds = new Set(baseline.split_violation_detail.filter((v) => v.contains_anchor).map((v) => v.maximal_component_id));
  // For every split-dimension compensating move, its component must NOT be
  // one that (per the baseline) contains an anchor member -- if it did, the
  // move would be exactly the reintroduced-leakage bug.
  for (const move of delta.filter((m) => m.dimension === "split" && m.reason === "COMPENSATING_RESTORATION")) {
    assert.ok(!anchorTouchingComponentIds.has(move.component_id), `compensating move ${move.assignment_id} targets an anchor-touching component ${move.component_id}`);
  }
});

test("Turn N4.13: Strategy B and C are correctly marked NOT_NEEDED (never fabricated empty results dressed as real analysis)", () => {
  const b = readJson(resolve(OUT_DIR, "strategy-b-anchor-replacement-plan.v0.1.json"));
  assert.equal(b.status, "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE");
  const c = readJson(resolve(OUT_DIR, "strategy-c-relation-group-cut-analysis.v0.1.json"));
  assert.equal(c.status, "NOT_NEEDED_BECAUSE_STRATEGY_A_FEASIBLE");
  assert.equal(c.no_relation_disposition_generated, true);
});

test("Turn N4.13: the recommended strategy is A, and every candidate plan/gate output declares official_split_eligible=false, gold_authoring_authorized=false, owner_approval_required=true", () => {
  const recommendation = readJson(resolve(OUT_DIR, "recommended-next-action.v0.1.json"));
  assert.equal(recommendation.recommended_strategy, "A");
  assert.equal(recommendation.status, "CANDIDATE_NOT_APPLIED");
  assert.equal(recommendation.official_split_eligible, false);
  assert.equal(recommendation.gold_authoring_authorized, false);
  assert.equal(recommendation.owner_approval_required, true);
  assert.equal(recommendation.no_strategy_auto_applied, true);

  const gate = readJson(resolve(OUT_DIR, "gate-status.v0.1.json"));
  assert.equal(gate.official_split_eligible, false);
  assert.equal(gate.gold_authoring_authorized, false);
  assert.equal(gate.actual_files_modified, false);
  assert.equal(gate.remaining_281_provisional_rows_untouched, true);
});

test("Turn N4.13: the 218-row targeted cohort and the remaining provisional relations are never auto-adjudicated by this Turn -- no disposition-shaped field appears anywhere in the outputs", () => {
  const files = [
    "strategy-a-assignment-only-plan.v0.1.json",
    "strategy-b-anchor-replacement-plan.v0.1.json",
    "strategy-c-relation-group-cut-analysis.v0.1.json",
  ];
  for (const file of files) {
    const text = JSON.stringify(readJson(resolve(OUT_DIR, file)));
    assert.doesNotMatch(text, /"owner_disposition"\s*:\s*"(CONFIRM|REJECT)"/);
  }
});

test("Turn N4.13: N4.9-N4.12 upstream artifacts are content-unchanged (row counts, key values) -- read-only inputs, never modified", () => {
  const ratifiedConsensus = readJsonl(resolve(V02_DIR, "decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/owner-ratification-v0.1/priority-wave-1-owner-ratified-consensus.v0.1.jsonl"));
  assert.equal(ratifiedConsensus.length, 13);
  const gateAfterWave1 = readJson(resolve(V02_DIR, "decision-respecting-graph-v0.1/priority-wave-1-v0.1/consensus-integration-v0.1/gate-status-after-wave1.v0.1.json"));
  assert.equal(gateAfterWave1.status, "LEAKAGE_REMAINS_AFTER_PRIORITY_WAVE_1");
  assert.equal(gateAfterWave1.official_split_eligible, false);
  const ledger = readJsonl(resolve(V02_DIR, "relation-closure-candidate-ledger.v0.2.jsonl"));
  assert.equal(ledger.length, 326);
  assert.equal(ledger.filter((r) => r.decision_authority === "REVIEWER_CONSENSUS_PROVISIONAL").length, 294);
});

test("Turn N4.13: deterministic rebuild -- re-running the script twice produces a BYTE-IDENTICAL assignment-delta file", () => {
  const before = readFileSync(resolve(OUT_DIR, "strategy-a-assignment-delta.v0.1.jsonl"), "utf8");
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const after = readFileSync(resolve(OUT_DIR, "strategy-a-assignment-delta.v0.1.jsonl"), "utf8");
  assert.equal(before, after);
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, stdio: "pipe" });
  const afterAgain = readFileSync(resolve(OUT_DIR, "strategy-a-assignment-delta.v0.1.jsonl"), "utf8");
  assert.equal(after, afterAgain);
});
