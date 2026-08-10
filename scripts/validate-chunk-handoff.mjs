import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import chunkSchema from "../domain/chunking/chunk.schema.json" with { type: "json" };
import seedSchema from "../domain/retrieval/retrieval-evaluation-seed.schema.json" with { type: "json" };

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--chunk-dir") args.chunkDir = argv[++index];
    else if (token === "--evaluation-seed") args.evaluationSeed = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.chunkDir || !args.evaluationSeed) {
    throw new Error("--chunk-dir and --evaluation-seed are required");
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function overlaps(actual, expected) {
  if (actual.node_id !== expected.node_id || actual.rel_path !== expected.rel_path) return false;
  if (expected.row_start === null) return true;
  return actual.row_start !== null && actual.row_start <= expected.row_end && expected.row_start <= actual.row_end;
}

const args = parseArgs(process.argv.slice(2));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateChunk = ajv.compile(chunkSchema);
const validateSeed = ajv.compile(seedSchema);
const seeds = await readJsonl(args.evaluationSeed);
for (const seed of seeds) {
  if (!validateSeed(seed)) throw new Error(`${seed.query_id}: ${ajv.errorsText(validateSeed.errors)}`);
}

const handoffManifest = JSON.parse(await readFile(
  join(resolve(args.chunkDir), "chunk-handoff-manifest.json"),
  "utf8",
));
const manifestErrors = [];
const deliveredSchemaPath = join(resolve(args.chunkDir), "chunk.schema.json");
const deliveredConfigsPath = join(resolve(args.chunkDir), "strategy-configs.v0.1.json");
if (await sha256File(deliveredSchemaPath) !== handoffManifest.chunk_schema_sha256) {
  manifestErrors.push("chunk.schema.json byte SHA-256 does not match manifest");
}
if (await sha256File(deliveredConfigsPath) !== handoffManifest.strategy_configs_sha256) {
  manifestErrors.push("strategy-configs.v0.1.json byte SHA-256 does not match manifest");
}
const chunkFiles = handoffManifest.strategy_artifacts
  .map((artifact) => artifact.file_name)
  .sort();
const reports = [];
for (const fileName of chunkFiles) {
  const path = join(resolve(args.chunkDir), fileName);
  const artifactManifest = handoffManifest.strategy_artifacts.find((artifact) => artifact.file_name === fileName);
  if (await sha256File(path) !== artifactManifest.sha256) manifestErrors.push(`${fileName}: byte SHA-256 does not match manifest`);
  const found = new Map(seeds.map((seed) => [seed.query_id, new Set()]));
  let chunkCount = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (!validateChunk(chunk)) throw new Error(`${fileName}:${chunkCount + 1}: ${ajv.errorsText(validateChunk.errors)}`);
    chunkCount += 1;
    if (!chunk.metadata.retrieval_eligible) continue;
    for (const seed of seeds) {
      for (const [index, expected] of seed.required_evidence_spans.entries()) {
        if (chunk.document_id === expected.document_id && chunk.source_spans.some((span) => overlaps(span, expected))) {
          found.get(seed.query_id).add(index);
        }
      }
    }
  }
  const missing = [];
  for (const seed of seeds) {
    if (found.get(seed.query_id).size !== seed.required_evidence_spans.length) missing.push(seed.query_id);
  }
  reports.push({ file_name: basename(path), chunk_count: chunkCount, evidence_coverage: `${seeds.length - missing.length}/${seeds.length}`, missing });
}

const errors = [
  ...manifestErrors,
  ...reports.flatMap((report) => report.missing.map((queryId) => `${report.file_name}: ${queryId}`)),
];
process.stdout.write(`${JSON.stringify({
  status: errors.length === 0 ? "PASS" : "FAIL",
  evaluation_seed_count: seeds.length,
  strategy_reports: reports,
  errors,
}, null, 2)}\n`);
process.exitCode = errors.length === 0 ? 0 : 1;
