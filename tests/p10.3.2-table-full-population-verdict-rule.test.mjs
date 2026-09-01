import test from "node:test";
import assert from "node:assert/strict";
import { decideFullPopulationVerdict, decideP10_4Eligibility, FULL_POPULATION_VERDICT } from "../domain/agent-comparison/chunking-comparison/table-full-population-verdict-rule.mjs";

const base = {
  tableItemCount: 92,
  fixedChunkingAttributableCount: 197,
  sectionChunkingAttributableCount: 141,
  fixedChunkMetadataCount: 0,
  parseLimitedSourceCount: 4,
  totalTableKindSourceCount: 339,
  determinismStable: true,
};

test("reproduces the REAL P10.3.2 outcome: ADAPTIVE_TABLE_CHUNKING_CONFIRMED_FULL_POPULATION", () => {
  const result = decideFullPopulationVerdict(base);
  assert.equal(result.status, FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED);
});

test("FULL_POPULATION_AUDIT_INCONCLUSIVE when the sample is too small", () => {
  const result = decideFullPopulationVerdict({ ...base, tableItemCount: 5 });
  assert.equal(result.status, FULL_POPULATION_VERDICT.INCONCLUSIVE);
});

test("FULL_POPULATION_AUDIT_INCONCLUSIVE when determinism is not confirmed", () => {
  const result = decideFullPopulationVerdict({ ...base, determinismStable: false });
  assert.equal(result.status, FULL_POPULATION_VERDICT.INCONCLUSIVE);
});

test("EXISTING_CHUNKER_METADATA_FIX_SUFFICIENT when violations are overwhelmingly metadata-pass-through", () => {
  const result = decideFullPopulationVerdict({ ...base, fixedChunkMetadataCount: 190 });
  assert.equal(result.status, FULL_POPULATION_VERDICT.METADATA_FIX_SUFFICIENT);
});

test("FULL_POPULATION_AUDIT_INCONCLUSIVE when Section reaches 0 chunking-attributable violations (would be a complete alternative, not adaptive)", () => {
  const result = decideFullPopulationVerdict({ ...base, sectionChunkingAttributableCount: 0 });
  assert.equal(result.status, FULL_POPULATION_VERDICT.INCONCLUSIVE);
});

test("ADAPTIVE_DIRECTION_CONFIRMED_PARSE_RECOVERY_REQUIRED when parse-limited sources are a material share of the population", () => {
  const result = decideFullPopulationVerdict({ ...base, parseLimitedSourceCount: 30, totalTableKindSourceCount: 339 }); // 8.8%
  assert.equal(result.status, FULL_POPULATION_VERDICT.ADAPTIVE_PARSE_RECOVERY);
});

test("decideP10_4Eligibility: eligible for CONFIRMED and PARSE_RECOVERY statuses, not for INCONCLUSIVE or METADATA_FIX", () => {
  assert.equal(decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED, parseLimitedSourceCount: 4, unresolvedGoldLocatorCount: 4 }).p10_4_implementation_eligible, true);
  assert.equal(decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.ADAPTIVE_PARSE_RECOVERY, parseLimitedSourceCount: 30, unresolvedGoldLocatorCount: 30 }).p10_4_implementation_eligible, true);
  assert.equal(decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.INCONCLUSIVE, parseLimitedSourceCount: 0, unresolvedGoldLocatorCount: 0 }).p10_4_implementation_eligible, false);
  assert.equal(decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.METADATA_FIX_SUFFICIENT, parseLimitedSourceCount: 0, unresolvedGoldLocatorCount: 0 }).p10_4_implementation_eligible, false);
});

test("decideP10_4Eligibility: unresolved_gold_locator_blocking is true whenever any PARSE_RECOVERY_REQUIRED sources remain, even if the overall verdict confirms adaptive", () => {
  const result = decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED, parseLimitedSourceCount: 4, unresolvedGoldLocatorCount: 4 });
  assert.equal(result.unresolved_gold_locator_blocking, true);
  assert.equal(result.required_exclusions.length, 1);
});

test("decideP10_4Eligibility: required_table_context_fields lists exactly the 13 required fields", () => {
  const result = decideP10_4Eligibility({ verdictStatus: FULL_POPULATION_VERDICT.ADAPTIVE_CONFIRMED, parseLimitedSourceCount: 0, unresolvedGoldLocatorCount: 0 });
  assert.deepEqual(result.required_table_context_fields, [
    "document_id", "node_id", "row", "column", "row_header", "column_header", "period_header",
    "unit", "table_title", "section_title", "cell_value", "canonical_source_locator", "inherited_context_provenance",
  ]);
});
