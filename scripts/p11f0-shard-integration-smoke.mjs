#!/usr/bin/env node
// Turn P11-F0 Stage 8/9: non-Gold, real-corpus-shard end-to-end smoke of
// the full hybrid retrieval stack -- BM25 index build/persist/reload,
// pgvector dense search, RRF fusion, RetrieverAdapter, and all FOUR Agent
// variants wired to it via the EXISTING, unmodified withVectorRetrieval
// helper. Uses FAKE_DETERMINISTIC only -- zero real HCX calls. Reads no
// DEV_TUNE/DEV_CHECK/HOLDOUT file; queries are synthetic, deterministic
// known-text probes derived from the shard's own already-materialized
// chunks (never Gold).
import pg from "pg";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { createPostgresVectorRetrievalRepository } from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { buildFixedKureBm25Index, persistFixedKureBm25Index, loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { createFixedKureHybridRetrieverAdapter } from "../domain/agent-comparison/retrieval/fixed-kure-hybrid-retriever-adapter.mjs";
import { computeFixedKureLoadSessionId, computeFixedKureRetrievalIndexId } from "../domain/postgres/reference-fixed-kure-load-session-repository.mjs";
import { runFourVariantComparison, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { withVectorRetrieval } from "../domain/agent-comparison/integration/wire-vector-retriever.mjs";
import { computeReleaseManifestSha256 } from "../domain/agent-comparison/integration/release-pin.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";

const { Client } = pg;
const BM25_CACHE_DIR = path.join(os.homedir(), "Library", "Caches", "ai-festival-p11f0-bm25-index");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const corpusSnapshotId = process.argv[process.argv.indexOf("--corpus-snapshot-id") + 1];
  if (!corpusSnapshotId) throw new Error("--corpus-snapshot-id is required");
  const embeddingServerUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!embeddingServerUrl) throw new Error("P11F0_KURE_SERVER_URL is required (e.g. http://127.0.0.1:58411/v1/embeddings)");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // Everything below runs inside try/finally so a thrown error (a bad
  // endpoint_url, a schema mismatch, anything) still closes the pg
  // connection -- without this, main().catch() logs FAILED but the open
  // connection keeps the event loop alive and the process never exits.
  try {
    const loadSessionId = computeFixedKureLoadSessionId({
      releaseId: "seed-release-v0.20", corpusSnapshotId,
      embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
      embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
      chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
    });
    const retrievalIndexId = computeFixedKureRetrievalIndexId({
      releaseId: "seed-release-v0.20", corpusSnapshotId,
      embeddingProvider: "nlpai-lab", embeddingModel: "KURE-v1",
      embeddingRevision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
      chunkingPolicyId: "fixed-token-512-o64.v0.1.0",
    });

    console.error("[smoke] building BM25 index (or reusing cache)...");
    let bm25Index;
    try {
      bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, loadSessionId);
      console.error("[smoke] BM25 index loaded from persisted cache");
    } catch {
      const { index, documentCount } = await buildFixedKureBm25Index(client, loadSessionId);
      const { sha256, bytes } = await persistFixedKureBm25Index(BM25_CACHE_DIR, loadSessionId, index);
      console.error(`[smoke] BM25 index built (${documentCount} docs) and persisted: sha256=${sha256} bytes=${bytes}`);
      bm25Index = index;
    }

    // A synthetic, deterministic, non-Gold probe query: pull one real chunk's
    // own raw_text substring back out as the "question" -- proves end-to-end
    // wiring without ever reading Gold expected-answer content.
    const probe = await client.query(
      `SELECT chunk_id, source_document_id, corp_code, text_content
       FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 ORDER BY chunk_id LIMIT 1`,
      [retrievalIndexId],
    );
    if (probe.rows.length === 0) throw new Error("no materialized chunks found for this retrieval_index_id -- run materialization first");
    const sampleChunk = probe.rows[0];
    // The FULL chunk text, not a short prefix: a real disclosure filing's
    // text is often table-linearized ("1. 제목 | 1. 제목 | ...", repeated
    // headers) -- a short prefix can land entirely inside that repetitive
    // header region, which is a poor (non-representative) probe for DENSE/
    // cosine semantic search even though it is a real, deterministic,
    // verbatim substring. The full text is still never Gold (it is this
    // Turn's own already-materialized chunk content, not an answer key).
    const probeQuestion = sampleChunk.text_content;

    const embeddingConfig = {
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
      revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024,
      endpoint_url: embeddingServerUrl, timeout_ms: 60000, auth_mode: "NONE",
    };
    const embeddingAdapter = createEmbeddingAdapter(embeddingConfig);
    const vectorRepository = createPostgresVectorRetrievalRepository({ client });

    const retrieverAdapter = createFixedKureHybridRetrieverAdapter({
      client, bm25Index, vectorRepository, embeddingAdapter, retrievalIndexId,
      expectedPins: { embedding_provider: "nlpai-lab", embedding_model: "KURE-v1", embedding_dimension: 1024, chunking_policy_id: "fixed-token-512-o64.v0.1.0" },
    });

    // Direct RetrieverAdapter probes (BEFORE wiring into the 4-variant
    // comparison) -- proves the adapter itself, independent of AgentFlow
    // plumbing.
    const directRequest = {
      schema_version: "0.1.0", query_id: "query_p11f0_shard_smoke_probe_01", question: probeQuestion,
      corpus_snapshot_id: corpusSnapshotId, chunking_config_id: "fixed-token-512-o64.v0.1.0", index_snapshot_id: retrievalIndexId,
      metadata_filters: { corp_codes: [], document_ids: [], doc_groups: [], doc_subtypes: [], base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true },
      top_k: 10, retrieval_method: "HYBRID_RRF",
    };
    const directResult = await retrieverAdapter.retrieve(directRequest, {});
    console.error(`[smoke] direct RetrieverAdapter probe: ${directResult.results.length} result(s), latency_ms=${directResult.latency_ms}`);
    const selfHit = directResult.results.find((r) => r.chunk_id === sampleChunk.chunk_id);
    console.error(`[smoke] the probe chunk itself ${selfHit ? "IS" : "is NOT"} present in its own top-10 HYBRID_RRF result (BM25 exact-match + DENSE cosine self-similarity should both surface it near rank 1)`);
    if (!selfHit) throw new Error("BM25+DENSE self-match probe FAILED: the chunk was not found in its own top-10 HYBRID_RRF result using its own full text as the query");

    // Now wire the SAME adapter into ALL FOUR variants via the existing,
    // unmodified helper -- zero real HCX calls (FAKE_DETERMINISTIC).
    const harness = await createSeedBundleHarness({ root: process.cwd() });
    const wired = withVectorRetrieval({
      context: { ...harness.context, corpus_snapshot_id: corpusSnapshotId },
      serviceAdapters: harness.serviceAdapters,
      retrieverAdapter, chunkingConfigId: "fixed-token-512-o64.v0.1.0", indexSnapshotId: retrievalIndexId,
      retrievalMethod: "HYBRID_RRF",
    });

    const modelConfig = { schema_version: "0.1.0", model_config_id: "model_fake-deterministic-p11f0-shard", kind: "FAKE_DETERMINISTIC", provider: "test-fixture", model: "deterministic-fake-v1" };
    const records = await runFourVariantComparison({
      variantIds: REQUIRED_VARIANT_IDS,
      modelAdapterFactory: () => createDeterministicFakeModelAdapter({
        responder: () => ({ text: `자동 응답: ${probeQuestion.slice(0, 10)}`, used_fact_ids: [], used_evidence_ids: [] }),
      }),
      agentVariantRevisions: computeAllAgentVariantRevisions(),
      modelConfig,
      releaseId: "seed-release-v0.20",
      releaseManifestSha256: await computeReleaseManifestSha256({ root: process.cwd() }),
      input: { question: probeQuestion, question_id: "q_p11f0_shard_smoke_01", hints: {} },
      context: wired.context,
      budgetLimits: { maxHcxCalls: 4, maxRetrievals: 5, maxToolCalls: 50, timeoutMs: 30000 },
      serviceAdapters: wired.serviceAdapters,
      flowOptions: wired.flowOptions,
      benchmarkRunId: "benchmark_run_p11f0_shard_smoke",
    });

    console.error(`[smoke] four-variant comparison: ${records.length} record(s)`);
    for (const record of records) {
      const errors = validateComparisonRecord(record);
      console.error(`[smoke]   ${record.agent_variant_id}: run_status=${record.run_status} document_retrieval_count=${record.document_retrieval_count} schema_errors=${errors.length}`);
      if (errors.length > 0) console.error(`[smoke]     ${errors.join("; ")}`);
    }

    await harness.dispose();
    const allValid = records.every((r) => validateComparisonRecord(r).length === 0);
    if (!allValid) throw new Error("one or more ComparisonRecords failed schema validation");
    console.error("[smoke] PASSED");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[smoke] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
