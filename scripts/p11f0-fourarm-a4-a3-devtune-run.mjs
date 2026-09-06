#!/usr/bin/env node
// Turn A4-A3-INTEGRATION-AND-DEVTUNE-V1, section F: single DEV_TUNE-101
// batch run. All 101 questions, one shared candidate-generation pass per
// question feeding all 6 configs, one query embedding per question, 0
// corpus embeddings, 0 DB writes. Raw candidate/text output goes only to
// gitignored work/ -- this script itself commits nothing.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import pg from "pg";

import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { buildNameToCorpCodeIndex } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";
import { validateOfficialConditionsV2Artifact } from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";
import { runQuestionPipeline } from "../domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official");
const OUT_DIR = path.join(REPO_ROOT, "work/a4-a3-devtune-results");

const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const KURE_PIN = Object.freeze({ repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 });
const KURE_EXPECTED_PINS = Object.freeze({
  embedding_provider: "nlpai-lab", embedding_model: "KURE-v1",
  embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension,
});
const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_OWNER_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";
const BM25_CACHE_DIR = path.join(os.homedir(), "Library/Caches/ai-festival-p11f0-bm25-index");

function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

async function loadCompanyIndex() {
  const resolver = await createGatedSeedCompanyResolver({
    artifactPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
    manifestPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
    ownerDecisionPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
    expectedOwnerDecisionSha256: EXPECTED_OWNER_DECISION_SHA256,
    root: REPO_ROOT,
  });
  return buildNameToCorpCodeIndex(resolver);
}

// Trims a hydrated CandidateRecord/reranker-output item down to exactly
// what the scorer needs (chunk_id/doc_id/node_index/node_indices/text/
// chunk_text_sha256/row/col) -- no score-machinery fields persisted.
function trimForScoring(item) {
  return {
    chunk_id: item.chunk_id,
    doc_id: item.document_id,
    node_index: item.node_index,
    node_indices: item.node_indices,
    text: item.text,
    chunk_text_sha256: item.chunk_text_sha256,
    row: null,
    col: null,
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const kureServerUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!kureServerUrl) throw new Error("P11F0_KURE_SERVER_URL is required");

  await mkdir(OUT_DIR, { recursive: true });

  const [conditionsRaw, nameToCorpCodeIndex, configsRaw] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl")),
    loadCompanyIndex(),
    import("../domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json", { with: { type: "json" } }),
  ]);
  const conditionsValidation = validateOfficialConditionsV2Artifact(conditionsRaw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  if (!conditionsValidation || conditionsValidation.file_sha256 !== EXPECTED_CONDITIONS_SHA256) {
    throw new Error(`conditions sha256 mismatch: ${JSON.stringify(conditionsValidation)}`);
  }
  const allQuestions = conditionsRaw.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (allQuestions.length !== 101) throw new Error(`expected 101 questions, got ${allQuestions.length}`);
  // A4A3_SMOKE_LIMIT is a local dev-only override for a quick wiring check
  // before the real, full, single 101-question batch run -- never set for
  // the committed/reported run (the manifest records n_questions actually run).
  const smokeLimit = process.env.A4A3_SMOKE_LIMIT ? Number(process.env.A4A3_SMOKE_LIMIT) : null;
  const questions = smokeLimit ? allQuestions.slice(0, smokeLimit) : allQuestions;
  const configs = configsRaw.default.configs;
  if (configs.length !== 6) throw new Error(`expected 6 configs, got ${configs.length}`);

  const bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, PROVENANCE_LOAD_SESSION_ID);
  if (bm25Index.documentCount !== 442549) throw new Error(`unexpected bm25 documentCount=${bm25Index.documentCount}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let embedCallCount = 0;
  const t0 = Date.now();
  const latencies = [];
  try {
    const embeddingAdapterInner = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
      revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
      endpoint_url: kureServerUrl, auth_mode: "NONE",
    });
    const embeddingAdapter = Object.freeze({
      ...embeddingAdapterInner,
      async embedQuery(text) { embedCallCount += 1; return embeddingAdapterInner.embedQuery(text); },
    });

    const indexRow = (await client.query(
      `SELECT index_status, record_count FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1`,
      [RETRIEVAL_INDEX_ID],
    )).rows[0];
    if (!indexRow || indexRow.index_status !== "READY" || Number(indexRow.record_count) !== 442549) {
      throw new Error(`retrieval index not READY/count-matched: ${JSON.stringify(indexRow)}`);
    }

    for (const q of questions) {
      const outPath = path.join(OUT_DIR, `${q.question_id}.json`);
      const already = await readFile(outPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
      if (already) { console.error(`[a4-a3-devtune] SKIP (already done) ${q.question_id}`); continue; }

      const qt0 = Date.now();
      const result = await runQuestionPipeline(
        { client, bm25Index, embeddingAdapter, retrievalIndexId: RETRIEVAL_INDEX_ID, provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID, expectedPins: KURE_EXPECTED_PINS, nameToCorpCodeIndex },
        q,
        configs,
      );
      const latencyMs = Date.now() - qt0;
      latencies.push(latencyMs);

      const record = {
        question_id: q.question_id,
        segment: q.segment,
        wide_pool_size: result.wide_pool_size,
        original_a_top20: result.original_a_top20.map(trimForScoring),
        per_config: Object.fromEntries(Object.entries(result.per_config).map(([configId, r]) => [configId, {
          raw_top20: r.raw_top20.map(trimForScoring),
          final_top20: r.final_top20.map(trimForScoring),
          a3_pass: r.a3_pass, a3_reject: r.a3_reject, a3_keep_unknown: r.a3_keep_unknown,
          stable_refill_count: r.stable_refill_count, final_shortfall: r.final_shortfall,
        }])),
        latency_ms: latencyMs,
      };
      await writeFile(outPath, JSON.stringify(record), "utf8");
      console.error(`[a4-a3-devtune] ${latencies.length}/${questions.length} ${q.question_id} (${latencyMs}ms)`);
    }
  } finally {
    await client.end();
  }

  const manifest = {
    turn: "A4-A3-INTEGRATION-AND-DEVTUNE-V1",
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    node: process.version,
    n_questions: questions.length,
    n_configs: configs.length,
    embed_query_call_count: embedCallCount,
    embed_document_call_count: 0,
    db_write_count: 0,
    total_elapsed_ms: Date.now() - t0,
    latency_ms_this_run: latencies,
    retrieval_index_id: RETRIEVAL_INDEX_ID,
    conditions_sha256: EXPECTED_CONDITIONS_SHA256,
    bm25_document_count: bm25Index.documentCount,
  };
  await writeFile(path.join(REPO_ROOT, "work/a4-a3-devtune-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(`[a4-a3-devtune] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
