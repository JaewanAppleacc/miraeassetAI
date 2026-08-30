#!/usr/bin/env node
// Turn P5.1 CLI: analyzes Turn P5's already-built, 1,874,688-chunk portable
// snapshot for length/shape, exact-duplicate, and boilerplate-candidate
// signal, then compares 4 candidate retrieval-index strategies and writes a
// recommended plan. Never calls a real embedding API, never opens a
// database connection, never writes into the Turn P5 snapshot directory.
//
// Two subcommands:
//   run  --output-dir <dir> [--snapshot-dir <dir>]
//        One analysis pass. Used directly and as the child process the
//        `full` subcommand spawns for its determinism check.
//   full [--output-dir <dir>] [--skip-rebuild-check]
//        The complete Turn P5.1 flow: official analysis, an independent
//        rebuild-and-compare, and gate-status.v0.1.json.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRetrievalIndexPlan } from "../domain/agent-comparison/retrieval/index-planning/build-index-plan.mjs";
import { sha256Hex, canonicalizeExcluding, SCHEMA_VERSION } from "../domain/agent-comparison/retrieval/index-planning/contracts.mjs";
import { writeJsonFileAtomic } from "../domain/agent-comparison/retrieval/document-snapshot/snapshot-writer.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(THIS_FILE, "..", "..");

// The exact pins the Turn P5.1 task brief states for Turn P5's own output.
// A mismatch against the real, on-disk Turn P5 snapshot is fail-closed --
// see build-index-plan.mjs's verifyDeclaredPins().
const EXPECTED_PINS = Object.freeze({
  snapshotId: "docsnap_8e480ec27b33b15bada7b3e764df5385",
  totalDocuments: 4204,
  totalChunks: 1874688,
  documentChunksSha256: "4fa1ea1c97a550ce35b287164268ed22ae4bd02df357b0c24845604d92bf0b7b",
  documentRecordsSha256: "17ffa5dd661de8e61e42fffa55fcbac4679ce9f7a0b3c350fcb35c3055bd3f50",
  coverageStateCounts: { PRESENT: 4123, PARTIAL_PARSE_FAILURE: 79, PARSE_FAILED: 2 },
});

const CANONICAL_COMPARE_FILES = [
  "input-pin-manifest.v0.1.json",
  "chunk-length-analysis.v0.1.json",
  "exact-duplicate-analysis.v0.1.json",
  "boilerplate-candidate-analysis.v0.1.json",
  "embedding-size-scenarios.v0.1.json",
  "retrieval-index-strategy-comparison.v0.1.json",
  "recommended-index-plan.v0.1.json",
  "provenance-preservation-report.v0.1.json",
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; index += 1; }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function defaultSnapshotDir() {
  return join(REPO_ROOT, "work/domain-seed/document-retrieval-snapshot-v0.1");
}

async function runOnce(args) {
  const outputDir = resolve(args["output-dir"] ?? join(REPO_ROOT, "work/domain-seed/retrieval-index-analysis-v0.1"));
  const snapshotDir = resolve(args["snapshot-dir"] ?? defaultSnapshotDir());
  const completedAt = args["completed-at"] ?? new Date().toISOString();
  const result = await buildRetrievalIndexPlan({ snapshotDir, outputDir, expectedPins: EXPECTED_PINS, completedAt });
  return { outputDir, totalChunksStreamed: result.totalChunksStreamed, recomputedChunksSha256: result.recomputedChunksSha256 };
}

async function spawnChildRun(childArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--max-old-space-size=4096", THIS_FILE, "run", ...childArgs], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) { rejectPromise(new Error(`child analysis process exited with code ${code}`)); return; }
      try { resolvePromise(JSON.parse(stdout.trim().split("\n").pop())); }
      catch (error) { rejectPromise(new Error(`could not parse child analysis process output: ${error.message}`)); }
    });
  });
}

async function canonicalHashesForDir(dir) {
  const hashes = {};
  for (const name of CANONICAL_COMPARE_FILES) {
    const content = JSON.parse(await readFile(join(dir, name), "utf8"));
    hashes[name] = sha256Hex(canonicalizeExcluding(content, ["generated_at"]));
  }
  return hashes;
}

async function runFull(args) {
  const outputDir = resolve(args["output-dir"] ?? join(REPO_ROOT, "work/domain-seed/retrieval-index-analysis-v0.1"));
  process.stderr.write(`[P5.1] running official retrieval-index analysis into ${outputDir}\n`);
  const officialResult = await runOnce({ ...args, "output-dir": outputDir });
  process.stderr.write(`[P5.1] official analysis done: ${officialResult.totalChunksStreamed} chunks streamed\n`);
  const officialHashes = await canonicalHashesForDir(outputDir);

  let determinismReport;
  if (args["skip-rebuild-check"]) {
    determinismReport = { schema_version: SCHEMA_VERSION, status: "SKIPPED", reason: "--skip-rebuild-check passed" };
  } else {
    const scratchDir = await mkdtemp(join(tmpdir(), "p5-1-rebuild-check-"));
    process.stderr.write(`[P5.1] spawning independent rebuild process into scratch dir ${scratchDir}\n`);
    try {
      const forwarded = [];
      if (typeof args["snapshot-dir"] === "string") forwarded.push("--snapshot-dir", args["snapshot-dir"]);
      await spawnChildRun(["--output-dir", scratchDir, "--completed-at", "1970-01-01T00:00:00.000Z", ...forwarded]);
      const rebuildHashes = await canonicalHashesForDir(scratchDir);
      const mismatches = CANONICAL_COMPARE_FILES.filter((name) => officialHashes[name] !== rebuildHashes[name]);
      determinismReport = {
        schema_version: SCHEMA_VERSION,
        status: mismatches.length === 0 ? "PASS" : "FAIL",
        compared_files: CANONICAL_COMPARE_FILES,
        mismatched_files: mismatches,
        run_a_hashes: officialHashes,
        run_b_hashes: rebuildHashes,
        run_b_output_dir_note: "separate node process, separate scratch root; deleted after this comparison",
      };
    } finally {
      process.stderr.write(`[P5.1] deleting rebuild scratch dir ${scratchDir}\n`);
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
  await writeJsonFileAtomic(join(outputDir, "determinism-report.v0.1.json"), determinismReport);
  process.stderr.write(`[P5.1] determinism check: ${determinismReport.status}\n`);

  const gates = {
    input_pins_verified: { status: "PASS" }, // buildRetrievalIndexPlan already threw fail-closed if not
    full_corpus_streamed: { status: officialResult.totalChunksStreamed === EXPECTED_PINS.totalChunks ? "PASS" : "FAIL", total_chunks_streamed: officialResult.totalChunksStreamed },
    snapshot_sha_unchanged: { status: officialResult.recomputedChunksSha256 === EXPECTED_PINS.documentChunksSha256 ? "PASS" : "FAIL" },
    determinism: { status: determinismReport.status },
  };
  const overall = Object.values(gates).every((gate) => gate.status === "PASS" || gate.status === "SKIPPED") ? "INDEX_PLAN_READY_FOR_OWNER_SELECTION" : "BLOCKED";
  await writeJsonFileAtomic(join(outputDir, "gate-status.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    overall_status: overall,
    gates,
    actual_embedding_started: false,
    postgres_load_started: false,
    production_wiring: false,
    evaluation_accessed: false,
  });
  process.stderr.write(`[P5.1] overall gate status: ${overall}\n`);

  process.stdout.write(`${JSON.stringify({ ...officialResult, determinismStatus: determinismReport.status, overallGateStatus: overall }, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const subcommand = args._[0];

if (subcommand === "run") {
  const result = await runOnce(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (subcommand === "full") {
  await runFull(args);
} else {
  process.stderr.write("usage: analyze-document-retrieval-index-v01.mjs <run|full> [--output-dir <dir>] [--snapshot-dir <dir>] [options]\n");
  process.exit(1);
}
