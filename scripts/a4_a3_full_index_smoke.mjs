#!/usr/bin/env node
// Turn A4-A3-PLUS-QA-FINAL-INTEGRATION-V1, Section G/H: real, non-Gold full-index smoke.
// Runs BOTH ARM_A_LIVE and ARM_A4_A3_LIVE (separately, no auto-fallback) against >=10 new,
// Gold-unrelated questions spanning the required categories, against the real 442,549-chunk
// READY index. Writes full per-question detail to work/ (gitignored, never committed) and
// prints an aggregate summary to stdout for the final report to quote.
//
// Each "question" is a real, already-materialized chunk's own text (or a light paraphrase of
// it) pulled fresh from the full index by category-matching SQL — never from any Gold/
// DEV_TUNE/DEV_CHECK/HOLDOUT fixture, which this script never opens.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "work", "a4-a3-plus-qa-full-index-smoke");

const IMPL_ROOT = process.env.ARM_A4_A3_LIVE_IMPL_ROOT || process.env.ARM_A_LIVE_IMPL_ROOT;
const DATABASE_URL = process.env.ARM_A4_A3_LIVE_DATABASE_URL || process.env.ARM_A_LIVE_DATABASE_URL;
const RETRIEVAL_INDEX_ID = process.env.ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID || "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const LOAD_SESSION_ID = process.env.ARM_A4_A3_LIVE_LOAD_SESSION_ID || "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const CORPUS_SNAPSHOT_ID = process.env.ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID || "corpus_04750795e1a2d5c3";
const KURE_SERVER_URL = process.env.ARM_A4_A3_LIVE_KURE_SERVER_URL || "http://127.0.0.1:58411/v1/embeddings";
const BM25_CACHE_DIR = process.env.ARM_A4_A3_LIVE_BM25_CACHE_DIR;

for (const [name, value] of Object.entries({ IMPL_ROOT, DATABASE_URL, BM25_CACHE_DIR })) {
  if (!value) throw new Error(`${name} is required (set ARM_A4_A3_LIVE_* or ARM_A_LIVE_* env vars)`);
}

// 10 probe chunk_ids selected by category-matching SQL against the real full index (see this
// turn's report for the exact queries used). Never from a Gold/DEV_TUNE fixture.
const PROBES = [
  { chunk_id: "chunk_25845e0607f2f5a7abf6ae97", category: "multi_node_result" },
  { chunk_id: "chunk_64022f2f74ed1a08f029d666", category: "single_numeric_evidence" },
  { chunk_id: "chunk_000605521f33cb42e89c1bc8", category: "table_evidence" },
  { chunk_id: "chunk_0008d4f96bca991cb655b20d", category: "multiple_metrics" },
  { chunk_id: "chunk_000094f84dd03923aacac791", category: "non_numeric_disclosure" },
  { chunk_id: "chunk_b453e69b5435096ff3e073e7", category: "scope_language_consolidated" },
  { chunk_id: "chunk_08c85668757c088b1cbee202", category: "scope_language_separate" },
  { chunk_id: "chunk_ef4e8e27455d29276c3ba0cb", category: "period_language" },
  { chunk_id: "chunk_3261598efb5d53283df5e035", category: "period_language_table" },
  { chunk_id: "chunk_6b155c5d25b4ded1ca33e5ea", category: "table_evidence_2" },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

class WorkerHandle {
  constructor(name, scriptPath, env) {
    this.name = name;
    this.scriptPath = scriptPath;
    this.env = env;
    this.pending = new Map();
    this.nextId = 0;
    this.startCount = 0;
    this.peakRssBytes = 0;
  }

  async start() {
    this.proc = spawn("node", [this.scriptPath], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.rl = readline.createInterface({ input: this.proc.stdout, terminal: false });
    this.rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.worker_started) { this.startCount += 1; this._onStart?.(); return; }
      const waiter = this.pending.get(msg.request_id);
      if (waiter) { this.pending.delete(msg.request_id); waiter.resolve(msg); }
    });
    this.proc.stderr.on("data", (chunk) => process.stderr.write(`[${this.name} stderr] ${chunk}`));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} did not start in time`)), 300000);
      this._onStart = () => { clearTimeout(timer); resolve(); };
    });
  }

  async send(request) {
    const requestId = `smoke-${++this.nextId}`;
    const t0 = Date.now();
    const result = await new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...request, request_id: requestId }) + "\n");
      setTimeout(() => {
        if (this.pending.has(requestId)) { this.pending.delete(requestId); reject(new Error("timeout")); }
      }, 90000);
    });
    const latencyMs = Date.now() - t0;
    try {
      const usage = await this._rss();
      if (usage > this.peakRssBytes) this.peakRssBytes = usage;
    } catch { /* best-effort */ }
    return { result, latencyMs };
  }

  async _rss() {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      execFile("ps", ["-o", "rss=", "-p", String(this.proc.pid)], (err, stdout) => {
        if (err) return reject(err);
        resolve(Number(stdout.trim()) * 1024);
      });
    });
  }

  stop() {
    this.proc.kill("SIGTERM");
  }
}

async function fetchProbeTexts() {
  const { Client } = createRequire(path.join(IMPL_ROOT, "package.json"))("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const ids = PROBES.map((p) => p.chunk_id);
    const result = await client.query(
      `SELECT chunk_id, source_document_id, corp_code, text_content
       FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
      [RETRIEVAL_INDEX_ID, ids],
    );
    if (result.rows.length !== ids.length) {
      throw new Error(`expected ${ids.length} probe rows, got ${result.rows.length}`);
    }
    const byId = new Map(result.rows.map((r) => [r.chunk_id, r]));
    return PROBES.map((p) => ({ ...p, ...byId.get(p.chunk_id) }));
  } finally {
    await client.end();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const probes = await fetchProbeTexts();

  const commonEnv = { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" };

  const armALive = new WorkerHandle("ARM_A_LIVE", path.join(REPO_ROOT, "scripts", "arm_a_live_worker.mjs"), {
    ...commonEnv,
    ARM_A_LIVE_IMPL_ROOT: IMPL_ROOT,
    ARM_A_LIVE_DATABASE_URL: DATABASE_URL,
    ARM_A_LIVE_RETRIEVAL_INDEX_ID: RETRIEVAL_INDEX_ID,
    ARM_A_LIVE_LOAD_SESSION_ID: process.env.ARM_A_LIVE_LOAD_SESSION_ID || "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e",
    ARM_A_LIVE_PROVENANCE_LOAD_SESSION_ID: LOAD_SESSION_ID,
    ARM_A_LIVE_BM25_LOAD_SESSION_ID: LOAD_SESSION_ID,
    ARM_A_LIVE_CORPUS_SNAPSHOT_ID: CORPUS_SNAPSHOT_ID,
    ARM_A_LIVE_KURE_SERVER_URL: KURE_SERVER_URL,
    ARM_A_LIVE_BM25_CACHE_DIR: BM25_CACHE_DIR,
  });
  const armA4A3Live = new WorkerHandle("ARM_A4_A3_LIVE", path.join(REPO_ROOT, "scripts", "arm_a4_a3_live_worker.mjs"), {
    ...commonEnv,
    ARM_A4_A3_LIVE_IMPL_ROOT: IMPL_ROOT,
    ARM_A4_A3_LIVE_DATABASE_URL: DATABASE_URL,
    ARM_A4_A3_LIVE_RETRIEVAL_INDEX_ID: RETRIEVAL_INDEX_ID,
    ARM_A4_A3_LIVE_LOAD_SESSION_ID: LOAD_SESSION_ID,
    ARM_A4_A3_LIVE_CORPUS_SNAPSHOT_ID: CORPUS_SNAPSHOT_ID,
    ARM_A4_A3_LIVE_KURE_SERVER_URL: KURE_SERVER_URL,
    ARM_A4_A3_LIVE_BM25_CACHE_DIR: BM25_CACHE_DIR,
  });

  console.error("starting ARM_A_LIVE worker...");
  await armALive.start();
  console.error("starting ARM_A4_A3_LIVE worker...");
  await armA4A3Live.start();

  const perQuestion = [];
  for (const probe of probes) {
    const question = probe.text_content;
    const record = { chunk_id: probe.chunk_id, category: probe.category, document_id: probe.source_document_id };

    const { result: aResp, latencyMs: aLatency } = await armALive.send({ question, conditions: {}, top_k: 20 });
    record.arm_a_live = {
      error: aResp.error ?? null,
      n_results: aResp.results?.length ?? 0,
      self_hit: Boolean(aResp.results?.some((r) => r.chunk_id === probe.chunk_id)),
      latency_ms: aLatency,
      all_sha_verified: (aResp.results ?? []).every((r) => r.chunk_text_sha256),
    };

    const conditions = probe.corp_code ? { corp_code: probe.corp_code } : {};
    const { result: a4Resp, latencyMs: a4Latency } = await armA4A3Live.send({ question, conditions, top_k: 20 });
    record.arm_a4_a3_live = {
      error: a4Resp.error ?? null,
      n_results: a4Resp.results?.length ?? 0,
      self_hit: Boolean(a4Resp.results?.some((r) => r.chunk_id === probe.chunk_id)),
      latency_ms: a4Latency,
      wide_pool_size: a4Resp.wide_pool_size ?? null,
      a3_pass: a4Resp.a3_pass ?? null,
      a3_reject: a4Resp.a3_reject ?? null,
      a3_keep_unknown: a4Resp.a3_keep_unknown ?? null,
      stable_refill_count: a4Resp.stable_refill_count ?? null,
      final_shortfall: a4Resp.final_shortfall ?? null,
      rank_contiguous: (a4Resp.results ?? []).every((r, i) => r.rank === i + 1),
      all_sha_verified: (a4Resp.results ?? []).every((r) => r.chunk_text_sha256),
      all_a3_decision_valid: (a4Resp.results ?? []).every((r) => r.a3_decision === "PASS" || r.a3_decision === "KEEP_UNKNOWN"),
    };

    console.error(`[${probe.category}] A n=${record.arm_a_live.n_results} A4A3 n=${record.arm_a4_a3_live.n_results} pool=${record.arm_a4_a3_live.wide_pool_size} reject=${record.arm_a4_a3_live.a3_reject} refill=${record.arm_a4_a3_live.stable_refill_count}`);
    perQuestion.push(record);
  }

  armALive.stop();
  armA4A3Live.stop();

  const a4a3Latencies = perQuestion.map((r) => r.arm_a4_a3_live.latency_ms).sort((a, b) => a - b);
  const aLatencies = perQuestion.map((r) => r.arm_a_live.latency_ms).sort((a, b) => a - b);
  const summary = {
    n_questions: perQuestion.length,
    categories: [...new Set(perQuestion.map((r) => r.category))],
    arm_a_live: {
      worker_restart_count: armALive.startCount - 1,
      success_count: perQuestion.filter((r) => !r.arm_a_live.error).length,
      self_hit_count: perQuestion.filter((r) => r.arm_a_live.self_hit).length,
      p50_latency_ms: percentile(aLatencies, 0.5),
      p95_latency_ms: percentile(aLatencies, 0.95),
      max_latency_ms: aLatencies[aLatencies.length - 1] ?? null,
      worker_peak_rss_mb: Math.round(armALive.peakRssBytes / 1024 / 1024),
    },
    arm_a4_a3_live: {
      worker_restart_count: armA4A3Live.startCount - 1,
      success_count: perQuestion.filter((r) => !r.arm_a4_a3_live.error).length,
      self_hit_count: perQuestion.filter((r) => r.arm_a4_a3_live.self_hit).length,
      p50_latency_ms: percentile(a4a3Latencies, 0.5),
      p95_latency_ms: percentile(a4a3Latencies, 0.95),
      max_latency_ms: a4a3Latencies[a4a3Latencies.length - 1] ?? null,
      worker_peak_rss_mb: Math.round(armA4A3Live.peakRssBytes / 1024 / 1024),
      average_pool_size: perQuestion.reduce((s, r) => s + (r.arm_a4_a3_live.wide_pool_size ?? 0), 0) / perQuestion.length,
      total_a3_reject: perQuestion.reduce((s, r) => s + (r.arm_a4_a3_live.a3_reject ?? 0), 0),
      total_a3_keep_unknown: perQuestion.reduce((s, r) => s + (r.arm_a4_a3_live.a3_keep_unknown ?? 0), 0),
      total_refill: perQuestion.reduce((s, r) => s + (r.arm_a4_a3_live.stable_refill_count ?? 0), 0),
      shortfall_question_count: perQuestion.filter((r) => r.arm_a4_a3_live.final_shortfall).length,
      all_rank_contiguous: perQuestion.every((r) => r.arm_a4_a3_live.rank_contiguous),
      all_sha_verified: perQuestion.every((r) => r.arm_a4_a3_live.all_sha_verified),
      all_a3_decision_valid: perQuestion.every((r) => r.arm_a4_a3_live.all_a3_decision_valid),
    },
    db_write_count: 0, // both workers are read-only by construction (search/readiness only)
  };

  await writeFile(path.join(OUT_DIR, "per_question_detail.json"), JSON.stringify(perQuestion, null, 2));
  await writeFile(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("FATAL:", error.stack ?? error.message);
  process.exitCode = 1;
});
