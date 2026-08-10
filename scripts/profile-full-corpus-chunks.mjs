import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import configs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };
import { chunkDocument } from "../domain/chunking/chunker.mjs";

function parseArgs(argv) {
  const args = { limit: Infinity, progressEvery: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input-dir") args.inputDir = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--a-handoff-manifest") args.aHandoffManifest = argv[++index];
    else if (token === "--target-corpus-snapshot-id") args.targetCorpusSnapshotId = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--limit") args.limit = Number(argv[++index]);
    else if (token === "--progress-every") args.progressEvery = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["inputDir", "documents", "aHandoffManifest", "targetCorpusSnapshotId", "output"]) {
    if (!args[key]) throw new Error(`Missing required option: ${key}`);
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalText(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

class HyperLogLog {
  constructor(precision = 14) {
    this.precision = precision;
    this.bucketCount = 2 ** precision;
    this.registers = new Uint8Array(this.bucketCount);
  }

  add(hexHash) {
    const prefix = Number.parseInt(hexHash.slice(0, 4), 16);
    const bucket = prefix >>> (16 - this.precision);
    let value = Number.parseInt(hexHash.slice(4, 12), 16) >>> 0;
    let rank = Math.clz32(value) + 1;
    if (value === 0) {
      value = Number.parseInt(hexHash.slice(12, 20), 16) >>> 0;
      rank = 33 + Math.clz32(value);
    }
    this.registers[bucket] = Math.max(this.registers[bucket], rank);
  }

  estimate() {
    const size = this.bucketCount;
    const alpha = 0.7213 / (1 + 1.079 / size);
    let harmonic = 0;
    let zeroes = 0;
    for (const register of this.registers) {
      harmonic += 2 ** -register;
      if (register === 0) zeroes += 1;
    }
    const raw = alpha * size * size / harmonic;
    if (raw <= 2.5 * size && zeroes > 0) return size * Math.log(size / zeroes);
    return raw;
  }
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))];
}

function newReport(config) {
  return {
    chunking_config_id: config.chunking_config_id,
    strategy_name: config.strategy_name,
    document_count: 0,
    chunk_count: 0,
    retrieval_eligible_count: 0,
    retrieval_embed_token_count: 0,
    exact_cardinality: new HyperLogLog(),
    canonical_cardinality: new HyperLogLog(),
    embed_text_cardinality: new HyperLogLog(),
    chunksPerDocument: [],
    retrievalChunksPerDocument: [],
    by_chunk_type: {},
    by_doc_group: {},
    by_corp_code: {},
    retrieval_by_chunk_type: {},
    retrieval_by_doc_group: {},
    retrieval_by_corp_code: {},
  };
}

const args = parseArgs(process.argv.slice(2));
const documents = await readJsonl(args.documents);
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const handoff = JSON.parse(await readFile(resolve(args.aHandoffManifest), "utf8"));
const inputFiles = (await readdir(resolve(args.inputDir)))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()
  .map((name) => join(resolve(args.inputDir), name));
const reports = configs.strategies.map(newReport);
let processed = 0;

outer: for (const inputFile of inputFiles) {
  const lines = createInterface({ input: createReadStream(inputFile), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const document = documentsById.get(record.doc_id);
    if (!document) throw new Error(`${record.doc_id}: DocumentIR is outside manifest seed`);
    for (const [index, config] of configs.strategies.entries()) {
      const report = reports[index];
      const chunks = chunkDocument(record, document, config, {
        targetCorpusSnapshotId: args.targetCorpusSnapshotId,
        parserCodeRevision: handoff.code_revision,
        parserConfigHash: handoff.parser_config_hash,
      });
      let retrievalInDocument = 0;
      for (const chunk of chunks) {
        report.chunk_count += 1;
        increment(report.by_chunk_type, chunk.chunk_type);
        increment(report.by_doc_group, chunk.metadata.doc_group);
        increment(report.by_corp_code, chunk.metadata.corp_code);
        if (!chunk.metadata.retrieval_eligible) continue;
        report.retrieval_eligible_count += 1;
        retrievalInDocument += 1;
        report.retrieval_embed_token_count += chunk.embed_token_count;
        increment(report.retrieval_by_chunk_type, chunk.chunk_type);
        increment(report.retrieval_by_doc_group, chunk.metadata.doc_group);
        increment(report.retrieval_by_corp_code, chunk.metadata.corp_code);
        report.exact_cardinality.add(chunk.content_sha256);
        report.canonical_cardinality.add(sha256(canonicalText(chunk.raw_text)));
        report.embed_text_cardinality.add(sha256(chunk.embed_text));
      }
      report.document_count += 1;
      report.chunksPerDocument.push(chunks.length);
      report.retrievalChunksPerDocument.push(retrievalInDocument);
    }
    processed += 1;
    if (processed % args.progressEvery === 0) {
      process.stderr.write(`profiled ${processed} documents\n`);
    }
    if (processed >= args.limit) {
      lines.close();
      break outer;
    }
  }
}

const finalized = reports.map((report) => {
  const estimatedExactUnique = Math.round(report.exact_cardinality.estimate());
  const estimatedCanonicalUnique = Math.round(report.canonical_cardinality.estimate());
  const estimatedEmbedTextUnique = Math.round(report.embed_text_cardinality.estimate());
  return {
    chunking_config_id: report.chunking_config_id,
    strategy_name: report.strategy_name,
    document_count: report.document_count,
    chunk_count: report.chunk_count,
    retrieval_eligible_count: report.retrieval_eligible_count,
    retrieval_embed_token_count: report.retrieval_embed_token_count,
    estimated_embedding_api_call_count_with_exact_cache: estimatedEmbedTextUnique,
    estimated_embedding_api_calls_saved_by_exact_cache:
      Math.max(0, report.retrieval_eligible_count - estimatedEmbedTextUnique),
    estimated_global_exact_unique: estimatedExactUnique,
    estimated_global_canonical_unique: estimatedCanonicalUnique,
    estimated_global_exact_duplicate_rate: report.retrieval_eligible_count === 0
      ? 0
      : Math.max(0, 1 - estimatedExactUnique / report.retrieval_eligible_count),
    estimated_global_canonical_duplicate_rate: report.retrieval_eligible_count === 0
      ? 0
      : Math.max(0, 1 - estimatedCanonicalUnique / report.retrieval_eligible_count),
    chunks_per_document: {
      min: Math.min(...report.chunksPerDocument),
      p50: percentile(report.chunksPerDocument, 0.5),
      p90: percentile(report.chunksPerDocument, 0.9),
      p99: percentile(report.chunksPerDocument, 0.99),
      max: Math.max(...report.chunksPerDocument),
    },
    retrieval_chunks_per_document: {
      min: Math.min(...report.retrievalChunksPerDocument),
      p50: percentile(report.retrievalChunksPerDocument, 0.5),
      p90: percentile(report.retrievalChunksPerDocument, 0.9),
      p99: percentile(report.retrievalChunksPerDocument, 0.99),
      max: Math.max(...report.retrievalChunksPerDocument),
    },
    by_chunk_type: report.by_chunk_type,
    by_doc_group: report.by_doc_group,
    by_corp_code: report.by_corp_code,
    retrieval_by_chunk_type: report.retrieval_by_chunk_type,
    retrieval_by_doc_group: report.retrieval_by_doc_group,
    retrieval_by_corp_code: report.retrieval_by_corp_code,
  };
});
const baseline = finalized.find((report) => report.chunking_config_id === "fixed-token-512-o64.v0.1.0");
for (const report of finalized) {
  report.retrieval_chunk_ratio_vs_baseline = report.retrieval_eligible_count / baseline.retrieval_eligible_count;
  report.embed_token_ratio_vs_baseline = report.retrieval_embed_token_count / baseline.retrieval_embed_token_count;
}

const result = {
  report_version: "0.1.0",
  generated_at: new Date().toISOString(),
  scope: processed === documents.length ? "FULL_CORPUS" : "PREFIX_SAMPLE",
  corpus_snapshot_id: args.targetCorpusSnapshotId,
  source_corpus_snapshot_id: handoff.corpus_snapshot_id,
  parser_version: handoff.parser_version,
  parser_code_revision: handoff.code_revision,
  document_count: processed,
  approximate_cardinality_method: "HyperLogLog p=14",
  strategy_reports: finalized,
};
await mkdir(dirname(resolve(args.output)), { recursive: true });
await writeFile(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  output: resolve(args.output),
  scope: result.scope,
  document_count: processed,
  strategies: finalized.map((report) => ({
    chunking_config_id: report.chunking_config_id,
    retrieval_eligible_count: report.retrieval_eligible_count,
    retrieval_chunk_ratio_vs_baseline: report.retrieval_chunk_ratio_vs_baseline,
    embed_token_ratio_vs_baseline: report.embed_token_ratio_vs_baseline,
    estimated_embedding_api_calls_saved_by_exact_cache:
      report.estimated_embedding_api_calls_saved_by_exact_cache,
    estimated_global_exact_duplicate_rate: report.estimated_global_exact_duplicate_rate,
  })),
}, null, 2)}\n`);
