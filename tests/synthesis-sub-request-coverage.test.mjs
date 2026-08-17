// Tests the CANDIDATE-only structured sub_requests integration across
// the synthesis layer: planSynthesisSignals's optional `subRequests`
// param, response-composer.mjs's coverage evaluation
// (domain/flows/synthesis/sub-request-coverage.mjs), and
// final-synthesis-validator.mjs's existing PARTIAL/PASS logic (unchanged
// -- structured completeness reuses the same applied/not_implemented
// mechanism, no validator code change was required).
import assert from "node:assert/strict";
import test from "node:test";

import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "test_metric",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    raw_label: "테스트 지표", attributes: {}, ...overrides,
  };
}

function subRequest(overrides) {
  return {
    sub_request_id: "sr_01", intent: "EXTRACT_FACTS",
    required_slot_names: [], required_event_types: [], required_output_kinds: [], required_capabilities: [],
    ...overrides,
  };
}

function pipeline({ question, facts = [], events = [], evidence = [], calculationValue = {}, slots = [], subRequests }) {
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue, subRequests });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, slots });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { signals, composed, validation };
}

test("structured sub_requests: both required slots rendered -> both COVERED, REQUEST_COMPLETENESS applied, PASS", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "revenue", normalized_value: 1000 }),
    fact({ fact_id: "f2", metric_code: "profit", normalized_value: 200 }),
  ];
  const slots = [{ slot_name: "revenue", fact_ids: ["f1"], evidence_ids: [] }, { slot_name: "profit", fact_ids: ["f2"], evidence_ids: [] }];
  const evidence = [{ evidence_id: "ev1", document_id: "doc1", file_id: "file1", source_locator: "doc1#node=1", quoted_text: "1,000", quote_sha256: "0".repeat(64) }];
  const subRequests = [
    subRequest({ sub_request_id: "sr_01", required_slot_names: ["revenue"] }),
    subRequest({ sub_request_id: "sr_02", required_slot_names: ["profit"] }),
  ];
  const { composed, validation } = pipeline({ question: "q", facts, slots, evidence, subRequests });
  assert.deepEqual(composed.covered_sub_requests, [{ sub_request_id: "sr_01", status: "COVERED" }, { sub_request_id: "sr_02", status: "COVERED" }]);
  assert.ok(composed.applied_capabilities.includes("REQUEST_COMPLETENESS"));
  assert.equal(validation.status, "PASS");
});

test("structured sub_requests: only one of two required slots rendered -> PARTIAL, not silently PASS", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "revenue", normalized_value: 1000 })];
  // "profit" slot exists in the plan's slot list but has NO fact_ids
  // resolved for it (nothing to render) -- a genuine coverage gap.
  const slots = [{ slot_name: "revenue", fact_ids: ["f1"], evidence_ids: [] }, { slot_name: "profit", fact_ids: [], evidence_ids: [] }];
  const subRequests = [
    subRequest({ sub_request_id: "sr_01", required_slot_names: ["revenue"] }),
    subRequest({ sub_request_id: "sr_02", required_slot_names: ["profit"] }),
  ];
  const { composed, validation } = pipeline({ question: "q", facts, slots, subRequests });
  assert.deepEqual(composed.covered_sub_requests, [{ sub_request_id: "sr_01", status: "COVERED" }, { sub_request_id: "sr_02", status: "MISSING" }]);
  assert.equal(composed.applied_capabilities.includes("REQUEST_COMPLETENESS"), false);
  assert.equal(validation.status, "PARTIAL");
});

test("structured sub_requests: a required slot with no value but an explicit information-limit disclosure -> EXPLICIT_INFORMATION_LIMIT, not MISSING", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "limited_metric" })];
  const slots = [{ slot_name: "limited_slot", fact_ids: ["f1"], evidence_ids: [] }];
  const calculationValue = { limited_slot_status: "NOT_FOUND" };
  const subRequests = [subRequest({ sub_request_id: "sr_01", required_slot_names: ["limited_slot"] })];
  const { composed, validation } = pipeline({ question: "q", facts, slots, calculationValue, subRequests });
  assert.deepEqual(composed.covered_sub_requests, [{ sub_request_id: "sr_01", status: "EXPLICIT_INFORMATION_LIMIT" }]);
  assert.ok(composed.applied_capabilities.includes("REQUEST_COMPLETENESS"));
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

test("structured sub_requests: a required_capabilities entry that never applies keeps the sub_request MISSING", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "revenue", normalized_value: 1000 })];
  const slots = [{ slot_name: "revenue", fact_ids: ["f1"], evidence_ids: [] }];
  const subRequests = [subRequest({ sub_request_id: "sr_01", required_slot_names: ["revenue"], required_capabilities: ["TEMPORAL_EVENT_SYNTHESIS"] })];
  const { composed } = pipeline({ question: "q", facts, slots, subRequests });
  assert.deepEqual(composed.covered_sub_requests, [{ sub_request_id: "sr_01", status: "MISSING" }]);
});

test("structured authority overrides a wrong heuristic count: heuristic sees 1 imperative ending, but 2 structured sub_requests are the real authority", () => {
  const facts = [
    fact({ fact_id: "f1", metric_code: "revenue", normalized_value: 1000 }),
    fact({ fact_id: "f2", metric_code: "profit", normalized_value: 200 }),
  ];
  const slots = [{ slot_name: "revenue", fact_ids: ["f1"], evidence_ids: [] }, { slot_name: "profit", fact_ids: ["f2"], evidence_ids: [] }];
  const subRequests = [
    subRequest({ sub_request_id: "sr_01", required_slot_names: ["revenue"] }),
    subRequest({ sub_request_id: "sr_02", required_slot_names: ["profit"] }),
  ];
  // A single imperative ending ("알려줘") -- the heuristic alone would
  // count this as 1 sub-request and never require REQUEST_COMPLETENESS.
  const signals = planSynthesisSignals({ question: "매출을 알려줘", facts, events: [], evidence: [], calculationValue: {}, subRequests });
  assert.equal(signals.sub_request_authority, "STRUCTURED");
  assert.equal(signals.sub_request_count, 2);
  assert.ok(signals.required_capabilities.includes("REQUEST_COMPLETENESS"));
});

test("without subRequests, behavior is byte-for-byte the pre-existing heuristic/NOT_IMPLEMENTED path (production default unchanged)", () => {
  const { composed, validation } = pipeline({ question: "A와 B를 비교해줘 그리고 정리해줘" });
  assert.deepEqual(composed.covered_sub_requests, []);
  assert.ok(composed.not_implemented_capabilities.includes("REQUEST_COMPLETENESS"));
  assert.notEqual(validation.status, "PASS");
});

test("covered_sub_requests entries are never a capability ID -- shape is strictly {sub_request_id, status}", () => {
  const facts = [fact({ fact_id: "f1", metric_code: "revenue", normalized_value: 1000 })];
  const slots = [{ slot_name: "revenue", fact_ids: ["f1"], evidence_ids: [] }];
  const subRequests = [subRequest({ sub_request_id: "sr_01", required_slot_names: ["revenue"] })];
  const { composed } = pipeline({ question: "q", facts, slots, subRequests });
  for (const entry of composed.covered_sub_requests) {
    assert.deepEqual(Object.keys(entry).sort(), ["status", "sub_request_id"]);
    assert.ok(["COVERED", "EXPLICIT_INFORMATION_LIMIT", "MISSING"].includes(entry.status));
  }
});
