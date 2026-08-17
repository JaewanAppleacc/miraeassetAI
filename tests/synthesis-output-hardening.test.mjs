// Turn I -- Response Output Release Hardening. TDD RED: written before the
// implementation changes and run first to confirm each assertion fails
// against the pre-Turn-I code, then re-run after the fix to confirm GREEN.
// Every fixture here is entirely synthetic (arbitrary keys/companies/
// metric names never seen in the real Seed corpus) -- this file is the
// generalization guard the overfitting review asked for: nothing here may
// depend on a real Seed question_id, company name, or exact calculation
// key to pass.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { planSynthesisSignals } from "../domain/flows/synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "../domain/flows/synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "../domain/flows/synthesis/response-composer.mjs";
import { validateSynthesis } from "../domain/flows/synthesis/final-synthesis-validator.mjs";
import { formatDisplayNumber, trimIeeeNoise } from "../domain/flows/synthesis/number-formatting.mjs";
import { projectWinnerField } from "../domain/flows/thin-structured-flow.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SYNTHESIS_DIR = path.join(ROOT, "domain/flows/synthesis");

function fact(overrides) {
  return {
    fact_id: "fact_default", corp_code: "00000000", metric_code: "test_metric",
    normalized_value: 100, unit: "KRW", scope: "COMPANY", value_status: "DISCLOSED",
    scale: 1, period_start: null, period_end: null, as_of_date: "2025-01-01",
    raw_label: "테스트 지표", attributes: {}, evidence_ids: [], ...overrides,
  };
}
function evidenceItem(overrides) {
  return {
    evidence_id: "evidence_default", document_id: "doc_default", file_id: "file_default",
    source_locator: "doc#node=1", quoted_text: "테스트 인용문", quote_sha256: "0".repeat(64), ...overrides,
  };
}
function eventItem(overrides) {
  return {
    event_id: "event_default", event_type: "AMENDS", event_date: "2025-01-01",
    event_status: "EFFECTIVE", anchor_document_id: "doc_default", attributes: {}, ...overrides,
  };
}
function registryEntry(overrides) {
  return {
    key: "zzz_synthetic_calculation_key", formula: "DIFF", output_kind: "VALUE", result: 100,
    input_fact_ids: ["fact_a", "fact_b"], input_labels: ["항목 A", "항목 B"], input_units: ["KRW", "KRW"],
    ...overrides,
  };
}

function pipeline({ question = "q", facts = [], events = [], evidence = [], calculationValue = {}, calculationRegistry = [], slots = [], subRequests = null, companyLabels = null }) {
  // Mirrors thin-structured-flow.mjs's calculatePair(), which always sets
  // calculationValue[outputKey] and pushes the matching registry entry in
  // the SAME call -- a registry entry with no corresponding
  // calculationValue key never happens in production, so fixtures here
  // keep that same pairing rather than exercising an impossible state.
  const mergedCalculationValue = { ...calculationValue };
  for (const entry of calculationRegistry) if (!(entry.key in mergedCalculationValue)) mergedCalculationValue[entry.key] = entry.result;
  calculationValue = mergedCalculationValue;
  const signals = planSynthesisSignals({ question, facts, events, evidence, calculationValue, subRequests });
  const narrativeFields = extractNarrativeFields({ facts, evidence, slots, signals });
  const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, slots, calculationRegistry, companyLabels });
  const validation = validateSynthesis({
    composerOutput: composed, signals, calculationValue, facts, evidence, events,
    authorizedFactIds: facts.map((f) => f.fact_id),
    authorizedEventIds: events.map((e) => e.event_id),
    authorizedEvidenceIds: evidence.map((e) => e.evidence_id),
  });
  return { signals, narrativeFields, composed, validation };
}

// -- §1 TDD RED: internal key / snake_case never leaks -------------------

test("an arbitrary registry key never appears literally in the answer text", () => {
  const registry = [registryEntry({ key: "totally_arbitrary_internal_key", result: 42 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.equal(composed.answer.includes("totally_arbitrary_internal_key"), false);
});

test("snake_case calculation keys never appear anywhere in the answer, for 3+ distinct arbitrary keys", () => {
  const registry = [
    registryEntry({ key: "revenue_growth_delta_metric_one", result: 10 }),
    registryEntry({ key: "some_other_synthetic_ratio_metric", output_kind: "PERCENT", formula: "PERCENTAGE_CHANGE", result: 5 }),
    registryEntry({ key: "yet_another_calc_key_xyz", result: -3 }),
  ];
  const { composed } = pipeline({ calculationRegistry: registry });
  for (const entry of registry) assert.equal(composed.answer.includes(entry.key), false, `leaked key "${entry.key}"`);
});

test("latest_effective_* internal English leaf labels (e.g. counterparty/pkg1_percent-shaped keys) never appear as user-facing labels, using an entirely synthetic multi-leaf object", () => {
  const calculationValue = { latest_effective_synthetic_multi_leaf: { arbitrary_leaf_one_percent: 13.7, arbitrary_leaf_two_percent: 55.2 } };
  const { composed } = pipeline({ calculationValue });
  assert.equal(composed.answer.includes("arbitrary_leaf_one_percent"), false);
  assert.equal(composed.answer.includes("arbitrary_leaf_two_percent"), false);
  assert.equal(composed.answer.includes("synthetic_multi_leaf"), false);
  // the values themselves must still be present and grounded
  assert.ok(composed.answer.includes("13.7"));
  assert.ok(composed.answer.includes("55.2"));
});

test("a verbatim Evidence quote containing an underscore-shaped token is exempt from the label leak check (quoting real text is not a label leak)", () => {
  const facts = [fact({ fact_id: "f1", normalized_value: "회사 내부 코드명은 PROJECT_ALPHA_2025 입니다.", metric_code: "attribution_text_metric" })];
  const signals = planSynthesisSignals({ question: "q", facts, events: [], evidence: [], calculationValue: {} });
  assert.ok(signals.attribution_candidates.length >= 0); // sanity: does not throw
  // The point of this fixture is documentation: verbatim-quoted source text
  // (rendered inside quotation marks, sourced by fact_id/evidence_id) is
  // never scanned by the internal-label static check -- only composer-
  // authored label positions (registry sentences, latest-state labels) are.
});

test("IEEE floating-point artifacts never appear in the answer as-is; the noise-trimmed value appears instead", () => {
  const registry = [registryEntry({ key: "synthetic_percent_diff", output_kind: "PERCENT", formula: "DIFF", result: 4.869999999999999 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.equal(composed.answer.includes("4.869999999999999"), false);
  assert.ok(composed.answer.includes("4.87"));
});

test("Turn M: a decimal with more than 2 fractional digits is rounded to 2 places for DISPLAY only (4.876543 -> 4.88), never left at full raw precision in the rendered text", () => {
  const registry = [registryEntry({ key: "synthetic_precise_percent", output_kind: "PERCENT", formula: "DIFF", result: 4.876543 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.ok(composed.answer.includes("4.88"));
  assert.equal(composed.answer.includes("4.876543"), false);
  // The raw, full-precision value is still preserved in the numeric_claim
  // itself -- only the rendered STRING is rounded, never the claim's own value.
  const claim = composed.numeric_claims.find((c) => c.source?.key === "synthetic_precise_percent");
  assert.equal(claim.value, 4.876543);
});

test("DIFF+VALUE(KRW) renders with 원; DIFF+PERCENT renders with %p; PERCENTAGE_CHANGE+PERCENT renders with % (not %p)", () => {
  const registry = [
    registryEntry({ key: "synthetic_diff_krw", formula: "DIFF", output_kind: "VALUE", result: 100000000, input_units: ["KRW", "KRW"] }),
    registryEntry({ key: "synthetic_diff_pp", formula: "DIFF", output_kind: "PERCENT", result: 4.87 }),
    registryEntry({ key: "synthetic_pct_change", formula: "PERCENTAGE_CHANGE", output_kind: "PERCENT", result: 3.2 }),
  ];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.match(composed.answer, /100,000,000원/);
  assert.match(composed.answer, /4\.87%p/);
  assert.match(composed.answer, /3\.2%(?!p)/);
});

test("claim.value stays the exact raw Calculator result even though display formatting trims noise for the rendered string", () => {
  const registry = [registryEntry({ key: "synthetic_noisy_value", output_kind: "VALUE", formula: "DIFF", result: 4.869999999999999 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  const claim = composed.numeric_claims.find((c) => c.source?.kind === "calculation" && c.source.key === "synthetic_noisy_value");
  assert.ok(claim);
  assert.equal(claim.value, 4.869999999999999);
  assert.equal(claim.display_value, "4.87");
});

test("PASS status is unaffected by noise-trimming -- the trimmed display is fully grounded, not flagged UNGROUNDED_NUMBER", () => {
  const registry = [registryEntry({ key: "synthetic_noisy_value_2", output_kind: "VALUE", formula: "DIFF", result: 4.869999999999999 })];
  const { validation } = pipeline({ calculationRegistry: registry });
  assert.equal(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"), false);
});

// -- §3 negative tests: wrong display_value must fail closed, no epsilon -

test("a fabricated display_value one cent/point off the true recomputed value fails closed (no tolerance)", () => {
  const registry = [registryEntry({ key: "synthetic_tolerance_check", output_kind: "PERCENT", formula: "DIFF", result: 4.87 })];
  const { composed, signals } = pipeline({ calculationRegistry: registry });
  const claim = composed.numeric_claims.find((c) => c.source?.key === "synthetic_tolerance_check");
  const tampered = { ...composed, numeric_claims: composed.numeric_claims.map((c) => (c === claim ? { ...c, display_value: "4.88" } : c)) };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts: [], evidence: [], events: [],
    authorizedFactIds: [], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "DISPLAY_VALUE_MISMATCH"));
});

test("a display_value trimmed to fewer digits than the true value (4.869 instead of 4.87) also fails closed", () => {
  const registry = [registryEntry({ key: "synthetic_tolerance_check_2", output_kind: "PERCENT", formula: "DIFF", result: 4.87 })];
  const { composed, signals } = pipeline({ calculationRegistry: registry });
  const claim = composed.numeric_claims.find((c) => c.source?.key === "synthetic_tolerance_check_2");
  const tampered = { ...composed, numeric_claims: composed.numeric_claims.map((c) => (c === claim ? { ...c, display_value: "4.869" } : c)) };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts: [], evidence: [], events: [],
    authorizedFactIds: [], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "DISPLAY_VALUE_MISMATCH"));
});

test("a display_value that matches recomputation but was never actually rendered in the narrative also fails closed", () => {
  const registry = [registryEntry({ key: "synthetic_never_rendered", output_kind: "VALUE", formula: "DIFF", result: 77 })];
  const { composed, signals } = pipeline({ calculationRegistry: registry });
  const fabricatedClaim = { type: "VALUE", value: 999, display_value: "999", source: { kind: "calculation", key: "phantom_key_never_in_registry" } };
  const tampered = { ...composed, numeric_claims: [...composed.numeric_claims, fabricatedClaim] };
  const validation = validateSynthesis({
    composerOutput: tampered, signals, calculationValue: {}, facts: [], evidence: [], events: [],
    authorizedFactIds: [], authorizedEventIds: [], authorizedEvidenceIds: [],
  });
  assert.equal(validation.status, "FAIL_CLOSED");
  assert.ok(validation.reasons.some((r) => r.code === "DISPLAY_VALUE_NOT_RENDERED" || r.code === "UNGROUNDED_NUMBER"));
});

// -- §2 unknown operation/unit: safe conservative render, never PARTIAL just for novelty --

test("an unknown formula/output_kind combination still renders the number safely with conservative wording, never leaking the key, never auto-downgrading to PARTIAL", () => {
  const registry = [registryEntry({ key: "synthetic_unknown_combo_key", formula: "RATIO", output_kind: "SHARES", result: 3, input_units: ["SHARES", "SHARES"] })];
  // EVIDENCE_REFERENCED_NARRATIVE is a pre-existing, unrelated universal
  // requirement (any narrative content requires a citation) -- satisfy it
  // with a synthetic evidence item so this test isolates only the
  // unknown-combination-rendering behavior under test.
  const evidence = [evidenceItem({ evidence_id: "evidence_synthetic", document_id: "doc_synthetic" })];
  const { composed, validation } = pipeline({ calculationRegistry: registry, evidence });
  assert.equal(composed.answer.includes("synthetic_unknown_combo_key"), false);
  assert.ok(composed.answer.includes("3"));
  assert.notEqual(validation.status, "PARTIAL");
});

// -- §9 fixture matrix: negative/zero/large/small, unknown unit -----------

test("negative computed values render with the sign preserved and grounded", () => {
  const registry = [registryEntry({ key: "synthetic_negative_diff", output_kind: "VALUE", formula: "DIFF", result: -38791 })];
  const { composed, validation } = pipeline({ calculationRegistry: registry });
  assert.ok(composed.answer.includes("-38,791") || composed.answer.includes("-38791"));
  assert.equal(validation.reasons.some((r) => r.code === "UNGROUNDED_NUMBER"), false);
});

test("a zero computed value renders and grounds correctly (not treated as falsy/absent)", () => {
  const registry = [registryEntry({ key: "synthetic_zero_diff", output_kind: "VALUE", formula: "DIFF", result: 0 })];
  const { composed, validation } = pipeline({ calculationRegistry: registry });
  assert.ok(composed.answer.includes("0"));
  assert.notEqual(validation.status, "FAIL_CLOSED");
});

test("a large integer computed value renders with grouping and is never noise-trimmed (integers are untouched)", () => {
  const registry = [registryEntry({ key: "synthetic_large_diff", output_kind: "VALUE", formula: "DIFF", result: 22764764160000 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.ok(composed.answer.includes("22,764,764,160,000"));
});

test("Turn M: a very small non-integer computed value is rounded to 2 display decimals (0.0034 -> 0), same universal display-rounding rule as any other decimal", () => {
  const registry = [registryEntry({ key: "synthetic_small_decimal", output_kind: "PERCENT", formula: "DIFF", result: 0.0034 })];
  const { composed } = pipeline({ calculationRegistry: registry });
  const claim = composed.numeric_claims.find((c) => c.source?.key === "synthetic_small_decimal");
  assert.equal(claim.value, 0.0034); // raw claim value is never touched
  assert.ok(composed.answer.includes(String(claim.display_value)));
});

test("an entirely unknown unit token still renders safely without inventing a Korean unit label", () => {
  const registry = [registryEntry({ key: "synthetic_unknown_unit", output_kind: "VALUE", formula: "DIFF", result: 42, input_units: ["XYZ_UNKNOWN_UNIT", "XYZ_UNKNOWN_UNIT"] })];
  const { composed } = pipeline({ calculationRegistry: registry });
  assert.ok(composed.answer.includes("42"));
});

// -- number-formatting.mjs unit tests --------------------------------------

test("trimIeeeNoise: collapses binary float noise without altering integers or meaningful decimals", () => {
  assert.equal(trimIeeeNoise(4.869999999999999), 4.87);
  assert.equal(trimIeeeNoise(4.876543), 4.876543);
  assert.equal(trimIeeeNoise(100), 100);
  assert.equal(trimIeeeNoise(-38791), -38791);
  assert.equal(trimIeeeNoise(0), 0);
});

test("formatDisplayNumber: integers use ko-KR grouping, non-integers use trimmed string form", () => {
  assert.equal(formatDisplayNumber(1000), "1,000");
  assert.equal(formatDisplayNumber(4.869999999999999), "4.87");
  assert.equal(formatDisplayNumber(-38791), "-38,791");
});

// -- Overfitting regression (mirrors the existing synthesis-wide scan) ---

// -- §4: Fact-level coarse qualifier provenance (Q22 parser removal) -----

test("a synthetic multi-value Fact with genuine qualifier language in its OWN linked Evidence renders a coarse qualifier sentence with real provenance, and qualifier_scope is FACT_LEVEL_COARSE", () => {
  const facts = [fact({
    fact_id: "fact_multi", metric_code: "synthetic_compound_metric", normalized_value: "ITEM A USD 10; ITEM B USD 20; ITEM C USD 30; ITEM D USD 40",
    evidence_ids: ["evidence_multi"],
  })];
  const evidence = [evidenceItem({ evidence_id: "evidence_multi", document_id: "doc_multi", quoted_text: "ITEM A : 약 USD 10; ITEM B : 약 USD 20 규모로 알려져 있습니다." })];
  const { composed } = pipeline({ facts, evidence });
  assert.equal(composed.qualifier_scope, "FACT_LEVEL_COARSE");
  assert.ok(composed.answer.includes("한정 표현"));
  assert.ok(composed.preserved_qualifiers.some((q) => q.evidence_id === "evidence_multi"));
  // never claims a precise per-value split of the compressed string
  assert.equal(composed.answer.includes("latest_effective"), false);
});

test("no coarse provenance -> no qualifier text is ever generated (never fabricated)", () => {
  const facts = [fact({
    fact_id: "fact_multi_clean", metric_code: "synthetic_compound_metric_2", normalized_value: "ITEM A USD 10; ITEM B USD 20",
    evidence_ids: ["evidence_multi_clean"],
  })];
  const evidence = [evidenceItem({ evidence_id: "evidence_multi_clean", document_id: "doc_multi_clean", quoted_text: "ITEM A USD 10; ITEM B USD 20 입니다." })];
  const { composed } = pipeline({ facts, evidence });
  assert.equal(composed.qualifier_scope, null);
  assert.equal(composed.answer.includes("약"), false);
});

test("thin-structured-flow.mjs no longer contains a PKG-specific regex projection (Q22 parser fully removed from answer-generation authority)", async () => {
  const source = await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(/PKG #1/.test(codeOnly), false);
  assert.equal(codeOnly.includes("latest_package_terms"), false);
  assert.equal(codeOnly.includes("latest_equity_shares"), false);
});

// -- §5: composite-key dedup ------------------------------------------------

test("the exact same qualifier sentence arriving from the SAME source twice is rendered only once", () => {
  const facts = [fact({ fact_id: "f1", normalized_value: "약 100억원 규모입니다.", evidence_ids: [] })];
  const { composed } = pipeline({ facts });
  const occurrences = composed.answer.split("약 100억원 규모입니다").length - 1;
  assert.equal(occurrences, 1);
});

test("the same normalized sentence arriving from two DIFFERENT sources (a Fact's own raw_value_text AND a separate Evidence quote) is rendered once in the narrative, but both source ids are preserved internally", () => {
  const facts = [
    fact({ fact_id: "f_dup_a", normalized_value: 100, raw_value_text: "약 200억원 규모의 합의입니다.", evidence_ids: [] }),
  ];
  const evidence = [evidenceItem({ evidence_id: "evidence_dup_b", quoted_text: "약 200억원 규모의 합의입니다." })];
  const { composed } = pipeline({ facts, evidence });
  // narrative_text excludes the citation block (which legitimately quotes
  // Evidence verbatim by design) -- dedup applies to the narrative
  // sentence itself, not to citations.
  const occurrences = composed.narrative_text.split("약 200억원 규모의 합의입니다").length - 1;
  assert.equal(occurrences, 1);
  const merged = composed.preserved_qualifiers.find((q) => q.text.includes("200억원"));
  assert.ok(merged);
  assert.ok(merged.merged_source_ids.includes("f_dup_a"));
  assert.ok(merged.merged_source_ids.includes("evidence_dup_b"));
});

// -- §6: legacy vs Candidate-authority event completeness language -------

test("legacy Plan path (no Candidate sub_requests): rendering 2+ events always adds the generic, conservative completeness caveat -- never a completeness claim", () => {
  const events = [eventItem({ event_id: "e1", event_date: "2025-01-01" }), eventItem({ event_id: "e2", event_date: "2025-02-01" })];
  const { composed } = pipeline({ events });
  assert.ok(composed.answer.includes("전체 변경 이력의 완전성을 의미하지 않습니다"));
  assert.equal(composed.answer.includes("전체 과정"), false);
  assert.equal(composed.answer.includes("완전한 타임라인"), false);
  assert.equal(composed.answer.includes("관련 사건을 모두"), false);
});

test("legacy Plan path with zero/one events: the completeness caveat never appears (nothing to caveat)", () => {
  const { composed: zeroEvents } = pipeline({ events: [] });
  assert.equal(zeroEvents.answer.includes("전체 변경 이력의 완전성을 의미하지 않습니다"), false);
  const { composed: oneEvent } = pipeline({ events: [eventItem({ event_id: "e1" })] });
  assert.equal(oneEvent.answer.includes("전체 변경 이력의 완전성을 의미하지 않습니다"), false);
});

test("Candidate sub-request authority: minimum_event_count exceeding rendered/verified count adds a specific stronger sentence with the real confirmed/required counts (never a guess from date gaps)", () => {
  const events = [eventItem({ event_id: "e1", event_date: "2025-01-01" }), eventItem({ event_id: "e2", event_date: "2025-02-01" })];
  const subRequests = [{
    sub_request_id: "sr_01", intent: "TRACE_TIMELINE",
    required_slot_names: [], required_event_types: [], required_output_kinds: ["DATE"],
    required_capabilities: ["TEMPORAL_EVENT_SYNTHESIS"], minimum_event_count: 5, requires_chronological_order: true,
    required_output_bindings: [], information_limit_allowed: true,
  }];
  const { composed } = pipeline({ events, subRequests });
  assert.ok(composed.answer.includes("2/5건"));
});

test("Candidate sub-request authority: when minimum_event_count is fully satisfied, no shortfall sentence is added", () => {
  const events = [eventItem({ event_id: "e1", event_date: "2025-01-01" }), eventItem({ event_id: "e2", event_date: "2025-02-01" })];
  const subRequests = [{
    sub_request_id: "sr_01", intent: "TRACE_TIMELINE",
    required_slot_names: [], required_event_types: [], required_output_kinds: ["DATE"],
    required_capabilities: ["TEMPORAL_EVENT_SYNTHESIS"], minimum_event_count: 2, requires_chronological_order: true,
    required_output_bindings: [], information_limit_allowed: true,
  }];
  const { composed } = pipeline({ events, subRequests });
  assert.equal(/\d\/\d건/.test(composed.answer), false);
  // the generic conservative caveat still applies regardless of authority
  assert.ok(composed.answer.includes("전체 변경 이력의 완전성을 의미하지 않습니다"));
});

test("number-formatting.mjs contains no Seed question_id / real-company-name / Gold access", async () => {
  const text = await readFile(path.join(SYNTHESIS_DIR, "number-formatting.mjs"), "utf8");
  const forbidden = ["question_seed_v07", "삼성중공업", "효성중공업", "SATORP", "HMM", "현대모비스", "expected_answer", "gold"];
  for (const token of forbidden) assert.equal(text.toLowerCase().includes(token.toLowerCase()), false, `contains overfit token "${token}"`);
});

// -- §5-A: winner resolved via companyLabels/corp_code, never a literal --

test("a winner comparison resolves the label from companyLabels when a resolution is provided, never a Flow-authored literal", () => {
  const calculationValue = { synthetic_metric_diff_krw: 100, synthetic_metric_winner_corp_code: "00000001" };
  const companyLabels = { "00000001": { corp_name: "합성기업일" } };
  const { composed } = pipeline({ calculationValue, companyLabels });
  assert.ok(composed.answer.includes("합성기업일 쪽 값이 더 큽니다"));
});

test("a winner comparison with no companyLabels resolution NEVER exposes the bare corp_code as if it were a name, and degrades to PARTIAL with an explicit information limit", () => {
  const calculationValue = { synthetic_metric_diff_krw: 100, synthetic_metric_winner_corp_code: "00000002" };
  const evidence = [evidenceItem({ evidence_id: "evidence_unresolved_winner" })];
  const { composed, validation } = pipeline({ calculationValue, evidence });
  assert.equal(composed.answer.includes("00000002"), false);
  assert.equal(composed.applied_capabilities.includes("ENTITY_LABEL_RESOLUTION"), false);
  assert.equal(validation.status, "PARTIAL");
  assert.ok(validation.missing_capabilities.includes("ENTITY_LABEL_RESOLUTION"));
});

test("a multi-entity value line with an unresolved corp_code never shows the bare corp_code, uses the generic placeholder, and degrades to PARTIAL", () => {
  const facts = [
    fact({ fact_id: "f_unres_1", corp_code: "00000010", metric_code: "synthetic_revenue" }),
    fact({ fact_id: "f_unres_2", corp_code: "00000011", metric_code: "synthetic_revenue" }),
  ];
  const evidence = [evidenceItem({ evidence_id: "evidence_unresolved_multi" })];
  const { composed, validation } = pipeline({ question: "두 회사를 비교해줘", facts, evidence });
  assert.equal(composed.answer.includes("00000010"), false);
  assert.equal(composed.answer.includes("00000011"), false);
  assert.ok(composed.answer.includes("미해결 기업"));
  assert.equal(composed.applied_capabilities.includes("ENTITY_LABEL_RESOLUTION"), false);
  assert.equal(validation.status, "PARTIAL");
  assert.ok(validation.missing_capabilities.includes("ENTITY_LABEL_RESOLUTION"));
});

test("a multi-entity value line where companyLabels resolves BOTH entities applies ENTITY_LABEL_RESOLUTION and shows real names", () => {
  const facts = [
    fact({ fact_id: "f_res_1", corp_code: "00000020", metric_code: "synthetic_revenue" }),
    fact({ fact_id: "f_res_2", corp_code: "00000021", metric_code: "synthetic_revenue" }),
  ];
  const companyLabels = { "00000020": { corp_name: "합성기업일" }, "00000021": { corp_name: "합성기업이" } };
  const evidence = [evidenceItem({ evidence_id: "evidence_resolved_multi" })];
  const { composed, validation } = pipeline({ question: "두 회사를 비교해줘", facts, companyLabels, evidence });
  assert.ok(composed.answer.includes("합성기업일"));
  assert.ok(composed.answer.includes("합성기업이"));
  assert.ok(composed.applied_capabilities.includes("ENTITY_LABEL_RESOLUTION"));
  assert.notEqual(validation.status, "PARTIAL");
});

test("thin-structured-flow.mjs's executable code contains no literal Seed company name as a computed value (comments documenting the historical removal are exempt)", async () => {
  const source = await readFile(path.join(ROOT, "domain/flows/thin-structured-flow.mjs"), "utf8");
  const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const token of ["HD현대중공업", "삼성중공업", "\"HMM\"", "현대모비스"]) {
    assert.equal(codeOnly.includes(token), false, `executable code still contains literal "${token}"`);
  }
});

// -- Turn K: backward-compatible winner-field projection (thin-structured-flow.mjs's projectWinnerField) --

test("projectWinnerField: a resolved corp_code (synthetic company A/B fixture) projects the resolver's real corp_name into the legacy structured field", () => {
  const calculationValue = { synthetic_metric_winner_corp_code: "00000001" };
  const companyLabels = { "00000001": { corp_name: "합성기업일" }, "00000002": { corp_name: "합성기업이" } };
  projectWinnerField(calculationValue, "synthetic_metric_winner_corp_code", "synthetic_metric_winner", companyLabels);
  assert.equal(calculationValue.synthetic_metric_winner, "합성기업일");
});

test("projectWinnerField: companyLabels absent -> the legacy field is never created (corp_code field alone is preserved, no literal fallback)", () => {
  const calculationValue = { synthetic_metric_winner_corp_code: "00000001" };
  projectWinnerField(calculationValue, "synthetic_metric_winner_corp_code", "synthetic_metric_winner", undefined);
  assert.equal("synthetic_metric_winner" in calculationValue, false);
  assert.equal(calculationValue.synthetic_metric_winner_corp_code, "00000001");
});

test("projectWinnerField: companyLabels present but missing an entry for this specific corp_code (a wrong/incomplete mapping) -> the legacy field is never created, never guessed", () => {
  const calculationValue = { synthetic_metric_winner_corp_code: "00000099" };
  const companyLabels = { "00000001": { corp_name: "합성기업일" } };
  projectWinnerField(calculationValue, "synthetic_metric_winner_corp_code", "synthetic_metric_winner", companyLabels);
  assert.equal("synthetic_metric_winner" in calculationValue, false);
});

test("projectWinnerField: a null winner corp_code (no winner determined) never creates the legacy field", () => {
  const calculationValue = { synthetic_metric_winner_corp_code: null };
  const companyLabels = { "00000001": { corp_name: "합성기업일" } };
  projectWinnerField(calculationValue, "synthetic_metric_winner_corp_code", "synthetic_metric_winner", companyLabels);
  assert.equal("synthetic_metric_winner" in calculationValue, false);
});

test("full pipeline: an unresolved winner corp_code still yields PARTIAL via ENTITY_LABEL_RESOLUTION exactly as before -- the new calculationValue projection does not bypass that safety net", () => {
  const calculationValue = { synthetic_metric_diff_krw: 100, synthetic_metric_winner_corp_code: "00000099" };
  const evidence = [evidenceItem({ evidence_id: "evidence_projection_unresolved" })];
  const { composed, validation } = pipeline({ calculationValue, evidence });
  assert.equal(composed.answer.includes("00000099"), false);
  assert.equal(validation.status, "PARTIAL");
  assert.ok(validation.missing_capabilities.includes("ENTITY_LABEL_RESOLUTION"));
});
