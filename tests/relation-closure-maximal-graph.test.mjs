// Turn N4.8: synthetic-fixture unit tests for
// domain/evaluation/relation-closure-maximal-graph.mjs -- Path 2's
// conservative maximal plausible graph. These fixtures are invented (never
// real corpus data) so a genuine leakage counterexample can be constructed
// and confirmed detected, independent of whatever the real 326-row packet
// happens to contain.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMaximalPlausibleGraph,
  computeMaximalGraphSplitImpact,
  computeMaximalGraphAuthorImpact,
  computeMaximalGraphQuarantineImpact,
  buildDocumentToBaseComponentMap,
  suggestReplacementCandidates,
} from "../domain/evaluation/relation-closure-maximal-graph.mjs";

function packetRow({ id, source, sourceComponent, candidates }) {
  return {
    relation_candidate_id: id,
    source_document_id: source,
    source_component_id: sourceComponent,
    candidates: candidates.map((c) => ({
      target_document_id: c.target,
      target_component_id: c.targetComponent ?? null,
      score: c.score ?? 0.3,
    })),
  };
}

test("buildMaximalPlausibleGraph: two rows with NO cross-component candidate never merge", () => {
  const rows = [
    packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docA2", targetComponent: "compA" }] }),
    packetRow({ id: "r2", source: "docB", sourceComponent: "compB", candidates: [{ target: "docB2", targetComponent: "compB" }] }),
  ];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  assert.equal(graph.resolveMaximalComponentId("compA") !== graph.resolveMaximalComponentId("compB"), true);
  assert.equal(graph.totalCandidateEdgeCount, 2);
  assert.equal(graph.distinctCrossComponentPairCount, 0);
});

test("buildMaximalPlausibleGraph: a single REJECTED-shaped candidate (disposition never read) still merges components -- worst case includes it", () => {
  // This module has no disposition field at all -- it cannot distinguish
  // REJECT from CONFIRM from PROVISIONAL, which is the point: every listed
  // candidate is treated as worst-case-plausible.
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  assert.equal(graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"));
});

test("buildMaximalPlausibleGraph: transitive chain A-B-C merges all three into one maximal component", () => {
  const rows = [
    packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "r2", source: "docB", sourceComponent: "compB", candidates: [{ target: "docC", targetComponent: "compC" }] }),
  ];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const ids = new Set([graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"), graph.resolveMaximalComponentId("compC")]);
  assert.equal(ids.size, 1);
  assert.equal(graph.maximalComponents.length, 1);
  assert.deepEqual(graph.maximalComponents[0].member_base_component_ids, ["compA", "compB", "compC"]);
});

test("buildMaximalPlausibleGraph: candidates with no known component (null) are excluded from merges but still reported", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docFloating", targetComponent: null }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  assert.equal(graph.excludedNoComponentEdges.length, 1);
  assert.equal(graph.excludedNoComponentEdges[0].target_document_id, "docFloating");
  assert.equal(graph.maximalComponents.length, 0); // compA never touched a valid cross-component pair
});

test("buildMaximalPlausibleGraph: EVERY candidate edge is included, not just the top-scored one per row", () => {
  const rows = [
    packetRow({
      id: "r1", source: "docA", sourceComponent: "compA",
      candidates: [
        { target: "docB", targetComponent: "compB", score: 0.9 },
        { target: "docC", targetComponent: "compC", score: 0.1 },
      ],
    }),
  ];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  assert.equal(graph.totalCandidateEdgeCount, 2);
  const ids = new Set([graph.resolveMaximalComponentId("compA"), graph.resolveMaximalComponentId("compB"), graph.resolveMaximalComponentId("compC")]);
  assert.equal(ids.size, 1, "the LOW-scored (0.1) candidate must still be unioned -- Path 2 is not top-candidate-only");
});

test("order independence: shuffling row and candidate order produces the identical maximal component partition", () => {
  const rowsA = [
    packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "r2", source: "docC", sourceComponent: "compC", candidates: [{ target: "docA", targetComponent: "compA" }, { target: "docD", targetComponent: "compD" }] }),
    packetRow({ id: "r3", source: "docE", sourceComponent: "compE", candidates: [{ target: "docF", targetComponent: "compF" }] }),
  ];
  const rowsB = [rowsA[2], rowsA[0], { ...rowsA[1], candidates: [...rowsA[1].candidates].reverse() }];
  const graphA = buildMaximalPlausibleGraph({ packetRows: rowsA });
  const graphB = buildMaximalPlausibleGraph({ packetRows: rowsB });
  const digest = (graph) => graph.maximalComponents.map((c) => c.maximal_component_id).sort().join(",");
  assert.equal(digest(graphA), digest(graphB));
  assert.equal(graphA.resolveMaximalComponentId("compA"), graphB.resolveMaximalComponentId("compA"));
  assert.equal(graphA.resolveMaximalComponentId("compE"), graphB.resolveMaximalComponentId("compE"));
});

test("duplicate edges have no effect: the same candidate edge listed twice produces the identical result as listed once", () => {
  const once = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const twice = [
    packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
    packetRow({ id: "r1-dup", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] }),
  ];
  const graphOnce = buildMaximalPlausibleGraph({ packetRows: once });
  const graphTwice = buildMaximalPlausibleGraph({ packetRows: twice });
  assert.equal(graphOnce.maximalComponents.length, graphTwice.maximalComponents.length);
  assert.equal(graphOnce.resolveMaximalComponentId("compA"), graphTwice.resolveMaximalComponentId("compA"));
  assert.equal(graphOnce.distinctCrossComponentPairCount, graphTwice.distinctCrossComponentPairCount);
});

test("counterexample: computeMaximalGraphSplitImpact DETECTS a genuine cross-split leakage introduced only by a plausible (unconfirmed) candidate", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "HOLDOUT", anchor_document_ids: ["docB"] },
  ];
  const impact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.equal(impact.ok, false);
  assert.equal(impact.violations.length, 1);
  assert.equal(impact.violations[0].type, "MAXIMAL_GRAPH_CROSS_SPLIT_LEAKAGE");
  assert.deepEqual(impact.violations[0].splits, ["DEV_TUNE", "HOLDOUT"]);
  assert.deepEqual(impact.violations[0].assignment_ids, ["assignA", "assignB"]);
});

test("counterexample negative control: the SAME two components with the SAME planned_split never false-positive", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "DEV_TUNE", anchor_document_ids: ["docB"] },
  ];
  const impact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.equal(impact.ok, true);
  assert.equal(impact.violations.length, 0);
});

test("computeMaximalGraphSplitImpact: a chain component never touched by any candidate never appears as a violation (isolated singleton)", () => {
  const graph = buildMaximalPlausibleGraph({ packetRows: [] });
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compIsolated", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
  ];
  const impact = computeMaximalGraphSplitImpact({ poolRecords, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.equal(impact.ok, true);
});

test("computeMaximalGraphAuthorImpact: detects a cross-author leakage the same way as cross-split", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const authorRows = [
    { assignment_id: "assignA", chain_component_id: "compA", author_allocation: "AUTHOR_A", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", author_allocation: "AUTHOR_B", anchor_document_ids: ["docB"] },
  ];
  const impact = computeMaximalGraphAuthorImpact({ authorRows, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.equal(impact.ok, false);
  assert.equal(impact.violations[0].type, "MAXIMAL_GRAPH_CROSS_AUTHOR_LEAKAGE");
  assert.deepEqual(impact.violations[0].authors, ["AUTHOR_A", "AUTHOR_B"]);
});

test("computeMaximalGraphAuthorImpact negative control: same author, no violation", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const authorRows = [
    { assignment_id: "assignA", chain_component_id: "compA", author_allocation: "AUTHOR_A", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", author_allocation: "AUTHOR_A", anchor_document_ids: ["docB"] },
  ];
  const impact = computeMaximalGraphAuthorImpact({ authorRows, resolveMaximalComponentId: graph.resolveMaximalComponentId });
  assert.equal(impact.ok, true);
});

test("computeMaximalGraphQuarantineImpact: a still-included Anchor document is flagged when a plausible edge chains it to a quarantined document's component", () => {
  const rows = [packetRow({ id: "r1", source: "docActive", sourceComponent: "compActive", candidates: [{ target: "docQuarantined", targetComponent: "compQuarantine" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: rows });
  const authorRows = [{ assignment_id: "assignActive", chain_component_id: "compActive", anchor_document_ids: ["docActive"] }];
  const impact = computeMaximalGraphQuarantineImpact({
    quarantineDocumentIds: ["docQuarantined"],
    docToBaseComponentId,
    authorRows,
    resolveMaximalComponentId: graph.resolveMaximalComponentId,
  });
  assert.equal(impact.ok, false);
  assert.equal(impact.violations[0].type, "MAXIMAL_GRAPH_QUARANTINE_INTRUSION_RISK");
  assert.equal(impact.violations[0].assignment_id, "assignActive");
});

test("computeMaximalGraphQuarantineImpact negative control: an Anchor document with no plausible path to any quarantined document is never flagged", () => {
  const rows = [packetRow({ id: "r1", source: "docActive", sourceComponent: "compActive", candidates: [{ target: "docOther", targetComponent: "compOther" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const docToBaseComponentId = buildDocumentToBaseComponentMap({ packetRows: rows });
  const authorRows = [{ assignment_id: "assignActive", chain_component_id: "compActive", anchor_document_ids: ["docActive"] }];
  const impact = computeMaximalGraphQuarantineImpact({
    quarantineDocumentIds: ["docQuarantined"],
    docToBaseComponentId,
    authorRows,
    resolveMaximalComponentId: graph.resolveMaximalComponentId,
  });
  assert.equal(impact.ok, true);
});

test("suggestReplacementCandidates: never suggests an assignment that is itself violating, already an Anchor member, or inside the violating maximal component", () => {
  const rows = [packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }] })];
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  const poolRecords = [
    { assignment_id: "assignA", chain_component_id: "compA", planned_split: "DEV_TUNE", anchor_document_ids: ["docA"] },
    { assignment_id: "assignB", chain_component_id: "compB", planned_split: "DEV_TUNE", anchor_document_ids: ["docB"] },
    { assignment_id: "assignC", chain_component_id: "compC", planned_split: "DEV_TUNE", anchor_document_ids: ["docC"] },
    { assignment_id: "assignAnchorAlready", chain_component_id: "compD", planned_split: "DEV_TUNE", anchor_document_ids: ["docD"] },
  ];
  const suggestions = suggestReplacementCandidates({
    violatingAssignmentIds: ["assignA"],
    poolRecords,
    anchorV02AssignmentIds: ["assignA", "assignAnchorAlready"],
    resolveMaximalComponentId: graph.resolveMaximalComponentId,
    targetPlannedSplit: "DEV_TUNE",
  });
  const suggestedIds = suggestions.map((s) => s.assignment_id);
  assert.deepEqual(suggestedIds, ["assignC"]);
});

test("totalCandidateEdgeCount matches the raw sum of every row's candidates array length (full inclusion, never sampled)", () => {
  const rows = [
    packetRow({ id: "r1", source: "docA", sourceComponent: "compA", candidates: [{ target: "docB", targetComponent: "compB" }, { target: "docC", targetComponent: "compC" }] }),
    packetRow({ id: "r2", source: "docD", sourceComponent: "compD", candidates: [{ target: "docE", targetComponent: "compE" }] }),
  ];
  const expected = rows.reduce((sum, r) => sum + r.candidates.length, 0);
  const graph = buildMaximalPlausibleGraph({ packetRows: rows });
  assert.equal(graph.totalCandidateEdgeCount, expected);
  assert.equal(graph.rawEdges.length, expected);
});
