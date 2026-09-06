// Turn A-PLUS-QA-CONDITION-MAPPING-V1 -- pure unit tests for qa-condition-mapper.mjs.
//
// No DB, no network, no Gold, no LLM call, no subprocess. Every fixture below is either
// hand-authored or the tiny in-memory CSV text at the bottom of this file -- never
// data/eval/devtune101_conditions.v2.jsonl's own `question`/Gold content (the separate
// scripts/qa_condition_mapping_101_report.mjs script reads that file, structurally only, for
// the required 101-condition pass-through report).
//
// Run with: node --test domain/agent-comparison/four-arm-ac/qa-condition-mapper.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_DOC_GROUPS,
  UnknownDocGroupError,
  UnresolvedCompanyNameError,
  buildNameToCorpCodeIndexFromUniverseCsv,
  mapQaOrLegacyConditionsToArmAConditions,
  mapQaOrLegacyConditionsToFilterInput,
  mapQaOrLegacyConditionsToFourArmConditions,
  normalizeConditionsInput,
} from "./qa-condition-mapper.mjs";

const FIXTURE_CSV = [
  "corp_code,stock_code,corp_name,listed_name,corp_eng_name,market",
  '00126380,005930,삼성전자,삼성전자,"SAMSUNG ELECTRONICS CO,.LTD",KOSPI',
  "00164742,005380,현대자동차,현대차,HYUNDAI MOTOR CO,KOSPI",
  "00309503,047810,한국항공우주,한국항공우주,\"KOREA AEROSPACE INDUSTRIES, LTD.\",KOSPI",
  "00583424,090430,아모레퍼시픽,아모레퍼시픽,AMOREPACIFIC CORP.,KOSPI",
].join("\n");

function fixtureIndex() {
  return buildNameToCorpCodeIndexFromUniverseCsv(FIXTURE_CSV);
}

// ---------- 1. universe.csv parsing ----------

test("buildNameToCorpCodeIndexFromUniverseCsv resolves corp_name and listed_name, handles quoted commas", () => {
  const index = fixtureIndex();
  assert.equal(index.get("삼성전자"), "00126380");
  assert.equal(index.get("현대자동차"), "00164742");
  assert.equal(index.get("현대차"), "00164742"); // listed_name alias
  assert.equal(index.get("한국항공우주"), "00309503");
});

// ---------- 2. QA-format input -> non-empty filter ----------

test("QA-shaped conditions (corps/doc_groups/year_months) produce a non-empty filter", () => {
  const qa = {
    candidate_terms: ["계약금액"], corps: ["한국항공우주"], correction: false,
    doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"], major_labels: [],
    periodic_subtypes: [], wants_latest: false, year_months: [[2025, 6]], years: [2025],
  };
  const result = mapQaOrLegacyConditionsToFilterInput(qa, { nameToCorpCodeIndex: fixtureIndex() });
  assert.deepEqual(result.filters.corp_codes, ["00309503"]);
  assert.deepEqual(result.filters.doc_groups, ["exchange"]);
  assert.deepEqual(result.filters.doc_subtypes, ["단일판매공급계약체결"]);
  assert.notEqual(JSON.stringify(result.filters), JSON.stringify({
    corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [],
    base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null,
    retrieval_eligible: true,
  }));
});

// ---------- 3. legacy internal format still supported, same result as before ----------

test("legacy {corp_code, document_group, period} shape maps to the same filter the old minimal mapper produced", () => {
  const legacy = { corp_code: "00126380", document_group: "periodic", document_subtype: "annual", period: "2024-03" };
  const result = mapQaOrLegacyConditionsToArmAConditions(legacy, { nameToCorpCodeIndex: fixtureIndex() });
  assert.deepEqual(result.corp_codes, ["00126380"]);
  assert.deepEqual(result.doc_groups, ["periodic"]);
  // periodic_subtypes present ("annual") -> base_months intentionally NOT added (subtype already
  // disambiguates annual/half/quarter; see four-arm-conditions-to-filter-mapper.mjs's own
  // deriveTemporalFilter comment) -- base_years alone, matching that policy exactly.
  assert.deepEqual(result.base_years, [2024]);
  assert.deepEqual(result.base_months, []);
});

test("empty conditions ({}) produce the same fully-unconstrained filter for both legacy and QA callers", () => {
  const index = fixtureIndex();
  const fromEmpty = mapQaOrLegacyConditionsToArmAConditions({}, { nameToCorpCodeIndex: index });
  const fromNull = mapQaOrLegacyConditionsToArmAConditions(null, { nameToCorpCodeIndex: index });
  const fromUndefined = mapQaOrLegacyConditionsToArmAConditions(undefined, { nameToCorpCodeIndex: index });
  for (const filters of [fromEmpty, fromNull, fromUndefined]) {
    assert.deepEqual(filters.corp_codes, []);
    assert.deepEqual(filters.doc_groups, []);
    assert.equal(filters.retrieval_eligible, true);
    assert.equal(filters.is_correction, null);
  }
});

// ---------- 4. multiple companies/doc_groups/periods preserved ----------

test("multiple corps, doc_groups, and year_months are all preserved (never truncated to one)", () => {
  const qa = {
    corps: ["삼성전자", "현대자동차"], doc_groups: ["periodic"],
    year_months: [[2024, 3], [2024, 6]], years: [2024],
  };
  const normalized = normalizeConditionsInput(qa);
  assert.equal(normalized.corps.length, 2);
  assert.equal(normalized.year_months.length, 2);
  const result = mapQaOrLegacyConditionsToFilterInput(qa, { nameToCorpCodeIndex: fixtureIndex() });
  assert.deepEqual([...result.filters.corp_codes].sort(), ["00126380", "00164742"]);
});

test("legacy corp_codes (plural) and QA corps (names) can be combined in one request", () => {
  const mixed = { corp_codes: ["00126380"], corps: ["현대자동차"], doc_groups: ["periodic"] };
  const result = mapQaOrLegacyConditionsToFilterInput(mixed, { nameToCorpCodeIndex: fixtureIndex() });
  assert.deepEqual([...result.filters.corp_codes].sort(), ["00126380", "00164742"]);
  assert.equal(result.diagnostics.shape, "MIXED");
});

// ---------- 5. invalid company name refuses, never silently widens ----------

test("an unresolvable company name throws UnresolvedCompanyNameError instead of widening the filter", () => {
  assert.throws(
    () => mapQaOrLegacyConditionsToFilterInput({ corps: ["존재하지않는회사"] }, { nameToCorpCodeIndex: fixtureIndex() }),
    UnresolvedCompanyNameError,
  );
});

// ---------- 6. unknown doc_group refuses, never silently widens ----------

test("an unknown doc_group value throws UnknownDocGroupError instead of being dropped", () => {
  assert.throws(
    () => mapQaOrLegacyConditionsToFilterInput({ doc_groups: ["not_a_real_group"] }, { nameToCorpCodeIndex: fixtureIndex() }),
    UnknownDocGroupError,
  );
});

test("KNOWN_DOC_GROUPS is exactly the corpus's real 4-group taxonomy", () => {
  assert.deepEqual([...KNOWN_DOC_GROUPS].sort(), ["exchange", "holding", "major", "periodic"]);
});

// ---------- 7. field absence vs empty array ----------

test("an absent field is distinguishable from an explicit empty array in diagnostics.fields_present", () => {
  const withEmpty = normalizeConditionsInput({ doc_groups: [] });
  const withoutField = normalizeConditionsInput({});
  assert.ok(withEmpty.diagnostics.fields_present.includes("doc_groups"));
  assert.ok(!withoutField.diagnostics.fields_present.includes("doc_groups"));
  // both still normalize to an empty doc_groups array -- presence is a diagnostic fact, not a
  // different filter outcome for this field.
  assert.deepEqual(withEmpty.doc_groups, []);
  assert.deepEqual(withoutField.doc_groups, []);
});

test("candidate_terms absent stays null (not []) so runQuestionPipeline's Array.isArray check is unaffected", () => {
  const legacyOnly = normalizeConditionsInput({ corp_code: "00126380" });
  assert.equal(legacyOnly.candidate_terms, null);
  const qaExplicit = normalizeConditionsInput({ candidate_terms: [] });
  assert.deepEqual(qaExplicit.candidate_terms, []);
});

// ---------- 8. periodic vs exchange/holding/major date semantics separated ----------

test("a periodic-only condition with year_months gets base_year(/month) applied", () => {
  const result = mapQaOrLegacyConditionsToFilterInput(
    { corps: ["삼성전자"], doc_groups: ["periodic"], year_months: [[2024, 3]], years: [2024] },
    { nameToCorpCodeIndex: fixtureIndex() },
  );
  assert.deepEqual(result.filters.base_years, [2024]);
  assert.deepEqual(result.filters.base_months, [3]);
  assert.equal(result.temporal_filter_applied, "BASE_YEAR_AND_MONTH_PERIODIC_NO_SUBTYPE");
});

for (const group of ["exchange", "holding", "major"]) {
  test(`a ${group} condition with year_months applies NO hard temporal filter (receipt-date gap is not a fixed offset)`, () => {
    const result = mapQaOrLegacyConditionsToFilterInput(
      { corps: ["삼성전자"], doc_groups: [group], year_months: [[2024, 3]], years: [2024] },
      { nameToCorpCodeIndex: fixtureIndex() },
    );
    assert.deepEqual(result.filters.base_years, []);
    assert.deepEqual(result.filters.base_months, []);
    assert.equal(result.filters.receipt_date_from, null);
    assert.equal(result.temporal_filter_applied, "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS");
  });
}

// ---------- 9. determinism and input immutability ----------

test("mapping is deterministic and never mutates its input", () => {
  const input = Object.freeze({
    corps: Object.freeze(["삼성전자", "현대자동차"]),
    doc_groups: Object.freeze(["periodic"]),
    year_months: Object.freeze([Object.freeze([2024, 3])]),
  });
  const index = fixtureIndex();
  const first = mapQaOrLegacyConditionsToFilterInput(input, { nameToCorpCodeIndex: index });
  const second = mapQaOrLegacyConditionsToFilterInput(input, { nameToCorpCodeIndex: index });
  assert.deepEqual(first.filters, second.filters);
  // Object.freeze above already guarantees no mutation could have happened without throwing in
  // strict mode (this module is a `type: module` ES module, always strict) -- reaching this line
  // at all is itself the immutability assertion.
});

test("mapQaOrLegacyConditionsToFourArmConditions returns a conditions object + matching index for the A4/A3 worker", () => {
  const qa = { corps: ["아모레퍼시픽"], doc_groups: ["holding"], year_months: [[2024, 3]], years: [2024] };
  const { conditions, nameToCorpCodeIndex, diagnostics } = mapQaOrLegacyConditionsToFourArmConditions(
    qa, { nameToCorpCodeIndex: fixtureIndex() },
  );
  assert.deepEqual(conditions.corps, ["아모레퍼시픽"]);
  assert.equal(nameToCorpCodeIndex.get("아모레퍼시픽"), "00583424");
  assert.equal(diagnostics.shape, "QA");
});

test("legacy single corp_code resolves via the identity overlay even with a name-keyed index", () => {
  const { conditions, nameToCorpCodeIndex } = mapQaOrLegacyConditionsToFourArmConditions(
    { corp_code: "00583424", document_group: "holding" }, { nameToCorpCodeIndex: fixtureIndex() },
  );
  assert.deepEqual(conditions.corps, ["00583424"]);
  assert.equal(nameToCorpCodeIndex.get("00583424"), "00583424");
});
