// Turn P6 section C.5: Event/Relation Scorer.
//
// Events: checks that every expected_event's event_id appears among the
// Agent's own retrieved_context event entries, AND that their RELATIVE
// order agrees with expected_events' order_index (a longest-common-
// subsequence-style check: the matched event_ids, in the order the Agent
// actually returned them, must appear in the same relative order the
// expected sequence declares -- an out-of-order match is EVENT_ORDER_MISMATCH,
// not silently accepted just because every id individually appears).
//
// Relations: checks relation_type, source_document_id/target_document_id
// direction, and source_corp_code/target_corp_code (cross-company
// attribution) against `actualRelations` -- a richer, structured shape
// ({relation_id, relation_type, source_document_id, target_document_id,
// source_corp_code, target_corp_code}) than the four Agent variants'
// CURRENT retrieved_context relation entries expose today
// (`{relation_id, relation_type}` only -- see e.g.
// flows/structured-first-agent.mjs's own relationContext construction).
// This scorer never invents that missing detail via free-text guessing
// (the same "no semantic analysis over free text" discipline
// hard-claim-grounding.mjs's own header commits to) -- when the runner
// cannot supply `actualRelations` with source/target/corp_code detail for
// a given item, this axis reports NOT_APPLICABLE for the relation half
// rather than a false PASS or a fabricated FAIL. The reverse-direction and
// cross-company checks below are unit-tested directly against a
// synthetic `actualRelations` (see tests/agent-comparison-benchmark-scorers.test.mjs),
// which is exactly how a future variant enhancement that starts populating
// this detail would be validated too.
import { pass, partial, notApplicable } from "./axis-result.mjs";

function longestIncreasingSubsequenceLength(indices) {
  const tails = [];
  for (const index of indices) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = index;
  }
  return tails.length;
}

function scoreEvents(expectedEvents, actualEventIds) {
  const idBearing = expectedEvents.filter((event) => typeof event.event_id === "string" && event.event_id !== "");
  if (idBearing.length === 0) return notApplicable();

  const expectedOrder = [...idBearing].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)).map((event) => event.event_id);
  const actualIndexByEventId = new Map((actualEventIds ?? []).map((id, index) => [id, index]));

  const matchedIds = expectedOrder.filter((id) => actualIndexByEventId.has(id));
  if (matchedIds.length === 0) {
    return partial(0, ["MISSING_EVENT"], { matched_count: 0, expected_count: expectedOrder.length });
  }
  const matchedActualIndices = matchedIds.map((id) => actualIndexByEventId.get(id));
  const inOrderCount = longestIncreasingSubsequenceLength(matchedActualIndices);
  const orderOk = inOrderCount === matchedActualIndices.length;

  const errorCodes = [];
  if (matchedIds.length < expectedOrder.length) errorCodes.push("MISSING_EVENT");
  if (!orderOk) errorCodes.push("EVENT_ORDER_MISMATCH");

  const coverage = matchedIds.length / expectedOrder.length;
  const rawScore = orderOk ? coverage : coverage * 0.5;
  if (errorCodes.length === 0) return pass({ matched_count: matchedIds.length, expected_count: expectedOrder.length });
  return partial(rawScore, errorCodes, { matched_count: matchedIds.length, expected_count: expectedOrder.length, order_ok: orderOk });
}

function scoreRelations(expectedRelations, actualRelations) {
  if (!Array.isArray(actualRelations)) {
    return notApplicable({ reason: "no structured actualRelations (source/target/corp_code) supplied for this run" });
  }
  const byRelationId = new Map(actualRelations.filter((r) => typeof r.relation_id === "string").map((r) => [r.relation_id, r]));
  const byTypeAndDocs = actualRelations.map((r) => r);

  let matched = 0;
  const errorCodes = [];
  const mismatches = [];
  for (const expected of expectedRelations) {
    // Matching by relation_id alone is NEVER sufficient to declare a
    // match -- an actual entry can share the expected relation_id while
    // still disagreeing on direction or corp_code (e.g. a buggy variant
    // enhancement that echoes the right id but swapped source/target), so
    // every candidate (found by id OR by exact type+docs) is re-checked
    // for direction/corp_code below rather than trusted on sight.
    const byId = typeof expected.relation_id === "string" ? byRelationId.get(expected.relation_id) : null;
    const exactCandidate = byId ?? byTypeAndDocs.find((actual) =>
      actual.relation_type === expected.relation_type
      && actual.source_document_id === expected.source_document_id
      && actual.target_document_id === expected.target_document_id);

    if (exactCandidate) {
      if (exactCandidate.source_document_id !== expected.source_document_id || exactCandidate.target_document_id !== expected.target_document_id) {
        if (exactCandidate.source_document_id === expected.target_document_id && exactCandidate.target_document_id === expected.source_document_id) {
          errorCodes.push("RELATION_DIRECTION_REVERSED");
          mismatches.push({ relation_id: expected.relation_id, reason: "RELATION_DIRECTION_REVERSED" });
          continue;
        }
        errorCodes.push("MISSING_RELATION");
        mismatches.push({ relation_id: expected.relation_id, reason: "MISSING_RELATION" });
        continue;
      }
      if (exactCandidate.source_corp_code !== expected.source_corp_code || exactCandidate.target_corp_code !== expected.target_corp_code) {
        errorCodes.push("CROSS_COMPANY_ATTRIBUTION");
        mismatches.push({ relation_id: expected.relation_id, reason: "CROSS_COMPANY_ATTRIBUTION" });
        continue;
      }
      matched += 1;
      continue;
    }

    // No exact-direction candidate at all -- distinguish "claimed the
    // reverse direction" / "claimed it for the wrong company" from a
    // genuine MISSING_RELATION, same as above but searched more loosely.
    const reversed = byTypeAndDocs.find((actual) =>
      actual.relation_type === expected.relation_type
      && actual.source_document_id === expected.target_document_id
      && actual.target_document_id === expected.source_document_id);
    if (reversed) {
      errorCodes.push("RELATION_DIRECTION_REVERSED");
      mismatches.push({ relation_id: expected.relation_id, reason: "RELATION_DIRECTION_REVERSED" });
      continue;
    }
    const crossCompany = byTypeAndDocs.find((actual) =>
      actual.relation_type === expected.relation_type
      && (actual.source_corp_code !== expected.source_corp_code || actual.target_corp_code !== expected.target_corp_code));
    if (crossCompany) {
      errorCodes.push("CROSS_COMPANY_ATTRIBUTION");
      mismatches.push({ relation_id: expected.relation_id, reason: "CROSS_COMPANY_ATTRIBUTION" });
      continue;
    }
    errorCodes.push("MISSING_RELATION");
    mismatches.push({ relation_id: expected.relation_id, reason: "MISSING_RELATION" });
  }

  const rawScore = matched / expectedRelations.length;
  if (rawScore >= 1) return pass({ matched_count: matched, expected_count: expectedRelations.length });
  return partial(rawScore, errorCodes, { matched_count: matched, expected_count: expectedRelations.length, mismatches });
}

// Combines the Event half and Relation half into ONE axis result (per
// benchmark-item-result.schema.json's single `event_relation` axis) --
// NOT_APPLICABLE only when BOTH halves have nothing to check; otherwise the
// worse of the two (FAIL dominates PASS/NOT_APPLICABLE) with both halves'
// details preserved.
export function scoreEventRelation({ expectedEvents, expectedRelations, actualEventIds, actualRelations }) {
  const hasEvents = Array.isArray(expectedEvents) && expectedEvents.length > 0;
  const hasRelations = Array.isArray(expectedRelations) && expectedRelations.length > 0;
  if (!hasEvents && !hasRelations) return notApplicable();

  const eventResult = hasEvents ? scoreEvents(expectedEvents, actualEventIds) : notApplicable();
  const relationResult = hasRelations ? scoreRelations(expectedRelations, actualRelations) : notApplicable();

  const parts = [eventResult, relationResult].filter((r) => r.status !== "NOT_APPLICABLE");
  if (parts.length === 0) return notApplicable();
  const scored = parts.filter((r) => typeof r.raw_score === "number");
  const rawScore = scored.length > 0 ? scored.reduce((sum, r) => sum + r.raw_score, 0) / scored.length : null;
  const errorCodes = parts.flatMap((r) => r.error_codes);
  const details = { events: eventResult.details, relations: relationResult.details };
  if (errorCodes.length === 0) return pass(details);
  return partial(rawScore ?? 0, errorCodes, details);
}
