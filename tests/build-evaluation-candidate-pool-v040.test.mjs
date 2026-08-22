// Turn N4.0.1: portable-path contract tests for
// scripts/build-evaluation-candidate-pool-v040.mjs, run against a tiny
// SYNTHETIC corpus (never the real, ungitted 4,204-doc corpus) so this
// suite runs unconditionally under npm run test:domain / verify:contracts,
// with no DISCLOSURE_CORPUS_ROOT dependency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(ROOT, "scripts/build-evaluation-candidate-pool-v040.mjs");

function manifestRow(overrides) {
  return {
    doc_id: "x", corp_code: "00000001", corp_name: "테스트기업", listed_name: "테스트기업",
    stock_code: "000000", industry: "IT", sector: "테스트섹터", doc_group: "exchange", doc_subtype: null,
    report_nm: "테스트보고서", is_correction: false, rcept_no: "20240101000001", rcept_dt: "20240101",
    flr_nm: "테스트기업", base_year: null, base_month: null, file_path: "raw/x", file_format: "xml", n_files: 1,
    ...overrides,
  };
}

const SYNTHETIC_MANIFEST = [
  manifestRow({ doc_id: "exchange_synth_contract", doc_subtype: "단일판매공급계약체결" }),
  manifestRow({ doc_id: "exchange_synth_correction", is_correction: true, report_nm: "[기재정정]공급계약" }),
];
const SYNTHETIC_RELATION_CANDIDATES = [
  { source_document_id: "exchange_synth_correction", relation_type: "AMENDS", candidates: [{ target_document_id: "exchange_synth_contract", score: 0.45 }] },
];

async function makeSyntheticCorpus() {
  const corpusDir = await mkdtemp(path.join(os.tmpdir(), "n4-0-1-synthetic-corpus-"));
  await writeFile(path.join(corpusDir, "manifest.jsonl"), `${SYNTHETIC_MANIFEST.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const relationQueuePath = path.join(corpusDir, "relation-review-queue.jsonl");
  await writeFile(relationQueuePath, `${SYNTHETIC_RELATION_CANDIDATES.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const parseCoveragePath = path.join(corpusDir, "document-parse-coverage.jsonl");
  await writeFile(parseCoveragePath, "", "utf8");
  return { corpusDir, relationQueuePath, parseCoveragePath };
}

async function runBuild(corpusDir, relationQueuePath, parseCoveragePath, outDir) {
  await mkdir(outDir, { recursive: true });
  await execFileAsync(process.execPath, [SCRIPT_PATH, corpusDir, relationQueuePath, parseCoveragePath, outDir], { cwd: ROOT });
  const manifestText = await readFile(path.join(outDir, "candidate-pool.v0.1.manifest.json"), "utf8");
  return JSON.parse(manifestText);
}

function collectStringLeaves(value, out = []) {
  if (typeof value === "string") { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStringLeaves(v, out); return out; }
  if (value && typeof value === "object") { for (const v of Object.values(value)) collectStringLeaves(v, out); return out; }
  return out;
}

let corpusDir, relationQueuePath, parseCoveragePath, outDirA, outDirB, manifestA, manifestB;
test.before(async () => {
  ({ corpusDir, relationQueuePath, parseCoveragePath } = await makeSyntheticCorpus());
  outDirA = await mkdtemp(path.join(os.tmpdir(), "n4-0-1-out-a-"));
  outDirB = await mkdtemp(path.join(os.tmpdir(), "n4-0-1-out-b-")); // a DIFFERENT temp root, deliberately
  manifestA = await runBuild(corpusDir, relationQueuePath, parseCoveragePath, outDirA);
  manifestB = await runBuild(corpusDir, relationQueuePath, parseCoveragePath, outDirB);
});
test.after(async () => {
  await Promise.all([corpusDir, outDirA, outDirB].map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the manifest contains zero absolute paths, zero home-directory paths, and zero '..' path segments anywhere", () => {
  const leaves = collectStringLeaves(manifestA);
  for (const value of leaves) {
    assert.doesNotMatch(value, /^\/Users\//, `found an absolute /Users/ path: ${value}`);
    assert.doesNotMatch(value, /^\/home\//, `found an absolute /home/ path: ${value}`);
    assert.doesNotMatch(value, new RegExp(`^${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `found a literal home-directory path: ${value}`);
    assert.doesNotMatch(value, /(^|\/)\.\.(\/|$)/, `found a '..' path segment: ${value}`);
    assert.ok(!path.isAbsolute(value) || !value.includes("/"), `found what looks like an absolute filesystem path: ${value}`);
  }
});

test("candidate_pool_path, relation_queue_source_path, and parse_coverage_source_path are all recorded as portable (non-absolute) strings", () => {
  assert.equal(path.isAbsolute(manifestA.candidate_pool_path), false);
  assert.equal(manifestA.candidate_pool_path, "candidate-pool.v0.1.jsonl");
  assert.ok(typeof manifestA.relation_queue_source_path === "string" || manifestA.relation_queue_source_path === null);
  assert.ok(typeof manifestA.parse_coverage_source_path === "string" || manifestA.parse_coverage_source_path === null);
});

test("generating the SAME logical Pool under two entirely different temp roots produces IDENTICAL portable path fields", () => {
  assert.equal(manifestA.candidate_pool_path, manifestB.candidate_pool_path);
  assert.equal(manifestA.manifest_source_relative_path, manifestB.manifest_source_relative_path);
  assert.notEqual(outDirA, outDirB, "sanity: the two output roots really are different machine paths");
});

test("the manifest never records the real corpus root path itself -- only manifest_sha256 and the corpus-relative constant", () => {
  assert.equal(manifestA.manifest_source_relative_path, "manifest.jsonl");
  assert.match(manifestA.manifest_sha256, /^[0-9a-f]{64}$/);
  const leaves = collectStringLeaves(manifestA);
  assert.ok(!leaves.some((v) => v.includes(corpusDir)), "the synthetic corpus's own tmp path must never appear in the manifest");
});

test("grouping_status/relation_basis/leakage_report_scope/official_split_eligible/chain_closure_required are present with the exact required values", () => {
  assert.equal(manifestA.grouping_status, "PROVISIONAL_HEURISTIC");
  assert.equal(manifestA.relation_basis, "TOP_CANDIDATE_PENDING_REVIEW");
  assert.equal(manifestA.leakage_report_scope, "CURRENT_PROVISIONAL_GRAPH_ONLY");
  assert.equal(manifestA.official_split_eligible, false);
  assert.equal(manifestA.chain_closure_required, true);
});

test("every assignment_id in the written Pool JSONL matches ^author_[0-9a-f]{24}$", async () => {
  const poolText = await readFile(path.join(outDirA, "candidate-pool.v0.1.jsonl"), "utf8");
  const rows = poolText.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.length > 0);
  for (const row of rows) assert.match(row.assignment_id, /^author_[0-9a-f]{24}$/);
});
