#!/usr/bin/env node
// A-RETRIEVAL-REMEDIATION-VALIDATION-V1: generic driver over the existing, UNMODIFIED
// read-only hydrator (p11f0-fourarm-scoring-view-hydrator.mjs)'s exported functions
// (assertReadyIndex, hydrateArm) -- that file's own main() hard-codes the committed
// domain/agent-comparison/four-arm-ac/results/{A,C}.results.jsonl paths, so this turn's
// fresh control/candidate output (different paths, different filenames) needs a thin
// wrapper rather than a change to that file. Same safety contract, verbatim: exact
// chunk_id lookup against the same READY index, sha256(text_content)==chunk_text_sha256
// and source_document_id==doc_id required for every item, abort entirely (write nothing)
// on any single failure, field-level invariance check that only `text` was added.
//
// Usage:
//   DATABASE_URL=... node scripts/a-remediation-validation-hydrate.mjs \
//     --in <path to *.ndjson> --out <dir> [--arm A]
//
// Writes <out>/A.results.jsonl (the name scripts/fourarm/score.py expects) and
// <out>/hydration_report.json. Never touches the original --in file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { assertReadyIndex, hydrateArm } from "./p11f0-fourarm-scoring-view-hydrator.mjs";

const { Client } = pg;

function option(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const inPath = option("--in");
  const outDir = option("--out");
  const arm = option("--arm", "A");
  if (!inPath) throw new Error("--in <path to *.ndjson> is required");
  if (!outDir) throw new Error("--out <gitignored work/ dir> is required");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (read-only lookup only)");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await assertReadyIndex(client);
    const result = await hydrateArm(client, arm, inPath);
    await client.query("ROLLBACK");

    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, "hydration_report.json"),
      JSON.stringify({ turn: "A-RETRIEVAL-REMEDIATION-VALIDATION-V1", in: inPath, arm,
                       status: result.anyFailure ? "BLOCKED_CONTRACT" : "HYDRATION_COMPLETE",
                       counts: result.counts, invarianceOk: result.invarianceOk,
                       invarianceMismatches: result.invarianceMismatches, failures: result.failures },
                     null, 1),
      "utf8",
    );

    if (result.anyFailure) {
      console.log(JSON.stringify({ status: "BLOCKED_CONTRACT",
        reason: "hydration integrity failure -- see hydration_report.json, no scoring view written" }, null, 1));
      process.exitCode = 1;
      return;
    }

    const lines = result.hydratedRows.map((r) => JSON.stringify(r));
    // score.py expects exactly "<arm>.results.jsonl" in --results-dir.
    await writeFile(path.join(outDir, `${arm}.results.jsonl`), `${lines.join("\n")}\n`, "utf8");
    console.log(JSON.stringify({ status: "HYDRATION_COMPLETE", arm, counts: result.counts }, null, 1));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exitCode = 1;
});
