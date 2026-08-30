// Turn N4.9: synthetic-fixture unit tests for
// domain/evaluation/relation-closure-decision-respecting-graph.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  selectDecisionRespectingCandidates,
  buildDecisionRespectingGraph,
  buildComponentSplitMap,
  buildComponentAuthorMap,
  classifyProvisionalRow,
  CLOSED_LABELS,
} from "../domain/evaluation/relation-closure-decision-respecting-graph.mjs";
import { computeMaximalGraphSplitImpact, computeMaximalGraphAuthorImpact } from "../domain/evaluation/relation-closure-maximal-graph.mjs";

function packetRow({ id, source, sourceComponent, candidates }) {
  return {
    relation_candidate_id: id,
    source_document_id: source,
    source_component_id: sourceComponent,
    candidates: candidates.map((c) => ({ target_document_id: c.target, target_component_id: c.targetComponent ?? null, score: c.score ?? 0.3 })),
  };
}
function ledgerRow({ id, authority, disposition, confirmedTarget = null }) {
  return { relation_candidate_id: id, decision_authority: authority, final_disposition: disposition, confirmed_target_document_id: confirmedTarget };
}

test("selectDecisionRespectingCandidates: OWNER_V03 CONFIRM uses ONLY the confirmed target, never the other candidates", () => {
  const row = packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] });
  const ledger = ledgerRow({ id: "r1", authority: "OWNER_V03", disposition: "CONFIRM", confirmedTarget: "B" });
  const selected = selectDecisionRespectingCandidates({ packetRow: row, ledgerRow: ledger });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].target_document_id, "B");
});

test("selectDecisionRespectingCandidates: OWNER_V03 REJECT contributes ZERO edges", () => {
  const row = packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] });
  const ledger = ledgerRow({ id: "r1", authority: "OWNER_V03", disposition: "REJECT" });
  assert.deepEqual(selectDecisionRespectingCandidates({ packetRow: row, ledgerRow: ledger }), []);
});

test("selectDecisionRespectingCandidates: DUAL_REVIEW_C_D CONFIRM uses ONLY the agreed target", () => {
  const row = packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] });
  const ledger = ledgerRow({ id: "r1", authority: "DUAL_REVIEW_C_D", disposition: "CONFIRM", confirmedTarget: "C" });
  const selected = selectDecisionRespectingCandidates({ packetRow: row, ledgerRow: ledger });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].target_document_id, "C");
});

test("selectDecisionRespectingCandidates: QUARANTINED_UNRESOLVED contributes ZERO edges", () => {
  const row = packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] });
  const ledger = ledgerRow({ id: "r1", authority: "QUARANTINED_UNRESOLVED", disposition: "NEEDS_MORE_REVIEW" });
  assert.deepEqual(selectDecisionRespectingCandidates({ packetRow: row, ledgerRow: ledger }), []);
});

test("selectDecisionRespectingCandidates: REVIEWER_CONSENSUS_PROVISIONAL includes EVERY candidate", () => {
  const row = packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] });
  const ledger = ledgerRow({ id: "r1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" });
  const selected = selectDecisionRespectingCandidates({ packetRow: row, ledgerRow: ledger });
  assert.equal(selected.length, 2);
});

test("buildDecisionRespectingGraph: a REJECT row's candidate never merges components, even though it would under the extreme N4.8 graph", () => {
  const rows = [packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] })];
  const ledger = [ledgerRow({ id: "r1", authority: "OWNER_V03", disposition: "REJECT" })];
  const graph = buildDecisionRespectingGraph({ packetRows: rows, ledgerRows: ledger });
  assert.notEqual(graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"));
  assert.equal(graph.totalCandidateEdgeCount, 0);
});

test("buildDecisionRespectingGraph: OWNER_V03 CONFIRM merges only via the confirmed edge, the rejected sibling candidate is dropped", () => {
  const rows = [packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] })];
  const ledger = [ledgerRow({ id: "r1", authority: "OWNER_V03", disposition: "CONFIRM", confirmedTarget: "B" })];
  const graph = buildDecisionRespectingGraph({ packetRows: rows, ledgerRows: ledger });
  assert.equal(graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"));
  assert.notEqual(graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compC"));
  assert.equal(graph.totalCandidateEdgeCount, 1);
});

test("buildDecisionRespectingGraph: a REVIEWER_CONSENSUS_PROVISIONAL row still merges via ALL of its candidates (worst-case-plausible, not a fact)", () => {
  const rows = [packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }, { target: "C", targetComponent: "compC" }] })];
  const ledger = [ledgerRow({ id: "r1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const graph = buildDecisionRespectingGraph({ packetRows: rows, ledgerRows: ledger });
  const ids = new Set(["compA", "compB", "compC"].map((c) => graph.resolveMaximalComponentId(c)));
  assert.equal(ids.size, 1);
});

test("order independence: shuffling rows produces the identical decision-respecting component partition", () => {
  const rows = [
    packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] }),
    packetRow({ id: "r2", source: "C", sourceComponent: "compC", candidates: [{ target: "D", targetComponent: "compD" }, { target: "E", targetComponent: "compE" }] }),
  ];
  const ledger = [
    ledgerRow({ id: "r1", authority: "OWNER_V03", disposition: "CONFIRM", confirmedTarget: "B" }),
    ledgerRow({ id: "r2", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const graphA = buildDecisionRespectingGraph({ packetRows: rows, ledgerRows: ledger });
  const graphB = buildDecisionRespectingGraph({ packetRows: [...rows].reverse(), ledgerRows: [...ledger].reverse() });
  assert.equal(graphA.resolveMaximalComponentId("compC"), graphB.resolveMaximalComponentId("compC"));
  assert.equal(graphA.maximalComponents.length, graphB.maximalComponents.length);
});

test("duplicate candidate edges have no effect on the decision-respecting graph", () => {
  const rows1 = [packetRow({ id: "r1", source: "A", sourceComponent: "compA", candidates: [{ target: "B", targetComponent: "compB" }] })];
  const rows2 = [...rows1, { ...rows1[0], relation_candidate_id: "r1-dup" }];
  const ledger1 = [ledgerRow({ id: "r1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const ledger2 = [...ledger1, ledgerRow({ id: "r1-dup", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const graphOnce = buildDecisionRespectingGraph({ packetRows: rows1, ledgerRows: ledger1 });
  const graphTwice = buildDecisionRespectingGraph({ packetRows: rows2, ledgerRows: ledger2 });
  assert.equal(graphOnce.maximalComponents.length, graphTwice.maximalComponents.length);
});

// -- classifyProvisionalRow ---------------------------------------------

function makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows }) {
  function buildAndImpact(excludeIds) {
    const graph = buildDecisionRespectingGraph({ packetRows, ledgerRows, excludeRelationCandidateIds: excludeIds });
    const splitImpact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graph.resolveMaximalComponentId });
    const authorImpact = computeMaximalGraphAuthorImpact({ authorRows, resolveMaximalComponentId: graph.resolveMaximalComponentId });
    return { graph, splitImpact, authorImpact };
  }
  return { buildAndImpact };
}

test("counterexample: a synthetic DIRECT cross-split provisional edge is detected and marked INDIVIDUALLY_DECISIVE", () => {
  const packetRows = [packetRow({ id: "p1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const ledgerRows = [ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "HOLDOUT", anchor_document_ids: ["docB"] },
  ];
  const authorRows = [];
  const { buildAndImpact } = makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows });
  const baseline = buildAndImpact(new Set());
  assert.equal(baseline.splitImpact.ok, false);
  const violatingIds = new Set(baseline.splitImpact.violations.map((v) => v.maximal_component_id));
  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows });
  const result = classifyProvisionalRow({
    packetRow: packetRows[0],
    componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: baseline.graph.resolveMaximalComponentId,
    violatingMaximalComponentIds: violatingIds,
    baselineViolationCount: baseline.splitImpact.violations.length + baseline.authorImpact.violations.length,
    rebuildAndCountViolationsExcludingThisRow: (rid) => {
      const after = buildAndImpact(new Set([rid]));
      return { splitViolationCount: after.splitImpact.violations.length, authorViolationCount: after.authorImpact.violations.length };
    },
    otherProvisionalPacketRows: [],
  });
  assert.ok(result.labels.includes("DIRECT_CROSS_SPLIT_EDGE"));
  assert.ok(result.labels.includes("INDIVIDUALLY_DECISIVE"));
  assert.ok(!result.labels.includes("NO_CURRENT_SPLIT_IMPACT"));
  for (const l of result.labels) assert.ok(CLOSED_LABELS.includes(l));
});

test("counterexample: a synthetic INDIRECT/transitive leak (via a chain of two provisional rows) is detected, and BOTH rows touch the violating component", () => {
  // compA(DEV_TUNE) -- p1 --> compB -- p2 --> compC(HOLDOUT): neither edge is
  // a DIRECT cross-split edge on its own (compB has no planned_split, it is
  // never a Pool500 component), but the transitive merge still creates a
  // real DEV_TUNE/HOLDOUT leak.
  const packetRows = [
    packetRow({ id: "p1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "p2", source: "docB", sourceComponent: "compB", candidates: [{ target: "docC", targetComponent: "compC" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
    ledgerRow({ id: "p2", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignC", chain_component_id: "compC", planned_split: "HOLDOUT", anchor_document_ids: ["docC"] },
  ];
  const authorRows = [];
  const { buildAndImpact } = makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows });
  const baseline = buildAndImpact(new Set());
  assert.equal(baseline.splitImpact.ok, false, "the transitive chain must still register as a real leak even with no single direct-cross-split edge");
  const violatingIds = new Set(baseline.splitImpact.violations.map((v) => v.maximal_component_id));
  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows });
  const baselineCount = baseline.splitImpact.violations.length + baseline.authorImpact.violations.length;
  const classify = (row) => classifyProvisionalRow({
    packetRow: row, componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: baseline.graph.resolveMaximalComponentId,
    violatingMaximalComponentIds: violatingIds,
    baselineViolationCount: baselineCount,
    rebuildAndCountViolationsExcludingThisRow: (rid) => {
      const after = buildAndImpact(new Set([rid]));
      return { splitViolationCount: after.splitImpact.violations.length, authorViolationCount: after.authorImpact.violations.length };
    },
    otherProvisionalPacketRows: packetRows,
  });
  const r1 = classify(packetRows[0]);
  const r2 = classify(packetRows[1]);
  assert.ok(!r1.labels.includes("DIRECT_CROSS_SPLIT_EDGE"), "p1 (compA<->compB) touches no two Pool-known splits directly");
  assert.ok(!r2.labels.includes("DIRECT_CROSS_SPLIT_EDGE"), "p2 (compB<->compC) touches no two Pool-known splits directly either");
  assert.ok(r1.touches_violating_component && r2.touches_violating_component, "both legs of the transitive chain must be flagged as touching the violation");
  // Removing EITHER leg alone breaks the chain and fixes the leak -- both
  // are individually decisive here (a two-edge bridge has no redundancy).
  assert.ok(r1.labels.includes("INDIVIDUALLY_DECISIVE"));
  assert.ok(r2.labels.includes("INDIVIDUALLY_DECISIVE"));
});

test("redundant path: TWO independent provisional edges connecting the SAME two components -> neither is individually decisive, both marked REDUNDANT_BUT_COMPONENT_RELEVANT, never falsely INDIVIDUALLY_DECISIVE", () => {
  const packetRows = [
    packetRow({ id: "p1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "p2", source: "docA2", sourceComponent: "compA", candidates: [{ target: "docB2", targetComponent: "compB" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
    ledgerRow({ id: "p2", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "HOLDOUT", anchor_document_ids: ["docB"] },
  ];
  const authorRows = [];
  const { buildAndImpact } = makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows });
  const baseline = buildAndImpact(new Set());
  assert.equal(baseline.splitImpact.ok, false);
  const violatingIds = new Set(baseline.splitImpact.violations.map((v) => v.maximal_component_id));
  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows });
  const baselineCount = baseline.splitImpact.violations.length + baseline.authorImpact.violations.length;
  const classify = (row) => classifyProvisionalRow({
    packetRow: row, componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: baseline.graph.resolveMaximalComponentId,
    violatingMaximalComponentIds: violatingIds,
    baselineViolationCount: baselineCount,
    rebuildAndCountViolationsExcludingThisRow: (rid) => {
      const after = buildAndImpact(new Set([rid]));
      return { splitViolationCount: after.splitImpact.violations.length, authorViolationCount: after.authorImpact.violations.length };
    },
    otherProvisionalPacketRows: packetRows,
  });
  const r1 = classify(packetRows[0]);
  const r2 = classify(packetRows[1]);
  assert.ok(!r1.individually_decisive, "removing p1 alone leaves p2 still connecting compA/compB -- the leak persists");
  assert.ok(!r2.individually_decisive, "removing p2 alone leaves p1 still connecting compA/compB -- the leak persists");
  assert.ok(r1.labels.includes("REDUNDANT_BUT_COMPONENT_RELEVANT"));
  assert.ok(r2.labels.includes("REDUNDANT_BUT_COMPONENT_RELEVANT"));
  assert.ok(!r1.labels.includes("INDIVIDUALLY_DECISIVE"));
  assert.ok(!r2.labels.includes("INDIVIDUALLY_DECISIVE"));
  assert.ok(r1.duplicate_path_with_relation_candidate_ids.includes("p2"));
  assert.ok(r2.duplicate_path_with_relation_candidate_ids.includes("p1"));
});

test("NO_CURRENT_SPLIT_IMPACT counterexample: a provisional row entirely disconnected from any violating component gets exactly that single label", () => {
  const packetRows = [
    packetRow({ id: "p1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "p2", source: "docX", sourceComponent: "compX", candidates: [{ target: "docY", targetComponent: "compY" }] }),
  ];
  const ledgerRows = [
    ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
    ledgerRow({ id: "p2", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" }),
  ];
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "HOLDOUT", anchor_document_ids: ["docB"] },
    { assignment_id: "assignX", chain_component_id: "compX", planned_split: "DEV_TUNE", anchor_document_ids: ["docX"] },
    { assignment_id: "assignY", chain_component_id: "compY", planned_split: "DEV_TUNE", anchor_document_ids: ["docY"] },
  ];
  const authorRows = [];
  const { buildAndImpact } = makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows });
  const baseline = buildAndImpact(new Set());
  const violatingIds = new Set(baseline.splitImpact.violations.map((v) => v.maximal_component_id));
  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows });
  const baselineCount = baseline.splitImpact.violations.length + baseline.authorImpact.violations.length;
  const r2 = classifyProvisionalRow({
    packetRow: packetRows[1], componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: baseline.graph.resolveMaximalComponentId,
    violatingMaximalComponentIds: violatingIds,
    baselineViolationCount: baselineCount,
    rebuildAndCountViolationsExcludingThisRow: (rid) => {
      const after = buildAndImpact(new Set([rid]));
      return { splitViolationCount: after.splitImpact.violations.length, authorViolationCount: after.authorImpact.violations.length };
    },
    otherProvisionalPacketRows: packetRows,
  });
  assert.deepEqual(r2.labels, ["NO_CURRENT_SPLIT_IMPACT"]);
});

test("DIRECT_CROSS_AUTHOR_EDGE counterexample", () => {
  const packetRows = [packetRow({ id: "p1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const ledgerRows = [ledgerRow({ id: "p1", authority: "REVIEWER_CONSENSUS_PROVISIONAL", disposition: "PROVISIONAL_PENDING_NOT_YET_ESCALATED" })];
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "DEV_TUNE", anchor_document_ids: ["docB"] },
  ];
  const authorRows = [
    { assignment_id: "assignA", chain_component_id: "compA", author_allocation: "AUTHOR_A", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", author_allocation: "AUTHOR_B", anchor_document_ids: ["docB"] },
  ];
  const { buildAndImpact } = makeImpactChecker({ packetRows, ledgerRows, poolRecords, authorRows });
  const baseline = buildAndImpact(new Set());
  assert.equal(baseline.splitImpact.ok, true);
  assert.equal(baseline.authorImpact.ok, false);
  const violatingIds = new Set(baseline.authorImpact.violations.map((v) => v.maximal_component_id));
  const componentSplitMap = buildComponentSplitMap({ poolRecords });
  const componentAuthorMap = buildComponentAuthorMap({ authorRows });
  const result = classifyProvisionalRow({
    packetRow: packetRows[0], componentSplitMap, componentAuthorMap,
    resolveMaximalComponentId: baseline.graph.resolveMaximalComponentId,
    violatingMaximalComponentIds: violatingIds,
    baselineViolationCount: baseline.splitImpact.violations.length + baseline.authorImpact.violations.length,
    rebuildAndCountViolationsExcludingThisRow: (rid) => {
      const after = buildAndImpact(new Set([rid]));
      return { splitViolationCount: after.splitImpact.violations.length, authorViolationCount: after.authorImpact.violations.length };
    },
    otherProvisionalPacketRows: [],
  });
  assert.ok(result.labels.includes("DIRECT_CROSS_AUTHOR_EDGE"));
  assert.ok(!result.labels.includes("DIRECT_CROSS_SPLIT_EDGE"));
});
