// Turn P10.1.1: "5. document diversity" -- at most MAX_GROUPS_PER_DOCUMENT
// (=4) collapsed groups from the SAME document may appear in the final
// ranking. Fixed BEFORE running, never changed after seeing results.
// Excess groups are dropped (never replaced/padded); the excluded count is
// always reported.
export const MAX_GROUPS_PER_DOCUMENT = 4;

// collapsedEntries: already sorted desc by score (collapseSiblings' own
// output). Returns { kept, excludedCount } -- `kept` preserves the input's
// relative order (a stable filter, not a re-sort).
export function applyDocumentDiversityCap(collapsedEntries, chunkById) {
  const perDocumentCount = new Map();
  const kept = [];
  let excludedCount = 0;
  for (const entry of collapsedEntries) {
    const documentId = chunkById.get(entry.id).document_id;
    const count = perDocumentCount.get(documentId) ?? 0;
    if (count >= MAX_GROUPS_PER_DOCUMENT) { excludedCount += 1; continue; }
    perDocumentCount.set(documentId, count + 1);
    kept.push(entry);
  }
  return { kept, excludedCount };
}
