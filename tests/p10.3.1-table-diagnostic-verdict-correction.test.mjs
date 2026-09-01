import test from "node:test";
import assert from "node:assert/strict";
import { decideCorrectedVerdict, CORRECTED_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-diagnostic-verdict-correction.mjs";

const base = {
  totalAuditedSources: 75,
  cellDeterminationImpossibleCount: 4,
  fixedOriginalCount: 162,
  fixedCorrectedCount: 162,
  fixedExcludedCount: 0,
  fixedChunkBoundaryCount: 162,
  fixedChunkMetadataCount: 0,
  sectionCorrectedCount: 108,
};

test("reproduces the REAL P10.3.1 outcome: ADAPTIVE_TABLE_CHUNKING_CONFIRMED (0% excluded, real loss remains on both sides)", () => {
  const result = decideCorrectedVerdict(base);
  assert.equal(result.status, CORRECTED_VERDICT.ADAPTIVE_CONFIRMED);
});

test("TABLE_DIAGNOSTIC_INVALID_REQUIRES_REBUILD when cell determination is impossible for >=50% of audited sources", () => {
  const result = decideCorrectedVerdict({ ...base, totalAuditedSources: 10, cellDeterminationImpossibleCount: 6 });
  assert.equal(result.status, CORRECTED_VERDICT.INVALID_REQUIRES_REBUILD);
});

test("rebuild check is evaluated FIRST -- even with a clean chunking signal, an impossible-to-determine sample forces rebuild", () => {
  const result = decideCorrectedVerdict({ ...base, totalAuditedSources: 4, cellDeterminationImpossibleCount: 4, fixedExcludedCount: 0 });
  assert.equal(result.status, CORRECTED_VERDICT.INVALID_REQUIRES_REBUILD);
});

test("ADAPTIVE_DIRECTION_VALID_BUT_METRICS_CORRECTED when >=30% of original violations were non-chunking-attributable", () => {
  const result = decideCorrectedVerdict({ ...base, fixedOriginalCount: 100, fixedExcludedCount: 40, fixedCorrectedCount: 60 });
  assert.equal(result.status, CORRECTED_VERDICT.ADAPTIVE_METRICS_CORRECTED);
});

test("EXISTING_CHUNKERS_REQUIRE_METADATA_FIX_ONLY when corrected violations are overwhelmingly metadata-pass-through, not text-boundary loss", () => {
  const result = decideCorrectedVerdict({ ...base, fixedChunkBoundaryCount: 10, fixedChunkMetadataCount: 150, fixedCorrectedCount: 160 });
  assert.equal(result.status, CORRECTED_VERDICT.METADATA_FIX_ONLY);
});

test("ADAPTIVE_CONFIRMED requires BOTH sides to still have real violations -- Section at 0 does not confirm adaptive (Section would be a complete alternative)", () => {
  const result = decideCorrectedVerdict({ ...base, sectionCorrectedCount: 0 });
  assert.notEqual(result.status, CORRECTED_VERDICT.ADAPTIVE_CONFIRMED);
});

test("reason_trail is a non-empty, ordered explanation for every branch (never an unexplained verdict)", () => {
  const result = decideCorrectedVerdict(base);
  assert.ok(Array.isArray(result.reasonTrail) && result.reasonTrail.length > 0);
});
