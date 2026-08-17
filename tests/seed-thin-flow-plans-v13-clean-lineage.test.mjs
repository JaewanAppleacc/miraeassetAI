// Turn M10 Section 7: Plan v0.13 clean candidate is a pure, single-field
// addition on top of Plan v0.12 clean candidate -- adds Q18's existing
// VERIFIED correction Event's own real evidence_id to Q18's Plan-level
// evidence_ids array only, making that already-VERIFIED Event reachable
// via the Flow's existing evidence_ids-keyed EVENT query. Every other
// record must be byte-for-byte identical to v0.12.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildCleanPlanV13 } from "../scripts/build-seed-thin-flow-plans-v13-clean.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let result; let baseRows; let outRows;

test.before(async () => {
  result = await buildCleanPlanV13();
  const baseBytes = await readFile(path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl"));
  baseRows = baseBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  outRows = result.outputBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
});

test("base SHA in the manifest exactly matches Plan v0.12 clean candidate's real SHA", async () => {
  const baseBytes = await readFile(path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl"));
  assert.equal(result.manifest.base_plan_v012_sha256, sha256(baseBytes));
  assert.equal(result.manifest.base_plan_v012_sha256, "79e87d20982ef2c86eaaa64e8dddda68ce91e1d7d448a56f04426d1ce18298f2");
});

test("exactly Q18 changed; all other 24 records are byte-for-byte identical to Plan v0.12", () => {
  assert.deepEqual(result.manifest.changed_question_ids, ["question_seed_v07_18"]);
  for (const row of outRows) {
    const baseRow = baseRows.find((r) => r.question_id === row.question_id);
    if (row.question_id === "question_seed_v07_18") continue;
    assert.deepEqual(row, baseRow, `${row.question_id} unexpectedly diverged from Plan v0.12`);
  }
});

test("Q18's ONLY change is the addition of the correction Event's own real evidence_id to the top-level evidence_ids array", () => {
  const baseQ18 = baseRows.find((r) => r.question_id === "question_seed_v07_18");
  const outQ18 = outRows.find((r) => r.question_id === "question_seed_v07_18");
  assert.equal(outQ18.evidence_ids.length, baseQ18.evidence_ids.length + 1);
  assert.ok(outQ18.evidence_ids.includes("evidence_027901c5fc28cf428810b88e"));
  assert.equal(baseQ18.evidence_ids.includes("evidence_027901c5fc28cf428810b88e"), false);
  const { evidence_ids: outIds, ...outRest } = outQ18;
  const { evidence_ids: baseIds, ...baseRest } = baseQ18;
  assert.deepEqual(outRest, baseRest, "no field other than evidence_ids changed");
  assert.equal(Object.hasOwn(outQ18, "sub_requests"), false);
});

test("record count is 25, no duplicate question_id, no question dropped", () => {
  assert.equal(outRows.length, 25);
  assert.equal(new Set(outRows.map((r) => r.question_id)).size, 25);
  assert.deepEqual([...outRows.map((r) => r.question_id)].sort(), [...baseRows.map((r) => r.question_id)].sort());
});

test("sub_request_authority_present is false (no Sub-request research revival)", () => {
  assert.equal(result.manifest.sub_request_authority_present, false);
});
