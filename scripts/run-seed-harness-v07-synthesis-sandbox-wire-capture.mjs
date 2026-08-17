// Re-runs the real Evaluation Harness against the SAME v0.17 Gold, over a
// REAL running HTTP server (identical call profile to
// scripts/run-seed-harness-v05.mjs / v06: timeout_ms=300000, concurrency=1,
// retries=2), for the P0/P1/P2-remediated Response Composer. This is a
// SANDBOX_EXPLORATION run, NOT a FLOW_SELECTION/DEV_TUNE milestone
// execution -- it never touches the shared/official usage ledger, and it
// writes to entirely NEW result/summary/lifecycle/ledger/config/receipt/
// wire-capture paths so the existing v05/v06 raw results are never
// overwritten or mutated.
//
// Unlike v05/v06, this run ALSO independently captures the raw wire
// response body for all 25 questions (a second, separate GET /answer call
// per question, issued AFTER the Harness run completes, against the same
// still-running server) so the actual answer text behind each Harness
// record can be audited after the fact -- the Harness result JSONL itself
// only stores raw_response_sha256, not the body. The captured file's own
// SHA-256 is cross-checked against the Harness record's raw_response_sha256
// for all 25 questions; this only holds if the system is fully
// deterministic for the same question/question_id pair (no randomness, no
// timestamps in the answer body), so a mismatch here would itself be a
// real finding, not just tooling noise.
//
// This run is expected to be executed against an intentionally dirty
// worktree (the synthesis modules are uncommitted per this turn's no-
// commit constraint), so it always passes --allow-dirty and its own
// receipt records release_eligible:false -- it is a regression/audit
// artifact, never a Release Gate input.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHarness } from "../domain/evaluation-harness/harness-runner.mjs";
import { assertReproducibleSourceTree, DirtySourceTreeError } from "../domain/evaluation-harness/source-tree-guard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_AT = new Date().toISOString();
const PORT = Number(process.env.SEED_HARNESS_PORT ?? 8744);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const LIFECYCLE_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-lifecycle.sandbox-only.json");
const LEDGER_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-usage-ledger.sandbox-only.jsonl");
const RESULT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.v0.1.jsonl");
const SUMMARY_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.v0.1.summary.json");
const RUN_CONFIG_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-run-config.sandbox-only.json");
const RECEIPT_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-run-receipt.sandbox-only.json");
const WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire");
const WIRE_INDEX_PATH = path.join(WIRE_DIR, "index.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function captureWireResponses(gold) {
  await mkdir(WIRE_DIR, { recursive: true });
  const index = [];
  for (const record of gold) {
    const url = new URL("/answer", BASE_URL);
    url.searchParams.set("question", record.question);
    url.searchParams.set("question_id", record.question_id);
    const response = await fetch(url);
    const raw = Buffer.from(await response.arrayBuffer());
    const relativePath = `work/domain-seed/seed-harness-v07-wire/${record.question_id}.response.json`;
    await writeFile(path.join(REPO, relativePath), raw);
    index.push({ question_id: record.question_id, http_status: response.status, path: relativePath, raw_sha256: sha256(raw) });
  }
  return index;
}

function crossCheckWireShas(harnessRecords, wireIndex) {
  const wireByQuestionId = new Map(wireIndex.map((entry) => [entry.question_id, entry]));
  const mismatches = [];
  for (const record of harnessRecords) {
    const wireEntry = wireByQuestionId.get(record.question_id);
    if (!wireEntry) { mismatches.push({ question_id: record.question_id, reason: "no wire capture" }); continue; }
    if (record.raw_response_sha256 !== wireEntry.raw_sha256) {
      mismatches.push({ question_id: record.question_id, reason: "sha mismatch", harness_sha256: record.raw_response_sha256, wire_sha256: wireEntry.raw_sha256 });
    }
  }
  return mismatches;
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
  console.error(`Synthesis sandbox run (v07, wire capture): release_eligible=${sourceTree.release_eligible} (expected false -- comparison/audit run over uncommitted synthesis modules, never a Release Gate input).`);

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
    run_id: `seed-harness-v07-synthesis-sandbox-wire-capture-${randomUUID()}`,
  };
  config.configuration_sha256 = sha256(Buffer.from(JSON.stringify({ ...config, configuration_sha256: undefined })));
  await writeFile(RUN_CONFIG_PATH, `${JSON.stringify({ ...config, source_tree: sourceTree }, null, 2)}\n`, "utf8");

  const server = startServer();
  let summary;
  let wireIndex;
  let shaMismatches;
  try {
    await waitForReady(BASE_URL);
    ({ summary } = await runHarness(config));
    wireIndex = await captureWireResponses(gold);
    const harnessRecords = (await readFile(RESULT_PATH, "utf8")).trim().split("\n").map(JSON.parse);
    shaMismatches = crossCheckWireShas(harnessRecords, wireIndex);
    await writeFile(WIRE_INDEX_PATH, `${JSON.stringify({ generated_at: new Date().toISOString(), count: wireIndex.length, entries: wireIndex }, null, 2)}\n`, "utf8");
  } finally {
    await stopServer(server);
  }

  const receipt = {
    run_id: config.run_id,
    release_eligible: sourceTree.release_eligible,
    source_tree: sourceTree,
    config_path: RUN_CONFIG_PATH,
    summary,
    wire_capture: { dir: "work/domain-seed/seed-harness-v07-wire", index_path: "work/domain-seed/seed-harness-v07-wire/index.json", count: wireIndex.length },
    wire_sha_cross_check: { total: wireIndex.length, mismatches: shaMismatches.length, mismatch_detail: shaMismatches },
  };
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(receipt, null, 2));

  if (shaMismatches.length > 0) {
    console.error(`FAIL: ${shaMismatches.length} wire SHA-256 mismatch(es) between the Harness run and the independently-captured wire responses.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
