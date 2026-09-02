// Turn P10: controlled 3-way chunking comparison manifest. Pins every
// non-chunking variable so only the chunking strategy differs across runs.
//
// The fixed-token and section-aware-flat strategy configs are reused
// VERBATIM from domain/chunking/strategy-configs.v0.1.json (the shared,
// tested, frozen artifact -- never hand-edited here). The hierarchical
// strategy's PARENT token budget in this Turn's brief (1,536) differs from
// that file's existing PRIMARY entry (1,024, "doctype-hier-parent-child-
// table-dual.v0.2.0"). Rather than editing that shared, already-tested
// artifact (CLAUDE.md: never overwrite another worker's artifact; a
// parameter-experiment needs its own experiment_id, not a silent edit of
// the frozen config), this manifest defines a SEPARATE, P10-scoped config
// variant with a bumped chunking_config_id. domain/chunking/chunker.mjs
// itself is untouched -- it already accepts any config object generically.
import configs from "../../chunking/strategy-configs.v0.1.json" with { type: "json" };

export const P10_EXPERIMENT_ID = "p10-chunking-comparison-v01";

const FIXED_512_OVERLAP = configs.strategies.find((s) => s.chunking_config_id === "fixed-token-512-o64.v0.1.0");
const SECTION_AWARE_FLAT = configs.strategies.find((s) => s.chunking_config_id === "section-aware-flat-512-o64.v0.1.0");
const BASE_HIERARCHICAL = configs.strategies.find((s) => s.role === "PRIMARY");

if (!FIXED_512_OVERLAP || !SECTION_AWARE_FLAT || !BASE_HIERARCHICAL) {
  throw new Error("p10-manifest.mjs: expected strategy-configs.v0.1.json to contain fixed-token-512-o64.v0.1.0, section-aware-flat-512-o64.v0.1.0, and a PRIMARY hierarchical entry");
}

// P10-scoped variant: identical to the frozen PRIMARY config except
// parent_max_tokens (1024 -> 1536, per this Turn's explicit brief).
// chunking_config_id is bumped so it can never collide with, or be
// silently confused for, the frozen artifact's own ID in any report,
// index snapshot, or manifest hash.
export const DOCUMENT_TYPE_HIERARCHICAL_PARENT_CHILD_TABLE_DUAL_P10 = Object.freeze({
  ...BASE_HIERARCHICAL,
  chunking_config_id: "doctype-hier-parent-child-table-dual.v0.2.0-p10-parent1536",
  strategy_version: "0.2.0-p10",
  parent_max_tokens: 1536,
  experiment_id: P10_EXPERIMENT_ID,
  parameter_change_note: "parent_max_tokens overridden from the frozen doctype-hier-parent-child-table-dual.v0.2.0 baseline (1024) to 1536 per Turn P10 brief section C3. All other hierarchical parameters (child_max_tokens=384, child_overlap_tokens=48, table_row_child_max_tokens=256, table_row_child_max_rows=8) are unchanged.",
});

export const P10_STRATEGIES = Object.freeze([
  Object.freeze({ ...FIXED_512_OVERLAP, experiment_id: P10_EXPERIMENT_ID }),
  Object.freeze({ ...SECTION_AWARE_FLAT, experiment_id: P10_EXPERIMENT_ID }),
  DOCUMENT_TYPE_HIERARCHICAL_PARENT_CHILD_TABLE_DUAL_P10,
]);

export const P10_EMBEDDING_CANDIDATE = Object.freeze({
  frozen_candidate_id: "bge_m3",
  repository_id: "BAAI/bge-m3",
  immutable_revision: "5617a9f61b028005a4858fdac845db406aefb181",
  embedding_dimension: 1024,
  selection_basis: "processing speed was fastest among the 3 pinned frozen candidates in prior calibration; used ONLY as a fixed comparator for this Turn's chunking comparison, never recorded as the final embedding model selection.",
  final_embedding_model_selected: false,
});

export const P10_COMPARISON_CONDITIONS = Object.freeze({
  top_k_values: Object.freeze([1, 5, 10, 20]),
  distance_metric: "cosine",
  tie_break: "lower chunk_id (lexicographic) wins on an exact score tie -- applied identically across all 3 strategies and both BM25/Dense/RRF legs",
  exact_text_dedup_policy: "content_sha256 equality on raw_text; duplicate_group_id links every occurrence, no occurrence's source_spans/provenance is dropped",
  query_prefix: "",
  document_prefix: "",
  cache_retry_timeout: "single-attempt, no retry, per-request timeout enforced by the local embedding server client (see scripts/p10-bounded-retrieval-smoke.mjs)",
});

export function provenanceForBuild({ targetCorpusSnapshotId, parserCodeRevision, parserConfigHash }) {
  return Object.freeze({ targetCorpusSnapshotId, parserCodeRevision, parserConfigHash });
}
