#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { DOCUMENT_GROUPS, validateManifestRecord } from "../domain/contracts.mjs";

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
if (!corpusRoot || !existsSync(corpusRoot)) {
  console.error("Usage: node scripts/audit-domain-data.mjs <corpus-root>");
  process.exit(2);
}

const manifestPath = resolve(corpusRoot, "manifest.jsonl");
const universePath = resolve(corpusRoot, "universe.csv");
if (!existsSync(manifestPath) || !existsSync(universePath)) {
  console.error("corpus-root must contain manifest.jsonl and universe.csv");
  process.exit(2);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

const universeLines = readFileSync(universePath, "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter(Boolean);
const headers = parseCsvLine(universeLines[0]);
const corpCodeIndex = headers.indexOf("corp_code");
const stockCodeIndex = headers.indexOf("stock_code");
const companyCodes = new Set();
const universeErrors = [];

for (const [offset, line] of universeLines.slice(1).entries()) {
  const row = parseCsvLine(line);
  const lineNumber = offset + 2;
  const corpCode = row[corpCodeIndex];
  const stockCode = row[stockCodeIndex];
  if (!/^\d{8}$/.test(corpCode ?? "")) universeErrors.push(`universe:${lineNumber} invalid corp_code`);
  if (!/^\d{6}$/.test(stockCode ?? "")) universeErrors.push(`universe:${lineNumber} invalid stock_code`);
  if (companyCodes.has(corpCode)) universeErrors.push(`universe:${lineNumber} duplicate corp_code ${corpCode}`);
  companyCodes.add(corpCode);
}

const counts = Object.fromEntries(DOCUMENT_GROUPS.map((group) => [group, 0]));
const corrections = Object.fromEntries(DOCUMENT_GROUPS.map((group) => [group, 0]));
const docIds = new Set();
const receiptNumbers = new Set();
const manifestErrors = [];
let documentCount = 0;
let existingPathCount = 0;
let declaredFiles = 0;

const input = createInterface({ input: createReadStream(manifestPath, "utf8"), crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  documentCount += 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    manifestErrors.push(`manifest:${documentCount} invalid JSON: ${error.message}`);
    continue;
  }
  for (const error of validateManifestRecord(record)) {
    manifestErrors.push(`manifest:${documentCount} ${record.doc_id ?? "<unknown>"}: ${error}`);
  }
  if (!companyCodes.has(record.corp_code)) manifestErrors.push(`${record.doc_id}: unknown corp_code ${record.corp_code}`);
  if (docIds.has(record.doc_id)) manifestErrors.push(`${record.doc_id}: duplicate doc_id`);
  if (receiptNumbers.has(record.rcept_no)) manifestErrors.push(`${record.doc_id}: duplicate rcept_no`);
  docIds.add(record.doc_id);
  receiptNumbers.add(record.rcept_no);
  if (record.doc_group in counts) counts[record.doc_group] += 1;
  if (record.is_correction && record.doc_group in corrections) corrections[record.doc_group] += 1;
  declaredFiles += Number(record.n_files ?? 0);
  const absolutePath = resolve(corpusRoot, record.file_path ?? "");
  if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    existingPathCount += 1;
  } else {
    manifestErrors.push(`${record.doc_id}: missing file_path ${record.file_path}`);
  }
}

const errors = [...universeErrors, ...manifestErrors];
const report = {
  status: errors.length === 0 ? "PASS" : "FAIL",
  corpus_root: corpusRoot,
  corpus_snapshot: {
    id: `corpus_${sha256File(manifestPath).slice(0, 16)}`,
    manifest_sha256: sha256File(manifestPath),
    universe_sha256: sha256File(universePath),
  },
  companies: companyCodes.size,
  documents: documentCount,
  document_groups: counts,
  corrections,
  declared_files: declaredFiles,
  existing_document_paths: existingPathCount,
  error_count: errors.length,
  errors: errors.slice(0, 100),
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
