// Versioned successor to run-seed-harness-v07-synthesis-sandbox-wire-capture.mjs
// (that script's own logic is otherwise unchanged and reused verbatim
// here -- HTTP-only real /answer calls against a freshly spawned agent
// server, SANDBOX_EXPLORATION profile, never touching the shared/official
// usage ledger). The ONLY difference: wire captures (and the harness
// result/summary/receipt) are written to a NEW, incrementing revision
// directory/filename set every run -- NEVER an in-place overwrite of a
// prior run's bytes. Before writing anything new, the CURRENT bare
// (legacy, pre-versioning) work/domain-seed/seed-harness-v07-wire/
// directory -- if present and not yet preserved -- is copied byte-for-
// byte into revision r1 so it is never silently lost. Every run after
// that gets the next integer revision. A per-question_id byte/text diff
// against the immediately-prior revision is always produced and saved,
// with both revisions' SHA-256 pinned in the diff report.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, cp, access } from "node:fs/promises";
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
const LEGACY_WIRE_DIR = path.join(REPO, "work/domain-seed/seed-harness-v07-wire");
const WIRE_ROOT = (rev) => path.join(REPO, `work/domain-seed/seed-harness-v07-wire.r${rev}`);
const RESULT_PATH = (rev) => path.join(REPO, `work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r${rev}.jsonl`);
const SUMMARY_PATH = (rev) => path.join(REPO, `work/domain-seed/seed-thin-flow-harness-v07-synthesis-sandbox.r${rev}.summary.json`);
const RECEIPT_PATH = (rev) => path.join(REPO, `work/domain-seed/seed-harness-v07-synthesis-sandbox-run-receipt.r${rev}.sandbox-only.json`);
const DIFF_PATH = (rev) => path.join(REPO, `work/domain-seed/seed-harness-v07-wire-diff.r${rev - 1}-to-r${rev}.json`);
const LIFECYCLE_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-lifecycle.sandbox-only.json");
const LEDGER_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-synthesis-sandbox-usage-ledger.sandbox-only.jsonl");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function determineRevisions() {
  const entries = await readdir(path.join(REPO, "work/domain-seed")).catch(() => []);
  const revisionNumbers = entries
    .map((name) => name.match(/^seed-harness-v07-wire\.r(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const highestExisting = revisionNumbers.length ? Math.max(...revisionNumbers) : 0;
  if (highestExisting === 0 && (await exists(LEGACY_WIRE_DIR))) {
    // First-ever versioned run: preserve the legacy in-place directory as
    // r1 (copy, never move -- the legacy path itself is left untouched
    // too, as its own historical artifact) before this run claims r2.
    await cp(LEGACY_WIRE_DIR, WIRE_ROOT(1), { recursive: true });
    return { priorRevision: 1, newRevision: 2 };
  }
  return { priorRevision: highestExisting || null, newRevision: highestExisting + 1 };
}

async function waitForReady(baseUrl, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) return;
      lastError = new Error(`GET /ready returned ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms: ${lastError?.message}`);
}
function startServer() {
  const child = spawn(process.execPath, [path.join(REPO, "scripts/start-agent-server.mjs")], {
    cwd: REPO, env: { ...process.env, PORT: String(PORT), AGENT_HOST: HOST }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  return child;
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5_000); });
}

async function captureWireResponses(gold, wireDir, wireDirRelative) {
  await mkdir(wireDir, { recursive: true });
  const index = [];
  for (const record of gold) {
    const url = new URL("/answer", BASE_URL);
    url.searchParams.set("question", record.question);
    url.searchParams.set("question_id", record.question_id);
    const response = await fetch(url);
    const raw = Buffer.from(await response.arrayBuffer());
    const relativePath = `${wireDirRelative}/${record.question_id}.response.json`;
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

// Minimal line-level diff (no external dependency): reports whether each
// question's answer text changed at all, and if so, which lines were
// added/removed -- sufficient for a human reviewer to see exactly what
// this turn's Runtime changes altered, without needing a full diff
// algorithm library.
function lineDiff(oldText, newText) {
  if (oldText === newText) return { changed: false, added_lines: [], removed_lines: [] };
  const oldLines = new Set(oldText.split("\n"));
  const newLines = new Set(newText.split("\n"));
  return {
    changed: true,
    added_lines: [...newLines].filter((l) => !oldLines.has(l)),
    removed_lines: [...oldLines].filter((l) => !newLines.has(l)),
  };
}

async function buildDiffReport(priorRevision, newRevision, gold) {
  if (!priorRevision) return { prior_revision: null, note: "no prior revision existed -- this is the first versioned run" };
  const items = [];
  for (const record of gold) {
    const priorPath = path.join(WIRE_ROOT(priorRevision), `${record.question_id}.response.json`);
    const newPath = path.join(WIRE_ROOT(newRevision), `${record.question_id}.response.json`);
    const [priorBytes, newBytes] = await Promise.all([readFile(priorPath).catch(() => null), readFile(newPath).catch(() => null)]);
    if (!priorBytes || !newBytes) { items.push({ question_id: record.question_id, error: "missing wire file on one side" }); continue; }
    const priorSha = sha256(priorBytes); const newSha = sha256(newBytes);
    let answerDiff = null;
    if (priorSha !== newSha) {
      try {
        const priorAnswer = JSON.parse(priorBytes.toString("utf8")).answer ?? "";
        const newAnswer = JSON.parse(newBytes.toString("utf8")).answer ?? "";
        answerDiff = lineDiff(priorAnswer, newAnswer);
      } catch { answerDiff = { changed: true, note: "could not parse one side as JSON" }; }
    }
    items.push({ question_id: record.question_id, prior_sha256: priorSha, new_sha256: newSha, byte_identical: priorSha === newSha, answer_diff: answerDiff });
  }
  return {
    prior_revision: priorRevision, new_revision: newRevision,
    prior_wire_dir: `work/domain-seed/seed-harness-v07-wire.r${priorRevision}`,
    new_wire_dir: `work/domain-seed/seed-harness-v07-wire.r${newRevision}`,
    total_items: items.length, changed_items: items.filter((i) => i.byte_identical === false).length,
    items,
  };
}

async function main() {
  let sourceTree;
  try { sourceTree = await assertReproducibleSourceTree({ cwd: REPO, allowDirty: true }); }
  catch (error) {
    if (error instanceof DirtySourceTreeError) {
      console.error(error.message);
      console.error(JSON.stringify({ code: error.code, status_summary: error.statusLines }, null, 2));
    }
    throw error;
  }
  console.error(`Synthesis sandbox run (v07, VERSIONED wire capture): release_eligible=${sourceTree.release_eligible} (expected false).`);

  const { priorRevision, newRevision } = await determineRevisions();
  const wireDirRelative = `work/domain-seed/seed-harness-v07-wire.r${newRevision}`;
  const wireDir = path.join(REPO, wireDirRelative);

  const gold = (await readFile(GOLD_PATH, "utf8")).trim().split("\n").map(JSON.parse);
  const lifecycle = gold.map((g) => ({
    schema_version: "0.1.0", assignment_id: g.question_id, assigned_split: "DEV_TUNE",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE", holdout_lifecycle_status: "SEALED", updated_at: RUN_AT,
  }));
  await writeFile(LIFECYCLE_PATH, JSON.stringify(lifecycle, null, 2) + "\n", "utf8");
  await writeFile(LEDGER_PATH, "", "utf8");

  const config = {
    base_url: BASE_URL, answer_path: "/answer", question_parameter: "question", question_id_parameter: "question_id",
    gold_path: GOLD_PATH, result_path: RESULT_PATH(newRevision), summary_path: SUMMARY_PATH(newRevision),
    lifecycle_path: LIFECYCLE_PATH, ledger_path: LEDGER_PATH, split: "SANDBOX", run_purpose: "SANDBOX_EXPLORATION",
    timeout_ms: 300_000, concurrency: 1, retries: 2, git_commit: sourceTree.git_commit,
    run_id: `seed-harness-v07-synthesis-sandbox-wire-capture-r${newRevision}-${randomUUID()}`,
  };
  config.configuration_sha256 = sha256(Buffer.from(JSON.stringify({ ...config, configuration_sha256: undefined })));

  const server = startServer();
  let summary; let wireIndex; let shaMismatches; let diffReport;
  try {
    await waitForReady(BASE_URL);
    ({ summary } = await runHarness(config));
    wireIndex = await captureWireResponses(gold, wireDir, wireDirRelative);
    const harnessRecords = (await readFile(RESULT_PATH(newRevision), "utf8")).trim().split("\n").map(JSON.parse);
    shaMismatches = crossCheckWireShas(harnessRecords, wireIndex);
    await writeFile(path.join(wireDir, "index.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), revision: newRevision, count: wireIndex.length, entries: wireIndex }, null, 2)}\n`, "utf8");
    diffReport = await buildDiffReport(priorRevision, newRevision, gold);
    await writeFile(DIFF_PATH(newRevision), `${JSON.stringify(diffReport, null, 2)}\n`, "utf8");
  } finally {
    await stopServer(server);
  }

  const receipt = {
    run_id: config.run_id, revision: newRevision, prior_revision: priorRevision,
    release_eligible: sourceTree.release_eligible, source_tree: sourceTree,
    summary,
    wire_capture: { dir: wireDirRelative, index_path: `${wireDirRelative}/index.json`, count: wireIndex.length },
    wire_sha_cross_check: { total: wireIndex.length, mismatches: shaMismatches.length, mismatch_detail: shaMismatches },
    diff_report_path: path.relative(REPO, DIFF_PATH(newRevision)),
    diff_summary: diffReport.prior_revision ? { changed_items: diffReport.changed_items, total_items: diffReport.total_items } : diffReport,
  };
  await writeFile(RECEIPT_PATH(newRevision), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
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
