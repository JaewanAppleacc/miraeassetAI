#!/usr/bin/env node
// opt-in ARM_A4_A3_REMEDIATION_LIVE 백엔드의 상주 stdin/stdout 워커.
// scripts/arm_a4_a3_live_worker.mjs와 구조 동일(같은 프로토콜, 같은 readiness 계약, 같은
// env 모양 — 접두만 ARM_A4_A3_REMEDIATION_LIVE_*라 두 백엔드가 프로세스 상태·구성을
// 공유하지 않는다). 유일한 기능 차이: 원본 무수정 a4-a3-retrieval-pipeline.mjs의
// runQuestionPipeline() 대신 a4-a3-remediation-retrieval-pipeline.mjs의
// runQuestionPipelineRemediationAware(..., REMEDIATION_V1_POLICY)를 호출한다.
// arm_a4_a3_live_worker.mjs 자체는 import·실행·수정되지 않는다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildNameToCorpCodeIndexFromUniverseCsv,
  mapQaOrLegacyConditionsToFourArmConditions,
} from "../domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require_ = createRequire(import.meta.url);

const baseNameToCorpCodeIndex = buildNameToCorpCodeIndexFromUniverseCsv(
  readFileSync(path.join(REPO_ROOT, "data/corpus/universe.csv"), "utf8"),
);

const RERANKER_CONFIG_ID = "R4_wide_rrf_centric";
const RETRIEVAL_OUTPUT_K = 20;
const BACKEND_TAG = "ARM_A4_A3_REMEDIATION_LIVE";

function log(...args) {
  console.error("[arm-a4-a3-remediation-live-worker]", ...args);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function mapConditionsForSearch(conditions) {
  return mapQaOrLegacyConditionsToFourArmConditions(conditions, { nameToCorpCodeIndex: baseNameToCorpCodeIndex });
}

async function main() {
  const databaseUrl = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_DATABASE_URL");
  const retrievalIndexId = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_RETRIEVAL_INDEX_ID");
  const loadSessionId = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_LOAD_SESSION_ID");
  const provenanceLoadSessionId = process.env.ARM_A4_A3_REMEDIATION_LIVE_PROVENANCE_LOAD_SESSION_ID || loadSessionId;
  const corpusSnapshotId = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_CORPUS_SNAPSHOT_ID");
  const kureServerUrl = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_KURE_SERVER_URL");
  const bm25CacheDir = requireEnv("ARM_A4_A3_REMEDIATION_LIVE_BM25_CACHE_DIR");

  const modulePath = (relative) => path.join(REPO_ROOT, relative);
  const { Client } = require_("pg");
  const { runQuestionPipelineRemediationAware } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a4-a3-remediation-retrieval-pipeline.mjs")
  );
  const { extractQuestionConditions, extractEvidenceFacts } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs")
  );
  const { mapOfficialConditionToFilterInput } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs")
  );
  const { detectEvidenceContradictions, CONTRADICTION_STATUS } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs")
  );
  const { REMEDIATION_V1_POLICY } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/four-arm-retrieval-policy.mjs")
  );
  const { KURE_PIN } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs")
  );
  const { createEmbeddingAdapter } = await import(
    modulePath("domain/agent-comparison/retrieval/embedding-adapter.mjs")
  );
  const { loadFixedKureBm25Index, buildFixedKureBm25Index, persistFixedKureBm25Index } = await import(
    modulePath("domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs")
  );
  const configsModule = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a4-reranker-configs.v1.json"),
    { with: { type: "json" } }
  );
  const allConfigs = configsModule.default.configs;
  const r4Config = allConfigs.find((c) => c.config_id === RERANKER_CONFIG_ID);
  if (!r4Config) throw new Error(`reranker config ${RERANKER_CONFIG_ID} not found in a4-reranker-configs.v1.json`);

  log("connecting to Postgres...");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  log("loading BM25 index (or building + persisting if not cached)...");
  let bm25Index;
  try {
    bm25Index = await loadFixedKureBm25Index(bm25CacheDir, loadSessionId);
    log("BM25 index loaded from persisted cache");
  } catch {
    const { index, documentCount } = await buildFixedKureBm25Index(client, loadSessionId);
    await persistFixedKureBm25Index(bm25CacheDir, loadSessionId, index);
    log(`BM25 index built (${documentCount} docs) and persisted`);
    bm25Index = index;
  }

  const embeddingAdapter = createEmbeddingAdapter({
    schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
    revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
    endpoint_url: kureServerUrl, timeout_ms: 60000, auth_mode: "NONE",
  });

  const expectedPins = { embedding_provider: "nlpai-lab", embedding_model: "KURE-v1",
    embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension };

  const healthUrl = kureServerUrl.replace(/\/v1\/embeddings\/?$/, "/health");
  const infoUrl = kureServerUrl.replace(/\/v1\/embeddings\/?$/, "/info");

  async function handleReadiness() {
    let kureReady = false;
    let kureRevisionMatch = false;
    let embeddingDimension = null;
    try {
      const [healthRes, infoRes] = await Promise.all([fetch(healthUrl), fetch(infoUrl)]);
      kureReady = healthRes.ok && (await healthRes.clone().json())?.status === "ok";
      const info = infoRes.ok ? await infoRes.json() : null;
      kureRevisionMatch = Boolean(info && info.model_revision === KURE_PIN.revision);
      embeddingDimension = info?.embedding_dimension ?? null;
    } catch (error) {
      log("KURE server health/info probe failed:", error.message);
    }
    const bm25IndexReady = Boolean(bm25Index) && bm25Index.documentCount > 0;
    const armReady = bm25IndexReady && kureReady && kureRevisionMatch
      && embeddingDimension === KURE_PIN.dimension;
    return {
      database_ready: true,
      bm25_index_ready: bm25IndexReady,
      bm25_document_count: bm25Index?.documentCount ?? 0,
      kure_ready: kureReady,
      kure_revision_match: kureRevisionMatch,
      embedding_dimension: embeddingDimension,
      arm_a4_a3_remediation_live_ready: armReady,
      kure_pin: { repository: "nlpai-lab/KURE-v1", revision: KURE_PIN.revision, dimension: KURE_PIN.dimension },
      retrieval_index_id: retrievalIndexId,
      corpus_snapshot_id: corpusSnapshotId,
      reranker_config: RERANKER_CONFIG_ID,
      policy_id: REMEDIATION_V1_POLICY.id,
    };
  }

  async function handleSearch(question, conditions, topK) {
    const readiness = await handleReadiness();
    if (!readiness.arm_a4_a3_remediation_live_ready) {
      return { error: { code: "ARM_A4_A3_REMEDIATION_NOT_READY", message: "arm_a4_a3_remediation_live_ready=false — refusing to search", readiness } };
    }
    let mappedConditions, nameToCorpCodeIndex;
    try {
      ({ conditions: mappedConditions, nameToCorpCodeIndex } = mapConditionsForSearch(conditions));
    } catch (error) {
      return { error: { code: "ARM_A4_A3_CONDITION_MAPPING_FAILED", message: error.message } };
    }
    const deps = {
      client, bm25Index, embeddingAdapter, retrievalIndexId, provenanceLoadSessionId,
      expectedPins, nameToCorpCodeIndex,
    };
    const question_ = { question_id: "live", question, conditions: mappedConditions, segment: null };
    let pipelineResult;
    try {
      pipelineResult = await runQuestionPipelineRemediationAware(deps, question_, [r4Config], REMEDIATION_V1_POLICY);
    } catch (error) {
      return { error: { code: "ARM_A4_A3_REMEDIATION_SEARCH_FAILED", message: error.message } };
    }
    const perConfig = pipelineResult.per_config[RERANKER_CONFIG_ID];
    const outputK = Number.isInteger(topK) && topK > 0 ? Math.min(topK, RETRIEVAL_OUTPUT_K) : RETRIEVAL_OUTPUT_K;
    const finalItems = perConfig.final_top20.slice(0, outputK);

    const mapped = mapOfficialConditionToFilterInput(mappedConditions, nameToCorpCodeIndex);
    const requiredConditions = extractQuestionConditions(question, mapped.filters);
    const results = finalItems.map((item, index) => {
      const evidenceFacts = extractEvidenceFacts(item);
      const decision = detectEvidenceContradictions({ questionConditions: requiredConditions, evidenceFacts });
      const a3Decision = decision.status === CONTRADICTION_STATUS.REJECT ? "REJECT"
        : decision.status === CONTRADICTION_STATUS.KEEP_UNKNOWN ? "KEEP_UNKNOWN" : "PASS";
      if (a3Decision === "REJECT") {
        throw new Error(`internal inconsistency: chunk_id=${item.chunk_id} recomputed as REJECT but was present in final_top20`);
      }
      return {
        rank: index + 1,
        reranker_rank: item.rank,
        score: item.reranker_score,
        chunk_id: item.chunk_id,
        document_id: item.document_id,
        text: item.text,
        chunk_text_sha256: item.chunk_text_sha256,
        node_index: item.node_index,
        node_indices: item.node_indices,
        locator: item.locator,
        provenance: item.provenance,
        metadata: item.metadata,
        // a4-wide-candidate-pool.mjs's own mergeBaseFields() (unmodified) only passes
        // through a fixed field set for every candidate list entry EXCEPT `metadata`
        // (via firstNonNull) -- retrieval_pass/retrieval_group are folded into
        // `metadata` by a4-a3-remediation-candidate-legs.mjs for exactly this reason.
        retrieval_pass: item.metadata?.retrieval_pass ?? null,
        retrieval_group: item.metadata?.retrieval_group ?? null,
        reranker_config: RERANKER_CONFIG_ID,
        a3_decision: a3Decision,
        backend: BACKEND_TAG,
      };
    });
    return {
      results,
      wide_pool_size: pipelineResult.wide_pool_size,
      a3_pass: perConfig.a3_pass,
      a3_reject: perConfig.a3_reject,
      a3_keep_unknown: perConfig.a3_keep_unknown,
      stable_refill_count: perConfig.stable_refill_count,
      final_shortfall: perConfig.final_shortfall,
    };
  }

  log(`ready — retrievalIndexId=${retrievalIndexId} loadSessionId=${loadSessionId} reranker=${RERANKER_CONFIG_ID} policy=${REMEDIATION_V1_POLICY.id}`);
  writeLine({ request_id: null, worker_started: true });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeLine({ request_id: null, error: { code: "ARM_A4_A3_REMEDIATION_SEARCH_FAILED", message: `malformed request JSON: ${error.message}` } });
      return;
    }
    const requestId = request.request_id ?? null;
    try {
      if (request.type === "readiness") {
        const readiness = await handleReadiness();
        writeLine({ request_id: requestId, readiness });
        return;
      }
      if (request.type === "fetch_node") {
        writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_REMEDIATION_SEARCH_FAILED", message: "fetch_node is not supported by ARM_A4_A3_REMEDIATION_LIVE — no DocumentIR access from this worker" } });
        return;
      }
      if (typeof request.question === "string" && request.question.trim() !== "") {
        const topK = Number.isInteger(request.top_k) && request.top_k > 0 ? request.top_k : RETRIEVAL_OUTPUT_K;
        const response = await handleSearch(request.question, request.conditions, topK);
        writeLine({ request_id: requestId, ...response });
        return;
      }
      writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_REMEDIATION_SEARCH_FAILED", message: "request must set 'type':'readiness'/'fetch_node' or a non-empty 'question'" } });
    } catch (error) {
      log("unexpected error handling request:", error.stack ?? error.message);
      writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_REMEDIATION_SEARCH_FAILED", message: error.message } });
    }
  });

  async function shutdown() {
    log("shutting down, closing DB connection...");
    try {
      await client.end();
    } finally {
      process.exit(0);
    }
  }
  rl.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("[arm-a4-a3-remediation-live-worker] FATAL:", error.stack ?? error.message);
  process.exitCode = 1;
});
