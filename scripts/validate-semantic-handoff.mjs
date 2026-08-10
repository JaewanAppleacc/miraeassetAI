import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

function parseArgs(argv) {
  const args = { handoffDir: "work/semantic-handoff" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--handoff-dir") args.handoffDir = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const dir = resolve(args.handoffDir);
const manifest = JSON.parse(await readFile(join(dir, "semantic-handoff-manifest.json"), "utf8"));
const schema = JSON.parse(await readFile(join(dir, "semantic-bundle.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const errors = [];

for (const contract of manifest.contracts) {
  const actual = await sha256(join(dir, contract.file_name));
  if (actual !== contract.sha256) errors.push(`${contract.file_name}: hash mismatch`);
}
const samplePath = join(dir, manifest.sample_artifact.file_name);
if (await sha256(samplePath) !== manifest.sample_artifact.sha256) errors.push("sample artifact: hash mismatch");

let bundles = 0;
let facts = 0;
let events = 0;
let relations = 0;
let evidence = 0;
const seenDocuments = new Set();
const lines = createInterface({ input: createReadStream(samplePath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const bundle = JSON.parse(line);
  bundles += 1;
  if (!validate(bundle)) errors.push(`line ${bundles}: ${ajv.errorsText(validate.errors)}`);
  if (bundle.corpus_snapshot_id !== manifest.corpus_snapshot_id) errors.push(`line ${bundles}: corpus snapshot drift`);
  const id = bundle.facts[0]?.source_document_id ?? bundle.evidence[0]?.document_id;
  if (seenDocuments.has(id)) errors.push(`line ${bundles}: duplicate document ${id}`);
  seenDocuments.add(id);
  facts += bundle.facts.length;
  events += bundle.events.length;
  relations += bundle.relations.length;
  evidence += bundle.evidence.length;
  const evidenceIds = new Set(bundle.evidence.map((item) => item.evidence_id));
  for (const fact of bundle.facts) {
    if (fact.verification_status !== "CANDIDATE") errors.push(`${fact.fact_id}: sample must remain CANDIDATE`);
    for (const evidenceId of fact.evidence_ids) {
      if (!evidenceIds.has(evidenceId)) errors.push(`${fact.fact_id}: missing evidence ${evidenceId}`);
    }
  }
  for (const item of bundle.evidence) {
    if (item.verification_status !== "CANDIDATE") errors.push(`${item.evidence_id}: sample must remain CANDIDATE`);
  }
}

for (const [key, actual] of Object.entries({ bundle_count: bundles, fact_count: facts, event_count: events, relation_count: relations, evidence_count: evidence })) {
  if (manifest.sample_artifact[key] !== actual) errors.push(`${key}: manifest=${manifest.sample_artifact[key]} actual=${actual}`);
}
if (manifest.official_runtime_eligible !== false) errors.push("candidate package must not be official-runtime eligible");

process.stdout.write(`${JSON.stringify({
  status: errors.length === 0 ? "PASS" : "FAIL",
  bundles,
  facts,
  events,
  relations,
  evidence,
  errors,
}, null, 2)}\n`);
process.exitCode = errors.length === 0 ? 0 : 1;
