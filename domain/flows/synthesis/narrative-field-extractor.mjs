// Extracts narrative (non-numeric) meaning that already exists on
// VERIFIED Fact/Evidence records but is dropped by thin-structured-flow's
// calculationValue projection (which only carries fact.normalized_value).
// Every produced value carries provenance (fact_id/evidence_id and, where
// resolvable, source_document_id) and nothing here invents meaning beyond
// what the raw quoted text/attributes already state. Fields whose
// provenance cannot be resolved generically are reported as blockers
// instead of guessed.
import { deepFreeze } from "./deep-freeze.mjs";

// Turn M2 item 2: the four Answerability/Value-Status states are
// SEMANTICALLY DISTINCT (CLAUDE.md section 4/8) and must never share
// wording that reads as any other state:
//   - NOT_FOUND: the corpus was searched and nothing was found (a
//     retrieval/coverage gap -- something MIGHT exist but wasn't located).
//   - NOT_APPLICABLE: a structural absence -- this issuer's disclosure
//     format simply has no such line item at all (nothing to find).
//   - OUTSIDE_CORPUS: the only source that could answer this lies outside
//     the provided corpus entirely.
//   - WITHHELD: the issuer explicitly disclosed that this information is
//     confidential/deferred, not merely missing.
// Turn M's previous NOT_APPLICABLE wording ("해당 항목이 확인되지 않습니다")
// was ambiguous with NOT_FOUND ("확인되지 않았습니다") -- these must never
// collapse into the same reader-facing phrase again.
const STATUS_LABEL_KO = Object.freeze({
  NOT_FOUND: "제공된 코퍼스에서 해당 정보를 확인하지 못했습니다",
  NOT_APPLICABLE: "해당 공시 구조에서는 이 항목이 적용되지 않습니다",
  OUTSIDE_CORPUS: "해당 근거 문서는 제공된 코퍼스 범위 밖에 있습니다",
  WITHHELD: "해당 정보는 비공개 또는 유보 상태로 공시되었습니다",
});

function resolveSlotName(key) {
  if (key.endsWith("_value_status")) return key.slice(0, -"_value_status".length);
  if (key.endsWith("_status")) return key.slice(0, -"_status".length);
  return null;
}

function normalizeContent(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : text;
}

// Turn I §5: composite-key dedup for attribution/qualifier candidates --
// `claim type` (attribution vs qualifier -- implicit in which list this
// runs over, since the two are never mixed) + source kind + source ID +
// normalized content (whitespace/newline collapsed only; never a
// paraphrase-changing dedup). Handles two cases: (1) the exact same
// source producing the exact same sentence more than once (e.g. re-fetched
// via more than one slot path), and (2) two DIFFERENT sources that
// happen to carry byte-identical sentence text -- the user-facing
// sentence is still emitted only once, but every contributing source id
// is preserved in `merged_source_ids` so no provenance is silently lost.
function dedupCandidates(items) {
  const bySourceIdentity = new Map();
  for (const item of items) {
    const key = `${item.source}|${item.id}|${normalizeContent(item.text)}`;
    if (!bySourceIdentity.has(key)) bySourceIdentity.set(key, item);
  }
  const byContent = new Map();
  const result = [];
  for (const item of bySourceIdentity.values()) {
    const contentKey = normalizeContent(item.text);
    const existing = byContent.get(contentKey);
    if (!existing) {
      const merged = { ...item, merged_source_ids: [item.id] };
      byContent.set(contentKey, merged);
      result.push(merged);
    } else if (!existing.merged_source_ids.includes(item.id)) {
      existing.merged_source_ids.push(item.id);
    }
  }
  return result;
}

function buildSlotToFactId(slots) {
  const map = new Map();
  for (const slot of slots ?? []) {
    if (Array.isArray(slot.fact_ids) && slot.fact_ids.length > 0) map.set(slot.slot_name, slot.fact_ids[0]);
  }
  return map;
}

export function extractNarrativeFields({ facts = [], evidence = [], slots = [], signals }) {
  if (!signals) throw new TypeError("extractNarrativeFields requires planner signals");
  const factsById = new Map(facts.map((f) => [f.fact_id, f]));
  const evidenceById = new Map(evidence.map((e) => [e.evidence_id, e]));
  const slotToFactId = buildSlotToFactId(slots);

  const informationLimits = [];
  const blockers = [];
  for (const { key, value } of signals.information_limit_fields ?? []) {
    const slotName = resolveSlotName(key);
    const factId = slotName ? slotToFactId.get(slotName) : undefined;
    if (!factId || !factsById.has(factId)) {
      blockers.push({ field: key, status: value, reason: "no_slot_provenance" });
      continue;
    }
    const fact = factsById.get(factId);
    informationLimits.push({
      field: key,
      status: value,
      status_label_ko: STATUS_LABEL_KO[value] ?? value,
      fact_id: factId,
      metric_code: fact.metric_code ?? null,
      raw_label: fact.raw_label ?? null,
      scope: fact.scope ?? null,
      period_start: fact.period_start ?? null,
      period_end: fact.period_end ?? null,
    });
  }

  // Prefer a structured Fact-level attribution flag over the text
  // heuristic when one exists: today's real Fact schema does not carry
  // such a field, so this branch is currently unreachable on real data
  // (a data-contract limitation reported in this turn's blockers list),
  // but the heuristic marker list stays as the required fallback so
  // attribution isn't silently dropped in the meantime.
  function enrich(candidate) {
    if (candidate.source === "fact") {
      const fact = factsById.get(candidate.id);
      const structuredAttribution = typeof fact?.attributes?.attribution_type === "string" ? fact.attributes.attribution_type : null;
      return {
        ...candidate,
        fact_id: candidate.id,
        metric_code: fact?.metric_code ?? null,
        raw_label: fact?.raw_label ?? null,
        scope: fact?.scope ?? null,
        provenance: structuredAttribution ? "structured" : "heuristic",
        ...(structuredAttribution ? { structured_attribution_type: structuredAttribution } : {}),
      };
    }
    const item = evidenceById.get(candidate.id);
    return {
      ...candidate,
      evidence_id: candidate.id,
      document_id: item?.document_id ?? null,
      source_locator: item?.source_locator ?? null,
      provenance: "heuristic",
    };
  }

  const attributions = dedupCandidates((signals.attribution_candidates ?? []).map(enrich));
  const qualifiers = dedupCandidates((signals.qualifier_candidates ?? []).map(enrich));

  return deepFreeze({
    information_limits: informationLimits,
    attributions,
    qualifiers,
    blockers,
    provenance_complete: blockers.length === 0,
  });
}
