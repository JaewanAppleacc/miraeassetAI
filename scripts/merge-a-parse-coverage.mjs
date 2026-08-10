import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ids } from "../domain/contracts.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--documents") args.documents = argv[++index];
    else if (token === "--parse-audit") args.parseAudit = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const field of ["documents", "parseAudit", "output"]) {
    if (!args[field]) throw new Error(`--${field.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

const args = parseArgs(process.argv.slice(2));
const documents = await readJsonl(args.documents);
const audits = await readJsonl(args.parseAudit);
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const seen = new Set();
const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const stateCounts = {};

for (const audit of audits) {
  const document = documentsById.get(audit.document_id);
  if (!document) throw new Error(`Parse audit references a non-manifest document: ${audit.document_id}`);
  if (seen.has(audit.document_id)) throw new Error(`Duplicate parse audit: ${audit.document_id}`);
  seen.add(audit.document_id);
  if (audit.corpus_snapshot_id !== document.corpus_snapshot_id) {
    throw new Error(`${audit.document_id}: target corpus snapshot does not match manifest seed`);
  }

  const record = {
    coverage_id: ids.coverage(
      document.corpus_snapshot_id,
      document.corp_code,
      document.doc_group,
      `document:${document.document_id}`,
    ),
    corpus_snapshot_id: document.corpus_snapshot_id,
    corp_code: document.corp_code,
    doc_group: document.doc_group,
    period_key: `document:${document.document_id}`,
    document_id: document.document_id,
    state: audit.coverage_state,
    reason_code: audit.coverage_reason_code,
    details: {
      coverage_layer: "PARSE",
      source_corpus_snapshot_id: audit.source_corpus_snapshot_id,
      source_parser_version: audit.source_parser_version,
      source_schema_version: audit.source_schema_version,
      source_parse_tier: audit.source_parse_tier,
      warning_codes: audit.warning_codes,
      file_count: audit.file_count,
      block_count: audit.block_count,
      table_count: audit.table_count,
      extracted_char_count: audit.extracted_char_count,
    },
  };
  if (!output.write(`${JSON.stringify(record)}\n`)) {
    await new Promise((resolveDrain) => output.once("drain", resolveDrain));
  }
  stateCounts[record.state] = (stateCounts[record.state] ?? 0) + 1;
}

const missing = documents.filter((document) => !seen.has(document.document_id));
if (missing.length > 0) throw new Error(`${missing.length} manifest documents have no parse audit`);
await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify({ documents: seen.size, states: stateCounts }, null, 2)}\n`);
