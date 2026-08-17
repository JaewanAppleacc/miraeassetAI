// Regression contract for the v0.4 promotion (scripts/promote-seed-
// structured-artifacts-v04.mjs). These are the specific semantic-grounding
// invariants the Q22 row=16/row=17 off-by-one defect violated -- if any of
// them regress (e.g. a future edit accidentally re-links the bad row=16
// evidence, or drops a required token from the row=17 replacement), this
// must fail loudly rather than silently re-promoting a defective link.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const BAD_ROW16_EVIDENCE_ID = "evidence_3af676a53066446432eb71f4";
const ROW17_EVIDENCE_ID = "evidence_c0b7c71ea8a833271c28a498";

async function readJsonl(relPath) {
  const text = await readFile(path.join(ROOT, relPath), "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l));
}
async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(ROOT, relPath), "utf8"));
}

let evidence, evidenceById, facts, factsById, coverage;

test.before(async () => {
  evidence = await readJsonl("work/domain-seed/seed-evidence-verified.v0.6.jsonl");
  evidenceById = new Map(evidence.map((e) => [e.evidence_id, e]));
  facts = await readJsonl("work/domain-seed/seed-facts-verified.v0.4.jsonl");
  factsById = new Map(facts.map((f) => [f.fact_id, f]));
  coverage = await readJson("work/domain-seed/seed-fact-coverage-verified.v0.4.json");
});

test("the bad row=16 (section-heading-only) evidence is absent from the VERIFIED evidence set entirely", () => {
  assert.equal(evidenceById.has(BAD_ROW16_EVIDENCE_ID), false);
});

test("the bad row=16 evidence is not referenced by any VERIFIED fact", () => {
  for (const fact of facts) {
    assert.equal(fact.evidence_ids.includes(BAD_ROW16_EVIDENCE_ID), false, fact.fact_id);
  }
});

test("the bad row=16 evidence is not referenced by any VERIFIED coverage slot", () => {
  for (const slot of coverage.slots) {
    assert.equal(slot.evidence_ids.includes(BAD_ROW16_EVIDENCE_ID), false, slot.slot_key);
  }
});

test("latest_equity_shares is grounded in the row=17 evidence and its quote contains all four required tokens", () => {
  const slot = coverage.slots.find((s) => s.slot_key === "question_seed_v07_22::latest_equity_shares");
  assert.ok(slot, "slot not found");
  assert.deepEqual(slot.evidence_ids, [ROW17_EVIDENCE_ID]);
  const fact = factsById.get(slot.fact_ids[0]);
  assert.deepEqual(fact.evidence_ids, [ROW17_EVIDENCE_ID]);
  const quote = evidenceById.get(ROW17_EVIDENCE_ID).quoted_text;
  for (const token of ["PKG#1", "13.7%", "PKG#4", "100%"]) {
    assert.ok(quote.includes(token), `missing token "${token}" in row=17 quote`);
  }
});

test("latest_package_terms is grounded in evidence whose quote contains all four required PKG amount tokens (the corrected 5,564 value, not the pre-correction 5,562)", () => {
  const slot = coverage.slots.find((s) => s.slot_key === "question_seed_v07_22::latest_package_terms");
  assert.ok(slot, "slot not found");
  assert.equal(slot.evidence_ids.includes(BAD_ROW16_EVIDENCE_ID), false);
  for (const evidenceId of slot.evidence_ids) {
    const quote = evidenceById.get(evidenceId).quoted_text;
    for (const token of ["USD 167", "SAR 863", "USD 512", "SAR 5,564"]) {
      assert.ok(quote.includes(token), `missing token "${token}" in evidence ${evidenceId}`);
    }
    assert.equal(quote.includes("SAR 5,562"), false, `evidence ${evidenceId} still carries the pre-correction 5,562 value`);
  }
});

test("correction_timeline has zero evidence_ids resolving to the bad row=16 quote", () => {
  const slot = coverage.slots.find((s) => s.slot_key === "question_seed_v07_22::correction_timeline");
  assert.ok(slot, "slot not found");
  assert.equal(slot.evidence_ids.includes(BAD_ROW16_EVIDENCE_ID), false);
  assert.ok(slot.evidence_ids.length > 0);
});

test("if the bad row=16 evidence is ever re-added to the VERIFIED set, none of the three Q22 slots may reference it (regression trap)", () => {
  // Defends the INVARIANT itself, not just the current data: even if a
  // future promotion run somehow re-includes evidence_3af676a5... in the
  // evidence set (e.g. a merge mistake), these three specific slots must
  // still never cite it. This assertion is independent of whether the
  // record currently exists in `evidence` at all.
  const guardedSlots = ["question_seed_v07_22::latest_equity_shares", "question_seed_v07_22::latest_package_terms", "question_seed_v07_22::correction_timeline"];
  for (const slotKey of guardedSlots) {
    const slot = coverage.slots.find((s) => s.slot_key === slotKey);
    assert.ok(slot, slotKey);
    assert.equal(slot.evidence_ids.includes(BAD_ROW16_EVIDENCE_ID), false, slotKey);
  }
});

test("Q3's four holding cells (before/after count/ratio) use four distinct locators and four distinct evidence_ids", () => {
  const slotKeys = [
    "question_seed_v07_03::holding_before_count",
    "question_seed_v07_03::holding_before_ratio",
    "question_seed_v07_03::holding_after_count",
    "question_seed_v07_03::holding_after_ratio",
  ];
  const evidenceIds = [];
  const locators = [];
  for (const slotKey of slotKeys) {
    const slot = coverage.slots.find((s) => s.slot_key === slotKey);
    assert.ok(slot, slotKey);
    assert.equal(slot.evidence_ids.length, 1, slotKey);
    const evidenceId = slot.evidence_ids[0];
    evidenceIds.push(evidenceId);
    const record = evidenceById.get(evidenceId);
    assert.ok(record, evidenceId);
    locators.push(record.source_locator);
  }
  assert.equal(new Set(evidenceIds).size, 4, `expected 4 distinct evidence_ids, got ${JSON.stringify(evidenceIds)}`);
  assert.equal(new Set(locators).size, 4, `expected 4 distinct locators, got ${JSON.stringify(locators)}`);
  // before/after both read 8,539,148 / 41.25 -- same VALUE, different cell.
  const values = slotKeys.map((k) => factsById.get(coverage.slots.find((s) => s.slot_key === k).fact_ids[0]).normalized_value);
  assert.deepEqual(values, [8539148, 41.25, 8539148, 41.25]);
});

test("no VERIFIED coverage slot or fact references an evidence_id outside the v0.6 VERIFIED evidence set", () => {
  for (const slot of coverage.slots) {
    for (const evidenceId of slot.evidence_ids) assert.ok(evidenceById.has(evidenceId), `${slot.slot_key} -> ${evidenceId}`);
  }
  for (const fact of facts) {
    for (const evidenceId of fact.evidence_ids) assert.ok(evidenceById.has(evidenceId), `${fact.fact_id} -> ${evidenceId}`);
  }
});
