import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--relations") args.relations = argv[++index];
    else if (token === "--references") args.references = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["relations", "references", "documents", "output"]) {
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

const args = parseArgs(process.argv.slice(2));
const [relations, references, documents] = await Promise.all([
  readJsonl(args.relations),
  readJsonl(args.references),
  readJsonl(args.documents),
]);
const referencesBySource = new Map(references.map((reference) => [reference.source_document_id, reference]));
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const counts = { matched: 0, outside: 0, ambiguous: 0 };

for (const relation of relations) {
  const reference = relation.relation_type === "AMENDS"
    ? referencesBySource.get(relation.source_document_id)
    : null;
  if (!reference) {
    output.write(`${JSON.stringify(relation)}\n`);
    continue;
  }
  let candidates = relation.candidates;
  if (reference.reference_status === "MATCHED_IN_CORPUS") {
    counts.matched += 1;
    const targetId = reference.recommended_target_document_id;
    const target = documentsById.get(targetId);
    const explicit = {
      target_document_id: targetId,
      score: 1,
      reasons: ["explicit_referenced_receipt_date", "same_corp_code", "same_report_family"],
      target_report_name: target.report_name,
      target_receipt_date: target.receipt_date,
    };
    candidates = [explicit, ...candidates.filter((candidate) => candidate.target_document_id !== targetId)];
  } else if (reference.reference_status === "TARGET_NOT_IN_CORPUS") counts.outside += 1;
  else counts.ambiguous += 1;

  const enriched = {
    ...relation,
    candidates,
    explicit_reference: {
      referenced_report_text: reference.referenced_report_text,
      referenced_receipt_date: reference.referenced_receipt_date,
      correction_reason_text: reference.correction_reason_text,
      reference_status: reference.reference_status,
      evidence: reference.evidence,
    },
    recommended_target_document_id: reference.recommended_target_document_id,
    recommendation_status: reference.reference_status === "MATCHED_IN_CORPUS"
      ? "EXPLICIT_REFERENCE_MATCH_REVIEW"
      : reference.reference_status === "TARGET_NOT_IN_CORPUS"
        ? "TARGET_OUTSIDE_CORPUS_REVIEW"
        : "EXPLICIT_REFERENCE_AMBIGUOUS",
    review_status: "PENDING",
    note: reference.reference_status === "MATCHED_IN_CORPUS"
      ? "Explicit referenced filing date matched one in-corpus document. Human review required before ACCEPTED."
      : reference.reference_status === "TARGET_NOT_IN_CORPUS"
        ? "Explicit referenced filing date has no in-corpus document. Human review required before TARGET_OUTSIDE_CORPUS."
        : "Explicit filing date maps to multiple in-corpus documents; use report family and field delta for disambiguation.",
  };
  output.write(`${JSON.stringify(enriched)}\n`);
}
await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify({ status: "PASS", output: outputPath, ...counts }, null, 2)}\n`);
