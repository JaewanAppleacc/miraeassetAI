import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    firstTermination: "work/ai-review/termination-review.v0.1.jsonl",
    firstFact: "work/ai-review/fact-sample-review.v0.1.jsonl",
    output: "work/ai-review/second-review.v0.1.jsonl",
    summary: "work/ai-review/second-review-summary.md",
    manifest: "work/ai-review/second-review-manifest.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--first-termination") args.firstTermination = argv[++index];
    else if (token === "--first-fact") args.firstFact = argv[++index];
    else if (token === "--output") args.output = argv[++index];
    else if (token === "--summary") args.summary = argv[++index];
    else if (token === "--manifest") args.manifest = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function readJsonl(path) {
  return readFile(resolve(path), "utf8").then((text) => text.split(/\r?\n/).filter(Boolean).map(JSON.parse));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk);
  return hash.digest("hex");
}

const relationDecisions = [
  {
    source_document_id: "exchange_20250618800387",
    target_document_id: "exchange_20240612800459",
    explicit_origin_receipt_date: "2021-10-18",
    explicit_origin_document_id: null,
    amends_resolution: "SECOND_REVIEW_CONFIRM_TARGET_OUTSIDE_CORPUS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_AMOUNT", "CONTRACT_START_DATE"],
    evidence_summary: "해지공시는 7척 계약 해지를 명시하고, 추천 target의 정정관련 공시서류제출일은 2021-10-18로 corpus 시작 전이다.",
    confidence: 0.99,
  },
  {
    source_document_id: "exchange_20250618800388",
    target_document_id: "exchange_20240612800468",
    explicit_origin_receipt_date: "2020-11-23",
    explicit_origin_document_id: null,
    amends_resolution: "SECOND_REVIEW_CONFIRM_TARGET_OUTSIDE_CORPUS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_AMOUNT", "CONTRACT_START_DATE"],
    evidence_summary: "해지공시는 쇄빙 LNG선 10척 계약 해지를 명시하고, 추천 target의 정정관련 공시서류제출일은 2020-11-23으로 corpus 시작 전이다.",
    confidence: 0.99,
  },
  {
    source_document_id: "exchange_20241128800504",
    target_document_id: "exchange_20240618800188",
    explicit_origin_receipt_date: "2020-02-27",
    explicit_origin_document_id: null,
    amends_resolution: "SECOND_REVIEW_CONFIRM_TARGET_OUTSIDE_CORPUS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_AMOUNT", "CONTRACT_START_DATE", "CONTRACT_END_DATE"],
    evidence_summary: "해지공시와 target이 Hassi Messaoud 프로젝트의 상대방·금액·기간까지 일치하며, 명시 원공시일 2020-02-27은 corpus 시작 전이다.",
    confidence: 0.99,
  },
  {
    source_document_id: "exchange_20240603800359",
    target_document_id: "exchange_20230331802739",
    explicit_origin_receipt_date: "2022-04-27",
    explicit_origin_document_id: null,
    amends_resolution: "SECOND_REVIEW_CONFIRM_TARGET_OUTSIDE_CORPUS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_AMOUNT", "CONTRACT_START_DATE"],
    evidence_summary: "해지공시가 2022-04-27 공시 계약임을 직접 명시하고 target의 계약 식별 필드가 일치한다. 원공시일은 corpus 시작 전이다.",
    confidence: 0.99,
  },
  {
    source_document_id: "exchange_20260316801038",
    target_document_id: "exchange_20260203800709",
    explicit_origin_receipt_date: "2023-06-02",
    explicit_origin_document_id: "exchange_20230602800079",
    amends_resolution: "SECOND_REVIEW_CONFIRM_INTERNAL_AMENDS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_AMOUNT", "CONTRACT_START_DATE"],
    evidence_summary: "정정공시가 2023-06-02 원유운반선 2척 공시를 명시 참조하고, 1척 해지 후 남은 1척에 대한 2026-03-16 해지 경과를 source가 직접 설명한다.",
    confidence: 1,
  },
  {
    source_document_id: "exchange_20250402800768",
    target_document_id: "exchange_20250123800469",
    explicit_origin_receipt_date: "2023-10-06",
    explicit_origin_document_id: "exchange_20231006800130",
    amends_resolution: "SECOND_REVIEW_CONFIRM_INTERNAL_AMENDS",
    matched_identity_fields: ["CONTRACT_NAME", "CONTRACT_COUNTERPARTY", "CONTRACT_START_DATE"],
    evidence_summary: "해지공시가 2023-10-06 최초공시를 직접 지목하고, target 정정공시의 명시 참조일 및 원공시 document가 일치한다.",
    confidence: 1,
  },
];

const factDecisions = [
  {
    fact_id: "fact_d7fcd1a27429a9f4ca901252",
    source_document_id: "exchange_20250728800035",
    metric_code: "CONTRACT_NAME",
    corrections: {
      raw_value_text: "반도체 위탁생산 공급계약",
      normalized_value: "반도체 위탁생산 공급계약",
      value_certainty: "PROVISIONAL",
      source_locator: "exchange_20250728800035/20250728800035.xml#node=0;row=1",
    },
    rationale: "원문 계약명 행은 반도체 위탁생산 공급계약이며 기존 Fact/Evidence는 9항 각주 행을 잘못 선택했다. 세부 계약명 공개 예정 문구 때문에 PROVISIONAL이 적합하다.",
    confidence: 0.99,
  },
  {
    fact_id: "fact_a7346cad20b54d1a2cf69c19",
    source_document_id: "exchange_20250728800035",
    metric_code: "CONTRACT_COUNTERPARTY",
    corrections: { value_certainty: "PROVISIONAL" },
    rationale: "글로벌 대형기업은 유보기한 후 공개 예정인 placeholder이며 3일 뒤 정정에서 Tesla로 공개됐다.",
    confidence: 0.98,
  },
  {
    fact_id: "fact_fe42ab1a264c62ddcfa81fa8",
    source_document_id: "exchange_20250731800028",
    metric_code: "CONTRACT_NAME",
    corrections: {
      raw_value_text: "반도체 위탁생산 공급계약",
      normalized_value: "반도체 위탁생산 공급계약",
      value_certainty: "PROVISIONAL",
      source_locator: "exchange_20250731800028/20250731800028.xml#node=3;row=5",
    },
    rationale: "정정 원문에도 계약명 행이 별도로 존재하며 기존 Evidence는 다시 9항 각주를 선택했다. 세부 계약명은 여전히 공개 예정이다.",
    confidence: 0.99,
  },
  {
    fact_id: "fact_3e49937185d7c53f68ca3427",
    source_document_id: "exchange_20250905800516",
    metric_code: "CONTRACT_END_DATE",
    corrections: {
      value_status: "MISSING",
      value_certainty: "PROVISIONAL",
      attributes: { missing_reason: "NOT_YET_DETERMINED" },
    },
    rationale: "원문은 계약기간이 각 IP 출시일부터 3년이며 종료일은 미확정이라고 직접 설명한다. 공시유보가 아니며, 현 enum에서는 MISSING+missing_reason이 가장 가까운 표현이다.",
    confidence: 0.95,
  },
  {
    fact_id: "fact_ac8d843df72e3c636ebcf708",
    source_document_id: "exchange_20251217800800",
    metric_code: "WITHHELD_REASON",
    corrections: { value_status: "NOT_APPLICABLE" },
    rationale: "공시유보사유가 '-'이고 다른 계약 필드는 공개돼 실제 유보가 없는 문서다.",
    confidence: 0.99,
  },
  {
    fact_id: "fact_df1b17fc3f451cb82fd92dd4",
    source_document_id: "exchange_20251217800800",
    metric_code: "WITHHELD_UNTIL",
    corrections: { value_status: "NOT_APPLICABLE" },
    rationale: "공시유보기한이 '-'이며 유보사유도 없어 적용 대상이 아니다.",
    confidence: 0.99,
  },
];

const args = parseArgs(process.argv.slice(2));
const [firstRelations, firstFacts] = await Promise.all([
  readJsonl(args.firstTermination),
  readJsonl(args.firstFact),
]);
const firstRelationBySource = new Map(firstRelations.map((record) => [record.source_document_id, record]));
const firstFactById = new Map(firstFacts.map((record) => [record.fact_id, record]));
const output = [];

for (const decision of relationDecisions) {
  const first = firstRelationBySource.get(decision.source_document_id);
  if (!first) throw new Error(`Missing first relation review: ${decision.source_document_id}`);
  output.push({
    review_version: "0.1.0",
    subject_type: "TERMINATES_RELATION",
    subject_id: `${decision.source_document_id}->${decision.target_document_id}`,
    first_review_status: first.ai_review_status,
    second_review_status: "SECOND_REVIEW_CONFIRM_ACCEPT_AFTER_AMENDS_RESOLUTION",
    ...decision,
    reviewer: { type: "AI_SECOND_PASS", tool: "Codex", external_data_used: false },
  });
}

for (const decision of factDecisions) {
  const first = firstFactById.get(decision.fact_id);
  if (!first) throw new Error(`Missing first fact review: ${decision.fact_id}`);
  output.push({
    review_version: "0.1.0",
    subject_type: "FACT",
    subject_id: decision.fact_id,
    first_review_status: first.ai_review_status,
    second_review_status: "SECOND_REVIEW_CONFIRM_CORRECTION",
    ...decision,
    reviewer: { type: "AI_SECOND_PASS", tool: "Codex", external_data_used: false },
  });
}

await mkdir(dirname(resolve(args.output)), { recursive: true });
await writeFile(resolve(args.output), `${output.map((record) => JSON.stringify(record)).join("\n")}\n`);
const summary = `# AI second review v0.1\n\n- TERMINATES: 6건 모두 동일 계약 관계 확인\n  - AMENDS 원공시 corpus 밖 확인: 4건\n  - AMENDS 원공시 corpus 내부 정확 일치: 2건\n- Fact: 6건 모두 수정 필요 확인\n  - 계약명 행 오선택: 2건\n  - placeholder certainty: 1건\n  - 미확정 종료일 상태: 1건\n  - 공시유보 비해당 상태: 2건\n\n이 결과는 독립 AI 2차 검수이며 사람의 최종 승인이나 DB 승격을 의미하지 않는다.\n`;
await writeFile(resolve(args.summary), summary);
const manifest = {
  review_version: "0.1.0",
  corpus_snapshot_id: "corpus_04750795e1a2d5c3",
  reviewer: { type: "AI_SECOND_PASS", tool: "Codex" },
  inputs: [
    { path: args.firstTermination, sha256: await sha256File(args.firstTermination), records: firstRelations.length },
    { path: args.firstFact, sha256: await sha256File(args.firstFact), records: firstFacts.length },
  ],
  outputs: [
    { path: args.output, sha256: await sha256File(args.output), records: output.length },
    { path: args.summary, sha256: await sha256File(args.summary) },
  ],
  counts: { relation_reviews: relationDecisions.length, fact_reviews: factDecisions.length },
  external_data_used: false,
  original_files_modified: false,
  final_human_approval_required: true,
};
await writeFile(resolve(args.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
