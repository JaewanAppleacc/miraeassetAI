// Turn P5.1: bounded-memory, single-pass length/shape accumulator. Feed it
// one chunk record at a time (from a streaming read of
// document-chunks.v0.1.jsonl); its memory footprint never grows with the
// number of chunks seen -- only with the number of DISTINCT block_types/
// source_groups/documents, all small, fixed-size sets for this corpus.
import {
  utf8ByteLength,
  whitespaceTokenProxy,
  tokenProxyRange,
  isNumberOnly,
  isSymbolOnly,
  isPageNumberLike,
  newHistogram,
  percentile,
} from "./contracts.mjs";

const EXTREMELY_SHORT_CHAR_THRESHOLD = 5;

export function createLengthAnalysisAccumulator({ tableMaxChunkChars }) {
  let totalChunks = 0;
  let totalChars = 0;
  let totalBytes = 0;
  let totalWhitespaceTokens = 0;
  let totalTokenProxyLow = 0;
  let totalTokenProxyHigh = 0;
  let maxChars = 0;
  let extremelyShortCount = 0;
  let oversizedTableRowChunkCount = 0;
  let titleOnlyCount = 0;
  let numberOnlyCount = 0;
  let symbolOnlyCount = 0;
  let pageNumberLikeCount = 0;

  const blockTypeCounts = {};
  const sourceGroupCounts = {};
  const chunksPerDocument = new Map(); // document_id -> count (bounded by document count)
  const charLengthHistogram = newHistogram([50, 100, 300, 600, 900, 1200, 1600, 2400]);
  const byteLengthHistogram = newHistogram([50, 100, 300, 600, 900, 1200, 1600, 2400]);

  return {
    add(chunk) {
      const text = chunk.text_content;
      const charLen = text.length;
      const byteLen = utf8ByteLength(text);
      const wsTokens = whitespaceTokenProxy(text);
      const tokenRange = tokenProxyRange(charLen);

      totalChunks += 1;
      totalChars += charLen;
      totalBytes += byteLen;
      totalWhitespaceTokens += wsTokens;
      totalTokenProxyLow += tokenRange.low;
      totalTokenProxyHigh += tokenRange.high;
      maxChars = Math.max(maxChars, charLen);
      charLengthHistogram.add(charLen);
      byteLengthHistogram.add(byteLen);

      if (charLen < EXTREMELY_SHORT_CHAR_THRESHOLD) extremelyShortCount += 1;
      const rowRange = chunk.metadata?.table_row_range;
      if (Array.isArray(rowRange) && rowRange[0] === rowRange[1] && charLen > tableMaxChunkChars) {
        oversizedTableRowChunkCount += 1;
      }
      if (chunk.metadata?.block_type === "TITLE") titleOnlyCount += 1;
      if (isNumberOnly(text)) numberOnlyCount += 1;
      if (isSymbolOnly(text)) symbolOnlyCount += 1;
      if (isPageNumberLike(text)) pageNumberLikeCount += 1;

      const blockType = chunk.metadata?.block_type ?? "UNKNOWN";
      blockTypeCounts[blockType] = (blockTypeCounts[blockType] ?? 0) + 1;
      sourceGroupCounts[chunk.source_group] = (sourceGroupCounts[chunk.source_group] ?? 0) + 1;
      chunksPerDocument.set(chunk.source_document_id, (chunksPerDocument.get(chunk.source_document_id) ?? 0) + 1);
    },
    toJSON() {
      const perDocumentCounts = [...chunksPerDocument.values()].sort((a, b) => a - b);
      return {
        total_chunks: totalChunks,
        char_length: {
          total_chars: totalChars,
          mean_chars: totalChunks === 0 ? 0 : Math.round(totalChars / totalChunks),
          max_chars: maxChars,
          histogram: charLengthHistogram.toJSON(),
        },
        utf8_byte_length: {
          total_bytes: totalBytes,
          mean_bytes: totalChunks === 0 ? 0 : Math.round(totalBytes / totalChunks),
          histogram: byteLengthHistogram.toJSON(),
        },
        whitespace_token_proxy: {
          total: totalWhitespaceTokens,
          mean: totalChunks === 0 ? 0 : Math.round(totalWhitespaceTokens / totalChunks),
          note: "A whitespace-delimited word count -- NOT a real tokenizer output.",
        },
        korean_aware_token_proxy_range: {
          total_low: totalTokenProxyLow,
          total_high: totalTokenProxyHigh,
          mean_low: totalChunks === 0 ? 0 : Math.round(totalTokenProxyLow / totalChunks),
          mean_high: totalChunks === 0 ? 0 : Math.round(totalTokenProxyHigh / totalChunks),
          note: "A heuristic char-count-derived range only. No real tokenizer was run. See contracts.mjs's TOKEN_PROXY_*_CHARS_PER_TOKEN constants for the exact assumption.",
        },
        block_type_counts: blockTypeCounts,
        source_group_counts: sourceGroupCounts,
        chunks_per_document: {
          documents_represented: chunksPerDocument.size,
          p50: percentile(perDocumentCounts, 50),
          p90: percentile(perDocumentCounts, 90),
          p99: percentile(perDocumentCounts, 99),
          max: perDocumentCounts.length ? perDocumentCounts[perDocumentCounts.length - 1] : 0,
        },
        extreme_shape_candidates: {
          extremely_short_chunk_count: extremelyShortCount,
          extremely_short_char_threshold: EXTREMELY_SHORT_CHAR_THRESHOLD,
          oversized_table_row_chunk_count: oversizedTableRowChunkCount,
          oversized_table_row_threshold_chars: tableMaxChunkChars,
          title_only_chunk_count: titleOnlyCount,
          number_only_chunk_count: numberOnlyCount,
          symbol_only_chunk_count: symbolOnlyCount,
          page_number_like_chunk_count: pageNumberLikeCount,
        },
      };
    },
  };
}
