import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import {
  buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput,
  UnresolvedCompanyNameError, CompanyNameCollisionError,
} from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONDITIONS_PATH = path.join(ROOT, "domain/agent-comparison/four-arm-ac/official/devtune101_conditions.v2.jsonl");

async function realResolver() {
  return createGatedSeedCompanyResolver({
    artifactPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
    manifestPath: path.join(ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
    ownerDecisionPath: path.join(ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedOwnerDecisionSha256: "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20",
    root: ROOT,
  });
}

function fakeResolver(records) {
  const index = new Map(records.map((r) => [r.corp_code, r]));
  return {
    resolve: (code) => index.get(code) ?? null,
    corpCodes: () => [...index.keys()],
    count: () => index.size,
  };
}

test("buildNameToCorpCodeIndex over the REAL approved 70-company directory resolves both corp_name and listed_name", async () => {
  const resolver = await realResolver();
  const index = buildNameToCorpCodeIndex(resolver);
  assert.equal(index.get("삼성전자"), "00126380");
  assert.equal(index.get("HD현대중공업"), "01390344");
  assert.equal(index.size >= 70, true);
});

test("every corp name referenced across all 101 real official conditions resolves against the real directory -- zero unresolved names", async () => {
  const resolver = await realResolver();
  const index = buildNameToCorpCodeIndex(resolver);
  const raw = await readFile(CONDITIONS_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const unresolved = [];
  for (const line of lines) {
    const row = JSON.parse(line);
    for (const name of row.conditions.corps ?? []) {
      if (!index.has(name)) unresolved.push(name);
    }
  }
  assert.deepEqual(unresolved, []);
});

test("mapOfficialConditionToFilterInput maps a real HIGH-segment holding condition end to end (corp_codes + doc_groups + is_correction, no unreliable date filter)", async () => {
  const resolver = await realResolver();
  const index = buildNameToCorpCodeIndex(resolver);
  const raw = await readFile(CONDITIONS_PATH, "utf8");
  const row = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.question_id === "author_0459b5f8f37b0192316cd77c");
  const mapped = mapOfficialConditionToFilterInput(row.conditions, index);
  assert.deepEqual(mapped.filters.corp_codes, ["00583424"]); // 아모레퍼시픽
  assert.deepEqual(mapped.filters.doc_groups, ["holding"]);
  // holding never populates base_year/base_month in the real corpus (a
  // prior version of this mapper applied base_years/base_months here and
  // produced ZERO results for 81/101 official questions). A second prior
  // version derived a receipt_date range from year_months instead, which
  // ALSO produced zero results for this exact question -- the real
  // filing (receipt_date=2024-04-03) landed ~12 days after the
  // referenced 기준일 (2024-03-22), outside any single-month range. No
  // hard temporal filter is applied for holding conditions at all.
  assert.deepEqual(mapped.filters.base_years, []);
  assert.deepEqual(mapped.filters.base_months, []);
  assert.equal(mapped.filters.receipt_date_from, null);
  assert.equal(mapped.filters.receipt_date_to, null);
  assert.equal(mapped.temporal_filter_applied, "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS");
  assert.equal(mapped.filters.is_correction, false);
});

test("real corpus regression guard: an annual periodic report's real base_month is 12, never the month value a 'X년 1월~12월' range phrase extracts", async () => {
  // This is the second real bug found the same way as the holding/receipt
  // date one: author_14dfddbe1d41275533ae3945's condition has
  // year_months=[[2023,1],[2025,1]] (month=1) for an ANNUAL report, but
  // the DB's own annual convention is base_month=12 -- applying month=1
  // as a hard filter also guaranteed zero matches. Re-verified live.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://jaewan@127.0.0.1:55329/p11f0_scratch" });
  await client.connect();
  try {
    const result = await client.query(`
      select distinct metadata->>'base_month' as base_month
      from disclosure_reference.reference_retrieval_chunks
      where retrieval_index_id = 'fixed_kure_index_8fe191342205848d1d6a6123f38a54e7'
        and corp_code = '01261644' and metadata->>'doc_subtype' = 'annual'
    `);
    assert.deepEqual(result.rows.map((r) => r.base_month), ["12"]);
  } finally {
    await client.end();
  }
});

test("real corpus regression guard: base_year/base_month is NEVER populated for holding/exchange/major -- only periodic has it", async () => {
  // This is the exact fact whose violation caused the 81/101-empty-results
  // bug. Re-verified live so a future corpus/loader change that breaks
  // this assumption fails a test instead of silently producing empty
  // results again.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://jaewan@127.0.0.1:55329/p11f0_scratch" });
  await client.connect();
  try {
    const result = await client.query(`
      select metadata->>'doc_group' as doc_group,
             count(*) filter (where metadata->>'base_year' is not null and metadata->>'base_year' != '') as has_base_year
      from disclosure_reference.reference_retrieval_chunks
      where retrieval_index_id = 'fixed_kure_index_8fe191342205848d1d6a6123f38a54e7'
      group by 1
    `);
    const byGroup = Object.fromEntries(result.rows.map((r) => [r.doc_group, Number(r.has_base_year)]));
    assert.equal(byGroup.holding, 0);
    assert.equal(byGroup.exchange, 0);
    assert.equal(byGroup.major, 0);
    assert.ok(byGroup.periodic > 0);
  } finally {
    await client.end();
  }
});

test("doc_subtype routing: pure doc_groups===['exchange'] maps exchange_subtypes only, never periodic_subtypes (verified aligned with the real DB vocabulary)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"], periodic_subtypes: ["quarter"],
    major_labels: [], years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.doc_subtypes, ["단일판매공급계약체결"]);
  assert.equal(mapped.doc_subtype_filter_applied, true);
});

test("doc_subtype routing: pure doc_groups===['periodic'] maps periodic_subtypes only", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["periodic"], exchange_subtypes: ["단일판매공급계약체결"], periodic_subtypes: ["quarter"],
    major_labels: [], years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.doc_subtypes, ["quarter"]);
});

test("doc_subtype routing: mixed doc_groups applies NO subtype hard filter -- a subtype real for one group is a guaranteed non-match for the others (regression: 메리츠금융지주 exchange+major real question)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["exchange", "major"], exchange_subtypes: ["단일판매공급계약체결"], periodic_subtypes: [],
    major_labels: ["자기주식"], years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.doc_subtypes, []);
  assert.equal(mapped.doc_subtype_filter_applied, false);
  assert.deepEqual(mapped.unmapped.exchange_subtypes, ["단일판매공급계약체결"]);
});

test("doc_subtype routing: pure doc_groups===['holding'] or ['major'] never gets a subtype hard filter (holding has one constant value, major has none)", () => {
  const index = new Map();
  const holding = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["holding"], exchange_subtypes: [], periodic_subtypes: [], major_labels: [],
    years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(holding.filters.doc_subtypes, []);
  const major = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["major"], exchange_subtypes: [], periodic_subtypes: [], major_labels: ["자기주식"],
    years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(major.filters.doc_subtypes, []);
});

test("major_labels is intentionally NOT mapped into doc_subtypes -- preserved in `unmapped` instead, never silently dropped", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["major"], exchange_subtypes: [], periodic_subtypes: [], major_labels: ["자기주식"],
    years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.doc_subtypes, []);
  assert.deepEqual(mapped.unmapped.major_labels, ["자기주식"]);
});

test("an unresolved company name throws fail-closed -- never silently widens the filter by dropping it", () => {
  const index = new Map([["삼성전자", "00126380"]]);
  assert.throws(
    () => mapOfficialConditionToFilterInput({ corps: ["존재하지않는회사"], doc_groups: [], exchange_subtypes: [], periodic_subtypes: [], major_labels: [], years: [], year_months: [], correction: false }, index),
    (e) => e instanceof UnresolvedCompanyNameError && e.company_name === "존재하지않는회사",
  );
});

test("buildNameToCorpCodeIndex rejects a genuine name collision between two different corp_codes", () => {
  const resolver = fakeResolver([
    { corp_code: "00000001", corp_name: "같은이름", listed_name: "같은이름" },
    { corp_code: "00000002", corp_name: "같은이름", listed_name: "같은이름2" },
  ]);
  assert.throws(() => buildNameToCorpCodeIndex(resolver), (e) => e instanceof CompanyNameCollisionError);
});

test("temporal routing: pure periodic WITHOUT a periodic_subtype uses base_years AND base_months", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["periodic"], exchange_subtypes: [], periodic_subtypes: [], major_labels: [],
    years: [2023, 2024], year_months: [[2023, 3], [2024, 3]], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.base_years.sort(), [2023, 2024]);
  assert.deepEqual(mapped.filters.base_months, [3]);
  assert.equal(mapped.filters.receipt_date_from, null);
  assert.equal(mapped.temporal_filter_applied, "BASE_YEAR_AND_MONTH_PERIODIC_NO_SUBTYPE");
});

test("temporal routing: pure periodic WITH a periodic_subtype uses base_years only, never base_months (subtype already disambiguates; month value is not trustworthy once a subtype is given)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["periodic"], exchange_subtypes: [], periodic_subtypes: ["annual"], major_labels: [],
    years: [2023, 2025], year_months: [[2023, 1], [2025, 1]], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.base_years.sort(), [2023, 2025]);
  assert.deepEqual(mapped.filters.base_months, []);
  assert.equal(mapped.temporal_filter_applied, "BASE_YEAR_ONLY_PERIODIC_SUBTYPE_DISAMBIGUATES");
  assert.deepEqual(mapped.filters.doc_subtypes, ["annual"]);
});

test("temporal routing: pure non-periodic doc_groups (holding/exchange/major) never get a hard temporal filter -- their years/year_months record an unrelated referenced date, not receipt_date", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["holding", "exchange"], exchange_subtypes: [], periodic_subtypes: [], major_labels: [],
    years: [2023, 2024], year_months: [[2023, 1], [2024, 3]], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.base_years, []);
  assert.deepEqual(mapped.filters.base_months, []);
  assert.equal(mapped.filters.receipt_date_from, null);
  assert.equal(mapped.filters.receipt_date_to, null);
  assert.equal(mapped.temporal_filter_applied, "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS");
});

test("temporal routing: doc_groups mixing periodic with a non-periodic group applies NO hard temporal filter (the two doc types' meaningful dates are unrelated)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["periodic", "exchange"], exchange_subtypes: [], periodic_subtypes: [], major_labels: [],
    years: [2024], year_months: [[2024, 3]], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.base_years, []);
  assert.deepEqual(mapped.filters.base_months, []);
  assert.equal(mapped.filters.receipt_date_from, null);
  assert.equal(mapped.filters.receipt_date_to, null);
  assert.equal(mapped.temporal_filter_applied, "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS");
});

test("temporal routing: no years/year_months at all applies no temporal filter regardless of doc_groups", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["major"], exchange_subtypes: [], periodic_subtypes: [], major_labels: ["자기주식"],
    years: [], year_months: [], correction: false,
  }, index);
  assert.equal(mapped.filters.receipt_date_from, null);
  assert.equal(mapped.temporal_filter_applied, "NONE_NO_TEMPORAL_CONDITION");
});

test("all 101 real official conditions route to a temporal_filter_applied value consistent with their own doc_groups/periodic_subtypes, and none apply base_month when a periodic_subtype is present", async () => {
  const resolver = await realResolver();
  const index = buildNameToCorpCodeIndex(resolver);
  const raw = await readFile(CONDITIONS_PATH, "utf8");
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tally = {};
  for (const row of rows) {
    const mapped = mapOfficialConditionToFilterInput(row.conditions, index);
    tally[mapped.temporal_filter_applied] = (tally[mapped.temporal_filter_applied] ?? 0) + 1;
    const dg = row.conditions.doc_groups ?? [];
    const hasSubtype = (row.conditions.periodic_subtypes ?? []).length > 0;
    if (mapped.temporal_filter_applied.startsWith("BASE_YEAR")) {
      assert.deepEqual(dg, ["periodic"]);
    }
    if (mapped.temporal_filter_applied === "BASE_YEAR_AND_MONTH_PERIODIC_NO_SUBTYPE") {
      assert.equal(hasSubtype, false);
    }
    if (hasSubtype && dg.length === 1 && dg[0] === "periodic") {
      assert.deepEqual(mapped.filters.base_months, []);
    }
    if (mapped.temporal_filter_applied === "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS") {
      assert.deepEqual(mapped.filters.base_years, []);
    }
  }
  assert.ok(tally.BASE_YEAR_ONLY_PERIODIC_SUBTYPE_DISAMBIGUATES > 0);
  assert.ok(tally.NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS > 0);
});
