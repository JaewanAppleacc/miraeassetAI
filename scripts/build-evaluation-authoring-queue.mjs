#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const corpusRoot = resolve(process.argv[2] ?? process.env.DISCLOSURE_CORPUS_ROOT ?? "");
const outputPath = resolve(process.argv[3] ?? "work/domain-seed/evaluation-authoring-queue.jsonl");
const parseCoveragePath = process.argv[4] ? resolve(process.argv[4]) : null;
if (!corpusRoot || !existsSync(resolve(corpusRoot, "manifest.jsonl"))) {
  console.error("Usage: node scripts/build-evaluation-authoring-queue.mjs <corpus-root> [output-jsonl]");
  process.exit(2);
}

const manifest = readFileSync(resolve(corpusRoot, "manifest.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const parseFailedDocumentIds = parseCoveragePath
  ? new Set(readFileSync(parseCoveragePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.state === "PARSE_FAILED")
      .map((record) => record.document_id))
  : new Set();

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stableSort = (records, salt) => [...records].sort((a, b) =>
  digest(`${salt}\0${a.evaluation_group_id}`).localeCompare(digest(`${salt}\0${b.evaluation_group_id}`))
);
const latest = (records) => [...records].sort((a, b) => b.rcept_no.localeCompare(a.rcept_no))[0];
const labelPeriodic = (subtype) => ({ annual: "사업보고서", half: "반기보고서", quarter: "분기보고서" }[subtype] ?? subtype);

function assignment({ bucket, group, type, difficulty, mode, question, anchors, slots, tags, dependencies = [] }) {
  const evaluationGroupId = `eval_group_${digest(group).slice(0, 24)}`;
  const contentDependencies = [...new Set([
    ...(anchors.length > 0 ? ["DOCUMENT_IR"] : []),
    "HUMAN_REVIEW",
    ...dependencies,
  ])];
  const splitDependencies = anchors.length > 0 ? ["RELATION_CHAIN_CLOSURE"] : [];
  return {
    assignment_id: `author_${digest(`${type}\0${evaluationGroupId}\0${question}`).slice(0, 24)}`,
    evaluation_group_id: evaluationGroupId,
    group_key: group,
    bucket,
    planned_split: null,
    question_type: type,
    difficulty,
    answer_mode: mode,
    question_draft: question,
    anchor_document_ids: anchors,
    known_chain_ids: [],
    required_evidence_slot_drafts: slots,
    tags,
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR",
    gold_status: "NOT_STARTED",
    split_lock_status: anchors.length > 0
      ? "PROVISIONAL_UNTIL_CHAIN_CLOSURE"
      : "LOCKED_BY_COVERAGE",
    content_dependencies: contentDependencies,
    split_dependencies: splitDependencies,
    dependencies: [...new Set([...contentDependencies, ...splitDependencies])],
  };
}

const pools = { periodic: [], exchange: [], major: [], holding: [], "cross-document": [] };

const periodicGroups = new Map();
for (const row of manifest.filter((item) => item.doc_group === "periodic")) {
  const key = `${row.corp_code}\0${row.doc_subtype}\0${row.base_year}\0${row.base_month}`;
  const list = periodicGroups.get(key) ?? [];
  list.push(row);
  periodicGroups.set(key, list);
}
const periodicLatest = [...periodicGroups.values()].map(latest);
const byCompanyPeriodType = new Map();
for (const row of periodicLatest) {
  const key = `${row.corp_code}\0${row.doc_subtype}\0${row.base_month}`;
  const list = byCompanyPeriodType.get(key) ?? [];
  list.push(row);
  byCompanyPeriodType.set(key, list);
}
for (const records of byCompanyPeriodType.values()) {
  const oldDoc = latest(records.filter((row) => row.base_year === 2023));
  const newDoc = latest(records.filter((row) => row.base_year === 2025));
  if (!oldDoc || !newDoc) continue;
  pools.periodic.push(assignment({
    bucket: "periodic",
    group: `periodic-comparison:${oldDoc.corp_code}:${oldDoc.doc_subtype}:${oldDoc.base_month}`,
    type: "COMPARISON_CALC",
    difficulty: "HARD",
    mode: "CLOSED",
    question: `${oldDoc.listed_name}의 2023년과 2025년 ${labelPeriodic(oldDoc.doc_subtype)}에서 매출액과 영업이익을 같은 기준으로 비교하고 증감률을 계산해줘.`,
    anchors: [oldDoc.doc_id, newDoc.doc_id],
    slots: ["2023 매출액(scope·period·unit·version)", "2025 매출액(scope·period·unit·version)", "2023 영업이익(scope·period·unit·version)", "2025 영업이익(scope·period·unit·version)"],
    tags: ["same_company_different_period", "numeric", "scope", "period_type"],
  }));
}

const exchange = manifest.filter((row) => row.doc_group === "exchange");
for (const row of exchange.filter((item) => item.doc_subtype === "단일판매공급계약체결" && !item.is_correction)) {
  pools.exchange.push(assignment({
    bucket: "exchange",
    group: `exchange-contract:${row.doc_id}`,
    type: "NUMERIC_LOOKUP",
    difficulty: "MEDIUM",
    mode: "CLOSED",
    question: `${row.listed_name}의 ${row.rcept_dt} 공급계약 공시에서 계약상대방, 계약금액, 계약기간과 최근 매출액 대비 비율을 알려줘.`,
    anchors: [row.doc_id],
    slots: ["계약상대방", "계약금액(value_status·unit·certainty)", "계약 시작일", "계약 종료일", "매출액 대비 비율"],
    tags: ["contract", "numeric", "withheld_candidate"],
  }));
}
for (const row of exchange.filter((item) => item.is_correction)) {
  pools.exchange.push(assignment({
    bucket: "exchange",
    group: `exchange-correction:${row.doc_id}`,
    type: "EVENT_TRACE",
    difficulty: "HARD",
    mode: "OPEN",
    question: `${row.listed_name}의 ${row.report_nm}에서 정정된 항목과 정정 후 최신 유효 내용을 근거와 함께 설명해줘.`,
    anchors: [row.doc_id],
    slots: ["정정 대상 원문서", "정정 전 field", "정정 후 field", "latest-effective 상태"],
    tags: ["correction_chain", "wrong_version"],
    dependencies: ["RELATION_GOLD"],
  }));
}
for (const row of exchange.filter((item) => item.doc_subtype === "단일판매공급계약해지")) {
  pools.exchange.push(assignment({
    bucket: "exchange",
    group: `exchange-termination:${row.doc_id}`,
    type: "EVENT_TRACE",
    difficulty: "HARD",
    mode: "OPEN",
    question: `${row.listed_name}의 ${row.rcept_dt} 계약 해지 공시는 어떤 원계약을 종료했으며 해지 후 상태는 무엇인지 알려줘.`,
    anchors: [row.doc_id],
    slots: ["해지 공시", "원계약 identity", "TERMINATES 관계", "해지 후 event 상태"],
    tags: ["termination", "event_chain"],
    dependencies: ["RELATION_GOLD"],
  }));
}
for (const row of exchange.filter((item) => item.doc_subtype === "신규시설투자등" && !item.is_correction)) {
  pools.exchange.push(assignment({
    bucket: "exchange",
    group: `exchange-investment:${row.doc_id}`,
    type: "NUMERIC_LOOKUP",
    difficulty: "MEDIUM",
    mode: "CLOSED",
    question: `${row.listed_name}의 ${row.rcept_dt} 신규시설투자 공시에서 투자금액, 자기자본 대비 비율, 투자목적과 예정 여부를 알려줘.`,
    anchors: [row.doc_id],
    slots: ["투자금액(unit·certainty)", "자기자본 대비 비율", "투자목적", "planned/confirmed 상태"],
    tags: ["facility_investment", "planned_or_provisional"],
  }));
}
for (const row of exchange.filter((item) => item.doc_subtype === "투자판단관련주요경영사항" && !item.is_correction)) {
  pools.exchange.push(assignment({
    bucket: "exchange",
    group: `exchange-judgement:${row.doc_id}`,
    type: "NARRATIVE_MULTI_DOC",
    difficulty: "MEDIUM",
    mode: "OPEN",
    question: `${row.listed_name}의 ${row.rcept_dt} 투자판단 관련 주요경영사항에서 사건의 핵심 내용, 현재 상태와 정보 한계를 설명해줘.`,
    anchors: [row.doc_id],
    slots: ["사건 핵심내용", "발생·결정 기준일", "현재 상태", "유보·예정·미확정 여부"],
    tags: ["investment_judgement", "narrative", "answerability"],
  }));
}

for (const row of manifest.filter((item) => item.doc_group === "major")) {
  pools.major.push(assignment({
    bucket: "major",
    group: `major:${row.doc_id}`,
    type: row.is_correction ? "EVENT_TRACE" : "NARRATIVE_MULTI_DOC",
    difficulty: row.is_correction ? "HARD" : "MEDIUM",
    mode: "OPEN",
    question: `${row.listed_name}의 ${row.report_nm} 핵심 결정내용, 기준일과 현재 유효 상태를 공시 근거로 설명해줘.`,
    anchors: [row.doc_id],
    slots: row.is_correction ? ["사건 핵심내용", "정정 대상", "정정 전후", "latest-effective 상태"] : ["사건유형", "핵심 결정내용", "기준일", "근거"],
    tags: row.is_correction ? ["correction_chain", "major_event"] : ["major_event", "narrative"],
    dependencies: row.is_correction ? ["RELATION_GOLD", "MAJOR_EVENT_CLASSIFICATION"] : ["MAJOR_EVENT_CLASSIFICATION"],
  }));
}

for (const row of manifest.filter((item) => item.doc_group === "holding")) {
  pools.holding.push(assignment({
    bucket: "holding",
    group: `holding:${row.doc_id}`,
    type: row.is_correction ? "EVENT_TRACE" : "NUMERIC_LOOKUP",
    difficulty: row.is_correction ? "HARD" : "MEDIUM",
    mode: "CLOSED",
    question: `${row.listed_name}의 ${row.rcept_dt} 대량보유 공시에서 보고자, 보유주식 수·비율의 전후 변화와 보유목적을 알려줘.`,
    anchors: [row.doc_id],
    slots: ["보고자", "변동 전 보유주식수·비율", "변동 후 보유주식수·비율", "보유목적", "version"],
    tags: row.is_correction ? ["holding", "correction_chain"] : ["holding", "holding_within_report_change"],
    dependencies: row.is_correction ? ["RELATION_GOLD"] : [],
  }));
}

const manifestCounts = new Map();
for (const row of manifest) manifestCounts.set(`${row.corp_code}\0${row.doc_group}`, (manifestCounts.get(`${row.corp_code}\0${row.doc_group}`) ?? 0) + 1);
const companies = [...new Map(manifest.map((row) => [row.corp_code, row])).values()];
for (const company of companies) {
  for (const group of ["major", "exchange", "holding"]) {
    if ((manifestCounts.get(`${company.corp_code}\0${group}`) ?? 0) !== 0) continue;
    pools["cross-document"].push(assignment({
      bucket: "cross-document",
      group: `zero-document:${company.corp_code}:${group}`,
      type: "ANSWERABILITY",
      difficulty: "MEDIUM",
      mode: "CLOSED",
      question: `제공된 코퍼스 기간에 ${company.listed_name}의 ${group} 유형 공시가 존재하는지 확인해줘.`,
      anchors: [],
      slots: ["query-scoped manifest coverage"],
      tags: ["zero_document", "answerability"],
      dependencies: ["MANIFEST_COVERAGE"],
    }));
  }
}

const annual2025 = periodicLatest.filter((row) => row.doc_subtype === "annual" && row.base_year === 2025);
const bySector = new Map();
for (const row of annual2025) {
  const list = bySector.get(row.sector) ?? [];
  list.push(row);
  bySector.set(row.sector, list);
}
for (const [sector, rows] of bySector) {
  if (rows.length < 2) continue;
  const ordered = stableSort(rows.map((row) => ({ ...row, evaluation_group_id: row.doc_id })), sector);
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = ordered[leftIndex];
      const right = ordered[rightIndex];
      pools["cross-document"].push(assignment({
        bucket: "cross-document",
        group: `sector-comparison:${sector}:${left.doc_id}:${right.doc_id}`,
        type: "COMPARISON_CALC",
        difficulty: "HARD",
        mode: "OPEN",
        question: `${sector} 섹터의 ${left.listed_name}과 ${right.listed_name} 2025년 사업보고서에서 매출액과 영업이익을 같은 기준으로 비교해줘.`,
        anchors: [left.doc_id, right.doc_id],
        slots: [`${left.listed_name} 매출액·영업이익`, `${right.listed_name} 매출액·영업이익`, "scope·period·unit 일치 검사"],
        tags: ["cross_company", "numeric", "scope"],
      }));
    }
  }
}

function quotaSelect(records, specifications, salt, options = {}) {
  const selected = [];
  const seen = new Set();
  const usedAnchors = new Set(options.forbiddenAnchors ?? []);
  for (const [name, count, predicate] of specifications) {
    const candidates = stableSort(records.filter(predicate), `${salt}:${name}`);
    let added = 0;
    for (const item of candidates) {
      if (seen.has(item.evaluation_group_id)) continue;
      if (options.uniqueAnchors && item.anchor_document_ids.some((documentId) => usedAnchors.has(documentId))) continue;
      seen.add(item.evaluation_group_id);
      selected.push(item);
      if (options.uniqueAnchors) {
        for (const documentId of item.anchor_document_ids) usedAnchors.add(documentId);
      }
      added += 1;
      if (added === count) break;
    }
    if (added !== count) throw new Error(`${salt}/${name} has ${added} candidates; ${count} required`);
  }
  return selected;
}

const chosenPeriodic = quotaSelect(pools.periodic, [
  ["comparison", 45, () => true],
], "periodic");
const periodicAnchorIds = new Set(chosenPeriodic.flatMap((item) => item.anchor_document_ids));

const chosenByBucket = {
  periodic: chosenPeriodic,
  exchange: quotaSelect(pools.exchange, [
    ["termination", 20, (item) => item.tags.includes("termination")],
    ["facility", 5, (item) => item.tags.includes("facility_investment")],
    ["judgement", 5, (item) => item.tags.includes("investment_judgement")],
    ["correction", 10, (item) => item.tags.includes("correction_chain")],
    ["contract", 5, (item) => item.tags.includes("contract")],
  ], "exchange"),
  major: quotaSelect(pools.major, [
    ["correction", 8, (item) => item.tags.includes("correction_chain")],
    ["narrative", 16, (item) => item.tags.includes("narrative")],
  ], "major"),
  holding: quotaSelect(pools.holding, [
    ["correction", 8, (item) => item.tags.includes("correction_chain")],
    ["within-report-change", 16, (item) => item.tags.includes("holding_within_report_change")],
  ], "holding"),
  "cross-document": quotaSelect(pools["cross-document"], [
    ["zero-document", 6, (item) => item.tags.includes("zero_document")],
    ["cross-company", 6, (item) => item.tags.includes("cross_company")],
  ], "cross-document", { uniqueAnchors: true, forbiddenAnchors: periodicAnchorIds }),
};

const selected = [];
const splitMatrices = {
  periodic: [
    ["all", { DEV_TUNE: 22, DEV_CHECK: 9, HOLDOUT: 14 }, () => true],
  ],
  exchange: [
    ["termination", { DEV_TUNE: 10, DEV_CHECK: 4, HOLDOUT: 6 }, (item) => item.tags.includes("termination")],
    ["facility", { DEV_TUNE: 2, DEV_CHECK: 1, HOLDOUT: 2 }, (item) => item.tags.includes("facility_investment")],
    ["judgement", { DEV_TUNE: 2, DEV_CHECK: 1, HOLDOUT: 2 }, (item) => item.tags.includes("investment_judgement")],
    ["correction", { DEV_TUNE: 6, DEV_CHECK: 2, HOLDOUT: 2 }, (item) => item.tags.includes("correction_chain")],
    ["contract", { DEV_TUNE: 3, DEV_CHECK: 1, HOLDOUT: 1 }, (item) => item.tags.includes("contract")],
  ],
  major: [
    ["correction", { DEV_TUNE: 4, DEV_CHECK: 1, HOLDOUT: 3 }, (item) => item.tags.includes("correction_chain")],
    ["narrative", { DEV_TUNE: 8, DEV_CHECK: 4, HOLDOUT: 4 }, (item) => item.tags.includes("narrative")],
  ],
  holding: [
    ["correction", { DEV_TUNE: 4, DEV_CHECK: 1, HOLDOUT: 3 }, (item) => item.tags.includes("correction_chain")],
    ["within-report-change", { DEV_TUNE: 8, DEV_CHECK: 4, HOLDOUT: 4 }, (item) => item.tags.includes("holding_within_report_change")],
  ],
  "cross-document": [
    ["zero-document", { DEV_TUNE: 3, DEV_CHECK: 1, HOLDOUT: 2 }, (item) => item.tags.includes("zero_document")],
    ["cross-company", { DEV_TUNE: 3, DEV_CHECK: 1, HOLDOUT: 2 }, (item) => item.tags.includes("cross_company")],
  ],
};

for (const [bucket, categories] of Object.entries(splitMatrices)) {
  const assigned = new Set();
  for (const [category, targets, predicate] of categories) {
    const candidates = stableSort(
      chosenByBucket[bucket].filter((item) => predicate(item) && !assigned.has(item.assignment_id)),
      `split:${bucket}:${category}`,
    );
    let cursor = 0;
    for (const [split, count] of Object.entries(targets)) {
      const slice = candidates.slice(cursor, cursor + count);
      if (slice.length !== count) throw new Error(`${bucket}/${category}/${split} lacks candidates`);
      for (const item of slice) {
        assigned.add(item.assignment_id);
        selected.push({ ...item, planned_split: split });
      }
      cursor += count;
    }
  }
  if (assigned.size !== chosenByBucket[bucket].length) {
    throw new Error(`${bucket} assigned ${assigned.size}/${chosenByBucket[bucket].length}`);
  }
}

for (const item of selected) {
  const blocked = item.anchor_document_ids.filter((documentId) => parseFailedDocumentIds.has(documentId));
  if (blocked.length === 0) continue;
  item.authoring_status = "PARSE_BLOCKED";
  item.parse_blocked_document_ids = blocked;
  item.tags = [...new Set([...item.tags, "parse_blocked"])];
  item.content_dependencies = [...new Set([
    ...item.content_dependencies,
    "PDF_PARSER_OR_MANUAL_PDF_REVIEW",
  ])];
  item.dependencies = [...new Set([...item.content_dependencies, ...item.split_dependencies])];
}

selected.sort((a, b) => a.planned_split.localeCompare(b.planned_split) || a.bucket.localeCompare(b.bucket) || a.assignment_id.localeCompare(b.assignment_id));
mkdirSync(resolve(outputPath, ".."), { recursive: true });
writeFileSync(outputPath, `${selected.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

const counts = { total: selected.length, by_split: {}, by_bucket: {}, by_type: {} };
for (const item of selected) {
  counts.by_split[item.planned_split] = (counts.by_split[item.planned_split] ?? 0) + 1;
  counts.by_bucket[item.bucket] = (counts.by_bucket[item.bucket] ?? 0) + 1;
  counts.by_type[item.question_type] = (counts.by_type[item.question_type] ?? 0) + 1;
}
console.log(JSON.stringify({
  status: "PASS",
  output_path: outputPath,
  parse_coverage_path: parseCoveragePath,
  parse_blocked_assignments: selected.filter((item) => item.authoring_status === "PARSE_BLOCKED").length,
  ...counts,
}, null, 2));
