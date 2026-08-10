import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import chunkSchema from "../domain/chunking/chunk.schema.json" with { type: "json" };
import defaultConfigs from "../domain/chunking/strategy-configs.v0.1.json" with { type: "json" };
import { chunkDocument } from "../domain/chunking/chunker.mjs";

function parseArgs(argv) {
  const args = { configs: "domain/chunking/strategy-configs.v0.1.json", createdAt: new Date().toISOString() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--representative") args.representative = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--a-handoff-manifest") args.aHandoffManifest = argv[++index];
    else if (token === "--configs") args.configs = argv[++index];
    else if (token === "--output-dir") args.outputDir = argv[++index];
    else if (token === "--target-corpus-snapshot-id") args.targetCorpusSnapshotId = argv[++index];
    else if (token === "--created-at") args.createdAt = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const field of ["representative", "documents", "aHandoffManifest", "outputDir", "targetCorpusSnapshotId"]) {
    if (!args[field]) throw new Error(`Missing required option: ${field}`);
  }
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitText(args, fallback = null) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function writeJsonLine(stream, value) {
  if (stream.write(`${JSON.stringify(value)}\n`)) return Promise.resolve();
  return new Promise((resolveDrain) => stream.once("drain", resolveDrain));
}

const args = parseArgs(process.argv.slice(2));
const representative = await readJsonl(args.representative);
const documents = await readJsonl(args.documents);
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const handoff = JSON.parse(await readFile(resolve(args.aHandoffManifest), "utf8"));
const configsFile = JSON.parse(await readFile(resolve(args.configs), "utf8"));
if (JSON.stringify(configsFile) !== JSON.stringify(defaultConfigs)) {
  throw new Error("Runtime strategy config differs from the imported version");
}
if (representative.length !== 11) throw new Error(`Expected 11 representative records, found ${representative.length}`);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(chunkSchema);
const outputDir = resolve(args.outputDir);
await mkdir(outputDir, { recursive: true });
const strategyArtifacts = [];

for (const config of configsFile.strategies) {
  const outputPath = join(outputDir, `${config.chunking_config_id}.jsonl`);
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  const summary = {
    chunking_config_id: config.chunking_config_id,
    strategy_name: config.strategy_name,
    strategy_version: config.strategy_version,
    config_sha256: sha256(JSON.stringify(canonical(config))),
    document_count: 0,
    chunk_count: 0,
    retrieval_eligible_count: 0,
    by_chunk_type: {},
    by_document: {},
  };
  for (const record of representative) {
    const document = documentsById.get(record.doc_id);
    if (!document) throw new Error(`Representative DocumentIR is not in manifest: ${record.doc_id}`);
    const chunks = chunkDocument(record, document, config, {
      targetCorpusSnapshotId: args.targetCorpusSnapshotId,
      parserCodeRevision: handoff.code_revision,
      parserConfigHash: handoff.parser_config_hash,
    });
    const chunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));
    for (const chunk of chunks) {
      if (!validate(chunk)) {
        throw new Error(`${chunk.chunk_id}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
      }
      if (chunk.parent_chunk_id && !chunkIds.has(chunk.parent_chunk_id)) {
        throw new Error(`${chunk.chunk_id}: parent chunk is missing from the same document artifact`);
      }
      await writeJsonLine(output, chunk);
      summary.chunk_count += 1;
      if (chunk.metadata.retrieval_eligible) summary.retrieval_eligible_count += 1;
      summary.by_chunk_type[chunk.chunk_type] = (summary.by_chunk_type[chunk.chunk_type] ?? 0) + 1;
    }
    summary.document_count += 1;
    summary.by_document[record.doc_id] = chunks.length;
  }
  await new Promise((resolveEnd) => output.end(resolveEnd));
  const fileStat = await stat(outputPath);
  strategyArtifacts.push({
    ...summary,
    file_name: basename(outputPath),
    bytes: fileStat.size,
    sha256: await sha256File(outputPath),
  });
}

const manifest = {
  handoff_version: "0.1.0",
  created_at: args.createdAt,
  corpus_snapshot_id: args.targetCorpusSnapshotId,
  producer_code: {
    repository: gitText(["config", "--get", "remote.origin.url"]),
    branch: gitText(["branch", "--show-current"]),
    git_head: gitText(["rev-parse", "HEAD"]),
    worktree_state: gitText(["status", "--porcelain", "--", "domain/chunking/chunker.mjs", "scripts/generate-representative-chunks.mjs"], "") === ""
      ? "CLEAN_FOR_RELEVANT_FILES"
      : "UNCOMMITTED_RELEVANT_FILES",
    chunker_file_sha256: await sha256File(resolve("domain/chunking/chunker.mjs")),
    generator_file_sha256: await sha256File(resolve("scripts/generate-representative-chunks.mjs")),
  },
  source_document_ir: {
    source_corpus_snapshot_id: handoff.corpus_snapshot_id,
    manifest_sha256: handoff.manifest_sha256,
    universe_sha256: handoff.universe_sha256,
    parser_version: handoff.parser_version,
    schema_version: handoff.document_ir_schema_version,
    parser_code_revision: handoff.code_revision,
    parser_config_hash: handoff.parser_config_hash,
    reproducibility: {
      deterministic_by_design: true,
      full_corpus_rerun_hash_comparison: "NOT_RUN",
    },
    parse_coverage: {
      present: 4123,
      partial_parse_failure_fallback: 79,
      parse_failed_pdf_viewer_empty: 2,
    },
  },
  chunk_schema_version: chunkSchema.properties.schema_version.const,
  // Handoff hashes always mean the exact delivered file bytes. Per-strategy
  // semantic config hashes remain canonical-object hashes and are named separately.
  chunk_schema_sha256: await sha256File(resolve("domain/chunking/chunk.schema.json")),
  strategy_configs_sha256: await sha256File(resolve(args.configs)),
  representative_document_ids: representative.map((record) => record.doc_id),
  strategy_artifacts: strategyArtifacts,
};
await writeFile(join(outputDir, "chunk-handoff-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const supportFiles = [
  "domain/adapters/A_HANDOFF_SNAPSHOT.md",
  "domain/adapters/a-warning-policy.v1.0.json",
  "domain/chunking/chunk.schema.json",
  "domain/chunking/FULL_CORPUS_BUDGET_DECISION.md",
  "domain/chunking/strategy-configs.v0.1.json",
  "domain/retrieval/retrieval-request.schema.json",
  "domain/retrieval/retrieval-result.schema.json",
  "domain/retrieval/retrieval-evaluation-seed.schema.json",
  "domain/retrieval/retrieval-evaluation-seed.v0.1.jsonl",
];
for (const sourcePath of supportFiles) {
  await copyFile(resolve(sourcePath), join(outputDir, basename(sourcePath)));
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
