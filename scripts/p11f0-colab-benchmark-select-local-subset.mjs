#!/usr/bin/env node
// Turn AC-COLAB-COMPAT-V1.1, section 2.1 of AC_COLAB_BENCH_V1.1_AMENDMENT.md:
// deterministic, length-stratified 500-row selection over the existing
// 5,000-row `benchmark-sample-fulltext.jsonl` population -- every selected
// row's embed_text_sha256 is therefore already present in the existing
// Colab 5,000-row result package, so this subset can be cosine-compared
// against that package without a new Colab run.
//
// Algorithm (fixed BEFORE any cosine number exists this Turn):
//   1. char_length = text.length (UTF-16 code units) per row.
//   2. Sort all rows by char_length ascending, tie-break by
//      embed_text_sha256 ascending.
//   3. Partition into `strataCount` equal-size length strata by rank.
//   4. Within each stratum, re-sort by embed_text_sha256 ascending and take
//      a SHA-evenly-spaced selection of `perStratum` rows (step =
//      stratum_size / perStratum, floor-indexed) -- the same method already
//      used for the original 5,000-sample selection
//      (p11f0-embedding-input-manifest.mjs), applied per-stratum.
//
// Fails closed: refuses to run (writes nothing) if the population size does
// not match the expected total, if any row is missing a required field, or
// if any stratum is too small to supply its share.
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function selectLengthStratifiedSubset(rows, { strataCount, perStratum, expectedPopulation = null }) {
  if (expectedPopulation !== null && rows.length !== expectedPopulation) {
    throw new Error(`POPULATION_SIZE_MISMATCH: expected ${expectedPopulation} rows, found ${rows.length}`);
  }
  for (const [i, row] of rows.entries()) {
    if (typeof row.text !== "string") throw new Error(`ROW_MISSING_TEXT: index ${i}`);
    if (typeof row.embed_text_sha256 !== "string") throw new Error(`ROW_MISSING_SHA: index ${i}`);
    if (typeof row.embedding_input_id !== "string") throw new Error(`ROW_MISSING_ID: index ${i}`);
  }

  const withLength = rows.map((row) => ({ ...row, char_length: row.text.length }));
  withLength.sort((a, b) => {
    if (a.char_length !== b.char_length) return a.char_length - b.char_length;
    return a.embed_text_sha256 < b.embed_text_sha256 ? -1 : (a.embed_text_sha256 > b.embed_text_sha256 ? 1 : 0);
  });

  const n = withLength.length;
  const strataBoundaries = [];
  const selected = [];
  for (let s = 0; s < strataCount; s += 1) {
    const startRank = Math.floor((s * n) / strataCount);
    const endRank = Math.floor(((s + 1) * n) / strataCount); // exclusive
    const stratum = withLength.slice(startRank, endRank);
    if (stratum.length < perStratum) {
      throw new Error(`STRATUM_TOO_SMALL: stratum ${s} has ${stratum.length} rows, needs at least ${perStratum}`);
    }
    strataBoundaries.push({
      stratum_index: s,
      row_count: stratum.length,
      char_length_min: stratum[0].char_length,
      char_length_max: stratum[stratum.length - 1].char_length,
    });
    const sortedByHash = [...stratum].sort((a, b) => (a.embed_text_sha256 < b.embed_text_sha256 ? -1 : (a.embed_text_sha256 > b.embed_text_sha256 ? 1 : 0)));
    const step = sortedByHash.length / perStratum;
    const indices = new Set();
    for (let i = 0; i < perStratum; i += 1) indices.add(Math.floor(i * step));
    for (const idx of [...indices].sort((a, b) => a - b)) selected.push(sortedByHash[idx]);
  }

  // Final selection order: ascending embed_text_sha256 (same canonical
  // ordering convention as the parent 5,000-sample file), not stratum
  // order -- keeps this file's own ordering independently reproducible
  // from the sha list alone.
  selected.sort((a, b) => (a.embed_text_sha256 < b.embed_text_sha256 ? -1 : (a.embed_text_sha256 > b.embed_text_sha256 ? 1 : 0)));

  return { selected, strataBoundaries, population: n };
}

async function main() {
  const fullTextPath = process.argv[2];
  const outPath = process.argv[3];
  const strataCount = Number(process.env.P11F0_SUBSET_STRATA_COUNT ?? 10);
  const perStratum = Number(process.env.P11F0_SUBSET_PER_STRATUM ?? 50);
  const expectedPopulation = process.env.P11F0_SUBSET_EXPECTED_POPULATION ? Number(process.env.P11F0_SUBSET_EXPECTED_POPULATION) : null;

  if (!fullTextPath || !outPath) {
    console.error("usage: node p11f0-colab-benchmark-select-local-subset.mjs <benchmark-sample-fulltext.jsonl> <out-subset-fulltext.jsonl>");
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(fullTextPath, "utf8");
  const rows = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const { selected, strataBoundaries, population } = selectLengthStratifiedSubset(rows, { strataCount, perStratum, expectedPopulation });

  const outLines = selected.map((row, i) => JSON.stringify({
    input_index: i,
    embedding_input_id: row.embedding_input_id,
    embed_text_sha256: row.embed_text_sha256,
    char_length: row.char_length,
    text: row.text,
  }));
  const outContent = `${outLines.join("\n")}\n`;
  const partialPath = `${outPath}.partial`;
  await writeFile(partialPath, outContent, "utf8");
  await rename(partialPath, outPath);

  const sampleManifestSha256 = sha256Hex(selected.map((r) => r.embedding_input_id).join("\n"));
  const inputOrderingSha256 = sha256Hex(selected.map((r) => r.embedding_input_id).join("\n"));

  console.log(JSON.stringify({
    out_path: outPath,
    population,
    strata_count: strataCount,
    per_stratum: perStratum,
    selected_count: selected.length,
    selection_method: `deterministic length-stratified (char_length ascending, ${strataCount} equal-rank strata, SHA-evenly-spaced ${perStratum}/stratum, step = stratum_size/${perStratum}, floor-indexed)`,
    sample_manifest_sha256: sampleManifestSha256,
    input_ordering_sha256: inputOrderingSha256,
    strata: strataBoundaries,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[select-local-subset] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
