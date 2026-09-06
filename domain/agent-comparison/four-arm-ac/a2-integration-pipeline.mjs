// Turn A2-INTEGRATION-AND-DEVTUNE-V1: composes the two independently-built
// A2 modules (a2-node-grounded-evidence.mjs, a2-evidence-scope-validator.mjs,
// a2-stable-evidence-filter.mjs) into the single fixed pipeline:
//
//   frozen Arm A top-20 item
//     -> buildNodeGroundedEvidence (node-grounded late expansion)
//     -> [schema bridge: expanded-evidence shape -> validator's flat context]
//     -> validateEvidenceDimensions (scope/period/unit/row-column/entity)
//     -> applyStableEvidenceFilter (PASS-only, stable refill, over all 20 items)
//
// This module performs NO new retrieval, NO new candidate generation, and
// NO scoring/re-ranking of its own -- it only sequences the three existing
// pure functions and adapts one schema gap between the first two (see
// mapExpandedEvidenceForValidator below), discovered while integrating the
// two independently-implemented Turns' output shapes.
//
// Schema gap found and bridged here (Section D.1 of the integration task):
// buildNodeGroundedEvidence()'s return shape has no flat scope_hint/period/
// unit/row_label/column_label/table_title/entity fields -- it returns
// per-node `expandedNodes[]`/`tableContext[]` arrays instead.
// validateEvidenceDimensions()'s `expandedEvidence` parameter expects
// exactly those flat fields. mapExpandedEvidenceForValidator() bridges this
// by reading ONLY already-fetched node content (never inventing a value),
// and only emits a flat field when it is unambiguous across every table
// node actually expanded for this evidence item -- any genuine ambiguity
// (more than one distinct table title/period/unit, or a row/col index that
// does not resolve to a single label) is left null (which the validator
// then treats as UNRESOLVED for that dimension, never guessed).

import { NODE_GROUNDED_STATUS } from "./a2-node-grounded-evidence.mjs";
import { validateEvidenceDimensions, VALIDATION_STATUS as SCOPE_STATUS } from "./a2-evidence-scope-validator.mjs";
import { applyStableEvidenceFilter, VALIDATION_STATUS as FILTER_STATUS } from "./a2-stable-evidence-filter.mjs";

export const A2_PIPELINE_VERSION = "fourarm.a2-integration-pipeline.v1";

function uniqueDefined(values) {
  const out = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// Returns the single value shared by every entry in `values`, or null if
// zero or more-than-one distinct non-null value is present. Never guesses
// among several candidates.
function soleValue(values) {
  const distinct = uniqueDefined(values);
  return distinct.length === 1 ? distinct[0] : null;
}

// Bridges buildNodeGroundedEvidence()'s output into the flat evidence
// context validateEvidenceDimensions() expects. Reads only text/table
// fields fetchNode actually returned (via expandedNodes/tableContext);
// never reads retrievalItem here (the caller still passes the original
// retrievalItem separately into validateEvidenceDimensions, which merges
// it as a fallback for fields this bridge cannot fill, e.g. `entity`).
export function mapExpandedEvidenceForValidator(nodeGroundedEvidence) {
  if (!nodeGroundedEvidence || typeof nodeGroundedEvidence !== "object") {
    return Object.freeze({});
  }
  const tables = Array.isArray(nodeGroundedEvidence.tableContext) ? nodeGroundedEvidence.tableContext : [];
  const nodes = Array.isArray(nodeGroundedEvidence.expandedNodes) ? nodeGroundedEvidence.expandedNodes : [];

  const table_title = soleValue(tables.map((t) => t.title));
  // The validator's `period` field expects an already-structured
  // { fiscal_year, start_month, end_month } (or { label }) object -- a raw
  // Korean phrase must go through its `period_hint` field instead (see
  // a2-evidence-scope-validator.mjs's resolveObservedPeriod/resolvePeriodRange).
  // fetchNode's `table.period` is a raw phrase, so it is bridged as
  // `period_hint`, never as `period` (which would silently fail to parse).
  const period_hint = soleValue(tables.map((t) => t.period));
  const unit = soleValue(tables.map((t) => t.unit));

  // row_label/column_label are resolvable only when exactly one table node
  // was expanded AND that node's own row/col index falls within the label
  // arrays fetchNode returned for it -- never picked from a multi-table
  // set, never defaulted to index 0.
  let row_label = null;
  let column_label = null;
  if (tables.length === 1) {
    const table = tables[0];
    const node = nodes.find((n) => n.nodeIndex === table.nodeIndex) ?? null;
    const rowIdx = node?.row ?? null;
    const colIdx = node?.col ?? null;
    if (Number.isInteger(rowIdx) && Array.isArray(table.rowLabels) && rowIdx >= 0 && rowIdx < table.rowLabels.length) {
      row_label = table.rowLabels[rowIdx] ?? null;
    }
    if (Number.isInteger(colIdx) && Array.isArray(table.colLabels) && colIdx >= 0 && colIdx < table.colLabels.length) {
      column_label = table.colLabels[colIdx] ?? null;
    }
  }

  // scope_hint: the scope validator only scans for literal 연결/별도/개별
  // markers -- concatenating whatever real text/table-title fetchNode
  // returned (never a Gold/label lookup) lets that scan run over the actual
  // fetched content instead of leaving the dimension permanently
  // UNRESOLVED just because no module exposes a dedicated "scope" field.
  const scopeHintParts = [
    ...tables.map((t) => t.title).filter((v) => typeof v === "string"),
    ...nodes.map((n) => n.text).filter((v) => typeof v === "string"),
  ];
  const scope_hint = scopeHintParts.length > 0 ? scopeHintParts.join("\n") : null;

  return Object.freeze({
    table_title, period_hint, unit, row_label, column_label, scope_hint,
  });
}

// One frozen top-20 item, end to end through expansion + validation.
// `fetchNode`: injected, read-only (Section C contract). `questionConditions`:
// this item's question's frozen dimension requirements (Section B). Never
// reads Gold. Returns { chunkId, nodeGroundedEvidence, validation,
// validationResult: { chunkId, status, reason } } -- the last field is
// exactly applyStableEvidenceFilter()'s expected validationResults entry
// shape.
export async function evaluateFrozenItem({ retrievalItem, questionConditions, fetchNode, limits, resolveEntity }) {
  const chunkId = retrievalItem?.chunk_id ?? null;
  const { buildNodeGroundedEvidence } = await import("./a2-node-grounded-evidence.mjs");
  const nodeGroundedEvidence = await buildNodeGroundedEvidence({ retrievalItem, fetchNode, limits });

  // Neither A's own result items nor buildNodeGroundedEvidence's output
  // carries an `entity` field (there is no such field anywhere upstream) --
  // an optional, caller-supplied, doc_id-keyed resolver (e.g. the real
  // documents.jsonl's own `filer_name`, never Gold) is the only way the
  // entity dimension can ever resolve to anything but permanently
  // UNRESOLVED. mergeEvidenceContext still prefers expandedEvidence's own
  // `entity` (there isn't one) before falling back to this.
  const entityContext = typeof resolveEntity === "function"
    ? { ...retrievalItem, entity: resolveEntity(retrievalItem?.doc_id ?? null) ?? retrievalItem?.entity ?? null }
    : retrievalItem;

  if (nodeGroundedEvidence.status === NODE_GROUNDED_STATUS.UNRESOLVED) {
    return Object.freeze({
      chunkId,
      nodeGroundedEvidence,
      validation: null,
      validationResult: Object.freeze({
        chunkId, status: FILTER_STATUS.UNRESOLVED,
        reason: nodeGroundedEvidence.unresolvedReason ?? "NODE_EXPANSION_UNRESOLVED",
      }),
    });
  }

  const expandedEvidence = mapExpandedEvidenceForValidator(nodeGroundedEvidence);
  const validation = validateEvidenceDimensions({ questionConditions, retrievalItem: entityContext, expandedEvidence });

  const status = validation.status === SCOPE_STATUS.PASS
    ? FILTER_STATUS.PASS
    : validation.status === SCOPE_STATUS.REJECT
      ? FILTER_STATUS.REJECT
      : FILTER_STATUS.UNRESOLVED;

  return Object.freeze({
    chunkId,
    nodeGroundedEvidence,
    validation,
    validationResult: Object.freeze({
      chunkId, status, reason: validation.reasons[0] ?? null,
    }),
  });
}

// The full fixed pipeline over one question's frozen top-20 (Section A/F):
// expand + validate every item, then one stable PASS-only refill pass.
// `questionConditionsByChunkId`: Map or plain object keyed by chunk_id ->
// questionConditions (every item in one top-20 belongs to the same
// question, so in practice this is usually one shared questionConditions
// object, but per-chunk lookup is supported for callers that vary it).
export async function runA2OverFrozenTop20({
  frozenTop20, questionConditions, questionConditionsByChunkId, fetchNode, finalK, limits, resolveEntity,
}) {
  if (!Array.isArray(frozenTop20)) throw new TypeError("frozenTop20 must be an array");
  if (typeof fetchNode !== "function") throw new TypeError("fetchNode function is required");

  const conditionsFor = (chunkId) => {
    if (questionConditionsByChunkId) {
      return questionConditionsByChunkId instanceof Map
        ? questionConditionsByChunkId.get(chunkId)
        : questionConditionsByChunkId[chunkId];
    }
    return questionConditions;
  };

  const perItem = [];
  for (const item of frozenTop20) {
    // Sequential, not Promise.all: preserves any ordering-sensitive
    // fail-closed behavior in a caller-supplied fetchNode and keeps a
    // deterministic, reproducible trace order matching frozenTop20's order.
    // eslint-disable-next-line no-await-in-loop
    const evaluated = await evaluateFrozenItem({
      retrievalItem: item,
      questionConditions: conditionsFor(item?.chunk_id ?? null),
      fetchNode,
      limits,
      resolveEntity,
    });
    perItem.push(evaluated);
  }

  const validationResults = perItem.map((e) => e.validationResult);
  const filterResult = applyStableEvidenceFilter({ frozenTop20, validationResults, finalK });

  return Object.freeze({
    version: A2_PIPELINE_VERSION,
    perItem: Object.freeze(perItem),
    validationResults: Object.freeze(validationResults),
    filterResult,
  });
}
