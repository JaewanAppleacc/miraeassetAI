#!/usr/bin/env node
// Turn FOURARM-AC-SCORING-VIEW-FIX-V1, Section B: read-only hydrator that
// adds a SHA-verified `text` field to a TEMPORARY scoring view built from
// A/C's own committed results.jsonl, so the frozen scorer's
// check_locators() can do its real content-verification pass instead of
// falling through to "no_text_to_verify" for every match (the
// METADATA_CONTRACT_DEFECT diagnosed in UNRESOLVED_AUDIT_V1.md).
//
// Guarantees enforced here (see SCORING_VIEW_FIX_V1_AMENDMENT.md):
//   - Original A.results.jsonl/C.results.jsonl are opened read-only and
//     never written to. Output goes only to --out (caller must point this
//     at gitignored work/).
//   - Exact chunk_id lookup only, against the SAME READY retrieval index
//     that produced the original retrieval (no re-search, no NodeStore
//     full-node substitution, no neighboring/parent context).
//   - A row is hydrated only if: its chunk_id is present in the index
//     exactly once, source_document_id matches the result's own doc_id,
//     and sha256(text_content) matches the result's own chunk_text_sha256
//     bit for bit.
//   - ANY single failure (missing / duplicate / hash mismatch / doc
//     mismatch) aborts the ENTIRE run for BOTH files before any output is
//     written -- no partial hydration.
//   - Every field other than the newly-added `text` is carried through
//     unchanged; this script also emits a byte-level invariance report
//     proving that.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

export const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
export const KURE_EXPECTED_PINS = Object.freeze({
  embedding_provider: "nlpai-lab",
  embedding_model: "KURE-v1",
  embedding_revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f",
  embedding_dimension: 1024,
});

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readRows(inPath) {
  const raw = await readFile(inPath, "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

export async function assertReadyIndex(client) {
  const { rows } = await client.query(
    `SELECT retrieval_index_id, index_status, embedding_provider, embedding_model,
            embedding_revision, embedding_dimension
     FROM disclosure_reference.reference_retrieval_indexes
     WHERE retrieval_index_id = $1`,
    [RETRIEVAL_INDEX_ID],
  );
  const index = rows[0];
  if (!index) throw new Error(`retrieval index ${RETRIEVAL_INDEX_ID} not found`);
  if (index.index_status !== "READY") throw new Error(`retrieval index ${RETRIEVAL_INDEX_ID} is not READY (status=${index.index_status})`);
  for (const [key, expected] of Object.entries(KURE_EXPECTED_PINS)) {
    if (index[key] !== expected && String(index[key]) !== String(expected)) {
      throw new Error(`retrieval index pin mismatch: ${key} expected ${expected}, found ${index[key]}`);
    }
  }
  return index;
}

export async function fetchChunkRows(client, chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT chunk_id, source_document_id, text_content, text_sha256
     FROM disclosure_reference.reference_retrieval_chunks
     WHERE retrieval_index_id = $1 AND chunk_id = ANY($2::text[])`,
    [RETRIEVAL_INDEX_ID, chunkIds],
  );
  const byChunkId = new Map();
  const dupCount = new Map();
  for (const row of rows) {
    dupCount.set(row.chunk_id, (dupCount.get(row.chunk_id) ?? 0) + 1);
    byChunkId.set(row.chunk_id, row);
  }
  return { byChunkId, dupCount };
}

function invarianceKeyOf(item) {
  // every field except `text` -- the ONLY field this Turn is permitted to add.
  const { text, ...rest } = item;
  return rest;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function hydrateArm(client, arm, inPath) {
  const rows = await readRows(inPath);
  const counts = {
    total_items: 0,
    hydrated_success: 0,
    missing: 0,
    duplicate: 0,
    duplicate_within_question: 0,
    hash_mismatch: 0,
    document_mismatch: 0,
    unique_chunk_ids: 0,
  };
  const failures = [];
  const allChunkIds = new Set();
  const withinQuestionSeen = new Set();
  const withinQuestionDuplicateKeys = new Set();

  for (const row of rows) {
    for (const item of row.results ?? []) {
      counts.total_items += 1;
      const cid = item.chunk_id;
      allChunkIds.add(cid);
      const key = `${row.question_id}::${cid}`;
      if (withinQuestionSeen.has(key)) {
        withinQuestionDuplicateKeys.add(key);
      }
      withinQuestionSeen.add(key);
    }
  }
  counts.unique_chunk_ids = allChunkIds.size;
  counts.duplicate_within_question = withinQuestionDuplicateKeys.size;
  for (const key of withinQuestionDuplicateKeys) {
    const [question_id, chunk_id] = key.split("::");
    failures.push({ question_id, chunk_id, reason: "duplicate_within_question_results" });
  }

  const { byChunkId, dupCount } = await fetchChunkRows(client, [...allChunkIds]);

  const hydratedRows = [];
  for (const row of rows) {
    const newResults = [];
    for (const item of row.results ?? []) {
      const cid = item.chunk_id;
      const dbRow = byChunkId.get(cid);
      const dbDupCount = dupCount.get(cid) ?? 0;

      if (!dbRow) {
        counts.missing += 1;
        failures.push({ question_id: row.question_id, chunk_id: cid, reason: "missing_in_index" });
        continue;
      }
      if (dbDupCount > 1) {
        counts.duplicate += 1;
        failures.push({ question_id: row.question_id, chunk_id: cid, reason: "duplicate_in_index" });
        continue;
      }
      if (dbRow.source_document_id !== item.doc_id) {
        counts.document_mismatch += 1;
        failures.push({ question_id: row.question_id, chunk_id: cid, reason: "document_mismatch", db_doc: dbRow.source_document_id, result_doc: item.doc_id });
        continue;
      }
      const computedSha = sha256Hex(dbRow.text_content);
      if (computedSha !== item.chunk_text_sha256) {
        counts.hash_mismatch += 1;
        failures.push({ question_id: row.question_id, chunk_id: cid, reason: "hash_mismatch" });
        continue;
      }
      counts.hydrated_success += 1;
      newResults.push({ ...item, text: dbRow.text_content });
    }
    hydratedRows.push({ ...row, results: newResults });
  }

  // invariance check: every field except `text` must be byte-equivalent.
  let invarianceOk = true;
  const invarianceMismatches = [];
  for (let i = 0; i < rows.length; i += 1) {
    const before = rows[i];
    const after = hydratedRows[i];
    if (before.question_id !== after.question_id) { invarianceOk = false; invarianceMismatches.push({ index: i, field: "question_id" }); }
    const beforeResults = (before.results ?? []).filter((it) => byChunkId.has(it.chunk_id) && dupCount.get(it.chunk_id) === 1 && byChunkId.get(it.chunk_id).source_document_id === it.doc_id && sha256Hex(byChunkId.get(it.chunk_id).text_content) === it.chunk_text_sha256);
    if (beforeResults.length !== after.results.length) { invarianceOk = false; invarianceMismatches.push({ index: i, field: "results.length" }); continue; }
    for (let j = 0; j < beforeResults.length; j += 1) {
      const b = invarianceKeyOf(beforeResults[j]);
      const a = invarianceKeyOf(after.results[j]);
      if (!deepEqual(b, a)) { invarianceOk = false; invarianceMismatches.push({ index: i, item: j, field: "non-text fields" }); }
    }
  }

  const anyFailure = counts.missing > 0 || counts.duplicate > 0 || counts.duplicate_within_question > 0 || counts.hash_mismatch > 0 || counts.document_mismatch > 0 || !invarianceOk;

  return { arm, counts, failures, invarianceOk, invarianceMismatches, hydratedRows, anyFailure };
}

export async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (read-only lookup only)");
  const outDir = args.out;
  if (!outDir) throw new Error("--out=<gitignored work/ dir> is required");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await assertReadyIndex(client);

    const resultsDir = path.resolve("domain/agent-comparison/four-arm-ac/results");
    const armResults = {};
    for (const arm of ["A", "C"]) {
      armResults[arm] = await hydrateArm(client, arm, path.join(resultsDir, `${arm}.results.jsonl`));
    }
    await client.query("ROLLBACK");

    const anyFailure = armResults.A.anyFailure || armResults.C.anyFailure;
    const report = {
      turn: "FOURARM-AC-SCORING-VIEW-FIX-V1",
      retrieval_index_id: RETRIEVAL_INDEX_ID,
      status: anyFailure ? "BLOCKED_CONTRACT" : "HYDRATION_COMPLETE",
      A: { counts: armResults.A.counts, invarianceOk: armResults.A.invarianceOk, invarianceMismatches: armResults.A.invarianceMismatches, failures: armResults.A.failures },
      C: { counts: armResults.C.counts, invarianceOk: armResults.C.invarianceOk, invarianceMismatches: armResults.C.invarianceMismatches, failures: armResults.C.failures },
    };

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "hydration_report.json"), JSON.stringify(report, null, 1), "utf8");

    if (anyFailure) {
      console.log(JSON.stringify({ status: "BLOCKED_CONTRACT", reason: "hydration integrity failure -- see hydration_report.json, no scoring view written" }, null, 1));
      process.exitCode = 1;
      return;
    }

    for (const arm of ["A", "C"]) {
      const lines = armResults[arm].hydratedRows.map((r) => JSON.stringify(r));
      await writeFile(path.join(outDir, `${arm}.scoring_view.jsonl`), lines.join("\n") + "\n", "utf8");
    }
    console.log(JSON.stringify({ status: "HYDRATION_COMPLETE", A: armResults.A.counts, C: armResults.C.counts }, null, 1));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(String(err && err.stack || err));
    process.exitCode = 1;
  });
}
