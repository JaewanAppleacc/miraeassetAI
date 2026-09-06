#!/usr/bin/env node
// Turn A2-DOCUMENTIR-NODESTORE-V1.1, Section 6: the single, exactly-once
// DEV_TUNE-101 execution of A2 (Section A of the task): frozen Arm A top-20
// -> node-grounded late expansion -> evidence scope validator -> PASS-only
// -> stable refill over the original rank order -> final top-10.
//
// No corpus path is hardcoded (CLAUDE.md: never commit a personal absolute
// path). Every real-data location is read from an environment variable,
// mirroring the project's existing CORPUS_PATH convention:
//
//   DOCUMENTIR_DIR              directory containing exchange.jsonl,
//                                holding.jsonl, major.jsonl, and the
//                                periodic file (required)
//   DOCUMENTIR_PERIODIC_FILENAME on-disk filename of the periodic file in
//                                DOCUMENTIR_DIR (default: periodic.jsonl;
//                                this session's real file is
//                                periodic-001.jsonl -- same content,
//                                different name, SHA-256-verified identical)
//   DOCUMENTIR_INDEX_DIR         optional directory with a pre-built
//                                {index_manifest.json, node_offsets.jsonl}
//                                byte-offset index (fast path); omitted ->
//                                bounded per-document streaming scan only
//   DOCUMENTS_METADATA_PATH      optional path to documents.jsonl (the
//                                existing document/company metadata seed --
//                                not Gold). Supplies each document's own
//                                `filer_name` as the evidence-side entity
//                                context for the entity dimension check;
//                                without it, entity stays permanently
//                                UNRESOLVED whenever a question requires one
//                                (neither A's result items nor
//                                buildNodeGroundedEvidence carries an entity
//                                field at all).
//
// Reads (read-only): A.results.jsonl (frozen top-20 input, unchanged),
// official/devtune101_conditions.v2.jsonl (question text + existing
// CompanyResolver output only -- no Gold), optionally documents.jsonl
// (document metadata only -- no Gold).
// Writes (new files only): results/A2.results.jsonl, results/A2.run.json.
// Never touches A.results.jsonl, A.run.json, or any B/C/D file.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { createDocumentIrFetchNode, loadPrebuiltOffsetIndex, verifyDocumentIrFiles } from "./a2-documentir-node-store.mjs";
import { extractQuestionConditions } from "./a2-question-condition-extractor.mjs";
import { runA2OverFrozenTop20 } from "./a2-integration-pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOUR_ARM_AC_DIR = HERE;
const A_RESULTS_PATH = path.join(FOUR_ARM_AC_DIR, "results", "A.results.jsonl");
const A_RUN_PATH = path.join(FOUR_ARM_AC_DIR, "results", "A.run.json");
const CONDITIONS_PATH = path.join(FOUR_ARM_AC_DIR, "official", "devtune101_conditions.v2.jsonl");
const A2_RESULTS_PATH = path.join(FOUR_ARM_AC_DIR, "results", "A2.results.jsonl");
const A2_RUN_PATH = path.join(FOUR_ARM_AC_DIR, "results", "A2.run.json");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8").trim().split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function main() {
  const documentIrDir = process.env.DOCUMENTIR_DIR;
  if (!documentIrDir) {
    console.error("DOCUMENTIR_DIR is not set -- refusing to run (see this file's header for the required env vars).");
    process.exitCode = 1;
    return;
  }
  const periodicFileName = process.env.DOCUMENTIR_PERIODIC_FILENAME || "periodic.jsonl";
  const documentIrPaths = {
    exchange: path.join(documentIrDir, "exchange.jsonl"),
    holding: path.join(documentIrDir, "holding.jsonl"),
    major: path.join(documentIrDir, "major.jsonl"),
    periodic: path.join(documentIrDir, periodicFileName),
  };

  const fileCheck = await verifyDocumentIrFiles(documentIrPaths);
  if (!fileCheck.ok) {
    console.error("DocumentIR file SHA-256 mismatch -- BLOCKED_INPUT_PIN:", JSON.stringify(fileCheck.mismatches));
    process.exitCode = 1;
    return;
  }

  let offsetIndex = null;
  if (process.env.DOCUMENTIR_INDEX_DIR) {
    const loaded = await loadPrebuiltOffsetIndex({ indexDir: process.env.DOCUMENTIR_INDEX_DIR, documentIrPaths });
    if (loaded.ok) offsetIndex = loaded.locations;
    else console.error(`prebuilt index unavailable (${loaded.reason}) -- falling back to bounded per-document streaming scan`);
  }

  let filerNameByDocId = null;
  if (process.env.DOCUMENTS_METADATA_PATH) {
    filerNameByDocId = new Map();
    for (const rec of readJsonl(process.env.DOCUMENTS_METADATA_PATH)) {
      if (rec.document_id && typeof rec.filer_name === "string" && rec.filer_name.trim() !== "") {
        filerNameByDocId.set(rec.document_id, rec.filer_name);
      }
    }
  }
  // `filer_name` is only reliably the SUBJECT entity for self-filed
  // disclosure types (periodic/major/exchange). For `holding` (지분 대량보유
  // 보고), the filer is a third-party reporting shareholder, not the
  // company the question is actually about (documents.jsonl carries no
  // separate subject-company field for that doc_group) -- applying
  // filer_name there would REJECT correct evidence on a filer/subject
  // mismatch that was never a real conflict. Left unresolved for `holding`
  // rather than guessed (found during this turn's own pre-execution
  // real-corpus batch smoke check, before any Gold/score was opened).
  const SELF_FILED_DOC_GROUPS = new Set(["periodic", "major", "exchange"]);
  const resolveEntity = filerNameByDocId
    ? (docId) => {
      const group = typeof docId === "string" ? docId.slice(0, docId.indexOf("_")) : null;
      if (!SELF_FILED_DOC_GROUPS.has(group)) return null;
      return filerNameByDocId.get(docId) ?? null;
    }
    : undefined;

  const aResultsRaw = readFileSync(A_RESULTS_PATH, "utf8").trim().split("\n").filter((l) => l.trim());
  const aRun = JSON.parse(readFileSync(A_RUN_PATH, "utf8"));
  const conditionsRows = readJsonl(CONDITIONS_PATH);
  const conditionsByQid = new Map(conditionsRows.map((r) => [r.question_id, r]));

  const a2Lines = [];
  const summary = { n_questions: 0, pass: 0, reject: 0, unresolved: 0, shortfall_questions: 0 };
  const startedAt = new Date().toISOString();

  for (const rawLine of aResultsRaw) {
    const aRec = JSON.parse(rawLine);
    const frozenTop20 = aRec.results;
    const condRow = conditionsByQid.get(aRec.question_id);
    if (!condRow) throw new Error(`no devtune101_conditions row for ${aRec.question_id} -- BLOCKED_INPUT_PIN`);

    const questionConditions = extractQuestionConditions({
      questionText: condRow.question,
      officialConditions: condRow.conditions,
    });

    const fetchNode = createDocumentIrFetchNode({
      documentIrPaths,
      offsetIndex,
      allowedLookupKeys: new Set(
        frozenTop20.flatMap((item) => {
          const indices = Array.isArray(item.node_indices) && item.node_indices.length > 0
            ? item.node_indices
            : (Number.isInteger(item.node_index) ? [item.node_index] : []);
          return indices.map((idx) => `${item.doc_id}::${idx}`);
        }),
      ),
    });

    // eslint-disable-next-line no-await-in-loop
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const a2 = await runA2OverFrozenTop20({ frozenTop20, questionConditions, fetchNode, finalK: 10, resolveEntity });
    const latencyMs = Date.now() - t0;

    for (const vr of a2.validationResults) {
      if (vr.status === "PASS") summary.pass += 1;
      else if (vr.status === "REJECT") summary.reject += 1;
      else summary.unresolved += 1;
    }
    if (a2.filterResult.finalTopKShortfall > 0) summary.shortfall_questions += 1;
    summary.n_questions += 1;

    a2Lines.push(JSON.stringify({
      question_id: aRec.question_id,
      arm: "A2",
      segment: aRec.segment,
      config_sha256: aRec.config_sha256,
      code_sha256: aRec.code_sha256,
      latency_ms: latencyMs,
      results: a2.filterResult.finalTopK,
    }));
  }

  writeFileSync(A2_RESULTS_PATH, `${a2Lines.join("\n")}\n`, "utf8");

  const a2Run = {
    arm: "A2",
    label: "A2_LATE_EXPANSION_SCOPE_VALIDATOR_STABLE_REFILL",
    base_arm: "A",
    base_arm_input_sha256: aRun.results_sha256,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    host: aRun.host,
    platform: process.platform,
    runtime: process.version,
    input_sha256: {
      conditions: sha256File(CONDITIONS_PATH),
      frozen_a_results: sha256File(A_RESULTS_PATH),
      document_ir: {
        "exchange.jsonl": await sha256FileAsync(documentIrPaths.exchange),
        "holding.jsonl": await sha256FileAsync(documentIrPaths.holding),
        "major.jsonl": await sha256FileAsync(documentIrPaths.major),
        "periodic.jsonl": await sha256FileAsync(documentIrPaths.periodic),
      },
    },
    n_questions: summary.n_questions,
    n_errors: 0,
    evidence_summary: summary,
    external_services: [],
  };
  writeFileSync(A2_RUN_PATH, JSON.stringify(a2Run, null, 2) + "\n", "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

async function sha256FileAsync(filePath) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
