import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  validateEvidenceDimensions,
  normalizePeriodLabel,
  VALIDATION_STATUS,
  ScopeValidatorInputError,
} from "../domain/agent-comparison/four-arm-ac/a2-evidence-scope-validator.mjs";

// All fixtures below are hand-authored and synthetic. None of them copy any
// real critical-packet content, Gold value, or Gold locator (see
// results/A2_SCOPE_VALIDATOR_V1_AMENDMENT.md).

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("연결 질문 + 별도 표 -> REJECT/SCOPE_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    retrievalItem: deepFreeze({ scope_hint: "별도재무제표 주석" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("SCOPE_CONFLICT"));
  assert.equal(result.checks.scope.observed, "SEPARATE");
});

test("별도 질문 + 연결 표 -> REJECT/SCOPE_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ scope: "SEPARATE" }),
    retrievalItem: deepFreeze({ scope_hint: "연결재무제표 주석" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("SCOPE_CONFLICT"));
  assert.equal(result.checks.scope.observed, "CONSOLIDATED");
});

test("연결 질문 + 연결 표 -> PASS", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    retrievalItem: deepFreeze({ scope_hint: "연결 손익계산서" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.deepEqual(result.reasons, []);
});

test("scope 표지 없음 -> UNRESOLVED (별도로 추측하지 않음)", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    retrievalItem: deepFreeze({ scope_hint: "요약 재무정보" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.UNRESOLVED);
  assert.ok(result.reasons.includes("INSUFFICIENT_CONTEXT"));
  assert.equal(result.checks.scope.observed, null);
});

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

test("2025 Q1 질문 + 2024 Q1 표 -> REJECT/PERIOD_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ period: { label: "2025년 1분기" } }),
    retrievalItem: deepFreeze({ period_hint: "2024년 1분기 3개월" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("PERIOD_CONFLICT"));
});

test("1분기 누적과 1분기 3개월은 동일 의미 -> PASS", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ period: { label: "2024년 1분기 누적" } }),
    retrievalItem: deepFreeze({ period_hint: "2024년 1분기 3개월" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.deepEqual(result.checks.period.expected, result.checks.period.observed);
});

test("반기 누적과 2분기 3개월은 서로 다른 기간 -> REJECT/PERIOD_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ period: { label: "2024년 반기 누적" } }),
    retrievalItem: deepFreeze({ period_hint: "2024년 2분기 3개월" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("PERIOD_CONFLICT"));
  assert.deepEqual(result.checks.period.expected, { fiscal_year: 2024, start_month: 1, end_month: 6 });
  assert.deepEqual(result.checks.period.observed, { fiscal_year: 2024, start_month: 4, end_month: 6 });
});

test("normalizePeriodLabel: 2분기/3분기/4분기를 명시적 qualifier 없이 주면 UNRESOLVED(null)", () => {
  assert.equal(normalizePeriodLabel("2024년 2분기"), null);
  assert.equal(normalizePeriodLabel("2024년 3분기 누적")?.end_month, 9);
  assert.equal(normalizePeriodLabel("2024년 4분기 3개월")?.start_month, 10);
});

test("period 조건이 없으면 PASS (no requirement)", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({}),
    retrievalItem: deepFreeze({ period_hint: "2024년 2분기" }),
  });
  assert.equal(result.checks.period.status, VALIDATION_STATUS.PASS);
});

// ---------------------------------------------------------------------------
// Unit / sign
// ---------------------------------------------------------------------------

test("원 -> 백만원 정확 환산 -> PASS + 변환 기록", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ unit: { required_unit: "MILLION_KRW" } }),
    retrievalItem: deepFreeze({ unit_hint: "(단위 : 원)" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.equal(result.checks.unit.observed.unit, "KRW");
  assert.ok(result.checks.unit.conversion);
  assert.equal(result.checks.unit.conversion.from_unit, "KRW");
  assert.equal(result.checks.unit.conversion.to_unit, "MILLION_KRW");
  assert.equal(result.checks.unit.conversion.multiply_observed_value_by, 1e-6);
});

test("동일 단위면 변환 기록 없이 PASS", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ unit: { required_unit: "MILLION_KRW" } }),
    retrievalItem: deepFreeze({ unit_hint: "(단위: 백만원)" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.equal(result.checks.unit.conversion, null);
});

test("부호 요구 충돌 -> REJECT/UNIT_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ unit: { required_unit: "MILLION_KRW", required_sign: "POSITIVE" } }),
    retrievalItem: deepFreeze({ unit_hint: "(단위: 백만원)", sign: "NEGATIVE" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("UNIT_CONFLICT"));
});

test("단위 판독 불가 -> UNRESOLVED", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ unit: { required_unit: "MILLION_KRW" } }),
    retrievalItem: deepFreeze({ unit_hint: "요약 표" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.UNRESOLVED);
});

// ---------------------------------------------------------------------------
// Row / column
// ---------------------------------------------------------------------------

test("행명 동일, 열(기간) 상이 -> REJECT/ROW_COLUMN_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({
      row_column: { required_row_label: "매출액", required_column_label: "2024년 1분기(3개월)" },
    }),
    retrievalItem: deepFreeze({ row_label: "매출액", column_label: "2024년 2분기(3개월)" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("ROW_COLUMN_CONFLICT"));
  assert.equal(result.checks.row_column.conflicting_field, "column_label");
});

test("동일 셀의 공백/구두점 차이만 있으면 PASS", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({
      row_column: { required_row_label: "매출액 (수익)", required_column_label: "2024년  1분기" },
    }),
    retrievalItem: deepFreeze({ row_label: "매출액(수익)", column_label: "2024년 1분기" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
});

test("row/column 요구 있는데 근거에 없음 -> UNRESOLVED", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ row_column: { required_row_label: "매출액" } }),
    retrievalItem: deepFreeze({}),
  });
  assert.equal(result.status, VALIDATION_STATUS.UNRESOLVED);
  assert.equal(result.checks.row_column.unresolved_field, "row_label");
});

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

test("entity 불일치 -> REJECT/ENTITY_CONFLICT", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ entity: "가상전자" }),
    retrievalItem: deepFreeze({ entity: "가상바이오" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("ENTITY_CONFLICT"));
});

// ---------------------------------------------------------------------------
// Aggregation / combined
// ---------------------------------------------------------------------------

test("모든 dimension 통과 -> PASS, reasons 비어있음", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({
      scope: "CONSOLIDATED",
      entity: "가상전자",
      period: { label: "2024년 1분기" },
      unit: { required_unit: "MILLION_KRW" },
      row_column: { required_row_label: "매출액" },
    }),
    retrievalItem: deepFreeze({
      scope_hint: "연결 재무제표",
      entity: "가상전자",
      period_hint: "2024년 1분기 3개월",
      unit_hint: "(단위: 백만원)",
      row_label: "매출액",
    }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.deepEqual(result.reasons, []);
});

test("REJECT가 하나라도 있으면 전체 상태는 REJECT (UNRESOLVED보다 우선)", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({
      scope: "CONSOLIDATED", // will be REJECT
      row_column: { required_row_label: "매출액" }, // will be UNRESOLVED (no evidence row_label)
    }),
    retrievalItem: deepFreeze({ scope_hint: "별도재무제표" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.REJECT);
  assert.ok(result.reasons.includes("SCOPE_CONFLICT"));
  assert.ok(result.reasons.includes("INSUFFICIENT_CONTEXT"));
});

test("expandedEvidence가 retrievalItem보다 우선한다", () => {
  const result = validateEvidenceDimensions({
    questionConditions: deepFreeze({ scope: "CONSOLIDATED" }),
    retrievalItem: deepFreeze({ scope_hint: "별도재무제표" }),
    expandedEvidence: deepFreeze({ scope_hint: "연결재무제표" }),
  });
  assert.equal(result.status, VALIDATION_STATUS.PASS);
  assert.equal(result.checks.scope.observed, "CONSOLIDATED");
});

// ---------------------------------------------------------------------------
// Invariants: no hardcoded packet/company/value, input immutability
// ---------------------------------------------------------------------------

test("모듈 소스에 packet-ID/특정 기업명 하드코딩이 없다", () => {
  const modulePath = fileURLToPath(
    new URL("../domain/agent-comparison/four-arm-ac/a2-evidence-scope-validator.mjs", import.meta.url),
  );
  const source = readFileSync(modulePath, "utf8");
  assert.equal(/u-[0-9a-f]{10,}/.test(source), false, "no literal packet-ID pattern");
  assert.equal(/삼성전자|SK하이닉스|LG전자|현대자동차/.test(source), false, "no literal company name");
  // Comments documenting the "never reads Gold" constraint are expected and
  // required -- what must never appear is actual Gold-shaped data access.
  assert.equal(/acceptable_sources|gold_evidence|gold_answer|goldEvidence|goldAnswer/i.test(source), false, "no Gold-shaped field access");
});

test("입력 객체를 변형하지 않는다 (deep-frozen inputs, no throw)", () => {
  const questionConditions = deepFreeze({
    scope: "CONSOLIDATED",
    period: { label: "2024년 1분기" },
    unit: { required_unit: "MILLION_KRW", required_sign: "POSITIVE" },
    row_column: { required_row_label: "매출액", required_column_label: "2024년 1분기" },
    entity: "가상전자",
  });
  const retrievalItem = deepFreeze({
    scope_hint: "연결 재무제표",
    period_hint: "2024년 1분기 3개월",
    unit_hint: "(단위: 백만원)",
    sign: "POSITIVE",
    row_label: "매출액",
    column_label: "2024년 1분기",
    entity: "가상전자",
  });
  const expandedEvidence = deepFreeze({ table_title: "요약 재무정보" });

  const before = JSON.stringify({ questionConditions, retrievalItem, expandedEvidence });
  assert.doesNotThrow(() => validateEvidenceDimensions({ questionConditions, retrievalItem, expandedEvidence }));
  const after = JSON.stringify({ questionConditions, retrievalItem, expandedEvidence });
  assert.equal(before, after);
});

test("잘못된 입력 타입은 명시적으로 거부한다", () => {
  assert.throws(() => validateEvidenceDimensions({ questionConditions: [] }), ScopeValidatorInputError);
  assert.throws(() => validateEvidenceDimensions({ retrievalItem: "not-an-object" }), ScopeValidatorInputError);
});
