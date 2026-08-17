#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(process.cwd());
const candidatesPath = join(root, "work/domain-seed/seed-gold-candidates.v0.3.jsonl");
const outputDir = join(root, "work/handoff/seed-gold-v0.3-review-bundle");
const documentIrSources = [
  join(root, "work/a-document-ir/source/exchange.jsonl"),
  join(root, "work/a-document-ir/source/holding.jsonl"),
  join(root, "work/a-document-ir/source/major.jsonl"),
  join(root, "work/a-document-ir/source/periodic-001.jsonl"),
];

async function readJsonl(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function writeJsonl(path, rows) {
  const output = createWriteStream(path, { encoding: "utf8" });
  for (const row of rows) output.write(`${JSON.stringify(row)}\n`);
  await new Promise((resolveEnd, reject) => {
    output.on("error", reject);
    output.end(resolveEnd);
  });
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const candidates = await readJsonl(candidatesPath);
const anchorIds = new Set(candidates.flatMap((row) => row.anchor_document_ids));
await mkdir(outputDir, { recursive: true });

const directFiles = [
  "work/domain-seed/seed-gold-candidates.v0.3.review.md",
  "work/domain-seed/seed-gold-candidates.v0.3.jsonl",
  "work/domain-seed/seed-gold-candidates.v0.3.summary.json",
  "work/domain-seed/exchange-correction-references.jsonl",
  "work/domain-seed/termination-review-packets.jsonl",
  "work/domain-seed/relation-review-queue.jsonl",
];
for (const relativePath of directFiles) {
  await copyFile(join(root, relativePath), join(outputDir, basename(relativePath)));
}

const documentIrOutput = join(outputDir, "anchor-document-ir.v0.3.jsonl");
const documentIrWriter = createWriteStream(documentIrOutput, { encoding: "utf8" });
const foundDocumentIds = new Set();
for (const sourcePath of documentIrSources) {
  const lines = createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!anchorIds.has(row.doc_id)) continue;
    documentIrWriter.write(`${JSON.stringify(row)}\n`);
    foundDocumentIds.add(row.doc_id);
  }
}
await new Promise((resolveEnd, reject) => {
  documentIrWriter.on("error", reject);
  documentIrWriter.end(resolveEnd);
});

const parseAudits = await readJsonl(join(root, "work/a-document-ir/parse-audit.full.jsonl"));
const selectedAudits = parseAudits.filter((row) => anchorIds.has(row.document_id));
await writeJsonl(join(outputDir, "anchor-parse-audit.v0.3.jsonl"), selectedAudits);

const missingDocumentIds = [...anchorIds].filter((documentId) => !foundDocumentIds.has(documentId)).sort();
if (missingDocumentIds.length > 0) {
  throw new Error(`Missing Anchor DocumentIR: ${missingDocumentIds.join(", ")}`);
}

const readme = [
  "# Seed Gold v0.3 독립 검수 번들",
  "",
  "- 대상: Seed 후보 25건",
  `- 직접 Anchor DocumentIR: ${foundDocumentIds.size}건`,
  "- 상태: 후보이며 Gold/VERIFIED가 아님",
  "- A와 C는 상대방 결과를 보기 전에 각각 독립 검수",
  "- 원본 후보 JSONL은 수정하지 않고 별도 review JSONL 작성",
  "",
  "## 판정값",
  "",
  "`ACCEPT`, `ACCEPT_WITH_REVISION`, `REJECT`, `BLOCKED_RELATION`, `BLOCKED_PARSE`",
  "",
  "## 필수 검수",
  "",
  "1. 기업·기간·Anchor 문서 일치",
  "2. 질문의 원문 답변 가능성 및 Answerability",
  "3. LOW/MEDIUM/HARD와 L1~H3 난이도 타당성",
  "4. Evidence Slot의 source locator·인용문 해소 가능성",
  "5. 정정·해지 Chain과 latest-effective 선택",
  "6. 단위·기간·scope·통화 비교 가능성",
  "7. 계산 요구와 정보한계 처리",
  "8. H3의 다중 문서·Chain·정규화·계산·정보한계 결합 여부",
  "",
  "## 결과 필드",
  "",
  "`assignment_id`, `reviewer_id`, `review_status`, `question_valid`, `difficulty_valid`, `answerability_valid`, `anchor_valid`, `evidence_locator_valid`, `relation_chain_valid`, `calculation_valid`, `issues`, `recommended_revision`",
  "",
].join("\n");
await writeFile(join(outputDir, "README.md"), readme, "utf8");

const bundleFiles = [
  ...directFiles.map((path) => basename(path)),
  "anchor-document-ir.v0.3.jsonl",
  "anchor-parse-audit.v0.3.jsonl",
  "README.md",
];
const manifestFiles = [];
for (const file of bundleFiles) {
  const path = join(outputDir, file);
  const bytes = (await readFile(path)).byteLength;
  manifestFiles.push({ file, bytes, sha256: await sha256(path) });
}
const manifest = {
  schema_version: "0.1.0",
  bundle_name: "seed-gold-v0.3-review-bundle",
  candidate_count: candidates.length,
  anchor_document_count: foundDocumentIds.size,
  anchor_document_ids: [...foundDocumentIds].sort(),
  files: manifestFiles,
};
await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output_dir: outputDir, candidate_count: candidates.length, anchor_document_count: foundDocumentIds.size }, null, 2)}\n`);
