import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildSeedQ3Q22V015 } from "../scripts/build-seed-q3-q22-v015.mjs";
import { buildSeedThinFlowPlansV03 } from "../scripts/build-seed-thin-flow-plans-v03.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const readJsonl = async (file) => (await readFile(path.join(ROOT, file), "utf8")).trim().split("\n").map(JSON.parse);

test("v0.15 builder deterministically resolves Q3/Q22 without overwriting sources", async () => {
  const result = await buildSeedQ3Q22V015();
  assert.deepEqual(result, { evidence: 213, facts: 67, slots: 82, canonicalDelta: 14 });
  const gold = await readJsonl("work/domain-seed/seed-gold-promotion-candidates.v0.15.jsonl");
  assert.equal(gold.length, 25);
  assert.equal(gold.every((record) => record.extensions.e2e_usage_status === "E2E_READY"), true);
  const q3 = gold.find((record) => record.question_id === "question_seed_v07_03");
  assert.equal(new Set(q3.extensions.evidence_ids).size, 4);
  assert.equal(q3.extensions.evidence_verification.every((item) => /&row=\d+&col=\d+$/.test(item.canonical_source_locator)), true);
  assert.deepEqual(q3.expected_answer.value, { shares_before: 8539148, ratio_before_percent: 41.25, shares_after: 8539148, ratio_after_percent: 41.25, changed: false });
  const q22 = gold.find((record) => record.question_id === "question_seed_v07_22");
  assert.equal(q22.gold_document_ids.length, 15);
  assert.equal(q22.expected_answer.value.correction_timeline_status, "COMPLETE");
});

test("Q22 effective-version edge targets 2024-11-28 and preserves the declared DART reference", async () => {
  const relations = await readJsonl("work/domain-seed/seed-relation-gold.v0.2.jsonl");
  const edge = relations.find((record) => record.source_document_id === "exchange_20250331802494");
  assert.equal(edge.target_document_id, "exchange_20241128800562");
  assert.equal(edge.attributes.declared_reference_document_id, "exchange_20240614800515");
});

test("v0.3 Thin Flow plan set covers all 25 questions including Q3/Q22", async () => {
  const { plans } = await buildSeedThinFlowPlansV03();
  assert.equal(plans.length, 25);
  assert.equal(plans.some((plan) => plan.question_id === "question_seed_v07_03"), true);
  assert.equal(plans.some((plan) => plan.question_id === "question_seed_v07_22"), true);
});
