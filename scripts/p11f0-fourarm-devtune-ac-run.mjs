#!/usr/bin/env node
// Turn FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE, section E:
// the REAL, ready-to-run DEV_TUNE-101 retrieval runner for arm A or arm C,
// against the SAME official conditions/universe/cutoff-contract pins B/D
// already used. This script is NOT invoked by this Turn -- see the
// handoff doc for exactly why (arm A requires a live KURE-v1 embedding
// server this environment does not currently have reachable; arm C has no
// such blocker but is deliberately held back from running alone so both
// arms execute against the identical code_sha256 in one pass, per the
// "no partial/selective arm execution" rule).
//
// What changed since the LAST Turn's assessment that this could not run
// at all: the corp-NAME -> corp_code resolution gap is now closed using
// an ALREADY Owner-approved CompanyResolver decision (work/domain-seed/
// seed-company-directory-owner-decision.v0.1.approved.json, reviewer
// 최재완, corpus_04750795e1a2d5c3, APPROVED 2026-08-14) -- every one of
// the 70 corp names referenced across all 101 official conditions
// resolves against it with zero misses (see tests/four-arm-conditions-
// to-filter-mapper.test.mjs). doc_subtype taxonomy for exchange_subtypes/
// periodic_subtypes is independently verified to match the real
// reference_retrieval_chunks.metadata.doc_subtype vocabulary exactly;
// only major_labels has no DB-side equivalent and is intentionally left
// unmapped (see four-arm-conditions-to-filter-mapper.mjs's own header).
//
// Checkpoint contract: results are appended one line per question to
// <outDir>/<ARM>.results.ndjson as each question finishes. Re-running
// this script skips any question_id already present in that file --
// resuming after an infra failure NEVER re-issues search() for an
// already-completed question, and NEVER partially rewrites the file. The
// <ARM>.run.json summary is only ever written once every question in
// devtune101_conditions.v2.jsonl has a checkpointed line.
import { createHash } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import process from "node:process";
import pg from "pg";
import { createArmRetrieverAdapter } from "../domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs";
import { createEmbeddingAdapter } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { createPostgresVectorRetrievalRepository } from "../domain/postgres/reference-vector-retrieval-repository.mjs";
import { loadFixedKureBm25Index } from "../domain/agent-comparison/retrieval/fixed-kure-bm25-index.mjs";
import { createGatedSeedCompanyResolver } from "../domain/adapters/seed-company-resolver.mjs";
import { buildNameToCorpCodeIndex, mapOfficialConditionToFilterInput } from "../domain/agent-comparison/four-arm-ac/four-arm-conditions-to-filter-mapper.mjs";
import { validateOfficialConditionsV2Artifact } from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";
import { RETRIEVAL_OUTPUT_K } from "../domain/agent-comparison/four-arm-ac/four-arm-cutoff-contract.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official");
const WORK_SEED_DIR = path.join(REPO_ROOT, "work/domain-seed");

const LOAD_SESSION_ID = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e";
const PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const KURE_PIN = Object.freeze({ repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 });
const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_OWNER_DECISION_SHA256 = "2d8766ba4c5c1da42758b7823feca96cbbab58e844dac6e68c580709f5c22a20";
const BM25_CACHE_DIR = path.join(os.homedir(), "Library/Caches/ai-festival-p11f0-bm25-index");

function option(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}
function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function gitHeadSha() { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(); }
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

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

async function readCheckpoint(resultsPath) {
  const done = new Map();
  if (!existsSync(resultsPath)) return done;
  const raw = readFileSync(resultsPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    done.set(row.question_id, row);
  }
  return done;
}

async function main() {
  const arm = option("--arm");
  if (arm !== "A" && arm !== "C") throw new Error('--arm A|C is required');
  const batchId = option("--batch-id");
  if (!batchId) throw new Error("--batch-id is required (must match the preflight manifest's batch_id for this run to be reusable)");
  const outDir = option("--out-dir", path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/results"));

  if (arm === "A" && !process.env.P11F0_KURE_SERVER_URL) {
    throw new Error(
      "P11F0_KURE_SERVER_URL is required for arm A (dense leg needs a live KURE-v1 embedding server for query embedding) -- " +
      "this is the ONE remaining blocker this Turn identified; refusing to silently fall back to a fake/deterministic embedder for an official run.",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  await mkdir(outDir, { recursive: true });
  const resultsPath = path.join(outDir, `${arm}.results.ndjson`);
  const runJsonPath = path.join(outDir, `${arm}.run.json`);

  const [conditionsRaw, nameToCorpCodeIndex, configRaw] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl")),
    loadCompanyIndex(),
    readFile(path.join(REPO_ROOT, `domain/agent-comparison/four-arm-ac/config.${arm}.json`)),
  ]);
  const conditionsValidation = validateOfficialConditionsV2Artifact(conditionsRaw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  const questions = conditionsRaw.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const configJson = JSON.parse(configRaw.toString("utf8"));
  const configSha256 = sha256Hex(configRaw);
  const codeSha256 = gitHeadSha();

  const bm25Index = await loadFixedKureBm25Index(BM25_CACHE_DIR, PROVENANCE_LOAD_SESSION_ID);
  if (bm25Index.documentCount !== 442549) throw new Error(`unexpected bm25 documentCount=${bm25Index.documentCount}, expected 442549`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let adapter;
  try {
    if (arm === "A") {
      const vectorRepository = createPostgresVectorRetrievalRepository({ client });
      const embeddingAdapter = createEmbeddingAdapter({
        schema_version: "0.1.0", kind: "HTTP_EMBEDDINGS", provider: "nlpai-lab", model: "KURE-v1",
        revision: KURE_PIN.revision, dimension: KURE_PIN.dimension,
        endpoint_url: process.env.P11F0_KURE_SERVER_URL, auth_mode: "NONE",
      });
      adapter = createArmRetrieverAdapter({
        arm: "A", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
        provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID, vectorRepository, embeddingAdapter, expectedPins: KURE_PIN,
      });
    } else {
      adapter = createArmRetrieverAdapter({
        arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
        provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID,
      });
    }

    const readiness = await adapter.readiness();
    if (!readiness.official_experiment_ready) {
      throw new Error(`arm ${arm} readiness is not official_experiment_ready: ${JSON.stringify(readiness.reasons)}`);
    }

    const done = await readCheckpoint(resultsPath);
    const startedAt = done.size === 0 ? new Date().toISOString() : null;
    const latencies = [];
    let errors = 0;

    for (const row of questions) {
      if (done.has(row.question_id)) continue;
      const mapped = mapOfficialConditionToFilterInput(row.conditions, nameToCorpCodeIndex);
      const t0 = Date.now();
      let resultLine;
      try {
        const results = await adapter.search(row.question, mapped.filters, RETRIEVAL_OUTPUT_K);
        const latencyMs = Date.now() - t0;
        latencies.push(latencyMs);
        resultLine = {
          question_id: row.question_id, arm, segment: row.segment,
          code_sha256: codeSha256, config_sha256: configSha256, batch_id: batchId,
          latency_ms: latencyMs,
          results: results.map((r) => ({
            rank: r.rank, chunk_id: r.chunk_id, doc_id: r.doc_id, node_index: r.node_index,
            locator: r.locator, row: r.row, col: r.col, score: r.score, score_type: r.score_type,
          })),
        };
      } catch (error) {
        errors += 1;
        resultLine = { question_id: row.question_id, arm, segment: row.segment, code_sha256: codeSha256, config_sha256: configSha256, batch_id: batchId, error: error.message };
      }
      // eslint-disable-next-line no-await-in-loop
      await appendFile(resultsPath, `${JSON.stringify(resultLine)}\n`, "utf8");
      done.set(row.question_id, resultLine);
      console.error(`[fourarm-devtune-${arm}] ${done.size}/${questions.length} ${row.question_id}`);
    }

    if (done.size !== questions.length) throw new Error(`incomplete: ${done.size}/${questions.length} questions checkpointed`);
    if (errors > 0) throw new Error(`${errors} question(s) errored -- refusing to write run.json for an incomplete/erroring run`);

    const finalRaw = readFileSync(resultsPath);
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const runJson = {
      arm, batch_id: batchId, started_at: startedAt ?? "RESUMED_RUN_START_TIME_NOT_RECORDED", finished_at: new Date().toISOString(),
      host: os.hostname(), platform: `${os.type()}-${os.release()}-${os.arch()}`, node: process.version,
      code_sha256: codeSha256, config_sha256: configSha256,
      input_sha256: { conditions: conditionsValidation.file_sha256, config: configSha256 },
      n_questions: questions.length, n_errors: errors,
      latency_ms: sortedLatencies.length > 0 ? { p50: percentile(sortedLatencies, 50), p95: percentile(sortedLatencies, 95), max: sortedLatencies[sortedLatencies.length - 1] } : null,
      results_sha256: sha256Hex(finalRaw),
    };
    await import("node:fs/promises").then((fs) => fs.writeFile(runJsonPath, JSON.stringify(runJson, null, 2)));
    console.log(JSON.stringify(runJson, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[fourarm-devtune-run] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

export { main };
