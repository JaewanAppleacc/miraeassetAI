// Turn AC-COLAB-FULL-SHARDS-V1, section K: scoped unit tests for
// scripts/p11f0-colab-full-shard-export.mjs, run against a small SYNTHETIC
// fixture (never the real 441,879-row corpus-derived population) so this
// suite is fast and self-contained -- no DATABASE_URL, no KURE server, no
// real corpus text. Uses the exporter's override parameters
// (expectedTotal/expectedShardCount/expectedBoundaries/minFreeBytes) to
// exercise the same code paths at a tractable scale.
//
// Never reads/writes Gold, DEV_CHECK, HOLDOUT, DB credentials, or real
// chunk text -- all fixture text below is synthetic placeholder content.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  exportFullShards, loadAndVerifyShardPlan, sha256Hex, shardFileName,
} from "../scripts/p11f0-colab-full-shard-export.mjs";

function sha256HexStr(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }

// 20-row synthetic population, sorted by embed_text_sha256 ascending (the
// exporter/shard-plan convention), 4-way contiguous boundaries (5 rows
// each) -- a small-scale analog of the real 441,879/8-way case.
const SMALL_TOTAL = 20;
const SMALL_SHARD_COUNT = 4;
const SMALL_BOUNDARIES = [
  { shard_index: 0, start_input_index: 0, end_input_index: 4, row_count: 5 },
  { shard_index: 1, start_input_index: 5, end_input_index: 9, row_count: 5 },
  { shard_index: 2, start_input_index: 10, end_input_index: 14, row_count: 5 },
  { shard_index: 3, start_input_index: 15, end_input_index: 19, row_count: 5 },
];

function makeRows(n, { duplicateIdAt = null, duplicateTextShaAt = null } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const text = `synthetic placeholder text row ${i}`;
    const sha = sha256HexStr(`row-${String(i).padStart(4, "0")}`); // fabricated but strictly increasing-sortable via padding
    rows.push({ embedding_input_id: `embin_synthetic_${String(i).padStart(4, "0")}`, embed_text_sha256: sha, char_length: text.length, text });
  }
  if (duplicateIdAt !== null) rows[duplicateIdAt].embedding_input_id = rows[0].embedding_input_id;
  if (duplicateTextShaAt !== null) rows[duplicateTextShaAt].embed_text_sha256 = rows[0].embed_text_sha256;
  // Re-sort by embed_text_sha256 so the fixture matches the exporter's own sortedness expectation (except when we deliberately want to break it, callers handle that separately).
  rows.sort((a, b) => (a.embed_text_sha256 < b.embed_text_sha256 ? -1 : a.embed_text_sha256 > b.embed_text_sha256 ? 1 : 0));
  return rows;
}

async function writeFixture(dir, rows, boundaries = SMALL_BOUNDARIES, shardCount = SMALL_SHARD_COUNT, total = SMALL_TOTAL) {
  const fullTextPath = path.join(dir, "fulltext.jsonl");
  await writeFile(fullTextPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  const fullTextSha256 = createHash("sha256").update(await readFile(fullTextPath)).digest("hex");

  const shardPlanPath = path.join(dir, "shard-plan.json");
  await writeFile(shardPlanPath, JSON.stringify({
    [`shard_plan_${shardCount}_contiguous`]: {
      shard_count: shardCount, complete: true, total_expected: total, total_assigned: total,
      shards: boundaries.map((b) => ({ ...b, shard_sha256: `fake-${b.shard_index}` })),
    },
  }), "utf8");

  const summaryPath = path.join(dir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({
    unique_input_count: total,
    model: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024, dtype: "float32" },
    full_text_file: { sha256: fullTextSha256, line_count: total },
  }), "utf8");

  return { fullTextPath, shardPlanPath, summaryPath, fullTextSha256 };
}

let workDir;
test.beforeEach(async () => { workDir = await mkdtemp(path.join(tmpdir(), "p11f0-full-shard-export-")); });
test.afterEach(async () => { await rm(workDir, { recursive: true, force: true }); });

test("1/2/3/4/5/6: full population export -- correct total, shard count, boundaries, coverage, zero overlap, zero missing", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  const result = await exportFullShards({
    fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath,
    expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES,
  });
  assert.equal(result.storage_mode, "ALL_8_SHARDS_LOCAL_READY");
  assert.equal(result.total_rows_exported_this_run, SMALL_TOTAL);
  assert.equal(result.shard_count, SMALL_SHARD_COUNT);
  assert.equal(result.overlap_count, 0);
  assert.equal(result.missing_global_index_count, 0);
  assert.equal(result.duplicate_id_count, 0);
  assert.equal(result.shards.length, SMALL_SHARD_COUNT);
  for (const [i, s] of result.shards.entries()) {
    assert.equal(s.shard_index, SMALL_BOUNDARIES[i].shard_index);
    assert.equal(s.global_start_index, SMALL_BOUNDARIES[i].start_input_index);
    assert.equal(s.global_end_index, SMALL_BOUNDARIES[i].end_input_index);
    assert.equal(s.row_count, SMALL_BOUNDARIES[i].row_count);
  }
});

test("7: duplicate embedding_input_id is refused, never silently exported", async () => {
  const rows = makeRows(SMALL_TOTAL, { duplicateIdAt: 5 });
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  await assert.rejects(
    () => exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES }),
    (error) => { assert.match(error.message, /DUPLICATE_EMBEDDING_INPUT_ID/); return true; },
  );
});

test("duplicate embed_text_sha256 is refused, never silently exported", async () => {
  const rows = makeRows(SMALL_TOTAL, { duplicateTextShaAt: 5 });
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  await assert.rejects(
    () => exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES }),
    (error) => { assert.match(error.message, /DUPLICATE_EMBED_TEXT_SHA256/); return true; },
  );
});

test("shard-plan boundary mismatch (a stale/foreign plan) is refused -- never silently re-derives a different partition", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, summaryPath } = await writeFixture(workDir, rows);
  const badBoundaries = SMALL_BOUNDARIES.map((b) => ({ ...b, row_count: b.row_count + 1 }));
  const shardPlanPath = path.join(workDir, "bad-shard-plan.json");
  await writeFile(shardPlanPath, JSON.stringify({
    [`shard_plan_${SMALL_SHARD_COUNT}_contiguous`]: {
      shard_count: SMALL_SHARD_COUNT, complete: true, total_expected: SMALL_TOTAL, total_assigned: SMALL_TOTAL,
      shards: badBoundaries.map((b) => ({ ...b, shard_sha256: "x" })),
    },
  }), "utf8");
  const outDir = path.join(workDir, "out");
  await assert.rejects(
    () => exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES }),
    (error) => { assert.match(error.message, /SHARD_PLAN_BOUNDARY_MISMATCH/); return true; },
  );
});

test("9: deterministic gzip -- re-running the export twice on identical input produces byte-identical compressed_file_sha256 per shard", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir1 = path.join(workDir, "out1");
  const outDir2 = path.join(workDir, "out2");
  const r1 = await exportFullShards({ fullTextPath, shardPlanPath, outDir: outDir1, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES });
  const r2 = await exportFullShards({ fullTextPath, shardPlanPath, outDir: outDir2, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES });
  assert.equal(r1.shards.length, r2.shards.length);
  for (let i = 0; i < r1.shards.length; i += 1) {
    assert.equal(r1.shards[i].compressed_file_sha256, r2.shards[i].compressed_file_sha256, `shard ${i} compressed SHA must be byte-identical across independent runs`);
    assert.equal(r1.shards[i].uncompressed_content_sha256, r2.shards[i].uncompressed_content_sha256);
  }
  assert.equal(r1.input_membership_sha256, r2.input_membership_sha256);
  assert.equal(r1.input_ordering_sha256, r2.input_ordering_sha256);
  // Also verify the ACTUAL written file bytes on disk are identical, not just the in-memory report.
  const f1 = await readFile(path.join(outDir1, shardFileName(0)));
  const f2 = await readFile(path.join(outDir2, shardFileName(0)));
  assert.ok(f1.equals(f2));
});

test("allowed fields only: exported rows never carry char_length or any field beyond the 4 allowed ones", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  await exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES });
  const gz = await readFile(path.join(outDir, shardFileName(0)));
  const decoded = gunzipSync(gz).toString("utf8");
  const rowsOut = decoded.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  assert.equal(rowsOut.length, 5);
  for (const r of rowsOut) {
    assert.deepEqual(Object.keys(r).sort(), ["embed_text_sha256", "embedding_input_id", "global_eligible_index", "text"].sort());
  }
});

test("20: forbidden content -- exported shard bytes never contain Gold/DEV_CHECK/HOLDOUT/question_id/expected_answer markers", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  await exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES });
  for (let i = 0; i < SMALL_SHARD_COUNT; i += 1) {
    const gz = await readFile(path.join(outDir, shardFileName(i)));
    const decoded = gunzipSync(gz).toString("utf8");
    for (const marker of ["DEV_CHECK", "HOLDOUT", "question_id", "expected_answer", "required_evidence_slots", "DATABASE_URL", "api_key"]) {
      assert.doesNotMatch(decoded, new RegExp(marker, "i"));
    }
  }
});

test("21: zero DB access -- module imports no pg client / DATABASE_URL usage", async () => {
  const src = await readFile(new URL("../scripts/p11f0-colab-full-shard-export.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from ["']pg["']/);
  assert.doesNotMatch(src, /DATABASE_URL/);
});

test("23: disk 10GiB gate -- an unreasonably high minFreeBytes floor forces STORAGE_CAPACITY_BLOCKED and writes zero shard files", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  const result = await exportFullShards({
    fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath,
    expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES,
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.storage_mode, "STORAGE_CAPACITY_BLOCKED");
  assert.equal(result.shards.length, 0);
  await assert.rejects(() => stat(path.join(outDir, shardFileName(0))));
});

test("one-shard-staging mode: processes only the requested shard, leaves others unwritten", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const outDir = path.join(workDir, "out");
  const result = await exportFullShards({
    fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: summaryPath,
    expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES,
    forceStagingMode: true, stagingOnlyShardIndex: 2,
  });
  assert.equal(result.storage_mode, "ONE_SHARD_STAGING_REQUIRED");
  assert.equal(result.shards.length, 1);
  assert.equal(result.shards[0].shard_index, 2);
  await assert.rejects(() => stat(path.join(outDir, shardFileName(0))));
  await assert.rejects(() => stat(path.join(outDir, shardFileName(1))));
  const gz = await readFile(path.join(outDir, shardFileName(2)));
  assert.ok(gz.length > 0);
});

test("loadAndVerifyShardPlan: mismatched total row count in plan is refused", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { shardPlanPath: goodPlanPath } = await writeFixture(workDir, rows);
  const plan = JSON.parse(await readFile(goodPlanPath, "utf8"));
  plan[`shard_plan_${SMALL_SHARD_COUNT}_contiguous`].total_expected = SMALL_TOTAL + 1;
  const badPlanPath = path.join(workDir, "bad-total-plan.json");
  await writeFile(badPlanPath, JSON.stringify(plan), "utf8");
  await assert.rejects(
    () => loadAndVerifyShardPlan(badPlanPath, SMALL_BOUNDARIES, SMALL_TOTAL, SMALL_SHARD_COUNT),
    (error) => { assert.match(error.message, /SHARD_PLAN_TOTAL_MISMATCH/); return true; },
  );
});

test("source summary model pin mismatch is refused", async () => {
  const rows = makeRows(SMALL_TOTAL);
  const { fullTextPath, shardPlanPath, summaryPath } = await writeFixture(workDir, rows);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  summary.model.revision = "wrong-revision";
  const badSummaryPath = path.join(workDir, "bad-summary.json");
  await writeFile(badSummaryPath, JSON.stringify(summary), "utf8");
  const outDir = path.join(workDir, "out");
  await assert.rejects(
    () => exportFullShards({ fullTextPath, shardPlanPath, outDir, manifestSourceSummaryPath: badSummaryPath, expectedTotal: SMALL_TOTAL, expectedShardCount: SMALL_SHARD_COUNT, expectedBoundaries: SMALL_BOUNDARIES }),
    (error) => { assert.match(error.message, /SOURCE_SUMMARY_MODEL_PIN_MISMATCH/); return true; },
  );
});

test("sha256Hex helper is a plain deterministic hex digest", () => {
  assert.equal(sha256Hex("hello"), createHash("sha256").update("hello", "utf8").digest("hex"));
});
