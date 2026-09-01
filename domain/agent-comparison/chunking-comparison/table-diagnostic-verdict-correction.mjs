// Turn P10.3.1 / Stage 4: fixed, pre-registered rule for re-evaluating
// P10.3's ADAPTIVE_TABLE_CHUNKING_REQUIRED verdict against Stage 2/3's
// root-cause-corrected numbers. Pure function, no I/O.
export const CORRECTED_VERDICT = Object.freeze({
  ADAPTIVE_CONFIRMED: "ADAPTIVE_TABLE_CHUNKING_CONFIRMED",
  ADAPTIVE_METRICS_CORRECTED: "ADAPTIVE_DIRECTION_VALID_BUT_METRICS_CORRECTED",
  METADATA_FIX_ONLY: "EXISTING_CHUNKERS_REQUIRE_METADATA_FIX_ONLY",
  INVALID_REQUIRES_REBUILD: "TABLE_DIAGNOSTIC_INVALID_REQUIRES_REBUILD",
});

// A cell-determination failure rate this high means the two strategies
// cannot be meaningfully compared at all -- forces a rebuild verdict
// regardless of anything else.
const CELL_DETERMINATION_IMPOSSIBLE_THRESHOLD = 0.5;
// If this fraction (or more) of P10.3's ORIGINAL violations turn out to
// be non-chunking-attributable (Gold ambiguity, unresolvable locator,
// parser limitation, or a resolver bug), the adaptive DIRECTION may still
// be right but the specific 162/108 numbers were materially wrong.
const SUBSTANTIAL_EXCLUSION_THRESHOLD = 0.3;
// If corrected violations are overwhelmingly metadata-pass-through
// issues rather than genuine text-boundary loss, no new chunking
// strategy is needed -- just carry existing chunk content into metadata.
const METADATA_DOMINANT_THRESHOLD = 0.7;

export function decideCorrectedVerdict({
  totalAuditedSources,
  cellDeterminationImpossibleCount, // GOLD_LOCATOR_UNRESOLVABLE + SOURCE_PARSE_LIMITATION among sources (not violations)
  fixedOriginalCount,
  fixedCorrectedCount,
  fixedExcludedCount,
  fixedChunkBoundaryCount,
  fixedChunkMetadataCount,
  sectionCorrectedCount,
}) {
  const reasonTrail = [];
  const impossibleRate = totalAuditedSources > 0 ? cellDeterminationImpossibleCount / totalAuditedSources : 0;
  if (impossibleRate >= CELL_DETERMINATION_IMPOSSIBLE_THRESHOLD) {
    reasonTrail.push(`cell determination impossible for ${(impossibleRate * 100).toFixed(1)}% of audited sources (>= ${CELL_DETERMINATION_IMPOSSIBLE_THRESHOLD * 100}%) -- Fixed/Section cannot be meaningfully compared`);
    return { status: CORRECTED_VERDICT.INVALID_REQUIRES_REBUILD, reasonTrail };
  }
  reasonTrail.push(`cell determination impossible rate ${(impossibleRate * 100).toFixed(1)}% is below the ${CELL_DETERMINATION_IMPOSSIBLE_THRESHOLD * 100}% rebuild threshold`);

  const excludedRate = fixedOriginalCount > 0 ? fixedExcludedCount / fixedOriginalCount : 0;
  if (excludedRate >= SUBSTANTIAL_EXCLUSION_THRESHOLD) {
    reasonTrail.push(`${(excludedRate * 100).toFixed(1)}% of Fixed's original ${fixedOriginalCount} violations were non-chunking-attributable (>= ${SUBSTANTIAL_EXCLUSION_THRESHOLD * 100}%) -- direction may hold but the reported magnitude was materially wrong`);
    return { status: CORRECTED_VERDICT.ADAPTIVE_METRICS_CORRECTED, reasonTrail };
  }
  reasonTrail.push(`${(excludedRate * 100).toFixed(1)}% of Fixed's original violations were excluded, below the ${SUBSTANTIAL_EXCLUSION_THRESHOLD * 100}% threshold`);

  const metadataRate = fixedCorrectedCount > 0 ? fixedChunkMetadataCount / fixedCorrectedCount : 0;
  if (metadataRate >= METADATA_DOMINANT_THRESHOLD) {
    reasonTrail.push(`${(metadataRate * 100).toFixed(1)}% of Fixed's corrected violations are CHUNK_METADATA_LOSS (>= ${METADATA_DOMINANT_THRESHOLD * 100}%) -- the context exists in chunk text, only metadata pass-through is missing`);
    return { status: CORRECTED_VERDICT.METADATA_FIX_ONLY, reasonTrail };
  }
  reasonTrail.push(`CHUNK_METADATA_LOSS is ${(metadataRate * 100).toFixed(1)}% of Fixed's corrected violations (CHUNK_BOUNDARY_CONTEXT_LOSS: ${fixedChunkBoundaryCount}) -- the loss is a genuine text-boundary artifact, not a metadata-pass-through gap`);

  if (fixedCorrectedCount > 0 && sectionCorrectedCount > 0) {
    reasonTrail.push(`after correction, Fixed still has ${fixedCorrectedCount} genuine chunking-attributable violations and Section still has ${sectionCorrectedCount} (not a complete alternative) -- adaptive direction confirmed`);
    return { status: CORRECTED_VERDICT.ADAPTIVE_CONFIRMED, reasonTrail };
  }

  reasonTrail.push("no branch matched cleanly -- fail-closed to metrics-corrected rather than confirming without a positive match");
  return { status: CORRECTED_VERDICT.ADAPTIVE_METRICS_CORRECTED, reasonTrail };
}
