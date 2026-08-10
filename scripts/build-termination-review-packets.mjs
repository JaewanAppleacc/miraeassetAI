import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../domain/relations/termination-review-packet.schema.json" with { type: "json" };

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--relations") args.relations = argv[++index];
    else if (token === "--semantic-bundles") args.semanticBundles = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["relations", "semanticBundles", "documents", "output"]) {
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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function documentIdOf(bundle) {
  return bundle?.facts?.[0]?.source_document_id ?? bundle?.evidence?.[0]?.document_id ?? null;
}

function documentRef(document) {
  return {
    document_id: document.document_id,
    corp_code: document.corp_code,
    report_name: document.report_name,
    receipt_date: document.receipt_date,
    is_correction: document.is_correction,
  };
}

function factRef(fact) {
  if (!fact) return null;
  return {
    fact_id: fact.fact_id,
    value_status: fact.value_status,
    raw_value_text: fact.raw_value_text,
    normalized_value: fact.normalized_value,
    evidence_ids: fact.evidence_ids,
  };
}

function evidenceRef(evidence) {
  return {
    evidence_id: evidence.evidence_id,
    document_id: evidence.document_id,
    source_locator: evidence.source_locator,
    quoted_text: evidence.quoted_text,
  };
}

const FIELD_MATCH_KEYS = new Map([
  ["CONTRACT_NAME", "contract_name"],
  ["CONTRACT_COUNTERPARTY", "counterparty"],
  ["CONTRACT_AMOUNT", "amount"],
  ["CONTRACT_START_DATE", "start_date"],
  ["CONTRACT_END_DATE", "end_date"],
]);

const args = parseArgs(process.argv.slice(2));
const [relations, bundles, documents] = await Promise.all([
  readJsonl(args.relations),
  readJsonl(args.semanticBundles),
  readJsonl(args.documents),
]);
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const bundlesById = new Map(bundles.map((bundle) => [documentIdOf(bundle), bundle]));
const amendsBySource = new Map(relations
  .filter((relation) => relation.relation_type === "AMENDS")
  .map((relation) => [relation.source_document_id, relation]));
const candidates = relations.filter((relation) =>
  relation.relation_type === "TERMINATES" &&
  relation.recommendation_status === "HIGH_CONFIDENCE_REVIEW"
);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const counts = { ready: 0, blocked_by_amends: 0 };

for (const relation of candidates) {
  const targetId = relation.recommended_target_document_id;
  const sourceDocument = documentsById.get(relation.source_document_id);
  const targetDocument = documentsById.get(targetId);
  const sourceBundle = bundlesById.get(relation.source_document_id);
  const targetBundle = bundlesById.get(targetId);
  if (!sourceDocument || !targetDocument || !sourceBundle || !targetBundle) {
    throw new Error(`${relation.source_document_id}: missing document or semantic bundle`);
  }
  const sourceFacts = new Map(sourceBundle.facts.map((fact) => [fact.metric_code, fact]));
  const targetFacts = new Map(targetBundle.facts.map((fact) => [fact.metric_code, fact]));
  const top = relation.candidates.find((candidate) => candidate.target_document_id === targetId);
  const amends = targetDocument.is_correction ? amendsBySource.get(targetId) : null;
  const requiresAmends = targetDocument.is_correction;
  const explicitEvidence = sourceBundle.evidence
    .filter((evidence) => /해지/.test(evidence.quoted_text ?? ""))
    .slice(0, 10)
    .map(evidenceRef);
  if (explicitEvidence.length === 0) throw new Error(`${relation.source_document_id}: no explicit termination evidence`);
  const packet = {
    schema_version: "0.1.0",
    review_packet_id: `termination_review_${digest(`${relation.source_document_id}\0${targetId}`).slice(0, 24)}`,
    corpus_snapshot_id: sourceDocument.corpus_snapshot_id,
    source_document: documentRef(sourceDocument),
    recommended_target_document: documentRef(targetDocument),
    identity_score: top.identity_score,
    field_comparison: [...FIELD_MATCH_KEYS].map(([metricCode, matchKey]) => ({
      metric_code: metricCode,
      matched: top.field_matches[matchKey],
      source_fact: factRef(sourceFacts.get(metricCode)),
      target_fact: factRef(targetFacts.get(metricCode)),
    })),
    explicit_termination_evidence: explicitEvidence,
    target_amends_dependency: {
      required: requiresAmends,
      relation_candidate_id: amends?.relation_candidate_id ?? null,
      review_status: amends?.review_status ?? null,
      candidate_target_document_ids: (amends?.candidates ?? []).map((candidate) => candidate.target_document_id),
    },
    machine_status: requiresAmends
      ? "BLOCKED_UNTIL_TARGET_AMENDS_CHAIN_CLOSURE"
      : "READY_FOR_HUMAN_REVIEW",
    review_status: "PENDING",
    review: { reviewer_id: null, reviewed_at: null, outcome: null, notes: null },
  };
  if (!validate(packet)) {
    throw new Error(`${packet.review_packet_id}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
  if (requiresAmends) counts.blocked_by_amends += 1;
  else counts.ready += 1;
  output.write(`${JSON.stringify(packet)}\n`);
}
await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify({ status: "PASS", packets: candidates.length, ...counts, output: outputPath }, null, 2)}\n`);
