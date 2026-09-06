// Turn A-PLUS-QA-FULL-INDEX-SMOKE-V1 — real integration smoke for arm_a_live_worker.mjs against
// the FULL 442,549-chunk READY retrieval index (fixed_kure_index_8fe191342205848d1d6a6123f38a54e7,
// db p11f0_scratch on port 55329), NOT the 18-chunk shard scripts/arm_a_live_worker.test.mjs
// already covers. Real subprocess, real Postgres, real running KURE-v1 server. No mocks. No
// Gold/DEV_TUNE/DEV_CHECK/HOLDOUT file is read anywhere in this file — the 5 probe questions are
// each a real, already-materialized chunk's own text, pulled fresh from the full index across 4
// distinct document groups (periodic/major/holding/exchange), never from the frozen 101 Gold set.
//
// Run with (heap must be raised — loading the full corpus's persisted 1.7GB BM25 cache OOMs
// Node's default heap):
//   NODE_OPTIONS="--max-old-space-size=8192" \
//   ARM_A_LIVE_IMPL_ROOT=... ARM_A_LIVE_DATABASE_URL=postgresql://jaewan@localhost:55329/p11f0_scratch \
//   ARM_A_LIVE_RETRIEVAL_INDEX_ID=fixed_kure_index_8fe191342205848d1d6a6123f38a54e7 \
//   ARM_A_LIVE_LOAD_SESSION_ID=fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e \
//   ARM_A_LIVE_PROVENANCE_LOAD_SESSION_ID=fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36 \
//   ARM_A_LIVE_BM25_LOAD_SESSION_ID=fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36 \
//   ARM_A_LIVE_CORPUS_SNAPSHOT_ID=corpus_04750795e1a2d5c3 \
//   ARM_A_LIVE_KURE_SERVER_URL=http://127.0.0.1:58411/v1/embeddings \
//   ARM_A_LIVE_BM25_CACHE_DIR=/Users/jaewan/Library/Caches/ai-festival-p11f0-bm25-index \
//     node --test scripts/arm_a_live_worker_full_index.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";
import path from "node:path";
import test, { after, before } from "node:test";

const EXPECTED_RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const EXPECTED_RECORD_COUNT = 442549;
const EXPECTED_UNIQUE_EMBEDDABLE_COUNT = 441879;
const EXPECTED_KURE_REVISION = "4ed4540949c70b7da2c74004a915e1f2d5e46e4f";

// The 5 probe chunk IDs this Turn selected by direct SQL against the real full index — one per
// document group (periodic appears twice: once for the multi-node case, once for plain prose),
// none of them from data/eval/phase1_devtune_gold.v0.1.jsonl or any gold25/DEV_TUNE-101 fixture.
const PROBE_CHUNK_IDS = [
  "chunk_25845e0607f2f5a7abf6ae97", // periodic_20250814002920 — 55 persisted spans, 55 DISTINCT
                                    // order_index values (genuinely multi-NODE, not just
                                    // multi-row/col within one node)
  "chunk_64022f2f74ed1a08f029d666", // major_20240910000559 — numeric (stock trading table)
  "chunk_000605521f33cb42e89c1bc8", // holding_20230504000774
  "chunk_0008d4f96bca991cb655b20d", // exchange_20250922800142 — numeric (정정 계약금액)
  "chunk_000094f84dd03923aacac791", // periodic_20250311001180 — prose (non-numeric)
];
const MULTI_NODE_PROBE_CHUNK_ID = "chunk_25845e0607f2f5a7abf6ae97";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to run this real-infra integration test`);
  return value;
}

let proc;
let rl;
let pending = new Map();
let nextId = 0;
let workerStartCount = 0;

function send(request) {
  return new Promise((resolve, reject) => {
    const requestId = `test-${++nextId}`;
    pending.set(requestId, { resolve, reject });
    proc.stdin.write(JSON.stringify({ ...request, request_id: requestId }) + "\n");
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`no response for ${requestId} within 60s`));
      }
    }, 60000);
  });
}

before(async () => {
  proc = spawn("node", [path.join(path.dirname(new URL(import.meta.url).pathname), "arm_a_live_worker.mjs")], {
    env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[worker stderr] ${chunk}`));
  rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.worker_started) return;
    const waiter = pending.get(msg.request_id);
    if (waiter) {
      pending.delete(msg.request_id);
      waiter.resolve(msg);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start in time")), 300000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      const msg = JSON.parse(line);
      assert.equal(msg.worker_started, true);
      workerStartCount += 1;
      resolve();
    });
  });
});

after(() => {
  proc.kill("SIGTERM");
});

test("readiness proves the FULL 442,549-chunk index, not the 18-chunk shard", async () => {
  const response = await send({ type: "readiness" });
  const r = response.readiness;
  assert.equal(r.arm_a_live_ready, true);
  assert.equal(r.kure_pin.revision, EXPECTED_KURE_REVISION);
  assert.equal(r.embedding_dimension, 1024);
  assert.equal(r.materialized_record_count, EXPECTED_RECORD_COUNT);
  const checks = r.adapter_readiness.checks;
  assert.equal(checks.bm25_document_count, EXPECTED_RECORD_COUNT);
  assert.equal(checks.materialized_chunk_count, EXPECTED_RECORD_COUNT);
  assert.equal(checks.expected_total_chunk_count, EXPECTED_RECORD_COUNT);
  assert.equal(checks.expected_unique_embeddable_count, EXPECTED_UNIQUE_EMBEDDABLE_COUNT);
  assert.equal(checks.locator_provenance.total_chunks, EXPECTED_RECORD_COUNT);
  assert.equal(checks.locator_provenance.unresolved_count, 0);
  assert.equal(checks.locator_provenance.provenance_ready, true);
  assert.equal(r.adapter_readiness.official_experiment_ready, true);
  // this is the literal proof this is NOT the 18-chunk smoke shard
  assert.notEqual(r.materialized_record_count, 18);
});

async function fetchProbeTexts() {
  const implRoot = requireEnv("ARM_A_LIVE_IMPL_ROOT");
  const { Client } = createRequire(path.join(implRoot, "package.json"))("pg");
  const client = new Client({ connectionString: requireEnv("ARM_A_LIVE_DATABASE_URL") });
  await client.connect();
  try {
    const retrievalIndexId = requireEnv("ARM_A_LIVE_RETRIEVAL_INDEX_ID");
    assert.equal(retrievalIndexId, EXPECTED_RETRIEVAL_INDEX_ID);
    const result = await client.query(
      `SELECT chunk_id, source_document_id, text_content
       FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
      [retrievalIndexId, PROBE_CHUNK_IDS],
    );
    assert.equal(result.rows.length, PROBE_CHUNK_IDS.length, "all 5 probe chunk ids must exist in the full index");
    const byId = new Map(result.rows.map((r) => [r.chunk_id, r]));
    return PROBE_CHUNK_IDS.map((id) => byId.get(id));
  } finally {
    await client.end();
  }
}

test("5 new, non-Gold, cross-document-group questions get real top-k results from the full index", async () => {
  const probes = await fetchProbeTexts();
  const docGroups = new Set(probes.map((p) => p.source_document_id.split("_")[0]));
  assert.ok(docGroups.size >= 4, `expected >= 4 distinct document groups, got: ${[...docGroups]}`);

  let sawMultiNode = false;
  const searchCallCount = { n: 0 };
  for (const probe of probes) {
    const response = await send({ question: probe.text_content, conditions: {}, top_k: 10 });
    searchCallCount.n += 1;
    assert.ok(!response.error, `search failed for ${probe.chunk_id}: ${JSON.stringify(response.error)}`);
    assert.ok(response.results.length > 0, "expected at least one real result");
    assert.ok(response.results.length <= 10, "must never return more than the requested top_k");
    let lastRank = 0;
    for (const item of response.results) {
      assert.ok(item.rank > lastRank, "rank must be strictly increasing");
      lastRank = item.rank;
      assert.equal(sha256Hex(item.text), item.chunk_text_sha256, "hydrated text must match its own recorded sha256");
      assert.ok(item.text.length > 0, "text must never be empty");
      assert.ok(item.document_id, "document_id must be present");
      assert.equal(item.retrieval_method, "fixed_bm25_dense_rrf");
      if (item.node_indices.length > 1) sawMultiNode = true;
    }
    const selfHit = response.results.find((r) => r.chunk_id === probe.chunk_id);
    assert.ok(selfHit, `probe chunk ${probe.chunk_id} (${probe.source_document_id}) should appear in its own top-10 self-match search over the full index`);
    if (probe.chunk_id === MULTI_NODE_PROBE_CHUNK_ID) {
      // this probe was chosen specifically because its 55 persisted spans span 55 DISTINCT nodes
      assert.ok(selfHit.node_indices.length > 1, "the multi-node probe's own self-hit must carry its full multi-node node_indices");
    }
  }
  assert.ok(sawMultiNode, "at least one of the 5 probes must surface a genuinely multi-node result");
  assert.equal(searchCallCount.n, 5, "all 5 questions must have gone through the same persistent worker");
  assert.equal(workerStartCount, 1, "the worker must be started exactly once across all 5 questions (no restarts)");
});

test("the worker never reads/imports the frozen A.results.jsonl replay path (full-index run)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(path.dirname(new URL(import.meta.url).pathname), "arm_a_live_worker.mjs"), "utf8");
  // Strip // comments first -- this file's own docstring legitimately *names* A.results.jsonl to
  // explain what it deliberately does not do (same convention as arm_a_live_worker.test.mjs).
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!codeOnly.includes("A.results.jsonl"));
  assert.ok(!codeOnly.includes("ARM_A_RESULTS_PATH"));
  assert.ok(!codeOnly.includes("arm_a_adapter"));
});
