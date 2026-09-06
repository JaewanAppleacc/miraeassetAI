#!/usr/bin/env node
// A-RETRIEVAL-REMEDIATION-VALIDATION-V1: read-only lookup of
// metadata.is_correction/doc_subtype/receipt_date for every chunk_id appearing in either
// the control or candidate results.jsonl, used only for the diagnostic "correction-notice
// search change" metric (never a pass/fail gate). Read-only transaction, no writes to the
// database or to either results file.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";

function option(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function chunkIdsFrom(resultsPath) {
  const raw = await readFile(resultsPath, "utf8");
  const ids = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    for (const item of row.results ?? []) ids.add(item.chunk_id);
  }
  return ids;
}

async function main() {
  const controlPath = option("--control");
  const candidatePath = option("--candidate");
  const outPath = option("--out");
  if (!controlPath || !candidatePath || !outPath) {
    throw new Error("--control <A.results.jsonl> --candidate <A.results.jsonl> --out <json> are required");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (read-only lookup only)");

  const ids = new Set([...(await chunkIdsFrom(controlPath)), ...(await chunkIdsFrom(candidatePath))]);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const out = {};
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const { rows } = await client.query(
      `SELECT chunk_id, metadata->>'is_correction' AS is_correction,
              metadata->>'doc_subtype' AS doc_subtype, metadata->>'receipt_date' AS receipt_date
       FROM disclosure_reference.reference_retrieval_chunks
       WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
      [RETRIEVAL_INDEX_ID, [...ids]],
    );
    await client.query("ROLLBACK");
    for (const r of rows) {
      out[r.chunk_id] = {
        is_correction: r.is_correction === "true",
        doc_subtype: r.doc_subtype,
        receipt_date: r.receipt_date,
      };
    }
  } finally {
    await client.end();
  }
  await writeFile(outPath, JSON.stringify(out, null, 1), "utf8");
  console.log(JSON.stringify({ status: "OK", chunk_ids_requested: ids.size, chunk_ids_found: Object.keys(out).length }, null, 1));
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exitCode = 1;
});
