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

test("mapOfficialConditionToFilterInput maps a real HIGH-segment condition end to end (corp_codes + doc_groups + years/months + is_correction)", async () => {
  const resolver = await realResolver();
  const index = buildNameToCorpCodeIndex(resolver);
  const raw = await readFile(CONDITIONS_PATH, "utf8");
  const row = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.question_id === "author_0459b5f8f37b0192316cd77c");
  const mapped = mapOfficialConditionToFilterInput(row.conditions, index);
  assert.deepEqual(mapped.filters.corp_codes, ["00583424"]); // 아모레퍼시픽
  assert.deepEqual(mapped.filters.doc_groups, ["holding"]);
  assert.deepEqual(mapped.filters.base_years, [2024]);
  assert.deepEqual(mapped.filters.base_months, [3]);
  assert.equal(mapped.filters.is_correction, false);
});

test("exchange_subtypes and periodic_subtypes map directly into doc_subtypes (verified aligned with the real DB vocabulary)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: ["exchange"], exchange_subtypes: ["단일판매공급계약체결"], periodic_subtypes: ["quarter"],
    major_labels: [], years: [], year_months: [], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.doc_subtypes.sort(), ["quarter", "단일판매공급계약체결"].sort());
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

test("year_months with multiple distinct months for one corp are unioned into base_months (documented widening, not silently exact)", () => {
  const index = new Map();
  const mapped = mapOfficialConditionToFilterInput({
    corps: [], doc_groups: [], exchange_subtypes: [], periodic_subtypes: [], major_labels: [],
    years: [2023, 2024], year_months: [[2023, 1], [2024, 3]], correction: false,
  }, index);
  assert.deepEqual(mapped.filters.base_years.sort(), [2023, 2024]);
  assert.deepEqual(mapped.filters.base_months.sort(), [1, 3]);
  assert.ok(mapped.note.includes("independent constraints"));
});
