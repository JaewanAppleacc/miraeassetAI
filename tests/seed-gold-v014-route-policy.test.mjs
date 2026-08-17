import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildSeedGoldV014RoutePolicy } from "../scripts/build-seed-gold-v014-route-policy.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SOURCE = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl");
const parse = (text) => text.trim().split("\n").map(JSON.parse);

test("v0.14 draft aligns only the 23 VERIFIED-Coverage routes with STRUCTURED", async () => {
  const sourceBytesBefore = await readFile(SOURCE);
  const result = await buildSeedGoldV014RoutePolicy({ root: ROOT, writeOutputs: false, generatedAt: "2026-08-13T02:00:00.000Z" });
  assert.equal(result.output.length, 25);
  assert.equal(result.mapping.filter((item) => item.route_policy_changed).length, 23);
  for (const record of result.output) {
    if (["question_seed_v07_03", "question_seed_v07_22"].includes(record.question_id)) continue;
    assert.ok(record.expected_execution.route_policy.every((rule) => rule.preferred_route === "STRUCTURED"));
    assert.equal(record.extensions.route_policy_status, "DRAFT_RUNTIME_ALIGNED_PENDING_OWNER_REVIEW");
  }
  assert.deepEqual(await readFile(SOURCE), sourceBytesBefore);
});

test("v0.14 draft changes no answer, evidence, scoring, or question content", async () => {
  const before = parse(await readFile(SOURCE, "utf8"));
  const { output } = await buildSeedGoldV014RoutePolicy({ root: ROOT, writeOutputs: false, generatedAt: "2026-08-13T02:00:00.000Z" });
  for (let index = 0; index < before.length; index++) {
    for (const field of ["question", "expected_answer", "required_evidence_slots", "scoring_spec", "gold_document_ids", "gold_chain_ids"]) {
      assert.deepEqual(output[index][field], before[index][field], `${before[index].question_id}:${field}`);
    }
  }
});
