// Turn P5: orchestrates one deterministic pass over A's 4-file DocumentIR
// corpus (see domain/HANDOFF.md) plus its corpus manifest, producing the 10
// portable snapshot artifacts this Turn's task brief requires. This is the
// ONLY module in this Turn that touches the filesystem for the real corpus
// -- chunking-policy.mjs and document-record.mjs stay pure so they can be
// unit-tested without it.
//
// Memory discipline: the only things ever held fully in memory are (a) the
// small inventory.json, (b) the manifest.jsonl join map (one small row per
// document -- document METADATA, not DocumentIR content), and (c) small,
// bounded per-run counters (doc_group counts, a histogram, one integer per
// document for the chunks-per-document percentile calc). The 4-file raw
// corpus and every DocumentIR record are read and discarded one line at a
// time; nothing about their size is ever proportional to corpus size in
// memory.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { adaptADocumentIR, mapCoverageState } from "../../../adapters/a-document-ir.mjs";
import {
  SCHEMA_VERSION,
  DOC_GROUPS,
  canonicalizeExcluding,
  computeSnapshotId,
  sha256Hex,
  assertPortableRelativePath,
} from "./contracts.mjs";
import { DEFAULT_CHUNKING_POLICY, CHUNKING_POLICY_ID, computeChunkingPolicySha256, assertValidPolicy } from "./chunking-policy.mjs";
import { buildDocumentRecord, buildChunkRecords } from "./document-record.mjs";
import { createAtomicJsonlWriter, writeJsonFileAtomic } from "./snapshot-writer.mjs";

export class SnapshotBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotBuildError";
  }
}

// Fixed, alphabetical file processing order -- NEVER derived from
// `readdir()` (directory listing order is not guaranteed portable across
// filesystems/OSes). The same four names inventory.json itself always
// lists for this corpus (domain/HANDOFF.md: "원본 4개 JSONL").
const SOURCE_FILE_ORDER = Object.freeze(["exchange.jsonl", "holding.jsonl", "major.jsonl", "periodic-001.jsonl"]);

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function loadInventory(inventoryPath) {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  if (!Array.isArray(inventory.files) || inventory.files.length === 0) {
    throw new SnapshotBuildError(`${inventoryPath}: inventory.files must be a non-empty array`);
  }
  const byName = new Map(inventory.files.map((entry) => [entry.file_name, entry]));
  for (const name of SOURCE_FILE_ORDER) {
    if (!byName.has(name)) throw new SnapshotBuildError(`inventory.json is missing an entry for ${name}`);
  }
  return { inventory, byName };
}

// Fail-closed, BEFORE any document is processed: every source file's real
// on-disk sha256 must equal what inventory.json declares. A mismatch aborts
// the whole build -- it never silently processes a file that does not match
// its own pinned inventory.
async function verifySourceFileHashes(sourceDir, byName) {
  const results = [];
  for (const name of SOURCE_FILE_ORDER) {
    const expected = byName.get(name);
    const path = join(sourceDir, name);
    // eslint-disable-next-line no-await-in-loop
    const actual = await sha256OfFile(path);
    if (actual !== expected.sha256) {
      throw new SnapshotBuildError(
        `${name}: sha256 mismatch (inventory declares ${expected.sha256}, on-disk file is ${actual}) -- refusing to process an unpinned/modified input`,
      );
    }
    results.push({ file_name: name, sha256: actual, bytes: expected.bytes, lines: expected.lines });
  }
  return results;
}

async function loadManifest(manifestPath) {
  const manifestSha256 = await sha256OfFile(manifestPath);
  const byDocId = new Map();
  const groupCounts = {};
  const rl = createInterface({ input: createReadStream(manifestPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (byDocId.has(row.doc_id)) throw new SnapshotBuildError(`manifest.jsonl: duplicate doc_id ${row.doc_id}`);
    byDocId.set(row.doc_id, row);
    groupCounts[row.doc_group] = (groupCounts[row.doc_group] ?? 0) + 1;
  }
  return { byDocId, manifestSha256, groupCounts, totalRows: byDocId.size };
}

function newHistogram(edges) {
  const buckets = new Array(edges.length + 1).fill(0);
  return {
    add(value) {
      let index = edges.findIndex((edge) => value < edge);
      if (index === -1) index = edges.length;
      buckets[index] += 1;
    },
    toJSON() {
      const labels = [];
      for (let index = 0; index <= edges.length; index += 1) {
        const lower = index === 0 ? 0 : edges[index - 1];
        const upper = index === edges.length ? null : edges[index];
        labels.push({ range: upper === null ? `${lower}+` : `${lower}-${upper}`, count: buckets[index] });
      }
      return labels;
    },
  };
}

// Every path-shaped field this snapshot ever emits must be portable
// (repository/snapshot-relative, no "..", no absolute prefix, no home-dir
// reference) -- see contracts.mjs's assertPortableRelativePath. Checked
// inline, once per record, so a violation aborts the build immediately
// (fail-closed) rather than being discovered by a separate later scan.
function checkRecordPortability(documentRecord, chunks) {
  let checked = 0;
  for (const file of documentRecord.files) {
    assertPortableRelativePath(file.relative_path, `document ${documentRecord.source_document_id} file.relative_path`);
    checked += 1;
  }
  for (const chunk of chunks) {
    assertPortableRelativePath(chunk.source_locator, `chunk ${chunk.chunk_id} source_locator`);
    checked += 1;
    if (chunk.metadata.file_relative_path) {
      assertPortableRelativePath(chunk.metadata.file_relative_path, `chunk ${chunk.chunk_id} metadata.file_relative_path`);
      checked += 1;
    }
  }
  return checked;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[index];
}

export async function buildDocumentRetrievalSnapshot({
  inventoryPath,
  sourceDir,
  manifestPath,
  outputDir,
  policyOverrides = {},
  completedAt = new Date().toISOString(),
  expectedTotals = null,
  buildToolVersion = "0.1.0",
}) {
  const policy = assertValidPolicy({ ...DEFAULT_CHUNKING_POLICY, ...policyOverrides });
  const chunkingPolicySha256 = computeChunkingPolicySha256(policy);

  const { byName } = await loadInventory(inventoryPath);
  const sourceFileShas = await verifySourceFileHashes(sourceDir, byName);
  const { byDocId: manifestByDocId, manifestSha256, groupCounts: manifestGroupCounts, totalRows: manifestTotalRows } =
    await loadManifest(manifestPath);

  const snapshotId = computeSnapshotId({
    inputCorpusManifestSha256: manifestSha256,
    sourceFileShas,
    chunkingPolicyId: CHUNKING_POLICY_ID,
    chunkingPolicySha256,
    schemaVersion: SCHEMA_VERSION,
  });

  const recordsWriter = createAtomicJsonlWriter(join(outputDir, "document-records.v0.1.jsonl"));
  const chunksWriter = createAtomicJsonlWriter(join(outputDir, "document-chunks.v0.1.jsonl"));

  const seenDocumentIds = new Set();
  const coverageCounts = {};
  const groupCounts = {};
  const groupParseStatusCounts = {};
  const blockTypeChunkCounts = {};
  const chunkCountsPerDocument = [];
  const partialDocumentIds = [];
  const failedDocumentIds = [];
  let totalDocuments = 0;
  let totalChunks = 0;
  let totalChunkChars = 0;
  let maxChunkChars = 0;
  let portabilityChecked = 0;
  const chunkLengthHistogram = newHistogram([100, 300, 600, 900, 1200, 1600, 2400]);
  const chunksPerDocumentHistogram = newHistogram([1, 5, 20, 100, 500, 1500]);

  try {
    for (const fileEntry of sourceFileShas) {
      const rl = createInterface({ input: createReadStream(join(sourceDir, fileEntry.file_name)), crlfDelay: Infinity });
      // eslint-disable-next-line no-await-in-loop
      for await (const line of rl) {
        if (!line.trim()) continue;
        const rawRecord = JSON.parse(line);
        const documentId = rawRecord.doc_id;
        if (seenDocumentIds.has(documentId)) {
          throw new SnapshotBuildError(`duplicate source_document_id across corpus: ${documentId}`);
        }
        seenDocumentIds.add(documentId);

        const manifestRow = manifestByDocId.get(documentId);
        if (!manifestRow) {
          throw new SnapshotBuildError(`document_id ${documentId} (from ${fileEntry.file_name}) has no corpus manifest row -- fail-closed`);
        }

        const adapted = adaptADocumentIR(rawRecord, { completedAt, targetCorpusSnapshotId: rawRecord.corpus_snapshot_id });
        const coverage = mapCoverageState(rawRecord);

        const chunks = buildChunkRecords({
          schemaVersion: SCHEMA_VERSION,
          snapshotId,
          chunkingPolicyId: CHUNKING_POLICY_ID,
          chunkingPolicySha256,
          adapted,
          coverage,
          manifestRow,
        });
        // eslint-disable-next-line no-await-in-loop
        for (const chunk of chunks) {
          await chunksWriter.writeLine(chunk);
          totalChunks += 1;
          totalChunkChars += chunk.text_content.length;
          maxChunkChars = Math.max(maxChunkChars, chunk.text_content.length);
          chunkLengthHistogram.add(chunk.text_content.length);
          blockTypeChunkCounts[chunk.metadata.block_type] = (blockTypeChunkCounts[chunk.metadata.block_type] ?? 0) + 1;
        }

        const documentRecord = buildDocumentRecord({
          schemaVersion: SCHEMA_VERSION,
          snapshotId,
          adapted,
          coverage,
          manifestRow,
          chunkCount: chunks.length,
        });
        // eslint-disable-next-line no-await-in-loop
        await recordsWriter.writeLine(documentRecord);
        portabilityChecked += checkRecordPortability(documentRecord, chunks);

        totalDocuments += 1;
        coverageCounts[coverage.state] = (coverageCounts[coverage.state] ?? 0) + 1;
        groupCounts[manifestRow.doc_group] = (groupCounts[manifestRow.doc_group] ?? 0) + 1;
        const groupKey = `${manifestRow.doc_group}:${documentRecord.parse_status}`;
        groupParseStatusCounts[groupKey] = (groupParseStatusCounts[groupKey] ?? 0) + 1;
        chunkCountsPerDocument.push(chunks.length);
        chunksPerDocumentHistogram.add(chunks.length);
        if (documentRecord.parse_status === "PARTIAL") partialDocumentIds.push(documentId);
        if (documentRecord.parse_status === "FAILED") failedDocumentIds.push(documentId);
      }
    }
  } catch (error) {
    await recordsWriter.abort();
    await chunksWriter.abort();
    throw error;
  }

  const recordsResult = await recordsWriter.finish();
  const chunksResult = await chunksWriter.finish();

  // --- post-hoc, whole-corpus invariant checks (fail-closed) ---
  if (totalDocuments !== manifestTotalRows) {
    throw new SnapshotBuildError(`processed ${totalDocuments} documents but manifest has ${manifestTotalRows} rows`);
  }
  for (const group of DOC_GROUPS) {
    if ((groupCounts[group] ?? 0) !== (manifestGroupCounts[group] ?? 0)) {
      throw new SnapshotBuildError(`doc_group ${group}: processed ${groupCounts[group] ?? 0}, manifest declares ${manifestGroupCounts[group] ?? 0}`);
    }
  }
  if (expectedTotals) {
    if (totalDocuments !== expectedTotals.total_documents) {
      throw new SnapshotBuildError(`expected ${expectedTotals.total_documents} total documents, processed ${totalDocuments}`);
    }
    for (const [group, expected] of Object.entries(expectedTotals.doc_groups ?? {})) {
      if ((groupCounts[group] ?? 0) !== expected) {
        throw new SnapshotBuildError(`doc_group ${group}: expected ${expected}, processed ${groupCounts[group] ?? 0}`);
      }
    }
    for (const [state, expected] of Object.entries(expectedTotals.coverage_states ?? {})) {
      if ((coverageCounts[state] ?? 0) !== expected) {
        throw new SnapshotBuildError(`coverage state ${state}: expected ${expected}, observed ${coverageCounts[state] ?? 0}`);
      }
    }
  }

  const sortedChunkCounts = [...chunkCountsPerDocument].sort((a, b) => a - b);
  const manifestObject = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    generated_at: completedAt,
    build_tool_version: buildToolVersion,
    input_corpus_manifest_sha256: manifestSha256,
    input_source_files: sourceFileShas,
    total_documents: totalDocuments,
    doc_group_counts: groupCounts,
    coverage_state_counts: coverageCounts,
    chunking_policy_id: CHUNKING_POLICY_ID,
    chunking_policy_sha256: chunkingPolicySha256,
    document_records_file: { name: "document-records.v0.1.jsonl", line_count: recordsResult.lineCount, bytes: recordsResult.bytesWritten, sha256: recordsResult.sha256 },
    document_chunks_file: { name: "document-chunks.v0.1.jsonl", line_count: chunksResult.lineCount, bytes: chunksResult.bytesWritten, sha256: chunksResult.sha256 },
    total_chunks: totalChunks,
  };
  const canonicalManifestSha256 = sha256Hex(canonicalizeExcluding(manifestObject, ["generated_at"]));

  await writeJsonFileAtomic(join(outputDir, "document-snapshot-manifest.v0.1.json"), {
    ...manifestObject,
    canonical_manifest_sha256: canonicalManifestSha256,
  });

  await writeJsonFileAtomic(join(outputDir, "chunking-policy.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    chunking_policy_id: CHUNKING_POLICY_ID,
    chunking_policy_sha256: chunkingPolicySha256,
    policy,
    rules: [
      "1. DocumentIR node (block) boundaries are the primary chunk boundary.",
      "2. A node whose own text/table fits under max_chunk_chars becomes exactly one chunk.",
      "3. Only a node that does not fit is subdivided.",
      "4. TABLE nodes are subdivided by whole rows; a row's cells are never split across chunks.",
      "5. Non-table text prefers a newline boundary, then a sentence-ending boundary, then a hard character cut as last resort.",
      "6. max_chunk_chars / overlap_chars / table_max_chunk_chars are configuration, not hard-coded.",
      "7. Whitespace normalization is trim-leading-trailing-only; internal content is never altered.",
      "8. char_start/char_end index into the original (pre-trim) node text or this policy's own row-joined table serialization.",
      "9. A node with no extractable text or zero table rows produces zero chunks.",
      "10. This policy is a pure function of (blocks, policy) -- identical input always yields identical chunk ids and order.",
    ],
  });

  await writeJsonFileAtomic(join(outputDir, "parse-status-report.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    total_documents: totalDocuments,
    coverage_state_counts: coverageCounts,
    doc_group_counts: groupCounts,
    doc_group_x_parse_status_counts: groupParseStatusCounts,
    partial_document_ids: partialDocumentIds.sort(),
    failed_document_ids: failedDocumentIds.sort(),
  });

  await writeJsonFileAtomic(join(outputDir, "chunk-distribution-report.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    total_chunks: totalChunks,
    total_documents: totalDocuments,
    documents_with_zero_chunks: chunkCountsPerDocument.filter((count) => count === 0).length,
    chunk_char_length: {
      total_chars: totalChunkChars,
      mean_chars: totalChunks === 0 ? 0 : Math.round(totalChunkChars / totalChunks),
      max_chars: maxChunkChars,
      histogram: chunkLengthHistogram.toJSON(),
    },
    chunks_per_document: {
      p50: percentile(sortedChunkCounts, 50),
      p90: percentile(sortedChunkCounts, 90),
      p99: percentile(sortedChunkCounts, 99),
      max: sortedChunkCounts.length ? sortedChunkCounts[sortedChunkCounts.length - 1] : 0,
      histogram: chunksPerDocumentHistogram.toJSON(),
    },
    block_type_chunk_counts: blockTypeChunkCounts,
  });

  await writeJsonFileAtomic(join(outputDir, "portability-report.v0.1.json"), {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    checks: [
      "no absolute path prefix (/ or drive letter)",
      "no home-directory reference (~)",
      "no '..' path segments",
    ],
    paths_checked: portabilityChecked,
    violations_found: 0,
    status: "PASS",
  });

  return {
    snapshotId,
    chunkingPolicySha256,
    manifestSha256,
    totalDocuments,
    totalChunks,
    coverageCounts,
    groupCounts,
    canonicalManifestSha256,
    documentRecordsSha256: recordsResult.sha256,
    documentChunksSha256: chunksResult.sha256,
    portabilityChecked,
    outputDir,
  };
}

export async function cleanupScratchDir(path) {
  await rm(path, { recursive: true, force: true });
}
