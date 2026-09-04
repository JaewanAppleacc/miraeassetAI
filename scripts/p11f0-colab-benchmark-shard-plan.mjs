#!/usr/bin/env node
// Turn AC-COLAB-BENCH-V1, section H: deterministic CONTIGUOUS-range shard
// plans (2/4/8-way) over the full 441,879-row eligible-unique-embeddable
// set, keyed by GLOBAL input_index -- the row's 0-based line number in
// embedding-input-fulltext.jsonl's own fixed, sha256(embed_text)-sorted
// order (independently re-verified strictly sorted before planning; see
// p11f0-embedding-input-manifest.mjs for how that file/order is produced).
//
// DELIBERATELY A DIFFERENT SCHEME from the pre-existing shard_plan_2/
// shard_plan_4 in embedding-input-manifest.summary.json (those are
// sha256-PREFIX-MOD-N, scattered, not contiguous -- built for an earlier
// Turn's different purpose). This Turn's own section H explicitly asks
// for contiguous global-input-index ranges (so a GPU worker can be hard-
// coded to "rows START..END", checkpoint/resume by row offset within its
// own shard, and merge results back in global order trivially) -- both
// schemes are valid partitions of the SAME 441,879-row population; this
// script does not replace or invalidate the existing hash-based ones.
//
// Never reads/writes Gold, DEV_CHECK, HOLDOUT, or any DB credential.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeJsonAtomic(finalPath, value) {
  const partialPath = `${finalPath}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await rename(partialPath, finalPath);
}

// Contiguous partition of [0, total) into shardCount ranges, as even as
// possible (the first `total % shardCount` shards get one extra row) --
// deterministic, no remainder dropped or appended only to the last shard.
function contiguousRanges(total, shardCount) {
  const base = Math.floor(total / shardCount);
  const extra = total % shardCount;
  const ranges = [];
  let cursor = 0;
  for (let i = 0; i < shardCount; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    ranges.push({ shard_index: i, start_input_index: cursor, end_input_index: cursor + size - 1, row_count: size });
    cursor += size;
  }
  return ranges;
}

async function main() {
  const fullTextPath = process.argv[2];
  const outPath = process.argv[3];
  if (!fullTextPath || !outPath) {
    console.error("usage: node p11f0-colab-benchmark-shard-plan.mjs <embedding-input-fulltext.jsonl> <out-shard-plan.json>");
    process.exitCode = 1;
    return;
  }

  const shardCounts = [2, 4, 8];
  const ranges = Object.fromEntries(shardCounts.map((n) => [n, null]));
  let total = 0;
  let prevSha = null;
  const hashers = Object.fromEntries(shardCounts.map((n) => [n, null])); // filled once total is known

  // Pass 1: count rows and confirm strict embed_text_sha256 ordering
  // (planning off an unsorted or re-ordered file would silently break the
  // "contiguous == deterministic" guarantee).
  {
    const rl = createInterface({ input: createReadStream(fullTextPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (prevSha !== null && row.embed_text_sha256 <= prevSha) {
        throw new Error(`INPUT_NOT_SORTED: line ${total} embed_text_sha256 ${row.embed_text_sha256} <= previous ${prevSha} -- refusing to plan contiguous shards over a non-deterministic order`);
      }
      prevSha = row.embed_text_sha256;
      total += 1;
    }
  }

  for (const n of shardCounts) {
    ranges[n] = contiguousRanges(total, n);
    hashers[n] = ranges[n].map(() => createHash("sha256"));
  }

  // Pass 2: stream again, feed each row's (input_index, embedding_input_id,
  // embed_text_sha256) into the hasher for whichever shard it falls in, per
  // shard count -- never materializes 441,879 ids in memory or in the
  // output file.
  {
    const rl = createInterface({ input: createReadStream(fullTextPath, { encoding: "utf8" }), crlfDelay: Infinity });
    let inputIndex = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const n of shardCounts) {
        const shardIdx = ranges[n].findIndex((r) => inputIndex >= r.start_input_index && inputIndex <= r.end_input_index);
        hashers[n][shardIdx].update(`${inputIndex}:${row.embedding_input_id}:${row.embed_text_sha256}\n`, "utf8");
      }
      inputIndex += 1;
    }
  }

  const plans = {};
  for (const n of shardCounts) {
    const shards = ranges[n].map((r, i) => ({ ...r, shard_sha256: hashers[n][i].digest("hex") }));
    const totalAssigned = shards.reduce((sum, s) => sum + s.row_count, 0);
    const coversFull = shards.length > 0 && shards[0].start_input_index === 0 && shards[shards.length - 1].end_input_index === total - 1;
    let noGapNoOverlap = true;
    for (let i = 1; i < shards.length; i += 1) {
      if (shards[i].start_input_index !== shards[i - 1].end_input_index + 1) noGapNoOverlap = false;
    }
    plans[`shard_plan_${n}_contiguous`] = {
      shard_count: n,
      partition_method: "contiguous global input_index range, sha256(embed_text)-sorted order",
      shards,
      total_assigned: totalAssigned,
      total_expected: total,
      overlap_or_gap: !noGapNoOverlap,
      complete: totalAssigned === total && coversFull && noGapNoOverlap,
    };
  }

  const recommended = 8;
  const output = {
    schema_version: "p11f0-colab-benchmark-shard-plan.v1",
    source_full_text_file: { line_count: total },
    ...plans,
    recommended_shard_count: recommended,
    recommendation_note: "8 shards recommended -- see AC_COLAB_BENCH_V1_HANDOFF.md section H for the full time/size/parallelism/resume tradeoff this was chosen from.",
  };

  await writeJsonAtomic(outPath, output);
  for (const n of shardCounts) {
    console.error(`[shard-plan] ${n}-way: complete=${plans[`shard_plan_${n}_contiguous`].complete} total_assigned=${plans[`shard_plan_${n}_contiguous`].total_assigned}/${total}`);
  }
}

main().catch((error) => {
  console.error(`[shard-plan] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
