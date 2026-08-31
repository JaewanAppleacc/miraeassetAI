// Turn P10.1: FIXED, deterministic hard-negative selection rule, pinned
// BEFORE any evaluation is run (per this Turn's brief: "항목별 negative
// 선정 규칙과 최대 개수를 실행 전에 고정"). Never changed after seeing
// results.
//
// RULE (fixed):
//   Candidate pool for item I = union, over EVERY corp_code in
//   I.corp_codes (usually 1, occasionally more for a multi-company
//   question), of every document in documents.jsonl whose corp_code ==
//   that value AND doc_group == I.doc_groups[0], MINUS I.gold_document_ids.
//   Sort candidates by |days(receipt_date, I.as_of_date)| ascending, tie-
//   break by document_id ascending (lexicographic) -- a pure function of
//   (corpus content, item fields) alone, never of insertion/scan order.
//   Take the first MAX_HARD_NEGATIVES_PER_ITEM (= 3) candidates TOTAL
//   (never 3-per-corp_code). If fewer exist, take all of them (never
//   padded, never fabricated).
export const MAX_HARD_NEGATIVES_PER_ITEM = 3;

function daysBetween(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00Z`).getTime();
  const b = new Date(`${dateB}T00:00:00Z`).getTime();
  return Math.abs(a - b) / 86400000;
}

export function selectHardNegatives(item, metadataIndex) {
  const docGroup = item.doc_groups[0];
  const excluded = new Set(item.gold_document_ids ?? []);
  const poolSet = new Set();
  for (const corpCode of item.corp_codes) {
    const key = `${corpCode}|${docGroup}`;
    for (const id of metadataIndex.byCorpDocGroup.get(key) ?? []) {
      if (!excluded.has(id)) poolSet.add(id);
    }
  }
  const candidates = [...poolSet];

  const ranked = candidates
    .map((id) => ({
      documentId: id,
      distanceDays: daysBetween(metadataIndex.byDocumentId.get(id).receipt_date, item.as_of_date),
    }))
    .sort((a, b) => (a.distanceDays - b.distanceDays) || a.documentId.localeCompare(b.documentId));

  return ranked.slice(0, MAX_HARD_NEGATIVES_PER_ITEM).map((r) => r.documentId);
}
