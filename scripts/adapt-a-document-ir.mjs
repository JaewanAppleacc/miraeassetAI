import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../domain/interfaces/document-ir.schema.json" with { type: "json" };
import { adaptADocumentIR, mapCoverageState } from "../domain/adapters/a-document-ir.mjs";

function parseArgs(argv) {
  const args = { validateOnly: false, limit: Infinity, limitPerFile: Infinity, completedAt: new Date().toISOString() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input-dir") args.inputDir = argv[++index];
    else if (token === "--target-corpus-snapshot-id") args.targetCorpusSnapshotId = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--audit-output") args.auditOutput = argv[++index];
    else if (token === "--limit") args.limit = Number(argv[++index]);
    else if (token === "--limit-per-file") args.limitPerFile = Number(argv[++index]);
    else if (token === "--completed-at") args.completedAt = argv[++index];
    else if (token === "--validate-only") args.validateOnly = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!args.inputDir) throw new Error("--input-dir is required");
  if (!args.validateOnly && !args.output) throw new Error("--output is required unless --validate-only is used");
  return args;
}

function writeLine(stream, value) {
  if (!stream) return Promise.resolve();
  if (stream.write(`${JSON.stringify(value)}\n`)) return Promise.resolve();
  return new Promise((resolveDrain) => stream.once("drain", resolveDrain));
}

const args = parseArgs(process.argv.slice(2));
const inputDir = resolve(args.inputDir);
const inputFiles = (await readdir(inputDir))
  .filter((name) => name.endsWith(".jsonl"))
  .sort()
  .map((name) => join(inputDir, name));
if (inputFiles.length === 0) throw new Error(`No JSONL files found in ${inputDir}`);

if (args.output) await mkdir(dirname(resolve(args.output)), { recursive: true });
if (args.auditOutput) await mkdir(dirname(resolve(args.auditOutput)), { recursive: true });
const output = args.output ? createWriteStream(resolve(args.output), { encoding: "utf8" }) : null;
const auditOutput = args.auditOutput ? createWriteStream(resolve(args.auditOutput), { encoding: "utf8" }) : null;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const summary = {
  input_dir: inputDir,
  input_files: inputFiles.map((inputFile) => basename(inputFile)),
  completed_at: args.completedAt,
  documents: 0,
  files: 0,
  blocks: 0,
  tables: 0,
  coverage: {},
  source_parse_tiers: {},
};

outer: for (const inputFile of inputFiles) {
  const lines = createInterface({ input: createReadStream(inputFile), crlfDelay: Infinity });
  let lineNumber = 0;
  let fileDocuments = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const source = JSON.parse(line);
    const adapted = adaptADocumentIR(source, {
      completedAt: args.completedAt,
      targetCorpusSnapshotId: args.targetCorpusSnapshotId,
    });
    if (!validate(adapted)) {
      throw new Error(`${inputFile}:${lineNumber}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    }

    const coverage = mapCoverageState(source);
    await writeLine(output, adapted);
    await writeLine(auditOutput, {
      corpus_snapshot_id: adapted.corpus_snapshot_id,
      source_corpus_snapshot_id: source.corpus_snapshot_id,
      document_id: source.doc_id,
      source_file: basename(inputFile),
      source_parser_version: source.parser_version,
      source_schema_version: source.schema_version,
      source_parse_tier: source.parse_quality?.tier ?? null,
      coverage_state: coverage.state,
      coverage_reason_code: coverage.reason_code,
      warning_codes: [...new Set((source.warnings ?? []).map((warning) => warning.code).filter(Boolean))].sort(),
      file_count: adapted.files.length,
      block_count: adapted.blocks.length,
      table_count: adapted.quality_summary.table_count,
      extracted_char_count: adapted.quality_summary.extracted_char_count,
    });

    summary.documents += 1;
    fileDocuments += 1;
    summary.files += adapted.files.length;
    summary.blocks += adapted.blocks.length;
    summary.tables += adapted.quality_summary.table_count;
    summary.coverage[coverage.reason_code] = (summary.coverage[coverage.reason_code] ?? 0) + 1;
    const tier = source.parse_quality?.tier ?? "unknown";
    summary.source_parse_tiers[tier] = (summary.source_parse_tiers[tier] ?? 0) + 1;
    if (summary.documents >= args.limit) {
      lines.close();
      break outer;
    }
    if (fileDocuments >= args.limitPerFile) {
      lines.close();
      break;
    }
  }
}

await Promise.all([
  output ? new Promise((resolveEnd) => output.end(resolveEnd)) : Promise.resolve(),
  auditOutput ? new Promise((resolveEnd) => auditOutput.end(resolveEnd)) : Promise.resolve(),
]);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
