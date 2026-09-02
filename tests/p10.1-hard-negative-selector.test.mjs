import test from "node:test";
import assert from "node:assert/strict";
import { selectHardNegatives, MAX_HARD_NEGATIVES_PER_ITEM } from "../domain/agent-comparison/chunking-comparison/hard-negative-selector.mjs";

function buildIndex(records) {
  const byDocumentId = new Map(records.map((r) => [r.document_id, r]));
  const byCorpDocGroup = new Map();
  for (const r of records) {
    const key = `${r.corp_code}|${r.doc_group}`;
    if (!byCorpDocGroup.has(key)) byCorpDocGroup.set(key, []);
    byCorpDocGroup.get(key).push(r.document_id);
  }
  for (const [key, ids] of byCorpDocGroup) {
    ids.sort((a, b) => {
      const da = byDocumentId.get(a).receipt_date, db = byDocumentId.get(b).receipt_date;
      return da < db ? -1 : da > db ? 1 : a.localeCompare(b);
    });
  }
  return { byDocumentId, byCorpDocGroup };
}

const RECORDS = [
  { document_id: "major_20230101000001", corp_code: "00126380", doc_group: "major", receipt_date: "2023-01-01" },
  { document_id: "major_20230201000002", corp_code: "00126380", doc_group: "major", receipt_date: "2023-02-01" },
  { document_id: "major_20230301000003", corp_code: "00126380", doc_group: "major", receipt_date: "2023-03-01" },
  { document_id: "major_20230601000004", corp_code: "00126380", doc_group: "major", receipt_date: "2023-06-01" },
  { document_id: "major_20230115000005", corp_code: "00999999", doc_group: "major", receipt_date: "2023-01-15" }, // different company -- must never be selected
];

test("selects candidates closest to as_of_date, excludes the gold document itself", () => {
  const index = buildIndex(RECORDS);
  const item = { corp_codes: ["00126380"], doc_groups: ["major"], as_of_date: "2023-02-15", gold_document_ids: ["major_20230201000002"] };
  const negatives = selectHardNegatives(item, index);
  assert.ok(!negatives.includes("major_20230201000002"));
  assert.ok(!negatives.includes("major_20230115000005"), "must never pull a document from a different corp_code");
  // closest to 2023-02-15 among {01-01, 03-01, 06-01} is 03-01 (14 days) then 01-01 (45 days) then 06-01 (~106 days)
  assert.deepEqual(negatives, ["major_20230301000003", "major_20230101000001", "major_20230601000004"]);
});

test("caps at MAX_HARD_NEGATIVES_PER_ITEM even when more candidates exist", () => {
  const index = buildIndex(RECORDS);
  const item = { corp_codes: ["00126380"], doc_groups: ["major"], as_of_date: "2023-01-01", gold_document_ids: [] };
  const negatives = selectHardNegatives(item, index);
  assert.equal(negatives.length, MAX_HARD_NEGATIVES_PER_ITEM);
});

test("never pads with fewer candidates than exist", () => {
  const index = buildIndex(RECORDS);
  const item = { corp_codes: ["00999999"], doc_groups: ["major"], as_of_date: "2023-01-15", gold_document_ids: ["major_20230115000005"] };
  const negatives = selectHardNegatives(item, index);
  assert.deepEqual(negatives, []); // the only doc for this corp_code was excluded as gold; no fabricated negatives
});

test("deterministic across repeated calls", () => {
  const index = buildIndex(RECORDS);
  const item = { corp_codes: ["00126380"], doc_groups: ["major"], as_of_date: "2023-02-15", gold_document_ids: [] };
  const first = selectHardNegatives(item, index);
  const second = selectHardNegatives(item, index);
  assert.deepEqual(first, second);
});

test("union pool across multiple corp_codes when an item spans more than one company", () => {
  const index = buildIndex(RECORDS);
  const item = { corp_codes: ["00126380", "00999999"], doc_groups: ["major"], as_of_date: "2023-01-10", gold_document_ids: [] };
  const negatives = selectHardNegatives(item, index);
  assert.ok(negatives.includes("major_20230115000005"), "the other company's document should be a valid candidate for a multi-company item");
  assert.equal(negatives.length, MAX_HARD_NEGATIVES_PER_ITEM);
});
