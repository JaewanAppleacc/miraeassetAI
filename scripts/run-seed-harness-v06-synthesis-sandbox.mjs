// Re-runs the real Evaluation Harness against the SAME v0.17 Gold, over a
// REAL running HTTP server (identical call profile to
// scripts/run-seed-harness-v05.mjs: timeout_ms=300000, concurrency=1,
// retries=2), specifically to measure the effect of the new common
// Response Composer (domain/flows/synthesis/*.mjs) introduced on top of
// thin-structured-flow.mjs. This is a SANDBOX_EXPLORATION run, NOT a
// FLOW_SELECTION/DEV_TUNE milestone execution -- it never touches the
// shared/official usage ledger, and it writes to entirely NEW result/
// summary/lifecycle/ledger/config/receipt paths so the existing v05 raw
// results (work/domain-seed/seed-thin-flow-harness-v05.v0.1.*) are never
// overwritten or mutated.
//
// This run is expected to be executed against an intentionally dirty
// worktree (the synthesis modules are uncommitted per this turn's no-
// commit constraint), so it always passes --allow-dirty and its own
// receipt records release_eligible:false -- it is a regression
// comparison artifact, never a Release Gate input.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "../domain/evaluation-harness/harness-runner.mjs";
import { assertReproducibleSourceTree, DirtySourceTreeError } from "../domain/evaluation-harness/source-tree-guard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_AT = new Date().toISOString();
const PORT = Number(process.env.SEED_HARNESS_PORT ?? 8740);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const LIFECYCLE_PATH = path.join(REPO, "work/domain-seed/seed-harness-v06-synthesis-sandbox-lifecycle.sandbox-only.json");
const LEDGER_PATH = path.join(REPO, "work/domain-seed/seed-harness-v06-synthesis-sandbox-usage-ledger.sandbox-only.jsonl");
const RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v06-synthesis-sandbox.v0.1.jsonl");
const SUMMARY_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v06-synthesis-sandbox.v0.1.summary.json");
const RUN_CONFIG_PATH = path.join(REPO, "work/domain-seed/seed-harness-v06-synthesis-sandbox-run-config.sandbox-only.json");
const RECEIPT_PATH = path.join(REPO, "work/domain-seed/seed-harness-v06-synthesis-sandbox-run-receipt.sandbox-only.json");

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
  let sourceTree;
  try {
    sourceTree = await assertReproducibleSourceTree({ cwd: REPO, allowDirty: true });
  } catch (error) {
    if (error instanceof DirtySourceTreeError) {
      console.error(error.message);
      console.error(JSON.stringify({ code: error.code, status_summary: error.statusLines }, null, 2));
    }
    throw error;
  }
  console.error(`Synthesis sandbox run: release_eligible=${sourceTree.release_eligible} (expected false -- this is a comparison run over uncommitted synthesis modules, never a Release Gate input).`);

  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map(JSON.parse);

  const lifecycle = gold.map((g) => ({
    schema_version: "0.1.0",
    assignment_id: g.question_id,
    assigned_split: "DEV_TUNE",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    holdout_lifecycle_status: "SEALED",
    updated_at: RUN_AT,
  }));
  await writeFile(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2) + "\n", "utf8");
  await writeFile(LEDGER_PATH, "", "utf8");

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
    timeout_ms: 300_000,
    concurrency: 1,
    retries: 2,
    git_commit: sourceTree.git_commit,
    run_id: `seed-harness-v06-synthesis-sandbox-${randomUUID()}`,
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
