#!/usr/bin/env node
// Turn A4-A3-PLUS-QA-SELF-CONTAINED-AND-JUDGE-V1 (originally A4-A3-PLUS-QA-FINAL-INTEGRATION-V1):
// persistent stdin/stdout worker for the DEV_TUNE-101-selected ARM_A4_A3_LIVE backend (A4 wide
// pool -> R4_wide_rrf_centric reranker -> A3 contradiction guard -> stable refill), mirroring
// scripts/arm_a_live_worker.mjs's own architecture 1:1: no HTTP server, one persistent Postgres
// client + one loaded BM25 index + one embedding adapter for the process lifetime, stdin/stdout
// JSONL protocol, all logging on stderr.
//
// This file never reimplements BM25/dense/RRF/wide-pool/reranker/A3 logic. It imports and calls
// the existing, unmodified four-arm-ac production modules, now vendored byte-identical into THIS
// repository under domain/ (see config/a4-a3-runtime-source-manifest.v1.json for each file's exact
// source commit/blob sha) instead of being dynamically imported from a separate sibling worktree —
// every import below is resolved relative to this file's own module URL
// (import.meta.url), so this script runs correctly regardless of the current working directory
// and regardless of whether any other Codex worktree exists on the machine. `pg` is resolved the
// same way, from this repository's own package.json/node_modules (see package.json). The only new
// logic in this file is: (1) this protocol, (2) mapping the wire's actual QA conditions shape
// (QueryConditions.as_dict() — see domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs's
// own docstring; the old minimal {corp_code, document_group, document_subtype, period} shape this
// used to assume is still supported for backward compatibility) into the pipeline's own
// `question.conditions` shape, and (3) converting each pipeline result item into the final wire
// item shape (rank renumber, reranker_rank preserved, a3_decision attached, backend tag) per the
// governing turn's Section E contract.
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

// This repo's own already-verified company universe (CLAUDE.md: SHA-checked against
// corpus_snapshot.json) — the same file src/dart_corpus/retrieval/corp_dictionary.py's own
// CorpDictionary already trusts to produce QA's `corps` NAME values in the first place.
const baseNameToCorpCodeIndex = buildNameToCorpCodeIndexFromUniverseCsv(
  readFileSync(path.join(REPO_ROOT, "data/corpus/universe.csv"), "utf8"),
);

const RERANKER_CONFIG_ID = "R4_wide_rrf_centric";
const RETRIEVAL_OUTPUT_K = 20;

function log(...args) {
  console.error("[arm-a4-a3-live-worker]", ...args);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Turn A-PLUS-QA-CONDITION-MAPPING-V1: the wire `conditions` object QA actually sends is
// QueryConditions.as_dict()'s own shape (corps/doc_groups/year_months/...), not the old minimal
// {corp_code, document_group, document_subtype, period} shape this file used to assume — which
// meant every field QA actually sent went unrecognized here (all of `c.corp_code`/
// `c.document_group`/`c.period` were simply undefined on that shape) and the metadata filter came
// back empty. qa-condition-mapper.mjs now does this reshaping (still accepting the old minimal
// shape too, for backward compatibility), AND resolves `corps` company NAMES via this repo's own
// universe.csv-based index — QA's own company resolution no longer needs to happen "upstream of
// this worker" (the old identityCorpCodeIndex below only ever worked for an already-resolved
// corp_code, never a name, which the live wire was never actually sending).
function mapConditionsForSearch(conditions) {
  return mapQaOrLegacyConditionsToFourArmConditions(conditions, { nameToCorpCodeIndex: baseNameToCorpCodeIndex });
}

async function main() {
  const databaseUrl = requireEnv("ARM_A4_A3_LIVE_DATABASE_URL");
  const retrievalIndexId = requireEnv("ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID");
  const loadSessionId = requireEnv("ARM_A4_A3_LIVE_LOAD_SESSION_ID");
  const provenanceLoadSessionId = process.env.ARM_A4_A3_LIVE_PROVENANCE_LOAD_SESSION_ID || loadSessionId;
  const corpusSnapshotId = requireEnv("ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID");
  const kureServerUrl = requireEnv("ARM_A4_A3_LIVE_KURE_SERVER_URL");
  const bm25CacheDir = requireEnv("ARM_A4_A3_LIVE_BM25_CACHE_DIR");

  // Every module below is vendored byte-identical into THIS repository (see
  // config/a4-a3-runtime-source-manifest.v1.json) and resolved relative to REPO_ROOT, which is
  // itself derived from this file's own import.meta.url — never from process.cwd() or any
  // externally-supplied "impl root" env var, so this works from any working directory and needs
  // no sibling Codex worktree to exist.
  const modulePath = (relative) => path.join(REPO_ROOT, relative);
  const { Client } = require_("pg");
  const { runQuestionPipeline, extractQuestionConditions, extractEvidenceFacts } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs")
  );
  const { mapOfficialConditionToFilterInput } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs")
  );
  const { detectEvidenceContradictions, CONTRADICTION_STATUS } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs")
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
    const armA4A3LiveReady = bm25IndexReady && kureReady && kureRevisionMatch
      && embeddingDimension === KURE_PIN.dimension;
    return {
      database_ready: true, // we would not have gotten this far without a live connection
      bm25_index_ready: bm25IndexReady,
      bm25_document_count: bm25Index?.documentCount ?? 0,
      kure_ready: kureReady,
      kure_revision_match: kureRevisionMatch,
      embedding_dimension: embeddingDimension,
      arm_a4_a3_live_ready: armA4A3LiveReady,
      kure_pin: { repository: "nlpai-lab/KURE-v1", revision: KURE_PIN.revision, dimension: KURE_PIN.dimension },
      retrieval_index_id: retrievalIndexId,
      corpus_snapshot_id: corpusSnapshotId,
      reranker_config: RERANKER_CONFIG_ID,
    };
  }

  async function handleSearch(question, conditions, topK) {
    const readiness = await handleReadiness();
    if (!readiness.arm_a4_a3_live_ready) {
      return { error: { code: "ARM_A4_A3_NOT_READY", message: "arm_a4_a3_live_ready=false — refusing to search", readiness } };
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
      pipelineResult = await runQuestionPipeline(deps, question_, [r4Config]);
    } catch (error) {
      return { error: { code: "ARM_A4_A3_SEARCH_FAILED", message: error.message } };
    }
    const perConfig = pipelineResult.per_config[RERANKER_CONFIG_ID];
    const outputK = Number.isInteger(topK) && topK > 0 ? Math.min(topK, RETRIEVAL_OUTPUT_K) : RETRIEVAL_OUTPUT_K;
    const finalItems = perConfig.final_top20.slice(0, outputK);

    // a3_decision per final item: runQuestionPipeline() computes this internally
    // (decisionByChunkId) but does not return it. Rather than modify that frozen,
    // already-pinned pipeline module (imported byte-identical from a separate
    // worktree, out of scope for this turn), the exact same exported, pure functions
    // are called again here on just the <=20 final items — deterministic given the
    // same inputs, so this is redundant computation, never a second implementation
    // of A3's judgement.
    const mapped = mapOfficialConditionToFilterInput(mappedConditions, nameToCorpCodeIndex);
    const requiredConditions = extractQuestionConditions(question, mapped.filters);
    const results = finalItems.map((item, index) => {
      const evidenceFacts = extractEvidenceFacts(item);
      const decision = detectEvidenceContradictions({ questionConditions: requiredConditions, evidenceFacts });
      const a3Decision = decision.status === CONTRADICTION_STATUS.REJECT ? "REJECT"
        : decision.status === CONTRADICTION_STATUS.KEEP_UNKNOWN ? "KEEP_UNKNOWN" : "PASS";
      if (a3Decision === "REJECT") {
        // Must never happen: selectWithStableRefill() already dropped every REJECT
        // candidate before this item could reach final_top20. Fail closed rather than
        // silently emit a REJECTed candidate to QA.
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
        reranker_config: RERANKER_CONFIG_ID,
        a3_decision: a3Decision,
        backend: "ARM_A4_A3_LIVE",
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

  log(`ready — retrievalIndexId=${retrievalIndexId} loadSessionId=${loadSessionId} reranker=${RERANKER_CONFIG_ID}`);
  writeLine({ request_id: null, worker_started: true });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeLine({ request_id: null, error: { code: "ARM_A4_A3_SEARCH_FAILED", message: `malformed request JSON: ${error.message}` } });
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
        writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_SEARCH_FAILED", message: "fetch_node is not supported by ARM_A4_A3_LIVE — no DocumentIR access from this worker" } });
        return;
      }
      if (typeof request.question === "string" && request.question.trim() !== "") {
        const topK = Number.isInteger(request.top_k) && request.top_k > 0 ? request.top_k : RETRIEVAL_OUTPUT_K;
        const response = await handleSearch(request.question, request.conditions, topK);
        writeLine({ request_id: requestId, ...response });
        return;
      }
      writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_SEARCH_FAILED", message: "request must set 'type':'readiness'/'fetch_node' or a non-empty 'question'" } });
    } catch (error) {
      log("unexpected error handling request:", error.stack ?? error.message);
      writeLine({ request_id: requestId, error: { code: "ARM_A4_A3_SEARCH_FAILED", message: error.message } });
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
  console.error("[arm-a4-a3-live-worker] FATAL:", error.stack ?? error.message);
  process.exitCode = 1;
});
