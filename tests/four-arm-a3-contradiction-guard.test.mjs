import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  detectEvidenceContradictions,
  normalizePeriodLabel,
  CONTRADICTION_STATUS,
  ContradictionGuardInputError,
} from "../domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs";

// All fixtures below are hand-authored and synthetic: fictional company
// labels ("테스트기업A/B"), invented indicator names, and no real packet ID,
// question sentence, Gold value, or Gold locator from this repository. This
// turn never opened A.results.jsonl, Gold, DEV_TUNE, or any existing
// critical packet (see results/A3_CONTRADICTION_GUARD_V1_HANDOFF.md).

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

test("연결 요구 + 별도 근거 -> REJECT/SCOPE_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    evidenceFacts: deepFreeze({ scope_hint: "별도재무제표 주석" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("SCOPE_CONTRADICTION"));
});

test("별도 요구 + 연결 근거 -> REJECT/SCOPE_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ scope: "SEPARATE" }),
    evidenceFacts: deepFreeze({ scope_hint: "연결 손익계산서" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("SCOPE_CONTRADICTION"));
});

test("연결 요구 + scope 불명확 -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    evidenceFacts: deepFreeze({ scope_hint: "요약 재무정보" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
  assert.ok(result.reasons.includes("INSUFFICIENT_CONTEXT"));
});

// ---------------------------------------------------------------------------
// period
// ---------------------------------------------------------------------------

test("2024년 요구 + 2023년 근거 -> REJECT/PERIOD_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ period: { label: "2024년" } }),
    evidenceFacts: deepFreeze({ period_hint: "2023년 사업연도" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("PERIOD_CONTRADICTION"));
});

test("누적 요구 + 3개월 근거 -> REJECT/PERIOD_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ period: { label: "2024년 3분기 누적" } }),
    evidenceFacts: deepFreeze({ period_hint: "2024년 3분기 3개월" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("PERIOD_CONTRADICTION"));
});

test("기간 불명확 (분기만 있고 누적/3개월 구분 없음) -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ period: { label: "2024년 2분기 누적" } }),
    evidenceFacts: deepFreeze({ period_hint: "2024년 2분기" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
  assert.ok(result.reasons.includes("INSUFFICIENT_CONTEXT"));
});

test("동일 기간(같은 사업연도) -> PASS", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ period: { label: "2024년" } }),
    evidenceFacts: deepFreeze({ period_hint: "2024년 사업연도" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.PASS);
});

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------

test("원 <-> 백만원 정확 환산 가능 -> PASS (호환, conversion 기록)", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ unit: "MILLION_KRW" }),
    evidenceFacts: deepFreeze({ unit_hint: "단위: 원" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.PASS);
  assert.equal(result.checks.unit.conversion.from_unit, "KRW");
  assert.equal(result.checks.unit.conversion.to_unit, "MILLION_KRW");
  assert.equal(result.checks.unit.conversion.multiply_observed_value_by, 1e-6);
});

test("단위 차이로 값이 호환되지 않음 (금액 요구 + % 근거) -> REJECT/UNIT_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ unit: "KRW" }),
    evidenceFacts: deepFreeze({ unit_hint: "증감률 12.3%" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("UNIT_CONTRADICTION"));
});

test("단위 불명확 -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ unit: "KRW" }),
    evidenceFacts: deepFreeze({ unit_hint: "요약치" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
});

// ---------------------------------------------------------------------------
// revision
// ---------------------------------------------------------------------------

test("정정 후 요구 + 정정 전 근거 -> REJECT/REVISION_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ revision: "POST_REVISION" }),
    evidenceFacts: deepFreeze({ revision_hint: "정정 전 공시 기준" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("REVISION_CONTRADICTION"));
});

test("정정 전 요구 + 정정 후 근거 -> REJECT/REVISION_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ revision: "PRE_REVISION" }),
    evidenceFacts: deepFreeze({ revision_hint: "정정후 재공시" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("REVISION_CONTRADICTION"));
});

test("정정 표지 불명확 -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ revision: "POST_REVISION" }),
    evidenceFacts: deepFreeze({ revision_hint: "공시 정정 관련 안내" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
});

// ---------------------------------------------------------------------------
// entity
// ---------------------------------------------------------------------------

test("대상 기업 명백한 불일치 -> REJECT/ENTITY_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ entity: "테스트기업A" }),
    evidenceFacts: deepFreeze({ entity: "테스트기업B" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("ENTITY_CONTRADICTION"));
});

test("승인된 별칭 resolver 입력이 있으면 동일 처리 -> PASS", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      entity: { required_name: "테스트기업A", approved_aliases: ["테스트기업에이"] },
    }),
    evidenceFacts: deepFreeze({ entity: "테스트기업에이" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.PASS);
  assert.equal(result.checks.entity.alias_resolved, true);
});

test("승인되지 않은 별칭은 동일 처리하지 않음 -> REJECT", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      entity: { required_name: "테스트기업A", approved_aliases: ["테스트기업에이"] },
    }),
    evidenceFacts: deepFreeze({ entity: "테스트기업씨" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
});

test("기업 정보 없음 -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({ entity: "테스트기업A" }),
    evidenceFacts: deepFreeze({}),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
});

// ---------------------------------------------------------------------------
// row / column
// ---------------------------------------------------------------------------

test("같은 표의 다른 지표 행 -> REJECT/ROW_COLUMN_CONTRADICTION", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      row_column: { required_table_title: "가상요약표", required_row_label: "가상지표1" },
    }),
    evidenceFacts: deepFreeze({ table_title: "가상요약표", row_label: "가상지표2" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("ROW_COLUMN_CONTRADICTION"));
  assert.equal(result.checks.row_column.conflicting_field, "row_label");
});

test("행/열 정보 부족 -> KEEP_UNKNOWN", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      row_column: { required_row_label: "가상지표1" },
    }),
    evidenceFacts: deepFreeze({ table_title: "가상요약표" }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
  assert.equal(result.checks.row_column.unresolved_field, "row_label");
});

// ---------------------------------------------------------------------------
// aggregate behavior
// ---------------------------------------------------------------------------

test("모든 조건 일치 -> PASS", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      scope: "CONSOLIDATED",
      period: { label: "2024년 3분기 누적" },
      unit: "MILLION_KRW",
      revision: "POST_REVISION",
      entity: "테스트기업A",
      row_column: { required_table_title: "가상요약표", required_row_label: "가상지표1", required_column_label: "당기" },
    }),
    evidenceFacts: deepFreeze({
      scope_hint: "연결 손익계산서",
      period_hint: "2024년 3분기 누적",
      unit_hint: "단위: 백만원",
      revision_hint: "정정 후 재공시",
      entity: "테스트기업A",
      table_title: "가상요약표",
      row_label: "가상지표1",
      column_label: "당기",
    }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.PASS);
  assert.deepEqual(result.reasons, []);
});

test("여러 차원 중 하나만 모순이어도 REJECT", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      scope: "CONSOLIDATED",
      period: { label: "2024년 3분기 누적" },
      entity: "테스트기업A",
    }),
    evidenceFacts: deepFreeze({
      scope_hint: "연결 손익계산서",
      period_hint: "2024년 3분기 누적",
      entity: "테스트기업B", // only this dimension conflicts
    }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.deepEqual(result.reasons, ["ENTITY_CONTRADICTION"]);
});

test("REJECT가 하나라도 있으면 다른 차원의 KEEP_UNKNOWN보다 우선한다", () => {
  const result = detectEvidenceContradictions({
    questionConditions: deepFreeze({
      scope: "CONSOLIDATED",
      entity: "테스트기업A",
    }),
    evidenceFacts: deepFreeze({
      scope_hint: "요약 재무정보", // KEEP_UNKNOWN dimension
      entity: "테스트기업B", // REJECT dimension
    }),
  });
  assert.equal(result.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(result.reasons.includes("ENTITY_CONTRADICTION"));
  assert.ok(result.reasons.includes("INSUFFICIENT_CONTEXT"));
});

// ---------------------------------------------------------------------------
// purity / determinism
// ---------------------------------------------------------------------------

test("입력 객체를 변경하지 않음", () => {
  const questionConditions = deepFreeze({
    scope: "CONSOLIDATED",
    entity: "테스트기업A",
    row_column: { required_row_label: "가상지표1" },
  });
  const evidenceFacts = deepFreeze({
    scope_hint: "별도재무제표",
    entity: "테스트기업B",
    row_label: "가상지표2",
  });
  const snapshotQ = JSON.stringify(questionConditions);
  const snapshotE = JSON.stringify(evidenceFacts);
  detectEvidenceContradictions({ questionConditions, evidenceFacts });
  assert.equal(JSON.stringify(questionConditions), snapshotQ);
  assert.equal(JSON.stringify(evidenceFacts), snapshotE);
});

test("동일 입력에 byte-identical 결과", () => {
  const questionConditions = deepFreeze({
    scope: "CONSOLIDATED",
    period: { label: "2024년 3분기 누적" },
    unit: "KRW",
    revision: "POST_REVISION",
    entity: "테스트기업A",
    row_column: { required_table_title: "가상요약표", required_row_label: "가상지표1" },
  });
  const evidenceFacts = deepFreeze({
    scope_hint: "연결 손익계산서",
    period_hint: "2024년 3분기 누적",
    unit_hint: "단위: 백만원",
    revision_hint: "정정 후 재공시",
    entity: "테스트기업A",
    table_title: "가상요약표",
    row_label: "가상지표1",
  });
  const r1 = detectEvidenceContradictions({ questionConditions, evidenceFacts });
  const r2 = detectEvidenceContradictions({ questionConditions, evidenceFacts });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test("잘못된 입력 타입은 즉시 명시적으로 실패한다", () => {
  assert.throws(() => detectEvidenceContradictions({ questionConditions: ["not", "an", "object"] }), ContradictionGuardInputError);
  assert.throws(() => detectEvidenceContradictions({ evidenceFacts: "not-an-object" }), ContradictionGuardInputError);
});

test("normalizePeriodLabel: 명시적 구분자가 없는 분기 라벨은 null(불명확)", () => {
  assert.equal(normalizePeriodLabel("2024년 2분기"), null);
});

test("normalizePeriodLabel: 상반기/하반기는 고정 범위로 해석된다", () => {
  assert.deepEqual(normalizePeriodLabel("2024년 상반기"), { fiscal_year: 2024, start_month: 1, end_month: 6 });
  assert.deepEqual(normalizePeriodLabel("2024년 하반기"), { fiscal_year: 2024, start_month: 7, end_month: 12 });
});

// ---------------------------------------------------------------------------
// no forbidden real identifiers in the implementation source
// ---------------------------------------------------------------------------

test("구현 소스에 금지된 Gold/packet 필드 접근이나 실제 packet ID 패턴이 없음", () => {
  const modulePath = fileURLToPath(
    new URL("../domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs", import.meta.url),
  );
  const source = readFileSync(modulePath, "utf8");

  for (const forbidden of ["acceptable_sources", "gold_evidence", "gold_answer", "A.results.jsonl", "DEV_TUNE"]) {
    assert.ok(!source.includes(forbidden), `module source must not reference "${forbidden}"`);
  }

  // Real packet IDs in this repo follow the shape "u-" + 12 hex chars.
  assert.doesNotMatch(source, /u-[0-9a-f]{12}/);

  // No network/DB/search/LLM call surface of any kind.
  for (const forbidden of ["fetch(", "require(", "import(", "http.", "pg.", "Pool(", "axios", "kure", "hyperclova", "hcx"]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `module source must not reference "${forbidden}"`);
  }

  // No import statements at all -- this module has zero dependencies.
  assert.doesNotMatch(source, /^import /m);
});

test("테스트 소스 자체에도 금지된 실제 packet ID 패턴이 없음", () => {
  const testPath = fileURLToPath(import.meta.url);
  const source = readFileSync(testPath, "utf8");
  assert.doesNotMatch(source, /u-[0-9a-f]{12}/);
});
