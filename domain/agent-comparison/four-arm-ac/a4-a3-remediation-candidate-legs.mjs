// Turn A4-A3-REMEDIATION-INTEGRATION-V1: per-leg (BM25, dense) candidate generation under
// an opt-in retrieval policy (four-arm-retrieval-policy.mjs, vendored verbatim from
// b30b909 -- pure, arm-agnostic functions, never modified here).
//
// a4-a3-retrieval-pipeline.mjs's own runQuestionPipeline() generates each leg with a
// SINGLE filter pass (one fetchEligibleChunkIds/bm25Search call, one
// searchDocumentChunksByVector call). This module generalizes that into a MULTI-PASS
// generator per leg -- one pass per (date window x subtype relaxation) combination,
// merged round-robin, capped at the SAME existing leg constants the frozen pipeline
// already uses (BM25_CANDIDATE_K=100, DENSE_CANDIDATE_K=100 -- read from
// a4-a3-retrieval-pipeline.mjs/a4-wide-candidate-pool.mjs, never re-declared or
// b30b909's own fusion_pool_k=40).
//
// The multi-pass merge/promotion/interleave ORCHESTRATION below (record/admit/
// mergeWindowsRoundRobin) is a new, small reimplementation of the same pattern
// arm-retriever-adapter.mjs's searchWithPolicy() uses for plain Arm A/C (b30b909,
// read-only reference, never imported or modified) -- reimplemented rather than
// imported because A4/A3 needs it per LEG (BM25-only, dense-only, before RRF/wide-pool
// fusion), which is a structurally different point in the pipeline than where plain Arm
// A/C apply it (after a already-fused per-pass search). Every actual POLICY DECISION
// function (buildRetrievalPlan, buildFilterPasses, rankCandidates, promoteRelaxed,
// orderCandidates, interleaveRelaxed) is imported and used unmodified from
// four-arm-retrieval-policy.mjs -- this file only adds the leg-shaped plumbing around them.
//
// fetchChunksByIds/fetchStagingSpans/toCandidateMetadata/hydrateCandidateRecord below are
// duplicated from a4-a3-retrieval-pipeline.mjs (private, unexported there) rather than
// imported, so that file needs ZERO modification (verified: none of the four are
// currently exported).
import { createHash } from "node:crypto";
import { bm25Search } from "../retrieval/fixed-kure-bm25-index.mjs";
import { createPostgresVectorRetrievalRepository } from "../../postgres/reference-vector-retrieval-repository.mjs";
import { fetchEligibleChunkIds, passesMetadataFilters } from "../../retrieval/metadata-filter.mjs";
import { classifySpans, buildProvenanceSet } from "./locator-provenance.mjs";
import { buildMetadataFiltersFromConditions } from "./conditions-fixture.mjs";
import {
  resolvePolicy, FROZEN_POLICY, buildRetrievalPlan, buildFilterPasses, rankCandidates,
} from "./four-arm-retrieval-policy.mjs";

export const BM25_CANDIDATE_K = 100;   // == a4-a3-retrieval-pipeline.mjs's own BM25_CANDIDATE_K
export const DENSE_CANDIDATE_K = 100;  // == a4-wide-candidate-pool.mjs's own WIDE_DENSE_CANDIDATE_K

function sha256Hex(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

// ---- duplicated from a4-a3-retrieval-pipeline.mjs (unexported there) ----------------

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

// ---- correction: ONLY_WHEN_ASKED --------------------------------------------------

// mapped.filters.is_correction is `conditions.correction` verbatim (AS_EXTRACTED, the
// frozen mapping) -- true / false / null. ONLY_WHEN_ASKED means: filter FOR correction
// filings only when the question explicitly asked about correction (true); a false or
// absent flag must NOT exclude correction filings (they simply stay eligible, ranking
// decides), so it is normalized to null here, never passed through as a hard `false`.
export function applyCorrectionOnlyWhenAsked(filters, policy) {
  const p = resolvePolicy(policy);
  if (p.correction_filter !== "ONLY_WHEN_ASKED") return filters;
  return { ...filters, is_correction: filters.is_correction === true ? true : null };
}

// ---- generic per-leg multi-pass orchestration --------------------------------------

const isWindowPass = (label) => label.startsWith("window");

// `filters` here is mapOfficialConditionToFilterInput's own RAW output (mapped.filters --
// corp_codes/doc_groups/doc_subtypes/... conditions-shaped, NOT yet run through
// buildMetadataFiltersFromConditions). buildFilterPasses() applies that transform
// internally to build each pass's own DB-ready filter object -- passed to legSearch()
// unchanged, exactly matching what a4-a3-retrieval-pipeline.mjs's own single-pass code
// hands to fetchEligibleChunkIds()/searchDocumentChunksByVector(). The frozen branch
// below applies the SAME transform explicitly, once, since it never touches
// buildFilterPasses (matching the frozen pipeline's own `buildMetadataFiltersFromConditions
// (mapped.filters)` call site exactly).
//
// legSearch(passFilters, capK) -> Promise<[{id, score}]>, already capped at capK and
// already filter-verified (row-level, same defense-in-depth as the frozen leg). Returns
// the merged, ordered, capped-at-legCapK list, each item tagged with retrieval_pass/
// retrieval_group (frozen policy: every item tagged "base"/"primary").
async function runLegWithPolicy({ question, filters, policy, legCapK, legSearch }) {
  const p = resolvePolicy(policy);
  if (p.id === FROZEN_POLICY.id) {
    const dbReadyFilters = buildMetadataFiltersFromConditions(filters ?? {});
    const items = await legSearch(dbReadyFilters, legCapK);
    return items.map((item) => ({ ...item, retrieval_pass: "base", retrieval_group: "primary" }));
  }
  const plan = buildRetrievalPlan({ question, filters, policy: p });
  const passes = buildFilterPasses(filters, plan);

  const seen = new Set();
  const merged = [];
  const executed = new Map();     // pass label -> items returned by that pass (rank order)
  const passRanks = new Map();    // id -> Map(pass label -> 1-based rank in that pass)
  let primaryCount = 0;

  const record = (pass, items) => {
    executed.set(pass.label, items);
    items.forEach((item, index) => {
      if (!passRanks.has(item.id)) passRanks.set(item.id, new Map());
      passRanks.get(item.id).set(pass.label, index + 1);
    });
  };
  const admit = (pass, item) => {
    if (seen.has(item.id)) return false;
    if (pass.group === "primary" && primaryCount >= legCapK) return false;
    seen.add(item.id);
    merged.push({ ...item, retrieval_pass: pass.label, retrieval_group: pass.group });
    if (pass.group === "primary") primaryCount += 1;
    return true;
  };
  // Round-robin over the window passes of one group: the j-th item of every window in
  // turn, so a first date whose document fills the leg's own cap cannot crowd the second
  // date's document out entirely.
  const mergeWindowsRoundRobin = (group) => {
    const list = passes.filter((pp) => isWindowPass(pp.label) && pp.group === group);
    const longest = Math.max(0, ...list.map((pp) => (executed.get(pp.label) ?? []).length));
    for (let j = 0; j < longest; j += 1) {
      for (const pp of list) {
        const item = (executed.get(pp.label) ?? [])[j];
        if (item) admit(pp, item);
      }
    }
  };

  // 1. every window pass runs (primary and relaxed); merged round-robin.
  for (const pass of passes) if (isWindowPass(pass.label)) record(pass, await legSearch(pass.filters, legCapK));
  mergeWindowsRoundRobin("primary");
  mergeWindowsRoundRobin("relaxed");
  // 2. base (primary) only while the primary pool is not yet full; base_relaxed always.
  for (const pass of passes) {
    if (isWindowPass(pass.label)) continue;
    if (pass.group === "primary" && primaryCount >= legCapK) continue;
    const items = await legSearch(pass.filters, legCapK);
    record(pass, items);
    for (const item of items) admit(pass, item);
  }

  const ranked = rankCandidates(merged, {
    promoteTop: p.relaxed_promote_top ?? 0,
    rankIn: (item, label) => passRanks.get(item.id)?.get(label) ?? Infinity,
    passOf: (item) => item.retrieval_pass,
    primaryOrder: passes.filter((pp) => pp.group === "primary").map((pp) => pp.label),
    interleaveEvery: p.relaxed_interleave_every ?? 0,
    isRelaxed: (item) => item.retrieval_group === "relaxed",
  });
  return ranked.slice(0, legCapK);
}

// deps: {client, bm25Index, embeddingAdapter, retrievalIndexId, provenanceLoadSessionId,
//        expectedPins}
// question: {question, mappedFilters} -- mappedFilters is mapOfficialConditionToFilterInput's
//   own output (the CALLER's job, same as a4-a3-retrieval-pipeline.mjs's own
//   runQuestionPipeline -- this module never calls the mapper itself, so the QA condition
//   mapper stays exactly where it already is in the call chain).
// Returns {bm25_top100, dense_top100} -- hydrated CandidateRecord[] shaped exactly like
// a4-a3-retrieval-pipeline.mjs's own bm25Records/denseRecords, each item additionally
// tagged retrieval_pass/retrieval_group.
export async function runRemediationAwareCandidateGeneration(deps, question, policy) {
  const {
    client, bm25Index, embeddingAdapter, retrievalIndexId, provenanceLoadSessionId, expectedPins,
  } = deps;
  const filters = applyCorrectionOnlyWhenAsked(question.mappedFilters, policy);

  const bm25Leg = await runLegWithPolicy({
    question: question.question, filters, policy, legCapK: BM25_CANDIDATE_K,
    legSearch: async (passFilters, capK) => {
      const eligibleIds = await fetchEligibleChunkIds(client, retrievalIndexId, passFilters);
      let ranked = bm25Search(bm25Index, question.question, { topK: capK, eligibleIds });
      if (resolvePolicy(policy).bm25_zero_score === "DROP") ranked = ranked.filter((r) => r.score > 0);
      const rowsById = await fetchChunksByIds(client, retrievalIndexId, ranked.map((r) => r.id));
      // row-level double-check, same defense-in-depth as the frozen BM25 leg.
      return ranked.filter((r) => { const row = rowsById.get(r.id); return row !== undefined && passesMetadataFilters(row, passFilters); });
    },
  });

  const queryVector = await embeddingAdapter.embedQuery(question.question); // ONE call, reused by every dense pass
  const denseLeg = await runLegWithPolicy({
    question: question.question, filters, policy, legCapK: DENSE_CANDIDATE_K,
    legSearch: async (passFilters, capK) => {
      const rows = await createPostgresVectorRetrievalRepository({ client }).searchDocumentChunksByVector(
        { retrievalIndexId, queryVector, topK: capK, filters: passFilters, expectedPins },
      );
      return rows.map((r) => ({ id: r.chunk_id, score: r.similarity_score }));
    },
  });

  const allIds = [...new Set([...bm25Leg.map((r) => r.id), ...denseLeg.map((r) => r.id)])];
  const rowsById = await fetchChunksByIds(client, retrievalIndexId, allIds);
  const spansById = await fetchStagingSpans(client, provenanceLoadSessionId, allIds);
  const bm25Records = bm25Leg.map((r, i) => ({
    ...hydrateCandidateRecord(r, i + 1, rowsById, spansById),
    retrieval_pass: r.retrieval_pass, retrieval_group: r.retrieval_group,
  }));
  const denseRecords = denseLeg.map((r, i) => ({
    ...hydrateCandidateRecord(r, i + 1, rowsById, spansById),
    retrieval_pass: r.retrieval_pass, retrieval_group: r.retrieval_group,
  }));

  return { bm25_top100: bm25Records, dense_top100: denseRecords };
}
