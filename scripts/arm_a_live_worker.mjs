#!/usr/bin/env node
// Turn A-PLUS-QA-LIVE-RETRIEVER-V1: persistent stdin/stdout worker that lets the Python QA
// process call Arm A's REAL retrieval code for an arbitrary question, without an HTTP server.
//
// This file NEVER reimplements BM25/dense/RRF/metadata-filter logic. It only imports and calls
// the existing, unmodified Arm A modules from a separate, read-only worktree (path given by
// ARM_A_LIVE_IMPL_ROOT — never hardcoded), exactly the way scripts/p11f0-shard-integration-smoke.mjs
// in that other repo already does. The only new logic here is: (1) the stdin/stdout JSONL
// protocol itself, (2) hydrating real chunk text (the adapter's own result never carries it —
// only chunk_text_sha256), verified against chunk_text_sha256/document_id before ever being
// returned, and (3) deriving node_index/node_indices from the adapter's own provenance.candidates
// (a presentation step, not new ranking).
//
// Protocol: one JSON object per line on stdin, one JSON object per line on stdout. All logging
// goes to stderr. Never writes to the database (search/fetch_node/readiness below are read-only,
// same as the underlying Arm A adapter).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { mapQaOrLegacyConditionsToArmAConditions, buildNameToCorpCodeIndexFromUniverseCsv } from
  "../domain/agent-comparison/four-arm-ac/qa-condition-mapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function log(...args) {
  console.error("[arm-a-live-worker]", ...args);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Turn A-PLUS-QA-CONDITION-MAPPING-V1: the wire `conditions` object QA actually sends is
// QueryConditions.as_dict()'s own shape (corps/doc_groups/year_months/... — see
// src/dart_corpus/retrieval/conditions.py), the same shape as the official
// devtune101_conditions.v2.jsonl artifact, NOT the old minimal {corp_code, document_group,
// document_subtype, period} shape this function used to assume (which meant every field QA
// actually sent went unrecognized and the metadata filter came back empty). This now delegates
// to qa-condition-mapper.mjs, which accepts both shapes, preserves multiple companies/doc-groups/
// periods, and refuses (throws) rather than silently widening on an unresolvable company name or
// an unknown doc_group.
let baseNameToCorpCodeIndex; // set once in main() from this repo's own data/corpus/universe.csv

function mapConditionsForSearch(conditions) {
  return mapQaOrLegacyConditionsToArmAConditions(conditions, { nameToCorpCodeIndex: baseNameToCorpCodeIndex });
}

async function fetchRealText(client, retrievalIndexId, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query(
    `SELECT chunk_id, source_document_id, text_content
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
    [retrievalIndexId, chunkIds],
  );
  return new Map(result.rows.map((r) => [r.chunk_id, r]));
}

// resolution.node_index is null for MULTI_NODE_AMBIGUOUS (locator-provenance.mjs's own
// classifySpans) — this reproduces the same node_index/node_indices split the original frozen
// A.results.jsonl producer already did: first candidate is the primary node_index, the full
// deduped candidate list is node_indices. Reads already-computed provenance, no new ranking.
function deriveNodeIndices(item) {
  const candidates = item.provenance?.candidates ?? [];
  const seen = [];
  for (const candidate of candidates) {
    if (!seen.includes(candidate.node_index)) seen.push(candidate.node_index);
  }
  if (item.node_index !== null && item.node_index !== undefined) {
    return { node_index: item.node_index, node_indices: seen.length > 0 ? seen : [item.node_index] };
  }
  return { node_index: seen[0] ?? null, node_indices: seen };
}

async function main() {
  const implRoot = requireEnv("ARM_A_LIVE_IMPL_ROOT");
  const databaseUrl = requireEnv("ARM_A_LIVE_DATABASE_URL");
  const retrievalIndexId = requireEnv("ARM_A_LIVE_RETRIEVAL_INDEX_ID");
  const loadSessionId = requireEnv("ARM_A_LIVE_LOAD_SESSION_ID");
  // Turn A-PLUS-QA-FULL-INDEX-SMOKE-V1: the shard used one plain load_session_id for
  // everything (discovery + materialization + BM25), per the live-retriever handoff's own note
  // that the attempt-based v2 scheme is incompatible with that plain lookup. The real full-corpus
  // index instead has TWO session rows: an immutable DISCOVERY attempt (holds `source_spans` for
  // provenance/fetch_node AND the canonical_queue rows BM25 is built from) and a separate READY
  // successor attempt (holds the materialized/dense session status createArmRetrieverAdapter's
  // own readiness() checks). createArmRetrieverAdapter already has a `provenanceLoadSessionId`
  // parameter for exactly this split (default: `loadSessionId`, so shard callers are unaffected
  // if these two new vars are left unset) — this worker just threads it through, and does the
  // same for which session id builds/loads the persisted BM25 cache. No new ranking/search logic.
  const provenanceLoadSessionId = process.env.ARM_A_LIVE_PROVENANCE_LOAD_SESSION_ID || loadSessionId;
  const bm25LoadSessionId = process.env.ARM_A_LIVE_BM25_LOAD_SESSION_ID || loadSessionId;
  const corpusSnapshotId = requireEnv("ARM_A_LIVE_CORPUS_SNAPSHOT_ID");
  const kureServerUrl = requireEnv("ARM_A_LIVE_KURE_SERVER_URL");
  const bm25CacheDir = requireEnv("ARM_A_LIVE_BM25_CACHE_DIR");

  // This repo's own already-verified company universe (CLAUDE.md: SHA-checked against
  // corpus_snapshot.json) — the same file src/dart_corpus/retrieval/corp_dictionary.py's own
  // CorpDictionary already trusts to produce QA's `corps` NAME values in the first place.
  baseNameToCorpCodeIndex = buildNameToCorpCodeIndexFromUniverseCsv(
    readFileSync(path.join(REPO_ROOT, "data/corpus/universe.csv"), "utf8"),
  );

  const modulePath = (relative) => path.join(implRoot, relative);
  // pg is a CJS dependency of the OTHER worktree (implRoot), not of this worker file's own
  // package — createRequire scoped to implRoot resolves it via that worktree's own node_modules,
  // exactly as if this file lived there, without adding any npm dependency to the QA repo itself.
  const { Client } = createRequire(path.join(implRoot, "package.json"))("pg");
  const { createArmRetrieverAdapter, KURE_PIN } = await import(
    modulePath("domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs")
  );
  const { createPostgresVectorRetrievalRepository } = await import(
    modulePath("domain/postgres/reference-vector-retrieval-repository.mjs")
  );
  const { createEmbeddingAdapter } = await import(
    modulePath("domain/agent-comparison/retrieval/embedding-adapter.mjs")
  );
  const { loadFixedKureBm25Index, buildFixedKureBm25Index, persistFixedKureBm25Index } = await import(
    modulePath("domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs")
  );

  log("connecting to Postgres...");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  log("loading BM25 index (or building + persisting if not cached)...");
  let bm25Index;
  try {
    bm25Index = await loadFixedKureBm25Index(bm25CacheDir, bm25LoadSessionId);
    log("BM25 index loaded from persisted cache");
  } catch {
    const { index, documentCount } = await buildFixedKureBm25Index(client, bm25LoadSessionId);
    await persistFixedKureBm25Index(bm25CacheDir, bm25LoadSessionId, index);
    log(`BM25 index built (${documentCount} docs) and persisted`);
    bm25Index = index;
  }

  const vectorRepository = createPostgresVectorRetrievalRepository({ client });
  const embeddingAdapter = createEmbeddingAdapter({
    schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
    revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
    endpoint_url: kureServerUrl, timeout_ms: 60000, auth_mode: "NONE",
  });

  const adapter = createArmRetrieverAdapter({
    arm: "A", client, bm25Index, vectorRepository, embeddingAdapter,
    retrievalIndexId, loadSessionId, provenanceLoadSessionId, corpusSnapshotId,
    expectedPins: { embedding_revision: KURE_PIN.revision, embedding_dimension: KURE_PIN.dimension },
  });

  const healthUrl = kureServerUrl.replace(/\/v1\/embeddings\/?$/, "/health");
  const infoUrl = kureServerUrl.replace(/\/v1\/embeddings\/?$/, "/info");

  async function handleReadiness() {
    const adapterReadiness = await adapter.readiness();
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
    const databaseReady = true; // we would not have gotten this far without a live connection
    const bm25IndexReady = adapterReadiness.checks.bm25_index_ready;
    const denseIndexReady = Boolean(adapterReadiness.checks.dense_index_ready);
    const armALiveReady = databaseReady && bm25IndexReady && denseIndexReady && kureReady
      && kureRevisionMatch && embeddingDimension === KURE_PIN.dimension
      && adapterReadiness.official_experiment_ready;
    return {
      database_ready: databaseReady,
      bm25_index_ready: bm25IndexReady,
      dense_index_ready: denseIndexReady,
      kure_ready: kureReady,
      kure_revision_match: kureRevisionMatch,
      embedding_dimension: embeddingDimension,
      materialized_record_count: adapterReadiness.checks.materialized_chunk_count,
      arm_a_live_ready: armALiveReady,
      kure_pin: { repository: "nlpai-lab/KURE-v1", revision: KURE_PIN.revision, dimension: KURE_PIN.dimension },
      adapter_readiness: adapterReadiness,
    };
  }

  async function handleSearch(question, conditions, topK) {
    const readiness = await handleReadiness();
    if (!readiness.arm_a_live_ready) {
      return { error: { code: "ARM_A_NOT_READY", message: "arm_a_live_ready=false — refusing to search", readiness } };
    }
    let mappedConditions;
    try {
      mappedConditions = mapConditionsForSearch(conditions);
    } catch (error) {
      return { error: { code: "ARM_A_CONDITION_MAPPING_FAILED", message: error.message } };
    }
    let rawResults;
    try {
      rawResults = await adapter.search(question, mappedConditions, topK);
    } catch (error) {
      return { error: { code: "ARM_A_SEARCH_FAILED", message: error.message } };
    }
    const chunkIds = rawResults.map((r) => r.chunk_id);
    const textByChunkId = await fetchRealText(client, retrievalIndexId, chunkIds);
    const results = [];
    for (const item of rawResults) {
      const row = textByChunkId.get(item.chunk_id);
      if (!row || !row.text_content) {
        return { error: { code: "TEXT_RESOLUTION_REQUIRED", message: `no materialized text for chunk_id=${item.chunk_id}` } };
      }
      if (row.source_document_id !== item.doc_id) {
        return { error: { code: "DOCUMENT_ID_MISMATCH", message: `chunk_id=${item.chunk_id}: expected doc_id=${item.doc_id}, row has ${row.source_document_id}` } };
      }
      const actualSha = sha256Hex(row.text_content);
      if (actualSha !== item.chunk_text_sha256) {
        return { error: { code: "TEXT_SHA_MISMATCH", message: `chunk_id=${item.chunk_id}: text sha256 ${actualSha} != recorded ${item.chunk_text_sha256}` } };
      }
      const { node_index, node_indices } = deriveNodeIndices(item);
      results.push({
        rank: item.rank,
        score: item.score,
        document_id: item.doc_id,
        chunk_id: item.chunk_id,
        node_index,
        node_indices,
        text: row.text_content,
        chunk_text_sha256: item.chunk_text_sha256,
        locator: item.locator,
        provenance: item.provenance,
        metadata: {
          ...item.metadata, score_type: item.score_type, component_scores: item.component_scores,
          arm_code: item.arm_code, arm_id: item.arm_id, locator_status: item.locator_status,
        },
        retrieval_method: "fixed_bm25_dense_rrf",
      });
    }
    return { results };
  }

  async function handleFetchNode(documentId, nodeIndex, row, col) {
    try {
      const result = await adapter.fetch_node(documentId, nodeIndex, { row: row ?? null, col: col ?? null });
      return { fetch_node: result };
    } catch (error) {
      return { error: { code: "ARM_A_SEARCH_FAILED", message: error.message } };
    }
  }

  log(`ready — retrievalIndexId=${retrievalIndexId} loadSessionId=${loadSessionId}`);
  writeLine({ request_id: null, worker_started: true });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeLine({ request_id: null, error: { code: "ARM_A_SEARCH_FAILED", message: `malformed request JSON: ${error.message}` } });
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
        const response = await handleFetchNode(request.document_id, request.node_index, request.row, request.col);
        writeLine({ request_id: requestId, ...response });
        return;
      }
      if (typeof request.question === "string" && request.question.trim() !== "") {
        const topK = Number.isInteger(request.top_k) && request.top_k > 0 ? request.top_k : 20;
        const response = await handleSearch(request.question, request.conditions, topK);
        writeLine({ request_id: requestId, ...response });
        return;
      }
      writeLine({ request_id: requestId, error: { code: "ARM_A_SEARCH_FAILED", message: "request must set 'type':'readiness'/'fetch_node' or a non-empty 'question'" } });
    } catch (error) {
      log("unexpected error handling request:", error.stack ?? error.message);
      writeLine({ request_id: requestId, error: { code: "ARM_A_SEARCH_FAILED", message: error.message } });
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
  console.error("[arm-a-live-worker] FATAL:", error.stack ?? error.message);
  process.exitCode = 1;
});
