#!/usr/bin/env node
// Turn P10.1: builds the bounded, deterministic evaluation corpus shared
// identically by all 3 chunking strategies -- validates the DEV_TUNE input
// gate (fail-closed), computes positive (gold) + fixed-rule hard-negative
// document sets per item, extracts the needed raw DocumentIR records
// (streaming, bounded, from the real corpus), and writes:
//   work/p10.1-chunking-dev-tune/input-pin-manifest.v0.1.json
//   work/p10.1-chunking-dev-tune/evaluation-corpus-manifest.v0.1.json
//   work/p10.1-chunking-dev-tune/.raw-corpus-cache.v0.1.jsonl  (gitignored;
//     large materialized records, reused by the comparison runner so it
//     never re-streams the 8GB periodic-001.jsonl on every run)
//
// NEVER writes question/answer/evidence_span text into any committed file
// -- only document_id/corp_code/doc_group/role/question_id linkage.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateDevTuneInputGate, buildInputPinManifest } from "../domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs";
import { loadDocumentMetadataIndex } from "../domain/agent-comparison/chunking-comparison/document-metadata-index.mjs";
import { selectHardNegatives, MAX_HARD_NEGATIVES_PER_ITEM } from "../domain/agent-comparison/chunking-comparison/hard-negative-selector.mjs";
import { extractRawRecords } from "../domain/agent-comparison/chunking-comparison/raw-corpus-extractor.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "p10.1-chunking-dev-tune");
const GOLD_JSONL_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-gold.v0.1.jsonl");
const MANIFEST_PATH = path.join(ROOT, "domain/evaluation/releases/gold-phase1-207-v0.1/dev-tune-release-manifest.v0.1.json");
const MAIN_CHECKOUT_ROOT = "/Users/jaewan/Documents/Codex/2026-07-28/ai-ai-festival-agent-1-ai";
const RAW_SOURCE_DIR = path.join(MAIN_CHECKOUT_ROOT, "work/a-document-ir/source");
const DOCUMENTS_JSONL_PATH = path.join(MAIN_CHECKOUT_ROOT, "work/domain-seed/documents.jsonl");

async function main() {
  console.error("[p10.1-build-corpus] validating DEV_TUNE input gate (fail-closed)...");
  const { manifest, goldItems, checks } = await validateDevTuneInputGate({ goldJsonlPath: GOLD_JSONL_PATH, manifestPath: MANIFEST_PATH });
  console.error(`[p10.1-build-corpus] gate GREEN: ${goldItems.length} DEV_TUNE rows, owner_decision_sha256 pinned OK`);

  await mkdir(OUT_DIR, { recursive: true });
  const inputPinManifest = buildInputPinManifest({ manifest, goldItems, checks, goldJsonlPath: path.relative(ROOT, GOLD_JSONL_PATH), manifestPath: path.relative(ROOT, MANIFEST_PATH) });
  await writeFile(path.join(OUT_DIR, "input-pin-manifest.v0.1.json"), `${JSON.stringify(inputPinManifest, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "gate-status.v0.1.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    gate: "DEV_TUNE_INPUT_GATE",
    status: "GREEN",
    dev_check_accessed: false,
    holdout_accessed: false,
    row_count: goldItems.length,
    owner_decision_sha256: manifest.owner_decision_sha256,
  }, null, 2)}\n`);

  console.error("[p10.1-build-corpus] loading full document metadata index (read-only, 4,204 docs)...");
  const metadataIndex = await loadDocumentMetadataIndex(DOCUMENTS_JSONL_PATH);

  const itemEntries = [];
  const allDocumentIds = new Set();
  for (const item of goldItems) {
    const positives = [...(item.gold_document_ids ?? [])];
    const negatives = selectHardNegatives(item, metadataIndex);
    for (const id of [...positives, ...negatives]) allDocumentIds.add(id);
    itemEntries.push({
      question_id: item.question_id,
      corp_codes: item.corp_codes,
      doc_groups: item.doc_groups,
      as_of_date: item.as_of_date,
      expected_answerability: item.expected_answerability,
      question_type: item.question_type,
      positive_document_ids: positives,
      hard_negative_document_ids: negatives,
    });
  }

  const missingFromMetadata = [...allDocumentIds].filter((id) => !metadataIndex.byDocumentId.has(id));
  if (missingFromMetadata.length > 0) {
    throw new Error(`FAIL-CLOSED: ${missingFromMetadata.length} document_id(s) referenced by DEV_TUNE items are not present in documents.jsonl: ${missingFromMetadata.slice(0, 5).join(", ")}...`);
  }

  console.error(`[p10.1-build-corpus] evaluation corpus: ${allDocumentIds.size} unique documents (positives + up to ${MAX_HARD_NEGATIVES_PER_ITEM} hard negatives per item)`);
  console.error("[p10.1-build-corpus] streaming raw DocumentIR records from the real corpus (bounded, read-only)...");
  const rawRecords = await extractRawRecords(RAW_SOURCE_DIR, allDocumentIds);

  const missingFromRawCorpus = [...allDocumentIds].filter((id) => !rawRecords.has(id));
  if (missingFromRawCorpus.length > 0) {
    throw new Error(`FAIL-CLOSED: ${missingFromRawCorpus.length} document_id(s) not found in the raw corpus source files: ${missingFromRawCorpus.slice(0, 5).join(", ")}...`);
  }

  const evaluationCorpusManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    experiment_id: "p10.1-chunking-dev-tune-v01",
    dev_tune_item_count: goldItems.length,
    max_hard_negatives_per_item: MAX_HARD_NEGATIVES_PER_ITEM,
    hard_negative_rule: "corp_code(s) x doc_group match, excluding gold_document_ids, sorted by |days(receipt_date, as_of_date)| ascending then document_id ascending, capped at MAX_HARD_NEGATIVES_PER_ITEM total",
    total_unique_documents: allDocumentIds.size,
    raw_source_dir: path.relative(ROOT, RAW_SOURCE_DIR),
    documents_metadata_path: path.relative(ROOT, DOCUMENTS_JSONL_PATH),
    items: itemEntries,
  };
  await writeFile(path.join(OUT_DIR, "evaluation-corpus-manifest.v0.1.json"), `${JSON.stringify(evaluationCorpusManifest, null, 2)}\n`);

  // Local, gitignored materialization cache: raw DocumentIR records +
  // resolved document metadata, keyed by document_id. Reused (not
  // recomputed) by the comparison runner. Not committed -- work/ is
  // gitignored, and this line-by-line JSONL never contains Gold question/
  // answer text (only real corpus document content, same class of data
  // this Turn's brief already authorizes reading).
  const cacheLines = [...allDocumentIds].sort().map((id) => JSON.stringify({
    document_id: id,
    raw_record: rawRecords.get(id),
    metadata: metadataIndex.byDocumentId.get(id),
  }));
  await writeFile(path.join(OUT_DIR, ".raw-corpus-cache.v0.1.jsonl"), `${cacheLines.join("\n")}\n`);

  console.log(JSON.stringify({
    status: "OK",
    dev_tune_item_count: goldItems.length,
    total_unique_documents: allDocumentIds.size,
    input_pin_manifest: "work/p10.1-chunking-dev-tune/input-pin-manifest.v0.1.json",
    evaluation_corpus_manifest: "work/p10.1-chunking-dev-tune/evaluation-corpus-manifest.v0.1.json",
  }, null, 2));
}

main().catch((error) => {
  console.error("[p10.1-build-corpus] FAILED (fail-closed):", error.stack ?? error.message);
  process.exitCode = 1;
});
