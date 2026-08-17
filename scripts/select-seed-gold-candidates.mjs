#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

const SELECTION = [
  ["author_9c6083819c0426fde3c10200", "SEARCH_EXTRACTION_CLOSED", "L1", "manifest existence lookup"],
  ["author_b976603c03443ddaa2a2db7d", "SEARCH_EXTRACTION_CLOSED", "L1", "manifest existence lookup"],
  ["author_bd3505a7bc99c64855ab8129", "SEARCH_EXTRACTION_CLOSED", "L1", "manifest existence lookup"],

  ["author_061bdb13583fbb06d34510a9", "SEARCH_EXTRACTION_CLOSED", "L3", "single-document multi-field contract extraction"],
  ["author_1fd3a9ff622b485619c0c510", "SEARCH_EXTRACTION_CLOSED", "L3", "single-document investment fields and certainty"],
  ["author_12e4a733f9b0f5affc939469", "MULTI_COMPARE_CALCULATE_CLOSED", "L3", "single-report before/after holding fields"],

  ["author_0221b9572d87d63d8da6ed6e", "SEARCH_EXTRACTION_OPEN", "M1", "section selection and major-disclosure narrative"],
  ["author_201d40063b73bb5ade27883c", "SEARCH_EXTRACTION_OPEN", "M1", "section selection and major-disclosure narrative"],
  ["author_ee640893fe4066385ea69586", "SEARCH_EXTRACTION_OPEN", "M1", "section selection and major-disclosure narrative"],

  ["author_2eb9d79b875e4a7b87eca7d6", "SEARCH_EXTRACTION_OPEN", "M2", "event narrative with information-limit judgment"],
  ["author_5ac509940b0168e9a81ed522", "SEARCH_EXTRACTION_OPEN", "M2", "event narrative with information-limit judgment"],
  ["author_4a8c719fb92c0aa97a0caafe", "SEARCH_EXTRACTION_OPEN", "M2", "major event fields and effective-state explanation"],

  ["author_047996ee31ce8223fea45201", "MULTI_COMPARE_CALCULATE_CLOSED", "M3", "two-period scope-aligned calculation"],
  ["author_0781884d48a123eabc7f909c", "MULTI_COMPARE_CALCULATE_CLOSED", "M3", "two-period scope-aligned calculation"],
  ["author_316ec15495063a1edb5beb99", "MULTI_COMPARE_CALCULATE_CLOSED", "M3", "two-period scope-aligned calculation"],
  ["author_a0fbc4ea03992478b50629bf", "MULTI_COMPARE_CALCULATE_CLOSED", "M3", "two-period scope-aligned calculation"],
  ["author_82f2d4def8834352771cb636", "MULTI_COMPARE_CALCULATE_OPEN", "M3", "cross-company scope-aligned comparison"],

  ["author_7409b8028e3cd57903ff228d", "COMPLEX_DOCUMENT_REASONING_CLOSED", "H1", "holding correction and before/after state"],

  ["author_050f83e72b46acb0b0efbb26", "COMPLEX_DOCUMENT_REASONING_OPEN", "H2", "termination-to-origin relation chain"],
  ["author_1a36ab524be491b7c60cf34c", "COMPLEX_DOCUMENT_REASONING_OPEN", "H2", "correction chain and latest-effective selection"],
  ["author_81c171debb1c90f831dff947", "COMPLEX_DOCUMENT_REASONING_OPEN", "H2", "major correction and latest-effective selection"],

  ["author_88a954719eed45aeb4e5f105", "COMPLEX_DOCUMENT_REASONING_OPEN", "H3", "withheld disclosure correction plus currency calculation"],
  ["author_93682178d73587acc9da0232", "COMPLEX_DOCUMENT_REASONING_OPEN", "H3", "multi-correction latest-effective state and change calculation"],
  ["author_494670a25010ca57340547af", "COMPLEX_DOCUMENT_REASONING_OPEN", "H3", "deep withheld-date correction chain and state classification"],
  ["author_758798bf6c0bc144e255ab54", "MULTI_COMPARE_CALCULATE_OPEN", "H3", "cross-company termination chains with dimension-aware calculation"],
];

const AUTHORED_H3 = [
  {
    assignment_id: "author_88a954719eed45aeb4e5f105",
    evaluation_group_id: "eval_group_31edf4ce7e62fbd78b1be11d",
    group_key: "exchange-h3:samsung-electronics-withheld-release",
    bucket: "exchange",
    planned_split: "DEV_TUNE",
    question_type: "EVENT_TRACE",
    difficulty: "HARD",
    answer_mode: "OPEN",
    question_draft: "삼성전자의 2025년 7월 28일 공급계약 공시와 7월 31일 정정공시를 연결해 공개 전후 계약상대방 변화와 그대로 유지된 계약금액·기간·매출액 대비 비율을 구분해줘. USD 16,544,160,000에 공시 환율 1,376원을 적용한 값이 공시된 원화 계약금액과 일치하는지도 계산하고, 이번 정정이 계약조건 변경인지 유보정보 공개인지 근거로 판단해줘.",
    anchor_document_ids: ["exchange_20250728800035", "exchange_20250731800028"],
    known_chain_ids: [],
    required_evidence_slot_drafts: ["원공시 계약조건", "정정공시 공개 전후 필드", "AMENDS 관계", "USD 금액과 적용 환율", "원화 계약금액 검산", "정정 성격 판정"],
    tags: ["correction_chain", "withheld", "currency_normalization", "calculation", "latest_effective", "h3"],
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR",
    gold_status: "NOT_STARTED",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    content_dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD"],
    split_dependencies: ["RELATION_CHAIN_CLOSURE"],
    dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD", "RELATION_CHAIN_CLOSURE"],
  },
  {
    assignment_id: "author_93682178d73587acc9da0232",
    evaluation_group_id: "eval_group_5e5b79ddfd243021a623dbef",
    group_key: "exchange-h3:rainbow-multi-correction",
    bucket: "exchange",
    planned_split: "DEV_TUNE",
    question_type: "EVENT_TRACE",
    difficulty: "HARD",
    answer_mode: "OPEN",
    question_draft: "레인보우로보틱스의 2024년 3월 15일 공시와 이를 정정한 2024년 11월 29일·12월 5일 공시를 하나의 Chain으로 재구성해 계약금액과 종료일이 각 단계에서 어떻게 바뀌었는지 설명해줘. 12월 5일 기준 최신 유효값을 선택하고 최초 공시 대비 계약금액 증감액·증감률과 계약기간 변화를 계산하되, 서로 기준이 다른 값은 직접 비교하지 말고 이유를 밝혀줘.",
    anchor_document_ids: ["exchange_20240315900173", "exchange_20241129900159", "exchange_20241205900548"],
    known_chain_ids: [],
    required_evidence_slot_drafts: ["최초 공시 계약금액·기간", "11월 29일 정정 필드", "12월 5일 정정 필드", "AMENDS 순서", "latest-effective 값", "증감액·증감률 계산", "차원 일치 검증"],
    tags: ["multi_correction_chain", "latest_effective", "calculation", "dimension_validation", "h3"],
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR",
    gold_status: "NOT_STARTED",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    content_dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD"],
    split_dependencies: ["RELATION_CHAIN_CLOSURE"],
    dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD", "RELATION_CHAIN_CLOSURE"],
  },
  {
    assignment_id: "author_494670a25010ca57340547af",
    evaluation_group_id: "eval_group_898e3ea9ae3ac7c649964168",
    group_key: "exchange-h3:samsung-biologics-withheld-chain",
    bucket: "exchange",
    planned_split: "DEV_TUNE",
    question_type: "EVENT_TRACE",
    difficulty: "HARD",
    answer_mode: "OPEN",
    question_draft: "삼성바이오로직스의 2023년 6월 5일 공시와 2023년 12월 19일, 2024년 3월 20일·5월 31일·6월 25일·7월 2일 정정공시를 시간순으로 연결해 유보기한과 공개 상태가 어떻게 변했는지 추적해줘. 각 정정이 단순 유보기한 연장인지 계약조건 변경인지 구분하고, 2024년 7월 2일 기준 공개 가능한 사실과 아직 확정할 수 없는 사실을 근거와 함께 나눠 설명해줘.",
    anchor_document_ids: ["exchange_20230605800001", "exchange_20231219800348", "exchange_20240320800925", "exchange_20240531801103", "exchange_20240625800283", "exchange_20240702800163"],
    known_chain_ids: [],
    required_evidence_slot_drafts: ["최초 공시 유보 상태", "정정별 유보기한", "정정 사유", "AMENDS 순서", "최종 공개 상태", "지원되는 사실", "지원되지 않는 결론"],
    tags: ["deep_correction_chain", "withheld", "answerability", "latest_effective", "information_limit", "h3"],
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR",
    gold_status: "NOT_STARTED",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    content_dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD"],
    split_dependencies: ["RELATION_CHAIN_CLOSURE"],
    dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD", "RELATION_CHAIN_CLOSURE"],
  },
  {
    assignment_id: "author_758798bf6c0bc144e255ab54",
    evaluation_group_id: "eval_group_0f17fabc780d4f3bc6e12947",
    group_key: "exchange-h3:samsung-heavy-hyosung-termination-compare",
    bucket: "cross-document",
    planned_split: "DEV_TUNE",
    question_type: "COMPARISON_CALC",
    difficulty: "HARD",
    answer_mode: "OPEN",
    question_draft: "삼성중공업의 2026년 3월 16일 계약 해지 공시와 효성중공업의 2025년 5월 8일 계약 해지 공시를 각각 원계약까지 추적해 최신 유효 계약금액과 해지금액의 일치 여부를 검증해줘. 두 해지금액의 차이와 배수를 계산하고 최근 매출액 대비 비율도 비교하되, 원계약의 정정 Chain이 닫히지 않았거나 기준 매출액·기간이 다르면 비교 가능한 결론과 보류해야 할 결론을 구분해줘.",
    anchor_document_ids: ["exchange_20260316801038", "exchange_20260203800709", "exchange_20250508800712", "exchange_20241104800041"],
    known_chain_ids: [],
    required_evidence_slot_drafts: ["삼성중공업 해지·원계약 identity", "효성중공업 해지·원계약 identity", "각 latest-effective 계약금액", "각 해지금액", "차이·배수 계산", "매출액 대비 비율 차원", "미확정 Chain 정보한계"],
    tags: ["termination", "cross_company", "multi_chain", "calculation", "dimension_validation", "information_limit", "h3"],
    authoring_status: "DRAFT_NEEDS_SOURCE_LOCATOR",
    gold_status: "NOT_STARTED",
    split_lock_status: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    content_dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD"],
    split_dependencies: ["RELATION_CHAIN_CLOSURE"],
    dependencies: ["DOCUMENT_IR", "HUMAN_REVIEW", "RELATION_GOLD", "RELATION_CHAIN_CLOSURE"],
  },
];

const DIFFICULTY_PROFILES = Object.freeze({
  L1: { retrieval_breadth: 1, reasoning_depth: 1, version_complexity: 0, calculation_complexity: 0, ambiguity: 0, language_complexity: 1 },
  L3: { retrieval_breadth: 1, reasoning_depth: 2, version_complexity: 0, calculation_complexity: 1, ambiguity: 1, language_complexity: 1 },
  M1: { retrieval_breadth: 2, reasoning_depth: 2, version_complexity: 1, calculation_complexity: 0, ambiguity: 1, language_complexity: 1 },
  M2: { retrieval_breadth: 2, reasoning_depth: 2, version_complexity: 2, calculation_complexity: 0, ambiguity: 2, language_complexity: 1 },
  M3: { retrieval_breadth: 3, reasoning_depth: 2, version_complexity: 1, calculation_complexity: 2, ambiguity: 1, language_complexity: 1 },
  H1: { retrieval_breadth: 2, reasoning_depth: 3, version_complexity: 2, calculation_complexity: 1, ambiguity: 2, language_complexity: 1 },
  H2: { retrieval_breadth: 3, reasoning_depth: 3, version_complexity: 3, calculation_complexity: 1, ambiguity: 2, language_complexity: 1 },
  H3: { retrieval_breadth: 4, reasoning_depth: 4, version_complexity: 4, calculation_complexity: 3, ambiguity: 3, language_complexity: 2 },
});

function officialDifficulty(level) {
  if (level.startsWith("L")) return "LOW";
  if (level.startsWith("M")) return "MEDIUM";
  return "HARD";
}

function parseArgs(argv) {
  const args = {
    queue: "work/domain-seed/evaluation-authoring-queue.jsonl",
    parseAudit: "work/a-document-ir/parse-audit.full.jsonl",
    output: "work/domain-seed/seed-gold-candidates.v0.3.jsonl",
    summary: "work/domain-seed/seed-gold-candidates.v0.3.summary.json",
    reviewSheet: "work/domain-seed/seed-gold-candidates.v0.3.review.md",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--queue") args.queue = argv[++index];
    else if (token === "--parse-audit") args.parseAudit = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--summary") args.summary = argv[++index];
    else if (token === "--review-sheet") args.reviewSheet = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function readJsonl(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const args = parseArgs(process.argv.slice(2));
const queue = await readJsonl(args.queue);
const sourcePoolCount = queue.length;
queue.push(...AUTHORED_H3);
const audits = await readJsonl(args.parseAudit);
const queueById = new Map(queue.map((row) => [row.assignment_id, row]));
const auditById = new Map(audits.map((row) => [row.document_id, row]));
const nonDevAnchors = new Map();
for (const row of queue.filter((item) => item.planned_split !== "DEV_TUNE")) {
  for (const documentId of row.anchor_document_ids) {
    const uses = nonDevAnchors.get(documentId) ?? [];
    uses.push({ assignment_id: row.assignment_id, split: row.planned_split });
    nonDevAnchors.set(documentId, uses);
  }
}

const selected = [];
const seenGroups = new Set();
const seenAnchors = new Set();
for (const [index, [assignmentId, taxonomyCell, difficultyLevel, selectionReason]] of SELECTION.entries()) {
  const source = queueById.get(assignmentId);
  if (!source) throw new Error(`Missing assignment: ${assignmentId}`);
  if (source.planned_split !== "DEV_TUNE") throw new Error(`${assignmentId} is not DEV_TUNE`);
  if (source.authoring_status === "PARSE_BLOCKED") throw new Error(`${assignmentId} is parse blocked`);
  if (seenGroups.has(source.evaluation_group_id)) throw new Error(`Duplicate evaluation group: ${source.evaluation_group_id}`);
  seenGroups.add(source.evaluation_group_id);
  for (const documentId of source.anchor_document_ids) {
    if (seenAnchors.has(documentId)) throw new Error(`Duplicate Seed anchor: ${documentId}`);
    if (nonDevAnchors.has(documentId)) {
      throw new Error(`Seed anchor leaks outside DEV_TUNE: ${documentId}`);
    }
    const audit = auditById.get(documentId);
    if (!audit) throw new Error(`Missing parse audit: ${documentId}`);
    if (audit.coverage_state === "PARSE_FAILED" || audit.source_parse_tier === "fallback") {
      throw new Error(`Seed anchor is not canonical-search-ready: ${documentId}`);
    }
    seenAnchors.add(documentId);
  }
  selected.push({
    seed_rank: index + 1,
    seed_status: "SEED_CANDIDATE_NEEDS_HUMAN_REVIEW",
    taxonomy_cell: taxonomyCell,
    source_difficulty: source.difficulty,
    difficulty: officialDifficulty(difficultyLevel),
    difficulty_level: difficultyLevel,
    difficulty_profile: DIFFICULTY_PROFILES[difficultyLevel],
    selection_reason: selectionReason,
    ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== "difficulty")),
  });
}

const outputPath = resolve(args.output);
await mkdir(dirname(outputPath), { recursive: true });
const output = createWriteStream(outputPath, { encoding: "utf8" });
for (const row of selected) output.write(`${JSON.stringify(row)}\n`);
await new Promise((resolveEnd) => output.end(resolveEnd));

const summary = {
  schema_version: "0.3.0",
  status: "SEED_CANDIDATE_ONLY_NOT_GOLD",
  selected_count: selected.length,
  source_pool_count: sourcePoolCount,
  newly_authored_h3_count: AUTHORED_H3.length,
  anchor_h3_target: { minimum: 15, preferred: 20 },
  h3_critical_slices: [
    "multi-document and multi-chain traversal",
    "correction followed by termination",
    "unit, period, scope, or currency normalization",
    "comparability and dimension validation",
    "withheld or insufficient-evidence handling",
    "deterministic calculation plus narrative explanation",
  ],
  source_split: "DEV_TUNE",
  unique_evaluation_groups: seenGroups.size,
  unique_anchor_documents: seenAnchors.size,
  taxonomy_cells: countBy(selected, "taxonomy_cell"),
  difficulties: countBy(selected, "difficulty"),
  difficulty_levels: countBy(selected, "difficulty_level"),
  answer_modes: countBy(selected, "answer_mode"),
  buckets: countBy(selected, "bucket"),
  question_types: countBy(selected, "question_type"),
  known_gaps: [
    "No current DEV_TUNE draft cleanly satisfies L2; simple single-value questions must be newly authored.",
    "Four H3 drafts were newly authored because the original 150-question pool did not contain suitable H3 cases.",
    "MULTI_COMPARE_CALCULATE_OPEN has only one non-parse-blocked DEV_TUNE candidate in the current pool.",
    "POLICY_SAFETY remains an automated Challenge/regression category, not a selected Seed Gold case.",
    "All relation-dependent records remain provisional until chain closure and human review.",
  ],
  promotion_requirements: [
    "independent human author and reviewer",
    "answer and answerability confirmed against source",
    "source locator and quoted span resolved",
    "period, scope, unit, and version checked",
    "relation-dependent cases promoted only after Relation Gold closure",
  ],
};
await writeFile(resolve(args.summary), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
const reviewRows = selected.map((row) => [
  row.seed_rank,
  row.taxonomy_cell,
  row.bucket,
  `${row.difficulty}/${row.difficulty_level}`,
  row.question_draft.replaceAll("|", "\\|"),
  row.anchor_document_ids.join(", ") || "manifest coverage",
  "PENDING",
]);
const reviewSheet = [
  `# Seed Gold 후보 ${selected.length}건 v0.3 - 9단계 난이도·H3 보강 사람 검수표`,
  "",
  "> 이 목록은 Gold가 아니다. 원문 검수와 독립 2차 검수를 통과하기 전에는 `VERIFIED`로 사용할 수 없다.",
  "",
  "| # | 공식 셀 | 문서군 | 난이도 | 질문 초안 | Anchor | 검수 |",
  "|---:|---|---|---|---|---|---|",
  ...reviewRows.map((row) => `| ${row.join(" | ")} |`),
  "",
  "## 현재 공백",
  "",
  "- 기존 DEV_TUNE 초안에는 L2에 정확히 맞는 단일값 조회 질문이 없어 신규 작성이 필요하다.",
  "- 기존 150개 초안에 적합한 H3가 없어 실제 문서·Chain에 고정한 H3 초안 4건을 새로 작성했다.",
  "- MULTI_COMPARE_CALCULATE_OPEN은 파싱 차단 없이 사용할 수 있는 DEV_TUNE 후보가 현재 1건뿐이다.",
  "- POLICY_SAFETY는 Seed Gold가 아니라 자동 Challenge·Regression 범주로 유지한다.",
  "- Relation 의존 후보는 Chain 확정과 사람 검수 전까지 provisional 상태다.",
  "",
  "## 승격 체크",
  "",
  ...summary.promotion_requirements.map((requirement) => `- [ ] ${requirement}`),
  "",
  "## Anchor 확장 목표",
  "",
  "- H3를 최소 15건, 권장 20건까지 확장한다.",
  "- 다중 문서·다중 Chain, 정정 후 해지, 단위·기간·scope·통화 정규화, 비교 가능성 판단, WITHHELD·근거 부족, 계산+서술 결합을 각각 포함한다.",
  "",
].join("\n");
await writeFile(resolve(args.reviewSheet), reviewSheet, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
