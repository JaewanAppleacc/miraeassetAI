// Turn H2 tests: the 10-code missing_reasons taxonomy (§1), the 5-category
// gap classifier (§2), the generalized calculation-result registry (§3),
// and invariance checks for the new v0.9 Plan candidate builder (§8/§9).
// v0.7/v0.8 fixtures and coverage precision are already exercised by
// tests/seed-plan-v08-candidate.test.mjs -- this file only adds the codes
// and behaviors that were not yet covered there.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evaluateSubRequestCoverageV2, MISSING_REASON_CODES } from "../domain/flows/synthesis/sub-request-coverage-v2.mjs";
import { classifyMissingReasons, GAP_CLASSIFICATIONS } from "../domain/flows/synthesis/gap-classification.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { buildSeedThinFlowPlansV09Candidate } from "../scripts/build-seed-thin-flow-plans-v09-candidate.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function v2SubRequest(overrides) {
  return {
    sub_request_id: "sr_01", intent: "EXTRACT_FACTS",
    required_slot_names: ["revenue"], required_event_types: [], required_output_kinds: ["VALUE"],
    required_capabilities: [], minimum_event_count: 0, requires_chronological_order: false,
    required_output_bindings: [{ output_kind: "VALUE", slot_name: "revenue" }], information_limit_allowed: true,
    ...overrides,
  };
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// -- §1: the 10 reason codes, exhaustively -------------------------------

test("MISSING_REASON_CODES contains exactly the 10 required codes (additions allowed elsewhere, but these 10 must never be renamed/removed)", () => {
  const required = [
    "REQUIRED_FACT_NOT_RESOLVED", "FACT_RESOLVED_BUT_NO_CLAIM", "OUTPUT_KIND_NOT_RENDERED",
    "CALCULATION_VALUE_NOT_PRODUCED", "CALCULATION_PRODUCED_BUT_NO_CLAIM", "INSUFFICIENT_VERIFIED_EVENTS",
    "VERIFIED_EVENT_NOT_RENDERED", "REQUIRED_CAPABILITY_NOT_APPLIED", "REQUIRED_CAPABILITY_NOT_IMPLEMENTED",
    "PLAN_REQUIREMENT_POLICY_CONFLICT",
  ];
  for (const code of required) assert.ok(MISSING_REASON_CODES.includes(code), `missing required code ${code}`);
});

test("v2 coverage: a required_slot_name with no fact_ids on the Plan slot -> REQUIRED_FACT_NOT_RESOLVED", () => {
  const subRequests = [v2SubRequest({ required_slot_names: ["revenue"], required_output_bindings: [] })];
  const slots = [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["REQUIRED_FACT_NOT_RESOLVED"]);
  assert.equal(result.missing_reasons[0].target.slot_name, "revenue");
});

test("v2 coverage: fact resolved for a required_slot_name but zero claims reference it at all -> FACT_RESOLVED_BUT_NO_CLAIM", () => {
  const subRequests = [v2SubRequest({ required_slot_names: ["revenue"], required_output_bindings: [] })];
  const slots = [{ slot_name: "revenue", fact_ids: ["fact_a"], evidence_ids: [] }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["FACT_RESOLVED_BUT_NO_CLAIM"]);
  assert.equal(result.missing_reasons[0].target.fact_id, "fact_a");
});

test("v2 coverage: a calculation_key binding with no registry entry and no matching claim -> CALCULATION_VALUE_NOT_PRODUCED (the calculation never ran)", () => {
  const subRequests = [v2SubRequest({
    required_slot_names: [], required_output_bindings: [{ output_kind: "VALUE", calculation_key: "custom_metric_diff" }],
  })];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots: [], events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [], calculationRegistry: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["CALCULATION_VALUE_NOT_PRODUCED"]);
  assert.equal(result.missing_reasons[0].target.calculation_key, "custom_metric_diff");
});

test("v2 coverage: a registry entry exists for the calculation_key but no claim was ever rendered for it -> CALCULATION_PRODUCED_BUT_NO_CLAIM (distinct from CALCULATION_VALUE_NOT_PRODUCED)", () => {
  const subRequests = [v2SubRequest({
    required_slot_names: [], required_output_bindings: [{ output_kind: "VALUE", calculation_key: "custom_metric_diff" }],
  })];
  const calculationRegistry = [{ key: "custom_metric_diff", output_kind: "VALUE", formula: "a-b", input_fact_ids: ["fact_a", "fact_b"], result: 42 }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots: [], events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [], calculationRegistry });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["CALCULATION_PRODUCED_BUT_NO_CLAIM"]);
});

test("v2 coverage: required_capabilities lists a capability the Runtime authority mode has never implemented -> REQUIRED_CAPABILITY_NOT_IMPLEMENTED (distinct from NOT_APPLIED)", () => {
  const subRequests = [v2SubRequest({ required_slot_names: [], required_output_bindings: [], required_capabilities: ["SOME_FUTURE_CAPABILITY"] })];
  const [result] = evaluateSubRequestCoverageV2(subRequests, {
    slots: [], events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: ["SOME_FUTURE_CAPABILITY"],
  });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["REQUIRED_CAPABILITY_NOT_IMPLEMENTED"]);
});

test("v2 coverage: required_capabilities lists an implemented capability that simply did not fire for this request -> REQUIRED_CAPABILITY_NOT_APPLIED", () => {
  const subRequests = [v2SubRequest({ required_slot_names: [], required_output_bindings: [], required_capabilities: ["QUALIFIER_PRESERVATION"] })];
  const [result] = evaluateSubRequestCoverageV2(subRequests, {
    slots: [], events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [],
  });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["REQUIRED_CAPABILITY_NOT_APPLIED"]);
});

test("v2 coverage: PLAN_REQUIREMENT_POLICY_CONFLICT fires generically (no question_id/company literal) whenever a TRACE_TIMELINE sub_request is event-short AND one of its own required slots rendered a NARRATIVE claim", () => {
  const subRequests = [v2SubRequest({
    intent: "TRACE_TIMELINE", required_slot_names: ["status_narrative"], required_output_bindings: [],
    minimum_event_count: 2, requires_chronological_order: true, required_capabilities: [],
  })];
  const slots = [{ slot_name: "status_narrative", fact_ids: ["fact_a"], evidence_ids: [] }];
  const claims = [{ type: "NARRATIVE", value: "회사가 스스로 밝힌 시간 순서 요약", source: { kind: "fact", id: "fact_a", field: "raw_value_text" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.ok(result.missing_reasons.some((r) => r.reason_code === "INSUFFICIENT_VERIFIED_EVENTS"));
  assert.ok(result.missing_reasons.some((r) => r.reason_code === "PLAN_REQUIREMENT_POLICY_CONFLICT"));
});

test("v2 coverage: no PLAN_REQUIREMENT_POLICY_CONFLICT when the TRACE_TIMELINE sub_request has no narrative alternative rendered (a real, unambiguous data gap)", () => {
  const subRequests = [v2SubRequest({
    intent: "TRACE_TIMELINE", required_slot_names: ["some_date"], required_output_bindings: [],
    minimum_event_count: 2, requires_chronological_order: false, required_capabilities: [],
  })];
  const slots = [{ slot_name: "some_date", fact_ids: ["fact_a"], evidence_ids: [] }];
  const claims = [{ type: "DATE", value: "2025-01-01", source: { kind: "fact", id: "fact_a", field: "as_of_date" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["INSUFFICIENT_VERIFIED_EVENTS"]);
});

test("missing_reasons entries are deep-frozen and carry no stack/path -- safe for external diagnostic exposure", () => {
  const subRequests = [v2SubRequest({ required_slot_names: ["revenue"], required_output_bindings: [] })];
  const slots = [{ slot_name: "revenue", fact_ids: [], evidence_ids: [] }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.throws(() => { result.missing_reasons.push({}); });
  assert.throws(() => { result.missing_reasons[0].reason_code = "X"; });
  const serialized = JSON.stringify(result.missing_reasons);
  assert.equal(/\.mjs:\d+/.test(serialized), false);
  assert.equal(/\/Users\//.test(serialized), false);
});

// -- §2: gap-classification.mjs (5 categories, fail-closed) --------------

test("GAP_CLASSIFICATIONS contains exactly the 5 required categories", () => {
  for (const c of ["SATISFIABLE", "IMPLEMENTATION_GAP", "STRUCTURED_DATA_GAP", "PLAN_AUTHORING_REVIEW_REQUIRED", "OWNER_POLICY_DECISION_REQUIRED"]) {
    assert.ok(GAP_CLASSIFICATIONS.includes(c));
  }
});

test("classifyMissingReasons: empty reasons -> SATISFIABLE", () => {
  assert.equal(classifyMissingReasons([]), "SATISFIABLE");
});

test("classifyMissingReasons: all-STRUCTURED_DATA_GAP-flavored codes -> STRUCTURED_DATA_GAP", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "INSUFFICIENT_VERIFIED_EVENTS" }]), "STRUCTURED_DATA_GAP");
  assert.equal(classifyMissingReasons([{ reason_code: "REQUIRED_FACT_NOT_RESOLVED" }, { reason_code: "INSUFFICIENT_VERIFIED_EVENTS" }]), "STRUCTURED_DATA_GAP");
});

test("classifyMissingReasons: all-IMPLEMENTATION_GAP-flavored codes -> IMPLEMENTATION_GAP (the same underlying MISSING status as STRUCTURED_DATA_GAP, but a different classification)", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "OUTPUT_KIND_NOT_RENDERED" }]), "IMPLEMENTATION_GAP");
  assert.equal(classifyMissingReasons([{ reason_code: "FACT_RESOLVED_BUT_NO_CLAIM" }, { reason_code: "CALCULATION_PRODUCED_BUT_NO_CLAIM" }]), "IMPLEMENTATION_GAP");
  assert.equal(classifyMissingReasons([{ reason_code: "VERIFIED_EVENT_NOT_RENDERED" }]), "IMPLEMENTATION_GAP");
});

test("classifyMissingReasons: PLAN_REQUIREMENT_POLICY_CONFLICT classifies as STRUCTURED_DATA_GAP (Turn J: resolved by seed-timeline-fact-narrative-policy-decision.v0.1.json -- a Fact-encoded narrative alternative never counts toward Event sufficiency), including when mixed with INSUFFICIENT_VERIFIED_EVENTS", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "PLAN_REQUIREMENT_POLICY_CONFLICT" }]), "STRUCTURED_DATA_GAP");
  assert.equal(classifyMissingReasons([{ reason_code: "INSUFFICIENT_VERIFIED_EVENTS" }, { reason_code: "PLAN_REQUIREMENT_POLICY_CONFLICT" }]), "STRUCTURED_DATA_GAP");
});

test("classifyMissingReasons: PLAN_REQUIREMENT_POLICY_CONFLICT mixed with an IMPLEMENTATION_GAP-flavored code still fails closed to PLAN_AUTHORING_REVIEW_REQUIRED (the policy decision only resolves the Event-vs-Fact-narrative question, not an unrelated rendering gap)", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "PLAN_REQUIREMENT_POLICY_CONFLICT" }, { reason_code: "OUTPUT_KIND_NOT_RENDERED" }]), "PLAN_AUTHORING_REVIEW_REQUIRED");
});

test("classifyMissingReasons: a MIX of a STRUCTURED_DATA_GAP-flavored code and an IMPLEMENTATION_GAP-flavored code fails closed to PLAN_AUTHORING_REVIEW_REQUIRED, never auto-picking one side", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "REQUIRED_FACT_NOT_RESOLVED" }, { reason_code: "OUTPUT_KIND_NOT_RENDERED" }]), "PLAN_AUTHORING_REVIEW_REQUIRED");
});

test("classifyMissingReasons: an ambiguous-by-construction code alone (REQUIRED_CAPABILITY_NOT_APPLIED) fails closed to PLAN_AUTHORING_REVIEW_REQUIRED, never guessed as STRUCTURED_DATA_GAP", () => {
  assert.equal(classifyMissingReasons([{ reason_code: "REQUIRED_CAPABILITY_NOT_APPLIED" }]), "PLAN_AUTHORING_REVIEW_REQUIRED");
  assert.equal(classifyMissingReasons([{ reason_code: "CALCULATION_VALUE_NOT_PRODUCED" }]), "PLAN_AUTHORING_REVIEW_REQUIRED");
  assert.equal(classifyMissingReasons([{ reason_code: "REQUIRED_CAPABILITY_NOT_IMPLEMENTED" }]), "PLAN_AUTHORING_REVIEW_REQUIRED");
});

// -- §3: calculation-result registry (generalized, no key-suffix guessing) -

test("registry: an arbitrary, non-Seed-hardcoded calculation key renders via registry metadata alone (no per-question key list involved)", () => {
  const signals = planSynthesisSignals({ question: "q", facts: [], events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts: [], evidence: [], slots: [], signals });
  const calculationRegistry = [{ key: "zzz_totally_arbitrary_metric_not_in_any_suffix_list", output_kind: "VALUE", formula: "a-b", input_fact_ids: ["fact_a", "fact_b"], result: 12345 }];
  const composed = composeResponse({ facts: [], events: [], evidence: [], calculationValue: {}, signals, narrativeFields, calculationRegistry });
  assert.ok(composed.answer.includes("12345") || composed.answer.includes("12,345"));
  const claim = composed.numeric_claims.find((c) => c.source?.kind === "calculation" && c.source.key === "zzz_totally_arbitrary_metric_not_in_any_suffix_list");
  assert.ok(claim, "expected a claim sourced from the arbitrary registry key");
  assert.equal(claim.type, "VALUE");
});

test("registry: revenue_ratio_diff_disclosed_pp renders as PERCENT and is bindable (regression: previously blocked by suffix-guessing)", () => {
  const signals = planSynthesisSignals({ question: "q", facts: [], events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts: [], evidence: [], slots: [], signals });
  const calculationRegistry = [{ key: "revenue_ratio_diff_disclosed_pp", output_kind: "PERCENT", formula: "a-b", input_fact_ids: ["fact_a", "fact_b"], result: 3.4 }];
  const composed = composeResponse({ facts: [], events: [], evidence: [], calculationValue: {}, signals, narrativeFields, calculationRegistry });
  const claim = composed.numeric_claims.find((c) => c.source?.kind === "calculation" && c.source.key === "revenue_ratio_diff_disclosed_pp");
  assert.ok(claim);
  assert.equal(claim.type, "PERCENT");
});

test("registry: amount_change_krw renders as VALUE and is bindable", () => {
  const signals = planSynthesisSignals({ question: "q", facts: [], events: [], evidence: [], calculationValue: {} });
  const narrativeFields = extractNarrativeFields({ facts: [], evidence: [], slots: [], signals });
  const calculationRegistry = [{ key: "amount_change_krw", output_kind: "VALUE", formula: "a-b", input_fact_ids: ["fact_a", "fact_b"], result: 500 }];
  const composed = composeResponse({ facts: [], events: [], evidence: [], calculationValue: {}, signals, narrativeFields, calculationRegistry });
  const claim = composed.numeric_claims.find((c) => c.source?.kind === "calculation" && c.source.key === "amount_change_krw");
  assert.ok(claim);
  assert.equal(claim.type, "VALUE");
});

test("registry: a nonexistent calculation key stays MISSING (v2 coverage never invents a claim for a key with no registry entry and no rendered claim)", () => {
  const subRequests = [v2SubRequest({ required_slot_names: [], required_output_bindings: [{ output_kind: "VALUE", calculation_key: "no_such_key" }] })];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots: [], events: [], claims: [], informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [], calculationRegistry: [] });
  assert.equal(result.status, "MISSING");
});

test("registry: wrong output_kind for a real registered number still fails coverage (registry metadata is authoritative over a hopeful binding)", () => {
  const subRequests = [v2SubRequest({ required_slot_names: [], required_output_bindings: [{ output_kind: "PERCENT", calculation_key: "amount_change_krw" }] })];
  const calculationRegistry = [{ key: "amount_change_krw", output_kind: "VALUE", formula: "a-b", input_fact_ids: ["fact_a", "fact_b"], result: 500 }];
  const claims = [{ type: "VALUE", value: 500, source: { kind: "calculation", key: "amount_change_krw" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots: [], events: [], claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [], calculationRegistry });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["OUTPUT_KIND_NOT_RENDERED"]);
});

// -- §8/§9: v0.9 Plan candidate builder invariance ------------------------

test("v0.9 candidate build never modifies v0.8 candidate bytes", async () => {
  const v08Before = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl"));
  await buildSeedThinFlowPlansV09Candidate({ writeOutputs: false });
  const v08After = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl"));
  assert.deepEqual(v08Before, v08After);
});

test("v0.9 candidate build never touches the v0.19 release manifest or configured runtime defaults", async () => {
  const releaseBefore = await readFile(path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json"));
  await buildSeedThinFlowPlansV09Candidate({ writeOutputs: false });
  const releaseAfter = await readFile(path.join(ROOT, "domain/releases/seed-release.v0.19.manifest.json"));
  assert.deepEqual(releaseBefore, releaseAfter);
});

test("v0.9 candidate: all 25 plans validate and are schema_version 0.3.0, sha256 is stable across two builds", async () => {
  const first = await buildSeedThinFlowPlansV09Candidate({ writeOutputs: false });
  const plans = first.planText.trim().split("\n").map(JSON.parse);
  assert.equal(plans.length, 25);
  for (const plan of plans) assert.equal(plan.schema_version, "0.3.0");
  const second = await buildSeedThinFlowPlansV09Candidate({ writeOutputs: false });
  assert.equal(sha256(Buffer.from(first.planText, "utf8")), sha256(Buffer.from(second.planText, "utf8")));
});

test("v0.9 candidate builder script has no Seed question_id / real-company-name literal branching in its correction table (data-authoring script, but SUB_REQUEST_CORRECTIONS stays keyed generically)", async () => {
  const text = await readFile(path.join(ROOT, "scripts/build-seed-thin-flow-plans-v09-candidate.mjs"), "utf8");
  assert.ok(text.includes("SUB_REQUEST_CORRECTIONS"));
  assert.equal(/\.expected_answer/.test(text), false);
});

test("domain/flows/synthesis/gap-classification.mjs is a pure function of reason codes -- no question_id/company/intent literal branching", async () => {
  const text = await readFile(path.join(ROOT, "domain/flows/synthesis/gap-classification.mjs"), "utf8");
  const forbidden = ["question_seed_v07", "삼성중공업", "효성중공업", "SATORP", "HMM", "현대모비스"];
  for (const token of forbidden) assert.equal(text.includes(token), false, `contains overfit token "${token}"`);
});

test("the v0.9 gap-diagnostic script never reads expected_answer/scoring_spec and every emitted record's owner fields are PENDING/null", async () => {
  const text = await readFile(path.join(ROOT, "scripts/build-seed-thin-flow-plans-v09-gap-diagnostic.mjs"), "utf8");
  for (const forbidden of [".expected_answer", "[\"expected_answer\"]", ".scoring_spec"]) {
    assert.equal(text.includes(forbidden), false, `script contains forbidden access pattern "${forbidden}"`);
  }
  assert.match(text, /owner_approval_status:\s*"PENDING"/);
  assert.match(text, /owner_reviewer:\s*null/);
});
