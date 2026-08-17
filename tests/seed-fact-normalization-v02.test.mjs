import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateFactRecord } from "../domain/adapters/seed-artifact-schema-validators.mjs";
import { buildSeedFactNormalizationV02 } from "../scripts/build-seed-fact-normalization-v02.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SOURCE_FACTS = path.join(ROOT, "work/domain-seed/seed-facts-verified.v0.1.jsonl");
const SOURCE_COVERAGE = path.join(ROOT, "work/domain-seed/seed-fact-coverage-verified.v0.1.json");

test("builds exactly 16 schema-valid CANDIDATE scale migrations without mutating source artifacts", async () => {
  const [factBefore, coverageBefore] = await Promise.all([readFile(SOURCE_FACTS), readFile(SOURCE_COVERAGE)]);
  const result = await buildSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, generatedAt: "2026-08-13T03:00:00.000Z" });
  assert.equal(result.delta.length, 16);
  assert.deepEqual(result.questionIds, [
    "question_seed_v07_10", "question_seed_v07_11", "question_seed_v07_12", "question_seed_v07_13",
    "question_seed_v07_14", "question_seed_v07_15", "question_seed_v07_16",
  ]);
  for (const candidate of result.delta) {
    assert.equal(candidate.verification_status, "CANDIDATE");
    assert.equal(candidate.scale, 1);
    assert.equal(candidate.attributes.normalization_migration.status, "PENDING_HUMAN_REVIEW");
    assert.deepEqual(validateFactRecord(candidate), []);
  }
  assert.deepEqual(await readFile(SOURCE_FACTS), factBefore);
  assert.deepEqual(await readFile(SOURCE_COVERAGE), coverageBefore);
});

test("every proposed canonical KRW value is the exact safe-integer product and preserves identity/evidence", async () => {
  const source = new Map((await readFile(SOURCE_FACTS, "utf8")).trim().split("\n").map(JSON.parse).map((fact) => [fact.fact_id, fact]));
  const { delta } = await buildSeedFactNormalizationV02({ root: ROOT, writeOutputs: false, generatedAt: "2026-08-13T03:00:00.000Z" });
  for (const candidate of delta) {
    const before = source.get(candidate.fact_id);
    assert.ok(before);
    assert.equal(candidate.normalized_value, before.normalized_value * before.scale);
    assert.equal(Number.isSafeInteger(candidate.normalized_value), true);
    assert.deepEqual(candidate.evidence_ids, before.evidence_ids);
    for (const field of ["corp_code", "metric_code", "source_document_id", "raw_value_text", "raw_unit_text", "unit", "currency", "scope", "period_start", "period_end"]) {
      assert.deepEqual(candidate[field], before[field], `${candidate.fact_id}:${field}`);
    }
  }
});
