#!/usr/bin/env node
// Turn A3-CANDIDATE-CEILING-AUDIT-V1, section C: candidate-pool generation
// for the oracle-ceiling audit. Reuses arm A's existing, UNMODIFIED search
// building blocks (bm25Search / fetchEligibleChunkIds / passesMetadataFilters
// / searchDocumentChunksByVector / reciprocalRankFusion / classifySpans /
// buildProvenanceSet / mapOfficialConditionToFilterInput /
// createGatedSeedCompanyResolver) directly, at the SAME code_sha (this
// worktree's HEAD, an unmodified descendant of A's own commit) -- the ONLY
// thing this script does that A's own runner/adapter does not is (a) widen
// the dense leg's own topK from A's official 20 to 100, and (b) persist the
// BM25-only and dense-only ranked lists BEFORE fusion, which
// fixed-kure-hybrid-retriever-adapter.mjs computes internally but never
// returns. No existing file is edited by this Turn.
//
// Output: one JSON file per question under work/a3-candidates/ (gitignored,
// carries raw chunk text for oracle text-verification) plus a manifest
// (embed-call count, timings, per-question chunk-id lists only) also under
// work/ -- nothing under work/ is ever committed.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import process from "node:process";
import pg from "pg";

import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { bm25Search, loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { createPostgresVectorRetrievalRepository } from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { fetchEligibleChunkIds, passesMetadataFilters } from "../domain/retrieval/metadata-filter.mjs";
import { reciprocalRankFusion } from "../domain/agent-comparison/chunking-comparison/rrf.mjs";
import { classifySpans, buildProvenanceSet } from "../domain/agent-comparison/four-arm-ac/locator-provenance.mjs";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";
import { buildMetadataFiltersFromConditions } from "../domain/agent-comparison/four-arm-ac/conditions-fixture.mjs";
import { validateOfficialConditionsV2Artifact } from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official");
const WORK_SEED_DIR = path.join(REPO_ROOT, "work/domain-seed");
const OUT_DIR = path.join(REPO_ROOT, "work/a3-candidates");

// Same pins/ids the existing devtune runner (scripts/p11f0-fourarm-devtune-ac-run.mjs) uses -- reused verbatim.
const LOAD_SESSION_ID = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e";
const PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const KURE_PIN = Object.freeze({ repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 });
const KURE_EXPECTED_PINS = Object.freeze({
  embedding_provider: "nlpai-lab", embedding_model: "KURE-v1",
  embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension,
});
const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_OWNER_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";
const BM25_CACHE_DIR = path.join(os.homedir(), "Library/Caches/ai-festival-p11f0-bm25-index");

// Pre-registered candidate ceiling (A3_CANDIDATE_CEILING_AUDIT_V1_AMENDMENT.md section 2).
const CANDIDATE_K = 100;
const RRF_K_CONSTANT = 60;

function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

async function loadCompanyIndex() {
  const resolver = await createGatedSeedCompanyResolver({
    artifactPath: path.join(WORK_SEED_DIR, "seed-company-directory.v0.1.candidate.jsonl"),
    manifestPath: path.join(WORK_SEED_DIR, "seed-company-directory.v0.1.candidate.manifest.json"),
    ownerDecisionPath: path.join(WORK_SEED_DIR, "seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedOwnerDecisionSha256: EXPECTED_OWNER_DECISION_SHA256,
    root: REPO_ROOT,
  });
  return buildNameToCorpCodeIndex(resolver);
}

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

// Exactly reformat_ac.py's own reformat_result_item() node_index/node_indices
// rule (RESULTS_SUMMARY.md / SCORER_MULTINODE_FIX_V1), reproduced here so
// this Turn's candidate pools use the SAME primary-node-plus-full-set
// convention A's own official results were reformatted to.
function resolveNodeIdentity(row, spans) {
  const resolution = classifySpans(spans ?? []);
  const provenanceSet = buildProvenanceSet(spans ?? []);
  const candidates = provenanceSet.candidates ?? [];
  const nodeIndices = [...new Set(candidates.map((c) => c.node_index).filter((v) => v !== null && v !== undefined))].sort((a, b) => a - b);
  let nodeIndex = resolution.node_index;
  if (nodeIndex === null || nodeIndex === undefined) {
    nodeIndex = nodeIndices.length > 0 ? nodeIndices[0] : null;
  }
  let locator = null;
  const match = candidates.find((c) => c.node_index === nodeIndex);
  if (match) locator = match.node_id;
  else if (candidates.length > 0) locator = candidates[0].node_id;
  if (locator === null) locator = resolution.locator ?? row?.source_locator ?? null;
  return {
    node_index: nodeIndex,
    node_indices: nodeIndices,
    locator,
    row: resolution.row,
    col: resolution.col,
    locator_status: resolution.status,
  };
}

function hydrate(id, { bm25RowsById, denseRowsById, spansById }) {
  const row = bm25RowsById.get(id) ?? denseRowsById.get(id);
  if (!row) return null;
  const identity = resolveNodeIdentity(row, spansById.get(id));
  return {
    chunk_id: id,
    doc_id: row.source_document_id,
    node_index: identity.node_index,
    node_indices: identity.node_indices,
    locator: identity.locator,
    locator_status: identity.locator_status,
    row: identity.row,
    col: identity.col,
    chunk_text_sha256: row.text_sha256,
    text: row.text_content,
  };
}

function toRankedOutput(rankedIdScore, hydrateArgs, scoreType) {
  return rankedIdScore.map((entry, index) => {
    const h = hydrate(entry.id, hydrateArgs);
    return {
      rank: index + 1,
      chunk_id: entry.id,
      score: entry.score,
      score_type: scoreType,
      ...(h ?? { doc_id: null, node_index: null, node_indices: [], locator: null, locator_status: "MISSING_ROW", row: null, col: null, chunk_text_sha256: null, text: null }),
    };
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const kureServerUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!kureServerUrl) throw new Error("P11F0_KURE_SERVER_URL is required");

  await mkdir(OUT_DIR, { recursive: true });

  const [conditionsRaw, nameToCorpCodeIndex] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl")),
    loadCompanyIndex(),
  ]);
  const conditionsValidation = validateOfficialConditionsV2Artifact(conditionsRaw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  if (!conditionsValidation || conditionsValidation.file_sha256 !== EXPECTED_CONDITIONS_SHA256) {
    throw new Error(`conditions sha256 mismatch: ${JSON.stringify(conditionsValidation)}`);
  }
  const allQuestions = conditionsRaw.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (allQuestions.length !== 101) throw new Error(`expected 101 questions, got ${allQuestions.length}`);
  // A3_SMOKE_LIMIT is a LOCAL dev-only override for a quick wiring smoke
  // test before the full 101-question run -- never set for the real,
  // committed audit run (the manifest records n_questions actually run).
  const smokeLimit = process.env.A3_SMOKE_LIMIT ? Number(process.env.A3_SMOKE_LIMIT) : null;
  const questions = smokeLimit ? allQuestions.slice(0, smokeLimit) : allQuestions;

  const bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, PROVENANCE_LOAD_SESSION_ID);
  if (bm25Index.documentCount !== 442549) throw new Error(`unexpected bm25 documentCount=${bm25Index.documentCount}, expected 442549`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let embedCallCount = 0;
  const t0 = Date.now();
  const perQuestionLatency = [];
  try {
    const vectorRepository = createPostgresVectorRetrievalRepository({ client });
    const embeddingAdapterInner = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
      revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
      endpoint_url: kureServerUrl, auth_mode: "NONE",
    });
    const embeddingAdapter = Object.freeze({
      ...embeddingAdapterInner,
      async embedQuery(text) {
        embedCallCount += 1;
        return embeddingAdapterInner.embedQuery(text);
      },
    });

    // readiness sanity check against the live retrieval index (read-only).
    const indexRow = (await client.query(
      `SELECT index_status, embedding_provider, embedding_model, embedding_revision, embedding_dimension, record_count
       FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1`,
      [RETRIEVAL_INDEX_ID],
    )).rows[0];
    if (!indexRow || indexRow.index_status !== "READY" || Number(indexRow.record_count) !== 442549) {
      throw new Error(`retrieval index not READY/count-matched: ${JSON.stringify(indexRow)}`);
    }

    for (const q of questions) {
      const outPath = path.join(OUT_DIR, `${q.question_id}.json`);
      const alreadyDone = await readFile(outPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
      if (alreadyDone && alreadyDone.candidate_k === CANDIDATE_K && alreadyDone.rrf_k === RRF_K_CONSTANT) {
        console.error(`[a3-candidates] SKIP (already done) ${q.question_id}`);
        continue;
      }
      const qt0 = Date.now();
      const mapped = mapOfficialConditionToFilterInput(q.conditions, nameToCorpCodeIndex);
      const filters = buildMetadataFiltersFromConditions(mapped.filters);

      const eligibleIds = await fetchEligibleChunkIds(client, RETRIEVAL_INDEX_ID, filters);
      const bm25Ranked = bm25Search(bm25Index, q.question, { topK: CANDIDATE_K, eligibleIds });

      const queryVector = await embeddingAdapter.embedQuery(q.question); // the ONE embed call for this question
      const denseRows = await vectorRepository.searchDocumentChunksByVector(
        { retrievalIndexId: RETRIEVAL_INDEX_ID, queryVector, topK: CANDIDATE_K, filters, expectedPins: KURE_EXPECTED_PINS },
      );
      const denseRanked = denseRows.map((r) => ({ id: r.chunk_id, score: r.similarity_score }));
      const denseRowsById = new Map(denseRows.map((r) => [r.chunk_id, r]));

      const bm25ChunkIds = bm25Ranked.map((r) => r.id);
      const bm25RowsById = await fetchChunksByIds(client, RETRIEVAL_INDEX_ID, bm25ChunkIds);
      const bm25RankedFiltered = bm25Ranked
        .filter((r) => { const row = bm25RowsById.get(r.id); return row !== undefined && passesMetadataFilters(row, filters); })
        .map((r) => ({ id: r.id, score: r.score }));

      const fused = reciprocalRankFusion([bm25RankedFiltered, denseRanked], { k: RRF_K_CONSTANT, topK: CANDIDATE_K });

      const allIds = [...new Set([...bm25RankedFiltered.map((r) => r.id), ...denseRanked.map((r) => r.id)])];
      const spansById = await fetchStagingSpans(client, PROVENANCE_LOAD_SESSION_ID, allIds);
      const hydrateArgs = { bm25RowsById, denseRowsById, spansById };

      const record = {
        question_id: q.question_id,
        segment: q.segment,
        candidate_k: CANDIDATE_K,
        rrf_k: RRF_K_CONSTANT,
        bm25: toRankedOutput(bm25RankedFiltered, hydrateArgs, "BM25"),
        dense: toRankedOutput(denseRanked, hydrateArgs, "DENSE"),
        union_rrf: toRankedOutput(fused, hydrateArgs, "RRF"),
      };
      await writeFile(outPath, JSON.stringify(record), "utf8");
      const latencyMs = Date.now() - qt0;
      perQuestionLatency.push(latencyMs);
      console.error(`[a3-candidates] ${perQuestionLatency.length}/${questions.length} ${q.question_id} (${latencyMs}ms)`);
    }
  } finally {
    await client.end();
  }

  const manifest = {
    turn: "A3-CANDIDATE-CEILING-AUDIT-V1",
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    node: process.version,
    n_questions: questions.length,
    candidate_k: CANDIDATE_K,
    rrf_k: RRF_K_CONSTANT,
    embed_query_call_count: embedCallCount,
    embed_document_call_count: 0,
    db_write_count: 0,
    total_elapsed_ms: Date.now() - t0,
    latency_ms_this_run: perQuestionLatency,
    retrieval_index_id: RETRIEVAL_INDEX_ID,
    provenance_load_session_id: PROVENANCE_LOAD_SESSION_ID,
    conditions_sha256: EXPECTED_CONDITIONS_SHA256,
    bm25_document_count: bm25Index.documentCount,
  };
  await writeFile(path.join(REPO_ROOT, "work/a3-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`[a3-candidates] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
