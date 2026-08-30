// Turn N4.10: pure selection of "Priority Wave 1" from Turn N4.9's 294-row
// provisional classification -- the union of rows satisfying ANY of the
// three conditions that most directly threaten the current decision-
// respecting graph's split/author leakage:
//   direct_cross_split_edge === true
//   direct_cross_author_edge === true
//   individually_decisive === true
//
// This module never hardcodes a count or a relation_candidate_id -- it
// computes the union purely from whatever classification rows the caller
// passes in, so tests/relation-closure-priority-wave-selection.test.mjs can
// exercise it with synthetic fixtures that assert a DIFFERENT union size
// than the real corpus's 13. It also never assigns CONFIRM/REJECT or any
// final disposition -- Priority Wave 1 is a REVIEW PRIORITY, never a
// correctness verdict (a selected row is not "wrong"; an unselected row is
// not "confirmed clean").
export function selectPriorityWave1({ classifications }) {
  const reasonsById = new Map();
  for (const c of classifications) {
    const reasons = [];
    if (c.direct_cross_split_edge === true) reasons.push("DIRECT_CROSS_SPLIT_EDGE");
    if (c.direct_cross_author_edge === true) reasons.push("DIRECT_CROSS_AUTHOR_EDGE");
    if (c.individually_decisive === true) reasons.push("INDIVIDUALLY_DECISIVE");
    if (reasons.length > 0) reasonsById.set(c.relation_candidate_id, reasons);
  }
  const relationCandidateIds = [...reasonsById.keys()].sort();
  const distribution = {
    DIRECT_CROSS_SPLIT_EDGE: classifications.filter((c) => c.direct_cross_split_edge === true).length,
    DIRECT_CROSS_AUTHOR_EDGE: classifications.filter((c) => c.direct_cross_author_edge === true).length,
    INDIVIDUALLY_DECISIVE: classifications.filter((c) => c.individually_decisive === true).length,
  };
  const multiConditionRelationCandidateIds = relationCandidateIds.filter((id) => reasonsById.get(id).length > 1).sort();
  return Object.freeze({
    relationCandidateIds,
    reasonsById,
    distribution,
    multiConditionCount: multiConditionRelationCandidateIds.length,
    multiConditionRelationCandidateIds,
    unionCount: relationCandidateIds.length,
  });
}
