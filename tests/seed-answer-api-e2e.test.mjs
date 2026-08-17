import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GET } from "../app/answer/route.ts";
import { fromAnswerWireResponseSafe, validateAnswerWireResponse } from "../domain/runtime/answer-wire-response.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const GOLD = path.join(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");

// v0.18 (resolves the v0.17 audit finding): the process-wide
// configuredSeedRuntime singleton (domain/runtime/configured-seed-runtime.mjs)
// now defaults to domain/releases/seed-release.v0.18.manifest.json /
// seed-structured-artifacts.v0.6.manifest.json. The v0.17 self-approval
// defect (domain/releases/seed-release.v0.17.BLOCKED.audit-report.json) is
// resolved by a real, externally authored Owner decision (work/domain-seed/
// seed-structured-owner-decision.v0.7-batch.decision.jsonl, 6/6 APPROVE by
// 최재완), independently validated by scripts/promote-seed-fact-batch-v06.mjs
// before promotion; the Thin-plan/CHAIN_MANIFEST hardening is carried over
// unchanged from v0.17. GET /answer serves grounded STRUCTURED outcomes
// again for all 25 E2E-ready questions. This does NOT mean the overall
// Release Gate is open -- see domain/releases/seed-release.v0.18.RELEASE_GATE_STATUS.json:
// Q07/Q21/Q24 metric_fail and 17 REVIEW_REQUIRED items remain BLOCKED and
// are untouched by this release.
test("all 25 E2E-ready Seed questions (Q3/Q22 included) traverse the actual GET /answer five-string wire as grounded STRUCTURED outcomes", async () => {
  const gold = (await readFile(GOLD, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((record) => record.extensions.e2e_usage_status === "E2E_READY");
  assert.equal(gold.length, 25);
  for (const record of gold) {
    const url = new URL("http://localhost/answer");
    url.searchParams.set("question_id", record.question_id);
    url.searchParams.set("question", record.question);
    const response = await GET(new Request(url));
    assert.equal(response.status, 200, record.question_id);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    const wire = await response.json();
    assert.deepEqual(validateAnswerWireResponse(wire), [], record.question_id);
    assert.equal(wire.question_id, record.question_id);
    assert.equal(wire.question, record.question);
    const restored = fromAnswerWireResponseSafe(wire);
    assert.equal(restored.ok, true, record.question_id);
    assert.equal(restored.value.think_trace.execution_mode, "STRUCTURED", record.question_id);
    assert.ok(restored.value.retrieved_context.length > 0, record.question_id);
  }
});

test("Q3 and Q22 answer directly with the corrected (row=17) grounding, never the removed row=16 evidence", async () => {
  const gold = (await readFile(GOLD, "utf8")).trim().split("\n").map(JSON.parse);
  const expected = new Map([
    ["question_seed_v07_03", ["변화 없음", "8,539,148", "41.25"]],
    ["question_seed_v07_22", ["3,090,076,756,644", "SATORP", "2027-06-23"]],
  ]);
  for (const [questionId, fragments] of expected) {
    const record = gold.find((item) => item.question_id === questionId);
    const url = new URL("http://localhost/answer");
    url.searchParams.set("question_id", questionId);
    url.searchParams.set("question", record.question);
    const response = await GET(new Request(url));
    const wire = await response.json();
    const restored = fromAnswerWireResponseSafe(wire);
    assert.equal(response.status, 200);
    assert.equal(restored.ok, true);
    assert.equal(restored.value.think_trace.execution_mode, "STRUCTURED");
    assert.equal(restored.value.retrieved_context.some((item) => item.evidence_id === "evidence_3af676a53066446432eb71f4"), false, questionId);
    for (const fragment of fragments) assert.match(restored.value.answer, new RegExp(fragment.replaceAll(",", "[,]")));
  }
});

test("GET /ready attests the v0.18 configured runtime (v0.17 audit finding resolved)", async () => {
  const { GET: getReady } = await import("../app/ready/route.ts");
  const response = await getReady();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "READY", ready: true, error_code: null });
});
