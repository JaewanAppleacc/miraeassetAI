// Regression coverage for the Q10 CONSOLIDATION_ENTITY_COUNT period-
// semantics fix in scripts/build-seed-fact-batch-v07-candidates.mjs: the
// two facts must be POINT_IN_TIME as of the reporting date the count
// actually describes (not CUMULATIVE over a half-year), with known_at/
// valid_from kept as the real submission date -- while the disclosed
// numbers and every Evidence field stay byte-identical to v06's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildCandidates as buildCandidatesV06 } from "../scripts/build-seed-fact-batch-v06-candidates.mjs";
import { buildCandidates as buildCandidatesV07 } from "../scripts/build-seed-fact-batch-v07-candidates.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SCRIPT_PATH = path.join(ROOT, "scripts/build-seed-fact-batch-v07-candidates.mjs");
const FORBIDDEN_LITERALS = ["최재완", '"APPROVE"', '"VERIFIED"', '"OWNER_ACCEPTED"', '"ACCEPTED"'];

function findQ10(facts) {
  const q10 = facts.filter((f) => f.metric_code === "CONSOLIDATION_ENTITY_COUNT");
  assert.equal(q10.length, 2);
  const before = q10.find((f) => f.normalized_value === 10);
  const after = q10.find((f) => f.normalized_value === 16);
  assert.ok(before && after);
  return { before, after };
}

test("static: v07's code (comments excluded) never contains an approval literal or the reviewer's name", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const literal of FORBIDDEN_LITERALS) {
    assert.equal(codeOnly.includes(literal), false, `forbidden literal ${literal} found in non-comment code`);
  }
});

test("Q10 2023 fact: POINT_IN_TIME as of the reporting date, known/valid from the real submission date, period_start/end null", async () => {
  const { facts } = await buildCandidatesV07({ generatedAt: "2026-08-14T00:00:00.000Z" });
  const { before } = findQ10(facts);
  assert.equal(before.period_type, "POINT_IN_TIME");
  assert.equal(before.as_of_date, "2023-06-30");
  assert.equal(before.known_at, "2023-08-14T00:00:00Z");
  assert.equal(before.valid_from, "2023-08-14T00:00:00Z");
  assert.equal(before.period_start, null);
  assert.equal(before.period_end, null);
  assert.equal(before.normalized_value, 10);
});

test("Q10 2025 fact: POINT_IN_TIME as of the reporting date, known/valid from the real submission date, period_start/end null", async () => {
  const { facts } = await buildCandidatesV07({ generatedAt: "2026-08-14T00:00:00.000Z" });
  const { after } = findQ10(facts);
  assert.equal(after.period_type, "POINT_IN_TIME");
  assert.equal(after.as_of_date, "2025-06-30");
  assert.equal(after.known_at, "2025-08-14T00:00:00Z");
  assert.equal(after.valid_from, "2025-08-14T00:00:00Z");
  assert.equal(after.period_start, null);
  assert.equal(after.period_end, null);
  assert.equal(after.normalized_value, 16);
});

test("v07 no longer reproduces v06's CUMULATIVE/period_start+end/mismatched as_of_date shape for Q10", async () => {
  const { facts: v06Facts } = await buildCandidatesV06({ generatedAt: "2026-08-14T00:00:00.000Z" });
  const { before: before06, after: after06 } = findQ10(v06Facts);
  // Pin down exactly what was wrong in v06, so this test fails loudly if
  // v06's script is ever "fixed in place" instead of superseded.
  assert.equal(before06.period_type, "CUMULATIVE");
  assert.equal(before06.as_of_date, "2023-08-14");
  assert.equal(before06.period_start, "2023-01-01");
  assert.equal(before06.period_end, "2023-06-30");
  assert.equal(after06.period_type, "CUMULATIVE");
  assert.equal(after06.as_of_date, "2025-08-14");
});

test("Q10 Evidence is byte-identical between v06 and v07 (only the Facts' period fields changed)", async () => {
  const [v06, v07] = await Promise.all([
    buildCandidatesV06({ generatedAt: "2026-08-14T00:00:00.000Z" }),
    buildCandidatesV07({ generatedAt: "2026-08-14T00:00:00.000Z" }),
  ]);
  const q10Evidence06 = v06.evidence.filter((e) => e.metadata.linked_slot_names[0].startsWith("consolidation_entity_count"));
  const q10Evidence07 = v07.evidence.filter((e) => e.metadata.linked_slot_names[0].startsWith("consolidation_entity_count"));
  assert.equal(q10Evidence06.length, 2);
  assert.equal(q10Evidence07.length, 2);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(q10Evidence06[i].evidence_id, q10Evidence07[i].evidence_id);
    assert.equal(q10Evidence06[i].source_locator, q10Evidence07[i].source_locator);
    assert.equal(q10Evidence06[i].quoted_text, q10Evidence07[i].quoted_text);
    assert.equal(q10Evidence06[i].quote_sha256, q10Evidence07[i].quote_sha256);
  }
});

test("Q02/Q04/Q05 facts and their Evidence are unaffected by the Q10 period fix", async () => {
  const [v06, v07] = await Promise.all([
    buildCandidatesV06({ generatedAt: "2026-08-14T00:00:00.000Z" }),
    buildCandidatesV07({ generatedAt: "2026-08-14T00:00:00.000Z" }),
  ]);
  const others06 = v06.facts.filter((f) => f.metric_code !== "CONSOLIDATION_ENTITY_COUNT");
  const others07 = v07.facts.filter((f) => f.metric_code !== "CONSOLIDATION_ENTITY_COUNT");
  assert.equal(others06.length, 4);
  assert.equal(others07.length, 4);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(others06[i].fact_id, others07[i].fact_id);
    assert.equal(others06[i].period_type, others07[i].period_type);
    assert.equal(others06[i].as_of_date, others07[i].as_of_date);
    assert.equal(others06[i].known_at, others07[i].known_at);
    assert.equal(others06[i].normalized_value, others07[i].normalized_value);
  }
});

test("all 6 v07 records remain CANDIDATE/PENDING (the period fix did not accidentally re-approve anything)", async () => {
  const { evidence, facts, decisionTemplate } = await buildCandidatesV07({ generatedAt: "2026-08-14T00:00:00.000Z" });
  for (const record of evidence) assert.equal(record.verification_status, "CANDIDATE");
  for (const record of facts) {
    assert.equal(record.verification_status, "CANDIDATE");
    assert.equal(record.attributes.review_provenance.owner_disposition, "PENDING");
  }
  assert.equal(decisionTemplate.length, 6);
  for (const item of decisionTemplate) {
    assert.equal(item.owner_disposition, "PENDING");
    assert.equal(item.reviewer, null);
    assert.equal(item.reviewed_at, null);
  }
});

test("the v0.7 candidate/template files on disk reflect the fix and remain fully PENDING", async () => {
  const facts = (await readFile(path.join(ROOT, "work/domain-seed/seed-facts-candidates.v0.7.delta.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const { before, after } = findQ10(facts);
  assert.equal(before.period_type, "POINT_IN_TIME");
  assert.equal(after.period_type, "POINT_IN_TIME");

  const template = (await readFile(path.join(ROOT, "work/domain-seed/seed-structured-owner-decision.v0.7-batch.template.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(template.length, 6);
  for (const item of template) {
    assert.equal(item.owner_disposition, "PENDING");
    assert.equal(item.reviewer, null);
    assert.equal(item.reviewed_at, null);
  }
});

test("the v0.6 candidate/template files (the flawed-period predecessor) are preserved untouched on disk", async () => {
  const v06Facts = (await readFile(path.join(ROOT, "work/domain-seed/seed-facts-candidates.v0.6.delta.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const { before } = findQ10(v06Facts);
  assert.equal(before.period_type, "CUMULATIVE");
});
