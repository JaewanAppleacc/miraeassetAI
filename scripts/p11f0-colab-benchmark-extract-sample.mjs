#!/usr/bin/env node
// Turn AC-COLAB-BENCH-V1, section D/F: extracts the pinned 5,000-sample
// subset from embedding-input-fulltext.jsonl, PRESERVING that file's own
// fixed order (sha256(embed_text)-ascending -- see
// p11f0-embedding-input-manifest.mjs), into a small, standalone file both
// the local reference runner and the Colab notebook read from -- this is
// what makes "batch ordering 동일" (section F) and "input ordering SHA
// 일치" (section G) checkable at all: both sides consume the SAME file in
// the SAME order.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  const fullTextPath = process.argv[2];
  const summaryPath = process.argv[3];
  const outPath = process.argv[4];
  if (!fullTextPath || !summaryPath || !outPath) {
    console.error("usage: node p11f0-colab-benchmark-extract-sample.mjs <fulltext.jsonl> <summary.json> <out-sample-fulltext.jsonl>");
    process.exitCode = 1;
    return;
  }

  const summary = JSON.parse(await (await import("node:fs/promises")).readFile(summaryPath, "utf8"));
  const sampleIds = new Set(summary.benchmark_sample.sample_ids);
  if (sampleIds.size !== summary.benchmark_sample.actual_size) {
    throw new Error(`MALFORMED_SUMMARY: sample_ids has ${sampleIds.size} unique entries, actual_size says ${summary.benchmark_sample.actual_size}`);
  }

  const rl = createInterface({ input: createReadStream(fullTextPath, { encoding: "utf8" }), crlfDelay: Infinity });
  const outLines = [];
  const orderedIds = [];
  let inputIndex = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (sampleIds.has(row.embedding_input_id)) {
      outLines.push(JSON.stringify({ input_index: inputIndex, embedding_input_id: row.embedding_input_id, embed_text_sha256: row.embed_text_sha256, text: row.text }));
      orderedIds.push(row.embedding_input_id);
    }
    inputIndex += 1;
  }

  if (orderedIds.length !== sampleIds.size) {
    throw new Error(`SAMPLE_EXTRACTION_INCOMPLETE: expected ${sampleIds.size} rows, found ${orderedIds.length} in the full-text file -- population/sample mismatch`);
  }
  const missing = [...sampleIds].filter((id) => !orderedIds.includes(id));
  if (missing.length > 0) throw new Error(`SAMPLE_IDS_NOT_IN_POPULATION: ${missing.length} sample id(s) not found in the full-text file: ${missing.slice(0, 5).join(", ")}`);

  const partialPath = `${outPath}.partial`;
  await writeFile(partialPath, `${outLines.join("\n")}\n`, "utf8");
  await rename(partialPath, outPath);

  const inputOrderingSha256 = sha256Hex(orderedIds.join("\n"));
  console.log(JSON.stringify({
    out_path: outPath,
    row_count: orderedIds.length,
    input_ordering_sha256: inputOrderingSha256,
    first_id: orderedIds[0],
    last_id: orderedIds[orderedIds.length - 1],
  }, null, 2));
}

main().catch((error) => {
  console.error(`[extract-sample] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
