// Turn N4.13: synthetic-fixture unit tests for
// domain/evaluation/component-safe-reallocation.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideConsolidationTarget,
  planForcedConsolidation,
  planCompensatingRestoration,
  computeExactTwoGroupMinCut,
  analyzeComponentGroupCut,
  filterEligibleReplacementCandidates,
  planMinimalGroupReplacement,
} from "../domain/evaluation/component-safe-reallocation.mjs";

const SPLIT_ORDER = ["DEV_TUNE", "DEV_CHECK", "HOLDOUT"];
const AUTHOR_ORDER = ["AUTHOR_A", "AUTHOR_B"];

// -- decideConsolidationTarget / planForcedConsolidation (component-level) --
test("decideConsolidationTarget: an Anchor-forced component ALWAYS targets DEV_TUNE, even when HOLDOUT is the plurality", () => {
  const target = decideConsolidationTarget({ currentLabels: ["HOLDOUT", "HOLDOUT", "HOLDOUT", "DEV_TUNE"], forcedLabel: "DEV_TUNE", labelPriorityOrder: SPLIT_ORDER });
  assert.equal(target, "DEV_TUNE");
});

test("decideConsolidationTarget: with no forced label, plurality wins", () => {
  const target = decideConsolidationTarget({ currentLabels: ["DEV_CHECK", "DEV_CHECK", "HOLDOUT"], forcedLabel: null, labelPriorityOrder: SPLIT_ORDER });
  assert.equal(target, "DEV_CHECK");
});

test("decideConsolidationTarget: deterministic tie-break -- a tie always resolves to the first label in labelPriorityOrder, regardless of input array order", () => {
  const t1 = decideConsolidationTarget({ currentLabels: ["DEV_CHECK", "DEV_TUNE"], forcedLabel: null, labelPriorityOrder: SPLIT_ORDER });
  const t2 = decideConsolidationTarget({ currentLabels: ["DEV_TUNE", "DEV_CHECK"], forcedLabel: null, labelPriorityOrder: SPLIT_ORDER });
  assert.equal(t1, "DEV_TUNE");
  assert.equal(t2, "DEV_TUNE");
  assert.equal(t1, t2);
});

test("planForcedConsolidation: component-unit split assignment -- every member of a violating component ends up with the SAME label", () => {
  const itemsById = new Map([
    ["a1", { currentLabel: "DEV_TUNE" }],
    ["a2", { currentLabel: "HOLDOUT" }],
    ["a3", { currentLabel: "HOLDOUT" }],
  ]);
  const { forcedMoves, targetByGroup } = planForcedConsolidation({
    violatingGroups: [{ groupId: "g1", memberIds: ["a1", "a2", "a3"], forced: "DEV_TUNE" }],
    itemsById, labelPriorityOrder: SPLIT_ORDER,
  });
  assert.equal(targetByGroup.get("g1"), "DEV_TUNE");
  assert.equal(forcedMoves.length, 2);
  assert.ok(forcedMoves.every((m) => m.toLabel === "DEV_TUNE"));
});

test("planForcedConsolidation: author component isolation -- a mixed-author component consolidates to one author, isolating it from the other", () => {
  const itemsById = new Map([
    ["a1", { currentLabel: "AUTHOR_A" }],
    ["a2", { currentLabel: "AUTHOR_A" }],
    ["a3", { currentLabel: "AUTHOR_B" }],
  ]);
  const { forcedMoves, targetByGroup } = planForcedConsolidation({
    violatingGroups: [{ groupId: "g1", memberIds: ["a1", "a2", "a3"], forced: null }],
    itemsById, labelPriorityOrder: AUTHOR_ORDER,
  });
  assert.equal(targetByGroup.get("g1"), "AUTHOR_A");
  assert.deepEqual(forcedMoves.map((m) => m.id), ["a3"]);
});

// -- planCompensatingRestoration -----------------------------------------
test("planCompensatingRestoration: exact count constraint -- restores original per-label totals exactly when enough small eligible groups exist", () => {
  const forcedMoves = [{ id: "v1", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }, { id: "v2", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }];
  const itemsById = new Map([
    ["v1", { currentLabel: "HOLDOUT" }], ["v2", { currentLabel: "HOLDOUT" }],
    ["c1", { currentLabel: "DEV_TUNE" }], ["c2", { currentLabel: "DEV_TUNE" }],
  ]);
  const originalCounts = new Map([["DEV_TUNE", 3], ["DEV_CHECK", 0], ["HOLDOUT", 2]]);
  const result = planCompensatingRestoration({
    forcedMoves, itemsById, originalCounts,
    excludedIds: new Set(), getGroupKey: (id) => id, labelPriorityOrder: SPLIT_ORDER,
  });
  assert.equal(result.exactRestorationAchieved, true);
  assert.deepEqual(result.shortfalls, []);
  assert.equal(result.finalCounts.get("DEV_TUNE"), 3);
  assert.equal(result.finalCounts.get("HOLDOUT"), 2);
  assert.equal(result.compensatingMoves.length, 2);
});

test("planCompensatingRestoration: infeasible counterexample -- reports an honest shortfall when no eligible group can close the deficit", () => {
  const forcedMoves = [{ id: "v1", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }];
  const itemsById = new Map([["v1", { currentLabel: "HOLDOUT" }]]); // no other eligible items at all
  const originalCounts = new Map([["DEV_TUNE", 0], ["DEV_CHECK", 0], ["HOLDOUT", 1]]);
  const result = planCompensatingRestoration({
    forcedMoves, itemsById, originalCounts,
    excludedIds: new Set(), getGroupKey: (id) => id, labelPriorityOrder: SPLIT_ORDER,
  });
  assert.equal(result.exactRestorationAchieved, false);
  assert.equal(result.shortfalls.length, 1);
  assert.equal(result.shortfalls[0].label, "HOLDOUT");
  assert.equal(result.shortfalls[0].unmet, 1);
});

test("planCompensatingRestoration: excludedIds (e.g. Anchor members) are NEVER used as compensating candidates, even if they would otherwise be an exact fit", () => {
  const forcedMoves = [{ id: "v1", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }];
  const itemsById = new Map([
    ["v1", { currentLabel: "HOLDOUT" }],
    ["anchor1", { currentLabel: "DEV_TUNE" }], // would be a perfect compensating fit, but excluded
  ]);
  const originalCounts = new Map([["DEV_TUNE", 1], ["DEV_CHECK", 0], ["HOLDOUT", 1]]);
  const result = planCompensatingRestoration({
    forcedMoves, itemsById, originalCounts,
    excludedIds: new Set(["anchor1"]), getGroupKey: (id) => id, labelPriorityOrder: SPLIT_ORDER,
  });
  assert.equal(result.exactRestorationAchieved, false);
  assert.ok(!result.compensatingMoves.some((m) => m.id === "anchor1"));
});

test("planCompensatingRestoration: never splits a group -- a group larger than the remaining need is skipped, not partially consumed", () => {
  const forcedMoves = [{ id: "v1", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }];
  const itemsById = new Map([
    ["v1", { currentLabel: "HOLDOUT" }],
    ["big1", { currentLabel: "DEV_TUNE" }], ["big2", { currentLabel: "DEV_TUNE" }], // group "biggroup" size 2, need is only 1
    ["small1", { currentLabel: "DEV_TUNE" }], // group "smallgroup" size 1, exact fit
  ]);
  const getGroupKey = (id) => (id.startsWith("big") ? "biggroup" : id === "small1" ? "smallgroup" : id);
  const originalCounts = new Map([["DEV_TUNE", 3], ["DEV_CHECK", 0], ["HOLDOUT", 1]]);
  const result = planCompensatingRestoration({
    forcedMoves, itemsById, originalCounts,
    excludedIds: new Set(), getGroupKey, labelPriorityOrder: SPLIT_ORDER,
  });
  assert.equal(result.exactRestorationAchieved, true);
  assert.deepEqual(result.compensatingMoves.map((m) => m.id), ["small1"]);
});

test("planCompensatingRestoration REGRESSION: a violating group's member that was ALREADY at the target label (so planForcedConsolidation never emits a move for it) must still be excluded from compensation -- pulling it out would re-split the just-fixed group", () => {
  // Violating group "gv" = {v1 (HOLDOUT), v2 (DEV_TUNE), v3 (DEV_TUNE)} ->
  // consolidates to DEV_TUNE. Only v1 gets a forced move (v2/v3 already
  // match). Without allViolatingGroupMemberIds, v2/v3 would look like
  // ordinary untouched DEV_TUNE items and could be picked as compensating
  // candidates -- which would re-introduce a DEV_TUNE/DEV_CHECK split on
  // group "gv" itself.
  const forcedMoves = [{ id: "v1", groupId: "gv", fromLabel: "HOLDOUT", toLabel: "DEV_TUNE" }];
  const itemsById = new Map([
    ["v1", { currentLabel: "HOLDOUT" }],
    ["v2", { currentLabel: "DEV_TUNE" }],
    ["v3", { currentLabel: "DEV_TUNE" }],
  ]);
  const getGroupKey = (id) => "gv"; // v1, v2, v3 all belong to the SAME (maximal) group
  const originalCounts = new Map([["DEV_TUNE", 2], ["DEV_CHECK", 0], ["HOLDOUT", 1]]);
  const result = planCompensatingRestoration({
    forcedMoves, itemsById, originalCounts,
    excludedIds: new Set(), getGroupKey, labelPriorityOrder: SPLIT_ORDER,
    allViolatingGroupMemberIds: ["v1", "v2", "v3"],
  });
  assert.deepEqual(result.compensatingMoves, [], "v2/v3 must never be selected -- they belong to the group just consolidated to DEV_TUNE");
});

// -- Strategy C: exact min-cut --------------------------------------------
test("computeExactTwoGroupMinCut: a single bridging edge between two groups has min cut size 1", () => {
  const { minCutSize } = computeExactTwoGroupMinCut({
    edges: [{ source: "bridge_from", target: "bridge_to" }],
    groupANodes: ["a1", "bridge_from"],
    groupBNodes: ["b1", "bridge_to"],
  });
  assert.equal(minCutSize, 1);
});

test("computeExactTwoGroupMinCut: two parallel bridging edges require cutting both (min cut size 2)", () => {
  const { minCutSize } = computeExactTwoGroupMinCut({
    edges: [{ source: "x", target: "y" }, { source: "x2", target: "y2" }],
    groupANodes: ["x", "x2"],
    groupBNodes: ["y", "y2"],
  });
  assert.equal(minCutSize, 2);
});

test("analyzeComponentGroupCut: exact 2-group case reports a real lower bound and never claims minimality beyond the graph-theoretic guarantee", () => {
  const result = analyzeComponentGroupCut({
    maximalComponentId: "comp1",
    nodesByLabel: new Map([["DEV_TUNE", ["a1"]], ["HOLDOUT", ["h1"]]]),
    provisionalEdges: [{ relation_candidate_id: "r1", source: "a1", target: "h1" }],
  });
  assert.equal(result.exact_min_cut_computable, true);
  assert.equal(result.lower_bound_relation_row_count, 1);
  assert.deepEqual(result.relation_ids_realizing_min_cut, ["r1"]);
  assert.match(result.minimality_claim, /EXACT/);
});

test("analyzeComponentGroupCut: a 3-distinct-label component refuses to claim exactness (multi-way cut is NP-hard, not attempted)", () => {
  const result = analyzeComponentGroupCut({
    maximalComponentId: "comp2",
    nodesByLabel: new Map([["DEV_TUNE", ["a1"]], ["DEV_CHECK", ["c1"]], ["HOLDOUT", ["h1"]]]),
    provisionalEdges: [],
  });
  assert.equal(result.exact_min_cut_computable, false);
  assert.equal(result.reason, "MULTI_WAY_CUT_NP_HARD_NOT_ATTEMPTED");
  assert.equal(result.minimality_claim, "NONE");
});

// -- Strategy B eligibility -------------------------------------------------
test("filterEligibleReplacementCandidates: rejects HOLDOUT, DEV_CHECK, parse-blocked, and already-excluded candidates -- only DEV_TUNE, clean records pass", () => {
  const pool = [
    { assignment_id: "ok1", planned_split: "DEV_TUNE", authoring_status: "READY", tags: [] },
    { assignment_id: "holdout1", planned_split: "HOLDOUT", authoring_status: "READY", tags: [] },
    { assignment_id: "devcheck1", planned_split: "DEV_CHECK", authoring_status: "READY", tags: [] },
    { assignment_id: "blocked1", planned_split: "DEV_TUNE", authoring_status: "PARSE_BLOCKED", tags: [] },
    { assignment_id: "tagged_blocked", planned_split: "DEV_TUNE", authoring_status: "READY", tags: ["parse_blocked"] },
    { assignment_id: "already_used", planned_split: "DEV_TUNE", authoring_status: "READY", tags: [] },
  ];
  const eligible = filterEligibleReplacementCandidates({ poolRecords: pool, excludeAssignmentIds: new Set(["already_used"]) });
  assert.deepEqual(eligible.map((r) => r.assignment_id), ["ok1"]);
});

test("planMinimalGroupReplacement: picks the smallest exact-fit combination of whole groups, deterministically", () => {
  const eligible = [
    { assignment_id: "s1", evaluation_group_id: "small" },
    { assignment_id: "m1", evaluation_group_id: "medium" }, { assignment_id: "m2", evaluation_group_id: "medium" },
    { assignment_id: "s2", evaluation_group_id: "small2" },
  ];
  const plan = planMinimalGroupReplacement({ neededCount: 2, eligibleRecords: eligible });
  assert.ok(plan);
  const totalPicked = plan.reduce((sum, g) => sum + g.memberIds.length, 0);
  assert.equal(totalPicked, 2);
  // Deterministic: two size-1 groups (small, small2) chosen over the size-2 "medium" group, tie-broken alphabetically.
  assert.deepEqual(plan.map((g) => g.groupId), ["small", "small2"]);
});

test("planMinimalGroupReplacement: returns null (infeasible) when no combination hits the exact needed count", () => {
  const eligible = [{ assignment_id: "m1", evaluation_group_id: "medium" }, { assignment_id: "m2", evaluation_group_id: "medium" }];
  const plan = planMinimalGroupReplacement({ neededCount: 1, eligibleRecords: eligible });
  assert.equal(plan, null);
});

test("planMinimalGroupReplacement: never reuses an already-used group id", () => {
  const eligible = [{ assignment_id: "s1", evaluation_group_id: "small" }];
  const plan = planMinimalGroupReplacement({ neededCount: 1, eligibleRecords: eligible, alreadyUsedGroupIds: new Set(["small"]) });
  assert.equal(plan, null);
});
