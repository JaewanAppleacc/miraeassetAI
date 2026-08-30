// Turn P6 section C/F: the 8 Grading Scorers, unit-tested directly against
// constructed inputs (never against real Gold/HOLDOUT data). Several axes
// (event/relation direction, cross-company attribution) need structured
// "actual" detail the four Agent variants' CURRENT retrieved_context does
// not yet expose post-hoc (see scorers/event-relation.mjs's own header
// comment) -- those are exercised here directly against the scorer
// function, exactly how a future variant enhancement that starts
// populating that detail would be validated too.
import assert from "node:assert/strict";
import test from "node:test";
import { scoreAnswerability } from "../domain/agent-comparison/benchmark/scorers/answerability.mjs";
import { scoreNumericClaim } from "../domain/agent-comparison/benchmark/scorers/numeric-claim.mjs";
import { scoreDateClaim } from "../domain/agent-comparison/benchmark/scorers/date-claim.mjs";
import { scoreFactCoverage } from "../domain/agent-comparison/benchmark/scorers/fact-coverage.mjs";
import { scoreEventRelation } from "../domain/agent-comparison/benchmark/scorers/event-relation.mjs";
import { scoreCitation } from "../domain/agent-comparison/benchmark/scorers/citation.mjs";
import { scoreStyle } from "../domain/agent-comparison/benchmark/scorers/style.mjs";
import { scoreItem } from "../domain/agent-comparison/benchmark/scorers/index.mjs";
import { validateScoringPolicy } from "../domain/agent-comparison/benchmark/contracts.mjs";
import { makeFixtureDatasetRecord, FIXTURE_FACT, FIXTURE_EVIDENCE } from "./lib/agent-comparison-benchmark-infra-fixture.mjs";

// --- Answerability -----------------------------------------------------

test("Answerability Scorer: PASS when actual matches expected", () => {
  const result = scoreAnswerability({ expectedAnswerability: "SUPPORTED", actualValidationStatus: "SUPPORTED" });
  assert.equal(result.status, "PASS");
});

// Test 10: hallucination on an information-limit-correct item is penalized.
test("Answerability Scorer: a hallucinated specific answer on an UNANSWERABLE-expected item FAILs with HALLUCINATED_ANSWER_ON_UNANSWERABLE_ITEM", () => {
  const result = scoreAnswerability({ expectedAnswerability: "UNANSWERABLE", actualValidationStatus: "SUPPORTED" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("HALLUCINATED_ANSWER_ON_UNANSWERABLE_ITEM"));
});

test("Answerability Scorer: correctly declining an UNANSWERABLE item PASSes", () => {
  const result = scoreAnswerability({ expectedAnswerability: "UNANSWERABLE", actualValidationStatus: "UNANSWERABLE" });
  assert.equal(result.status, "PASS");
});

// --- Numeric Claim (test 5) ---------------------------------------------

test("Numeric Claim Scorer: correct value AND unit PASSes", () => {
  const result = scoreNumericClaim({
    expectedNumericClaims: [{ value: 1000000000, unit: "KRW", unit_conversion_allowed: false, role: "revenue_amount" }],
    answerText: "매출액은 1,000,000,000원입니다.",
  });
  assert.equal(result.status, "PASS");
});

test("Numeric Claim Scorer: correct value but WRONG unit is rejected (UNIT_MISMATCH), not silently accepted", () => {
  const result = scoreNumericClaim({
    expectedNumericClaims: [{ value: 1000000000, unit: "KRW", unit_conversion_allowed: false, role: "revenue_amount" }],
    answerText: "매출액은 1,000,000,000주입니다.", // same number, unit token is SHARES ("주") not KRW ("원")
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("UNIT_MISMATCH"));
});

test("Numeric Claim Scorer: missing value entirely is MISSING_NUMERIC_CLAIM, distinct from UNIT_MISMATCH", () => {
  const result = scoreNumericClaim({
    expectedNumericClaims: [{ value: 1000000000, unit: "KRW", unit_conversion_allowed: false, role: "revenue_amount" }],
    answerText: "관련 정보가 없습니다.",
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("MISSING_NUMERIC_CLAIM"));
});

test("Numeric Claim Scorer: an unlisted/ad-hoc unit conversion is never accepted, even when unit_conversion_allowed=true", () => {
  const result = scoreNumericClaim({
    expectedNumericClaims: [{ value: 1000000000, unit: "KRW", unit_conversion_allowed: true, role: "revenue_amount" }],
    answerText: "매출액은 1,000,000천원입니다.", // a derived thousand-won figure the policy never listed
    numericUnitConversions: [], // policy lists NO conversions at all
  });
  assert.equal(result.status, "FAIL");
});

test("Numeric Claim Scorer: a ScoringPolicy-listed conversion IS accepted when unit_conversion_allowed=true", () => {
  const result = scoreNumericClaim({
    expectedNumericClaims: [{ value: 1000000000, unit: "KRW", unit_conversion_allowed: true, role: "revenue_amount" }],
    answerText: "매출액은 1,000,000천원입니다.",
    numericUnitConversions: [{ from_unit: "THOUSAND_KRW", to_unit: "KRW", multiplier: 1000 }],
  });
  assert.equal(result.status, "PASS");
});

// --- Date Claim (test 6) -------------------------------------------------

test("Date Claim Scorer: correct date value with the correct role label nearby PASSes", () => {
  const result = scoreDateClaim({
    expectedDateClaims: [{ date: "2024-03-19", date_role: "CORRECTION_DATE" }],
    answerText: "정정일은 2024-03-19입니다.",
  });
  assert.equal(result.status, "PASS");
});

test("Date Claim Scorer: correct date value but the WRONG role label nearby FAILs with DATE_ROLE_MISMATCH", () => {
  const result = scoreDateClaim({
    expectedDateClaims: [{ date: "2024-03-19", date_role: "CORRECTION_DATE" }],
    answerText: "결정일은 2024-03-19입니다.", // same date, but labeled as DECISION_DATE, not CORRECTION_DATE
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("DATE_ROLE_MISMATCH"));
});

test("Date Claim Scorer: a missing date value is MISSING_DATE_CLAIM", () => {
  const result = scoreDateClaim({
    expectedDateClaims: [{ date: "2024-03-19", date_role: "CORRECTION_DATE" }],
    answerText: "관련 날짜 정보가 없습니다.",
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("MISSING_DATE_CLAIM"));
});

// --- Event/Relation (tests 7, 8) ------------------------------------------

test("Event/Relation Scorer: a relation whose source/target are REVERSED relative to the expected one is rejected (RELATION_DIRECTION_REVERSED)", () => {
  const expectedRelations = [{
    relation_id: "relation_test_0001", relation_type: "AMENDS",
    source_document_id: "periodic_00000000000010", target_document_id: "periodic_00000000000001",
    source_corp_code: "00000001", target_corp_code: "00000001",
  }];
  const actualRelations = [{
    relation_id: "relation_test_0001", relation_type: "AMENDS",
    source_document_id: "periodic_00000000000001", target_document_id: "periodic_00000000000010", // swapped
    source_corp_code: "00000001", target_corp_code: "00000001",
  }];
  const result = scoreEventRelation({ expectedEvents: [], expectedRelations, actualEventIds: [], actualRelations });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("RELATION_DIRECTION_REVERSED"));
});

test("Event/Relation Scorer: a relation whose corp_code belongs to a DIFFERENT company than expected is rejected (CROSS_COMPANY_ATTRIBUTION)", () => {
  const expectedRelations = [{
    relation_id: "relation_test_0002", relation_type: "AMENDS",
    source_document_id: "periodic_00000000000010", target_document_id: "periodic_00000000000001",
    source_corp_code: "00000001", target_corp_code: "00000001",
  }];
  const actualRelations = [{
    relation_id: "relation_test_0002", relation_type: "AMENDS",
    source_document_id: "periodic_00000000000010", target_document_id: "periodic_00000000000001",
    source_corp_code: "00000001", target_corp_code: "00000099", // a different company on the target side
  }];
  const result = scoreEventRelation({ expectedEvents: [], expectedRelations, actualEventIds: [], actualRelations });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("CROSS_COMPANY_ATTRIBUTION"));
});

test("Event/Relation Scorer: a correctly-directed, same-company relation PASSes", () => {
  const expectedRelations = [{
    relation_id: "relation_test_0003", relation_type: "AMENDS",
    source_document_id: "periodic_00000000000010", target_document_id: "periodic_00000000000001",
    source_corp_code: "00000001", target_corp_code: "00000001",
  }];
  const result = scoreEventRelation({ expectedEvents: [], expectedRelations, actualEventIds: [], actualRelations: expectedRelations });
  assert.equal(result.status, "PASS");
});

test("Event/Relation Scorer: event ordering out of sequence is EVENT_ORDER_MISMATCH", () => {
  const expectedEvents = [{ event_id: "event_a", event_type: "T1", order_index: 0 }, { event_id: "event_b", event_type: "T2", order_index: 1 }];
  const result = scoreEventRelation({ expectedEvents, expectedRelations: [], actualEventIds: ["event_b", "event_a"], actualRelations: [] });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("EVENT_ORDER_MISMATCH"));
});

test("Event/Relation Scorer: NOT_APPLICABLE when the item has no expected_events/expected_relations at all", () => {
  const result = scoreEventRelation({ expectedEvents: [], expectedRelations: [], actualEventIds: [], actualRelations: [] });
  assert.equal(result.status, "NOT_APPLICABLE");
});

// --- Citation (test 9) -----------------------------------------------------

test("Citation Scorer: an evidence_id outside allowed_evidence_ids is rejected (UNAUTHORIZED_EVIDENCE_ID), even if it happened to structurally validate", () => {
  const result = scoreCitation({
    allowedEvidenceIds: ["evidence_000000000000000000000001"],
    selectedEvidenceIds: ["evidence_000000000000000000000099"],
    citationBindingStatus: "PASS",
    unsupportedClaimCount: 0,
    evidenceValidationSuccessRate: 1,
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("UNAUTHORIZED_EVIDENCE_ID"));
});

test("Citation Scorer: PASS when every selected evidence_id is within the allowed set and citation_binding_status is PASS", () => {
  const result = scoreCitation({
    allowedEvidenceIds: ["evidence_000000000000000000000001"],
    selectedEvidenceIds: ["evidence_000000000000000000000001"],
    citationBindingStatus: "PASS",
    unsupportedClaimCount: 0,
    evidenceValidationSuccessRate: 1,
  });
  assert.equal(result.status, "PASS");
});

test("Citation Scorer: never reads a retrieval/vector-similarity score as evidence of a correct citation -- the function signature has no such input at all", () => {
  assert.equal(scoreCitation.length <= 1, true); // single options-object arg; no score/similarity parameter exists to accidentally read
  const result = scoreCitation({
    allowedEvidenceIds: ["evidence_000000000000000000000001"],
    selectedEvidenceIds: ["evidence_000000000000000000000001"],
    citationBindingStatus: "PASS",
    unsupportedClaimCount: 0,
    evidenceValidationSuccessRate: 1,
    retrieval_score_hint: 0.99, // even if a caller mistakenly passes this, it must have zero effect
  });
  assert.equal(result.status, "PASS");
});

// --- Fact Coverage -----------------------------------------------------

test("Fact Coverage Scorer: an unauthorized (unexpected) fact_id added to the answer is flagged", () => {
  const result = scoreFactCoverage({
    expectedFacts: [{ fact_id: FIXTURE_FACT.fact_id, semantic_slot: null, corp_code: FIXTURE_FACT.corp_code, metric_code: FIXTURE_FACT.metric_code, required: true }],
    actualFactIds: [FIXTURE_FACT.fact_id, "fact_000000000000000000000099"],
  });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("UNAUTHORIZED_FACT_ADDED"));
  assert.deepEqual(result.details.unauthorized_fact_ids, ["fact_000000000000000000000099"]);
});

test("Fact Coverage Scorer: full coverage with no extras PASSes", () => {
  const result = scoreFactCoverage({
    expectedFacts: [{ fact_id: FIXTURE_FACT.fact_id, semantic_slot: null, corp_code: FIXTURE_FACT.corp_code, metric_code: FIXTURE_FACT.metric_code, required: true }],
    actualFactIds: [FIXTURE_FACT.fact_id],
  });
  assert.equal(result.status, "PASS");
});

// --- Style/Contract -------------------------------------------------------

test("Style Scorer: a leaked internal enum/snake_case token is flagged", () => {
  const result = scoreStyle({ answerText: "scope=CONSOLIDATED, value_status=DISCLOSED 매출액은 1,000,000,000원입니다.", allowedCorpCodes: ["00000001"] });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("INTERNAL_TOKEN_LEAKED"));
});

test("Style Scorer: a corp_code not in the allowed set is flagged (CORP_CODE_EXPOSED)", () => {
  const result = scoreStyle({ answerText: "매출액은 1,000,000,000원입니다 (관련 기업 코드 00000099).", allowedCorpCodes: ["00000001"] });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("CORP_CODE_EXPOSED"));
});

test("Style Scorer: a repeated sentence is flagged", () => {
  const sentence = "매출액은 1,000,000,000원으로 집계되었습니다.";
  const result = scoreStyle({ answerText: `${sentence} ${sentence}`, allowedCorpCodes: [] });
  assert.equal(result.status, "FAIL");
  assert.ok(result.error_codes.includes("REPEATED_SENTENCE"));
});

test("Style Scorer: clean text PASSes", () => {
  const result = scoreStyle({ answerText: "매출액은 1,000,000,000원입니다.", allowedCorpCodes: ["00000001"] });
  assert.equal(result.status, "PASS");
});

// --- scoreItem orchestration: SKIPPED / composite_score gating -----------

test("scoreItem: scoringEligible=false SKIPs every one of the 8 axes and composite_score stays null", () => {
  const scoring = scoreItem({ datasetRecord: makeFixtureDatasetRecord(), scoringEligible: false, answerText: "무관한 답변" });
  for (const axis of Object.keys(scoring.axes)) {
    assert.equal(scoring.axes[axis].status, "SKIPPED");
    assert.equal(scoring.axes[axis].raw_score, null);
  }
  assert.equal(scoring.composite_score, null);
});

test("scoreItem: composite_score stays null with no ScoringPolicy, even for a fully-eligible, fully-PASSing item", () => {
  const item = makeFixtureDatasetRecord();
  const scoring = scoreItem({
    datasetRecord: item,
    scoringEligible: true,
    answerText: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    retrievedContext: [{ fact_id: FIXTURE_FACT.fact_id, quotes: [FIXTURE_EVIDENCE.quoted_text] }],
    selectedEvidenceIds: [FIXTURE_EVIDENCE.evidence_id],
    citationBindingStatus: "PASS",
    unsupportedClaimCount: 0,
    evidenceValidationSuccessRate: 1,
    validationStatus: "SUPPORTED",
    operationalTelemetry: { latencyMs: 1, structuredQueryCount: 1, modelFallbackUsed: false, scoringEligible: true },
  });
  assert.equal(scoring.composite_score, null);
  assert.equal(scoring.axes.numeric_claim.status, "PASS");
  assert.equal(scoring.axes.citation.status, "PASS");
});

test("scoreItem: an explicit ScoringPolicy IS applied to compute a composite_score", () => {
  const policy = {
    schema_version: "0.1.0", scoring_policy_id: "scoring_policy_test", scoring_policy_version: "test-v1",
    numeric_unit_conversions: [], axis_weights: { answerability: 1, numeric_claim: 1, date_claim: 1, fact_coverage: 1, event_relation: 1, citation: 1, style: 1, operational: 1 },
    composite_score_formula_version: "weighted_mean_v1",
  };
  assert.deepEqual(validateScoringPolicy(policy), []);
  const item = makeFixtureDatasetRecord();
  const scoring = scoreItem({
    datasetRecord: item,
    scoringEligible: true,
    answerText: `매출액은 ${FIXTURE_FACT.normalized_value}원입니다.`,
    retrievedContext: [{ fact_id: FIXTURE_FACT.fact_id, quotes: [FIXTURE_EVIDENCE.quoted_text] }],
    selectedEvidenceIds: [FIXTURE_EVIDENCE.evidence_id],
    citationBindingStatus: "PASS",
    unsupportedClaimCount: 0,
    evidenceValidationSuccessRate: 1,
    validationStatus: "SUPPORTED",
    operationalTelemetry: { latencyMs: 1, structuredQueryCount: 1, modelFallbackUsed: false, scoringEligible: true },
    scoringPolicy: policy,
  });
  assert.equal(scoring.scoring_policy_version, "test-v1");
  assert.equal(typeof scoring.composite_score, "number");
  assert.equal(scoring.composite_score, 1); // every scored axis PASSed (1.0); NOT_APPLICABLE axes are excluded from the weighted mean
});
