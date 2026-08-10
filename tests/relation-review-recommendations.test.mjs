import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateRecommendationInvariant } from "../scripts/build-relation-review-recommendations.mjs";

const schema = JSON.parse(readFileSync(new URL("../domain/relations/relation-review-recommendation.schema.json", import.meta.url), "utf8"));

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function fixture() {
  return {
    schema_version: "0.1.0",
    review_packet_id: `relation_review_${"a".repeat(24)}`,
    corpus_snapshot_id: "corpus_snapshot_1",
    relation_candidate_id: "relation_candidate_1",
    relation_type: "AMENDS",
    source_document: {
      document_id: "exchange_20250731800028",
      corp_code: "00126380",
      doc_group: "exchange",
      report_name: "[기재정정]단일판매공급계약체결",
      receipt_date: "2025-07-31",
      is_correction: true,
    },
    source_parse: { state: "PRESENT", reason_code: "PARSE_SUCCESS", warning_codes: [] },
    recommended_target_document: null,
    candidate_count: 0,
    candidate_summaries: [],
    evidence: [],
    recommendation_basis: ["MANIFEST_CANDIDATES_ONLY"],
    machine_status: "AMBIGUOUS_REVIEW",
    human_action: "원문을 확인하세요.",
    review_status: "PENDING_HUMAN_REVIEW",
    review: {
      reviewer_id: null,
      reviewed_at: null,
      outcome: null,
      target_document_id: null,
      evidence_ids: [],
      notes: null,
    },
  };
}

test("relation review recommendation validates while human decision is empty", () => {
  const validate = validator();
  assert.equal(validate(fixture()), true, JSON.stringify(validate.errors));
});

test("machine packet cannot masquerade as accepted Gold", () => {
  const validate = validator();
  const record = fixture();
  record.review_status = "ACCEPTED";
  record.review.outcome = "ACCEPTED";
  assert.equal(validate(record), false);
});

test("citation support requires a stable source locator and exact quoted text", () => {
  const validate = validator();
  const record = fixture();
  record.evidence = [{
    evidence_id: `review_evidence_${"b".repeat(24)}`,
    kind: "REFERENCE_DATE",
    document_id: record.source_document.document_id,
    source_locator: "",
    quoted_text: "2. 정정관련 공시서류제출일 | 2025-07-28",
  }];
  assert.equal(validate(record), false);
});

test("ready status requires a recommended target and evidence", () => {
  const record = fixture();
  record.machine_status = "READY_FOR_HUMAN_REVIEW";
  assert.deepEqual(validateRecommendationInvariant(record), [
    "READY_FOR_HUMAN_REVIEW requires recommended_target_document",
    "READY_FOR_HUMAN_REVIEW requires source evidence",
  ]);
});

test("machine recommendation cannot carry a hidden human decision", () => {
  const record = fixture();
  record.review.reviewer_id = "reviewer_1";
  assert.ok(validateRecommendationInvariant(record).includes("machine recommendation cannot contain a human decision"));
});
