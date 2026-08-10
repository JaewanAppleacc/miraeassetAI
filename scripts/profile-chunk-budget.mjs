import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--chunk-dir") args.chunkDir = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.chunkDir || !args.output) throw new Error("--chunk-dir and --output are required");
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalText(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function addGroup(map, key, chunk) {
  const group = map.get(key) ?? {
    count: 0,
    documentIds: new Set(),
    corpCodes: new Set(),
    docGroups: new Set(),
    chunkTypes: new Set(),
    preview: chunk.raw_text.slice(0, 180),
  };
  group.count += 1;
  group.documentIds.add(chunk.document_id);
  group.corpCodes.add(chunk.metadata.corp_code);
  group.docGroups.add(chunk.metadata.doc_group);
  group.chunkTypes.add(chunk.chunk_type);
  map.set(key, group);
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function groupSummary(map) {
  const duplicates = [...map.entries()].filter(([, group]) => group.count > 1);
  return {
    unique_fingerprints: map.size,
    duplicate_groups: duplicates.length,
    duplicate_instances: duplicates.reduce((sum, [, group]) => sum + group.count - 1, 0),
    cross_document_duplicate_groups: duplicates.filter(([, group]) => group.documentIds.size > 1).length,
    top_groups: duplicates
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 20)
      .map(([fingerprint, group]) => ({
        fingerprint,
        count: group.count,
        document_count: group.documentIds.size,
        corp_count: group.corpCodes.size,
        doc_groups: [...group.docGroups].sort(),
        chunk_types: [...group.chunkTypes].sort(),
        preview: group.preview,
      })),
  };
}

const args = parseArgs(process.argv.slice(2));
const chunkDir = resolve(args.chunkDir);
const manifest = JSON.parse(await readFile(join(chunkDir, "chunk-handoff-manifest.json"), "utf8"));
const strategyReports = [];

for (const artifact of manifest.strategy_artifacts) {
  const exactGroups = new Map();
  const canonicalGroups = new Map();
  const embedTextGroups = new Map();
  const byChunkType = {};
  const byDocGroup = {};
  const byCorpCode = {};
  const byDocument = {};
  let chunkCount = 0;
  let retrievalEligibleCount = 0;
  let retrievalTokenCount = 0;
  const lines = createInterface({
    input: createReadStream(join(chunkDir, artifact.file_name)),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    chunkCount += 1;
    increment(byChunkType, chunk.chunk_type);
    increment(byDocGroup, chunk.metadata.doc_group);
    increment(byCorpCode, chunk.metadata.corp_code);
    increment(byDocument, chunk.document_id);
    if (!chunk.metadata.retrieval_eligible) continue;
    retrievalEligibleCount += 1;
    retrievalTokenCount += chunk.embed_token_count;
    addGroup(exactGroups, chunk.content_sha256, chunk);
    addGroup(canonicalGroups, sha256(canonicalText(chunk.raw_text)), chunk);
    addGroup(embedTextGroups, sha256(chunk.embed_text), chunk);
  }
  const exact = groupSummary(exactGroups);
  const canonical = groupSummary(canonicalGroups);
  const embedText = groupSummary(embedTextGroups);
  const documentCounts = Object.values(byDocument);
  strategyReports.push({
    chunking_config_id: artifact.chunking_config_id,
    file_name: basename(artifact.file_name),
    chunk_count: chunkCount,
    retrieval_eligible_count: retrievalEligibleCount,
    retrieval_embed_token_count: retrievalTokenCount,
    embedding_api_call_count_with_exact_cache: embedText.unique_fingerprints,
    embedding_api_calls_saved_by_exact_cache: embedText.duplicate_instances,
    exact_duplicate_rate: retrievalEligibleCount === 0 ? 0 : exact.duplicate_instances / retrievalEligibleCount,
    canonical_duplicate_rate: retrievalEligibleCount === 0 ? 0 : canonical.duplicate_instances / retrievalEligibleCount,
    exact_duplicates: exact,
    canonical_duplicates: canonical,
    embed_text_duplicates: embedText,
    chunks_per_document: {
      min: Math.min(...documentCounts),
      p50: percentile(documentCounts, 0.5),
      p90: percentile(documentCounts, 0.9),
      max: Math.max(...documentCounts),
    },
    by_chunk_type: byChunkType,
    by_doc_group: byDocGroup,
    by_corp_code: byCorpCode,
    by_document: byDocument,
  });
}

const baseline = strategyReports.find((report) =>
  report.chunking_config_id === "fixed-token-512-o64.v0.1.0"
);
for (const report of strategyReports) {
  report.retrieval_chunk_ratio_vs_baseline = baseline
    ? report.retrieval_eligible_count / baseline.retrieval_eligible_count
    : null;
  report.embed_token_ratio_vs_baseline = baseline
    ? report.retrieval_embed_token_count / baseline.retrieval_embed_token_count
    : null;
}

const result = {
  report_version: "0.1.0",
  generated_at: new Date().toISOString(),
  corpus_snapshot_id: manifest.corpus_snapshot_id,
  source_handoff_created_at: manifest.created_at,
  scope: "REPRESENTATIVE_11_DOCUMENTS",
  strategy_reports: strategyReports,
};
await writeFile(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: resolve(args.output),
  strategies: strategyReports.map((report) => ({
    chunking_config_id: report.chunking_config_id,
    retrieval_eligible_count: report.retrieval_eligible_count,
    retrieval_chunk_ratio_vs_baseline: report.retrieval_chunk_ratio_vs_baseline,
    embed_token_ratio_vs_baseline: report.embed_token_ratio_vs_baseline,
    exact_duplicate_rate: report.exact_duplicate_rate,
    canonical_duplicate_rate: report.canonical_duplicate_rate,
    embedding_api_calls_saved_by_exact_cache: report.embedding_api_calls_saved_by_exact_cache,
  })),
}, null, 2)}\n`);
