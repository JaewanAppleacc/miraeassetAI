// Turn P8, Section H/J-stage1: proves the resumable loader's DISCOVERY
// phase does not hold memory proportional to input size. Runs discovery
// (in a child process, so each measurement starts from a clean heap) over
// two synthetic JSONL fixtures of very different sizes and asserts peak
// RSS grows far more slowly than the input does -- the "clearly lower peak
// RSS than the old full-Map loader, and no linear growth" contract from
// the Turn P8 task brief. This is a comparative/shape assertion (Section H
// explicitly says not to pin an absolute number as the contract), not a
// hard byte budget.
//
//   DATABASE_URL='postgresql://user:pass@host:5432/scratch_db' \
//     npm run test:resumable-dedup-loader:bounded-memory:postgres16
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHILD_SCRIPT = path.join(ROOT, "scripts", "measure-discovery-memory-child-v01.mjs");

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function chunkLine(i) {
  const text = `synthetic bounded-memory fixture text number ${i} with some extra padding to be realistic ${sha256Hex(String(i)).slice(0, 16)}`;
  return JSON.stringify({
    chunk_id: `chunk_${String(i).padStart(24, "0")}`, source_document_id: `exchange_${String(1000000 + i).padStart(14, "0")}`,
    corp_code: String(10000000 + (i % 500)).padStart(8, "0"), source_group: "exchange", document_type: "test",
    node_id: `doc${i}::a.xml::n0`, source_locator: `doc${i}/a.xml#node=0`, parse_status: "SUCCESS",
    chunk_ordinal: 0, char_start: 0, char_end: text.length, text_content: text, text_sha256: sha256Hex(text),
    metadata: { block_type: "PARAGRAPH" },
  });
}

async function writeFixture(lineCount) {
  const dir = await mkdtemp(path.join(tmpdir(), "dedup-loader-memtest-"));
  const filePath = path.join(dir, "chunks.jsonl");
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) lines.push(chunkLine(i));
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return { dir, filePath };
}

function runChildDiscovery({ databaseUrl, chunksFilePath, snapshotId }) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [], {
      env: { ...process.env, DATABASE_URL: databaseUrl, CHUNKS_FILE_PATH: chunksFilePath, SNAPSHOT_ID: snapshotId },
      execArgv: ["--expose-gc"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`child discovery process exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()));
      } catch {
        reject(new Error(`could not parse child output: ${stdout}\n${stderr}`));
      }
    });
    child.on("error", reject);
  });
}

test("discovery peak RSS does not grow linearly with input size (12x more lines yields far less than 12x more peak RSS)", async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRESQL_16_INTEGRATION_NOT_RUN: DATABASE_URL is required to run tests/reference-dedup-resumable-loader-bounded-memory-postgres16-integration.test.mjs. "
      + "Run: node scripts/run-with-scratch-postgres16.mjs -- npm run test:resumable-dedup-loader:bounded-memory:postgres16",
    );
  }

  const small = await writeFixture(3000);
  const large = await writeFixture(36000); // 12x more lines
  try {
    const smallResult = await runChildDiscovery({ databaseUrl: url, chunksFilePath: small.filePath, snapshotId: `docsnap_memtest_small_${Date.now()}` });
    const largeResult = await runChildDiscovery({ databaseUrl: url, chunksFilePath: large.filePath, snapshotId: `docsnap_memtest_large_${Date.now()}` });

    assert.equal(smallResult.discoveredOccurrenceCount, 3000);
    assert.equal(largeResult.discoveredOccurrenceCount, 36000);

    const lineRatio = 36000 / 3000; // 12x
    const rssRatio = largeResult.peakRssMb / smallResult.peakRssMb;
    console.error(`[bounded-memory] small(3000 lines) peak_rss=${smallResult.peakRssMb.toFixed(1)}MB, large(36000 lines) peak_rss=${largeResult.peakRssMb.toFixed(1)}MB, line_ratio=${lineRatio}x, rss_ratio=${rssRatio.toFixed(2)}x`);
    assert.ok(rssRatio < lineRatio / 3, `expected peak RSS growth (${rssRatio.toFixed(2)}x) to be far below input growth (${lineRatio}x) -- got a ratio suggesting near-linear memory growth`);
    assert.ok(largeResult.peakRssMb < 400, `peak RSS for even the larger fixture should stay well within a bounded plateau, got ${largeResult.peakRssMb.toFixed(1)}MB`);
  } finally {
    await rm(small.dir, { recursive: true, force: true });
    await rm(large.dir, { recursive: true, force: true });
  }
});
