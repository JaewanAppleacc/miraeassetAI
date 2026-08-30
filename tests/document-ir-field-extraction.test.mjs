// Turn N4.5.1: pure-logic tests for domain/evaluation/document-ir-field-extraction.mjs.
// Every field label used below is a GENERIC DART table-shape example
// (never a real document id, company name, or specific value copied from
// the real corpus) -- these tests exercise the structural parsing rules,
// not any one real disclosure.
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFieldLabel, extractTableFields, extractDocumentFields, parseRelatedDisclosuresText,
  classifyFieldCategory, indexFieldsByCategory, indexSourceBeforeByCategory, findContinuitySignals, findIdentitySignals,
} from "../domain/evaluation/document-ir-field-extraction.mjs";

test("normalizeFieldLabel strips leading numbering/bullets and collapses whitespace, without merging different text", () => {
  assert.equal(normalizeFieldLabel("5. 계약기간"), "계약기간");
  assert.equal(normalizeFieldLabel("- 체결계약명"), "체결계약명");
  assert.equal(normalizeFieldLabel("※ 관련공시"), "※관련공시");
  assert.equal(normalizeFieldLabel("계약금액"), "계약금액");
  assert.notEqual(normalizeFieldLabel("계약금액"), normalizeFieldLabel("기타자금"));
});

function tableNode(nodeId, rows) {
  return { kind: "table", node_id: nodeId, normalized_rows: rows };
}

test("extractTableFields: a (category,category,value) row collapses to one plain_value field", () => {
  const fields = extractTableFields(tableNode("doc::f.xml::n0", [["3. 계약상대", "3. 계약상대", "회사X"]]));
  assert.equal(fields.length, 1);
  assert.equal(fields[0].kind, "plain_value");
  assert.equal(fields[0].fieldLabel, "계약상대");
  assert.equal(fields[0].value, "회사X");
  assert.equal(fields[0].locator, "doc::f.xml::n0#row=0");
});

test("extractTableFields: a (category,subfield,value) row concatenates BOTH label parts", () => {
  const fields = extractTableFields(tableNode("doc::f.xml::n0", [["5. 계약기간", "종료일", "2099-01-01"]]));
  assert.equal(fields[0].fieldLabel, "계약기간종료일");
  assert.equal(fields[0].value, "2099-01-01");
});

test("extractTableFields: a 4-column row with (a,a,b,b) duplication collapses the same as (a,b)", () => {
  const fields = extractTableFields(tableNode("doc::f.xml::n0", [["1. 구분", "1. 구분", "유형A", "유형A"]]));
  assert.equal(fields.length, 1);
  assert.equal(fields[0].fieldLabel, "구분");
  assert.equal(fields[0].value, "유형A");
});

test("extractTableFields: rows AFTER the exact ['정정항목','정정전','정정후'] header become correction_pair (label, before, after)", () => {
  const fields = extractTableFields(tableNode("doc::f.xml::n1", [
    ["1. 정정관련 공시서류", "X", "X"],
    ["정정항목", "정정전", "정정후"],
    ["5. 계약기간종료일", "2099-01-01", "2100-01-01"],
  ]));
  const correctionRow = fields.find((f) => f.kind === "correction_pair");
  assert.ok(correctionRow);
  assert.equal(correctionRow.fieldLabel, "계약기간종료일");
  assert.equal(correctionRow.before, "2099-01-01");
  assert.equal(correctionRow.after, "2100-01-01");
  const preHeaderRow = fields.find((f) => f.kind === "plain_value" && f.fieldLabel === "정정관련공시서류");
  assert.ok(preHeaderRow);
});

test("extractTableFields: a row that collapses to length 1 or >=4 without full duplication is skipped, never guessed", () => {
  const fields = extractTableFields(tableNode("doc::f.xml::n0", [["only one cell"], ["a", "b", "c", "d"]]));
  assert.equal(fields.length, 0);
});

test("extractDocumentFields walks every table node in a document", () => {
  const doc = { nodes: [tableNode("doc::f.xml::n0", [["a", "a", "1"]]), tableNode("doc::f.xml::n1", [["b", "b", "2"]]), { kind: "paragraph", node_id: "doc::f.xml::n2" }] };
  const fields = extractDocumentFields(doc);
  assert.equal(fields.length, 2);
});

test("parseRelatedDisclosuresText splits a concatenated '※ 관련공시' cell into individual (date, reportNameGuess) entries", () => {
  const entries = parseRelatedDisclosuresText("2024-06-17 어떤계약체결2021-07-30 어떤계약체결");
  assert.deepEqual(entries, [
    { date: "2024-06-17", reportNameGuess: "어떤계약체결" },
    { date: "2021-07-30", reportNameGuess: "어떤계약체결" },
  ]);
});

test("parseRelatedDisclosuresText returns [] for a placeholder '-' or empty text", () => {
  assert.deepEqual(parseRelatedDisclosuresText("-"), []);
  assert.deepEqual(parseRelatedDisclosuresText(""), []);
  assert.deepEqual(parseRelatedDisclosuresText(null), []);
});

test("classifyFieldCategory: CONTRACT_AMOUNT never matches an unrelated '기타자금'-shaped label", () => {
  assert.equal(classifyFieldCategory("계약내역계약금액(원)"), "CONTRACT_AMOUNT");
  assert.equal(classifyFieldCategory("기타자금소요"), null);
});

test("classifyFieldCategory: CONTRACT_PERIOD_END requires the exact concatenated label, never a bare '종료일' or an unrelated '유보기한종료일'", () => {
  assert.equal(classifyFieldCategory("계약기간종료일"), "CONTRACT_PERIOD_END");
  assert.equal(classifyFieldCategory("종료일"), null);
  assert.equal(classifyFieldCategory("유보기한종료일"), null);
});

test("indexFieldsByCategory: a correction_pair's AFTER value wins over a plain_value for the same category", () => {
  const fields = [
    { kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "n0#row=0" },
    { kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-06-01", locator: "n1#row=5" },
  ];
  const byCategory = indexFieldsByCategory(fields);
  assert.equal(byCategory.get("CONTRACT_PERIOD_END").value, "2100-06-01");
});

test("indexSourceBeforeByCategory: only correction_pair rows contribute a 'before' value", () => {
  const fields = [
    { kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "n0#row=0" },
    { kind: "correction_pair", fieldLabel: "계약상대", before: "회사X", after: "회사Y", locator: "n1#row=1" },
  ];
  const byCategory = indexSourceBeforeByCategory(fields);
  assert.equal(byCategory.size, 1);
  assert.equal(byCategory.get("COUNTERPARTY").value, "회사X");
});

test("findContinuitySignals: candidate's CURRENT value equal to source's BEFORE value is a real signal, with the exact node locators attached", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "2099-01-01", after: "2100-06-01", locator: "src::n1#row=5" }]);
  const candidateCurrent = indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약기간종료일", value: "2099-01-01", locator: "cand::n3#row=10" }]);
  const signals = findContinuitySignals({ sourceBeforeByCategory: sourceBefore, candidateCurrentByCategory: candidateCurrent });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].category, "CONTRACT_PERIOD_END");
  assert.equal(signals[0].source_locator, "src::n1#row=5");
  assert.equal(signals[0].candidate_locator, "cand::n3#row=10");
});

test("findContinuitySignals counterexample: source amount and candidate amount that DIFFER produce no signal (numbers are close but not equal)", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약내역계약금액(원)", before: "1,000,000", after: "2,000,000", locator: "src::n1#row=1" }]);
  const candidateCurrent = indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약내역계약금액(원)", value: "1,000,001", locator: "cand::n3#row=2" }]);
  const signals = findContinuitySignals({ sourceBeforeByCategory: sourceBefore, candidateCurrentByCategory: candidateCurrent });
  assert.equal(signals.length, 0);
});

test("findContinuitySignals never cross-matches two DIFFERENT categories even if their raw values happen to be textually equal", () => {
  const sourceBefore = indexSourceBeforeByCategory([{ kind: "correction_pair", fieldLabel: "계약기간종료일", before: "100", after: "200", locator: "src::n1#row=1" }]);
  const candidateCurrent = indexFieldsByCategory([{ kind: "plain_value", fieldLabel: "계약내역계약금액(원)", value: "100", locator: "cand::n3#row=2" }]);
  const signals = findContinuitySignals({ sourceBeforeByCategory: sourceBefore, candidateCurrentByCategory: candidateCurrent });
  assert.equal(signals.length, 0);
});

test("findIdentitySignals: name+counterparty both matching produces one identity signal; name alone never does", () => {
  const source = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "테스트계약", locator: "src::n3#row=1" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "src::n3#row=6" },
  ]);
  const candidateSame = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "테스트계약", locator: "cand::n3#row=1" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "cand::n3#row=6" },
  ]);
  const signals = findIdentitySignals({ sourceCurrentByCategory: source, candidateCurrentByCategory: candidateSame });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].identity_kind, "CONTRACT_NAME_AND_COUNTERPARTY");

  const candidateDifferentCounterparty = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "테스트계약", locator: "cand::n3#row=1" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사Z", locator: "cand::n3#row=6" },
  ]);
  const noSignals = findIdentitySignals({ sourceCurrentByCategory: source, candidateCurrentByCategory: candidateDifferentCounterparty });
  assert.equal(noSignals.length, 0);
});

test("findIdentitySignals counterexample: same company (implicitly, via matching some other field) but genuinely DIFFERENT contract name never signals identity", () => {
  const source = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "계약A", locator: "src::n3#row=1" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "src::n3#row=6" },
  ]);
  const candidate = indexFieldsByCategory([
    { kind: "plain_value", fieldLabel: "체결계약명", value: "완전히다른계약", locator: "cand::n3#row=1" },
    { kind: "plain_value", fieldLabel: "계약상대", value: "회사X", locator: "cand::n3#row=6" },
  ]);
  const signals = findIdentitySignals({ sourceCurrentByCategory: source, candidateCurrentByCategory: candidate });
  assert.equal(signals.length, 0);
});
