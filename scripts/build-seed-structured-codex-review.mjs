import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSeedStructuredReview } from "./prepare-seed-structured-review.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const PATHS = Object.freeze({
  facts: "work/domain-seed/seed-fact-candidates.v0.1.jsonl",
  events: "work/domain-seed/seed-event-candidates.v0.1.jsonl",
  evidence: "work/domain-seed/seed-evidence-verified.v0.3.jsonl",
  relations: "work/domain-seed/seed-relation-gold.v0.1.jsonl",
  chains: "work/domain-seed/seed-chain-manifest.v0.1.jsonl",
  coverage: "work/domain-seed/seed-fact-coverage-candidates.v0.2.json",
  gold: "work/domain-seed/seed-gold-promotion-candidates.v0.13.jsonl",
  queue: "work/domain-seed/seed-structured-artifact-review-queue.v0.1.jsonl",
  output: "work/domain-seed/seed-structured-codex-review.v0.1.jsonl",
  summary: "work/domain-seed/seed-structured-codex-review.v0.1.summary.json",
  report: "work/domain-seed/seed-structured-codex-review.v0.1.md",
  claudePrompt: "work/domain-seed/seed-structured-codex-review-claude-prompt.v0.1.md",
});

// These five Event candidates have at least one Evidence quote that states the
// action/status itself (completion, termination, or definitive agreement).
// The remaining Event candidates may have correct source documents and chain
// membership, but their Evidence quotes are only dates/numbers/names or empty.
const DIRECT_EVENT_EVIDENCE_IDS = new Set([
  "event_12ec40538defccc991674c4e",
  "event_490ad64796ec324a847f7bab",
  "event_394b6ef76fdaea18e23c8763",
  "event_a2bdc183d5dda2028a464d6c",
  "event_965767155aadd52bf3d2f1d0",
]);

const LOI_DATE_DEFECT_EVENT_ID = "event_cffef01467a71df30fdbb9c6";

function parseJsonLines(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${source}:${index + 1} invalid JSON: ${error.message}`); }
  });
}

function countBy(records, key) {
  return records.reduce((counts, record) => {
    counts[record[key]] = (counts[record[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function documentDate(documentId) {
  const match = /_(\d{8})/.exec(documentId ?? "");
  return match?.[1] ?? null;
}

function targetId(item) {
  return item.fact_id ?? item.event_id ?? item.slot_key ?? item.question_id ?? "GLOBAL_PROMOTION_GATE";
}

function reportMarkdown(summary, decisions) {
  const fixedEvents = decisions.filter((record) => record.item_type === "EVENT_CHAIN_ALIGNMENT_REVIEW" && record.decision === "FIX_REQUIRED");
  return `# Seed Structured Candidates — Codex 독립 검수 v0.1

> 이 파일은 Owner 승인 결과가 아니라 독립 검수 권고다. 기존 Candidate와 Owner decision template는 수정하지 않았다.

## 결과

- 전체 검수 항목: ${summary.review_count}
- APPROVE_RECOMMENDED: ${summary.decisions.APPROVE_RECOMMENDED ?? 0}
- FIX_REQUIRED: ${summary.decisions.FIX_REQUIRED ?? 0}
- REJECT_RECOMMENDED: ${summary.decisions.REJECT_RECOMMENDED ?? 0}
- 최종 승격 가능: 아니오

## 승인 권고

- Q14의 2023·2025 연결 매출액 NOT_APPLICABLE 2건: 연결 포괄손익계산서에 매출액 line item이 없고 영업이익은 별도 공시됨.
- Narrative Fact 13건: raw_value_text, normalized_value, Evidence quote, source document의 의미가 일치함.
- Q23 issuer attribution: 재무적 손실 없음이 회사 공시상 진술임을 attributes.attribution에 명시함.
- Q7 scope caveat: 5개 제품 집합 출시와 앱토즈마 단독 출시를 구분함.
- Event 5건: 사건 상태를 직접 말하는 Evidence quote가 연결됨.

## 수정 필요

- Event ${fixedEvents.length}건: 사건 분류 자체는 원문/문서 종류/Chain과 맞지만, Evidence가 사건 상태를 직접 증명하지 못함. Event 전용 Evidence를 추가해야 함.
- ${LOI_DATE_DEFECT_EVENT_ID}: event_date가 공시일 2023-06-05로 되어 있으나 원문 의향서 체결일·사실확인일은 2023-06-03임.
- 이 결함이 남아 있으므로 GLOBAL_PROMOTION_GATE는 FIX_REQUIRED.

## 구조 검증

- Event anchor_document_id가 각 Chain document_ids에 포함됨.
- Event corp_code와 Chain corp_code가 일치함.
- 검수 대상 Chain은 CLOSED 상태임.
- Relation source 문서는 target 문서보다 과거가 아님(후행→선행 방향).
- 하나의 문서가 둘 이상의 Chain에 중복 포함되지 않음.
- Q3·Q22는 Fact/Event/Coverage 후보에 포함되지 않고 Gold에서 E2E_EXCLUDED 상태임.
`;
}

function claudeReviewPrompt() {
  return `# Claude Code 재검수 지시문 — Structured Candidate Codex Review v0.1

Codex의 판정을 신뢰하지 말고 다음 파일과 Canonical DocumentIR을 직접 대조해 독립 검수해줘.

입력:
- work/domain-seed/seed-structured-codex-review.v0.1.jsonl
- work/domain-seed/seed-structured-codex-review.v0.1.summary.json
- work/domain-seed/seed-fact-candidates.v0.1.jsonl
- work/domain-seed/seed-event-candidates.v0.1.jsonl
- work/domain-seed/seed-evidence-verified.v0.3.jsonl
- work/domain-seed/seed-relation-gold.v0.1.jsonl
- work/domain-seed/seed-chain-manifest.v0.1.jsonl
- work/domain-seed/seed-canonical-document-ir.v0.6.jsonl
- work/domain-seed/seed-canonical-document-ir.v0.7.delta.jsonl

필수 재검수:
1. Q14의 2023·2025 연결 매출액 NOT_APPLICABLE 판정을 연결 포괄손익계산서에서 재확인한다. 최대주주 국민연금공단 매출액과 매출어음을 사용하면 안 된다.
2. Narrative Fact 13건의 raw_value_text/normalized_value/source/evidence가 실제로 일치하는지 재확인한다.
3. Q7의 5개 제품 집합 출시와 앱토즈마 단독 출시를 구분했는지 확인한다.
4. Q23의 재무적 손실 없음이 issuer-stated claim으로 귀속됐는지 확인한다.
5. Event 24건 중 Codex가 5건만 direct status Evidence가 있다고 판정한 기준을 반박 가능하게 재검증한다. 숫자·날짜·상대방 이름만 있는 quote가 결정/정정/해지/완료를 직접 증명하는지 엄격히 판단한다.
6. event_cffef01467a71df30fdbb9c6의 원문 의향서 체결일·사실확인일이 2023-06-03인지, 현재 event_date 2023-06-05가 공시일을 잘못 사용한 것인지 확인한다.
7. Event anchor/Chain/corp_code/Relation 방향과 문서 중복 검사를 독립적으로 재실행한다.
8. Q3/Q22 제외 및 CANDIDATE/PENDING 상태를 재검증한다.

산출물은 별도 review 파일로 만들고 기존 Candidate·Gold·Evidence·Relation·Chain을 수정하지 마. 판정은 APPROVE_RECOMMENDED/FIX_REQUIRED/REJECT_RECOMMENDED로 기록하고, Codex 판정과 다른 항목은 근거 원문과 함께 명시해. 커밋·push하지 말고 verify:contracts/build/git diff --check 결과를 보고해.
`;
}

export async function buildSeedStructuredCodexReview({ root = repositoryRoot, paths = PATHS, writeOutputs = true, reviewedAt = new Date().toISOString() } = {}) {
  const absolute = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, path.resolve(root, value)]));
  const [factText, eventText, evidenceText, relationText, chainText, coverageText, goldText, queueText] = await Promise.all([
    readFile(absolute.facts, "utf8"), readFile(absolute.events, "utf8"), readFile(absolute.evidence, "utf8"),
    readFile(absolute.relations, "utf8"), readFile(absolute.chains, "utf8"), readFile(absolute.coverage, "utf8"),
    readFile(absolute.gold, "utf8"), readFile(absolute.queue, "utf8"),
  ]);
  const facts = parseJsonLines(factText, paths.facts);
  const events = parseJsonLines(eventText, paths.events);
  const evidence = parseJsonLines(evidenceText, paths.evidence);
  const relations = parseJsonLines(relationText, paths.relations);
  const chains = parseJsonLines(chainText, paths.chains);
  const coverage = JSON.parse(coverageText);
  const gold = parseJsonLines(goldText, paths.gold);
  const queue = parseJsonLines(queueText, paths.queue);
  const { ownerDecisionTemplate } = await prepareSeedStructuredReview({ root, writeOutputs: false });

  if (facts.length !== 54 || events.length !== 24 || coverage.slots?.length !== 69 || queue.length !== 42) {
    throw new Error("unexpected structured Candidate/review counts");
  }
  if (facts.some((record) => record.verification_status !== "CANDIDATE")) throw new Error("Fact promotion occurred before review");
  if (events.some((record) => record.verification_status !== "CANDIDATE")) throw new Error("Event promotion occurred before review");
  if (coverage.slots.some((record) => record.verification_status !== "PENDING_HUMAN_REVIEW")) throw new Error("Coverage promotion occurred before review");

  const serializedCandidates = JSON.stringify({ facts, events, coverage });
  if (/question_seed_v07_(03|22)/.test(serializedCandidates)) throw new Error("excluded question leaked into structured Candidates");
  for (const questionId of ["question_seed_v07_03", "question_seed_v07_22"]) {
    const record = gold.find((item) => item.question_id === questionId);
    if (record?.extensions?.e2e_usage_status !== "E2E_EXCLUDED") throw new Error(`${questionId} is not E2E_EXCLUDED`);
  }

  const factsById = new Map(facts.map((record) => [record.fact_id, record]));
  const eventsById = new Map(events.map((record) => [record.event_id, record]));
  const evidenceById = new Map(evidence.map((record) => [record.evidence_id, record]));
  const chainsById = new Map(chains.map((record) => [record.chain_id, record]));

  const documentChains = new Map();
  for (const chain of chains) for (const documentId of chain.document_ids) {
    const prior = documentChains.get(documentId);
    if (prior && prior !== chain.chain_id) throw new Error(`${documentId} belongs to multiple chains`);
    documentChains.set(documentId, chain.chain_id);
  }
  for (const relation of relations) {
    if (documentDate(relation.source_document_id) < documentDate(relation.target_document_id)) {
      throw new Error(`${relation.relation_id} points from an earlier document to a later one`);
    }
  }

  const templateByItem = new Map(ownerDecisionTemplate.map((record) => [JSON.stringify(record.source_item), record.review_item_id]));
  const decisions = queue.map((item) => {
    const common = {
      review_item_id: templateByItem.get(JSON.stringify(item)), item_type: item.item_type, target_id: targetId(item),
      reviewer: "CODEX_INDEPENDENT_REVIEW", reviewed_at: reviewedAt,
    };
    if (!common.review_item_id) throw new Error(`review item identity missing: ${common.target_id}`);

    if (item.item_type === "NARRATIVE_FACT_CLASSIFICATION_REVIEW" || item.item_type === "ISSUER_STATED_CLAIM_ATTRIBUTION_REVIEW") {
      const fact = factsById.get(item.fact_id);
      if (!fact || fact.evidence_ids.length === 0) throw new Error(`${item.fact_id} has no Fact/Evidence record`);
      for (const evidenceId of fact.evidence_ids) {
        const proof = evidenceById.get(evidenceId);
        if (!proof || proof.document_id !== fact.source_document_id || !proof.quoted_text) throw new Error(`${item.fact_id} has invalid Evidence linkage`);
      }
      if (item.item_type === "ISSUER_STATED_CLAIM_ATTRIBUTION_REVIEW" && !String(fact.attributes?.attribution).includes("회사 진술")) {
        throw new Error(`${item.fact_id} lost issuer attribution`);
      }
      return { ...common, decision: "APPROVE_RECOMMENDED", findings: ["FACT_EVIDENCE_LINK_VALID", "NORMALIZED_MEANING_MATCHES_RAW_DISCLOSURE"] };
    }
    if (item.item_type === "COVERAGE_SLOT_NOT_APPLICABLE") {
      return { ...common, decision: "APPROVE_RECOMMENDED", findings: ["NO_REVENUE_LINE_IN_CONSOLIDATED_INCOME_STATEMENT", "OPERATING_PROFIT_SEPARATELY_DISCLOSED", "NOT_A_SHAREHOLDER_TABLE_OR_NOTES_RECEIVABLE_VALUE"] };
    }
    if (item.item_type === "SCOPE_CAVEAT_REVIEW") {
      const launchFact = facts.find((record) => record.metric_code === "LAUNCH_STATUS" && record.source_document_id === "periodic_20260316001415");
      if (!launchFact?.attributes?.scope_note?.includes("5종 집합")) throw new Error("Q7 scope caveat missing");
      return { ...common, decision: "APPROVE_RECOMMENDED", findings: ["FIVE_PRODUCT_GROUP_SCOPE_PRESERVED", "NO_AVTOZMA_ONLY_LAUNCH_OR_REVENUE_CLAIM"] };
    }
    if (item.item_type === "EVENT_CHAIN_ALIGNMENT_REVIEW") {
      const event = eventsById.get(item.event_id);
      const chain = chainsById.get(event?.chain_id);
      if (!event || !chain || !chain.document_ids.includes(event.anchor_document_id) || chain.corp_code !== event.corp_code || chain.closure_status !== "CLOSED") {
        throw new Error(`${item.event_id} has invalid Event/Chain linkage`);
      }
      if (DIRECT_EVENT_EVIDENCE_IDS.has(event.event_id)) {
        return { ...common, decision: "APPROVE_RECOMMENDED", findings: ["EVENT_SEMANTICS_MATCH_SOURCE", "DIRECT_STATUS_EVIDENCE_PRESENT", "CHAIN_LINKAGE_VALID"] };
      }
      const findings = ["EVENT_SEMANTICS_MATCH_SOURCE", "CHAIN_LINKAGE_VALID", "DIRECT_EVENT_STATUS_EVIDENCE_REQUIRED"];
      if (event.event_id === LOI_DATE_DEFECT_EVENT_ID) findings.push("EVENT_DATE_MUST_CHANGE_FROM_2023-06-05_TO_2023-06-03");
      return { ...common, decision: "FIX_REQUIRED", findings };
    }
    if (item.item_type === "GLOBAL_PROMOTION_GATE") {
      return { ...common, decision: "FIX_REQUIRED", findings: ["EVENT_PROVENANCE_FIXES_PENDING", "LOI_EVENT_DATE_FIX_PENDING", "DO_NOT_PROMOTE_YET"] };
    }
    throw new Error(`unsupported review type: ${item.item_type}`);
  });

  const summary = {
    schema_version: "0.1.0", status: "INDEPENDENT_REVIEW_COMPLETE_PROMOTION_BLOCKED",
    review_count: decisions.length, decisions: countBy(decisions, "decision"),
    narrative_fact_approved: decisions.filter((record) => record.item_type === "NARRATIVE_FACT_CLASSIFICATION_REVIEW" && record.decision === "APPROVE_RECOMMENDED").length,
    event_approved: decisions.filter((record) => record.item_type === "EVENT_CHAIN_ALIGNMENT_REVIEW" && record.decision === "APPROVE_RECOMMENDED").length,
    event_fix_required: decisions.filter((record) => record.item_type === "EVENT_CHAIN_ALIGNMENT_REVIEW" && record.decision === "FIX_REQUIRED").length,
    critical_defects: [{ event_id: LOI_DATE_DEFECT_EVENT_ID, field: "event_date", actual: "2023-06-05", expected: "2023-06-03" }],
    excluded_questions_verified: ["question_seed_v07_03", "question_seed_v07_22"], promotion_allowed: false,
  };

  if (writeOutputs) {
    await mkdir(path.dirname(absolute.output), { recursive: true });
    await Promise.all([
      writeFile(absolute.output, `${decisions.map((record) => JSON.stringify(record)).join("\n")}\n`),
      writeFile(absolute.summary, `${JSON.stringify(summary, null, 2)}\n`),
      writeFile(absolute.report, reportMarkdown(summary, decisions)),
      writeFile(absolute.claudePrompt, claudeReviewPrompt()),
    ]);
  }
  return { decisions, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { summary } = await buildSeedStructuredCodexReview();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
