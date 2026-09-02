// Turn P10.1.1: the parent-aware search contract's "1차 검색 단위" rule --
// only these leaf/child chunk_types are ever offered as retrieval
// candidates; a parent-role chunk_type (SECTION_PARENT/EVENT_PARENT/
// HOLDING_STATUS_PARENT/TABLE_WHOLE) never competes for a top-k slot.
export const LEAF_CANDIDATE_CHUNK_TYPES = Object.freeze(new Set([
  "PARAGRAPH_CHILD",
  "FIELD_GROUP_CHILD",
  "TABLE_ROW",
  "DOCUMENT_FALLBACK",
]));

export function isLeafCandidateChunk(chunk) {
  return LEAF_CANDIDATE_CHUNK_TYPES.has(chunk.chunk_type);
}

export function filterToLeafCandidates(chunks) {
  return chunks.filter(isLeafCandidateChunk);
}
