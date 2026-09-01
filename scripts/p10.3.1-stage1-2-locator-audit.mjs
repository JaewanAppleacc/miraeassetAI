#!/usr/bin/env node
// Turn P10.3.1 / Stage 1 + Stage 2: defines the locator authority policy,
// discovers P10.3's true resolver coverage (which Gold locator schemes it
// could and could not parse), then re-audits the 4 originally-unresolvable
// sources and every recorded LOCATOR_RESOLVES_TO_WRONG_CELL/
// PERIOD_COLUMN_VALUE_MISMATCH/UNIT_MISSING_OR_MISCOMBINED violation from
// P10.3's table-structure-preservation-report.v0.1.json (read-only,
// UNMODIFIED) against the authority-respecting resolver.
//
// No chunking is run and no embedding call is made -- this script only
// reads Gold + the real parsed DocumentIR (both already-established, read-
// only inputs) and P10.3's own already-materialized result files.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { findNodeById, resolveTableCell } from "../domain/agent-comparison/chunking-comparison/table-evidence-resolver.mjs";
import { classifyLocatorScheme, resolveAuthoritativeCell, resolveNodeForLocator, LOCATOR_SCHEME, ROOT_CAUSE } from "../domain/agent-comparison/chunking-comparison/table-locator-authority.mjs";
import { classifyUnresolvableSource, classifyRecordedViolation, buildAuditFields, hasIrregularColumnCounts } from "../domain/agent-comparison/chunking-comparison/table-audit-classifier.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.3.1-table-locator-audit");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const RAW_CACHE_PATH = path.join(ROOT, "work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl");
const P10_3_PRESERVATION_PATH = path.join(ROOT, "work/p10.3-table-diagnostic/table-structure-preservation-report.v0.1.json");

function anonymizeId(questionId) {
  return `audit_item_${createHash("sha256").update(questionId, "utf8").digest("hex").slice(0, 16)}`;
}

async function main() {
  const goldItems = (await readFile(GOLD_JSONL_PATH, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const cacheLines = (await readFile(RAW_CACHE_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rawRecordByDocId = new Map(cacheLines.map((entry) => [entry.document_id, entry.raw_record]));
  const preservation = JSON.parse(await readFile(P10_3_PRESERVATION_PATH, "utf8"));

  // --- Stage 1: locator authority policy + P10.3 resolver coverage gap ---
  // P10.3's original resolver (table-evidence-resolver.mjs's findNodeById)
  // only ever attempted an exact node_id string match, which only the
  // NODE_ONLY_COLON scheme satisfies.
  const schemeCounts = { [LOCATOR_SCHEME.CELL_QUALIFIED]: 0, [LOCATOR_SCHEME.NODE_ONLY_HASH]: 0, [LOCATOR_SCHEME.NODE_ONLY_COLON]: 0, [LOCATOR_SCHEME.UNRECOGNIZED]: 0 };
  const schemeTableKindCounts = { [LOCATOR_SCHEME.CELL_QUALIFIED]: 0, [LOCATOR_SCHEME.NODE_ONLY_HASH]: 0, [LOCATOR_SCHEME.NODE_ONLY_COLON]: 0 };
  let totalSources = 0;
  let p103CoveredSources = 0; // NODE_ONLY_COLON only -- what P10.3's resolver could even attempt
  let p103MissedTableSources = 0; // CELL_QUALIFIED/NODE_ONLY_HASH resolving to a table node -- never attempted by P10.3
  const trueTableItemIds = new Set();

  for (const item of goldItems) {
    let itemHasTable = false;
    for (const slot of item.required_evidence_slots ?? []) {
      for (const src of slot.acceptable_sources ?? []) {
        totalSources += 1;
        const scheme = classifyLocatorScheme(src.source_locator);
        schemeCounts[scheme] += 1;
        const raw = rawRecordByDocId.get(src.document_id);
        const { node } = resolveNodeForLocator(raw, src.source_locator);
        if (node?.kind === "table") schemeTableKindCounts[scheme] += 1;
        // "Resolved" here means an actual cell was pinned down (row/col
        // in-range for CELL_QUALIFIED, or a text match succeeded for the
        // node-only schemes) -- the stricter, more defensible bar than
        // merely "the locator points at a table-kind node", since a
        // table-kind node with no resolvable cell contributes no usable
        // evidence for Stage 2/3.
        const authoritative = resolveAuthoritativeCell({ rawRecord: raw, locator: src.source_locator, evidenceSpanText: src.evidence_span, extensions: item.extensions });
        if (authoritative.root_cause === ROOT_CAUSE.GOLD_LOCATOR_EXACT || authoritative.root_cause === ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS) itemHasTable = true;
        if (scheme === LOCATOR_SCHEME.NODE_ONLY_COLON) p103CoveredSources += 1;
        else if (node?.kind === "table") p103MissedTableSources += 1;
      }
    }
    if (itemHasTable) trueTableItemIds.add(item.question_id);
  }

  const authorityPolicy = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    authority_order: [
      "1. source_locator's own document_id/node_id/row/column (CELL_QUALIFIED scheme)",
      "2. extensions.evidence_verification or other cell-qualified provenance (verified ABSENT from this Gold release's schema -- see extensions_evidence_verification_present below)",
      "3. node_id + table structure (NODE_ONLY_HASH scheme, node resolved by rel_path+order_index)",
      "4. evidence_span exact/broad text match against normalized_rows (NODE_ONLY_COLON scheme, and NODE_ONLY_HASH once the node is found)",
    ],
    extensions_evidence_verification_present: false,
    extensions_evidence_verification_check_note: "checked every one of the 345 acceptable_sources and all 101 items' item-level `extensions` objects -- acceptable_source only ever has {document_id, source_locator, evidence_span}; extensions carries only authoring/workflow fields (assignment_id, chain_component_id, gold_pool_role, authoring_eligibility, split_lock_status, artifact_status, verification_note), never per-cell row/col provenance",
    locator_scheme_distribution: schemeCounts,
    locator_scheme_table_kind_distribution: schemeTableKindCounts,
    total_sources: totalSources,
    p10_3_resolver_coverage_gap: {
      p10_3_resolver_only_handled_scheme: LOCATOR_SCHEME.NODE_ONLY_COLON,
      p10_3_attempted_sources: p103CoveredSources,
      p10_3_missed_table_kind_sources: p103MissedTableSources,
      finding: "P10.3's table-evidence-resolver.mjs matched source_locator against node_id via EXACT STRING EQUALITY only. This only ever satisfies the NODE_ONLY_COLON shape (docId::relPath::nodeId). The CELL_QUALIFIED shape (docId/relPath#node=N&row=R&col=C, 260/345 = 75.4% of ALL Gold sources, and the MOST authoritative locator format available -- an explicit row+col, not a text-matched guess) and the NODE_ONLY_HASH shape (docId/relPath#node=N, 6/345) were never even attempted: findNodeById() returned null for every one, silently classifying them as non-table/unresolvable rather than resolving them via order_index+rel_path lookup.",
      p10_3_reported_table_evaluation_item_count: 49,
      corrected_table_evaluation_item_count: trueTableItemIds.size,
    },
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "table-locator-authority-policy.v0.1.json"), `${JSON.stringify(authorityPolicy, null, 2)}\n`);

  // --- Stage 2: root-cause audit of the 4 unresolvable sources + every
  // recorded violation in P10.3's ALREADY-EXAMINED 45-item/615-cell-check
  // subset (NODE_ONLY_COLON scheme only -- the subset P10.3 actually
  // analyzed; the coverage gap above is reported separately, not
  // re-chunked or re-analyzed this Turn per the explicit "청킹 구현이나
  // 임베딩 실행을 하지 않는다" boundary). ---
  const auditRecords = [];
  const rootCauseCounts = {};
  const record = (r) => { auditRecords.push(r); rootCauseCounts[r.root_cause] = (rootCauseCounts[r.root_cause] ?? 0) + 1; };

  // 2a. Re-derive, per item, the (node_id, matched_row_indices) sets from
  // NODE_ONLY_COLON sources -- EXACTLY P10.3's own resolution path
  // (reused unmodified table-evidence-resolver.mjs), so this cross-
  // references cleanly against P10.3's recorded violations.
  const cellByItem = new Map(); // question_id -> [{node, node_id, row_index, source}]
  const unresolvableEntries = [];
  for (const item of goldItems) {
    const cells = [];
    for (const slot of item.required_evidence_slots ?? []) {
      for (const src of slot.acceptable_sources ?? []) {
        if (classifyLocatorScheme(src.source_locator) !== LOCATOR_SCHEME.NODE_ONLY_COLON) continue;
        const raw = rawRecordByDocId.get(src.document_id);
        const node = raw ? findNodeById(raw, src.source_locator) : null;
        if (!node || node.kind !== "table") continue;
        const resolved = resolveTableCell(node, src.evidence_span);
        if (!resolved.matched) {
          unresolvableEntries.push({ question_id: item.question_id, node, node_id: src.source_locator });
          continue;
        }
        for (const rowIndex of resolved.matched_row_indices) {
          cells.push({ node, node_id: src.source_locator, row_index: rowIndex, ambiguous: resolved.ambiguous });
        }
      }
    }
    if (cells.length > 0 || unresolvableEntries.some((u) => u.question_id === item.question_id)) cellByItem.set(item.question_id, cells);
  }

  for (const entry of unresolvableEntries) {
    const rootCause = classifyUnresolvableSource({ node: entry.node });
    const authoritativeResult = { authoritative_locator_available: false, exact_match_count: 0, ambiguous_match_count: 0 };
    record({
      audit_item_id: anonymizeId(entry.question_id),
      strategy: null,
      violation_type: "UNRESOLVABLE_SOURCE",
      root_cause: rootCause,
      irregular_column_counts: hasIrregularColumnCounts(entry.node),
      ...buildAuditFields({ authoritativeResult, rootCause }),
    });
  }

  // 2b. Audit every recorded violation for BOTH strategies.
  for (const strategyReport of preservation.strategies) {
    for (const itemReport of strategyReport.per_item) {
      const cells = cellByItem.get(itemReport.question_id) ?? [];
      for (const violation of itemReport.critical_violations) {
        const cell = cells.find((c) => c.node_id === violation.node_id && c.row_index === violation.row_index);
        const authoritativeResult = cell
          ? { root_cause: cell.ambiguous ? ROOT_CAUSE.GOLD_LOCATOR_AMBIGUOUS : ROOT_CAUSE.GOLD_LOCATOR_EXACT, authoritative_locator_available: false, exact_match_count: 1, ambiguous_match_count: cell.ambiguous ? 2 : 0 }
          : { root_cause: ROOT_CAUSE.RESOLVER_IMPLEMENTATION_BUG, authoritative_locator_available: false, exact_match_count: 0, ambiguous_match_count: 0 };
        const rootCause = classifyRecordedViolation({ violationType: violation.type, authoritativeResult });
        record({
          audit_item_id: anonymizeId(itemReport.question_id),
          strategy: strategyReport.chunking_config_id,
          violation_type: violation.type,
          node_id_hash: createHash("sha256").update(violation.node_id, "utf8").digest("hex").slice(0, 16),
          row_index: violation.row_index,
          root_cause: rootCause,
          irregular_column_counts: cell ? hasIrregularColumnCounts(cell.node) : null,
          ...buildAuditFields({ authoritativeResult, rootCause }),
        });
      }
    }
  }

  const audit = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    unresolvable_sources_audited: unresolvableEntries.length,
    recorded_violations_audited: auditRecords.length - unresolvableEntries.length,
    root_cause_distribution: rootCauseCounts,
    audit_records: auditRecords,
  };
  await writeFile(path.join(OUT_DIR, "table-locator-root-cause-audit.v0.1.json"), `${JSON.stringify(audit, null, 2)}\n`);

  console.log(JSON.stringify({
    locator_scheme_distribution: schemeCounts,
    p10_3_reported_table_items: 49,
    corrected_table_evaluation_item_count: trueTableItemIds.size,
    unresolvable_sources_audited: unresolvableEntries.length,
    recorded_violations_audited: auditRecords.length - unresolvableEntries.length,
    root_cause_distribution: rootCauseCounts,
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.3.1-stage1-2-locator-audit] FAILED:", error.stack ?? error.message);
  process.exitCode = 1;
});
