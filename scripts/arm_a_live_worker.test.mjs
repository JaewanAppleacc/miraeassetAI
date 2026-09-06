// Turn A-PLUS-QA-LIVE-RETRIEVER-V1 — real integration smoke for arm_a_live_worker.mjs.
//
// Real subprocess, real Postgres (scratch_repro), real running KURE-v1 embedding server, real
// small materialized shard (12 real documents / 18 real chunks, corpus_snapshot_id
// corpus_04750795e1a2d5c3_shard_val_12). No mocks. No Gold/DEV_TUNE/DEV_CHECK/HOLDOUT file is
// read anywhere in this file -- probe questions are pulled from the shard's own already-
// materialized chunk text, the same non-Gold probe pattern p11f0-shard-integration-smoke.mjs
// (in the separate Arm A repo) already uses.
//
// Run with the env vars documented in the plan / handoff, e.g.:
//   ARM_A_LIVE_IMPL_ROOT=... ARM_A_LIVE_DATABASE_URL=... ARM_A_LIVE_RETRIEVAL_INDEX_ID=... \
//   ARM_A_LIVE_LOAD_SESSION_ID=... ARM_A_LIVE_CORPUS_SNAPSHOT_ID=... \
//   ARM_A_LIVE_KURE_SERVER_URL=... ARM_A_LIVE_BM25_CACHE_DIR=... \
//     node --test scripts/arm_a_live_worker.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";
import path from "node:path";
import test, { after, before } from "node:test";

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

function send(request) {
  return new Promise((resolve, reject) => {
    const requestId = `test-${++nextId}`;
    pending.set(requestId, { resolve, reject });
    proc.stdin.write(JSON.stringify({ ...request, request_id: requestId }) + "\n");
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`no response for ${requestId} within 30s`));
      }
    }, 30000);
  });
}

before(async () => {
  const implRoot = requireEnv("ARM_A_LIVE_IMPL_ROOT");
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
  // wait for the unsolicited worker_started line
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start in time")), 60000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      const msg = JSON.parse(line);
      assert.equal(msg.worker_started, true);
      resolve();
    });
  });
  // access implRoot to silence unused-var lint in case of future refactors
  void implRoot;
});

after(() => {
  proc.kill("SIGTERM");
});

test("readiness reflects real infra state", async () => {
  const response = await send({ type: "readiness" });
  assert.equal(response.readiness.arm_a_live_ready, true);
  assert.equal(response.readiness.kure_pin.revision, "4ed4540949c70b7da2c74004a915e1f2d5e46e4f");
  assert.equal(response.readiness.embedding_dimension, 1024);
});

async function fetchProbeQuestions() {
  const implRoot = requireEnv("ARM_A_LIVE_IMPL_ROOT");
  const { Client } = createRequire(path.join(implRoot, "package.json"))("pg");
  const client = new Client({ connectionString: requireEnv("ARM_A_LIVE_DATABASE_URL") });
  await client.connect();
  try {
    const retrievalIndexId = requireEnv("ARM_A_LIVE_RETRIEVAL_INDEX_ID");
    const loadSessionId = requireEnv("ARM_A_LIVE_LOAD_SESSION_ID");
    // pick one genuinely multi-node chunk (>1 distinct order_index in its persisted spans) and
    // two single/low-span chunks, all from this shard's own real, already-materialized content.
    const multiNode = await client.query(
      `SELECT c.chunk_id, c.text_content
       FROM disclosure_reference.reference_retrieval_chunks c
       JOIN disclosure_reference.reference_fixed_kure_chunk_staging s
         ON s.chunk_id = c.chunk_id AND s.load_session_id = $2
       WHERE c.retrieval_index_id = $1 AND jsonb_array_length(s.source_spans) > 1
       ORDER BY jsonb_array_length(s.source_spans) DESC LIMIT 1`,
      [retrievalIndexId, loadSessionId],
    );
    const others = await client.query(
      `SELECT chunk_id, text_content FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND chunk_id != $2 ORDER BY chunk_id LIMIT 2`,
      [retrievalIndexId, multiNode.rows[0]?.chunk_id ?? ""],
    );
    assert.ok(multiNode.rows.length > 0, "expected at least one multi-node chunk in this shard");
    return [multiNode.rows[0], ...others.rows].map((r) => ({
      question: r.text_content, chunkId: r.chunk_id,
    }));
  } finally {
    await client.end();
  }
}

test("3+ arbitrary non-Gold questions get real top-k results with verified real text", async () => {
  const probes = await fetchProbeQuestions();
  assert.ok(probes.length >= 3, "need at least 3 real probe questions");
  let sawMultiNode = false;
  for (const probe of probes) {
    const response = await send({ question: probe.question, conditions: {}, top_k: 5 });
    assert.ok(!response.error, `search failed for probe ${probe.chunkId}: ${JSON.stringify(response.error)}`);
    assert.ok(response.results.length <= 5, "must never return more than the requested top_k");
    assert.ok(response.results.length > 0, "expected at least one real result");
    let lastRank = 0;
    for (const item of response.results) {
      assert.ok(item.rank > lastRank, "rank must be strictly increasing (A's own order preserved)");
      lastRank = item.rank;
      assert.equal(sha256Hex(item.text), item.chunk_text_sha256, "hydrated text must match its own recorded sha256");
      assert.ok(item.text.length > 0, "text must never be empty");
      if (item.node_indices.length > 1) sawMultiNode = true;
    }
    // the probe's own chunk should be found near the top of its own self-match search
    const selfHit = response.results.find((r) => r.chunk_id === probe.chunkId);
    assert.ok(selfHit, `probe chunk ${probe.chunkId} should appear in its own top-5 self-match search`);
  }
  assert.ok(sawMultiNode, "at least one probe must surface a genuinely multi-node chunk (node_indices.length > 1)");
});

test("the worker never reads/imports the frozen A.results.jsonl replay path", async () => {
  const workerSource = await (await import("node:fs/promises")).readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), "arm_a_live_worker.mjs"), "utf8");
  // Check actual code lines only (strip // comments) -- the module docstring at the top of this
  // very test file, and of arm_a_live_worker.mjs itself, legitimately *names* A.results.jsonl to
  // explain what this live path deliberately does not do; that is not a violation.
  const codeOnly = workerSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!codeOnly.includes("A.results.jsonl"));
  assert.ok(!codeOnly.includes("ARM_A_RESULTS_PATH"));
  assert.ok(!codeOnly.includes("arm_a_adapter"));
});
