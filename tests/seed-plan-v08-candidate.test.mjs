// Tests for the v0.8 sub_request GROUPING fix (v0.7's defect: one
// sub_request per slot) and the v2 (schema_version 0.3.0) coverage
// evaluator's output_binding/minimum_event_count/requires_chronological_order
// precision checks. See scripts/build-seed-thin-flow-plans-v08-candidate.mjs
// and domain/flows/synthesis/sub-request-coverage-v2.mjs.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateSubRequestsV2 } from "../domain/adapters/sub-request-vocabulary.mjs";
import { evaluateSubRequestCoverageV2 } from "../domain/flows/synthesis/sub-request-coverage-v2.mjs";
import { buildSeedThinFlowPlansV08Candidate } from "../scripts/build-seed-thin-flow-plans-v08-candidate.mjs";

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

// -- Grouping fix (v0.7's core defect) ------------------------------------

test("v0.8: a plan with 4 slots does NOT automatically become 4 sub_requests", async () => {
  const { planText } = await buildSeedThinFlowPlansV08Candidate({ writeOutputs: false });
  const plans = planText.trim().split("\n").map(JSON.parse);
  const q03 = plans.find((p) => p.question_id === "question_seed_v07_03");
  assert.equal(q03.slots.length, 4);
  assert.equal(q03.sub_requests.length, 1);
});

test("v0.8: Q17's TRACE_TIMELINE ask is present, not dropped in favor of only slot-level EXTRACT_FACTS", async () => {
  const { planText } = await buildSeedThinFlowPlansV08Candidate({ writeOutputs: false });
  const plans = planText.trim().split("\n").map(JSON.parse);
  const q17 = plans.find((p) => p.question_id === "question_seed_v07_17");
  assert.ok(q17.sub_requests.some((sr) => sr.intent === "TRACE_TIMELINE"));
});

test("v0.8: Q22's 9 latest-state-flavored slots are grouped into 2 sub_requests (correction narrative + one grouped latest-state ask), not split per slot", async () => {
  const { planText } = await buildSeedThinFlowPlansV08Candidate({ writeOutputs: false });
  const plans = planText.trim().split("\n").map(JSON.parse);
  const q22 = plans.find((p) => p.question_id === "question_seed_v07_22");
  assert.equal(q22.slots.length, 9);
  assert.equal(q22.sub_requests.length, 2);
  const latestState = q22.sub_requests.find((sr) => sr.intent === "REPORT_LATEST_STATE");
  assert.ok(latestState);
  assert.equal(latestState.required_slot_names.length, 8);
});

// -- v2 coverage evaluator precision --------------------------------------

test("v2 coverage: a required output_kind with no matching claim -> MISSING with OUTPUT_KIND_NOT_RENDERED (capability applied alone is not enough)", () => {
  const subRequests = [v2SubRequest({ required_output_bindings: [{ output_kind: "PERCENT", slot_name: "revenue" }], required_capabilities: [] })];
  const slots = [{ slot_name: "revenue", fact_ids: ["fact_a"], evidence_ids: [] }];
  // Only a VALUE claim exists, never the required PERCENT.
  const claims = [{ type: "VALUE", value: 100, source: { kind: "fact", id: "fact_a", field: "normalized_value" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["OUTPUT_KIND_NOT_RENDERED"]);
  assert.equal(result.missing_reasons[0].target.output_kind, "PERCENT");
});

test("v2 coverage: TEMPORAL_EVENT_SYNTHESIS applied but no DATE claim actually tied to the fact -> MISSING with OUTPUT_KIND_NOT_RENDERED (capability alone never marks a slot-name check COVERED)", () => {
  const subRequests = [v2SubRequest({
    required_slot_names: ["revenue"], required_output_bindings: [{ output_kind: "DATE", slot_name: "revenue" }],
    required_capabilities: ["TEMPORAL_EVENT_SYNTHESIS"],
  })];
  const slots = [{ slot_name: "revenue", fact_ids: ["fact_a"], evidence_ids: [] }];
  const claims = [{ type: "VALUE", value: 100, source: { kind: "fact", id: "fact_a", field: "normalized_value" } }]; // no DATE claim
  const [result] = evaluateSubRequestCoverageV2(subRequests, {
    slots, events: [], claims, informationLimits: [], appliedCapabilities: ["TEMPORAL_EVENT_SYNTHESIS"], notImplementedCapabilities: [],
  });
  assert.equal(result.status, "MISSING");
  assert.ok(result.missing_reasons.some((r) => r.reason_code === "OUTPUT_KIND_NOT_RENDERED"));
});

test("v2 coverage: a used Fact with no NARRATIVE claim of its own -> MISSING with OUTPUT_KIND_NOT_RENDERED, even though the fact_id is otherwise referenced", () => {
  const subRequests = [v2SubRequest({ required_output_bindings: [{ output_kind: "NARRATIVE", slot_name: "revenue" }] })];
  const slots = [{ slot_name: "revenue", fact_ids: ["fact_a"], evidence_ids: [] }];
  const claims = [{ type: "VALUE", value: 100, source: { kind: "fact", id: "fact_a", field: "normalized_value" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["OUTPUT_KIND_NOT_RENDERED"]);
});

test("v2 coverage: requires_chronological_order with only 1 rendered event -> MISSING with INSUFFICIENT_VERIFIED_EVENTS", () => {
  const subRequests = [v2SubRequest({
    required_slot_names: [], required_output_bindings: [], minimum_event_count: 2, requires_chronological_order: true,
    required_capabilities: ["TEMPORAL_EVENT_SYNTHESIS"],
  })];
  const events = [{ event_id: "e1", event_type: "AMENDS" }];
  const claims = [{ type: "DATE", value: "2025-01-01", source: { kind: "event", id: "e1", field: "event_date" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, {
    slots: [], events, claims, informationLimits: [], appliedCapabilities: ["TEMPORAL_EVENT_SYNTHESIS"], notImplementedCapabilities: [],
  });
  assert.equal(result.status, "MISSING");
  const insufficientReason = result.missing_reasons.find((r) => r.reason_code === "INSUFFICIENT_VERIFIED_EVENTS");
  assert.ok(insufficientReason);
  assert.equal(insufficientReason.target.available, 1);
  assert.equal(insufficientReason.target.required, 2);
});

test("v2 coverage: distinguishes INSUFFICIENT_VERIFIED_EVENTS (too few real events) from VERIFIED_EVENT_NOT_RENDERED (enough real events, rendering gap)", () => {
  const subRequests = [v2SubRequest({
    required_slot_names: [], required_output_bindings: [], minimum_event_count: 2, requires_chronological_order: false, required_capabilities: [],
  })];
  const events = [{ event_id: "e1", event_type: "AMENDS" }, { event_id: "e2", event_type: "AMENDS" }];
  // 2 real events exist (enough), but only 1 was ever rendered as a claim.
  const claims = [{ type: "DATE", value: "2025-01-01", source: { kind: "event", id: "e1", field: "event_date" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots: [], events, claims, informationLimits: [], appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "MISSING");
  assert.deepEqual(result.missing_reasons.map((r) => r.reason_code), ["VERIFIED_EVENT_NOT_RENDERED"]);
  assert.equal(result.missing_reasons[0].target.available, 2);
  assert.equal(result.missing_reasons[0].target.rendered, 1);
});

test("v2 coverage: an information-limit disclosure explicitly satisfies a slot-bound output requirement -> EXPLICIT_INFORMATION_LIMIT, not MISSING", () => {
  const subRequests = [v2SubRequest({ required_output_bindings: [{ output_kind: "VALUE", slot_name: "revenue" }], information_limit_allowed: true })];
  const slots = [{ slot_name: "revenue", fact_ids: ["fact_a"], evidence_ids: [] }];
  const informationLimits = [{ fact_id: "fact_a", field: "revenue_status", status: "WITHHELD", status_label_ko: "비공개(유보)로 공시되었습니다" }];
  const claims = [{ type: "STATUS", value: "WITHHELD", source: { kind: "calculation", key: "revenue_status" } }];
  const [result] = evaluateSubRequestCoverageV2(subRequests, { slots, events: [], claims, informationLimits, appliedCapabilities: [], notImplementedCapabilities: [] });
  assert.equal(result.status, "EXPLICIT_INFORMATION_LIMIT");
  assert.deepEqual(result.missing_reasons, []);
});

// -- validateSubRequestsV2 rejects malformed/dishonest authoring ---------

test("validateSubRequestsV2: rejects a required_output_bindings entry referencing an unknown slot", () => {
  const subRequests = [v2SubRequest({ required_output_bindings: [{ output_kind: "VALUE", slot_name: "nonexistent" }] })];
  assert.throws(() => validateSubRequestsV2(subRequests, { slotNames: new Set(["revenue"]), questionId: "q1" }), /references unknown slot/);
});

test("validateSubRequestsV2: rejects a binding declaring both slot_name and calculation_key (or neither)", () => {
  const both = [v2SubRequest({ required_output_bindings: [{ output_kind: "VALUE", slot_name: "revenue", calculation_key: "x" }] })];
  assert.throws(() => validateSubRequestsV2(both, { slotNames: new Set(["revenue"]), questionId: "q1" }), /exactly one of slot_name\/calculation_key/);
  const neither = [v2SubRequest({ required_output_bindings: [{ output_kind: "VALUE" }] })];
  assert.throws(() => validateSubRequestsV2(neither, { slotNames: new Set(["revenue"]), questionId: "q1" }), /exactly one of slot_name\/calculation_key/);
});

test("validateSubRequestsV2: rejects a TRACE_TIMELINE with minimum_event_count < 2 (a trivially-satisfiable non-timeline)", () => {
  const subRequests = [v2SubRequest({ intent: "TRACE_TIMELINE", required_slot_names: [], required_output_bindings: [], requires_chronological_order: true, minimum_event_count: 1, required_output_kinds: ["DATE", "STATUS"] })];
  assert.throws(() => validateSubRequestsV2(subRequests, { slotNames: new Set(), questionId: "q1" }), /minimum_event_count >= 2/);
});

test("validateSubRequestsV2: rejects a COMPARE_VALUES with fewer than 2 required slots", () => {
  const subRequests = [v2SubRequest({ intent: "COMPARE_VALUES", required_slot_names: ["revenue"], required_output_bindings: [] })];
  assert.throws(() => validateSubRequestsV2(subRequests, { slotNames: new Set(["revenue"]), questionId: "q1" }), /at least 2 slots/);
});

// -- Anti-overfitting -------------------------------------------------------

test("v0.8 authoring script never accesses expected_answer/scoring_spec/evidence_span (property access, not the forbidden-field literal it declares in its own manifest)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-seed-thin-flow-plans-v08-candidate.mjs"), "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of [".expected_answer", "[\"expected_answer\"]", ".scoring_spec", ".evidence_span"]) {
    assert.equal(codeOnly.includes(forbidden), false, `script contains forbidden access pattern "${forbidden}"`);
  }
});

test("sub-request-coverage-v2.mjs and seed-company-resolver.mjs contain no Seed question_id / real-company-name literals (Runtime dispatch code, not Candidate authoring data)", async () => {
  const forbidden = [
    "question_seed_v07", "삼성중공업", "효성중공업", "현대건설", "SATORP", "한화오션", "셀트리온",
    "삼성전자", "신한지주", "HD현대중공업", "HMM", "현대모비스", "삼성E&A", "삼성바이오로직스", "에스엠",
  ];
  for (const relativePath of ["domain/flows/synthesis/sub-request-coverage-v2.mjs", "domain/adapters/seed-company-resolver.mjs", "domain/adapters/sub-request-vocabulary.mjs"]) {
    const text = await readFile(path.join(ROOT, relativePath), "utf8");
    for (const token of forbidden) assert.equal(text.includes(token), false, `${relativePath} contains overfit token "${token}"`);
  }
});

test("v0.8 candidate build never modifies v0.7 candidate bytes", async () => {
  const v07Before = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.jsonl"));
  await buildSeedThinFlowPlansV08Candidate({ writeOutputs: false });
  const v07After = await readFile(path.join(ROOT, "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.jsonl"));
  assert.deepEqual(v07Before, v07After);
});

test("v0.8 candidate: all 25 plans validate and are schema_version 0.3.0", async () => {
  const { planText } = await buildSeedThinFlowPlansV08Candidate({ writeOutputs: false });
  const plans = planText.trim().split("\n").map(JSON.parse);
  assert.equal(plans.length, 25);
  for (const plan of plans) assert.equal(plan.schema_version, "0.3.0");
});

test("domain/flows/synthesis/ directory (including new v2 files) has no complete stored answer strings or Gold access", async () => {
  const dir = path.join(ROOT, "domain/flows/synthesis");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.includes("sub-request-coverage-v2.mjs"));
  for (const file of files) {
    const code = (await readFile(path.join(dir, file), "utf8")).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.equal(/gold/i.test(code), false, `${file} references Gold outside comments`);
    assert.equal(code.includes("expected_answer"), false, `${file} references expected_answer`);
  }
});
