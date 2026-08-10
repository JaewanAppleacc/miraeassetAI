import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../domain/interfaces/semantic-bundle.schema.json" with { type: "json" };
import { extractExchangeContractBundle } from "../domain/facts/extract-exchange-contract.mjs";

function parseArgs(argv) {
  const args = { createdAt: new Date().toISOString() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") args.input = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--ontology") args.ontology = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--target-corpus-snapshot-id") args.targetCorpusSnapshotId = argv[++index];
    else if (token === "--created-at") args.createdAt = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const field of ["input", "documents", "ontology", "output", "targetCorpusSnapshotId"]) {
    if (!args[field]) throw new Error(`Missing required option: ${field}`);
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
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const ontologyJson = JSON.parse(await readFile(resolve(args.ontology), "utf8"));
const metricOntology = new Map(ontologyJson.metrics.map((metric) => [metric.metric_code, metric]));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const summary = { documents: 0, bundles: 0, facts: 0, evidence: 0, metrics: {}, value_statuses: {} };
const lines = createInterface({ input: createReadStream(resolve(args.input)), crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  const source = JSON.parse(line);
  const document = documentsById.get(source.doc_id);
  if (!document) throw new Error(`Non-manifest DocumentIR record: ${source.doc_id}`);
  summary.documents += 1;
  const bundle = extractExchangeContractBundle(source, document, metricOntology, {
    targetCorpusSnapshotId: args.targetCorpusSnapshotId,
    createdAt: args.createdAt,
  });
  if (!bundle) continue;
  if (!validate(bundle)) {
    throw new Error(`${source.doc_id}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
  if (!output.write(`${JSON.stringify(bundle)}\n`)) {
    await new Promise((resolveDrain) => output.once("drain", resolveDrain));
  }
  summary.bundles += 1;
  summary.facts += bundle.facts.length;
  summary.evidence += bundle.evidence.length;
  for (const fact of bundle.facts) {
    summary.metrics[fact.metric_code] = (summary.metrics[fact.metric_code] ?? 0) + 1;
    summary.value_statuses[fact.value_status] = (summary.value_statuses[fact.value_status] ?? 0) + 1;
  }
}
await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
