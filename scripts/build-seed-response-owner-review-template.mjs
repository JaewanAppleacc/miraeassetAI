// Builds the Owner review packet for Harness v05's real REVIEW_REQUIRED
// items. This script makes NO judgment calls: every record it writes has
// owner_disposition:"PENDING", reviewer:null, reviewed_at:null, notes:null
// -- a human must fill these in later (see
// scripts/build-seed-metric-failure-owner-decision.mjs and its -v02
// successor for the pattern this repeats: authoring PENDING structure now,
// promotion/adjudication only via a later, separate, explicit Owner
// action).
//
// The review-item SET is computed mechanically from the real Harness
// result -- it walks every record's metric_results and collects every
// TOP-LEVEL metric whose own status is exactly "REVIEW_REQUIRED". The
// number 17 is never hardcoded anywhere in this script; it is only ever
// the LENGTH of whatever that walk actually finds. If the Harness were
// re-run and review_required changed, this script would track it.
//
// Reads only -- never writes to work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl,
// its wire response files, Gold v0.17, Evidence v0.9, Fact v0.7, Coverage
// v0.6, the v0.2 metric-failure decision, or the v0.19 release
// manifest/decision. Authors no new Fact, no Gold change, no Thin Flow
// template.
//
// Outputs (all new, v0.1):
//   work/domain-seed/seed-response-owner-review-template.v0.1.jsonl
//   work/domain-seed/seed-response-owner-review-template.v0.1.checklist.md
//   work/domain-seed/seed-response-owner-review-template.v0.1.manifest.json
//   work/domain-seed/seed-response-owner-review-pages.v0.1.md
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromAnswerWireResponseSafe } from "../domain/runtime/answer-wire-response.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_AT = new Date().toISOString();

const HARNESS_RESULT_PATH = "work/domain-seed/seed-thin-flow-harness-v05.v0.1.jsonl";
const GOLD_PATH = "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl";
const EVIDENCE_PATH = "work/domain-seed/seed-evidence-verified.v0.9.jsonl";
const FACT_PATH = "work/domain-seed/seed-facts-verified.v0.7.jsonl";
const COVERAGE_PATH = "work/domain-seed/seed-fact-coverage-verified.v0.6.json";
const METRIC_FAILURE_DECISION_V02_PATH = "work/domain-seed/seed-metric-failure-owner-decision.v0.2.jsonl";
const RELEASE_MANIFEST_PATH = "domain/releases/seed-release.v0.19.manifest.json";
const RELEASE_DECISION_PATH = "domain/releases/seed-release.v0.19.decision.json";
const WIRE_DIR = "work/domain-seed/seed-harness-v05-wire";

const DECISION_OUT = "work/domain-seed/seed-response-owner-review-template.v0.1.jsonl";
const CHECKLIST_OUT = "work/domain-seed/seed-response-owner-review-template.v0.1.checklist.md";
const MANIFEST_OUT = "work/domain-seed/seed-response-owner-review-template.v0.1.manifest.json";
const PAGES_OUT = "work/domain-seed/seed-response-owner-review-pages.v0.1.md";

const ALLOWED_DISPOSITIONS = Object.freeze(["APPROVE_RESPONSE", "FIX_REQUIRED", "REJECT_RESPONSE", "PENDING"]);

const CLAIM_COVERAGE_REVIEW_QUESTIONS = Object.freeze([
  "질문의 핵심 요구사항을 모두 답했는가",
  "원문에 없는 주장을 추가하지 않았는가",
  "정보 부재·코퍼스 한계를 표시했는가",
  "회사 주장과 객관적 사실을 구분했는가",
  "계산·비교 결론이 근거와 일치하는가",
  "근거 공시를 식별 가능하게 표시했는가",
]);

const EXPLICIT_FACT_VALUE_SLOTS_REVIEW_QUESTIONS = Object.freeze([
  "REVIEW_REQUIRED로 표시된 각 서술 필드가 원문 의미와 일치하는가",
  "판단·귀속·비교 caveat를 사실처럼 과장하지 않았는가",
  "값 누락 때문에 답변이 불완전한 것은 아닌가",
]);

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
async function readAbs(p) { return readFile(path.join(REPO, p)); }
async function sha256OfFile(p) { return sha256(await readAbs(p)); }
async function readJsonlAbs(p) { return (await readAbs(p)).toString("utf8").trim().split("\n").map(JSON.parse); }
function jsonl(records) { return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`; }

// Collects every TOP-LEVEL metric_results entry whose OWN status is
// exactly "REVIEW_REQUIRED" -- this IS the mechanical, non-hardcoded
// re-derivation of the review set (see header comment).
function findReviewRequiredItems(harnessRecords) {
  const items = [];
  for (const record of harnessRecords) {
    for (const [metricName, metric] of Object.entries(record.metric_results ?? {})) {
      if (metric && metric.status === "REVIEW_REQUIRED") {
        items.push({ question_id: record.question_id, metric_name: metricName, metric });
      }
    }
  }
  return items;
}

function fieldLevelReviewRequiredNames(metricDetail) {
  if (!metricDetail || typeof metricDetail !== "object" || Array.isArray(metricDetail)) return [];
  return Object.entries(metricDetail).filter(([, status]) => status === "REVIEW_REQUIRED").map(([field]) => field);
}

async function main() {
  const [harnessRecords, gold, metricFailureV02] = await Promise.all([
    readJsonlAbs(HARNESS_RESULT_PATH),
    readJsonlAbs(GOLD_PATH),
    readJsonlAbs(METRIC_FAILURE_DECISION_V02_PATH),
  ]);
  const goldById = new Map(gold.map((g) => [g.question_id, g]));
  const metricFailureByQuestionId = new Map();
  for (const d of metricFailureV02) {
    if (!metricFailureByQuestionId.has(d.question_id)) metricFailureByQuestionId.set(d.question_id, []);
    metricFailureByQuestionId.get(d.question_id).push(d.metric_name);
  }

  const reviewRequiredItems = findReviewRequiredItems(harnessRecords);
  if (reviewRequiredItems.length === 0) throw new Error("no REVIEW_REQUIRED items found in the Harness result -- refusing to author an empty review packet");

  const uniqueQuestionIds = [...new Set(reviewRequiredItems.map((i) => i.question_id))].sort();
  const wireBytesByQuestionId = new Map();
  for (const questionId of uniqueQuestionIds) {
    const wirePath = path.join(REPO, WIRE_DIR, `${questionId}.response.json`);
    wireBytesByQuestionId.set(questionId, await readFile(wirePath));
  }

  const records = [];
  for (const { question_id: questionId, metric_name: metricName, metric } of reviewRequiredItems) {
    const wireBytes = wireBytesByQuestionId.get(questionId);
    const wire = JSON.parse(wireBytes.toString("utf8"));
    const restored = fromAnswerWireResponseSafe(wire);
    if (!restored.ok) throw new Error(`wire response for ${questionId} does not restore: ${restored.error}`);
    const value = restored.value;
    const goldRecord = goldById.get(questionId);
    if (!goldRecord) throw new Error(`no Gold record for ${questionId}`);

    const relatedEvidence = (value.retrieved_context ?? []).map((item) => ({
      evidence_id: item.evidence_id, document_id: item.document_id, source_locator: item.source_locator, quoted_text: item.quoted_text,
    }));

    const isExplicitFactValueSlots = metricName === "explicit_fact_value_slots";
    const reviewRequiredFieldNames = isExplicitFactValueSlots ? fieldLevelReviewRequiredNames(metric.detail) : [];
    const fieldComparison = isExplicitFactValueSlots
      ? reviewRequiredFieldNames.map((field) => ({
        field,
        agent_value: value.think_trace?.calculation?.value?.[field] ?? null,
        gold_expected_value: goldRecord.expected_answer?.value?.[field] ?? null,
      }))
      : undefined;

    records.push({
      review_item_id: `response_review_${questionId}_${metricName}`,
      question_id: questionId,
      metric_name: metricName,
      question: goldRecord.question,
      agent_answer: value.answer,
      retrieved_context: value.retrieved_context,
      think_trace_calculation: value.think_trace?.calculation ?? null,
      think_trace_validation: value.think_trace?.validation ?? null,
      gold_expected_answer_value: goldRecord.expected_answer?.value ?? null,
      metric_detail: metric.detail,
      metric_detail_review_required_fields: isExplicitFactValueSlots ? reviewRequiredFieldNames : undefined,
      field_comparison: fieldComparison,
      related_evidence: relatedEvidence,
      related_metric_fail_adjudication_v02: metricFailureByQuestionId.get(questionId) ?? [],
      review_questions: isExplicitFactValueSlots ? EXPLICIT_FACT_VALUE_SLOTS_REVIEW_QUESTIONS : CLAIM_COVERAGE_REVIEW_QUESTIONS,
      allowed_dispositions: ALLOWED_DISPOSITIONS,
      owner_disposition: "PENDING",
      reviewer: null,
      reviewed_at: null,
      notes: null,
    });
  }

  // Validation: no duplicate review_item_id, set matches mechanically
  // re-derived REVIEW_REQUIRED items exactly (count, not just existence).
  const ids = records.map((r) => r.review_item_id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate review_item_id detected");
  if (records.length !== reviewRequiredItems.length) throw new Error("record count does not match the mechanically re-derived REVIEW_REQUIRED item count");
  if (records.some((r) => r.owner_disposition !== "PENDING" || r.reviewer !== null || r.reviewed_at !== null || r.notes !== null)) {
    throw new Error("a record was not left fully PENDING -- refusing to author a partially-adjudicated packet");
  }

  const decisionText = jsonl(records);
  await writeFile(path.join(REPO, DECISION_OUT), decisionText, "utf8");
  const decisionSha256 = sha256(Buffer.from(decisionText, "utf8"));

  const claimCoverageCount = records.filter((r) => r.metric_name === "claim_coverage").length;
  const explicitFactValueSlotsCount = records.filter((r) => r.metric_name === "explicit_fact_value_slots").length;

  // --- manifest: path/sha256 for every real input this packet was built
  // from, plus every output it produced. ---------------------------------
  const inputPins = {};
  for (const [key, relativePath] of Object.entries({
    harness_result: HARNESS_RESULT_PATH,
    gold: GOLD_PATH,
    evidence: EVIDENCE_PATH,
    fact: FACT_PATH,
    coverage: COVERAGE_PATH,
    metric_failure_owner_decision_v02: METRIC_FAILURE_DECISION_V02_PATH,
    release_manifest: RELEASE_MANIFEST_PATH,
    release_decision: RELEASE_DECISION_PATH,
  })) {
    const bytes = await readAbs(relativePath);
    inputPins[key] = { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
  }
  const wirePins = {};
  for (const questionId of uniqueQuestionIds) {
    const relativePath = `${WIRE_DIR}/${questionId}.response.json`;
    const bytes = wireBytesByQuestionId.get(questionId);
    wirePins[questionId] = { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
  }

  const manifestBase = {
    schema_version: "0.1.0",
    artifact_id: "seed-response-owner-review-template-v0.1",
    generated_at: GENERATED_AT,
    scope:
      "Harness v05 실행에서 실제로 REVIEW_REQUIRED로 기록된 항목 전체(claim_coverage + explicit_fact_value_slots)에 대한 "
      + "Owner 검수 PENDING 템플릿. 이 스크립트는 판정을 대신 내리지 않는다 -- 모든 레코드는 owner_disposition:PENDING, "
      + "reviewer:null, reviewed_at:null, notes:null이다. 대상 집합은 Harness 결과를 기계적으로 재계산해 도출했으며 "
      + "숫자를 하드코딩하지 않았다.",
    review_required_set: {
      total: reviewRequiredItems.length,
      claim_coverage_count: claimCoverageCount,
      explicit_fact_value_slots_count: explicitFactValueSlotsCount,
      question_ids: uniqueQuestionIds,
      items: reviewRequiredItems.map((i) => ({ question_id: i.question_id, metric_name: i.metric_name })),
    },
    allowed_dispositions: ALLOWED_DISPOSITIONS,
    inputs: { ...inputPins, wire_responses: wirePins },
  };

  const checklistMd = `# Seed Response Owner Review -- Checklist v0.1

**Generated at:** ${GENERATED_AT}
**Data freeze point:** v0.19 (Fact v0.7 / Evidence v0.9 / Coverage v0.6 / Gold v0.17 / Plan v0.6 -- unmodified)
**Review-required set:** ${reviewRequiredItems.length}건 (claim_coverage ${claimCoverageCount}건 + explicit_fact_value_slots ${explicitFactValueSlotsCount}건), Harness 결과에서 기계적으로 재계산됨.

이 문서는 사람이 한 번에 확인할 체크리스트다. 각 항목의 전체 컨텍스트(질문/답변/retrieved_context/
think_trace/Gold 기대값/근거 Evidence)는 \`${PAGES_OUT}\`에서 확인한다. 판정은
\`${DECISION_OUT}\`의 해당 review_item_id 레코드에 직접 기록한다 (owner_disposition을
PENDING에서 APPROVE_RESPONSE / FIX_REQUIRED / REJECT_RESPONSE 중 하나로 바꾸고, reviewer/reviewed_at/notes를 채운다).

## 판정 enum

- \`APPROVE_RESPONSE\` -- 현재 응답을 그대로 승인
- \`FIX_REQUIRED\` -- 응답 수정 필요 (수정 방향은 notes에 기록)
- \`REJECT_RESPONSE\` -- 현재 응답을 거부 (사유는 notes에 기록)
- \`PENDING\` -- 아직 판정하지 않음 (이 패킷 생성 시점의 기본값)

## claim_coverage 검수 질문 (13건 공통)

${CLAIM_COVERAGE_REVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## explicit_fact_value_slots 검수 질문 (4건 공통: Q09/Q15/Q17/Q23)

${EXPLICIT_FACT_VALUE_SLOTS_REVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## 항목 목록 (${reviewRequiredItems.length}건)

| # | review_item_id | question_id | metric_name |
|---|---|---|---|
${records.map((r, i) => `| ${i + 1} | ${r.review_item_id} | ${r.question_id} | ${r.metric_name} |`).join("\n")}

## 주의

- 이 패킷은 어떤 항목도 자동으로 APPROVE하지 않는다. 모든 항목이 PENDING이다.
- 원본 Harness/Gold/Evidence/Fact/Coverage/Runtime 파일은 이 패킷을 만드는 과정에서 전혀 수정되지 않았다.
- 신규 Fact, Gold 변경, Thin Flow 템플릿은 이 작업에서 추가되지 않았다.
`;

  function renderComparisonTable(fieldComparison) {
    if (!fieldComparison || fieldComparison.length === 0) return "";
    const rows = fieldComparison.map((c) => `| ${c.field} | ${JSON.stringify(c.agent_value)} | ${JSON.stringify(c.gold_expected_value)} |`).join("\n");
    return `\n**REVIEW_REQUIRED 필드 비교 (Agent 산출값 vs Gold 기대값)**\n\n| field | agent_value | gold_expected_value |\n|---|---|---|\n${rows}\n`;
  }

  function renderSection(questionId, itemsForQuestion) {
    const first = itemsForQuestion[0];
    const wire = JSON.parse(wireBytesByQuestionId.get(questionId).toString("utf8"));
    const restored = fromAnswerWireResponseSafe(wire).value;
    const evidenceRows = (restored.retrieved_context ?? [])
      .map((e) => `| ${e.evidence_id} | ${e.document_id} | ${e.source_locator} | ${e.quoted_text.replaceAll("\n", " ").slice(0, 200)} |`)
      .join("\n");
    return `## ${questionId}

**원 질문:** ${first.question}

**실제 Agent answer:**

\`\`\`
${first.agent_answer}
\`\`\`

**실제 think_trace.calculation:**

\`\`\`json
${JSON.stringify(first.think_trace_calculation, null, 2)}
\`\`\`

**실제 think_trace.validation:**

\`\`\`json
${JSON.stringify(first.think_trace_validation, null, 2)}
\`\`\`

**Gold expected_answer.value:**

\`\`\`json
${JSON.stringify(first.gold_expected_answer_value, null, 2)}
\`\`\`

**관련 Evidence (retrieved_context 전체):**

| evidence_id | document_id | source_locator | quoted_text |
|---|---|---|---|
${evidenceRows}

${itemsForQuestion.map((item) => `### ${item.metric_name} -- \`${item.review_item_id}\`

**metric_detail:** \`${JSON.stringify(item.metric_detail)}\`
${item.metric_detail_review_required_fields && item.metric_detail_review_required_fields.length ? `**REVIEW_REQUIRED 필드:** ${item.metric_detail_review_required_fields.join(", ")}` : ""}
${renderComparisonTable(item.field_comparison)}
**검수 질문:**

${item.review_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

**owner_disposition:** PENDING (판정 미기록)
`).join("\n")}
`;
  }

  const questionIdToItems = new Map();
  for (const record of records) {
    if (!questionIdToItems.has(record.question_id)) questionIdToItems.set(record.question_id, []);
    questionIdToItems.get(record.question_id).push(record);
  }
  const pagesMd = `# Seed Response Owner Review -- Pages v0.1

**Generated at:** ${GENERATED_AT}
**${uniqueQuestionIds.length}개 질문, ${reviewRequiredItems.length}개 review item (claim_coverage ${claimCoverageCount} + explicit_fact_value_slots ${explicitFactValueSlotsCount})**

${uniqueQuestionIds.map((questionId) => renderSection(questionId, questionIdToItems.get(questionId))).join("\n---\n\n")}
`;

  await writeFile(path.join(REPO, CHECKLIST_OUT), checklistMd, "utf8");
  await writeFile(path.join(REPO, PAGES_OUT), pagesMd, "utf8");

  const checklistSha256 = await sha256OfFile(CHECKLIST_OUT);
  const pagesSha256 = await sha256OfFile(PAGES_OUT);

  const manifest = {
    ...manifestBase,
    outputs: {
      decision: { path: DECISION_OUT, sha256: decisionSha256, record_count: records.length },
      checklist: { path: CHECKLIST_OUT, sha256: checklistSha256 },
      pages: { path: PAGES_OUT, sha256: pagesSha256 },
    },
  };
  await writeFile(path.join(REPO, MANIFEST_OUT), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    review_required_total: reviewRequiredItems.length,
    claim_coverage_count: claimCoverageCount,
    explicit_fact_value_slots_count: explicitFactValueSlotsCount,
    question_ids: uniqueQuestionIds,
    decision_path: DECISION_OUT, decision_sha256: decisionSha256,
    checklist_path: CHECKLIST_OUT, pages_path: PAGES_OUT, manifest_path: MANIFEST_OUT,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
