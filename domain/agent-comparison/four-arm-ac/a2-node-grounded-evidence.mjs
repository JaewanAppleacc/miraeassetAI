// Turn A2-LATE-EXPANSION, section A/B: node-grounded evidence expansion over
// an already-frozen arm A top-20 result set. This module performs NO new
// retrieval. It never imports or calls bm25Search, reciprocalRankFusion,
// embedQuery, searchDocumentChunksByVector, or any KURE/dense/RRF path --
// grep the imports below: there are none. It only re-reads node-level
// content for node references that already exist in a retrieval item's own
// `provenance.candidates` (or, for callers/fixtures that predate the
// provenance sidecar, its flat `node_index`/`node_indices` fields) via a
// caller-supplied, read-only `fetchNode` function.
//
// `fetchNode` is a DEPENDENCY the caller injects, not something this module
// implements or wires to a database. The existing arm-retriever-adapter.mjs
// `fetch_node(doc_id, node_index, {row, col})` only verifies node IDENTITY
// (`node_text_available` is always false there -- see locator-provenance.mjs
// and AC_LOCATOR_READY_REPORT.md: node-local text is not persisted
// independently of chunk-level raw_text in that loader). This module's own
// contract for `fetchNode` is therefore a superset, expected to be satisfied
// by whatever node-content source the caller wires in (e.g. a NodeStore-
// backed reader, per UNRESOLVED_AUDIT_V1.md section D's own note that a
// NodeStore fetch_node "can supply the exact node text with zero new
// retrieval calls"):
//
//   fetchNode({ documentId, nodeIndex, row, col }) => Promise<{
//     found: boolean,
//     documentId: string,
//     nodeIndex: number,
//     nodeId: string | null,
//     sourceLocator: string | null,
//     isTable: boolean,
//     row: number | null,
//     col: number | null,
//     text: string | null,
//     table: null | {
//       title: string | null,
//       period: string | null,
//       unit: string | null,
//       rowLabels: string[] | null,
//       colLabels: string[] | null,
//     },
//   }>
//
// This module never fabricates a value `fetchNode` did not return -- a
// missing title/period/unit/rowLabels/colLabels is rendered as an absent
// line, never a guessed placeholder.

export const NODE_GROUNDED_STATUS = Object.freeze({ READY: "READY", UNRESOLVED: "UNRESOLVED" });

export const DEFAULT_LIMITS = Object.freeze({
  maxCandidateNodes: 8,
  maxExpandedChars: 12000,
  maxSingleNodeChars: 6000,
});

function uniquePreserveOrder(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Section A: candidate node indices come ONLY from the retrieval item's own
// provenance.candidates, or (fallback for items built before the
// provenance sidecar existed) its flat node_index/node_indices fields --
// never from an adjacent/neighboring node this module invents.
function gatherCandidateSpansByNode(retrievalItem) {
  const byNode = new Map();
  const provenance = retrievalItem?.provenance;
  if (provenance && Array.isArray(provenance.candidates) && provenance.candidates.length > 0) {
    for (const candidate of provenance.candidates) {
      const list = byNode.get(candidate.node_index) ?? [];
      list.push(candidate);
      byNode.set(candidate.node_index, list);
    }
    return byNode;
  }
  // Fallback: no provenance sidecar present at all (not "provenance present
  // but empty" -- that case is handled by the caller as UNRESOLVED before
  // reaching here). Build synthetic single-span candidates from whatever
  // flat node fields the item carries.
  const flatIndices = uniquePreserveOrder([
    ...(Number.isInteger(retrievalItem?.node_index) ? [retrievalItem.node_index] : []),
    ...(Array.isArray(retrievalItem?.node_indices) ? retrievalItem.node_indices.filter(Number.isInteger) : []),
  ]);
  for (const nodeIndex of flatIndices) {
    byNode.set(nodeIndex, [{
      node_index: nodeIndex, node_id: null,
      row_start: null, row_end: null, col_start: null, col_end: null,
      source_locator: retrievalItem?.locator ?? null, is_table: false,
    }]);
  }
  return byNode;
}

function isProvenanceUnresolved(retrievalItem) {
  return retrievalItem?.provenance?.unresolved === true;
}

function buildTableHeaderLines(table) {
  if (!table) return [];
  const lines = [];
  if (table.title) lines.push(`제목: ${table.title}`);
  if (table.period) lines.push(`기간: ${table.period}`);
  if (table.unit) lines.push(`단위: ${table.unit}`);
  if (Array.isArray(table.rowLabels) && table.rowLabels.length > 0) lines.push(`행: ${table.rowLabels.join(", ")}`);
  if (Array.isArray(table.colLabels) && table.colLabels.length > 0) lines.push(`열: ${table.colLabels.join(", ")}`);
  return lines;
}

// Builds one node's minimal content string under maxSingleNodeChars.
// Returns { content, dimensionTruncated, singleNodeTruncated, headerLines }.
// For a table node, the header lines (title/period/unit/row/col) are never
// partially cut -- either the full header fits and only the body is
// truncated, or the header itself does not fit and this is reported as a
// dimension loss (the caller escalates that to overall UNRESOLVED).
function buildNodeContent(fetchResult, maxSingleNodeChars) {
  const isTable = Boolean(fetchResult.isTable);
  const bodyText = typeof fetchResult.text === "string" ? fetchResult.text : "";
  if (!isTable) {
    const truncated = bodyText.length > maxSingleNodeChars;
    return {
      content: truncated ? bodyText.slice(0, maxSingleNodeChars) : bodyText,
      dimensionTruncated: false,
      singleNodeTruncated: truncated,
      headerLines: [],
    };
  }
  const headerLines = buildTableHeaderLines(fetchResult.table);
  const headerText = headerLines.join("\n");
  if (headerText.length > maxSingleNodeChars) {
    return { content: null, dimensionTruncated: true, singleNodeTruncated: true, headerLines };
  }
  const separator = headerText && bodyText ? "\n" : "";
  const fullText = headerText + separator + bodyText;
  if (fullText.length <= maxSingleNodeChars) {
    return { content: fullText, dimensionTruncated: false, singleNodeTruncated: false, headerLines };
  }
  const allowedBody = Math.max(0, maxSingleNodeChars - headerText.length - separator.length);
  const truncatedBody = bodyText.slice(0, allowedBody);
  return {
    content: headerText + separator + truncatedBody,
    dimensionTruncated: false,
    singleNodeTruncated: true,
    headerLines,
  };
}

export async function buildNodeGroundedEvidence({ retrievalItem, fetchNode, limits = {} }) {
  if (!retrievalItem || typeof retrievalItem !== "object") throw new TypeError("retrievalItem is required");
  if (typeof fetchNode !== "function") throw new TypeError("fetchNode function is required");
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const { maxCandidateNodes, maxExpandedChars, maxSingleNodeChars } = effectiveLimits;

  const sourceChunkId = retrievalItem.chunk_id ?? null;
  const documentId = retrievalItem.doc_id ?? null;

  const base = {
    sourceChunkId, documentId,
    candidateNodeIndices: [], expandedNodes: [], tableContext: [], locatorCandidates: [],
    truncation: {
      candidateNodesTruncated: false, totalCandidateNodeCount: 0, includedCandidateNodeCount: 0,
      expandedCharsTruncated: false, totalExpandedChars: 0, singleNodeTruncatedNodeIndices: [],
    },
    provenance: retrievalItem.provenance ?? null,
  };

  if (isProvenanceUnresolved(retrievalItem)) {
    return Object.freeze({
      status: NODE_GROUNDED_STATUS.UNRESOLVED,
      unresolvedReason: "NO_SOURCE_SPANS_PERSISTED",
      ...base,
    });
  }

  const byNode = gatherCandidateSpansByNode(retrievalItem);
  const totalCandidateNodeCount = byNode.size;
  if (totalCandidateNodeCount === 0) {
    return Object.freeze({
      status: NODE_GROUNDED_STATUS.UNRESOLVED,
      unresolvedReason: "NO_CANDIDATE_NODES",
      ...base,
    });
  }

  const orderedNodeIndices = [...byNode.keys()];
  const candidateNodesTruncated = orderedNodeIndices.length > maxCandidateNodes;
  const includedNodeIndices = orderedNodeIndices.slice(0, maxCandidateNodes);

  const locatorCandidates = [];
  for (const nodeIndex of includedNodeIndices) {
    for (const span of byNode.get(nodeIndex)) {
      locatorCandidates.push(Object.freeze({
        nodeIndex, row: span.row_start ?? null, col: span.col_start ?? null,
        sourceLocator: span.source_locator ?? null,
      }));
    }
  }

  let anyFetchFailure = false;
  let dimensionLossReason = null;
  const expandedNodes = [];
  const singleNodeTruncatedNodeIndices = [];
  let remainingBudget = maxExpandedChars;
  let totalExpandedChars = 0;
  let budgetExhausted = false;

  for (const nodeIndex of includedNodeIndices) {
    const representativeSpan = byNode.get(nodeIndex)[0];
    let fetchResult;
    try {
      fetchResult = await fetchNode({ documentId, nodeIndex, row: null, col: null });
    } catch {
      fetchResult = null;
    }

    const valid = fetchResult && fetchResult.found === true
      && fetchResult.documentId === documentId && fetchResult.nodeIndex === nodeIndex;
    if (!valid) {
      anyFetchFailure = true;
      expandedNodes.push(Object.freeze({
        nodeIndex, nodeId: representativeSpan.node_id ?? null,
        isTable: Boolean(representativeSpan.is_table), sourceLocator: representativeSpan.source_locator ?? null,
        row: representativeSpan.row_start ?? null, col: representativeSpan.col_start ?? null,
        text: null, tableContext: null, charLength: 0, truncated: false, fetchFailed: true,
      }));
      continue;
    }

    if (budgetExhausted) {
      expandedNodes.push(Object.freeze({
        nodeIndex, nodeId: fetchResult.nodeId ?? representativeSpan.node_id ?? null,
        isTable: Boolean(fetchResult.isTable), sourceLocator: fetchResult.sourceLocator ?? representativeSpan.source_locator ?? null,
        row: fetchResult.row ?? null, col: fetchResult.col ?? null,
        text: null, tableContext: null, charLength: 0, truncated: false, excludedByBudget: true,
      }));
      continue;
    }

    const built = buildNodeContent(fetchResult, maxSingleNodeChars);
    if (built.dimensionTruncated) {
      dimensionLossReason = "REQUIRED_TABLE_DIMENSION_TRUNCATED";
      expandedNodes.push(Object.freeze({
        nodeIndex, nodeId: fetchResult.nodeId ?? null, isTable: true,
        sourceLocator: fetchResult.sourceLocator ?? null, row: fetchResult.row ?? null, col: fetchResult.col ?? null,
        text: null, tableContext: null, charLength: 0, truncated: true, dimensionTruncated: true,
      }));
      continue;
    }

    let content = built.content;
    let singleNodeTruncated = built.singleNodeTruncated;
    if (content.length > remainingBudget) {
      const headerLen = built.headerLines.join("\n").length;
      const headerSeparatorLen = built.headerLines.length > 0 && content.length > headerLen ? 1 : 0;
      if (fetchResult.isTable && headerLen + headerSeparatorLen > remainingBudget) {
        dimensionLossReason = "REQUIRED_TABLE_DIMENSION_TRUNCATED";
        expandedNodes.push(Object.freeze({
          nodeIndex, nodeId: fetchResult.nodeId ?? null, isTable: true,
          sourceLocator: fetchResult.sourceLocator ?? null, row: fetchResult.row ?? null, col: fetchResult.col ?? null,
          text: null, tableContext: null, charLength: 0, truncated: true, dimensionTruncated: true,
        }));
        budgetExhausted = true;
        continue;
      }
      content = content.slice(0, remainingBudget);
      singleNodeTruncated = true;
      budgetExhausted = true;
    }

    remainingBudget -= content.length;
    totalExpandedChars += content.length;
    if (singleNodeTruncated) singleNodeTruncatedNodeIndices.push(nodeIndex);

    const tableContext = fetchResult.isTable
      ? Object.freeze({
        nodeIndex, title: fetchResult.table?.title ?? null, period: fetchResult.table?.period ?? null,
        unit: fetchResult.table?.unit ?? null, rowLabels: fetchResult.table?.rowLabels ?? null,
        colLabels: fetchResult.table?.colLabels ?? null, locator: fetchResult.sourceLocator ?? null,
      })
      : null;

    expandedNodes.push(Object.freeze({
      nodeIndex, nodeId: fetchResult.nodeId ?? null, isTable: Boolean(fetchResult.isTable),
      sourceLocator: fetchResult.sourceLocator ?? null, row: fetchResult.row ?? null, col: fetchResult.col ?? null,
      text: content, tableContext, charLength: content.length, truncated: singleNodeTruncated,
    }));
  }

  const tableContext = expandedNodes.map((n) => n.tableContext).filter((t) => t !== null);
  const expandedCharsTruncated = budgetExhausted;

  const result = {
    sourceChunkId, documentId,
    candidateNodeIndices: includedNodeIndices,
    expandedNodes: Object.freeze(expandedNodes),
    tableContext: Object.freeze(tableContext),
    locatorCandidates: Object.freeze(locatorCandidates),
    truncation: Object.freeze({
      candidateNodesTruncated,
      totalCandidateNodeCount,
      includedCandidateNodeCount: includedNodeIndices.length,
      expandedCharsTruncated,
      totalExpandedChars,
      singleNodeTruncatedNodeIndices: Object.freeze(singleNodeTruncatedNodeIndices),
    }),
    provenance: retrievalItem.provenance ?? null,
  };

  if (dimensionLossReason) {
    return Object.freeze({ status: NODE_GROUNDED_STATUS.UNRESOLVED, unresolvedReason: dimensionLossReason, ...result });
  }
  if (anyFetchFailure) {
    return Object.freeze({ status: NODE_GROUNDED_STATUS.UNRESOLVED, unresolvedReason: "NODE_FETCH_FAILED", ...result });
  }
  return Object.freeze({ status: NODE_GROUNDED_STATUS.READY, unresolvedReason: null, ...result });
}
