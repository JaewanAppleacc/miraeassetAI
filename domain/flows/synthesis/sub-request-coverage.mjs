// Evaluates each Plan sub_request (see domain/adapters/sub-request-
// vocabulary.mjs) against what the Response Composer ACTUALLY rendered
// this request -- never against Gold, never by question_id/company
// branching. A sub_request is COVERED when every required slot's value
// was rendered, EXPLICIT_INFORMATION_LIMIT when a required slot was
// rendered as a disclosed information limit instead of a value (a valid,
// honest outcome, not a gap), and MISSING otherwise -- MISSING is never
// silently reclassified as COVERED.
import { deepFreeze } from "./deep-freeze.mjs";

function buildSlotToFactId(slots) {
  const map = new Map();
  for (const slot of slots ?? []) {
    if (Array.isArray(slot.fact_ids) && slot.fact_ids.length > 0) map.set(slot.slot_name, slot.fact_ids[0]);
  }
  return map;
}

export function evaluateSubRequestCoverage(subRequests, {
  slots = [], events = [], usedFactIdSet, usedEventIdSet, informationLimits = [], appliedCapabilities = [], notImplementedCapabilities = [],
}) {
  const slotToFactId = buildSlotToFactId(slots);
  const infoLimitFactIds = new Set(informationLimits.map((item) => item.fact_id).filter(Boolean));
  const eventTypesRendered = new Set(events.filter((event) => usedEventIdSet.has(event.event_id)).map((event) => event.event_type));

  const results = subRequests.map((sr) => {
    let anyMissing = false;
    let anyInformationLimit = false;

    for (const slotName of sr.required_slot_names) {
      const factId = slotToFactId.get(slotName);
      if (factId && infoLimitFactIds.has(factId)) { anyInformationLimit = true; continue; }
      if (factId && usedFactIdSet.has(factId)) continue;
      anyMissing = true;
    }
    if (sr.required_event_types.length > 0 && !sr.required_event_types.some((type) => eventTypesRendered.has(type))) {
      anyMissing = true;
    }
    for (const capabilityId of sr.required_capabilities) {
      if (notImplementedCapabilities.includes(capabilityId)) { anyMissing = true; continue; }
      if (!appliedCapabilities.includes(capabilityId)) anyMissing = true;
    }

    const status = anyMissing ? "MISSING" : anyInformationLimit ? "EXPLICIT_INFORMATION_LIMIT" : "COVERED";
    return { sub_request_id: sr.sub_request_id, status };
  });

  return deepFreeze(results);
}
