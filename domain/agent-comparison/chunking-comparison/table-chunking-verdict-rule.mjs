// Turn P10.3-TABLE / Stage 5: the FIXED, pre-registered final verdict rule.
// Pure function over already-computed Stage 2/3/4 numbers -- never
// modified after seeing results, never falls back to approving Fixed by
// default when the evidence is uncertain.
export const TABLE_VERDICT = Object.freeze({
  FIXED_SAFE: "FIXED_512_TABLE_SAFE",
  SECTION_PREFERRED: "SECTION_FLAT_PREFERRED_FOR_TABLES",
  ADAPTIVE_REQUIRED: "ADAPTIVE_TABLE_CHUNKING_REQUIRED",
  INCONCLUSIVE: "TABLE_DIAGNOSTIC_INCONCLUSIVE",
});

const RECALL_TOLERANCE = 0.01;
const SECTION_PREFERENCE_MARGIN = 0.03;
const MIN_TABLE_ITEM_SAMPLE = 15;

export function decideTableChunkingVerdict({
  tableItemCount,
  fixedCriticalViolationCount,
  sectionCriticalViolationCount,
  fixedMisattributionCount, // row/column/unit/period misattribution, 0 if none
  sectionMisattributionCount,
  recallDeltasByModel, // [{ frozen_candidate_id, fixed_table_recall_at_10, section_table_recall_at_10, section_wins, fixed_wins }]
  fixedMultiCellCompletenessRate,
  sectionMultiCellCompletenessRate,
  determinismStable,
  cacheOrRankingDataMissing,
  locatorDeterministicallyResolvable,
  modelVerdictsConflictSharply,
}) {
  const reasonTrail = [];

  if (cacheOrRankingDataMissing) {
    reasonTrail.push("P10.2 cache/ranking 결과 누락");
    return { status: TABLE_VERDICT.INCONCLUSIVE, reasonTrail, adaptiveDesign: null };
  }
  if (!locatorDeterministicallyResolvable) {
    reasonTrail.push("원문 row/column을 결정론적으로 복원하지 못함");
    return { status: TABLE_VERDICT.INCONCLUSIVE, reasonTrail, adaptiveDesign: null };
  }
  if (tableItemCount < MIN_TABLE_ITEM_SAMPLE) {
    reasonTrail.push(`표 표본이 너무 작음 (${tableItemCount} < ${MIN_TABLE_ITEM_SAMPLE})`);
    return { status: TABLE_VERDICT.INCONCLUSIVE, reasonTrail, adaptiveDesign: null };
  }
  if (modelVerdictsConflictSharply) {
    reasonTrail.push("모델별 판정이 크게 충돌함");
    return { status: TABLE_VERDICT.INCONCLUSIVE, reasonTrail, adaptiveDesign: null };
  }

  const fixedRecallNeverBehindByMoreThanTolerance = recallDeltasByModel.every((d) => (d.fixed_table_recall_at_10 - d.section_table_recall_at_10) >= -RECALL_TOLERANCE);
  const fixedMultiCellOkOrBetter = fixedMultiCellCompletenessRate === null || sectionMultiCellCompletenessRate === null
    ? true
    : fixedMultiCellCompletenessRate >= sectionMultiCellCompletenessRate;

  const fixedSafe = fixedCriticalViolationCount === 0
    && fixedMisattributionCount === 0
    && fixedRecallNeverBehindByMoreThanTolerance
    && fixedMultiCellOkOrBetter;
  if (fixedSafe) {
    reasonTrail.push("Fixed critical violation 0, misattribution 0, table Recall@10 우위 유지, multi-cell completeness 동등/우세");
    return { status: TABLE_VERDICT.FIXED_SAFE, reasonTrail, adaptiveDesign: null };
  }
  reasonTrail.push(`FIXED_512_TABLE_SAFE 미충족: critical_violations=${fixedCriticalViolationCount}, misattribution=${fixedMisattributionCount}, recall_never_behind=${fixedRecallNeverBehindByMoreThanTolerance}, multi_cell_ok=${fixedMultiCellOkOrBetter}`);

  const modelsWhereSectionBeatsFixedByMargin = recallDeltasByModel.filter((d) => (d.section_table_recall_at_10 - d.fixed_table_recall_at_10) >= SECTION_PREFERENCE_MARGIN).length;
  const onlyFixedHasCriticalViolations = fixedCriticalViolationCount > 0 && sectionCriticalViolationCount === 0;
  const sectionPreferred = determinismStable === true
    && (modelsWhereSectionBeatsFixedByMargin >= 2 || onlyFixedHasCriticalViolations);
  if (sectionPreferred) {
    reasonTrail.push(`Section이 ${modelsWhereSectionBeatsFixedByMargin}개 모델에서 table Recall@10 0.03 이상 우위, 또는 Fixed에만 critical violation 존재(${onlyFixedHasCriticalViolations}), determinism 재현됨`);
    return { status: TABLE_VERDICT.SECTION_PREFERRED, reasonTrail, adaptiveDesign: null };
  }
  reasonTrail.push(`SECTION_FLAT_PREFERRED_FOR_TABLES 미충족: models_beating_by_margin=${modelsWhereSectionBeatsFixedByMargin}, only_fixed_has_violations=${onlyFixedHasCriticalViolations}, determinism_stable=${determinismStable}`);

  const sectionStructurallyBetter = sectionCriticalViolationCount < fixedCriticalViolationCount;
  if (sectionStructurallyBetter) {
    reasonTrail.push(`일반 문서는 Fixed 우세(P10.2 기존 선정), 표 문서는 구조 보존에서 Section이 우세(critical_violations Fixed=${fixedCriticalViolationCount} > Section=${sectionCriticalViolationCount})하나 검색 우위로 이어지지 않아 단일 청킹으로 양쪽을 만족 못함`);
    return {
      status: TABLE_VERDICT.ADAPTIVE_REQUIRED,
      reasonTrail,
      adaptiveDesign: {
        paragraph_title: "fixed-token-512-o64.v0.1.0",
        table_table_row: "table-aware chunk preserving title/unit/row/column context (design only, NOT implemented this Turn)",
        combination: "동일 문서 내 두 결과를 공통 retrieval ranker에서 결합",
      },
    };
  }

  reasonTrail.push("어떤 기준도 명확히 충족하지 않음");
  return { status: TABLE_VERDICT.INCONCLUSIVE, reasonTrail, adaptiveDesign: null };
}
