#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
  DOCUMENT_GROUPS,
  ids,
  normalizeAlias,
} from "../domain/contracts.mjs";

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
const outputRoot = resolve(process.argv[3] ?? "work/domain-seed");
if (!corpusRoot || !existsSync(resolve(corpusRoot, "manifest.jsonl"))) {
  console.error("Usage: node scripts/build-domain-seed.mjs <corpus-root> [output-dir]");
  process.exit(2);
}

mkdirSync(outputRoot, { recursive: true });
const manifestPath = resolve(corpusRoot, "manifest.jsonl");
const universePath = resolve(corpusRoot, "universe.csv");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift().map((header) => header.replace(/^\uFEFF/, ""));
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function writeJsonl(name, records) {
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(resolve(outputRoot, name), `${payload}${payload ? "\n" : ""}`, "utf8");
}

function isoReceiptDate(receiptDate) {
  return `${receiptDate.slice(0, 4)}-${receiptDate.slice(4, 6)}-${receiptDate.slice(6, 8)}`;
}

function normalizeReportName(reportName) {
  return String(reportName)
    .normalize("NFC")
    .replace(/^\s*\[기재정정\]\s*/, "")
    .replace(/\(\d{4}\.\d{2}\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const manifestSha = sha256File(manifestPath);
const universeSha = sha256File(universePath);
const corpusSnapshotId = `corpus_${manifestSha.slice(0, 16)}`;
const manifest = readFileSync(manifestPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const universe = parseCsv(readFileSync(universePath, "utf8"));

const companies = universe.map((row) => ({
  corp_code: row.corp_code,
  stock_code: row.stock_code,
  corp_name: row.corp_name.normalize("NFC"),
  listed_name: row.listed_name.normalize("NFC"),
  corp_eng_name: row.corp_eng_name || null,
  market: row.market,
  industry: row.industry,
  sector_no: row.sector_no ? Number(row.sector_no) : null,
  sector: row.sector,
  listing_date: row.listing_date || null,
  fiscal_month: row.fiscal_month ? Number(row.fiscal_month.replace("월", "")) : null,
  universe_payload: row,
}));

const aliases = [];
for (const company of companies) {
  const candidates = [
    [company.corp_name, "DART_NAME", "universe.corp_name"],
    [company.listed_name, "LISTED_NAME", "universe.listed_name"],
    [company.stock_code, "STOCK_CODE", "universe.stock_code"],
    [company.corp_eng_name, "ENGLISH", "universe.corp_eng_name"],
  ];
  const seen = new Set();
  for (const [alias, aliasType, source] of candidates) {
    if (!alias) continue;
    const normalizedAlias = normalizeAlias(alias);
    const key = `${aliasType}\0${normalizedAlias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push({
      alias_id: ids.alias(company.corp_code, aliasType, normalizedAlias),
      corp_code: company.corp_code,
      alias,
      normalized_alias: normalizedAlias,
      alias_type: aliasType,
      valid_from: null,
      valid_to: null,
      source,
    });
  }
}

const documents = manifest.map((row) => ({
  document_id: row.doc_id,
  corpus_snapshot_id: corpusSnapshotId,
  corp_code: row.corp_code,
  doc_group: row.doc_group,
  doc_subtype: row.doc_subtype,
  report_name: row.report_nm.normalize("NFC"),
  receipt_number: row.rcept_no,
  receipt_date: isoReceiptDate(row.rcept_dt),
  filer_name: row.flr_nm.normalize("NFC"),
  is_correction: row.is_correction,
  base_year: row.base_year,
  base_month: row.base_month,
  file_path: row.file_path,
  file_format: row.file_format,
  declared_file_count: row.n_files,
  known_at: `${isoReceiptDate(row.rcept_dt)}T00:00:00+09:00`,
  manifest_payload: row,
}));

const manifestCounts = new Map();
for (const row of manifest) {
  manifestCounts.set(`${row.corp_code}\0${row.doc_group}`, (manifestCounts.get(`${row.corp_code}\0${row.doc_group}`) ?? 0) + 1);
}
const coverage = [];
for (const company of companies) {
  for (const docGroup of DOCUMENT_GROUPS) {
    const count = manifestCounts.get(`${company.corp_code}\0${docGroup}`) ?? 0;
    coverage.push({
      coverage_id: ids.coverage(corpusSnapshotId, company.corp_code, docGroup, "corpus-window"),
      corpus_snapshot_id: corpusSnapshotId,
      corp_code: company.corp_code,
      doc_group: docGroup,
      period_key: "corpus-window",
      document_id: null,
      state: count > 0 ? "PRESENT" : "ZERO_DOCUMENT",
      reason_code: count > 0 ? "MANIFEST_DOCUMENT_PRESENT" : "ZERO_DOCUMENT_IN_CORPUS",
      details: {
        coverage_layer: "MANIFEST",
        manifest_document_count: count,
        parse_status_not_assessed: true,
      },
    });
  }
}

const byCorpGroup = new Map();
for (const row of manifest) {
  const key = `${row.corp_code}\0${row.doc_group}`;
  const list = byCorpGroup.get(key) ?? [];
  list.push(row);
  byCorpGroup.set(key, list);
}
for (const list of byCorpGroup.values()) {
  list.sort((left, right) => left.rcept_no.localeCompare(right.rcept_no));
}

function relationScore(source, target) {
  let score = 0;
  const reasons = [];
  if (source.doc_subtype && source.doc_subtype === target.doc_subtype) {
    score += 0.25;
    reasons.push("same_doc_subtype");
  }
  if (normalizeReportName(source.report_nm) === normalizeReportName(target.report_nm)) {
    score += 0.25;
    reasons.push("same_normalized_report_name");
  }
  if (source.doc_group === "periodic" && source.base_year === target.base_year && source.base_month === target.base_month) {
    score += 0.45;
    reasons.push("same_periodic_base_period");
  }
  const days = Math.abs(Date.parse(isoReceiptDate(source.rcept_dt)) - Date.parse(isoReceiptDate(target.rcept_dt))) / 86_400_000;
  if (days <= 30) {
    score += 0.2;
    reasons.push("within_30_days");
  } else if (days <= 365) {
    score += 0.1;
    reasons.push("within_365_days");
  }
  return { score: Math.min(score, 1), reasons };
}

const relationReviewQueue = [];
for (const source of manifest.filter((row) => row.is_correction)) {
  const candidates = (byCorpGroup.get(`${source.corp_code}\0${source.doc_group}`) ?? [])
    .filter((target) => target.rcept_no < source.rcept_no)
    .map((target) => ({ target, ...relationScore(source, target) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.target.rcept_no.localeCompare(left.target.rcept_no))
    .slice(0, 5)
    .map(({ target, score, reasons }) => ({
      target_document_id: target.doc_id,
      score,
      reasons,
      target_report_name: target.report_nm,
      target_receipt_date: isoReceiptDate(target.rcept_dt),
    }));
  relationReviewQueue.push({
    relation_candidate_id: ids.relationCandidate(source.doc_id, "AMENDS"),
    source_document_id: source.doc_id,
    corp_code: source.corp_code,
    doc_group: source.doc_group,
    relation_type: "AMENDS",
    source_report_name: source.report_nm,
    source_receipt_date: isoReceiptDate(source.rcept_dt),
    candidates,
    review_status: "PENDING",
    note: "Manifest-only candidates. Confirm with explicit reference and field/event identity before promotion.",
  });
}

// Contract termination disclosures are few enough to review exhaustively. A
// manifest-only candidate list is intentionally broad: contract counterpart,
// amount, and period identity must be checked against parsed source fields
// before a TERMINATES relation can be promoted.
for (const source of manifest.filter(
  (row) => row.doc_group === "exchange" && row.doc_subtype === "단일판매공급계약해지",
)) {
  const candidates = (byCorpGroup.get(`${source.corp_code}\0exchange`) ?? [])
    .filter(
      (target) =>
        target.rcept_no < source.rcept_no &&
        target.doc_subtype === "단일판매공급계약체결",
    )
    .map((target) => ({
      target_document_id: target.doc_id,
      score: 0.25,
      reasons: ["same_contract_document_family"],
      target_report_name: target.report_nm,
      target_receipt_date: isoReceiptDate(target.rcept_dt),
    }))
    .sort((left, right) => right.target_receipt_date.localeCompare(left.target_receipt_date));

  relationReviewQueue.push({
    relation_candidate_id: ids.relationCandidate(source.doc_id, "TERMINATES"),
    source_document_id: source.doc_id,
    corp_code: source.corp_code,
    doc_group: source.doc_group,
    relation_type: "TERMINATES",
    source_report_name: source.report_nm,
    source_receipt_date: isoReceiptDate(source.rcept_dt),
    candidates,
    review_status: "PENDING",
    note: "Exhaustive termination review. Confirm counterpart, contract identity, amount, and period from source fields; an empty list may mean the original contract is outside the corpus.",
  });
}

const snapshot = {
  corpus_snapshot_id: corpusSnapshotId,
  manifest_sha256: manifestSha,
  universe_sha256: universeSha,
  document_count: manifest.length,
  generated_at: new Date().toISOString(),
  source_root_basename: basename(corpusRoot),
};

writeFileSync(resolve(outputRoot, "corpus-snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
writeJsonl("companies.jsonl", companies);
writeJsonl("company-aliases.jsonl", aliases);
writeJsonl("documents.jsonl", documents);
writeJsonl("coverage.jsonl", coverage);
writeJsonl("relation-review-queue.jsonl", relationReviewQueue);

console.log(JSON.stringify({
  status: "PASS",
  output_dir: outputRoot,
  corpus_snapshot_id: corpusSnapshotId,
  companies: companies.length,
  aliases: aliases.length,
  documents: documents.length,
  coverage_records: coverage.length,
  relation_review_items: relationReviewQueue.length,
}, null, 2));
