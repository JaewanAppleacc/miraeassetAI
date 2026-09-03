import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";

// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, sections F/G: the SINGLE shared
// metadata-filter implementation for both official candidate arms (A and
// C). Before this Turn, arm A's BM25 leg (fixed-kure-hybrid-retriever-
// adapter.mjs's private passesFilters) and arm C
// (arm-retriever-adapter.mjs's own passesMetadataFilters) were two
// SEPARATE, DIVERGING functions -- a code comment on the latter claimed
// they were "the same predicate", but passesMetadataFilters additionally
// checked doc_subtypes/retrieval_eligible while passesFilters did not, and
// NEITHER checked base_years/base_months/receipt_date_from/
// receipt_date_to/is_correction at all. Every ALLOWED metadata_filters
// field (conditions-fixture.mjs's own METADATA_FILTER_KEYS) is implemented
// here, once, and both arms import it -- no separate copy exists anywhere
// else in the four-arm-ac module.
//
// Two entry points, both operating on the SAME field set:
//   - passesMetadataFilters(row, filters): row-level predicate (a defense-
//     in-depth double-check after DB-level prefiltering, and the only
//     mechanism available for in-process candidates like BM25-scored rows
//     hydrated from `reference_retrieval_chunks`).
//   - buildEligibilityWhereClause(filters, paramOffset): builds the SAME
//     logical predicate as a parameterized SQL WHERE fragment (JSONB path
//     expressions for fields stored inside `metadata`, plain columns for
//     corp_code/source_document_id), for fetchEligibleChunkIds's own
//     prefilter query AND for the dense leg's SQL (both call this ONE
//     builder, so a filter field can never behave differently between the
//     two legs).
//
// vFINAL section G's own requirement is enforced at the CALL SITE, not
// here: the filter must be applied to the candidate pool BEFORE BM25/dense
// ranking, not as a post-hoc prune of an already-ranked top-K. This module
// only supplies the predicate/WHERE-fragment; fetchEligibleChunkIds below
// is what actually restricts the pool before scoring.

function asNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

// row: a hydrated chunk row carrying top-level corp_code/source_document_id
// (as reference_retrieval_chunks always does) and a `metadata` object with
// doc_group/doc_subtype/base_year/base_month/receipt_date/is_correction/
// retrieval_eligible (as chunker.mjs's own chunkMetadata() always
// populates -- see domain/chunking/chunker.mjs).
export function passesMetadataFilters(row, filters) {
  const metadata = row?.metadata ?? {};
  const corpCodes = asNonEmptyArray(filters?.corp_codes);
  if (corpCodes && !corpCodes.includes(row.corp_code)) return false;

  const documentIds = asNonEmptyArray(filters?.document_ids);
  if (documentIds && !documentIds.includes(row.source_document_id)) return false;

  const docGroups = asNonEmptyArray(filters?.doc_groups);
  if (docGroups && !docGroups.includes(metadata.doc_group)) return false;

  const docSubtypes = asNonEmptyArray(filters?.doc_subtypes);
  if (docSubtypes && !docSubtypes.includes(metadata.doc_subtype)) return false;

  const baseYears = asNonEmptyArray(filters?.base_years);
  if (baseYears && !baseYears.includes(metadata.base_year)) return false;

  const baseMonths = asNonEmptyArray(filters?.base_months);
  if (baseMonths && !baseMonths.includes(metadata.base_month)) return false;

  if (filters?.receipt_date_from && (!metadata.receipt_date || metadata.receipt_date < filters.receipt_date_from)) return false;
  if (filters?.receipt_date_to && (!metadata.receipt_date || metadata.receipt_date > filters.receipt_date_to)) return false;

  if (filters?.is_correction !== null && filters?.is_correction !== undefined
    && metadata.is_correction !== filters.is_correction) return false;

  if (filters?.retrieval_eligible === true && metadata.retrieval_eligible === false) return false;

  return true;
}

// Builds ["cond1 = $n", "cond2 = ANY($m)", ...] plus the params array they
// reference, starting at 1-based index `paramStartIndex` (the caller's
// next free placeholder). `columnPrefix` (default "", e.g. "c." for a
// JOINed query) is prepended to every column reference so this builder is
// safe to use against a query with multiple table aliases. Returns
// { conditions, params, nextParamIndex } -- the caller splices `conditions`
// into its own WHERE clause (joined with " AND ") and appends `params` to
// its own params array, in that order.
export function buildEligibilityWhereClause(filters, paramStartIndex, columnPrefix = "") {
  const conditions = [];
  const params = [];
  let next = paramStartIndex;
  const col = (name) => `${columnPrefix}${name}`;

  const corpCodes = asNonEmptyArray(filters?.corp_codes);
  if (corpCodes) { params.push(corpCodes); conditions.push(`${col("corp_code")} = ANY($${next})`); next += 1; }

  const documentIds = asNonEmptyArray(filters?.document_ids);
  if (documentIds) { params.push(documentIds); conditions.push(`${col("source_document_id")} = ANY($${next})`); next += 1; }

  const docGroups = asNonEmptyArray(filters?.doc_groups);
  if (docGroups) { params.push(docGroups); conditions.push(`${col("metadata")}->>'doc_group' = ANY($${next})`); next += 1; }

  const docSubtypes = asNonEmptyArray(filters?.doc_subtypes);
  if (docSubtypes) { params.push(docSubtypes); conditions.push(`${col("metadata")}->>'doc_subtype' = ANY($${next})`); next += 1; }

  const baseYears = asNonEmptyArray(filters?.base_years);
  if (baseYears) { params.push(baseYears); conditions.push(`(${col("metadata")}->>'base_year')::int = ANY($${next})`); next += 1; }

  const baseMonths = asNonEmptyArray(filters?.base_months);
  if (baseMonths) { params.push(baseMonths); conditions.push(`(${col("metadata")}->>'base_month')::int = ANY($${next})`); next += 1; }

  if (filters?.receipt_date_from) { params.push(filters.receipt_date_from); conditions.push(`${col("metadata")}->>'receipt_date' >= $${next}`); next += 1; }
  if (filters?.receipt_date_to) { params.push(filters.receipt_date_to); conditions.push(`${col("metadata")}->>'receipt_date' <= $${next}`); next += 1; }

  if (filters?.is_correction !== null && filters?.is_correction !== undefined) {
    params.push(filters.is_correction); conditions.push(`(${col("metadata")}->>'is_correction')::boolean = $${next}`); next += 1;
  }

  if (filters?.retrieval_eligible === true) {
    conditions.push(`(${col("metadata")}->>'retrieval_eligible')::boolean IS DISTINCT FROM false`);
  }

  return { conditions, params, nextParamIndex: next };
}

// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY section G: the true PREFILTER --
// returns the Set of chunk_ids that pass `filters`, queried directly
// against reference_retrieval_chunks BEFORE any BM25/dense ranking touches
// them, so the candidate pool ranking runs over is already
// filter-compliant (never a post-hoc prune of an already-ranked top-K).
export async function fetchEligibleChunkIds(client, retrievalIndexId, filters, { signal } = {}) {
  if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
  const { conditions, params } = buildEligibilityWhereClause(filters, 2);
  const whereClause = ["retrieval_index_id = $1", ...conditions].join(" AND ");
  const result = await client.query(
    `SELECT chunk_id FROM disclosure_reference.reference_retrieval_chunks WHERE ${whereClause}`,
    [retrievalIndexId, ...params],
  );
  return new Set(result.rows.map((r) => r.chunk_id));
}
