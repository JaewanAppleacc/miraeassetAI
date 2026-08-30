// Turn N4.5.1: pure-logic tests for domain/evaluation/relation-closure-documentir-risk.mjs.
// Fictional field values only -- never a real document id, company name,
// or amount from the real corpus (self-checked below).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateRowAgainstDocumentIr, RISK_STRENGTHS } from "../domain/evaluation/relation-closure-documentir-risk.mjs";
import { indexFieldsByCategory, indexSourceBeforeByCategory } from "../domain/evaluation/document-ir-field-extraction.mjs";

function candidate(id, receiptDate, isCorrection = false) {
  return { target_document_id: id, target_receipt_date: receiptDate, target_info: { is_correction: isCorrection } };
}

test("qualifies: date-linked candidate + real continuity signal -> HIGH only when identity ALSO present, else MEDIUM", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]);
  const sourceCurrent = indexFieldsByCategory([]);
  const candA = candidate("cand_a", "2020-05-01");
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" }]) }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: sourceBefore,
    sourceCurrentByCategory: sourceCurrent,
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.risk_strength, RISK_STRENGTHS.MEDIUM); // continuity present, no identity signal here
  assert.equal(result.candidate_evaluations.length, 1);
  assert.equal(result.candidate_evaluations[0].date_linked, true);
});

test("qualifies HIGH: date-linked + continuity + identity all present together", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]);
  const sourceCurrent = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "테스트계약", locator: "src#n3a" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "src#n3b" },
  ]);
  const candA = candidate("cand_a", "2020-05-01");
  const candidateFields = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" },
    { kind: "plain_value", fieldLabel: "체결계약명", value: "테스트계약", locator: "cand_a#n3a" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "cand_a#n3b" },
  ]);
  const analysis = new Map([["cand_a", { currentByCategory: candidateFields }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: sourceBefore,
    sourceCurrentByCategory: sourceCurrent,
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.risk_strength, RISK_STRENGTHS.HIGH);
});

test("counterexample: TARGET_NOT_IN_CORPUS-style absence of any date link or correction flag never qualifies, even with a real continuity VALUE match", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]);
  const candA = candidate("cand_a", "1999-01-01"); // does NOT match any related-disclosure date, not flagged is_correction
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" }]) }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: sourceBefore,
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, false);
});

test("counterexample: date-linked candidate but NO real value continuity or identity signal never qualifies (a candidate merely existing is not enough)", () => {
  const candA = candidate("cand_a", "2020-05-01");
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([]) }]]); // no comparable fields at all
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: indexSourceBeforeByCategory([]),
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, false);
});

test("counterexample: same company/doc_subtype alone (via an is_correction=false candidate with no date link) never qualifies", () => {
  const candA = candidate("cand_a", null, false);
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" }]) }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [],
    sourceBeforeByCategory: indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]),
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, false);
});

test("an intermediate correction document already in the candidate list (is_correction=true) satisfies condition A even without a date match", () => {
  const candA = candidate("cand_a", "1999-01-01", true); // is_correction true, but its receipt date isn't in relatedDisclosureDates
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" }]) }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [], // no date link at all
    sourceBeforeByCategory: indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]),
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.candidate_evaluations[0].intermediate_correction_in_candidate_list, true);
  assert.equal(result.candidate_evaluations[0].date_linked, false);
});

test("a candidate whose own DocumentIR could not be loaded is reported in candidates_unavailable, never silently dropped or treated as qualifying", () => {
  const candA = candidate("cand_missing", "2020-05-01");
  const analysis = new Map(); // cand_missing not present at all -> undefined
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: indexSourceBeforeByCategory([]),
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, false);
  assert.deepEqual(result.candidates_unavailable, ["cand_missing"]);
});

test("risk detection never leads to an auto-CONFIRM or auto-REJECT -- qualifying result carries no disposition field at all, only evidence", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-01-01", locator: "src#n1" }]);
  const candA = candidate("cand_a", "2020-05-01");
  const analysis = new Map([["cand_a", { currentByCategory: indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand_a#n3" }]) }]]);
  const result = evaluateRowAgainstDocumentIr({
    row: { candidates: [candA] },
    sourceRelatedDisclosureDates: [{ date: "2020-05-01", reportNameGuess: null }],
    sourceBeforeByCategory: sourceBefore,
    sourceCurrentByCategory: indexFieldsByCategory([]),
    candidateAnalysisById: analysis,
  });
  assert.equal(result.qualifies, true);
  assert.ok(!("disposition" in result));
  assert.ok(!("confirmed_target_document_id" in result));
});

test("the implementation modules never hardcode a specific real document_id or company name in their detection logic", () => {
  const riskLogicSource = readFileSync(fileURLToPath(new URL("../domain/evaluation/relation-closure-documentir-risk.mjs", import.meta.url)), "utf8");
  const fieldExtractionSource = readFileSync(fileURLToPath(new URL("../domain/evaluation/document-ir-field-extraction.mjs", import.meta.url)), "utf8");
  for (const source of [riskLogicSource, fieldExtractionSource]) {
    assert.doesNotMatch(source, /periodic_202[3-6]\d{12}|exchange_202[3-6]\d{12}|major_202[3-6]\d{12}|holding_202[3-6]\d{12}/);
    assert.doesNotMatch(source, /두산에너빌리티|한국가스공사/);
  }
});
