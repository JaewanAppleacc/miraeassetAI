// Shared vocabulary + structural validator for a Plan's `sub_requests`
// array (CANDIDATE contract, schema_version "0.2.0" -- see
// seed-question-plan-store.mjs). A sub_request describes WHAT KIND of ask
// a question makes and WHICH slots/events/output-kinds/capabilities it
// needs -- never the answer value, never a question_id/company branch.
// Both the Plan store (construction-time validation) and the Runtime
// synthesis layer (coverage evaluation) import this single source of
// truth so the enums can never drift apart between the two.
export const SUB_REQUEST_INTENTS = Object.freeze([
  "COMPARE_VALUES",
  "TRACE_TIMELINE",
  "REPORT_LATEST_STATE",
  "REPORT_INFORMATION_LIMIT",
  "EXPLAIN_ATTRIBUTION",
  "EXTRACT_FACTS",
  "CALCULATE_CHANGE",
]);

export const SUB_REQUEST_OUTPUT_KINDS = Object.freeze(["VALUE", "PERCENT", "SHARES", "DATE", "STATUS", "NARRATIVE"]);

// Mirrors the 10 capability_ids in
// work/domain-seed/seed-response-synthesis-requirements.v0.1.json and
// domain/flows/synthesis/capability-labels.mjs. Kept as a plain literal
// list here (rather than an import) because domain/adapters/ must not
// depend on domain/flows/ -- Runtime layering stays one-directional.
export const SUB_REQUEST_CAPABILITIES = Object.freeze([
  "ENTITY_AND_PERIOD_LABELING",
  "COMPARATIVE_CONCLUSION",
  "TEMPORAL_EVENT_SYNTHESIS",
  "LATEST_EFFECTIVE_STATE",
  "INFORMATION_LIMIT_DISCLOSURE",
  "ATTRIBUTION_PRESERVATION",
  "QUALIFIER_PRESERVATION",
  "REQUEST_COMPLETENESS",
  "NEUTRAL_COMPARABILITY_CAVEAT",
  "EVIDENCE_REFERENCED_NARRATIVE",
]);

const SUB_REQUEST_FIELDS = Object.freeze([
  "sub_request_id", "intent", "required_slot_names", "required_event_types", "required_output_kinds", "required_capabilities",
]);
const SUB_REQUEST_FIELD_SET = new Set(SUB_REQUEST_FIELDS);
const EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// Validates the whole sub_requests array for one Plan record. Throws a
// plain Error (matching seed-question-plan-store.mjs's existing
// convention) on the first violation; `slotNames` is the Set of this
// SAME plan's own `slots[].slot_name` values, so a sub_request can never
// reference a slot the plan doesn't actually resolve.
export function validateSubRequests(subRequests, { slotNames, questionId }) {
  if (!Array.isArray(subRequests) || subRequests.length === 0) {
    throw new Error(`${questionId}: sub_requests must be a non-empty array`);
  }
  const seenIds = new Set();
  for (const sr of subRequests) {
    if (!sr || typeof sr !== "object" || Array.isArray(sr)) throw new Error(`${questionId}: invalid sub_request`);
    for (const key of Object.keys(sr)) {
      if (!SUB_REQUEST_FIELD_SET.has(key)) throw new Error(`${questionId}: unexpected sub_request field "${key}"`);
    }
    for (const field of SUB_REQUEST_FIELDS) {
      if (!Object.hasOwn(sr, field)) throw new Error(`${questionId}: sub_request missing required field "${field}"`);
    }
    if (typeof sr.sub_request_id !== "string" || sr.sub_request_id === "") throw new Error(`${questionId}: invalid sub_request_id`);
    if (seenIds.has(sr.sub_request_id)) throw new Error(`${questionId}: duplicate sub_request_id "${sr.sub_request_id}"`);
    seenIds.add(sr.sub_request_id);
    if (!SUB_REQUEST_INTENTS.includes(sr.intent)) throw new Error(`${questionId}: invalid sub_request intent "${sr.intent}"`);

    const arrayFields = [
      ["required_slot_names", (v) => typeof v === "string" && v !== ""],
      ["required_event_types", (v) => typeof v === "string" && EVENT_TYPE_PATTERN.test(v)],
      ["required_output_kinds", (v) => SUB_REQUEST_OUTPUT_KINDS.includes(v)],
      ["required_capabilities", (v) => SUB_REQUEST_CAPABILITIES.includes(v)],
    ];
    for (const [field, isValidValue] of arrayFields) {
      if (!Array.isArray(sr[field])) throw new Error(`${questionId}: sub_request.${field} must be an array`);
      for (const value of sr[field]) {
        if (!isValidValue(value)) throw new Error(`${questionId}: sub_request.${field} contains invalid value "${value}"`);
      }
    }
    for (const slotName of sr.required_slot_names) {
      if (!slotNames.has(slotName)) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" references unknown slot "${slotName}"`);
    }
  }
}

// ---------------------------------------------------------------------
// v2 (CANDIDATE, plan schema_version "0.3.0"): a sub_request now groups
// the actual RESULT UNIT a question asks for (which may span several
// slots/events) rather than one slot per sub_request, and adds four
// fields so completeness can be checked against what the Composer
// ACTUALLY rendered, not just which Fact IDs got touched:
//
//   minimum_event_count       -- integer >= 0. For TRACE_TIMELINE this
//                                 must be >= 2 (a "timeline" of 0 or 1
//                                 events isn't a timeline); for other
//                                 intents it documents how many rendered
//                                 events (matching required_event_types,
//                                 or any if empty) this sub_request needs.
//   requires_chronological_order -- boolean. When true the coverage
//                                 evaluator additionally requires the
//                                 TEMPORAL_EVENT_SYNTHESIS capability to
//                                 have applied (the only renderer that
//                                 sorts events ascending).
//   required_output_bindings  -- array of {output_kind, slot_name} or
//                                 {output_kind, calculation_key} (exactly
//                                 one of slot_name/calculation_key).
//                                 Each binding must be satisfied by an
//                                 ACTUAL rendered claim of that kind from
//                                 that exact source -- not merely "the
//                                 Fact was used somewhere" or "some
//                                 capability applied".
//   information_limit_allowed -- boolean. Whether this sub_request may
//                                 be satisfied by an explicit disclosed
//                                 information-limit status claim in place
//                                 of a value claim (still not "silently
//                                 missing" -- an honest disclosure).
//
// v1 (0.2.0) plans and validateSubRequests() above are UNCHANGED and
// continue to validate exactly as before.
export const SUB_REQUEST_V2_FIELDS = Object.freeze([
  "sub_request_id", "intent", "required_slot_names", "required_event_types", "required_output_kinds", "required_capabilities",
  "minimum_event_count", "requires_chronological_order", "required_output_bindings", "information_limit_allowed",
]);
const SUB_REQUEST_V2_FIELD_SET = new Set(SUB_REQUEST_V2_FIELDS);

function validateOutputBinding(binding, { slotNames, questionId, subRequestId }) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`${questionId}: sub_request "${subRequestId}" has an invalid required_output_bindings entry`);
  }
  const allowedBindingFields = new Set(["output_kind", "slot_name", "calculation_key"]);
  for (const key of Object.keys(binding)) {
    if (!allowedBindingFields.has(key)) throw new Error(`${questionId}: sub_request "${subRequestId}" output binding has unexpected field "${key}"`);
  }
  if (!SUB_REQUEST_OUTPUT_KINDS.includes(binding.output_kind)) {
    throw new Error(`${questionId}: sub_request "${subRequestId}" output binding has invalid output_kind "${binding.output_kind}"`);
  }
  const hasSlot = Object.hasOwn(binding, "slot_name");
  const hasCalc = Object.hasOwn(binding, "calculation_key");
  if (hasSlot === hasCalc) {
    throw new Error(`${questionId}: sub_request "${subRequestId}" output binding must set exactly one of slot_name/calculation_key`);
  }
  if (hasSlot) {
    if (typeof binding.slot_name !== "string" || !slotNames.has(binding.slot_name)) {
      throw new Error(`${questionId}: sub_request "${subRequestId}" output binding references unknown slot "${binding.slot_name}"`);
    }
  } else if (typeof binding.calculation_key !== "string" || binding.calculation_key === "") {
    throw new Error(`${questionId}: sub_request "${subRequestId}" output binding has an invalid calculation_key`);
  }
}

// Per-intent minimum invariants: an intent must not be authored in a way
// that is trivially satisfiable without any real evidence of the thing it
// claims to check (e.g. a TRACE_TIMELINE that doesn't actually require a
// timeline).
function validateIntentInvariants(sr, questionId) {
  const outputKindsBound = new Set(sr.required_output_bindings.map((b) => b.output_kind));
  const outputKindsDeclared = new Set(sr.required_output_kinds);
  if (sr.intent === "TRACE_TIMELINE") {
    if (sr.requires_chronological_order !== true) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (TRACE_TIMELINE) must set requires_chronological_order:true`);
    if (!(sr.minimum_event_count >= 2)) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (TRACE_TIMELINE) must require minimum_event_count >= 2`);
    // A timeline's dates come from rendered EVENTS, which minimum_event_count
    // + requires_chronological_order already verify precisely (the coverage
    // evaluator only counts an event as satisfying minimum_event_count when
    // it was actually claimed/rendered, i.e. it has a DATE). No slot/
    // calculation-sourced DATE binding is required or even possible here --
    // required_output_kinds is still required to DECLARE DATE and STATUS so
    // the intent's shape is self-documenting.
    if (!outputKindsDeclared.has("DATE") || !outputKindsDeclared.has("STATUS")) {
      throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (TRACE_TIMELINE) must declare required_output_kinds DATE and STATUS`);
    }
  }
  if (sr.intent === "COMPARE_VALUES" && sr.required_slot_names.length < 2) {
    throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (COMPARE_VALUES) must require at least 2 slots`);
  }
  if (sr.intent === "REPORT_LATEST_STATE") {
    if (!outputKindsBound.has("DATE")) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (REPORT_LATEST_STATE) must bind an effective-date DATE output`);
    if (outputKindsBound.size < 2) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (REPORT_LATEST_STATE) must bind a value output in addition to its DATE output`);
  }
  if (sr.intent === "REPORT_INFORMATION_LIMIT") {
    if (sr.information_limit_allowed !== true) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (REPORT_INFORMATION_LIMIT) must set information_limit_allowed:true`);
    if (!outputKindsBound.has("STATUS")) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (REPORT_INFORMATION_LIMIT) must bind a STATUS output`);
  }
  if (sr.intent === "EXPLAIN_ATTRIBUTION") {
    // Attribution content is quoted-Evidence-sourced (a company's own
    // stated judgment/forecast inside a filing's free text), not tied to
    // a single named Fact slot the way a VALUE/DATE is -- there is no
    // slot_name/calculation_key that can honestly bind it. Coverage is
    // instead enforced through required_capabilities (ATTRIBUTION_PRESERVATION
    // must have actually applied, which the coverage evaluator verifies
    // against real applied_capabilities); required_output_kinds NARRATIVE
    // is a self-documenting declaration of the same requirement.
    if (!sr.required_capabilities.includes("ATTRIBUTION_PRESERVATION")) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (EXPLAIN_ATTRIBUTION) must require ATTRIBUTION_PRESERVATION`);
    if (!outputKindsDeclared.has("NARRATIVE")) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" (EXPLAIN_ATTRIBUTION) must declare required_output_kinds NARRATIVE`);
  }
}

export function validateSubRequestsV2(subRequests, { slotNames, questionId }) {
  if (!Array.isArray(subRequests) || subRequests.length === 0) {
    throw new Error(`${questionId}: sub_requests must be a non-empty array`);
  }
  const seenIds = new Set();
  for (const sr of subRequests) {
    if (!sr || typeof sr !== "object" || Array.isArray(sr)) throw new Error(`${questionId}: invalid sub_request`);
    for (const key of Object.keys(sr)) {
      if (!SUB_REQUEST_V2_FIELD_SET.has(key)) throw new Error(`${questionId}: unexpected sub_request field "${key}"`);
    }
    for (const field of SUB_REQUEST_V2_FIELDS) {
      if (!Object.hasOwn(sr, field)) throw new Error(`${questionId}: sub_request missing required field "${field}"`);
    }
    if (typeof sr.sub_request_id !== "string" || sr.sub_request_id === "") throw new Error(`${questionId}: invalid sub_request_id`);
    if (seenIds.has(sr.sub_request_id)) throw new Error(`${questionId}: duplicate sub_request_id "${sr.sub_request_id}"`);
    seenIds.add(sr.sub_request_id);
    if (!SUB_REQUEST_INTENTS.includes(sr.intent)) throw new Error(`${questionId}: invalid sub_request intent "${sr.intent}"`);

    const arrayFields = [
      ["required_slot_names", (v) => typeof v === "string" && v !== ""],
      ["required_event_types", (v) => typeof v === "string" && EVENT_TYPE_PATTERN.test(v)],
      ["required_output_kinds", (v) => SUB_REQUEST_OUTPUT_KINDS.includes(v)],
      ["required_capabilities", (v) => SUB_REQUEST_CAPABILITIES.includes(v)],
    ];
    for (const [field, isValidValue] of arrayFields) {
      if (!Array.isArray(sr[field])) throw new Error(`${questionId}: sub_request.${field} must be an array`);
      for (const value of sr[field]) {
        if (!isValidValue(value)) throw new Error(`${questionId}: sub_request.${field} contains invalid value "${value}"`);
      }
    }
    for (const slotName of sr.required_slot_names) {
      if (!slotNames.has(slotName)) throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" references unknown slot "${slotName}"`);
    }
    if (!Number.isInteger(sr.minimum_event_count) || sr.minimum_event_count < 0) {
      throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" has an invalid minimum_event_count`);
    }
    if (typeof sr.requires_chronological_order !== "boolean") {
      throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" has an invalid requires_chronological_order`);
    }
    if (typeof sr.information_limit_allowed !== "boolean") {
      throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" has an invalid information_limit_allowed`);
    }
    if (!Array.isArray(sr.required_output_bindings)) {
      throw new Error(`${questionId}: sub_request "${sr.sub_request_id}" has an invalid required_output_bindings`);
    }
    for (const binding of sr.required_output_bindings) validateOutputBinding(binding, { slotNames, questionId, subRequestId: sr.sub_request_id });
    validateIntentInvariants(sr, questionId);
  }
}
