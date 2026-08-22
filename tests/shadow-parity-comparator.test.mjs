// Turn N3: unit coverage for domain/postgres/shadow-parity-comparator.mjs --
// deterministic, synthetic data only, no bundle/Postgres involved. Proves
// the comparator itself (a) accepts genuinely identical data, (b) reports
// the exact failure category the required parity checks depend on
// (missing/extra/duplicate ID, field-path payload mismatch, order
// mismatch, NOT_FOUND asymmetry), (c) truncates large values instead of
// dumping full payloads, and (d) never treats a mismatch as something to
// silently resolve.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ShadowParityMismatchError,
  assertParity,
  compareIdSets,
  compareRecordSets,
  compareSingleRecord,
} from "../domain/postgres/shadow-parity-comparator.mjs";

test("compareIdSets: identical sets (different order) are ok with zero missing/extra/duplicate", () => {
  const result = compareIdSets({ baselineIds: ["a", "b", "c"], shadowIds: ["c", "a", "b"] });
  assert.deepEqual(result, { ok: true, missing: [], extra: [], baselineDuplicateCount: 0, shadowDuplicateCount: 0 });
});

test("compareIdSets: reports missing (baseline-only) and extra (shadow-only) IDs", () => {
  const result = compareIdSets({ baselineIds: ["a", "b"], shadowIds: ["b", "c"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["a"]);
  assert.deepEqual(result.extra, ["c"]);
});

test("compareIdSets: a duplicate on either side alone fails, even with otherwise-matching sets", () => {
  const baselineDup = compareIdSets({ baselineIds: ["a", "a", "b"], shadowIds: ["a", "b"] });
  assert.equal(baselineDup.ok, false);
  assert.equal(baselineDup.baselineDuplicateCount, 1);
  assert.equal(baselineDup.shadowDuplicateCount, 0);

  const shadowDup = compareIdSets({ baselineIds: ["a", "b"], shadowIds: ["a", "a", "b"] });
  assert.equal(shadowDup.ok, false);
  assert.equal(shadowDup.shadowDuplicateCount, 1);
});

test("compareRecordSets: identical records in different order are ok when orderMatters is false (the default)", () => {
  const baseline = [{ record_id: "f1", payload: { x: 1 } }, { record_id: "f2", payload: { x: 2 } }];
  const shadow = [{ record_id: "f2", payload: { x: 2 } }, { record_id: "f1", payload: { x: 1 } }];
  assert.equal(compareRecordSets({ role: "FACT", query: "q1", baseline, shadow }).ok, true);
});

test("compareRecordSets: orderMatters=true rejects the SAME records returned in a different order", () => {
  const baseline = [{ record_id: "f1" }, { record_id: "f2" }];
  const shadow = [{ record_id: "f2" }, { record_id: "f1" }];
  const result = compareRecordSets({ role: "FACT", query: "q1", baseline, shadow, orderMatters: true });
  assert.equal(result.ok, false);
  assert.match(result.summary, /order mismatch at index 0/);
});

test("compareRecordSets: a field-path payload mismatch reports role/query/id/path, not a full payload dump", () => {
  const baseline = [{ record_id: "f1", payload: { corp_code: "001", nested: { value: "correct" } } }];
  const shadow = [{ record_id: "f1", payload: { corp_code: "001", nested: { value: "WRONG" } } }];
  const result = compareRecordSets({ role: "FACT", query: "q_mismatch", baseline, shadow });
  assert.equal(result.ok, false);
  assert.equal(result.role, "FACT");
  assert.equal(result.query, "q_mismatch");
  assert.equal(result.firstMismatch.id, "f1");
  assert.equal(result.firstMismatch.path, "payload.nested.value");
  assert.equal(result.firstMismatch.baseline, "correct");
  assert.equal(result.firstMismatch.shadow, "WRONG");
});

test("compareRecordSets: mismatch report truncates large values instead of embedding the full text", () => {
  const longText = "x".repeat(5000);
  const baseline = [{ record_id: "e1", payload: { evidence_span: { text: longText } } }];
  const shadow = [{ record_id: "e1", payload: { evidence_span: { text: `${longText}-DIFFERENT` } } }];
  const result = compareRecordSets({ role: "EVIDENCE", query: "q_long", baseline, shadow });
  assert.equal(result.ok, false);
  assert.ok(result.firstMismatch.baseline.length < 250, "truncated baseline value must stay well under the raw 5000+ char payload");
  assert.match(result.firstMismatch.baseline, /truncated/);
});

test("compareRecordSets: reports id-set mismatch (not a payload diff) when an ID is missing or extra", () => {
  const baseline = [{ record_id: "f1" }, { record_id: "f2" }];
  const shadow = [{ record_id: "f1" }];
  const result = compareRecordSets({ role: "FACT", query: "q_missing", baseline, shadow });
  assert.equal(result.ok, false);
  assert.match(result.summary, /id set mismatch/);
  assert.equal(result.firstMismatch, null);
  assert.deepEqual(result.idSetResult.missing, ["f2"]);
});

test("compareRecordSets: idOf supports raw payload shapes (e.g. { fact_id }) via a custom accessor", () => {
  const baseline = [{ fact_id: "fact_a", corp_code: "001" }];
  const shadow = [{ fact_id: "fact_a", corp_code: "001" }];
  const result = compareRecordSets({ role: "FACT", query: "raw", baseline, shadow, idOf: (r) => r.fact_id });
  assert.equal(result.ok, true);
});

test("compareSingleRecord: both-null (NOT_FOUND on both sides) is parity, not a mismatch", () => {
  const result = compareSingleRecord({ role: "FACT", query: "getFact(nonexistent)", baseline: null, shadow: null });
  assert.equal(result.ok, true);
  assert.match(result.summary, /NOT_FOUND/);
});

test("compareSingleRecord: exactly one side null is a mismatch, never silently treated as NOT_FOUND", () => {
  const oneNull = compareSingleRecord({ role: "FACT", query: "getFact(f1)", baseline: { fact_id: "f1" }, shadow: null });
  assert.equal(oneNull.ok, false);
  assert.match(oneNull.summary, /NOT_FOUND parity mismatch/);

  const otherNull = compareSingleRecord({ role: "FACT", query: "getFact(f1)", baseline: null, shadow: { fact_id: "f1" } });
  assert.equal(otherNull.ok, false);
});

test("compareSingleRecord: two non-null values that differ report the field path", () => {
  const result = compareSingleRecord({
    role: "EVIDENCE", query: "getEvidence(e1)",
    baseline: { evidence_id: "e1", metadata: { corp_code: "001" } },
    shadow: { evidence_id: "e1", metadata: { corp_code: "002" } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.firstMismatch.path, "metadata.corp_code");
});

test("assertParity: throws ShadowParityMismatchError with role/query/id/path in the message for a failing result", () => {
  const baseline = [{ record_id: "f1", payload: { x: 1 } }];
  const shadow = [{ record_id: "f1", payload: { x: 2 } }];
  const result = compareRecordSets({ role: "FACT", query: "q_assert", baseline, shadow });
  assert.throws(() => assertParity(result), (error) => {
    assert.ok(error instanceof ShadowParityMismatchError);
    assert.match(error.message, /role=FACT/);
    assert.match(error.message, /query=q_assert/);
    assert.match(error.message, /id=f1/);
    assert.match(error.message, /path=payload\.x/);
    assert.equal(error.detail, result);
    return true;
  });
});

test("assertParity: a passing result returns the result itself and never throws", () => {
  const result = compareIdSets({ baselineIds: ["a"], shadowIds: ["a"] });
  assert.equal(assertParity(result), result);
});

test("array length mismatch inside a nested payload is reported at its own .length path, not misattributed to an unrelated element", () => {
  const baseline = [{ record_id: "f1", payload: { evidence_ids: ["e1", "e2"] } }];
  const shadow = [{ record_id: "f1", payload: { evidence_ids: ["e1"] } }];
  const result = compareRecordSets({ role: "FACT", query: "q_arr", baseline, shadow });
  assert.equal(result.ok, false);
  assert.equal(result.firstMismatch.path, "payload.evidence_ids.length");
});

test("NaN in equivalent position on both sides does not falsely report a mismatch", () => {
  const baseline = [{ record_id: "f1", payload: { value: NaN } }];
  const shadow = [{ record_id: "f1", payload: { value: NaN } }];
  assert.equal(compareRecordSets({ role: "FACT", query: "q_nan", baseline, shadow }).ok, true);
});
