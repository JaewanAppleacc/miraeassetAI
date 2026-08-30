import assert from "node:assert/strict";
import test from "node:test";
import { extractHardClaims, verifyHardClaims, verifyCitationBinding, verifyGeneratedAnswer } from "../domain/agent-comparison/flows/hard-claim-grounding.mjs";

const GROUNDED_FACTS = [
  {
    fact: {
      fact_id: "fact_000000000000000000000001",
      source_document_id: "periodic_00000000000001",
      raw_value_text: "1,000,000,000",
      normalized_value: 1_000_000_000,
      period_start: "2025-01-01",
      period_end: "2025-12-31",
      known_at: "2026-01-01T00:00:00.000Z",
      valid_from: "2025-01-01",
      valid_to: null,
      as_of_date: "2025-12-31",
    },
    quotes: ["매출액은 1,000,000,000원입니다."],
    evidenceIds: ["evidence_000000000000000000000001"],
  },
];

test("extractHardClaims finds comma-grouped numbers, decimals, dates, and document ids without double-counting", () => {
  const claims = extractHardClaims("2026-01-01 기준 매출액은 1,000,000,000원이며 증가율은 41.25%, 문서는 periodic_00000000000001 입니다.");
  assert.deepEqual([...claims.numbers], ["1000000000", "41.25"]);
  assert.deepEqual([...claims.dates], ["20260101"]);
  assert.deepEqual([...claims.documentIds], ["periodic_00000000000001"]);
});

test("extractHardClaims parses Korean-style dates (year/month/day) the same as ISO dates", () => {
  const claims = extractHardClaims("이 사실은 2026년 1월 1일에 공시되었습니다.");
  assert.deepEqual([...claims.dates], ["202611"]);
});

test("verifyHardClaims passes when every extracted number/date/document id appears in the grounded source data", () => {
  const result = verifyHardClaims("매출액은 1,000,000,000원입니다.", GROUNDED_FACTS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.unsupportedClaims, []);
});

test("verifyHardClaims rejects an invented number not present anywhere in the grounded Fact/Evidence data", () => {
  const result = verifyHardClaims("매출액은 9,999,999,999원입니다.", GROUNDED_FACTS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unsupportedClaims, [{ type: "number", value: "9999999999" }]);
});

test("verifyHardClaims rejects an invented date not present anywhere in the grounded Fact/Evidence data", () => {
  const result = verifyHardClaims("이 값은 2031-06-30 기준입니다.", GROUNDED_FACTS);
  assert.equal(result.ok, false);
  assert.equal(result.unsupportedClaims.some((c) => c.type === "date" && c.value === "20310630"), true);
});

test("verifyHardClaims rejects a document id not present in the grounded Fact/Evidence data", () => {
  const result = verifyHardClaims("근거 문서는 periodic_99999999999999 입니다.", GROUNDED_FACTS);
  assert.equal(result.ok, false);
  assert.equal(result.unsupportedClaims.some((c) => c.type === "document_id" && c.value === "periodic_99999999999999"), true);
});

test("verifyHardClaims: a corp_code-shaped 8-digit number belonging to a DIFFERENT (unauthorized) company is rejected as an unsupported number claim -- this codebase's own identity scheme is corp_code, not a name string (domain/README.md)", () => {
  const result = verifyHardClaims("관련 기업 코드는 00000099 입니다.", GROUNDED_FACTS);
  assert.equal(result.ok, false);
  assert.equal(result.unsupportedClaims.some((c) => c.type === "number" && c.value === "00000099"), true);
});

test("verifyCitationBinding accepts ids that are subsets of the authorized/validated sets", () => {
  const result = verifyCitationBinding({
    usedFactIds: ["fact_000000000000000000000001"],
    usedEvidenceIds: ["evidence_000000000000000000000001"],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
  });
  assert.equal(result.ok, true);
});

test("verifyCitationBinding rejects a fact_id outside the authorized set", () => {
  const result = verifyCitationBinding({
    usedFactIds: ["fact_000000000000000000000002"],
    usedEvidenceIds: [],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNAUTHORIZED_FACT_ID");
});

test("verifyCitationBinding rejects an evidence_id outside the validated set", () => {
  const result = verifyCitationBinding({
    usedFactIds: ["fact_000000000000000000000001"],
    usedEvidenceIds: ["evidence_000000000000000000000002"],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNVALIDATED_EVIDENCE_ID");
});

test("verifyGeneratedAnswer: a fully grounded generated answer with authorized citations PASSES", () => {
  const verdict = verifyGeneratedAnswer({
    text: "매출액은 1,000,000,000원입니다.",
    usedFactIds: ["fact_000000000000000000000001"],
    usedEvidenceIds: ["evidence_000000000000000000000001"],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
    groundedFacts: GROUNDED_FACTS,
  });
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.unsupportedClaimCount, 0);
});

test("verifyGeneratedAnswer: an unauthorized citation FAILS even when the answer text itself contains no unsupported hard claims", () => {
  const verdict = verifyGeneratedAnswer({
    text: "매출액은 1,000,000,000원입니다.",
    usedFactIds: ["fact_000000000000000000000099"],
    usedEvidenceIds: [],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
    groundedFacts: GROUNDED_FACTS,
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "UNAUTHORIZED_FACT_ID");
});

test("verifyGeneratedAnswer: an unsupported hard claim FAILS even when citations are authorized", () => {
  const verdict = verifyGeneratedAnswer({
    text: "매출액은 9,999,999,999원입니다.",
    usedFactIds: ["fact_000000000000000000000001"],
    usedEvidenceIds: ["evidence_000000000000000000000001"],
    authorizedFactIds: new Set(["fact_000000000000000000000001"]),
    validatedEvidenceIds: new Set(["evidence_000000000000000000000001"]),
    groundedFacts: GROUNDED_FACTS,
  });
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.reason, "UNSUPPORTED_HARD_CLAIM");
  assert.equal(verdict.unsupportedClaimCount, 1);
});
