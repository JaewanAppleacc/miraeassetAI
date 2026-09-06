// Turn A2-DOCUMENTIR-NODESTORE-V1.1: scoped, offline tests for
// a2-question-condition-extractor.mjs. Every question text here is
// hand-authored/synthetic; officialConditions fixtures are synthetic too.
// No Gold, no acceptable_sources, no critical packet ID, no scoring result.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { extractQuestionConditions } from "../domain/agent-comparison/four-arm-ac/a2-question-condition-extractor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "../domain/agent-comparison/four-arm-ac/a2-question-condition-extractor.mjs");

// ---------------------------------------------------------------------------
// scope -- the one hard requirement: an explicit marker must never be missed.
// ---------------------------------------------------------------------------

test("scope: 연결재무제표 -> CONSOLIDATED", () => {
  const r = extractQuestionConditions({ questionText: "삼성전자의 2024년 연결재무제표 상 매출액은 얼마인가?" });
  assert.equal(r.scope, "CONSOLIDATED");
});

test("scope: bare 연결 marker -> CONSOLIDATED", () => {
  const r = extractQuestionConditions({ questionText: "두 회사의 연결 매출액을 비교하면?" });
  assert.equal(r.scope, "CONSOLIDATED");
});

test("scope: 별도재무제표 -> SEPARATE", () => {
  const r = extractQuestionConditions({ questionText: "현대자동차의 별도재무제표 상 영업이익은?" });
  assert.equal(r.scope, "SEPARATE");
});

test("scope: 개별재무제표 -> SEPARATE", () => {
  const r = extractQuestionConditions({ questionText: "해당 법인의 개별재무제표 기준 자산총액은?" });
  assert.equal(r.scope, "SEPARATE");
});

test("scope: no marker at all -> null (never inferred)", () => {
  const r = extractQuestionConditions({ questionText: "삼성전자의 2024년 매출액은 얼마인가?" });
  assert.equal(r.scope, null);
});

test("scope: both markers present in one question -> null (ambiguous, never guessed)", () => {
  const r = extractQuestionConditions({ questionText: "연결과 별도 재무제표의 매출액 차이는?" });
  assert.equal(r.scope, null);
});

// ---------------------------------------------------------------------------
// period
// ---------------------------------------------------------------------------

test("period: 2024년 1분기 -> Q1 range (no qualifier needed, Q1 is unambiguous)", () => {
  const r = extractQuestionConditions({ questionText: "2024년 1분기 매출액은?" });
  assert.deepEqual(r.period, { fiscal_year: 2024, start_month: 1, end_month: 3 });
});

test("period: 2024년 4분기 without a qualifier -> null (genuinely ambiguous, matches evidence-side rule)", () => {
  const r = extractQuestionConditions({ questionText: "2024년 4분기 매출액은?" });
  assert.equal(r.period, null);
});

test("period: 2024년 4분기 3개월 -> resolves to months 10-12", () => {
  const r = extractQuestionConditions({ questionText: "2024년 4분기 3개월 매출액은?" });
  assert.deepEqual(r.period, { fiscal_year: 2024, start_month: 10, end_month: 12 });
});

test("period: two distinct fiscal years mentioned -> null (cannot reduce to one required period)", () => {
  const r = extractQuestionConditions({ questionText: "2023년 사업연도와 2024년 사업연도의 매출액을 비교하면?" });
  assert.equal(r.period, null);
});

test("period: Korean A-와(과)-B comparison phrasing across two years -> null, never binds only to the later year", () => {
  const r = extractQuestionConditions({ questionText: "두산로보틱스의 매출액은(는) 2023년와(과) 2025년 사이(같은 연간(사업보고서) 기준)에 얼마나 증가했는가?" });
  assert.equal(r.period, null);
});

test("period: no period phrase -> null", () => {
  const r = extractQuestionConditions({ questionText: "삼성전자의 매출액은?" });
  assert.equal(r.period, null);
});

// ---------------------------------------------------------------------------
// unit -- explicit only.
// ---------------------------------------------------------------------------

test("unit: explicit parenthetical unit -> extracted", () => {
  const r = extractQuestionConditions({ questionText: "같은 단위(백만원)로 환산하여 비교하면?" });
  assert.deepEqual(r.unit, { required_unit: "백만원", required_sign: null });
});

test("unit: a currency word with no explicit unit marker is NOT extracted (avoids false positives)", () => {
  const r = extractQuestionConditions({ questionText: "매출액 1000억원 증가에 대해 설명하라" });
  assert.equal(r.unit, null);
});

// ---------------------------------------------------------------------------
// row_column -- conservative canonical-role matches only.
// ---------------------------------------------------------------------------

test("row_column: 정정 후 -> required_column_label 정정후", () => {
  const r = extractQuestionConditions({ questionText: "정정 후 매출액은 얼마인가?" });
  assert.equal(r.row_column.required_column_label, "정정후");
});

test("row_column: 직전 보고서 -> required_column_label 직전", () => {
  const r = extractQuestionConditions({ questionText: "직전 보고서 대비 이번 보고서의 보유주식수 변동은?" });
  assert.equal(r.row_column.required_column_label, "직전");
});

test("row_column: no role phrase -> null", () => {
  const r = extractQuestionConditions({ questionText: "삼성전자의 매출액은?" });
  assert.equal(r.row_column, null);
});

// ---------------------------------------------------------------------------
// entity -- reuses existing CompanyResolver output only.
// ---------------------------------------------------------------------------

test("entity: single resolved corp -> used", () => {
  const r = extractQuestionConditions({ questionText: "아무 질문", officialConditions: { corps: ["아모레퍼시픽"] } });
  assert.equal(r.entity, "아모레퍼시픽");
});

test("entity: two resolved corps -> null (cannot reduce to one required entity)", () => {
  const r = extractQuestionConditions({ questionText: "아무 질문", officialConditions: { corps: ["두산로보틱스", "레인보우로보틱스"] } });
  assert.equal(r.entity, null);
});

test("entity: no officialConditions supplied -> null", () => {
  const r = extractQuestionConditions({ questionText: "아무 질문" });
  assert.equal(r.entity, null);
});

// ---------------------------------------------------------------------------
// Gold-blindness: no Gold-shaped identifier anywhere in the module source.
// ---------------------------------------------------------------------------

test("module source's executable code never references Gold/acceptable_sources/evidence-span/scoring-result/critical-packet-ID fields (comments may name them to document their absence)", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(codeOnly, /acceptable_sources|gold_answer|gold_evidence|gold_locator|critical_packet|scoring_result/i);
});

test("throws on missing questionText rather than silently defaulting", () => {
  assert.throws(() => extractQuestionConditions({}), TypeError);
});
