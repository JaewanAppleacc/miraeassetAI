// Turn A4-A3-INTEGRATION-AND-DEVTUNE-V1: the integration pipeline.
//
// Pipeline (fixed, A4_A3_DEVTUNE_V1_AMENDMENT.md section 4):
//   BM25 top-100 + dense top-100 (one embedQuery call per question)
//   -> original-A-compatible top-20 (RRF over bm25-100 + dense's own
//      top-20 subset, cross-checked by buildWideCandidatePool's own
//      reproducibility guard)
//   -> buildWideCandidatePool() (<=200, unmodified)
//   -> hydration + chunk_text_sha256 verification
//   -> questionContext extraction (non-Gold)
//   -> rankCandidatePool() for each of R0..R5 (unmodified, full ranking)
//   -> detectEvidenceContradictions() per candidate (unmodified, cached
//      once per chunk_id per question, reused across all 6 configs)
//   -> selectWithStableRefill() per config
//   -> final top-20 per config, plus each config's pre-A3 "raw" top-20,
//      plus the same-run original-A-compatible top-20
//
// This module never reads a Gold field, a real failure-packet id, or any
// DEV_CHECK/HOLDOUT data -- there is no such input anywhere in its code
// path. It never removes a candidate itself: A3 removal is entirely
// selectWithStableRefill()'s job, driven by detectEvidenceContradictions()
// decisions this module only ROUTES, never reimplements.
import { createHash } from "node:crypto";
import { bm25Search } from "../retrieval/fixed-kure-bm25-index.mjs";
import { createPostgresVectorRetrievalRepository } from "../../postgres/reference-vector-retrieval-repository.mjs";
import { fetchEligibleChunkIds, passesMetadataFilters } from "../../retrieval/metadata-filter.mjs";
import { reciprocalRankFusion } from "../chunking-comparison/rrf.mjs";
import { classifySpans, buildProvenanceSet } from "./locator-provenance.mjs";
import { mapOfficialConditionToFilterInput } from "./four-arm-conditions-to-filter-mapper.mjs";
import { buildMetadataFiltersFromConditions } from "./conditions-fixture.mjs";
import { buildWideCandidatePool } from "./a4-wide-candidate-pool.mjs";
import { rankCandidatePool, selectWithStableRefill } from "./a4-reranker-engine.mjs";
import { detectEvidenceContradictions, CONTRADICTION_STATUS, normalizePeriodLabel } from "./a3-evidence-contradiction-guard.mjs";

export const BM25_CANDIDATE_K = 100;
export const DENSE_CANDIDATE_K = 100;
export const ORIGINAL_DENSE_CANDIDATE_K = 20;
export const RRF_CONSTANT = 60;

function sha256Hex(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// questionConditions extraction (non-Gold; A4_A3_DEVTUNE_V1_AMENDMENT.md §3).
// Duplicated marker lists (not exported by the guard) -- kept IDENTICAL to
// a3-evidence-contradiction-guard.mjs's own CONSOLIDATED_MARKERS/
// SEPARATE_MARKERS/unit tokens/revision markers.
// ---------------------------------------------------------------------------

const CONSOLIDATED_MARKERS = ["연결"];
const SEPARATE_MARKERS = ["별도", "개별"];

function extractScopeRequirement(text) {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC");
  const hasConsolidated = CONSOLIDATED_MARKERS.some((m) => t.includes(m));
  const hasSeparate = SEPARATE_MARKERS.some((m) => t.includes(m));
  if (hasConsolidated === hasSeparate) return null; // both or neither -> undetermined
  return hasConsolidated ? "CONSOLIDATED" : "SEPARATE";
}

function extractUnitRequirement(text) {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC");
  if (/%/.test(t)) return "PERCENT";
  if (/억\s*원/.test(t)) return "HUNDRED_MILLION_KRW";
  if (/백만\s*원/.test(t)) return "MILLION_KRW";
  if (/천\s*원/.test(t)) return "THOUSAND_KRW";
  if (/원/.test(t)) return "KRW";
  if (/주/.test(t)) return "SHARE";
  return null;
}

function extractRevisionRequirement(text) {
  if (typeof text !== "string") return null;
  const t = text.normalize("NFKC");
  const hasPre = /정정\s*전/.test(t);
  const hasPost = /정정\s*후/.test(t);
  if (hasPre === hasPost) return null;
  return hasPre ? "PRE_REVISION" : "POST_REVISION";
}

// questionText: the question's own sentence. mappedFilters: the already-
// resolved, non-Gold filter object (mapOfficialConditionToFilterInput's
// own output) -- corp_codes[0] becomes the entity requirement (compared by
// exact corp_code, not by normalized company-name string, for reliability).
// row_column is intentionally never populated this Turn (see amendment §3).
export function extractQuestionConditions(questionText, mappedFilters) {
  const conditions = {};
  const scope = extractScopeRequirement(questionText);
  if (scope) conditions.scope = scope;

  const period = normalizePeriodLabel(questionText);
  if (period) conditions.period = period;

  const unit = extractUnitRequirement(questionText);
  if (unit) conditions.unit = unit;

  const revision = extractRevisionRequirement(questionText);
  if (revision) conditions.revision = revision;

  const corpCode = Array.isArray(mappedFilters?.corp_codes) && mappedFilters.corp_codes.length === 1
    ? mappedFilters.corp_codes[0]
    : null;
  if (corpCode) conditions.entity = corpCode;

  return conditions;
}

// evidenceFacts extraction (non-Gold; amendment §3): full candidate chunk
// text passed straight into the guard's own *_hint parsers (reused
// unmodified inside detectEvidenceContradictions -- this function never
// re-implements period/unit/scope/revision PARSING itself, only routes the
// raw text and the candidate's own corp_code).
export function extractEvidenceFacts(candidate) {
  const text = typeof candidate.text === "string" ? candidate.text : null;
  return {
    scope_hint: text,
    period_hint: text,
    unit_hint: text,
    revision_hint: text,
    entity: candidate.metadata?.corp_code ?? null,
  };
}

// ---------------------------------------------------------------------------
// Candidate hydration into buildWideCandidatePool()'s CandidateRecord shape.
// ---------------------------------------------------------------------------

async function fetchChunksByIds(client, retrievalIndexId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_document_id, corp_code, source_locator, chunk_ordinal, text_content, text_sha256, metadata
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
    [retrievalIndexId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r]));
}

async function fetchStagingSpans(client, loadSessionId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_spans FROM disclosure_reference.reference_fixed_kure_chunk_staging
     WHERE load_session_id = $1 AND chunk_id = ANY($2::text[])`,
    [loadSessionId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r.source_spans]));
}

function toCandidateMetadata(row) {
  const m = row.metadata ?? {};
  return {
    corp_code: row.corp_code ?? null,
    doc_group: m.doc_group ?? null,
    doc_subtype: m.doc_subtype ?? null,
    base_year: m.base_year ?? null,
    base_month: m.base_month ?? null,
    receipt_date: m.receipt_date ?? null,
    is_correction: m.is_correction ?? null,
  };
}

// Hydrates one ranked {id, score} entry into a CandidateRecord. Verifies
// the row's own text_sha256 against a freshly computed sha256 of
// text_content -- a fail-closed defense against a corrupted/substituted
// row (section D.5's "실제 본문 hydration 및 SHA 검증").
function hydrateCandidateRecord(entry, rank, rowsById, spansById) {
  const row = rowsById.get(entry.id);
  if (!row) throw new Error(`hydrateCandidateRecord: no reference_retrieval_chunks row for chunk_id ${entry.id}`);
  const recomputedSha = sha256Hex(row.text_content ?? "");
  if (row.text_sha256 && row.text_sha256 !== recomputedSha) {
    throw new Error(`hydrateCandidateRecord: text_sha256 mismatch for chunk_id ${entry.id} (row=${row.text_sha256}, recomputed=${recomputedSha})`);
  }
  const spans = spansById.get(entry.id) ?? [];
  const resolution = classifySpans(spans);
  const provenanceSet = buildProvenanceSet(spans);
  return {
    chunk_id: entry.id,
    document_id: row.source_document_id,
    text: row.text_content,
    chunk_text_sha256: row.text_sha256 ?? recomputedSha,
    node_index: resolution.node_index,
    node_indices: provenanceSet.candidates.map((c) => c.node_index).filter((n) => n !== null && n !== undefined),
    locator: { source_locator: row.source_locator, status: resolution.status },
    provenance: { status: provenanceSet.status, candidates: provenanceSet.candidates },
    metadata: toCandidateMetadata(row),
    rank,
    score: entry.score,
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

// deps: { client, bm25Index, embeddingAdapter, retrievalIndexId,
//         provenanceLoadSessionId, expectedPins, nameToCorpCodeIndex }
// question: { question_id, question, conditions, segment }
// configs: the R0-R5 registry entries (unmodified).
//
// Returns { question_id, original_a_top20 (CandidateRecord[]),
// wide_pool_size, per_config: { [config_id]: { raw_top20, final_top20,
// a3_pass, a3_reject, a3_keep_unknown, stable_refill_count,
// final_shortfall } } }.
export async function runQuestionPipeline(deps, question, configs) {
  const {
    client, bm25Index, embeddingAdapter, retrievalIndexId, provenanceLoadSessionId, expectedPins, nameToCorpCodeIndex,
  } = deps;

  const mapped = mapOfficialConditionToFilterInput(question.conditions, nameToCorpCodeIndex);
  const filters = buildMetadataFiltersFromConditions(mapped.filters);

  const eligibleIds = await fetchEligibleChunkIds(client, retrievalIndexId, filters);
  const bm25Ranked = bm25Search(bm25Index, question.question, { topK: BM25_CANDIDATE_K, eligibleIds });

  const queryVector = await embeddingAdapter.embedQuery(question.question); // the ONE embed call for this question
  const denseRows = await createPostgresVectorRetrievalRepository({ client }).searchDocumentChunksByVector(
    { retrievalIndexId, queryVector, topK: DENSE_CANDIDATE_K, filters, expectedPins },
  );
  const denseRanked = denseRows.map((r) => ({ id: r.chunk_id, score: r.similarity_score }));

  const bm25ChunkIds = bm25Ranked.map((r) => r.id);
  const bm25RowsById = await fetchChunksByIds(client, retrievalIndexId, bm25ChunkIds);
  const bm25RankedFiltered = bm25Ranked
    .filter((r) => { const row = bm25RowsById.get(r.id); return row !== undefined && passesMetadataFilters(row, filters); })
    .map((r) => ({ id: r.id, score: r.score }));

  const denseRowsById = new Map(denseRows.map((r) => [r.chunk_id, r]));
  const allIds = [...new Set([...bm25RankedFiltered.map((r) => r.id), ...denseRanked.map((r) => r.id)])];
  const rowsById = new Map([...bm25RowsById, ...denseRowsById]);
  const spansById = await fetchStagingSpans(client, provenanceLoadSessionId, allIds);

  const bm25Records = bm25RankedFiltered.map((r, i) => hydrateCandidateRecord(r, i + 1, rowsById, spansById));
  const denseRecords = denseRanked.map((r, i) => hydrateCandidateRecord(r, i + 1, rowsById, spansById));

  // Original-A-compatible top-20: RRF(k=60) over bm25 (full) + dense's own
  // rank<=20 subset -- the SAME formula A's own official retrieval uses,
  // reproduced here so buildWideCandidatePool() can independently verify it
  // (fail-closed) and so it can be scored as the same-run A baseline.
  const denseTop20Subset = denseRecords.filter((r) => r.rank <= ORIGINAL_DENSE_CANDIDATE_K);
  const fusedOriginalA = reciprocalRankFusion(
    [bm25Records.map((r) => ({ id: r.chunk_id, score: r.score })), denseTop20Subset.map((r) => ({ id: r.chunk_id, score: r.score }))],
    { k: RRF_CONSTANT, topK: ORIGINAL_DENSE_CANDIDATE_K },
  );
  const byChunkId = new Map([...bm25Records, ...denseRecords].map((r) => [r.chunk_id, r]));
  const originalATop20 = fusedOriginalA.map((entry, index) => ({ ...byChunkId.get(entry.id), rank: index + 1 }));

  const { pool } = buildWideCandidatePool({
    original_a_top20: originalATop20,
    bm25_top100: bm25Records,
    dense_top100: denseRecords,
  });

  const questionContext = {
    question_id: question.question_id,
    question_text: question.question,
    required_metric_labels: Array.isArray(question.conditions?.candidate_terms) ? question.conditions.candidate_terms : null,
    expected_corp_codes: mapped.filters?.corp_codes ?? null,
    expected_doc_groups: mapped.filters?.doc_groups ?? null,
    expected_base_years: mapped.filters?.base_years ?? null,
    expected_base_months: mapped.filters?.base_months ?? null,
  };
  const requiredConditions = extractQuestionConditions(question.question, mapped.filters);

  // A3 decisions computed ONCE per chunk_id, reused across all 6 configs.
  const decisionByChunkId = new Map();
  for (const candidate of pool) {
    const evidenceFacts = extractEvidenceFacts(candidate);
    const result = detectEvidenceContradictions({ questionConditions: requiredConditions, evidenceFacts });
    decisionByChunkId.set(candidate.chunk_id, result.status === CONTRADICTION_STATUS.REJECT ? "REJECT"
      : result.status === CONTRADICTION_STATUS.KEEP_UNKNOWN ? "KEEP_UNKNOWN" : "PASS");
  }

  const perConfig = {};
  for (const config of configs) {
    const full = rankCandidatePool(pool, questionContext, config);
    const rawTop20 = full.slice(0, 20);
    const decisions = Object.fromEntries(full.map((c) => [c.chunk_id, decisionByChunkId.get(c.chunk_id)]));
    const finalTop20 = selectWithStableRefill(full, decisions, { outputK: 20 });
    const counts = { PASS: 0, REJECT: 0, KEEP_UNKNOWN: 0 };
    for (const c of full) counts[decisionByChunkId.get(c.chunk_id)] += 1;
    const rejectedInTop20 = rawTop20.filter((c) => decisionByChunkId.get(c.chunk_id) === "REJECT").length;
    perConfig[config.config_id] = {
      raw_top20: rawTop20,
      final_top20: finalTop20,
      a3_pass: counts.PASS,
      a3_reject: counts.REJECT,
      a3_keep_unknown: counts.KEEP_UNKNOWN,
      stable_refill_count: rejectedInTop20,
      final_shortfall: finalTop20.length < 20,
    };
  }

  return {
    question_id: question.question_id,
    original_a_top20: originalATop20,
    wide_pool_size: pool.length,
    per_config: perConfig,
  };
}
