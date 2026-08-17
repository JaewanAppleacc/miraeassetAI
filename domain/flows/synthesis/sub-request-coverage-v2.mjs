// v2 sub_request coverage evaluator (plan schema_version "0.3.0" -- see
// domain/adapters/sub-request-vocabulary.mjs's validateSubRequestsV2).
// Unlike v1 (sub-request-coverage.mjs, kept unchanged for v0.7 audit
// history), this checks `required_output_bindings` against ACTUAL
// rendered claims of the exact declared output_kind from the exact
// declared source -- "the slot's Fact ID was touched somewhere" or "some
// capability applied" is never sufficient on its own. `claims` here is
// composer's full claim ledger (VALUE/PERCENT/SHARES/DATE/STATUS/
// NARRATIVE -- see response-composer.mjs), and `calculationRegistry` is
// the full provenance list of every successful Calculator result (see
// thin-structured-flow.mjs), used to distinguish "this calculation never
// ran" from "it ran but nothing claimed it".
//
// Every unmet requirement is reported as a typed, machine-readable
// `missing_reasons` entry (never just a bare MISSING status) so a SANDBOX
// audit can mechanically tell apart a Runtime rendering gap from a real
// absence of VERIFIED source data. Reason `detail` strings are built only
// from plan/data identifiers already safe to surface (slot names,
// capability IDs, calculation keys, counts) -- never an exception
// message/stack/path.
import { deepFreeze } from "./deep-freeze.mjs";

export const MISSING_REASON_CODES = Object.freeze([
  "REQUIRED_FACT_NOT_RESOLVED",
  "FACT_RESOLVED_BUT_NO_CLAIM",
  "OUTPUT_KIND_NOT_RENDERED",
  "CALCULATION_VALUE_NOT_PRODUCED",
  "CALCULATION_PRODUCED_BUT_NO_CLAIM",
  "INSUFFICIENT_VERIFIED_EVENTS",
  "VERIFIED_EVENT_NOT_RENDERED",
  "REQUIRED_CAPABILITY_NOT_APPLIED",
  "REQUIRED_CAPABILITY_NOT_IMPLEMENTED",
  "PLAN_REQUIREMENT_POLICY_CONFLICT",
]);

function buildSlotToFactId(slots) {
  const map = new Map();
  for (const slot of slots ?? []) {
    if (Array.isArray(slot.fact_ids) && slot.fact_ids.length > 0) map.set(slot.slot_name, slot.fact_ids[0]);
  }
  return map;
}

function reason(reason_code, target, detail) {
  return { reason_code, target, detail };
}

function claimsForFact(claims, factId) {
  return claims.filter((c) => c.source?.kind === "fact" && c.source.id === factId);
}

export function evaluateSubRequestCoverageV2(subRequests, {
  slots = [], events = [], claims = [], informationLimits = [], appliedCapabilities = [], notImplementedCapabilities = [],
  calculationRegistry = [],
}) {
  const slotToFactId = buildSlotToFactId(slots);
  const infoLimitFactIds = new Set(informationLimits.map((item) => item.fact_id).filter(Boolean));
  const registryByKey = new Map(calculationRegistry.map((entry) => [entry.key, entry]));

  const results = subRequests.map((sr) => {
    const reasons = [];
    let anyInformationLimit = false;

    // required_slot_names: a slot is COVERED if ANY claim is sourced from
    // its fact, EXPLICIT_INFORMATION_LIMIT if that fact's value was
    // disclosed as a status instead, MISSING (with a typed reason)
    // otherwise. This is the coarse "was this slot addressed at all"
    // check; required_output_bindings below is the precise "was the
    // SPECIFIC kind of output rendered" check.
    for (const slotName of sr.required_slot_names) {
      const factId = slotToFactId.get(slotName);
      if (factId == null) { reasons.push(reason("REQUIRED_FACT_NOT_RESOLVED", { slot_name: slotName }, `plan has no fact_ids for slot "${slotName}"`)); continue; }
      if (infoLimitFactIds.has(factId)) { anyInformationLimit = true; continue; }
      if (claimsForFact(claims, factId).length === 0) {
        reasons.push(reason("FACT_RESOLVED_BUT_NO_CLAIM", { slot_name: slotName, fact_id: factId }, `fact resolved for slot "${slotName}" but no claim was rendered for it`));
      }
    }

    for (const binding of sr.required_output_bindings) {
      if (binding.slot_name) {
        const boundFactId = slotToFactId.get(binding.slot_name);
        if (boundFactId == null) {
          reasons.push(reason("REQUIRED_FACT_NOT_RESOLVED", { slot_name: binding.slot_name }, `plan has no fact_ids for slot "${binding.slot_name}"`));
          continue;
        }
        const factClaims = claimsForFact(claims, boundFactId);
        if (factClaims.some((c) => c.type === binding.output_kind)) continue;
        if (sr.information_limit_allowed && infoLimitFactIds.has(boundFactId)) { anyInformationLimit = true; continue; }
        if (factClaims.length === 0) {
          reasons.push(reason("FACT_RESOLVED_BUT_NO_CLAIM", { slot_name: binding.slot_name, fact_id: boundFactId }, `fact resolved for slot "${binding.slot_name}" but no claim was rendered for it`));
        } else {
          reasons.push(reason("OUTPUT_KIND_NOT_RENDERED", { slot_name: binding.slot_name, fact_id: boundFactId, output_kind: binding.output_kind }, `fact rendered but not as a ${binding.output_kind} claim (rendered as: ${[...new Set(factClaims.map((c) => c.type))].join(",")})`));
        }
        continue;
      }
      // calculation_key binding
      const registryEntry = registryByKey.get(binding.calculation_key);
      const matchingClaims = claims.filter((c) => c.source?.kind === "calculation" &&
        (c.source.key === binding.calculation_key || c.source.key.startsWith(`${binding.calculation_key}.`)));
      if (matchingClaims.some((c) => c.type === binding.output_kind)) continue;
      if (!registryEntry && matchingClaims.length === 0) {
        reasons.push(reason("CALCULATION_VALUE_NOT_PRODUCED", { calculation_key: binding.calculation_key }, `no Calculator result or calculationValue entry exists for key "${binding.calculation_key}"`));
      } else if (matchingClaims.length === 0) {
        reasons.push(reason("CALCULATION_PRODUCED_BUT_NO_CLAIM", { calculation_key: binding.calculation_key }, `calculation result exists for "${binding.calculation_key}" but was never rendered as a claim`));
      } else {
        reasons.push(reason("OUTPUT_KIND_NOT_RENDERED", { calculation_key: binding.calculation_key, output_kind: binding.output_kind }, `calculation rendered but not as a ${binding.output_kind} claim (rendered as: ${[...new Set(matchingClaims.map((c) => c.type))].join(",")})`));
      }
    }

    if (sr.minimum_event_count > 0) {
      const eligibleEvents = events.filter((event) => sr.required_event_types.length === 0 || sr.required_event_types.includes(event.event_type));
      const renderedCount = eligibleEvents.filter((event) => claims.some((c) => c.source?.kind === "event" && c.source.id === event.event_id)).length;
      if (eligibleEvents.length < sr.minimum_event_count) {
        reasons.push(reason("INSUFFICIENT_VERIFIED_EVENTS", { required_event_types: sr.required_event_types, required: sr.minimum_event_count, available: eligibleEvents.length }, `only ${eligibleEvents.length} VERIFIED event(s) available, ${sr.minimum_event_count} required`));
        // Generic policy-conflict signal: the events required for this
        // TRACE_TIMELINE genuinely don't exist, but a Fact-shaped
        // narrative/status alternative covering the SAME required slots
        // was itself successfully rendered -- this is a real choice
        // about which representation counts as "a timeline", not
        // something Runtime code may decide unilaterally.
        if (sr.intent === "TRACE_TIMELINE") {
          const hasNarrativeAlternative = sr.required_slot_names.some((slotName) => {
            const factId = slotToFactId.get(slotName);
            return factId != null && claims.some((c) => c.source?.kind === "fact" && c.source.id === factId && c.type === "NARRATIVE");
          });
          if (hasNarrativeAlternative) {
            reasons.push(reason("PLAN_REQUIREMENT_POLICY_CONFLICT", { intent: sr.intent }, "a Fact-encoded narrative alternative covering the same slots was rendered while VERIFIED Events remain insufficient -- whether that narrative counts as satisfying a timeline requirement is an Owner policy decision, not a Runtime default"));
          }
        }
      } else if (renderedCount < sr.minimum_event_count) {
        reasons.push(reason("VERIFIED_EVENT_NOT_RENDERED", { required_event_types: sr.required_event_types, required: sr.minimum_event_count, available: eligibleEvents.length, rendered: renderedCount }, `${eligibleEvents.length} VERIFIED event(s) available but only ${renderedCount} were rendered`));
      }
    }
    if (sr.requires_chronological_order && !appliedCapabilities.includes("TEMPORAL_EVENT_SYNTHESIS")) {
      reasons.push(reason("REQUIRED_CAPABILITY_NOT_APPLIED", { capability_id: "TEMPORAL_EVENT_SYNTHESIS" }, "requires_chronological_order:true but TEMPORAL_EVENT_SYNTHESIS did not apply"));
    }

    for (const capabilityId of sr.required_capabilities) {
      if (notImplementedCapabilities.includes(capabilityId)) {
        reasons.push(reason("REQUIRED_CAPABILITY_NOT_IMPLEMENTED", { capability_id: capabilityId }, `capability "${capabilityId}" has no Runtime implementation for this authority mode`));
      } else if (!appliedCapabilities.includes(capabilityId)) {
        reasons.push(reason("REQUIRED_CAPABILITY_NOT_APPLIED", { capability_id: capabilityId }, `capability "${capabilityId}" was required but did not apply to this request`));
      }
    }

    const status = reasons.length > 0 ? "MISSING" : anyInformationLimit ? "EXPLICIT_INFORMATION_LIMIT" : "COVERED";
    return { sub_request_id: sr.sub_request_id, status, missing_reasons: reasons };
  });

  return deepFreeze(results);
}
