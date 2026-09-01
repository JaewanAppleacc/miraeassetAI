// Turn P10.1.1: "6. parent expansion" -- attaches parent TEXT as answer
// CONTEXT only, alongside the representative child. This function returns
// a plain { child, contextText, contextSource } record for reporting/
// inspection; it is NEVER passed into dev-tune-metrics.mjs's
// computeItemMetrics (which only ever receives the representative CHILD
// chunk objects themselves -- see scripts/p10.1.1-hierarchical-
// diagnostic.mjs). This module has no scoring authority of its own; it
// cannot "award" a Gold locator hit, because it is never on the path that
// decides one.
export function expandWithParentContext(representativeChunk, chunkById) {
  const parentId = representativeChunk.parent_chunk_id;
  const parent = parentId ? chunkById.get(parentId) : null;
  if (parent) {
    return { child: representativeChunk, contextText: parent.raw_text, contextSource: "PARENT" };
  }
  return { child: representativeChunk, contextText: representativeChunk.raw_text, contextSource: "CHILD_FALLBACK" };
}
