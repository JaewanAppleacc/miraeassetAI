// Turn P10.1.1: sibling collapse + document-diversity cap, per this Turn's
// "Parent-aware 검색 계약" items 4-5.
//
// Group key = chunk.parent_chunk_id if present, else chunk.chunk_id (a
// parent-less chunk is its own singleton group). Within a group, the
// representative is whichever member has the HIGHEST RRF score; an exact
// score tie breaks by chunk_id ascending (same deterministic tie-break
// used everywhere else in this Turn's comparisons). group score = the
// representative's own RRF score -- never re-aggregated (e.g. summed)
// across members, so a group with many low-scoring siblings never
// outranks a group with one strong hit.
//
// This module NEVER substitutes a parent chunk into the scored/returned
// list -- only the representative CHILD chunk itself is ever collapsed
// into the output. Scoring downstream (dev-tune-metrics.mjs's
// computeItemMetrics) therefore can only ever credit a Gold locator hit
// via that child's own source_spans, never via parent text.
function groupKeyOf(chunk) {
  return chunk.parent_chunk_id ?? chunk.chunk_id;
}

// rankedIds: [{ id, score }] already RRF-fused and sorted desc by score
// (as reciprocalRankFusion returns). chunkById: Map<chunk_id, chunk>.
export function collapseSiblings(rankedIds, chunkById) {
  const groups = new Map(); // groupKey -> { representative: {id,score}, memberIds: [] }
  for (const entry of rankedIds) {
    const chunk = chunkById.get(entry.id);
    const key = groupKeyOf(chunk);
    if (!groups.has(key)) groups.set(key, { representative: entry, memberIds: [entry.id] });
    else {
      const group = groups.get(key);
      group.memberIds.push(entry.id);
      const current = group.representative;
      if (entry.score > current.score || (entry.score === current.score && entry.id.localeCompare(current.id) < 0)) {
        group.representative = entry;
      }
    }
  }

  const collapsedEntries = [...groups.entries()].map(([groupKey, group]) => ({
    groupKey,
    id: group.representative.id,
    score: group.representative.score,
    memberIds: group.memberIds,
  }));
  collapsedEntries.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  return collapsedEntries;
}

// Diagnostics over the pre-collapse top-N slice of the ORIGINAL ranked
// list (before any collapse/cap) -- "top-20의 unique parent 수" etc. are
// always computed against the SAME prefix length the caller asks for.
export function siblingCrowdingDiagnostics(rankedIds, chunkById, topN) {
  const prefix = rankedIds.slice(0, topN);
  const parentKeys = new Set();
  const documentIds = new Set();
  const groupCounts = new Map(); // groupKey -> count within this prefix
  for (const entry of prefix) {
    const chunk = chunkById.get(entry.id);
    const key = groupKeyOf(chunk);
    parentKeys.add(key);
    documentIds.add(chunk.document_id);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const siblingCrowdedSlots = [...groupCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const collapsedPrefix = collapseSiblings(rankedIds, chunkById).slice(0, topN);
  const uniqueParentsAfter = new Set(collapsedPrefix.map((e) => e.groupKey)).size;

  return {
    unique_parent_count_before: parentKeys.size,
    unique_parent_count_after: uniqueParentsAfter,
    sibling_crowded_slot_count: siblingCrowdedSlots,
    same_document_slot_count: prefix.length - documentIds.size, // slots beyond the first per document
  };
}
