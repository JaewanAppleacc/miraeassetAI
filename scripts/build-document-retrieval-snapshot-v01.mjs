#!/usr/bin/env node
// Turn P5 CLI: builds the portable DocumentIR retrieval snapshot for A's
// full 4,204-document corpus (domain/HANDOFF.md), then runs the
// determinism-rebuild check (a genuinely separate `node` process, a second
// full pass over the same corpus into a scratch directory), the P4
// DOCUMENT_CHUNK compatibility check, and a fake-embedding-adapter
// feasibility smoke -- writing all 10 required snapshot artifacts.
//
// Two subcommands:
//   run  --output-dir <dir> [--inventory ..] [--source-dir ..] [--manifest ..] [--no-expected-totals]
//        One build pass only. Used both directly and as the child process
//        the `full` subcommand spawns for its determinism check.
//   full [--output-dir <dir>] [--skip-rebuild-check]
//        The complete Turn P5 flow described above.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocumentRetrievalSnapshot } from "../domain/agent-comparison/retrieval/document-snapshot/build-snapshot.mjs";
import { writeJsonFileAtomic } from "../domain/agent-comparison/retrieval/document-snapshot/snapshot-writer.mjs";
import { toP4DocumentChunkRecord } from "../domain/agent-comparison/retrieval/document-snapshot/p4-document-chunk-adapter.mjs";
import { CHUNK_ID_PATTERN, CORP_CODE_PATTERN, DOCUMENT_ID_PATTERN } from "../domain/agent-comparison/retrieval/document-snapshot/contracts.mjs";
import { createDeterministicFakeEmbeddingAdapter } from "../domain/agent-comparison/retrieval/fake-deterministic-embedding-adapter.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(THIS_FILE, "..", "..");

// Fixed, real-corpus expectations (domain/HANDOFF.md's own numbers) --
// applied only by the `full` flow's official build, never by a fixture test
// (which passes its own smaller expectations, or none, directly to
// buildDocumentRetrievalSnapshot).
const REAL_CORPUS_EXPECTED_TOTALS = Object.freeze({
  total_documents: 4204,
  doc_groups: { periodic: 1054, major: 598, exchange: 1469, holding: 1083 },
  coverage_states: { PRESENT: 4123, PARTIAL_PARSE_FAILURE: 79, PARSE_FAILED: 2 },
});

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function defaultInputs() {
  return {
    inventoryPath: join(REPO_ROOT, "work/a-document-ir/inventory.json"),
    sourceDir: join(REPO_ROOT, "work/a-document-ir/source"),
    manifestPath: join(REPO_ROOT, "work/a-document-ir/manifest.jsonl"),
  };
}

async function runOnce(args) {
  const defaults = defaultInputs();
  const outputDir = resolve(args["output-dir"] ?? join(REPO_ROOT, "work/domain-seed/document-retrieval-snapshot-v0.1"));
  const inventoryPath = resolve(args.inventory ?? defaults.inventoryPath);
  const sourceDir = resolve(args["source-dir"] ?? defaults.sourceDir);
  const manifestPath = resolve(args.manifest ?? defaults.manifestPath);
  const expectedTotals = args["no-expected-totals"] ? null : REAL_CORPUS_EXPECTED_TOTALS;
  const completedAt = args["completed-at"] ?? new Date().toISOString();

  const result = await buildDocumentRetrievalSnapshot({
    inventoryPath,
    sourceDir,
    manifestPath,
    outputDir,
    expectedTotals,
    completedAt,
  });
  return { ...result, outputDir };
}

async function spawnChildRun(childArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--max-old-space-size=4096", THIS_FILE, "run", ...childArgs], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`child build process exited with code ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim().split("\n").pop()));
      } catch (error) {
        rejectPromise(new Error(`could not parse child build process output: ${error.message}`));
      }
    });
  });
}

async function readFirstNLines(path, n) {
  const lines = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines.push(JSON.parse(line));
    if (lines.length >= n) { rl.close(); break; }
  }
  return lines;
}

// Streams every chunk row and checks it converts into a P4
// reference_retrieval_chunks-shaped DOCUMENT_CHUNK row that would satisfy
// every CHECK constraint 003_reference_vector_retrieval.sql declares --
// without ever opening a database connection.
async function checkP4Compatibility(chunksPath) {
  const retrievalIndexId = "retrieval_index_p5_compat_check_0000000000000000000000000000000";
  const seenChunkIds = new Set();
  const seenRecordKeys = new Set();
  let checked = 0;
  const violations = [];

  const rl = createInterface({ input: createReadStream(chunksPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const snapshotChunk = JSON.parse(line);
    const p4Record = toP4DocumentChunkRecord({ retrievalIndexId, snapshotChunk });
    checked += 1;

    if (!CHUNK_ID_PATTERN.test(p4Record.chunk_id)) violations.push(`${snapshotChunk.chunk_id}: p4 chunk_id fails pattern`);
    if (p4Record.corp_code !== null && !CORP_CODE_PATTERN.test(p4Record.corp_code)) violations.push(`${snapshotChunk.chunk_id}: corp_code fails pattern`);
    if (!DOCUMENT_ID_PATTERN.test(p4Record.source_document_id)) violations.push(`${snapshotChunk.chunk_id}: source_document_id fails pattern`);
    if (typeof p4Record.text_content !== "string" || p4Record.text_content.length === 0) violations.push(`${snapshotChunk.chunk_id}: text_content empty`);
    if (!/^[0-9a-f]{64}$/.test(p4Record.text_sha256)) violations.push(`${snapshotChunk.chunk_id}: text_sha256 fails pattern`);
    if (p4Record.source_kind !== "DOCUMENT_CHUNK") violations.push(`${snapshotChunk.chunk_id}: source_kind is not DOCUMENT_CHUNK`);
    if (p4Record.evidence_id !== null) violations.push(`${snapshotChunk.chunk_id}: evidence_id must be null for DOCUMENT_CHUNK`);
    if (typeof p4Record.record_key !== "string" || p4Record.record_key === "") violations.push(`${snapshotChunk.chunk_id}: record_key empty`);
    if (seenChunkIds.has(p4Record.chunk_id)) violations.push(`${p4Record.chunk_id}: duplicate p4 chunk_id under one retrieval_index_id`);
    seenChunkIds.add(p4Record.chunk_id);
    if (seenRecordKeys.has(p4Record.record_key)) violations.push(`${p4Record.record_key}: duplicate record_key under one retrieval_index_id`);
    seenRecordKeys.add(p4Record.record_key);
    if (violations.length > 50) break; // enough evidence of a systemic problem; stop early
  }
  return { checked, violations, retrieval_index_id_used: retrievalIndexId };
}

async function checkFakeEmbeddingFeasibility(chunksPath, sampleSize = 50) {
  const sample = await readFirstNLines(chunksPath, sampleSize);
  if (sample.length === 0) return { sampled: 0, status: "SKIPPED_NO_CHUNKS" };
  const adapter = createDeterministicFakeEmbeddingAdapter({ dimension: 32 });
  const vectors = await adapter.embedDocuments(sample.map((chunk) => chunk.text_content));
  const orderPreserved = vectors.length === sample.length
    && vectors.every((vector) => Array.isArray(vector) && vector.length === 32 && vector.every((value) => Number.isFinite(value)));
  return { sampled: sample.length, dimension: 32, order_and_dimension_preserved: orderPreserved, status: orderPreserved ? "PASS" : "FAIL" };
}

function forwardableInputArgs(args) {
  const forwarded = [];
  for (const key of ["inventory", "source-dir", "manifest"]) {
    if (typeof args[key] === "string") forwarded.push(`--${key}`, args[key]);
  }
  if (args["no-expected-totals"]) forwarded.push("--no-expected-totals");
  return forwarded;
}

async function runFull(args) {
  const outputDir = resolve(args["output-dir"] ?? join(REPO_ROOT, "work/domain-seed/document-retrieval-snapshot-v0.1"));
  process.stderr.write(`[P5] building official snapshot into ${outputDir}\n`);
  const officialResult = await runOnce({ ...args, "output-dir": outputDir });
  process.stderr.write(`[P5] official build done: ${officialResult.totalDocuments} documents, ${officialResult.totalChunks} chunks\n`);

  let determinismReport;
  if (args["skip-rebuild-check"]) {
    determinismReport = { schema_version: "0.1.0", status: "SKIPPED", reason: "--skip-rebuild-check passed" };
  } else {
    const scratchDir = await mkdtemp(join(tmpdir(), "p5-rebuild-check-"));
    process.stderr.write(`[P5] spawning independent rebuild process into scratch dir ${scratchDir}\n`);
    try {
      const rebuildResult = await spawnChildRun([
        "--output-dir", scratchDir,
        "--completed-at", "1970-01-01T00:00:00.000Z",
        ...forwardableInputArgs(args),
      ]);
      const same = officialResult.snapshotId === rebuildResult.snapshotId
        && officialResult.canonicalManifestSha256 === rebuildResult.canonicalManifestSha256
        && officialResult.documentRecordsSha256 === rebuildResult.documentRecordsSha256
        && officialResult.documentChunksSha256 === rebuildResult.documentChunksSha256;
      determinismReport = {
        schema_version: "0.1.0",
        status: same ? "PASS" : "FAIL",
        run_a: { snapshot_id: officialResult.snapshotId, canonical_manifest_sha256: officialResult.canonicalManifestSha256, document_records_sha256: officialResult.documentRecordsSha256, document_chunks_sha256: officialResult.documentChunksSha256, output_dir: outputDir },
        run_b: { snapshot_id: rebuildResult.snapshotId, canonical_manifest_sha256: rebuildResult.canonicalManifestSha256, document_records_sha256: rebuildResult.documentRecordsSha256, document_chunks_sha256: rebuildResult.documentChunksSha256, output_dir: scratchDir, note: "separate node process, separate scratch root; deleted after this comparison" },
      };
    } finally {
      process.stderr.write(`[P5] deleting rebuild scratch dir ${scratchDir}\n`);
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
  await writeJsonFileAtomic(join(outputDir, "determinism-rebuild-report.v0.1.json"), determinismReport);
  process.stderr.write(`[P5] determinism check: ${determinismReport.status}\n`);

  process.stderr.write("[P5] checking P4 DOCUMENT_CHUNK compatibility over every chunk\n");
  const p4Check = await checkP4Compatibility(join(outputDir, "document-chunks.v0.1.jsonl"));
  const embeddingCheck = await checkFakeEmbeddingFeasibility(join(outputDir, "document-chunks.v0.1.jsonl"));
  const p4Report = {
    schema_version: "0.1.0",
    status: p4Check.violations.length === 0 ? "PASS" : "FAIL",
    chunks_checked: p4Check.checked,
    violations: p4Check.violations,
    retrieval_index_id_used_for_check: p4Check.retrieval_index_id_used,
    fake_embedding_feasibility: embeddingCheck,
    note: "No database connection was opened and no embedding vector was persisted -- this is a pure shape/constraint compatibility check plus an in-memory fake-embedding feasibility smoke.",
  };
  await writeJsonFileAtomic(join(outputDir, "p4-document-chunk-compatibility-report.v0.1.json"), p4Report);
  process.stderr.write(`[P5] P4 compatibility check: ${p4Report.status} (${p4Check.checked} chunks)\n`);

  const parseStatusReport = JSON.parse(await readFile(join(outputDir, "parse-status-report.v0.1.json"), "utf8"));
  const portabilityReport = JSON.parse(await readFile(join(outputDir, "portability-report.v0.1.json"), "utf8"));
  const expectedTotalsMatched = officialResult.totalDocuments === REAL_CORPUS_EXPECTED_TOTALS.total_documents
    && Object.entries(REAL_CORPUS_EXPECTED_TOTALS.doc_groups).every(([group, expected]) => officialResult.groupCounts[group] === expected)
    && Object.entries(REAL_CORPUS_EXPECTED_TOTALS.coverage_states).every(([state, expected]) => officialResult.coverageCounts[state] === expected);

  const gates = {
    full_corpus_processed: { status: expectedTotalsMatched ? "PASS" : "FAIL", detail: { total_documents: officialResult.totalDocuments, doc_group_counts: officialResult.groupCounts, coverage_state_counts: officialResult.coverageCounts } },
    parse_status_report_written: { status: parseStatusReport.total_documents === officialResult.totalDocuments ? "PASS" : "FAIL" },
    portability: { status: portabilityReport.status },
    determinism_rebuild: { status: determinismReport.status },
    p4_document_chunk_compatibility: { status: p4Report.status },
  };
  const overall = Object.values(gates).every((gate) => gate.status === "PASS" || gate.status === "SKIPPED") ? "GATE_PASSED" : "GATE_FAILED";
  await writeJsonFileAtomic(join(outputDir, "gate-status.v0.1.json"), {
    schema_version: "0.1.0",
    snapshot_id: officialResult.snapshotId,
    overall_status: overall,
    gates,
  });
  process.stderr.write(`[P5] overall gate status: ${overall}\n`);

  process.stdout.write(`${JSON.stringify({ ...officialResult, determinismStatus: determinismReport.status, p4CompatStatus: p4Report.status, overallGateStatus: overall }, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const subcommand = args._[0];

if (subcommand === "run") {
  const result = await runOnce(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (subcommand === "full") {
  await runFull(args);
} else {
  process.stderr.write("usage: build-document-retrieval-snapshot-v01.mjs <run|full> [--output-dir <dir>] [options]\n");
  process.exit(1);
}
