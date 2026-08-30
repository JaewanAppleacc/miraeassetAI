// Turn P5.1: deterministic BOILERPLATE_CANDIDATE classification.
//
// This module NEVER deletes or excludes anything -- it only labels a
// candidate status plus reason codes. A chunk flagged as
// `protectedFromBoilerplate` (see contracts.mjs's isProtectedFromBoilerplate
// -- contains a date-like or amount-like pattern) is NEVER classified as a
// boilerplate candidate, no matter how many documents its exact text
// appears in. Frequency alone is never sufficient to override that
// protection -- this is the literal safety requirement from the Turn P5.1
// task brief ("회사·금액·날짜가 포함된 chunk를 단순 빈도만으로 제외하지 않음").
//
// Operates on ONE unique-text entry (from duplicate-analysis.mjs) at a
// time -- every occurrence of the same exact text shares the same
// classification, computed once, not once per chunk.
export const BOILERPLATE_CANDIDATE = "BOILERPLATE_CANDIDATE";
export const NOT_CANDIDATE = "NOT_CANDIDATE";

export const DEFAULT_THRESHOLDS = Object.freeze({
  // "High document frequency" = appears in at least this fraction of all
  // documents, floored at a small absolute minimum so a tiny corpus doesn't
  // make everything look "frequent."
  highDocFrequencyMinDocsAbsolute: 20,
  highDocFrequencyFraction: 0.01,
  shortTitleMaxChars: 15,
});

export function computeHighDocFrequencyThreshold(totalDocuments, thresholds = DEFAULT_THRESHOLDS) {
  return Math.max(thresholds.highDocFrequencyMinDocsAbsolute, Math.ceil(totalDocuments * thresholds.highDocFrequencyFraction));
}

// entry: one value from duplicate-analysis.mjs's internal Map (count,
// distinctDocumentCount, charLength, blockType, tableRowRange, preview,
// protectedFromBoilerplate, isNumberOnly, isSymbolOnly, isPageNumberLike).
// Iterates the duplicate-analysis accumulator's UNIQUE hashes once (not
// once per chunk) and classifies each. Returns both the summary report and
// the raw per-hash classification counts strategy-comparison.mjs needs to
// size Strategy D (PRIMARY_PLUS_COLD_FALLBACK).
export function buildBoilerplateCandidateAnalysis(duplicateAccumulator, { totalDocuments, thresholds = DEFAULT_THRESHOLDS, topN = 50 }) {
  let candidateUniqueCount = 0;
  let candidateOccurrenceCount = 0;
  let protectedDespiteHighFrequencyCount = 0;
  const reasonCodeCounts = {};
  const highDocFrequencyThreshold = computeHighDocFrequencyThreshold(totalDocuments, thresholds);
  const candidates = [];

  for (const [hash, entry] of duplicateAccumulator.entries()) {
    const classification = classifyBoilerplateCandidate(entry, { totalDocuments, thresholds });
    if (entry.protectedFromBoilerplate && entry.distinctDocumentCount >= highDocFrequencyThreshold) {
      protectedDespiteHighFrequencyCount += 1;
    }
    if (classification.status === BOILERPLATE_CANDIDATE) {
      candidateUniqueCount += 1;
      candidateOccurrenceCount += entry.count;
      for (const code of classification.reason_codes) reasonCodeCounts[code] = (reasonCodeCounts[code] ?? 0) + 1;
      candidates.push({ text_sha256: hash, occurrence_count: entry.count, distinct_document_count: entry.distinctDocumentCount, reason_codes: classification.reason_codes, safe_preview: entry.preview });
    }
  }
  candidates.sort((a, b) => b.occurrence_count - a.occurrence_count);

  return {
    high_doc_frequency_threshold_documents: highDocFrequencyThreshold,
    thresholds,
    unique_text_count: duplicateAccumulator.size,
    boilerplate_candidate_unique_text_count: candidateUniqueCount,
    boilerplate_candidate_occurrence_count: candidateOccurrenceCount,
    protected_despite_high_frequency_count: protectedDespiteHighFrequencyCount,
    reason_code_counts: reasonCodeCounts,
    top_candidates_by_occurrence: candidates.slice(0, topN),
    note: "status is BOILERPLATE_CANDIDATE only -- nothing is deleted or excluded by this analysis. A chunk containing a date-like or amount-like pattern is never classified as a candidate regardless of frequency (see protected_despite_high_frequency_count for how often that protection actually mattered).",
  };
}

export function classifyBoilerplateCandidate(entry, { totalDocuments, thresholds = DEFAULT_THRESHOLDS }) {
  if (entry.protectedFromBoilerplate) {
    return { status: NOT_CANDIDATE, reason_codes: [], protected_reason: "CONTAINS_DATE_OR_AMOUNT_LIKE_PATTERN" };
  }

  const highDocFrequencyThreshold = computeHighDocFrequencyThreshold(totalDocuments, thresholds);
  const reasonCodes = [];

  if (entry.distinctDocumentCount >= highDocFrequencyThreshold) {
    reasonCodes.push("BOILERPLATE_HIGH_DOC_FREQUENCY");
  }
  if (entry.isPageNumberLike) {
    reasonCodes.push("BOILERPLATE_PAGE_NUMBER_PATTERN");
  }
  if ((entry.blockType === "TITLE") && entry.charLength <= thresholds.shortTitleMaxChars && entry.distinctDocumentCount >= highDocFrequencyThreshold) {
    reasonCodes.push("BOILERPLATE_SHORT_TITLE");
  }
  if (entry.blockType === "TABLE" && entry.isSymbolOnly) {
    reasonCodes.push("BOILERPLATE_EMPTY_TABLE_PLACEHOLDER");
  }
  if (entry.isNumberOnly || entry.isSymbolOnly) {
    reasonCodes.push("BOILERPLATE_SYMBOL_OR_NUMBER_ONLY");
  }

  if (reasonCodes.length === 0) return { status: NOT_CANDIDATE, reason_codes: [], protected_reason: null };
  return { status: BOILERPLATE_CANDIDATE, reason_codes: reasonCodes, protected_reason: null };
}
