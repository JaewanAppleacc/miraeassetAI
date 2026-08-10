import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--document-ir") args.documentIr = argv[++index];
    else if (token === "--documents") args.documents = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["documentIr", "documents", "output"]) {
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

function normalizeDate(text) {
  const match = String(text).match(/(20\d{2})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function normalizeReportFamily(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/^\s*\[기재정정\]\s*/, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/체결$/u, "");
}

function findReference(record) {
  let reportText = null;
  let receiptDate = null;
  let reasonText = null;
  const evidence = [];
  for (const node of record.nodes ?? []) {
    if (node.kind !== "table") continue;
    for (const [rowIndex, row] of (node.normalized_rows ?? []).entries()) {
      const cells = row.map((cell) => String(cell ?? "").trim());
      const joined = cells.join(" | ");
      if (cells.some((cell) => /정정관련\s*공시서류제출일/.test(cell))) {
        receiptDate = cells.map(normalizeDate).find(Boolean) ?? receiptDate;
        evidence.push({
          kind: "REFERENCE_DATE",
          node_id: node.node_id,
          row_index: rowIndex,
          source_locator: `${record.doc_id}/${node.source.rel_path}#node=${node.source.order_index};row=${rowIndex}`,
          quoted_text: joined,
        });
      } else if (cells.some((cell) => /정정관련\s*공시서류$/.test(cell))) {
        reportText = cells.find((cell) => cell && !/정정관련\s*공시서류$/.test(cell)) ?? reportText;
        evidence.push({
          kind: "REFERENCE_REPORT",
          node_id: node.node_id,
          row_index: rowIndex,
          source_locator: `${record.doc_id}/${node.source.rel_path}#node=${node.source.order_index};row=${rowIndex}`,
          quoted_text: joined,
        });
      } else if (cells.some((cell) => /정정사유/.test(cell))) {
        reasonText = cells.find((cell) => cell && !/정정사유/.test(cell)) ?? reasonText;
      }
    }
  }
  return { reportText, receiptDate, reasonText, evidence };
}

const args = parseArgs(process.argv.slice(2));
const documents = await readJsonl(args.documents);
const documentsById = new Map(documents.map((document) => [document.document_id, document]));
const byCorpDate = new Map();
for (const document of documents) {
  const key = `${document.corp_code}\0${document.receipt_date}`;
  const values = byCorpDate.get(key) ?? [];
  values.push(document);
  byCorpDate.set(key, values);
}

const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
const lines = createInterface({ input: createReadStream(resolve(args.documentIr)), crlfDelay: Infinity });
const summary = {
  exchange_correction_documents: 0,
  matched_in_corpus: 0,
  target_not_in_corpus: 0,
  ambiguous: 0,
  reference_not_parsed: 0,
};

for await (const line of lines) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const source = documentsById.get(record.doc_id);
  if (!source?.is_correction || source.doc_group !== "exchange") continue;
  summary.exchange_correction_documents += 1;
  const reference = findReference(record);
  const sameDate = reference.receiptDate
    ? (byCorpDate.get(`${source.corp_code}\0${reference.receiptDate}`) ?? [])
        .filter((candidate) => candidate.document_id !== source.document_id)
    : [];
  const referenceFamily = normalizeReportFamily(reference.reportText);
  const familyMatches = sameDate.filter((candidate) =>
    !referenceFamily || normalizeReportFamily(candidate.report_name).includes(referenceFamily) ||
    referenceFamily.includes(normalizeReportFamily(candidate.report_name))
  );
  const candidates = familyMatches.length > 0 ? familyMatches : sameDate;
  let status;
  if (!reference.receiptDate) status = "REFERENCE_NOT_PARSED";
  else if (candidates.length === 0) status = "TARGET_NOT_IN_CORPUS";
  else if (candidates.length === 1) status = "MATCHED_IN_CORPUS";
  else status = "AMBIGUOUS";
  const key = status.toLowerCase();
  summary[key] += 1;
  const result = {
    schema_version: "0.1.0",
    corpus_snapshot_id: source.corpus_snapshot_id,
    source_document_id: source.document_id,
    corp_code: source.corp_code,
    source_receipt_date: source.receipt_date,
    referenced_report_text: reference.reportText,
    referenced_receipt_date: reference.receiptDate,
    correction_reason_text: reference.reasonText,
    reference_status: status,
    recommended_target_document_id: status === "MATCHED_IN_CORPUS" ? candidates[0].document_id : null,
    candidate_target_document_ids: candidates.map((candidate) => candidate.document_id),
    evidence: reference.evidence,
  };
  output.write(`${JSON.stringify(result)}\n`);
}
await new Promise((resolveEnd) => output.end(resolveEnd));
process.stdout.write(`${JSON.stringify({ status: "PASS", output: outputPath, ...summary }, null, 2)}\n`);
