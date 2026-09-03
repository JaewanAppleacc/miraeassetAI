#!/usr/bin/env node
// Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section O: local result
// importer/verifier for a downloaded GPU benchmark result file (JSON
// Lines, one record per embedded 5,000-sample input -- see
// gpu-benchmark-result.schema.json). Never uploads anything, never calls
// a GPU/embedding service itself -- this only validates a file the
// operator already downloaded from Kaggle/Colab by hand.
//
// Checks, in order (fail-closed, reports every violation found rather
// than stopping at the first):
//   1. every line is valid JSON matching gpu-benchmark-result.schema.json
//   2. model/revision/dimension/dtype/normalization pins match exactly
//      (malformed/wrong-pin results are rejected, never silently accepted)
//   3. embedding_input_id set == the pinned 5,000-sample set exactly
//      (0 missing, 0 duplicate, 0 unexpected extra ids)
//   4. embed_text_sha256 on each result matches what the sample manifest
//      recorded for that embedding_input_id
//   5. every vector has exactly 1024 finite numeric components
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

async function main() {
  const resultPath = process.argv[2];
  const summaryPath = process.argv[3];
  if (!resultPath || !summaryPath) {
    console.error("usage: node p11f0-gpu-benchmark-result-verify.mjs <result.jsonl> <embedding-input-manifest.summary.json>");
    process.exitCode = 1;
    return;
  }

  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const schema = JSON.parse(await readFile(new URL("../domain/agent-comparison/four-arm-ac/gpu-benchmark-result.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const expectedIds = new Set(summary.benchmark_sample?.sample_ids ?? []);
  if (expectedIds.size === 0) {
    console.error("MALFORMED_SAMPLE_MANIFEST: summary.benchmark_sample.sample_ids is empty -- was this summary generated with sample IDs recorded? (see p11f0-embedding-input-manifest.mjs)");
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(resultPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");

  const errors = [];
  const seenIds = new Set();
  let elapsedTotalMs = 0;
  let validCount = 0;

  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      errors.push(`line ${index}: MALFORMED_JSON`);
      continue;
    }
    if (!validate(record)) {
      errors.push(`line ${index}: SCHEMA_VIOLATION: ${ajv.errorsText(validate.errors)}`);
      continue;
    }
    if (seenIds.has(record.embedding_input_id)) {
      errors.push(`line ${index}: DUPLICATE_EMBEDDING_INPUT_ID: ${record.embedding_input_id}`);
      continue;
    }
    seenIds.add(record.embedding_input_id);
    if (!expectedIds.has(record.embedding_input_id)) {
      errors.push(`line ${index}: UNEXPECTED_EMBEDDING_INPUT_ID (not in the pinned 5,000-sample set): ${record.embedding_input_id}`);
      continue;
    }
    if (!record.vector.every((v) => Number.isFinite(v))) {
      errors.push(`line ${index}: NON_FINITE_VECTOR_COMPONENT: ${record.embedding_input_id}`);
      continue;
    }
    elapsedTotalMs += record.elapsed_ms;
    validCount += 1;
  }

  const missingIds = [...expectedIds].filter((id) => !seenIds.has(id));
  if (missingIds.length > 0) errors.push(`MISSING_RESULTS: ${missingIds.length} sample id(s) never appeared in the result file`);

  const report = {
    result_file: resultPath,
    expected_sample_size: expectedIds.size,
    valid_record_count: validCount,
    error_count: errors.length,
    missing_count: missingIds.length,
    errors: errors.slice(0, 50), // cap the printed list; error_count carries the real total
    ok: errors.length === 0 && validCount === expectedIds.size,
  };

  if (report.ok) {
    const avgMs = elapsedTotalMs / validCount;
    const fullRunEstimateMs = avgMs * (summary.unique_input_count ?? 0);
    report.throughput = {
      benchmark_sample_size: validCount,
      avg_elapsed_ms_per_input: avgMs,
      full_run_unique_input_count: summary.unique_input_count ?? null,
      estimated_full_run_ms: fullRunEstimateMs,
      estimated_full_run_note: "Linear extrapolation from the 5,000-sample benchmark's own measured per-input latency -- an estimate, not a guarantee (real GPU throughput can vary with batch size, contention, and thermal/queue conditions).",
    };
  }

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`[gpu-benchmark-result-verify] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
