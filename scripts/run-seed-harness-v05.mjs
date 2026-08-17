// Runs the real Evaluation Harness (domain/evaluation-harness/harness-runner.mjs)
// against the v0.5-promoted Seed Gold (v0.17 release) over a REAL running
// HTTP server (domain/runtime/node-agent-server.mjs, the real Node
// deployment adapter over the real process-wide configuredSeedRuntime
// singleton -- no in-process shortcuts). Official call profile per Codex
// review item 4: timeout_ms=300000, concurrency=1 (25 sequential calls),
// retries=2. This is a SANDBOX_EXPLORATION run (CLAUDE.md: "Seed는 배선·
// API·계약 검사에만 사용하고 전략 선택에 사용하지 않는다") -- explicitly NOT
// a FLOW_SELECTION/DEV_TUNE milestone execution, so it never touches any
// shared/official usage ledger: lifecycle_path/ledger_path both point at
// freshly-built, throwaway files scoped to this one run.
//
// SOURCE-TREE REPRODUCIBILITY (added after a Codex audit found this script
// recorded only `git rev-parse HEAD`, which does NOT guarantee the run is
// reproducible -- uncommitted tracked modifications, staged changes, or
// untracked source files all change what actually ran without changing
// HEAD). This script now calls assertReproducibleSourceTree() as its very
// first action, before the HTTP server is started and before the Usage
// Ledger/lifecycle files are written. By default a dirty worktree aborts
// the run entirely. Pass --allow-dirty (SANDBOX-only) to proceed anyway;
// the run's own config/receipt then records release_eligible:false and the
// exact source_tree_hash/status_summary that made it ineligible, never
// silently drops that fact.
//
// This script now also owns the HTTP server's full lifecycle itself
// (spawns domain/runtime/node-agent-server.mjs via scripts/start-agent-
// server.mjs, waits for /ready, always tears it down afterward) rather
// than assuming an operator started one out-of-band -- so "before the HTTP
// server starts" is a real, enforced ordering, not just a comment.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "../domain/evaluation-harness/harness-runner.mjs";
import { assertReproducibleSourceTree, DirtySourceTreeError } from "../domain/evaluation-harness/source-tree-guard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_AT = new Date().toISOString();
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const PORT = Number(process.env.SEED_HARNESS_PORT ?? 8739);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const LIFECYCLE_PATH = path.join(REPO, "work/domain-seed/seed-harness-v05-lifecycle.sandbox-only.json");
const LEDGER_PATH = path.join(REPO, "work/domain-seed/seed-harness-v05-usage-ledger.sandbox-only.jsonl");
const RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl");
const SUMMARY_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v05.v0.1.summary.json");
const RUN_CONFIG_PATH = path.join(REPO, "work/domain-seed/seed-harness-v05-run-config.sandbox-only.json");
const RECEIPT_PATH = path.join(REPO, "work/domain-seed/seed-harness-v05-run-receipt.sandbox-only.json");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function waitForReady(baseUrl, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
      lastError = new Error(`GET /ready returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms: ${lastError?.message}`);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(REPO, "scripts/start-agent-server.mjs")], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), AGENT_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5_000); });
}

async function main() {
  // 1) Source-tree reproducibility -- MUST run before anything else touches
  // the filesystem or the network (no server start, no ledger reservation).
  let sourceTree;
  try {
    sourceTree = await assertReproducibleSourceTree({ cwd: REPO, allowDirty: ALLOW_DIRTY });
  } catch (error) {
    if (error instanceof DirtySourceTreeError) {
      console.error(error.message);
      console.error(JSON.stringify({ code: error.code, status_summary: error.statusLines }, null, 2));
    }
    throw error;
  }
  if (!sourceTree.release_eligible) {
    console.error(`WARNING: proceeding with a non-reproducible source tree (--allow-dirty). release_eligible=false. This run is NOT valid for a Release Gate decision.`);
  }

  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map(JSON.parse);

  // Fresh, throwaway PROVISIONAL split-lifecycle covering exactly these 25
  // Seed question_ids -- makes them SANDBOX-eligible without claiming any
  // real DEV_TUNE/DEV_CHECK/HOLDOUT assignment or lock state.
  const lifecycle = gold.map((g) => ({
    schema_version: "0.1.0",
    assignment_id: g.question_id,
    assigned_split: "DEV_TUNE",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    holdout_lifecycle_status: "SEALED",
    updated_at: RUN_AT,
  }));
  await writeFile(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2) + "\n", "utf8");
  await writeFile(LEDGER_PATH, "", "utf8"); // empty durable ledger, this run's own throwaway file

  const config = {
    base_url: BASE_URL,
    answer_path: "/answer",
    question_parameter: "question",
    question_id_parameter: "question_id",
    gold_path: GOLD_PATH,
    result_path: RESULT_PATH,
    summary_path: SUMMARY_PATH,
    lifecycle_path: LIFECYCLE_PATH,
    ledger_path: LEDGER_PATH,
    split: "SANDBOX",
    run_purpose: "SANDBOX_EXPLORATION",
    // Official call profile (Codex review item 4).
    timeout_ms: 300_000,
    concurrency: 1,
    retries: 2,
    git_commit: sourceTree.git_commit,
    run_id: `seed-harness-v05-official-profile-${randomUUID()}`,
  };
  config.configuration_sha256 = sha256(JSON.stringify({ ...config, configuration_sha256: undefined }));
  await writeFile(RUN_CONFIG_PATH, `${JSON.stringify({ ...config, source_tree: sourceTree }, null, 2)}\n`, "utf8");

  const server = startServer();
  let summary;
  try {
    await waitForReady(BASE_URL);
    ({ summary } = await runHarness(config));
  } finally {
    await stopServer(server);
  }

  const receipt = {
    run_id: config.run_id,
    release_eligible: sourceTree.release_eligible,
    source_tree: sourceTree,
    config_path: RUN_CONFIG_PATH,
    summary,
  };
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
