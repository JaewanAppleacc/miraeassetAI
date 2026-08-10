#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findEvaluationLeakage,
  validateEvaluationGoldV02,
} from "../domain/contracts.mjs";

const inputPath = resolve(process.argv[2] ?? "");
if (!inputPath || !existsSync(inputPath)) {
  console.error("Usage: node scripts/validate-evaluation.mjs <evaluation.jsonl>");
  process.exit(2);
}

const records = [];
const errors = [];
const raw = readFileSync(inputPath, "utf8").trim();
const serializedRecords = inputPath.endsWith(".json")
  ? (() => {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (error) {
        errors.push(`invalid JSON: ${error.message}`);
        return [];
      }
    })()
  : raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        errors.push(`line ${index + 1}: invalid JSON: ${error.message}`);
        return null;
      }
    }).filter(Boolean);

for (const [index, record] of serializedRecords.entries()) {
  records.push(record);
  for (const error of validateEvaluationGoldV02(record)) {
    errors.push(`record ${index + 1} (${record.question_id ?? "<unknown>"}): ${error}`);
  }
}

errors.push(...findEvaluationLeakage(records));

const bySplit = {};
const byGroup = {};
const byQuestionType = {};
for (const record of records) {
  bySplit[record.split] = (bySplit[record.split] ?? 0) + 1;
  for (const group of record.doc_groups ?? []) byGroup[group] = (byGroup[group] ?? 0) + 1;
  byQuestionType[record.question_type] = (byQuestionType[record.question_type] ?? 0) + 1;
}

console.log(JSON.stringify({
  status: errors.length === 0 ? "PASS" : "FAIL",
  file: inputPath,
  record_count: records.length,
  by_split: bySplit,
  by_doc_group: byGroup,
  by_question_type: byQuestionType,
  error_count: errors.length,
  errors: errors.slice(0, 100),
}, null, 2));

process.exitCode = errors.length === 0 ? 0 : 1;
