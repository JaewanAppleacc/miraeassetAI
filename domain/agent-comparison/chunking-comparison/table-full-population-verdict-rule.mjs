// Turn P10.3.2 / Stage 7: fixed, pre-registered rule over the corrected
// FULL POPULATION numbers (92 items / 339 sources), reusing P10.2's
// tie-vs-material-interaction discipline and P10.3/P10.3.1's
// never-auto-approve-Fixed principle. Pure function, no I/O.
export const FULL_POPULATION_VERDICT = Object.freeze({
  ADAPTIVE_CONFIRMED: "ADAPTIVE_TABLE_CHUNKING_CONFIRMED_FULL_POPULATION",
  ADAPTIVE_PARSE_RECOVERY: "ADAPTIVE_DIRECTION_CONFIRMED_PARSE_RECOVERY_REQUIRED",
  METADATA_FIX_SUFFICIENT: "EXISTING_CHUNKER_METADATA_FIX_SUFFICIENT",
  INCONCLUSIVE: "FULL_POPULATION_AUDIT_INCONCLUSIVE",
});

const MIN_TABLE_ITEM_SAMPLE = 15;
const METADATA_DOMINANT_THRESHOLD = 0.7;
// If parse-limited sources are a large enough share of the population
// that resolving them would plausibly change the comparison, the
// confirmed verdict must be qualified as parse-recovery-blocked.
const PARSE_RECOVERY_MATERIAL_THRESHOLD = 0.05;

export function decideFullPopulationVerdict({
  tableItemCount,
  fixedChunkingAttributableCount,
  sectionChunkingAttributableCount,
  fixedChunkMetadataCount,
  parseLimitedSourceCount,
  totalTableKindSourceCount,
  determinismStable,
}) {
  const reasonTrail = [];

  if (tableItemCount < MIN_TABLE_ITEM_SAMPLE || determinismStable !== true) {
    reasonTrail.push(`sample too small (${tableItemCount}) or non-deterministic -- cannot confirm at full-population scale`);
    return { status: FULL_POPULATION_VERDICT.INCONCLUSIVE, reasonTrail };
  }
  reasonTrail.push(`table item count ${tableItemCount} >= ${MIN_TABLE_ITEM_SAMPLE}, determinism confirmed`);

  const metadataRate = fixedChunkingAttributableCount > 0 ? fixedChunkMetadataCount / fixedChunkingAttributableCount : 0;
  if (metadataRate >= METADATA_DOMINANT_THRESHOLD) {
    reasonTrail.push(`${(metadataRate * 100).toFixed(1)}% of Fixed's chunking-attributable violations are metadata-pass-through issues, not text-boundary loss`);
    return { status: FULL_POPULATION_VERDICT.METADATA_FIX_SUFFICIENT, reasonTrail };
  }
  reasonTrail.push(`metadata-only rate ${(metadataRate * 100).toFixed(1)}% is below the ${METADATA_DOMINANT_THRESHOLD * 100}% threshold -- genuine text-boundary loss dominates`);

  const adaptiveGroundsMet = fixedChunkingAttributableCount > 0 && sectionChunkingAttributableCount > 0;
  if (!adaptiveGroundsMet) {
    reasonTrail.push(`adaptive confirmation requires BOTH strategies to retain real chunking-attributable violations (Fixed=${fixedChunkingAttributableCount}, Section=${sectionChunkingAttributableCount})`);
    return { status: FULL_POPULATION_VERDICT.INCONCLUSIVE, reasonTrail };
  }
  reasonTrail.push(`Fixed retains ${fixedChunkingAttributableCount} and Section retains ${sectionChunkingAttributableCount} genuine chunking-attributable violations -- Section is not a complete alternative`);

  const parseLimitedRate = totalTableKindSourceCount > 0 ? parseLimitedSourceCount / totalTableKindSourceCount : 0;
  if (parseLimitedRate >= PARSE_RECOVERY_MATERIAL_THRESHOLD) {
    reasonTrail.push(`${(parseLimitedRate * 100).toFixed(2)}% of table-kind sources are parse-limited (>= ${PARSE_RECOVERY_MATERIAL_THRESHOLD * 100}%) -- adaptive direction confirmed but full accuracy needs parser recovery first`);
    return { status: FULL_POPULATION_VERDICT.ADAPTIVE_PARSE_RECOVERY, reasonTrail };
  }
  reasonTrail.push(`parse-limited rate ${(parseLimitedRate * 100).toFixed(2)}% is below the ${PARSE_RECOVERY_MATERIAL_THRESHOLD * 100}% materiality threshold`);

  return { status: FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED, reasonTrail };
}

export function decideP10_4Eligibility({ verdictStatus, parseLimitedSourceCount, unresolvedGoldLocatorCount }) {
  const eligible = verdictStatus === FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED || verdictStatus === FULL_POPULATION_VERDICT.ADAPTIVE_PARSE_RECOVERY;
  return {
    p10_4_implementation_eligible: eligible,
    parse_recovery_blocking: verdictStatus === FULL_POPULATION_VERDICT.ADAPTIVE_PARSE_RECOVERY,
    unresolved_gold_locator_blocking: unresolvedGoldLocatorCount > 0,
    required_exclusions: unresolvedGoldLocatorCount > 0 ? [`${unresolvedGoldLocatorCount} PARSE_RECOVERY_REQUIRED source(s) excluded from table-aware chunk scoring until parser recovery`] : [],
    required_table_context_fields: [
      "document_id", "node_id", "row", "column", "row_header", "column_header", "period_header",
      "unit", "table_title", "section_title", "cell_value", "canonical_source_locator", "inherited_context_provenance",
    ],
  };
}
