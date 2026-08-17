// Turn M10: Owner review found that individually-correct
// investment-amount/investment-purpose/investment-target-asset Facts were
// rendered in whatever order the request happened to load them, which
// reads as if two separate investment items had cross-attributed
// purposes/targets. The fix groups this SPECIFIC, closed metric_code
// triad (INVESTMENT_AMOUNT / INVESTMENT_PURPOSE / INVESTMENT_TARGET_ASSET
// -- all three already part of the approved ontology vocabulary, see
// domain/adapters/information-limit-vocabulary.mjs) by (corp_code,
// source_document_id) -- an EXPLICIT per-item grouping key each real
// disclosure item already carries, never a heuristic inferred from
// question text or slot naming. When no safe, unambiguous group key
// exists (e.g. two amounts sharing one document_id with no way to tell
// which purpose/target pairs with which), grouping is refused rather than
// guessed -- the composer instead reports a PLAN_AUTHORING_REVIEW_REQUIRED
// composition_warning and falls back to the pre-existing per-fact
// rendering for the ambiguous item family only, never dropping data.
//
// Explicit anti-overfitting guard: per the user's own instruction, this
// grouping NEVER treats a shared source_document_id alone as a universal
// "same item" signal outside this one closed metric_code triad -- see the
// negative fixture below proving an UNRELATED metric_code family sharing
// a document_id is never grouped.
import assert from "node:assert/strict";
import test from "node:test";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "TEST_METRIC",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    source_document_id: "doc_default", raw_label: "테스트 지표", attributes: {}, ...overrides,
  };
}
function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, calculationRegistry = [], slots = [], companyLabels = null }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, calculationRegistry, companyLabels, slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { composed, validation };
}

function investmentGroupFacts({ suffix, corpCode, documentId, amount, purpose, target }) {
  return [
    fact({ fact_id: `fact_amount_${suffix}`, corp_code: corpCode, source_document_id: documentId, metric_code: "INVESTMENT_AMOUNT", normalized_value: amount, raw_label: "투자금액(원)" }),
    fact({ fact_id: `fact_purpose_${suffix}`, corp_code: corpCode, source_document_id: documentId, metric_code: "INVESTMENT_PURPOSE", normalized_value: purpose, raw_label: "투자목적" }),
    fact({ fact_id: `fact_target_${suffix}`, corp_code: corpCode, source_document_id: documentId, metric_code: "INVESTMENT_TARGET_ASSET", normalized_value: target, raw_label: "투자대상" }),
  ];
}

test("Turn M10: two investment disclosure groups from DIFFERENT source_document_id never cross-attribute purpose/target/amount", () => {
  const groupA = investmentGroupFacts({ suffix: "a", corpCode: "00000001", documentId: "doc_alpha", amount: 111, purpose: "합성목적가", target: "합성대상가" });
  const groupB = investmentGroupFacts({ suffix: "b", corpCode: "00000001", documentId: "doc_beta", amount: 222, purpose: "합성목적나", target: "합성대상나" });
  const { composed, validation } = pipeline({ facts: [...groupA, ...groupB] });
  assert.notEqual(validation.status, "FAIL_CLOSED");
  // amount 111 must appear on the SAME line/sentence as its own group's purpose+target, never group B's
  const lines = composed.answer.split("\n");
  const line111 = lines.find((l) => l.includes("111"));
  const line222 = lines.find((l) => l.includes("222"));
  assert.ok(line111 && line111.includes("합성목적가") && line111.includes("합성대상가"));
  assert.ok(line111 && !line111.includes("합성목적나") && !line111.includes("합성대상나"));
  assert.ok(line222 && line222.includes("합성목적나") && line222.includes("합성대상나"));
  assert.ok(line222 && !line222.includes("합성목적가") && !line222.includes("합성대상가"));
});

test("Turn M10: shuffling the input Fact array order produces the IDENTICAL grouped answer (group provenance, never array-position dependent)", () => {
  const groupA = investmentGroupFacts({ suffix: "a", corpCode: "00000001", documentId: "doc_alpha", amount: 111, purpose: "합성목적가", target: "합성대상가" });
  const groupB = investmentGroupFacts({ suffix: "b", corpCode: "00000001", documentId: "doc_beta", amount: 222, purpose: "합성목적나", target: "합성대상나" });
  const inOrder = pipeline({ facts: [...groupA, ...groupB] }).composed.answer;
  const shuffled = pipeline({ facts: [groupB[1], groupA[2], groupB[0], groupA[0], groupB[2], groupA[1]] }).composed.answer;
  assert.equal(shuffled, inOrder);
});

test("Turn M10: a genuinely different company's investment group (different corp_code) is never merged with another company's group even if a document_id happened to collide", () => {
  const groupA = investmentGroupFacts({ suffix: "a", corpCode: "00000001", documentId: "doc_shared", amount: 111, purpose: "합성목적가", target: "합성대상가" });
  const groupB = investmentGroupFacts({ suffix: "b", corpCode: "00000002", documentId: "doc_shared", amount: 222, purpose: "합성목적나", target: "합성대상나" });
  const { composed } = pipeline({ facts: [...groupA, ...groupB] });
  const lines = composed.answer.split("\n");
  const line111 = lines.find((l) => l.includes("111"));
  assert.ok(line111 && !line111.includes("합성목적나"));
});

test("Turn M10 counterexample: an UNRELATED metric_code family sharing the SAME source_document_id is never grouped by this rule (source_document_id alone is not a universal same-item signal)", () => {
  const unrelated = [
    fact({ fact_id: "fact_unrelated_1", corp_code: "00000003", source_document_id: "doc_gamma", metric_code: "TRUST_CONTRACT_INSTITUTION", normalized_value: "합성기관", raw_label: "계약체결기관" }),
    fact({ fact_id: "fact_unrelated_2", corp_code: "00000003", source_document_id: "doc_gamma", metric_code: "ACQUISITION_PLANNED_SHARES", normalized_value: 999, unit: "SHARES", raw_label: "취득예정주식(주)" }),
  ];
  const { composed } = pipeline({ facts: unrelated });
  // rendered exactly as ordinary independent Fact lines -- no investment-
  // group combining/reordering ever applied to a non-triad metric_code
  // pairing, regardless of shared document_id.
  assert.match(composed.answer, /계약체결기관: 합성기관/);
  assert.match(composed.answer, /취득예정주식\(주\): 999 주/);
});

test("Turn M10: an AMBIGUOUS investment group (two amounts sharing one document_id, only one purpose/target) is refused (no guessed pairing) and reported as PLAN_AUTHORING_REVIEW_REQUIRED", () => {
  const ambiguous = [
    fact({ fact_id: "fact_amount_x", corp_code: "00000004", source_document_id: "doc_delta", metric_code: "INVESTMENT_AMOUNT", normalized_value: 111, raw_label: "투자금액(원)" }),
    fact({ fact_id: "fact_amount_y", corp_code: "00000004", source_document_id: "doc_delta", metric_code: "INVESTMENT_AMOUNT", normalized_value: 222, raw_label: "투자금액(원)" }),
    fact({ fact_id: "fact_purpose_x", corp_code: "00000004", source_document_id: "doc_delta", metric_code: "INVESTMENT_PURPOSE", normalized_value: "합성목적", raw_label: "투자목적" }),
  ];
  const { composed } = pipeline({ facts: ambiguous });
  const warning = composed.composition_warnings.find((w) => w.type === "PLAN_AUTHORING_REVIEW_REQUIRED");
  assert.ok(warning, "expected a PLAN_AUTHORING_REVIEW_REQUIRED composition warning for the ambiguous group");
  // both amounts must still be honestly rendered (never dropped, never a
  // guessed pairing) via the ordinary per-fact fallback.
  assert.match(composed.answer, /111/);
  assert.match(composed.answer, /222/);
});

test("Turn M10.1: a lone INVESTMENT_AMOUNT stays on the ordinary Fact rendering path", () => {
  const loneAmount = fact({
    fact_id: "fact_lone_amount",
    corp_code: "00000005",
    source_document_id: "doc_lone",
    metric_code: "INVESTMENT_AMOUNT",
    normalized_value: 333,
    raw_label: "투자금액(원)",
  });
  const companyLabels = { "00000005": { corp_name: "합성기업마" } };
  const { composed } = pipeline({ facts: [loneAmount], companyLabels });
  assert.match(composed.answer, /- 투자금액\(원\): 333 원 \(공시일: 2025-01-01\)/);
  assert.equal(composed.answer.includes("[합성기업마 /"), false, "single Facts must not be rewritten by the investment-group renderer");
  assert.equal(composed.composition_warnings.some((warning) => warning.type === "PLAN_AUTHORING_REVIEW_REQUIRED"), false);
});
