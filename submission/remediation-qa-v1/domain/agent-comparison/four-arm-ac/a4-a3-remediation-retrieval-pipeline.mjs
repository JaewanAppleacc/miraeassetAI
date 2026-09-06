// runQuestionPipeline()의 검색 개선(remediation) 적용 변형. bm25_top100/dense_top100을
// 단일 패스 대신 a4-a3-remediation-candidate-legs.mjs의 다중 패스 생성기에서 가져오고,
// 후보 생성 이후 단계(광역 풀, R4 순위, A3 가드, 안정 보충)는 기존 모듈들이 export하는
// 같은 함수들을 무수정으로 재사용한다.
//
// buildWideCandidatePool()에는 original_a_top20을 []로 넘긴다 — 그 함수의 RRF 재현성
// 교차검증은 이 배열이 비어 있지 않을 때만 도는데, 개선된 leg는 원래 Arm A의 frozen leg를
// 재현할 대상이 아니기 때문이다.
import { buildWideCandidatePool } from "./a4-wide-candidate-pool.mjs";
import { rankCandidatePool, selectWithStableRefill } from "./a4-reranker-engine.mjs";
import { detectEvidenceContradictions, CONTRADICTION_STATUS } from "./a3-evidence-contradiction-guard.mjs";
import { extractQuestionConditions, extractEvidenceFacts } from "./a4-a3-retrieval-pipeline.mjs";
import { mapOfficialConditionToFilterInput } from "./four-arm-conditions-to-filter-mapper.mjs";
import { runRemediationAwareCandidateGeneration } from "./a4-a3-remediation-candidate-legs.mjs";

// deps: same shape as a4-a3-retrieval-pipeline.mjs's runQuestionPipeline (client,
//   bm25Index, embeddingAdapter, retrievalIndexId, provenanceLoadSessionId, expectedPins,
//   nameToCorpCodeIndex).
// question: {question_id, question, conditions, segment} -- conditions is the QA
//   condition mapper's own output shape (unchanged call site: this function calls
//   mapOfficialConditionToFilterInput itself, exactly where the frozen pipeline does).
// configs: the reranker config registry entries (here always just R4_wide_rrf_centric).
// policy: a four-arm-retrieval-policy.mjs policy id or object (REMEDIATION_V1_POLICY.id
//   for this turn's new backend; passing FROZEN_POLICY.id here reproduces the frozen
//   pipeline's own single-pass leg behaviour through the multi-pass code path's own
//   frozen branch -- verified equivalent by this turn's own offline tests, never how the
//   ARM_A4_A3_LIVE backend itself is served, which continues to call the original,
//   untouched runQuestionPipeline).
export async function runQuestionPipelineRemediationAware(deps, question, configs, policy) {
  const { nameToCorpCodeIndex } = deps;
  const mapped = mapOfficialConditionToFilterInput(question.conditions, nameToCorpCodeIndex);

  const { bm25_top100, dense_top100 } = await runRemediationAwareCandidateGeneration(
    deps, { question: question.question, mappedFilters: mapped.filters }, policy,
  );

  const { pool } = buildWideCandidatePool({
    original_a_top20: [],
    bm25_top100,
    dense_top100,
  });

  const questionContext = {
    question_id: question.question_id,
    question_text: question.question,
    required_metric_labels: Array.isArray(question.conditions?.candidate_terms) ? question.conditions.candidate_terms : null,
    expected_corp_codes: mapped.filters?.corp_codes ?? null,
    expected_doc_groups: mapped.filters?.doc_groups ?? null,
    expected_base_years: mapped.filters?.base_years ?? null,
    expected_base_months: mapped.filters?.base_months ?? null,
  };
  const requiredConditions = extractQuestionConditions(question.question, mapped.filters);

  const decisionByChunkId = new Map();
  for (const candidate of pool) {
    const evidenceFacts = extractEvidenceFacts(candidate);
    const result = detectEvidenceContradictions({ questionConditions: requiredConditions, evidenceFacts });
    decisionByChunkId.set(candidate.chunk_id, result.status === CONTRADICTION_STATUS.REJECT ? "REJECT"
      : result.status === CONTRADICTION_STATUS.KEEP_UNKNOWN ? "KEEP_UNKNOWN" : "PASS");
  }

  const perConfig = {};
  for (const config of configs) {
    const full = rankCandidatePool(pool, questionContext, config);
    const rawTop20 = full.slice(0, 20);
    const decisions = Object.fromEntries(full.map((c) => [c.chunk_id, decisionByChunkId.get(c.chunk_id)]));
    const finalTop20 = selectWithStableRefill(full, decisions, { outputK: 20 });
    const counts = { PASS: 0, REJECT: 0, KEEP_UNKNOWN: 0 };
    for (const c of full) counts[decisionByChunkId.get(c.chunk_id)] += 1;
    const rejectedInTop20 = rawTop20.filter((c) => decisionByChunkId.get(c.chunk_id) === "REJECT").length;
    perConfig[config.config_id] = {
      raw_top20: rawTop20,
      final_top20: finalTop20,
      a3_pass: counts.PASS,
      a3_reject: counts.REJECT,
      a3_keep_unknown: counts.KEEP_UNKNOWN,
      stable_refill_count: rejectedInTop20,
      final_shortfall: finalTop20.length < 20,
    };
  }

  return {
    question_id: question.question_id,
    wide_pool_size: pool.length,
    per_config: perConfig,
  };
}
