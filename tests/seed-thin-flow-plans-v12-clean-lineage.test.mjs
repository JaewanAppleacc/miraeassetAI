// Turn M8 Section 6 (Plan lineage tests): proves the new clean Plan
// (v0.12.clean.candidate) is derived from OFFICIAL Plan v0.6, never from
// the v0.7-v0.11 research/Candidate lineage, and that the changed set is
// mechanically exactly what Section 2/5 specify.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildCleanPlanV12 } from "../scripts/build-seed-thin-flow-plans-v12-clean.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

let result;
test.before(async () => { result = await buildCleanPlanV12(); });

test("clean Plan base SHA is exactly Plan v0.6's own SHA", async () => {
  const v06Bytes = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"));
  assert.equal(result.baseShaV06, sha256(v06Bytes));
});

test("clean Plan's SHA-256 differs from every v0.7-v0.11 Candidate lineage revision (no byte-collision, genuinely independent artifact)", () => {
  const lineageShas = Object.values(result.candidateLineageShas).filter(Boolean);
  assert.ok(lineageShas.length >= 4, "expected to have compared against several candidate-lineage revisions");
  for (const sha of lineageShas) assert.notEqual(result.outputSha256, sha);
});

test("no output row carries sub_requests / sub_request_authority -- 0 of 25", () => {
  assert.equal(result.outputRows.filter((r) => Object.hasOwn(r, "sub_requests")).length, 0);
  assert.equal(result.outputRows.filter((r) => Object.hasOwn(r, "sub_request_authority")).length, 0);
});

test("Q05/Q07/Q19/Q21/Q24 are canonical-equal to v0.6 (field-for-field JSON equality, not just 'no slot change')", async () => {
  const v06Rows = (await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  for (const qid of ["question_seed_v07_05", "question_seed_v07_07", "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_24"]) {
    const base = v06Rows.find((r) => r.question_id === qid);
    const out = result.outputRows.find((r) => r.question_id === qid);
    assert.deepEqual(out, base, `${qid} must be canonical-equal to v0.6`);
  }
});

test("changed set is mechanically exactly the 6 questions Section 2/5 specify -- Q06/Q09/Q17/Q18/Q20/Q25", () => {
  assert.deepEqual([...result.changedQuestionIds].sort(), [
    "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
  ]);
});

test("approved-scope-outside Plan record changes: 0 (every one of the other 19 questions is byte-identical to v0.6)", async () => {
  const v06Rows = (await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const changedSet = new Set(result.changedQuestionIds);
  let outOfScopeChanges = 0;
  for (const base of v06Rows) {
    if (changedSet.has(base.question_id)) continue;
    const out = result.outputRows.find((r) => r.question_id === base.question_id);
    if (JSON.stringify(out) !== JSON.stringify(base)) outOfScopeChanges++;
  }
  assert.equal(outOfScopeChanges, 0);
});

test("exactly 1 record (Q18) carries schema_version 0.4.0; the other 24 keep 0.1.0", () => {
  const counts = result.outputRows.reduce((acc, r) => { acc[r.schema_version] = (acc[r.schema_version] ?? 0) + 1; return acc; }, {});
  assert.deepEqual(counts, { "0.1.0": 24, "0.4.0": 1 });
});

test("Q18's own information_limits declaration targets ISSUANCE_AMOUNT with reason NOT_DIRECTLY_DISCLOSED", () => {
  const q18 = result.outputRows.find((r) => r.question_id === "question_seed_v07_18");
  assert.equal(q18.information_limits.length, 1);
  assert.equal(q18.information_limits[0].target_metric_code, "ISSUANCE_AMOUNT");
  assert.equal(q18.information_limits[0].reason_code, "NOT_DIRECTLY_DISCLOSED");
});
