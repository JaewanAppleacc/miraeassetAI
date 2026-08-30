// Turn P5.1: bounded-memory, single-pass exact-duplicate accumulator.
//
// Memory design: one Map entry per DISTINCT text_sha256 (not per chunk).
// Each entry is a small, fixed-size record -- no per-hash Set/array that
// could grow with occurrence count. Cross-document duplication is detected
// without ever storing a full set of document ids per hash: because the
// upstream snapshot writer (Turn P5) visits each document's own chunks as
// one contiguous run and never revisits a document afterward, "the current
// chunk's document_id differs from the last document_id seen for this
// hash" is sufficient to correctly count DISTINCT documents once per hash,
// in O(1) space per hash. A short (<=40 char) safe preview is captured only
// at first sight of a hash -- never the full chunk text, regardless of how
// long the original chunk was.
import {
  safePreview,
  isProtectedFromBoilerplate,
  isNumberOnly,
  isSymbolOnly,
  isPageNumberLike,
  utf8ByteLength,
  tokenProxyRange,
  newHistogram,
  percentile,
} from "./contracts.mjs";

export function createDuplicateAnalysisAccumulator() {
  const byHash = new Map();
  let totalChunksSeen = 0;

  return {
    add(chunk) {
      totalChunksSeen += 1;
      const hash = chunk.text_sha256;
      const existing = byHash.get(hash);
      if (!existing) {
        byHash.set(hash, {
          count: 1,
          distinctDocumentCount: 1,
          lastSeenDocumentId: chunk.source_document_id,
          firstChunkId: chunk.chunk_id,
          firstSourceDocumentId: chunk.source_document_id,
          firstSourceLocator: chunk.source_locator,
          preview: safePreview(chunk.text_content),
          charLength: chunk.text_content.length,
          byteLength: utf8ByteLength(chunk.text_content),
          blockType: chunk.metadata?.block_type ?? "UNKNOWN",
          tableRowRange: chunk.metadata?.table_row_range ?? null,
          // Computed once, at first sight of this exact text -- every other
          // occurrence of the SAME hash is, by definition, the identical
          // text, so none of these ever need recomputing per-occurrence.
          protectedFromBoilerplate: isProtectedFromBoilerplate(chunk.text_content),
          isNumberOnly: isNumberOnly(chunk.text_content),
          isSymbolOnly: isSymbolOnly(chunk.text_content),
          isPageNumberLike: isPageNumberLike(chunk.text_content),
        });
        return;
      }
      existing.count += 1;
      if (existing.lastSeenDocumentId !== chunk.source_document_id) {
        existing.distinctDocumentCount += 1;
        existing.lastSeenDocumentId = chunk.source_document_id;
      }
    },

    // Exposed so a caller (boilerplate-rules.mjs, build-index-plan.mjs) can
    // classify/verify per-unique-text without a second full file scan.
    entries() {
      return byHash.entries();
    },
    get size() {
      return byHash.size;
    },
    get(hash) {
      return byHash.get(hash);
    },

    toJSON({ topN = 50 } = {}) {
      const occurrenceCounts = [];
      let withinDocumentDuplicateOccurrences = 0; // extra occurrences of a hash within the SAME document beyond its first
      let crossDocumentDuplicateGroups = 0; // hashes seen in >= 2 distinct documents
      let crossDocumentDuplicateOccurrences = 0; // total occurrences belonging to a cross-document-duplicate hash
      let sumOfOccurrences = 0;
      let uniqueTextTotalChars = 0;
      let uniqueTextTotalBytes = 0;
      let uniqueTextTotalTokenProxyLow = 0;
      let uniqueTextTotalTokenProxyHigh = 0;
      const occurrenceHistogram = newHistogram([1, 2, 5, 10, 50, 200, 1000]);

      for (const [, entry] of byHash) {
        occurrenceCounts.push(entry.count);
        sumOfOccurrences += entry.count;
        occurrenceHistogram.add(entry.count);
        uniqueTextTotalChars += entry.charLength;
        uniqueTextTotalBytes += entry.byteLength;
        const tokenRange = tokenProxyRange(entry.charLength);
        uniqueTextTotalTokenProxyLow += tokenRange.low;
        uniqueTextTotalTokenProxyHigh += tokenRange.high;
        if (entry.distinctDocumentCount === 1 && entry.count > 1) {
          withinDocumentDuplicateOccurrences += entry.count - 1;
        }
        if (entry.distinctDocumentCount > 1) {
          crossDocumentDuplicateGroups += 1;
          crossDocumentDuplicateOccurrences += entry.count;
        }
      }
      occurrenceCounts.sort((a, b) => a - b);

      const top = [...byHash.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, topN)
        .map(([hash, entry]) => ({
          text_sha256: hash,
          occurrence_count: entry.count,
          distinct_document_count: entry.distinctDocumentCount,
          char_length: entry.charLength,
          safe_preview: entry.preview,
          first_chunk_id: entry.firstChunkId,
          first_source_document_id: entry.firstSourceDocumentId,
        }));

      return {
        total_chunks_seen: totalChunksSeen,
        unique_text_count: byHash.size,
        sum_of_occurrences: sumOfOccurrences,
        occurrences_match_total_chunks: sumOfOccurrences === totalChunksSeen,
        exact_duplicate_text_count: byHash.size === 0 ? 0 : [...byHash.values()].filter((entry) => entry.count > 1).length,
        within_document_duplicate_occurrences: withinDocumentDuplicateOccurrences,
        cross_document_duplicate_groups: crossDocumentDuplicateGroups,
        cross_document_duplicate_occurrences: crossDocumentDuplicateOccurrences,
        occurrence_count_distribution: {
          p50: percentile(occurrenceCounts, 50),
          p90: percentile(occurrenceCounts, 90),
          p99: percentile(occurrenceCounts, 99),
          max: occurrenceCounts.length ? occurrenceCounts[occurrenceCounts.length - 1] : 0,
          histogram: occurrenceHistogram.toJSON(),
        },
        top_repeated_text_by_occurrence: top,
        embedding_calls_avoidable: totalChunksSeen - byHash.size,
        unique_text_totals: {
          total_chars: uniqueTextTotalChars,
          total_utf8_bytes: uniqueTextTotalBytes,
          korean_aware_token_proxy_range: { total_low: uniqueTextTotalTokenProxyLow, total_high: uniqueTextTotalTokenProxyHigh },
        },
        note: "Previews are truncated to 40 characters and are not the full chunk text. Provenance (chunk_id/source_document_id/source_locator) is never dropped -- see provenance-preservation-report.v0.1.json for the reconstruction proof.",
      };
    },
  };
}
