#!/usr/bin/env node
// Turn A4-A3-INTEGRATION-AND-DEVTUNE-V1, section E: infra gate + one
// non-Gold smoke question, run before any Gold/DEV_TUNE access. Exits
// non-zero (BLOCKED_CONTRACT) on any failure.
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import pg from "pg";

import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { buildNameToCorpCodeIndex } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";
import { runQuestionPipeline } from "../domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const KURE_PIN = Object.freeze({ repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 });
const KURE_EXPECTED_PINS = Object.freeze({
  embedding_provider: "nlpai-lab", embedding_model: "KURE-v1",
  embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension,
});
const EXPECTED_OWNER_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";
const BM25_CACHE_DIR = path.join(os.homedir(), "Library/Caches/ai-festival-p11f0-bm25-index");

// A deliberately NON-Gold, hand-authored synthetic question -- not one of
// the 101 DEV_TUNE-101 official conditions rows.
const SMOKE_QUESTION = {
  question_id: "smoke_non_gold_0001",
  question: "삼성전자의 최근 대량보유상황보고서 내용은 무엇인가?",
  conditions: { corps: ["삼성전자"], doc_groups: ["holding"], years: [], year_months: [], candidate_terms: ["대량보유", "보고서"] },
  segment: "SMOKE",
};

function fail(message) {
  console.error(`[a4-a3-smoke] BLOCKED_CONTRACT: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return fail("DATABASE_URL is required");
  const kureServerUrl = process.env.P11F0_KURE_SERVER_URL;
  if (!kureServerUrl) return fail("P11F0_KURE_SERVER_URL is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // --- infra gate ---
    const indexRow = (await client.query(
      `SELECT index_status, record_count, embedding_dimension FROM disclosure_reference.reference_retrieval_indexes WHERE retrieval_index_id = $1`,
      [RETRIEVAL_INDEX_ID],
    )).rows[0];
    if (!indexRow || indexRow.index_status !== "READY") return fail(`retrieval index not READY: ${JSON.stringify(indexRow)}`);
    if (Number(indexRow.record_count) !== 442549) return fail(`retrieval_record_count mismatch: ${indexRow.record_count}`);
    if (Number(indexRow.embedding_dimension) !== 1024) return fail(`embedding_dimension mismatch: ${indexRow.embedding_dimension}`);

    const sessionRow = (await client.query(
      `SELECT status, expected_unique_embeddable_count FROM disclosure_reference.reference_fixed_kure_load_sessions WHERE load_session_id = 'fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e'`,
    )).rows[0];
    if (!sessionRow || sessionRow.status !== "READY" || Number(sessionRow.expected_unique_embeddable_count) !== 441879) {
      return fail(`unique_embedding_count gate failed: ${JSON.stringify(sessionRow)}`);
    }

    const infoResp = await fetch(kureServerUrl.replace(/\/v1\/embeddings$/, "/info"));
    const info = await infoResp.json();
    if (info.repository_id !== KURE_PIN.repository || info.model_revision !== KURE_PIN.revision || info.embedding_dimension !== KURE_PIN.dimension) {
      return fail(`KURE pin mismatch: ${JSON.stringify(info)}`);
    }
    console.error("[a4-a3-smoke] infra gate: GREEN");

    // --- pipeline smoke ---
    const bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, PROVENANCE_LOAD_SESSION_ID);
    if (bm25Index.documentCount !== 442549) return fail(`bm25 documentCount mismatch: ${bm25Index.documentCount}`);

    const resolver = await createGatedSeedCompanyResolver({
      artifactPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.jsonl"),
      manifestPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory.v0.1.candidate.manifest.json"),
      ownerDecisionPath: path.join(REPO_ROOT, "work/domain-seed/seed-company-directory-owner-decision.v0.1.approved.json"),
      expectedOwnerDecisionSha256: EXPECTED_OWNER_DECISION_SHA256,
      root: REPO_ROOT,
    });
    const nameToCorpCodeIndex = buildNameToCorpCodeIndex(resolver);

    const embeddingAdapter = createEmbeddingAdapter({
      schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
      revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
      endpoint_url: kureServerUrl, auth_mode: "NONE",
    });

    const configsRaw = await import("../domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json", { with: { type: "json" } });
    const configs = configsRaw.default.configs;

    const result = await runQuestionPipeline(
      { client, bm25Index, embeddingAdapter, retrievalIndexId: RETRIEVAL_INDEX_ID, provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID, expectedPins: KURE_EXPECTED_PINS, nameToCorpCodeIndex },
      SMOKE_QUESTION,
      configs,
    );

    if (result.wide_pool_size < 1 || result.wide_pool_size > 200) return fail(`wide_pool_size out of range: ${result.wide_pool_size}`);
    if (Object.keys(result.per_config).length !== 6) return fail(`expected 6 configs, got ${Object.keys(result.per_config).length}`);
    for (const [configId, r] of Object.entries(result.per_config)) {
      if (!Array.isArray(r.final_top20) || r.final_top20.length === 0) return fail(`${configId}: empty final_top20`);
      for (const c of r.final_top20) {
        if (typeof c.chunk_text_sha256 !== "string" || c.chunk_text_sha256.length !== 64) return fail(`${configId}: missing/invalid chunk_text_sha256 on ${c.chunk_id}`);
        if (!c.provenance || typeof c.provenance !== "object") return fail(`${configId}: missing provenance on ${c.chunk_id}`);
      }
    }
    console.error(`[a4-a3-smoke] pipeline smoke: GREEN (wide_pool_size=${result.wide_pool_size}, configs=${Object.keys(result.per_config).length}, embed_calls=1)`);
    console.log(JSON.stringify({ status: "GREEN", wide_pool_size: result.wide_pool_size, configs: Object.keys(result.per_config) }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  fail(error.stack ?? error.message);
});
