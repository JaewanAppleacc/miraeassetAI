// Turn P10.4 / Stage 1: Adaptive Table Chunking policy contract. Fixed
// version + invariants, checked by tests rather than left as prose.
export const ADAPTIVE_POLICY_ID = "adaptive-fixed512-table-aware-v0.1.0";
export const ADAPTIVE_POLICY_VERSION = "0.1.0";
// The base Fixed strategy this policy reuses BYTE-EQUIVALENTLY for
// PARAGRAPH/TITLE and non-table content -- must match P10_STRATEGIES'
// pinned chunking_config_id exactly, never a re-derived value.
export const BASE_FIXED_CONFIG_ID = "fixed-token-512-o64.v0.1.0";

export const ADAPTIVE_CHUNK_TYPE = Object.freeze({
  FIXED_WINDOW: "FIXED_WINDOW", // unchanged pass-through from chunkFixed()
  TABLE_ROW_WITH_HEADERS: "TABLE_ROW_WITH_HEADERS",
  TABLE_ROW_SEGMENT_WITH_HEADERS: "TABLE_ROW_SEGMENT_WITH_HEADERS",
  MULTI_ROW_CONTEXT: "MULTI_ROW_CONTEXT",
  TABLE_PARENT_CONTEXT: "TABLE_PARENT_CONTEXT",
});

export const CONTEXT_STATE = Object.freeze({
  EXPLICIT_IN_SOURCE: "EXPLICIT_IN_SOURCE",
  INHERITED_FROM_TABLE_CONTEXT: "INHERITED_FROM_TABLE_CONTEXT",
  ABSENT_IN_SOURCE: "ABSENT_IN_SOURCE",
  PARSE_RECOVERY_REQUIRED: "PARSE_RECOVERY_REQUIRED",
});

// Table-row packing budget for TABLE_ROW_WITH_HEADERS/TABLE_ROW_SEGMENT_
// WITH_HEADERS. Deliberately set equal to Fixed's own max_tokens (512),
// not an arbitrary smaller sub-budget -- a real full-corpus measurement
// (Turn P10.4 Stage 5) found an initial 256-token budget produced 3.13x
// Fixed's unique search-eligible text count; raising to 512 (matching
// Fixed's own window budget, the principled choice rather than a smaller
// number chosen by feel) reduced this to 2.07x by roughly halving the
// number of packed chunks needed for the same table content. Still above
// the <=1.5x Stage 8 gate -- the residual gap is per-table fragmentation
// (each table is packed independently, never mixed with other tables or
// surrounding paragraph text the way Fixed's single continuous stream
// does) plus repeated header-line overhead per chunk, neither of which a
// larger token budget alone fully resolves. Documented as a known
// limitation rather than tuned further under time pressure.
export const TABLE_ROW_CHILD_MAX_TOKENS = 512;

// Late-parent-expansion budget. Centralized here, never hardcoded inline
// at call sites -- Stage 3's expansion code reads these fields, never a
// literal number.
export const PARENT_EXPANSION_POLICY = Object.freeze({
  policy_id: "adaptive-parent-expansion-v0.1.0",
  parent_context_max_tokens: 1024,
  expansion_per_child: 1, // at most 1 TABLE_PARENT_CONTEXT attached per selected child
  total_expansion_context_budget_tokens: 8192, // hard cap across an entire Top-K result set
});

// Mandatory invariants (Stage 1) -- referenced by tests, not just prose.
export const ADAPTIVE_INVARIANTS = Object.freeze([
  "NO_INFERRED_HEADER_OR_UNIT_NOT_IN_SOURCE",
  "NO_WHOLE_TABLE_AS_ONE_SEARCH_CHUNK",
  "NO_FORCED_SIBLING_INSERTION_IN_TOP_K",
  "NO_UNCONDITIONAL_DOCUMENT_CAP",
  "NO_EVIDENCE_SPAN_ONLY_ROW_COLUMN_ESTIMATION",
  "NO_GOLD_QUESTION_OR_ANSWER_DRIVEN_CHUNKING",
  "NO_TABLE_CONTENT_SUMMARIZATION_OR_REWRITE",
  "NO_FABRICATED_UNIT_OR_PERIOD",
  "PARENT_CONTEXT_NEVER_RE_RANKED",
  "PARENT_CONTEXT_NEVER_OCCUPIES_A_TOP_K_SLOT",
]);
