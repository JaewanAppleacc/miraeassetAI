import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export const REVIEW_ITEM_TYPES = Object.freeze([
  "COVERAGE_SLOT_NOT_APPLICABLE",
  "NARRATIVE_FACT_CLASSIFICATION_REVIEW",
  "ISSUER_STATED_CLAIM_ATTRIBUTION_REVIEW",
  "EVENT_CHAIN_ALIGNMENT_REVIEW",
  "SCOPE_CAVEAT_REVIEW",
  "GLOBAL_PROMOTION_GATE",
]);

const DEFAULT_PATHS = Object.freeze({
  facts: "work/domain-seed/seed-fact-candidates.v0.1.jsonl",
  events: "work/domain-seed/seed-event-candidates.v0.1.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-candidates.v0.1.json",
  queue: "work/domain-seed/seed-structured-artifact-review-queue.v0.1.jsonl",
  outputCoverage: "work/domain-seed/seed-fact-coverage-candidates.v0.2.json",
  outputSummary: "work/domain-seed/seed-structured-review-preparation.v0.1.summary.json",
  outputOwnerChecklist: "work/domain-seed/seed-structured-owner-review-checklist.v0.1.md",
  outputOwnerDecisions: "work/domain-seed/seed-structured-owner-review-decisions.v0.1.jsonl",
  outputClaudePrompt: "work/domain-seed/seed-structured-claude-review-prompt.v0.1.md",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonLines(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1} invalid JSON: ${error.message}`);
    }
  });
}

function countBy(records, key) {
  const result = {};
  for (const record of records) {
    const value = String(record[key]);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function reviewItemId(item, index) {
  return `structured_review_${sha256(JSON.stringify([index, item])).slice(0, 24)}`;
}

function assertCandidateRecords(records, label) {
  for (const record of records) {
    if (record.verification_status !== "CANDIDATE") {
      throw new Error(`${label} ${record.fact_id ?? record.event_id ?? "(unknown)"} is not CANDIDATE`);
    }
  }
}

function assertExcludedQuestionsAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const questionId of ["question_seed_v07_03", "question_seed_v07_22"]) {
    if (serialized.includes(questionId)) throw new Error(`${questionId} must remain excluded from structured candidates`);
  }
}

function ownerChecklist(summary) {
  return `# Seed Structured Artifact — Owner 최종 확인 체크리스트 v0.1

> 목적: 기계 검증으로 대신할 수 없는 의미 판단만 사람이 확인한다. Fact ${summary.fact_count}건·Event ${summary.event_count}건을 처음부터 다시 읽는 검수가 아니다. 아래 판정 전에는 어떤 Candidate도 VERIFIED로 승격하지 않는다.

## 승인 방법

각 항목을 원문과 대조한 뒤 별도 결정 파일에 \`APPROVE | FIX_REQUIRED | REJECT\` 중 하나를 기록한다. 이 체크리스트와 Candidate 원본은 수정하지 않는다.

## 1. Q14 NOT_APPLICABLE — 2건

- [ ] 2023년 신한지주 재무제표에 매출액 line item이 실제로 없는가
- [ ] 2025년 신한지주 재무제표에도 같은 이유로 매출액이 적용되지 않는가
- [ ] 검색 실패나 파싱 실패가 아니라 금융지주 표시 구조상의 NOT_APPLICABLE인가
- [ ] 영업이익은 별도 값으로 공시됐다는 사실과 혼동하지 않았는가

## 2. Q23 회사 주장 귀속 — 1건

- [ ] “재무적 손실 없음”이 객관적 사실이 아니라 회사의 공시상 판단으로 표현됐는가
- [ ] 해지 공시 \`exchange_20250407800036\`이 출처로 특정됐는가
- [ ] 중단 비용 보상과 기존 전망 미반영도 회사 진술 범위로 유지됐는가

## 3. Q7 범위 — 1건

- [ ] 유럽 30개국 허가 범위와 앱토즈마 단독 제품 범위를 혼동하지 않았는가
- [ ] 허가일과 사실확인일을 서로 다른 날짜 의미로 유지했는가

## 4. Narrative Fact — ${summary.review_item_types.NARRATIVE_FACT_CLASSIFICATION_REVIEW ?? 0}건

- [ ] 계획·결정·완료·정정·해지·유보 상태를 원문 의미대로 분류했는가
- [ ] 회사 주장, 정보한계, 확정 사실을 구분했는가
- [ ] period·scope·unit이 질문이 요구한 차원과 맞는가

## 5. Event–Chain — ${summary.review_item_types.EVENT_CHAIN_ALIGNMENT_REVIEW ?? 0}건

- [ ] event_type과 event_date가 원문에 맞는가
- [ ] source_document_id와 evidence_ids가 해당 사건을 직접 증명하는가
- [ ] 같은 기업·보고서 유형이라는 이유만으로 다른 사건을 합치지 않았는가
- [ ] Relation 방향과 Chain의 원공시→정정→해지 순서가 맞는가

## 6. 제외 문항

- [ ] Q3는 Evidence identity 미해결로 모든 Candidate에서 제외돼 있는가
- [ ] Q22는 Canonical DocumentIR 2건 미편입으로 제외돼 있는가

## 7. 최종 승격 Gate

- [ ] Fact ${summary.fact_count}건이 모두 아직 CANDIDATE인가
- [ ] Event ${summary.event_count}건이 모두 아직 CANDIDATE인가
- [ ] Coverage ${summary.coverage_slot_count}개가 모두 PENDING_HUMAN_REVIEW인가
- [ ] 미판정·FIX_REQUIRED·REJECT 항목을 공식 Coverage에 포함하지 않을 것인가
- [ ] 승인 결과는 별도 decision artifact로 남기고, 원본 Candidate를 덮어쓰지 않을 것인가
`;
}

function claudePrompt(summary, paths) {
  return `# Claude Code 독립 검수 지시문 — Seed Structured Candidates v0.1

다음 Candidate를 구현자의 보고나 기존 승인 상태를 신뢰하지 않고 독립 검수해줘.

입력:
- ${paths.facts}
- ${paths.events}
- ${paths.outputCoverage}
- ${paths.queue}
- work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl
- work/domain-seed/seed-evidence-verified.v0.3.jsonl
- work/domain-seed/seed-relation-gold.v0.1.jsonl
- work/domain-seed/seed-chain-manifest.v0.1.jsonl
- Canonical DocumentIR v0.6 + v0.7 delta

검수 대상은 review queue ${summary.review_queue_count}건이다. 원본 Candidate는 수정하지 말고 별도 판정 파일만 생성해.

필수 검수:
1. Q14 NOT_APPLICABLE 2건을 실제 재무제표 line item 부재로 재확인한다.
2. Narrative Fact ${summary.review_item_types.NARRATIVE_FACT_CLASSIFICATION_REVIEW ?? 0}건의 metric/value/status/period/scope가 Evidence 의미와 맞는지 확인한다.
3. issuer-stated claim은 source document와 attribution 없이는 승인하지 않는다.
4. Event ${summary.event_count}건의 event_type/date/corp/source/evidence와 Relation·Chain 사건 동일성을 확인한다.
5. Q7의 유럽 30개국 허가와 앱토즈마 단독 범위를 분리한다.
6. queue 밖 숫자 Fact도 evidence quoted_text에서 값을 독립 재도출하고 unit·scope·period를 확인한다.
7. Q3/Q22가 Fact/Event/Coverage에 0건인지 확인한다.
8. 어떤 Candidate도 검수 전 VERIFIED로 취급하지 않는다.

판정 enum:
- APPROVE_RECOMMENDED
- FIX_REQUIRED
- REJECT_RECOMMENDED

산출물:
- seed-structured-artifact-rereview.v0.1.jsonl
- seed-structured-artifact-rereview.v0.1.summary.json
- seed-structured-artifact-rereview.v0.1.md

보고에는 Fact/Event/Coverage별 판정 분포, 불일치, 승격 가능 ID, 재검수 필요 ID를 포함해. Runtime/API/Harness/공식 Schema는 수정하지 말고 커밋·push하지 마. 마지막에 eval:validate, schema:validate, verify:contracts, build, git diff --check를 실행해.
`;
}

export async function prepareSeedStructuredReview({ root = repositoryRoot, paths = DEFAULT_PATHS, writeOutputs = true } = {}) {
  const absolute = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [factBytes, eventBytes, coverageBytes, queueBytes] = await Promise.all([
    readFile(absolute.facts), readFile(absolute.events), readFile(absolute.coverage), readFile(absolute.queue),
  ]);
  const facts = parseJsonLines(factBytes.toString("utf8"), paths.facts);
  const events = parseJsonLines(eventBytes.toString("utf8"), paths.events);
  const coverage = JSON.parse(coverageBytes.toString("utf8"));
  const queue = parseJsonLines(queueBytes.toString("utf8"), paths.queue);

  assertCandidateRecords(facts, "Fact");
  assertCandidateRecords(events, "Event");
  assertExcludedQuestionsAbsent({ facts, events, coverage });
  if (!Array.isArray(coverage.slots) || coverage.slots.length === 0) throw new Error("Candidate Coverage must contain slots");
  if (queue.length === 0) throw new Error("review queue must not be empty");
  for (const item of queue) {
    if (!REVIEW_ITEM_TYPES.includes(item.item_type)) throw new Error(`unknown review item_type: ${item.item_type}`);
  }

  const convertedSlots = coverage.slots.map((slot) => {
    if (slot.verification_status !== "PENDING_HUMAN_REVIEW") throw new Error(`${slot.slot_key} is not pending human review`);
    const candidateStatus = slot.candidate_status === "VERIFIED_FACT_AVAILABLE"
      ? "FACT_CANDIDATE_AVAILABLE"
      : slot.candidate_status;
    if (!["FACT_CANDIDATE_AVAILABLE", "EVIDENCE_ONLY", "NOT_APPLICABLE", "MISSING", "BLOCKED"].includes(candidateStatus)) {
      throw new Error(`${slot.slot_key} has unknown candidate_status ${slot.candidate_status}`);
    }
    return { ...slot, candidate_status: candidateStatus };
  });

  const outputCoverage = {
    ...coverage,
    candidate_schema_profile: "fact-coverage-snapshot.v0.1.json (CANDIDATE profile v0.2)",
    producer_version: "seed-structured-candidates-v0.2-review-safe-status",
    based_on_candidate_sha256: sha256(coverageBytes),
    deviation_note: "This is not an official FactCoverageSnapshot. FACT_CANDIDATE_AVAILABLE means an unapproved Fact candidate exists; only an Owner-approved promotion step may emit the official VERIFIED schema.",
    slots: convertedSlots,
  };
  if (JSON.stringify(outputCoverage).includes("VERIFIED_FACT_AVAILABLE")) throw new Error("ambiguous VERIFIED_FACT_AVAILABLE survived conversion");

  const summary = {
    schema_version: "0.1.0",
    status: "PENDING_OWNER_AND_INDEPENDENT_REVIEW",
    source_sha256: {
      facts: sha256(factBytes), events: sha256(eventBytes), coverage: sha256(coverageBytes), queue: sha256(queueBytes),
    },
    fact_count: facts.length,
    event_count: events.length,
    coverage_slot_count: convertedSlots.length,
    review_queue_count: queue.length,
    review_item_types: countBy(queue, "item_type"),
    review_priorities: countBy(queue, "priority"),
    coverage_candidate_statuses: countBy(convertedSlots, "candidate_status"),
    excluded_questions: ["question_seed_v07_03", "question_seed_v07_22"],
    promotion_allowed: false,
  };

  const ownerDecisionTemplate = queue.map((item, index) => ({
    review_item_id: reviewItemId(item, index),
    decision: "PENDING",
    reviewer: null,
    reviewed_at: null,
    notes: null,
    source_item: item,
  }));

  if (writeOutputs) {
    const outputs = [absolute.outputCoverage, absolute.outputSummary, absolute.outputOwnerChecklist, absolute.outputOwnerDecisions, absolute.outputClaudePrompt];
    await Promise.all(outputs.map((output) => mkdir(path.dirname(output), { recursive: true })));
    await Promise.all([
      writeFile(absolute.outputCoverage, `${JSON.stringify(outputCoverage, null, 2)}\n`),
      writeFile(absolute.outputSummary, `${JSON.stringify(summary, null, 2)}\n`),
      writeFile(absolute.outputOwnerChecklist, ownerChecklist(summary)),
      writeFile(absolute.outputOwnerDecisions, `${ownerDecisionTemplate.map((record) => JSON.stringify(record)).join("\n")}\n`),
      writeFile(absolute.outputClaudePrompt, claudePrompt(summary, paths)),
    ]);
  }
  return { facts, events, queue, coverage: outputCoverage, summary, ownerDecisionTemplate };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { summary } = await prepareSeedStructuredReview();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
