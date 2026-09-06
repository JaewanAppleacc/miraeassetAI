// Turn A4-A3-QA-CONDITION-MAPPER-INTEGRATION-V1 — offline/structural wiring test.
//
// Verifies that scripts/arm_a_live_worker.mjs and scripts/arm_a4_a3_live_worker.mjs are actually
// wired to domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs (imports the right
// functions, from the right relative path, builds the corp-code index from this repo's own
// data/corpus/universe.csv, and no longer contains the old minimal-shape mappers). No DB, no
// KURE server, no subprocess, no network — both workers' own main() connects to Postgres/KURE
// unconditionally on load, which this turn is explicitly told NOT to exercise ("실제 KURE 서버가
// 다른 작업에 사용 중이면 live smoke는 실행하지 말고 offline/structural 검증까지만"), so this
// test never imports either worker file as a module. It instead (a) statically inspects each
// worker's source text for the exact call-sites the previous turn's integration introduced, and
// (b) functionally re-drives the SAME qa-condition-mapper entry points each worker calls, using
// the SAME relative import path and the SAME data/corpus/universe.csv file each worker reads at
// startup — so a broken relative path, a renamed export, or a wrong index shape would fail this
// test exactly the way it would fail the real worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ARM_A_LIVE_WORKER_PATH = path.join(REPO_ROOT, "scripts/arm_a_live_worker.mjs");
const ARM_A4_A3_LIVE_WORKER_PATH = path.join(REPO_ROOT, "scripts/arm_a4_a3_live_worker.mjs");
const MAPPER_RELATIVE_IMPORT = "../domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs";

// ---------- 1. static source inspection ----------

test("arm_a_live_worker.mjs imports the QA condition mapper (not the old minimal-shape mapper)", () => {
  const src = readFileSync(ARM_A_LIVE_WORKER_PATH, "utf8");
  assert.match(src, /from\s+\n?\s*"\.\.\/domain\/agent-comparison\/four-arm-ac\/qa-condition-mapper\.mjs"/);
  assert.match(src, /mapQaOrLegacyConditionsToArmAConditions/);
  assert.match(src, /buildNameToCorpCodeIndexFromUniverseCsv/);
  assert.match(src, /data\/corpus\/universe\.csv/);
  // the buggy minimal-shape mapper this turn's predecessor removed must not have come back
  assert.doesNotMatch(src, /function toArmAConditions\(/);
  // handleSearch must route through the mapper before calling adapter.search, and fail closed
  // (a distinct error code) rather than let a mapping exception crash the worker uncaught
  assert.match(src, /mapConditionsForSearch\(conditions\)/);
  assert.match(src, /ARM_A_CONDITION_MAPPING_FAILED/);
});

test("arm_a4_a3_live_worker.mjs imports the QA condition mapper (not the old minimal-shape mapper)", () => {
  const src = readFileSync(ARM_A4_A3_LIVE_WORKER_PATH, "utf8");
  assert.match(src, new RegExp(MAPPER_RELATIVE_IMPORT.replace(/[.[\]]/g, "\\$&")));
  assert.match(src, /mapQaOrLegacyConditionsToFourArmConditions/);
  assert.match(src, /buildNameToCorpCodeIndexFromUniverseCsv/);
  assert.match(src, /data\/corpus\/universe\.csv/);
  assert.doesNotMatch(src, /function toFourArmConditions\(/);
  assert.doesNotMatch(src, /function identityCorpCodeIndex\(/);
  assert.match(src, /mapConditionsForSearch\(conditions\)/);
  assert.match(src, /ARM_A4_A3_CONDITION_MAPPING_FAILED/);
});

test("arm_a4_a3_live_worker.mjs's candidate-k and reranker config are exactly unchanged", () => {
  const src = readFileSync(ARM_A4_A3_LIVE_WORKER_PATH, "utf8");
  assert.match(src, /const RETRIEVAL_OUTPUT_K = 20;/, "RETRIEVAL_OUTPUT_K must stay 20");
  assert.match(src, /const RERANKER_CONFIG_ID = "R4_wide_rrf_centric";/, "reranker config must stay unchanged");
});

// ---------- 2. functional re-drive of the exact wiring each worker performs at startup ----------

test("arm_a_live_worker's own wiring (relative import + universe.csv + mapQaOrLegacyConditionsToArmAConditions) produces a real non-empty filter", async () => {
  const workerDir = path.dirname(ARM_A_LIVE_WORKER_PATH);
  const mapperModuleUrl = new URL(MAPPER_RELATIVE_IMPORT, `file://${workerDir}/`).href;
  const { mapQaOrLegacyConditionsToArmAConditions, buildNameToCorpCodeIndexFromUniverseCsv } = await import(mapperModuleUrl);
  const universeCsvPath = path.join(path.resolve(workerDir, ".."), "data/corpus/universe.csv");
  const index = buildNameToCorpCodeIndexFromUniverseCsv(readFileSync(universeCsvPath, "utf8"));

  const qaShaped = { corps: ["삼성전자"], doc_groups: ["periodic"], year_months: [[2024, 3]], years: [2024] };
  const filters = mapQaOrLegacyConditionsToArmAConditions(qaShaped, { nameToCorpCodeIndex: index });
  assert.deepEqual(filters.corp_codes, ["00126380"]);
  assert.deepEqual(filters.doc_groups, ["periodic"]);
  assert.deepEqual(filters.base_years, [2024]);

  const legacyShaped = { corp_code: "00126380", document_group: "periodic", period: "2024-03" };
  const legacyFilters = mapQaOrLegacyConditionsToArmAConditions(legacyShaped, { nameToCorpCodeIndex: index });
  assert.deepEqual(legacyFilters.corp_codes, ["00126380"]);
  assert.deepEqual(legacyFilters.base_years, [2024]);
  assert.deepEqual(legacyFilters.base_months, [3]);
});

test("arm_a4_a3_live_worker's own wiring (relative import + universe.csv + mapQaOrLegacyConditionsToFourArmConditions) produces a real non-empty conditions object", async () => {
  const workerDir = path.dirname(ARM_A4_A3_LIVE_WORKER_PATH);
  const mapperModuleUrl = new URL(MAPPER_RELATIVE_IMPORT, `file://${workerDir}/`).href;
  const { mapQaOrLegacyConditionsToFourArmConditions, buildNameToCorpCodeIndexFromUniverseCsv } = await import(mapperModuleUrl);
  const universeCsvPath = path.join(path.resolve(workerDir, ".."), "data/corpus/universe.csv");
  const index = buildNameToCorpCodeIndexFromUniverseCsv(readFileSync(universeCsvPath, "utf8"));

  const qaShaped = { corps: ["아모레퍼시픽"], doc_groups: ["holding"], year_months: [[2024, 3]], years: [2024] };
  const { conditions, nameToCorpCodeIndex, diagnostics } = mapQaOrLegacyConditionsToFourArmConditions(
    qaShaped, { nameToCorpCodeIndex: index },
  );
  assert.deepEqual(conditions.corps, ["아모레퍼시픽"]);
  assert.deepEqual(conditions.doc_groups, ["holding"]);
  assert.equal(nameToCorpCodeIndex.get("아모레퍼시픽"), "00583424");
  assert.equal(diagnostics.shape, "QA");

  const legacyShaped = { corp_code: "00583424", document_group: "holding" };
  const legacyResult = mapQaOrLegacyConditionsToFourArmConditions(legacyShaped, { nameToCorpCodeIndex: index });
  assert.deepEqual(legacyResult.conditions.corps, ["00583424"]);
  assert.equal(legacyResult.nameToCorpCodeIndex.get("00583424"), "00583424");
});
