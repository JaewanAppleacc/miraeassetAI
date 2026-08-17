// Final Synthesis Validator: an ADDITIONAL defense layer in front of the
// existing Policy Guard / FinalResponse validator (does not replace
// either). Validates the Response Composer's returned answer + internal
// composition metadata BEFORE the Flow returns its outcome. Never reads
// Gold. On fabrication/unauthorized-ID risk it fails closed; on partial
// sub-request coverage it reports the gap explicitly instead of hiding it.
//
// Two independent layers of numeric/date grounding, both required:
//   1. CLAIM verification -- every VALUE/PERCENT/SHARES/DATE claim the
//      composer declares is re-derived from its named source (a Fact
//      field, a calculationValue key, or an Event field) and must match
//      EXACTLY (no rounding tolerance; only thousands-separator commas
//      are normalized). A claim sourced from an IDENTIFIER-shaped field
//      (corp_code, *_id, document/anchor_document_id) is rejected outright
//      -- identifiers can label a value, they can never BE one.
//   2. RESIDUAL scan -- composer's `scan_text` (identifier brackets and
//      verbatim quotes already masked out) is independently scanned for
//      any number/date token NOT covered by a declared claim. This is
//      the catch-all for a composer bug that renders a naked, unclaimed
//      number.
import { deepFreeze } from "./deep-freeze.mjs";
import { formatDisplayNumber, unitLabel } from "./number-formatting.mjs";
import { formatDirectionNarrative } from "./change-direction.mjs";

const FORBIDDEN_SUPERIORITY_PHRASES = ["더 우수", "더 낫", "경쟁력이 높", "투자 가치", "투자를 추천", "투자의견", "저평가", "고평가"];
const DATE_TOKEN_PATTERN = /\d{4}[-.]\d{2}[-.]\d{2}/g;
// Matches: comma-grouped integers (1,000 / 268,000,000,000), plain
// decimals with a short integer part (6.77 / 1.9 / 100.49), and bare
// integers of 2+ digits (500 / 100), each with an optional leading minus
// sign (a decrease like -38,791 must parse back to the SAME negative
// value as its claim, not silently lose the sign and become a positive
// residual mismatch). Deliberately does NOT match a lone single digit
// (e.g. a Korean disclosure's "3." list marker) so ordinary prose
// numbering in generated text isn't treated as a stray value.
const NUMBER_TOKEN_PATTERN = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\.\d+|-?\d{2,}/g;
const IDENTIFIER_FIELDS = new Set(["corp_code", "fact_id", "evidence_id", "event_id", "document_id", "anchor_document_id", "file_id", "quote_sha256"]);

// Turn M8: information_limits declarations (see domain/adapters/
// information-limit-vocabulary.mjs) get the same independent-
// verification treatment as every other Composer claim -- the validator
// never trusts the Composer's own bookkeeping, it re-derives against the
// authorized Fact universe. Internal enum tokens (reason_code/
// calculation_status) are the SAME closed, small literal set duplicated
// here for the identical one-directional layering reason documented on
// response-composer.mjs's own copy (domain/flows/ never statically
// imports domain/adapters/) -- grown only via an explicit version bump
// in all three copies together.
const INFORMATION_LIMIT_INTERNAL_ENUM_TOKENS = ["NOT_DIRECTLY_DISCLOSED", "DERIVED_CALCULATION_NOT_AVAILABLE"];
function verifyInformationLimitDeclarations(declarations, { factsById, authorizedFactIds, narrativeText }) {
  const reasons = [];
  for (const decl of declarations ?? []) {
    if (!subsetOf(decl.supporting_fact_ids, authorizedFactIds)) {
      reasons.push({ code: "INFORMATION_LIMIT_UNAUTHORIZED_SUPPORTING_FACT", detail: decl.target_metric_code });
    }
    const conflictingFact = [...factsById.values()].find((f) => f.metric_code === decl.target_metric_code);
    if (conflictingFact) {
      reasons.push({ code: "INFORMATION_LIMIT_CONFLICTS_WITH_DIRECT_FACT", detail: `${decl.target_metric_code}:${conflictingFact.fact_id}` });
    }
    if (typeof decl.rendered_sentence !== "string" || !narrativeText.includes(decl.rendered_sentence)) {
      reasons.push({ code: "INFORMATION_LIMIT_DECLARATION_DISAPPEARED", detail: decl.target_metric_code });
    }
  }
  for (const token of INFORMATION_LIMIT_INTERNAL_ENUM_TOKENS) {
    if (narrativeText.includes(token)) {
      reasons.push({ code: "INFORMATION_LIMIT_INTERNAL_ENUM_LEAKED", detail: token });
    }
  }
  return reasons;
}

function subsetOf(subset, superset) {
  const supSet = new Set(superset);
  return subset.every((id) => supSet.has(id));
}

function getPath(obj, dottedKey) {
  return dottedKey.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

// Independently re-derives each declared claim from its named source and
// requires an EXACT match (===) -- catches a composer bug that declares a
// claim pointing at the wrong/fabricated source, or at an identifier
// field masquerading as a value. NARRATIVE claims are exempt from this
// exact-match path: their value is a narrowed SENTENCE, not a literal
// Fact/Evidence field, so their real grounding check is "is this exact
// substring present in the declared source" -- already performed by
// verifyQuotedSpans() against preserved_attributions, which every
// NARRATIVE claim from renderAttributionSentences() has a matching entry
// in.
function verifyClaims(claims, { factsById, calculationValue, eventsById }) {
  const reasons = [];
  for (const claim of claims) {
    if (claim.type === "NARRATIVE") continue;
    if (claim.source?.field && IDENTIFIER_FIELDS.has(claim.source.field)) {
      reasons.push({ code: "IDENTIFIER_USED_AS_VALUE", detail: `claim type=${claim.type} sourced from identifier field "${claim.source.field}"` });
      continue;
    }
    const dateOrNumberCode = claim.type === "DATE" ? "UNGROUNDED_DATE" : "UNGROUNDED_NUMBER";
    if (claim.source?.kind === "fact") {
      const fact = factsById.get(claim.source.id);
      if (!fact) { reasons.push({ code: dateOrNumberCode, detail: `claim references unknown fact ${claim.source.id}` }); continue; }
      // Turn M10: dotted-path lookup (SAME getPath helper already used for
      // calculation-sourced claims) so a claim can be sourced from a
      // nested, explicit structured field (e.g.
      // "attributes.initial_planned_shares" -- a real, closed VERIFIED
      // Fact attribute convention) and still be independently re-derived
      // exactly, not just a top-level field. A plain top-level field name
      // (e.g. "normalized_value"/"as_of_date") behaves identically to the
      // old direct property access, so every pre-existing claim is
      // unaffected.
      const actual = getPath(fact, claim.source.field);
      if (actual !== claim.value) reasons.push({ code: dateOrNumberCode, detail: `claim ${JSON.stringify(claim.value)} does not exactly match fact.${claim.source.field}` });
    } else if (claim.source?.kind === "calculation") {
      const actual = getPath(calculationValue, claim.source.key);
      if (actual !== claim.value) reasons.push({ code: dateOrNumberCode, detail: `claim ${JSON.stringify(claim.value)} does not exactly match calculationValue.${claim.source.key}` });
    } else if (claim.source?.kind === "event") {
      const event = eventsById.get(claim.source.id);
      if (!event) { reasons.push({ code: dateOrNumberCode, detail: `claim references unknown event ${claim.source.id}` }); continue; }
      const actual = event[claim.source.field];
      if (actual !== claim.value) reasons.push({ code: dateOrNumberCode, detail: `claim ${JSON.stringify(claim.value)} does not exactly match event.${claim.source.field}` });
    } else {
      reasons.push({ code: dateOrNumberCode, detail: "claim has no recognized source kind" });
    }
  }
  return reasons;
}

// `display_value` (Turn I -- see number-formatting.mjs) is only ever set
// on calculation-sourced numeric claims where genuine Calculator
// arithmetic (DIFF/PERCENTAGE_CHANGE/...) can produce IEEE binary-float
// noise; fact/event-sourced claims never carry it, and skip this check
// entirely (`typeof claim.display_value === "string"` guards that). No
// tolerance/epsilon is introduced anywhere here -- both checks are exact:
// (a) the validator independently recomputes formatDisplayNumber from the
// ALREADY-exact-matched raw claim.value using the SAME shared function the
// composer used, so a drifted/hand-edited display_value is caught; (b)
// the exact display string must be a literal substring of the rendered
// narrative, so a value that was computed but never actually shown (or
// shown differently, e.g. from a second independent formatting call that
// silently diverged) is also caught.
function verifyDisplayValues(claims, narrativeText) {
  const reasons = [];
  for (const claim of claims) {
    if (typeof claim.display_value !== "string") continue;
    const expected = formatDisplayNumber(claim.value);
    if (claim.display_value !== expected) {
      reasons.push({ code: "DISPLAY_VALUE_MISMATCH", detail: `display_value ${JSON.stringify(claim.display_value)} does not match recomputed ${JSON.stringify(expected)}` });
      continue;
    }
    if (!narrativeText.includes(claim.display_value)) {
      reasons.push({ code: "DISPLAY_VALUE_NOT_RENDERED", detail: `display_value ${JSON.stringify(claim.display_value)} was declared but never found in the rendered narrative` });
    }
  }
  return reasons;
}

// Turn M2 item 4: independently re-derives each claim's direction
// sentence from the SAME shared function the composer used (single
// source of truth, exactly like verifyDisplayValues above), using
// claim.value (already exact-matched against its source Fact field by
// verifyClaims) and the unit resolved from that SAME source Fact -- never
// trusting a caller-supplied unit string. EXACT rule, no tolerance: the
// recomputed sentence must be byte-identical to the declared one, and
// that declared sentence must be a literal substring of narrative_text.
function verifyDirectionNarratives(claims, { factsById }, narrativeText) {
  const reasons = [];
  for (const claim of claims) {
    if (typeof claim.direction_narrative !== "string") continue;
    const fact = claim.source?.kind === "fact" ? factsById.get(claim.source.id) : null;
    const expected = fact ? formatDirectionNarrative(claim.value, unitLabel(fact.unit)) : null;
    if (expected === null || claim.direction_narrative !== expected) {
      reasons.push({ code: "DIRECTION_NARRATIVE_MISMATCH", detail: `direction_narrative ${JSON.stringify(claim.direction_narrative)} does not match recomputed ${JSON.stringify(expected)}` });
      continue;
    }
    if (!narrativeText.includes(claim.direction_narrative)) {
      reasons.push({ code: "DIRECTION_NARRATIVE_NOT_RENDERED", detail: `direction_narrative ${JSON.stringify(claim.direction_narrative)} was declared but never found in the rendered narrative` });
    }
  }
  return reasons;
}

// Scans the masked scan_text for any number/date token not accounted for
// by a declared, already-independently-verified claim. Exact match only
// -- no rounding -- so a fabricated "100원"/"100.4원" next to a real
// 100.49 claim is never mistaken for the real value, and comma-grouped
// display ("1,000") is treated as identical to its canonical form (1000).
function findResidualUngroundedTokens(scanText, claims) {
  const knownDates = new Set(claims.filter((c) => c.type === "DATE").map((c) => String(c.value)));
  // Prefer the claim's verified display_value (already independently
  // re-derived and confirmed present by verifyDisplayValues) as the
  // "known" comparable number where one exists, since that -- not the raw
  // IEEE value -- is what actually appears in scan_text. Claims without a
  // display_value (fact/event-sourced; no arithmetic, no noise risk) keep
  // comparing against the exact raw value as before.
  // Turn M2 item 4: a direction_narrative claim renders the ABSOLUTE
  // magnitude in text (the sign is expressed via the 증가/감소 word, not
  // a literal "-" character) -- so the scanned token to compare against
  // is Math.abs(claim.value), never the raw signed value. This mirrors
  // the pre-existing display_value preference below (a claim declares
  // which numeric FORM actually appears in the rendered text).
  const knownValues = new Set(
    claims.filter((c) => c.type !== "DATE" && typeof c.value === "number")
      .map((c) => {
        if (typeof c.display_value === "string") return Number(c.display_value.replaceAll(",", ""));
        if (typeof c.direction_narrative === "string") return Math.abs(c.value);
        return c.value;
      })
  );

  const residualDates = [...scanText.matchAll(DATE_TOKEN_PATTERN)].map((m) => m[0]).filter((d) => !knownDates.has(d));
  const textWithoutDates = scanText.replace(DATE_TOKEN_PATTERN, " ");
  const residualNumbers = [...textWithoutDates.matchAll(NUMBER_TOKEN_PATTERN)]
    .map((m) => m[0])
    .filter((raw) => !knownValues.has(Number(raw.replaceAll(",", ""))));

  return { residualDates, residualNumbers };
}

// Attribution/qualifier sentences quote VERIFIED source text verbatim --
// this independently re-checks that the quoted span really is an exact
// substring of the Fact/Evidence text it claims to come from (not just
// trusting the composer's self-report).
function verifyQuotedSpans(items, { factsById, evidenceById }, code) {
  const reasons = [];
  for (const item of items) {
    let sourceText = null;
    if (item.fact_id) sourceText = factsById.get(item.fact_id)?.raw_value_text ?? null;
    else if (item.evidence_id) sourceText = evidenceById.get(item.evidence_id)?.quoted_text ?? null;
    if (typeof sourceText !== "string" || !sourceText.includes(item.text)) {
      reasons.push({ code, detail: `quoted span not verbatim in source ${item.fact_id ?? item.evidence_id ?? "unknown"}` });
    }
  }
  return reasons;
}

function subsetReasons(composerOutput, authorizedFactIds, authorizedEventIds, authorizedEvidenceIds) {
  const reasons = [];
  if (!subsetOf(composerOutput.used_fact_ids, authorizedFactIds)) reasons.push({ code: "UNAUTHORIZED_FACT_ID", detail: "used_fact_ids not subset of authorized facts" });
  if (!subsetOf(composerOutput.used_event_ids, authorizedEventIds)) reasons.push({ code: "UNAUTHORIZED_EVENT_ID", detail: "used_event_ids not subset of authorized events" });
  if (!subsetOf(composerOutput.used_evidence_ids, authorizedEvidenceIds)) reasons.push({ code: "UNAUTHORIZED_EVIDENCE_ID", detail: "used_evidence_ids not subset of authorized evidence" });
  return reasons;
}

export function validateSynthesis({
  composerOutput, signals, calculationValue = {}, facts = [], evidence = [], events = [],
  authorizedFactIds, authorizedEventIds, authorizedEvidenceIds,
}) {
  if (!composerOutput || !signals) throw new TypeError("validateSynthesis requires composerOutput and signals");

  const factsById = new Map(facts.map((f) => [f.fact_id, f]));
  const eventsById = new Map(events.map((e) => [e.event_id, e]));
  const evidenceById = new Map(evidence.map((e) => [e.evidence_id, e]));

  const reasons = [
    ...subsetReasons(composerOutput, authorizedFactIds, authorizedEventIds, authorizedEvidenceIds),
    ...verifyClaims(composerOutput.numeric_claims ?? [], { factsById, calculationValue, eventsById }),
    ...verifyDisplayValues(composerOutput.numeric_claims ?? [], composerOutput.narrative_text ?? ""),
    ...verifyDirectionNarratives(composerOutput.numeric_claims ?? [], { factsById }, composerOutput.narrative_text ?? ""),
    ...verifyQuotedSpans(composerOutput.preserved_attributions ?? [], { factsById, evidenceById }, "ATTRIBUTION_NOT_VERBATIM"),
    ...verifyQuotedSpans(composerOutput.preserved_qualifiers ?? [], { factsById, evidenceById }, "QUALIFIER_NOT_VERBATIM"),
    ...verifyQuotedSpans(composerOutput.preserved_narrative_sources ?? [], { factsById, evidenceById }, "NARRATIVE_SOURCE_NOT_VERBATIM"),
    ...verifyInformationLimitDeclarations(composerOutput.information_limit_declarations ?? [], { factsById, authorizedFactIds, narrativeText: composerOutput.narrative_text ?? "" }),
  ];

  const { residualDates, residualNumbers } = findResidualUngroundedTokens(composerOutput.scan_text ?? "", composerOutput.numeric_claims ?? []);
  if (residualNumbers.length > 0) reasons.push({ code: "UNGROUNDED_NUMBER", detail: `numbers not traceable to a declared claim: ${residualNumbers.join(", ")}` });
  if (residualDates.length > 0) reasons.push({ code: "UNGROUNDED_DATE", detail: `dates not traceable to a declared claim: ${residualDates.join(", ")}` });

  for (const item of composerOutput.preserved_information_limits ?? []) {
    if (!composerOutput.narrative_text.includes(item.status_label_ko)) reasons.push({ code: "INFORMATION_LIMIT_DISAPPEARED", detail: `field ${item.field}` });
  }
  // Turn M2 item 8: the attribution wrapper's exact wording is now
  // "회사는 \"...\"라고 밝혔습니다/판단했습니다." (see response-composer.mjs's
  // attributionVerb) rather than Turn M's "회사가 스스로 밝힌 내용: ...". This
  // check accepts EITHER verb ending -- it never re-derives which one a
  // specific item should use (that choice already belongs to the
  // composer); it only guards against the sentence collapsing into an
  // unattributed, objective-sounding claim.
  for (const item of composerOutput.preserved_attributions ?? []) {
    const hasAttributionFraming = composerOutput.narrative_text.includes("라고 밝혔습니다") || composerOutput.narrative_text.includes("라고 판단했습니다");
    if (!composerOutput.narrative_text.includes(item.text) || !hasAttributionFraming) {
      reasons.push({ code: "ATTRIBUTION_FLATTENED", detail: `${item.source}:${item.fact_id ?? item.evidence_id ?? item.id}` });
    }
  }
  for (const item of composerOutput.preserved_qualifiers ?? []) {
    if (!composerOutput.narrative_text.includes(item.text)) reasons.push({ code: "QUALIFIER_DISAPPEARED", detail: `${item.source}:${item.fact_id ?? item.evidence_id ?? item.id}` });
  }
  // Turn M3 item 8: a VERIFIED narrative Fact's own raw_value_text must
  // keep its distinct "정기공시에는 ...라고 기재되어 있습니다." framing --
  // never collapse into the attribution wrapper (that would misrepresent
  // a plain disclosed fact as the company's own stated judgment) and
  // never silently disappear.
  for (const item of composerOutput.preserved_narrative_sources ?? []) {
    if (!composerOutput.narrative_text.includes(item.text) || !composerOutput.narrative_text.includes("라고 기재되어 있습니다")) {
      reasons.push({ code: "NARRATIVE_SOURCE_DISAPPEARED", detail: `fact:${item.fact_id}` });
    }
  }

  const foundForbidden = FORBIDDEN_SUPERIORITY_PHRASES.filter((phrase) => composerOutput.narrative_text.includes(phrase));
  if (foundForbidden.length > 0) reasons.push({ code: "PROHIBITED_SUPERIORITY_CLAIM", detail: foundForbidden.join(", ") });
  if (signals.comparison_basis_mismatch && !composerOutput.applied_capabilities.includes("NEUTRAL_COMPARABILITY_CAVEAT")) {
    reasons.push({ code: "MISSING_COMPARABILITY_CAVEAT", detail: "comparison_basis_mismatch signal active without a rendered caveat" });
  }

  const fatalCodes = new Set([
    "UNAUTHORIZED_FACT_ID", "UNAUTHORIZED_EVENT_ID", "UNAUTHORIZED_EVIDENCE_ID",
    "UNGROUNDED_NUMBER", "UNGROUNDED_DATE", "IDENTIFIER_USED_AS_VALUE",
    "DISPLAY_VALUE_MISMATCH", "DISPLAY_VALUE_NOT_RENDERED",
    "DIRECTION_NARRATIVE_MISMATCH", "DIRECTION_NARRATIVE_NOT_RENDERED",
    "ATTRIBUTION_NOT_VERBATIM", "QUALIFIER_NOT_VERBATIM", "NARRATIVE_SOURCE_NOT_VERBATIM",
    "INFORMATION_LIMIT_DISAPPEARED", "ATTRIBUTION_FLATTENED", "QUALIFIER_DISAPPEARED", "NARRATIVE_SOURCE_DISAPPEARED",
    "PROHIBITED_SUPERIORITY_CLAIM", "MISSING_COMPARABILITY_CAVEAT",
    "INFORMATION_LIMIT_UNAUTHORIZED_SUPPORTING_FACT", "INFORMATION_LIMIT_CONFLICTS_WITH_DIRECT_FACT",
    "INFORMATION_LIMIT_DECLARATION_DISAPPEARED", "INFORMATION_LIMIT_INTERNAL_ENUM_LEAKED",
  ]);
  const fatalReasons = reasons.filter((r) => fatalCodes.has(r.code));
  if (fatalReasons.length > 0) {
    return deepFreeze({ status: "FAIL_CLOSED", reasons: fatalReasons, missing_capabilities: [], not_implemented_capabilities: [] });
  }

  const notImplemented = composerOutput.not_implemented_capabilities ?? [];
  const missingCapabilities = signals.required_capabilities.filter(
    (c) => !composerOutput.applied_capabilities.includes(c) && !notImplemented.includes(c)
  );
  const requiredNotImplemented = signals.required_capabilities.filter((c) => notImplemented.includes(c));
  if (missingCapabilities.length > 0 || requiredNotImplemented.length > 0) {
    return deepFreeze({ status: "PARTIAL", reasons: [], missing_capabilities: missingCapabilities, not_implemented_capabilities: requiredNotImplemented });
  }

  // Turn M8: an information_limit declaration means the user's request
  // was NOT fully answerable (a requested, Owner-approved metric has no
  // direct-disclosure Fact) even though the declaration itself rendered
  // correctly and every other check above passed -- PASS would falsely
  // claim completeness. This is a status-only downgrade (no
  // missing_capabilities/reasons entry -- the declaration disclosed
  // itself honestly and fatal-checked clean above; it is PARTIAL by
  // definition, not by a caught defect).
  const informationLimitDeclarations = composerOutput.information_limit_declarations ?? [];
  if (informationLimitDeclarations.length > 0) {
    return deepFreeze({
      status: "PARTIAL", reasons: [], missing_capabilities: [], not_implemented_capabilities: [],
      information_limit_declarations: informationLimitDeclarations.map((d) => ({
        target_metric_code: d.target_metric_code, reason_code: d.reason_code,
        supporting_fact_ids: d.supporting_fact_ids, calculation_status: d.calculation_status,
      })),
    });
  }

  return deepFreeze({ status: "PASS", reasons: [], missing_capabilities: [], not_implemented_capabilities: [] });
}
