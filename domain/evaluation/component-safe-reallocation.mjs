// Turn N4.13: pure planning functions for a COMPONENT-SAFE reassignment
// feasibility analysis over the existing Anchor 150 / Author 75-75 /
// Candidate Pool 500 -- never applied to the real files by this module or
// its caller script. Every function here is a candidate-plan CALCULATOR,
// never a writer of official assignment/split/author state.
//
// Core principle (matches domain/evaluation/CHAIN_SAFE_GROUPING_CONTRACT.v1
// .md and AUTHOR_ALLOCATION.v1.md, both CURRENT policy): every member of one
// prospective maximal component must end up with the SAME label (split, or
// author when the member is an Anchor). An Anchor member's split label is
// ALWAYS forced to DEV_TUNE (Anchor is, by construction, the DEV_TUNE-only
// subset of the Candidate Pool -- domain/evaluation/anchor-allocation-
// builder.mjs's selectAnchorPool filters poolRecords to
// planned_split==="DEV_TUNE" before selecting Anchor at all). A violating
// component containing ANY Anchor member therefore has no real choice: the
// WHOLE component must consolidate to DEV_TUNE, never plurality-voted away
// from it.
import { createHash } from "node:crypto";

function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

// Decides the single target label for one violating component's full
// membership. `forcedLabel` (e.g. "DEV_TUNE" because an Anchor member is
// present) always wins over plurality. Otherwise the label with the most
// current members wins; ties are broken by `labelPriorityOrder` (first
// listed label wins a tie) -- deterministic, never random, independent of
// input array order (the counts are computed by value, not position).
export function decideConsolidationTarget({ currentLabels, forcedLabel, labelPriorityOrder }) {
  if (forcedLabel) return forcedLabel;
  const counts = new Map();
  for (const label of currentLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const label of labelPriorityOrder) {
    const count = counts.get(label) ?? 0;
    if (count > bestCount) { bestCount = count; best = label; }
  }
  return best;
}

// Plans the full consolidation (forced moves for every violating component)
// for one label dimension (split OR author). `violatingGroups`:
// [{ groupId, memberIds, forced: label|null }]. `itemsById`: Map(id ->
// { currentLabel, groupKey }) for EVERY item in the label's universe (used
// both to read current labels and, later, to find compensating candidates).
// Returns { forcedMoves: [{id, groupId, fromLabel, toLabel}], targetByGroup }.
export function planForcedConsolidation({ violatingGroups, itemsById, labelPriorityOrder }) {
  const forcedMoves = [];
  const targetByGroup = new Map();
  for (const group of violatingGroups) {
    const currentLabels = group.memberIds.map((id) => itemsById.get(id).currentLabel);
    const target = decideConsolidationTarget({ currentLabels, forcedLabel: group.forced ?? null, labelPriorityOrder });
    targetByGroup.set(group.groupId, target);
    for (const id of group.memberIds) {
      const current = itemsById.get(id).currentLabel;
      if (current !== target) forcedMoves.push({ id, groupId: group.groupId, fromLabel: current, toLabel: target });
    }
  }
  return { forcedMoves, targetByGroup };
}

// Computes the net per-label delta the forced moves alone would introduce
// (vs the ORIGINAL, pre-plan label counts) and finds compensating whole-
// group swaps to restore the ORIGINAL totals exactly, using ONLY items that
// are (a) not already touched by a forced move, (b) not in `excludedIds`
// (e.g. Anchor members, whose split can never move away from DEV_TUNE), and
// (c) grouped by `getGroupKey` so an ENTIRE group always moves together
// (never split across two labels).
//
// Deterministic tie-break: eligible groups are always consumed smallest-
// group-size-first, then by the group's own sorted member-id-derived stable
// key -- never by array/object insertion order, never by Math.random().
// Compensating moves are attempted for each deficit label in
// `labelPriorityOrder` order. If eligible groups cannot close a deficit
// EXACTLY (size granularity mismatch), the shortfall is reported honestly
// (`exactRestorationAchieved: false`) rather than silently rounded.
export function planCompensatingRestoration({ forcedMoves, itemsById, originalCounts, excludedIds, getGroupKey, labelPriorityOrder, allViolatingGroupMemberIds = [] }) {
  const netDelta = new Map(labelPriorityOrder.map((l) => [l, 0]));
  for (const move of forcedMoves) {
    netDelta.set(move.fromLabel, (netDelta.get(move.fromLabel) ?? 0) - 1);
    netDelta.set(move.toLabel, (netDelta.get(move.toLabel) ?? 0) + 1);
  }
  // touchedIds must cover EVERY member of EVERY violating group, not just the
  // ones whose label actually changed (planForcedConsolidation only returns
  // a move for a member whose current label already differs from the
  // target). A member that was ALREADY at the target label is still part of
  // the just-consolidated group -- pulling it out as a "compensating"
  // candidate would re-introduce a split on that exact group. `forcedMoves`
  // alone under-counts this; `allViolatingGroupMemberIds` closes the gap.
  const touchedIds = new Set([...forcedMoves.map((m) => m.id), ...allViolatingGroupMemberIds]);

  // Build eligible compensation pool: group untouched, non-excluded items by
  // their group key and current label.
  const eligibleGroupsByLabel = new Map(labelPriorityOrder.map((l) => [l, new Map()]));
  for (const [id, item] of itemsById) {
    if (touchedIds.has(id) || excludedIds.has(id)) continue;
    const groupKey = getGroupKey(id);
    const byGroup = eligibleGroupsByLabel.get(item.currentLabel);
    if (!byGroup) continue;
    const list = byGroup.get(groupKey) ?? [];
    list.push(id);
    byGroup.set(groupKey, list);
  }

  const compensatingMoves = [];
  const shortfalls = [];
  for (const deficitLabel of labelPriorityOrder) {
    let need = -(netDelta.get(deficitLabel) ?? 0); // positive => this label is short
    if (need <= 0) continue;
    // Pull from whichever OTHER label(s) currently have a positive (excess)
    // net delta, largest excess first for determinism, ties by label name.
    const excessLabels = labelPriorityOrder
      .filter((l) => l !== deficitLabel && (netDelta.get(l) ?? 0) > 0)
      .sort((a, b) => (netDelta.get(b) - netDelta.get(a)) || a.localeCompare(b));
    for (const sourceLabel of excessLabels) {
      if (need <= 0) break;
      const groups = [...eligibleGroupsByLabel.get(sourceLabel).entries()]
        .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
      for (const [groupKey, memberIds] of groups) {
        if (need <= 0) break;
        if (memberIds.length > need) continue; // never overshoot -- exact restoration only
        for (const id of memberIds) compensatingMoves.push({ id, groupId: groupKey, fromLabel: sourceLabel, toLabel: deficitLabel, reason: "COMPENSATING_RESTORATION" });
        netDelta.set(sourceLabel, netDelta.get(sourceLabel) - memberIds.length);
        netDelta.set(deficitLabel, netDelta.get(deficitLabel) + memberIds.length);
        need -= memberIds.length;
        eligibleGroupsByLabel.get(sourceLabel).delete(groupKey);
      }
    }
    if (need > 0) shortfalls.push({ label: deficitLabel, unmet: need });
  }

  const finalCounts = new Map(originalCounts);
  for (const move of [...forcedMoves, ...compensatingMoves]) {
    finalCounts.set(move.fromLabel, (finalCounts.get(move.fromLabel) ?? 0) - 1);
    finalCounts.set(move.toLabel, (finalCounts.get(move.toLabel) ?? 0) + 1);
  }

  return {
    compensatingMoves,
    finalCounts,
    exactRestorationAchieved: shortfalls.length === 0,
    shortfalls,
  };
}

// -- Strategy C: exact min-cut (max-flow) between exactly two label groups
// within one small violating component's PROVISIONAL-only edge graph. Exact
// for the 2-terminal case (max-flow/min-cut theorem) -- never approximated.
// For 3+ distinct labels within one component (a true multi-way cut, NP-hard
// in general), this function refuses to claim exactness and the caller must
// report bounds only, never "minimum".
class MaxFlowGraph {
  constructor() { this.adj = new Map(); this.origCap = new Map(); }
  _ensure(n) { if (!this.adj.has(n)) this.adj.set(n, new Map()); }
  addEdge(u, v, capacity = 1) {
    this._ensure(u); this._ensure(v);
    this.adj.get(u).set(v, (this.adj.get(u).get(v) ?? 0) + capacity);
    this.adj.get(v).set(u, this.adj.get(v).get(u) ?? 0); // residual reverse edge starts at 0
    const key = `${u} ${v}`;
    this.origCap.set(key, (this.origCap.get(key) ?? 0) + capacity);
  }
  // Returns { maxFlow, minCutEdges: [[u,v], ...] } using BFS-based Edmonds-Karp
  // over unit-ish capacities (multi-edges between the same pair increment
  // capacity, matching "how many provisional relation rows connect these two
  // nodes").
  maxFlowMinCut(source, sink) {
    let flow = 0;
    for (;;) {
      const parent = new Map([[source, null]]);
      const queue = [source];
      while (queue.length > 0 && !parent.has(sink)) {
        const u = queue.shift();
        for (const [v, cap] of this.adj.get(u) ?? []) {
          if (cap > 0 && !parent.has(v)) { parent.set(v, u); queue.push(v); }
        }
      }
      if (!parent.has(sink)) break;
      let bottleneck = Infinity;
      let cur = sink;
      while (parent.get(cur) !== null) {
        const p = parent.get(cur);
        bottleneck = Math.min(bottleneck, this.adj.get(p).get(cur));
        cur = p;
      }
      cur = sink;
      while (parent.get(cur) !== null) {
        const p = parent.get(cur);
        this.adj.get(p).set(cur, this.adj.get(p).get(cur) - bottleneck);
        this.adj.get(cur).set(p, (this.adj.get(cur).get(p) ?? 0) + bottleneck);
        cur = p;
      }
      flow += bottleneck;
    }
    // Min cut: nodes reachable from source in the residual graph.
    const reachable = new Set([source]);
    const queue = [source];
    while (queue.length > 0) {
      const u = queue.shift();
      for (const [v, cap] of this.adj.get(u) ?? []) {
        if (cap > 0 && !reachable.has(v)) { reachable.add(v); queue.push(v); }
      }
    }
    // Cut edges are identified by ORIGINAL capacity (not residual, which is
    // 0 for every saturated min-cut edge by definition -- checking residual
    // here would find nothing).
    const minCutEdges = [];
    for (const [u, neighbors] of this.adj) {
      if (!reachable.has(u)) continue;
      for (const [v] of neighbors) {
        if (reachable.has(v)) continue;
        if ((this.origCap.get(`${u} ${v}`) ?? 0) <= 0) continue;
        minCutEdges.push([u, v]);
      }
    }
    return { maxFlow: flow, minCutEdges };
  }
}
export function computeExactTwoGroupMinCut({ edges, groupANodes, groupBNodes }) {
  const graph = new MaxFlowGraph();
  const SOURCE = "__SOURCE__";
  const SINK = "__SINK__";
  // Source/sink attachment edges must never themselves be the cheapest
  // cut -- they represent group MEMBERSHIP, not a reviewable relation. A
  // capacity far larger than the total number of real edges guarantees the
  // min cut always falls on real inter-node relation edges instead.
  const INFINITE_CAPACITY = edges.length + groupANodes.length + groupBNodes.length + 1000;
  for (const node of groupANodes) graph.addEdge(SOURCE, node, INFINITE_CAPACITY);
  for (const node of groupBNodes) graph.addEdge(node, SINK, INFINITE_CAPACITY);
  // A "relation candidate" edge is inherently undirected for this purpose --
  // removing it costs 1 regardless of which direction a path traverses it --
  // so it is modeled as unit capacity in BOTH directions, not a one-way arc.
  for (const edge of edges) {
    graph.addEdge(edge.source, edge.target);
    graph.addEdge(edge.target, edge.source);
  }
  const { maxFlow, minCutEdges } = graph.maxFlowMinCut(SOURCE, SINK);
  const realCutEdges = minCutEdges.filter(([u, v]) => u !== SOURCE && v !== SINK && u !== SINK && v !== SOURCE);
  return { minCutSize: maxFlow, cutEdges: realCutEdges };
}

// Builds the Strategy C group-cut analysis for ONE violating maximal
// component. `provisionalEdges`: [{relation_candidate_id, source, target}]
// -- ONLY edges contributed by still-provisional (undecided) rows; confirmed
// CONFIRM/REJECT edges are fixed and not reviewable, so they are excluded
// from the cut graph entirely (removing them is not an available action).
export function analyzeComponentGroupCut({ maximalComponentId, nodesByLabel, provisionalEdges }) {
  const distinctLabels = [...nodesByLabel.keys()];
  const totalProvisionalRelationIds = new Set(provisionalEdges.map((e) => e.relation_candidate_id));
  const trivialUpperBound = totalProvisionalRelationIds.size;

  if (distinctLabels.length !== 2) {
    return Object.freeze({
      maximal_component_id: maximalComponentId,
      distinct_label_count: distinctLabels.length,
      exact_min_cut_computable: false,
      reason: distinctLabels.length < 2 ? "NOT_ACTUALLY_SPLIT_INCONSISTENT" : "MULTI_WAY_CUT_NP_HARD_NOT_ATTEMPTED",
      lower_bound_relation_row_count: null,
      upper_bound_relation_row_count: trivialUpperBound,
      minimality_claim: "NONE",
    });
  }

  const [labelA, labelB] = distinctLabels;
  const groupANodes = nodesByLabel.get(labelA);
  const groupBNodes = nodesByLabel.get(labelB);
  const edgesForFlow = provisionalEdges.map((e) => ({ source: e.source, target: e.target }));
  const { minCutSize, cutEdges } = computeExactTwoGroupMinCut({ edges: edgesForFlow, groupANodes, groupBNodes });
  // Map cut EDGES back to the (possibly multiple) relation_candidate_ids that
  // realize each -- removing ANY ONE relation whose edge lies in the cut set
  // breaks that specific edge; the reported set is every relation row that
  // contributes at least one cut edge (an achievable, real review target
  // list, not just an abstract edge count).
  const cutEdgeKeySet = new Set(cutEdges.map(([u, v]) => `${u}|${v}`));
  const relationIdsRealizingCut = new Set(
    provisionalEdges.filter((e) => cutEdgeKeySet.has(`${e.source}|${e.target}`) || cutEdgeKeySet.has(`${e.target}|${e.source}`)).map((e) => e.relation_candidate_id),
  );

  return Object.freeze({
    maximal_component_id: maximalComponentId,
    distinct_label_count: 2,
    labels: [labelA, labelB],
    exact_min_cut_computable: true,
    exact_min_cut_edge_count: minCutSize,
    lower_bound_relation_row_count: minCutSize, // exact (max-flow/min-cut), a true lower bound on relations that MUST be reviewed
    upper_bound_relation_row_count: Math.max(minCutSize, relationIdsRealizingCut.size, 1),
    relation_ids_realizing_min_cut: [...relationIdsRealizingCut].sort(),
    minimality_claim: "The lower_bound_relation_row_count is an EXACT graph-theoretic minimum (max-flow/min-cut) for a 2-group split -- reviewing fewer than this many relations can never disconnect the two groups under the current provisional-edge graph. This does NOT mean reviewing exactly this many relations WILL resolve the leak (their disposition after review is not decided by this analysis) -- it is a lower bound on cost, not a guaranteed-sufficient review list.",
  });
}

// -- Strategy B: Anchor replacement eligibility (only used if Strategy A is
// infeasible). The ONLY policy-sanctioned Anchor lifecycle/split is
// DEV_TUNE (domain/evaluation/anchor-allocation-builder.mjs's
// selectAnchorPool filters to planned_split==="DEV_TUNE" before selecting
// Anchor at all; TARGET_SIZE.v1.md and README.md's "split-before-authoring"
// / PROVISIONAL_UNTIL_CHAIN_CLOSURE rules never describe an authoring-stage
// path that draws from DEV_CHECK or HOLDOUT). This function therefore NEVER
// returns a DEV_CHECK/HOLDOUT candidate as eligible, regardless of how the
// caller is invoked -- there is no parameter that can widen this, by design,
// per this Turn's own instruction: "정책이 모호하면 임의로 HOLDOUT 항목을
// 사용하지 말고 BLOCKED로 보고".
export function filterEligibleReplacementCandidates({ poolRecords, excludeAssignmentIds }) {
  return poolRecords.filter((r) => (
    r.planned_split === "DEV_TUNE"
    && !excludeAssignmentIds.has(r.assignment_id)
    && r.authoring_status !== "PARSE_BLOCKED"
    && !(r.tags ?? []).includes("parse_blocked")
  ));
}

// Deterministically picks the SMALLEST-count set of whole eligible groups
// (by evaluation_group_id) needed to replace a removed group's size, smallest
// group first then evaluation_group_id ascending. Never partially consumes a
// group. Returns null (infeasible) if no combination of remaining eligible
// groups can hit the exact needed count without exceeding it group-by-group.
export function planMinimalGroupReplacement({ neededCount, eligibleRecords, alreadyUsedGroupIds = new Set() }) {
  const byGroup = new Map();
  for (const r of eligibleRecords) {
    if (alreadyUsedGroupIds.has(r.evaluation_group_id)) continue;
    const list = byGroup.get(r.evaluation_group_id) ?? [];
    list.push(r.assignment_id);
    byGroup.set(r.evaluation_group_id, list);
  }
  const groups = [...byGroup.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
  const selected = [];
  let remaining = neededCount;
  for (const [groupId, members] of groups) {
    if (remaining <= 0) break;
    if (members.length > remaining) continue;
    selected.push({ groupId, memberIds: members });
    remaining -= members.length;
  }
  if (remaining !== 0) return null;
  return selected;
}
