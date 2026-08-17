// Common Response Composer: turns already-validated structured data
// (facts/events/evidence/calculationValue), the generic Planner signals,
// and the Narrative Field Extractor's output into a natural-language
// answer. Pure function -- no service calls, no Gold access, no
// question_id/company branching. Sentence generation uses only generic
// structural template fragments (comparison/timeline/latest-state/
// information-limit/attribution/caveat categories); it never stores a
// specific question's finished answer text.
//
// Every VALUE/PERCENT/SHARES/DATE assertion the composer renders in
// GENERATED text is also recorded as a typed `numeric_claim` naming its
// exact source (a Fact field, a calculationValue key, or an Event field).
// IDENTIFIER-shaped fields (corp_code, document/anchor_document_id,
// fact/evidence/event ids) are NEVER wrapped in a claim and are always
// masked out of `scan_text` (the copy of the narrative the Final
// Synthesis Validator scans for stray numbers) -- they may be displayed
// to the reader as labels, but they can never ground a monetary/percent/
// share value. Verbatim-quoted attribution/qualifier spans are likewise
// masked in `scan_text` (they are exact substrings of an already-VERIFIED
// Fact/Evidence text, not composer-authored numbers) but the validator
// independently re-checks that they really are verbatim substrings of
// their declared source.
import { deepFreeze } from "./deep-freeze.mjs";
import { evaluateSubRequestCoverage } from "./sub-request-coverage.mjs";
import { evaluateSubRequestCoverageV2 } from "./sub-request-coverage-v2.mjs";
import { formatDisplayNumber, unitLabel } from "./number-formatting.mjs";
import { inferDateRole, resolveDateValue } from "./date-role-labeling.mjs";
import { naturalizeFactEnum, naturalizeEventType, naturalizeEventStatus, naturalizeFieldLabel } from "./natural-label.mjs";
import { topicParticle, subjectParticle, withConjunction, withDirection, withTopic } from "./korean-particles.mjs";
import { hasComparisonBasis, formatDirectionNarrative } from "./change-direction.mjs";
import { isTerminationVsContractAmountPair } from "./contract-amount-role.mjs";
import { detectWithheldToDisclosedOnlyChanges } from "./withheld-disclosure-detection.mjs";
import { splitSentences } from "./synthesis-signal-planner.mjs";

const IDENTIFIER_PLACEHOLDER = "[ID]";
// Turn M3 item 8: a "single real disclosure sentence" length budget for
// narrative-source rendering -- generous enough for a genuine multi-
// clause Korean sentence (dates + counts + amounts), far short of a
// multi-paragraph procedural quote (e.g. a referral-to-another-filing
// notice), so a long raw_value_text is narrowed to its individual
// sentences rather than dumped whole.
const NARRATIVE_SOURCE_MAX_CHARS = 160;
const NARRATIVE_SOURCE_MIN_CHARS = 6;

function unique(values) { return [...new Set(values)]; }
// Turn M capability G: generic content dedup for a paired (display,
// scan) line list -- keeps the FIRST occurrence of each distinct line,
// dropping later repeats from both arrays at the same index so they stay
// in sync. Never a paraphrase-aware dedup (that would risk conflating
// two genuinely different sentences); the dedup key only collapses
// whitespace RUNS (real disclosure source text carries irregular
// multi-space gaps -- e.g. "취득한 자기주식     전량에" -- so two renders
// of the SAME underlying quote could otherwise differ by whitespace
// alone and slip past a byte-for-byte comparison) -- every other
// character must still match exactly.
function dedupExactLines(displayLines, scanLines) {
  const seen = new Set();
  const outDisplay = []; const outScan = [];
  for (let i = 0; i < displayLines.length; i++) {
    const key = displayLines[i].trim().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    outDisplay.push(displayLines[i]);
    outScan.push(scanLines[i] ?? displayLines[i]);
  }
  return { displayLines: outDisplay, scanLines: outScan };
}
function renderNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? value.toLocaleString("ko-KR") : String(value);
}
// The real VERIFIED Fact corpus is NOT consistent about whether `unit`
// holds the enum token ("PERCENT"/"SHARES") or the raw Korean/symbol
// label directly ("%"/"주"/"개") -- both forms are observed across real
// facts (confirmed by direct inspection of the VERIFIED_FACT artifact).
// Recognizing only the enum token silently miscategorized every "%"/"주"-
// labeled Fact as a generic VALUE claim, which made any PERCENT/SHARES
// required_output_binding permanently unsatisfiable for those facts even
// though the value itself renders correctly. This must not be "fixed" by
// touching Fact data (forbidden) -- only by recognizing both forms here.
const PERCENT_UNIT_TOKENS = new Set(["PERCENT", "%"]);
const SHARES_UNIT_TOKENS = new Set(["SHARES", "주", "개"]);
function claimTypeForUnit(unit) {
  if (PERCENT_UNIT_TOKENS.has(unit)) return "PERCENT";
  if (SHARES_UNIT_TOKENS.has(unit)) return "SHARES";
  return "VALUE";
}
// A string-valued Fact (an enum-like lifecycle status, a compressed
// correction-timeline summary, a contract-identity string, ...) is
// classified STATUS when its own metric_code/slot naming says so
// (generic suffix convention already used project-wide -- "*_status"),
// else NARRATIVE. This is a naming-shape rule, never a per-question one.
function claimTypeForStringFact(fact) {
  const name = `${fact.metric_code ?? ""}`.toLowerCase();
  return name.endsWith("status") ? "STATUS" : "NARRATIVE";
}

function comparisonBaseNames(dimensions) {
  return unique(dimensions.map((k) => k.replace(/_(diff_krw|diff_percent|diff_pp|change_percent|winner)$/, "")));
}

// The ONLY place a corp_code is turned into a human-readable company
// label: prefer the request-scoped, request-injected companyLabels map
// (CompanyResolver output). If it does not resolve, this returns null --
// a bare corp_code is NEVER used as a stand-in company name (a numeric
// identifier is not something an end reader could recognize as a name,
// and treating it as one is itself a trust-boundary leak). The caller is
// responsible for treating a null return as an unresolved entity, never
// silently proceeding as if a name was shown.
function resolveCompanyLabel(corpCode, companyLabels) {
  if (typeof corpCode !== "string" || corpCode === "") return null;
  return companyLabels?.[corpCode]?.corp_name ?? null;
}
const UNRESOLVED_ENTITY_LABEL = "미해결 기업";

// A small, complete lookup keyed by exactly the pairing of Calculator's
// own frozen CALCULATOR_FORMULAS (domain/runtime/agent-runtime.mjs) with
// a typed claim output_kind (VALUE/PERCENT/SHARES) -- NOT by any
// per-question calculation key. This is the ONLY place that decides
// wording/unit-suffix for a computed pair, and it never grows a new entry
// keyed on a specific Seed calculation key; a formula/output_kind
// combination this Flow has simply never exercised yet (e.g. RATIO+SHARES)
// still renders safely via FALLBACK_SENTENCE below rather than being
// treated as an error or a reason to withhold/degrade the response.
const DISPLAY_OPERATION_BY_FORMULA = Object.freeze({
  DIFF: "ABSOLUTE_DIFFERENCE", PERCENTAGE_CHANGE: "PERCENTAGE_CHANGE", SUM: "SUM", RATIO: "RATIO",
});
// Turn M4 item 4A: the literal string "와(과)" is NOT a particle -- it is
// both Korean conjunction particle FORMS concatenated together, a
// placeholder that was never actually resolved. Every template below now
// calls withConjunction(a) (batchim-aware, same generic particle library
// used everywhere else in this file) so the real particle is picked from
// whatever `a` actually ends with -- including a closing paren/digit/
// Latin abbreviation, which withConjunction's own batchim detector
// already treats correctly (falls back to the no-batchim form, exactly
// like every other particle call in this codebase).
const REGISTRY_SENTENCE_TEMPLATES = Object.freeze({
  "ABSOLUTE_DIFFERENCE:VALUE": (a, b, n, unit) => `${withConjunction(a)} ${b}의 차이는 ${n}${unit}입니다.`,
  "ABSOLUTE_DIFFERENCE:PERCENT": (a, b, n) => `${withConjunction(a)} ${b}의 차이는 ${n}%p입니다.`,
  "ABSOLUTE_DIFFERENCE:SHARES": (a, b, n, unit) => `${withConjunction(a)} ${b}의 차이는 ${n}${unit}입니다.`,
  "PERCENTAGE_CHANGE:PERCENT": (a, b, n) => `${a}에서 ${withDirection(b)} 변화율은 ${n}%입니다.`,
  "SUM:VALUE": (a, b, n, unit) => `${withConjunction(a)} ${b}의 합계는 ${n}${unit}입니다.`,
  "SUM:PERCENT": (a, b, n) => `${withConjunction(a)} ${b}의 합계는 ${n}%입니다.`,
  "RATIO:VALUE": (a, b, n, unit) => `${withConjunction(a)} ${b}의 비율은 ${n}${unit}입니다.`,
  "RATIO:PERCENT": (a, b, n) => `${withConjunction(a)} ${b}의 비율은 ${n}%입니다.`,
});
function displayUnitFor(outputKind, displayOperation, inputUnit) {
  if (outputKind === "PERCENT") return displayOperation === "ABSOLUTE_DIFFERENCE" ? "%p" : "%";
  return unitLabel(inputUnit);
}

// Baseline disclosed-value statement: every VERIFIED fact -- numeric
// (VALUE/PERCENT/SHARES) OR string (STATUS/NARRATIVE, e.g. a lifecycle
// status enum, a compressed correction-timeline summary, a contract-
// identity string) -- must be stated regardless of multiplicity (never
// omit a disclosed value just because there's only one of it, and never
// silently drop a non-numeric Fact just because it isn't a number). When
// the multiplicity signal is active, each line is additionally labeled
// with its entity/period so values are never mixed without attribution.
// A string value is treated as an opaque claim (like the pre-existing
// calculationValue-string handling in renderLatestStateSentences): the
// whole string is claimed against fact.normalized_value verbatim and
// masked in scan_text, rather than token-parsed -- it may itself contain
// many embedded numbers/dates (a compressed multi-date timeline summary,
// for instance) that are not independently re-derivable claims.
//
// `companyLabels` (optional): a request-scoped corp_code -> {corp_name,
// listed_name} map, as returned by CompanyResolver.resolve() calls made
// by the CALLER (never a raw directory path handed to the composer
// itself -- see domain/adapters/seed-company-resolver.mjs). When a
// corp_code resolves, its human-readable corp_name is used as the label;
// otherwise the label falls back to fact.company_name (if the Fact
// happens to carry one) and finally the bare corp_code. A resolved
// company name is NEVER treated as a numeric grounding source (it's a
// string), and the identifier bracket is masked wholesale in scan_text
// regardless of which label was used, so neither a bare corp_code nor a
// resolved name can leak into the grounding scan as if it were a value.
// This function never invents a label from question text.
// Turn M capability A: builds the date TEXT plus its inferred ROLE LABEL
// for one Fact -- a real period (period_start != period_end) keeps the
// tilde-range format with the generic "기간" role (unchanged behavior);
// any other date-bearing Fact is labeled with inferDateRole's specific
// role (공시일/보고일/기준일/결정일/계약 체결일/해지일/사건 발생일), never
// the previous unconditional "기간" mislabel. `confident: false` is
// surfaced to the caller so an internal-only PARTIAL reason can be
// recorded -- the reader still sees the conservative "기준일" label, just
// never presented with false confidence internally.
function formatFactDateInfo(fact, linkedEvent = null) {
  const dateRole = inferDateRole(fact, linkedEvent);
  if (dateRole.role === "PERIOD") {
    return { text: `${fact.period_start ?? ""}~${fact.period_end ?? ""}`, roleLabel: dateRole.roleLabel, confident: true, isPeriod: true };
  }
  const singleDate = resolveDateValue(fact, linkedEvent);
  if (!singleDate) return { text: "", roleLabel: null, confident: true, isPeriod: false };
  return { text: singleDate, roleLabel: dateRole.roleLabel, confident: dateRole.confident, isPeriod: false };
}

// Turn M10: mirrors resolveDateValue's own *_STATUS + linked-Event
// precedence, but returns a CLAIM source descriptor instead of a plain
// value -- so the Final Synthesis Validator re-derives against the SAME
// record the text actually came from (an Event's own event_date, not the
// Fact's as_of_date) whenever the override applies. Never a second,
// independent decision about WHEN to override; this only decides WHAT to
// claim after formatFactDateInfo/resolveDateValue already decided.
function dateClaimSourceFor(fact, linkedEvent) {
  if (resolveDateValue(fact, linkedEvent) === linkedEvent?.event_date && linkedEvent?.event_date != null) {
    return { kind: "event", id: linkedEvent.event_id, field: "event_date" };
  }
  return { kind: "fact", id: fact.fact_id, field: "as_of_date" };
}

// Turn M10: a real disclosure often states an investment amount alongside
// its OWN purpose/target-asset in the SAME filing item -- but the three
// values arrive as three separate VERIFIED Facts, and rendering each
// independently (in whatever order the request happened to load them)
// reads as if two separate investment items had cross-attributed
// purposes/targets. This groups the CLOSED, approved-ontology triad
// {INVESTMENT_AMOUNT, INVESTMENT_PURPOSE, INVESTMENT_TARGET_ASSET} by
// (corp_code, source_document_id) -- an explicit field every real
// disclosure item already carries, never a heuristic inferred from
// question text, slot naming, or array position. Deliberately narrow:
// this NEVER treats a shared source_document_id as a universal "same
// item" signal for any OTHER metric_code family (see the module-level
// scoping via INVESTMENT_DISCLOSURE_GROUP_METRIC_CODES below). When a
// bucket contains more than one Fact of the SAME role (e.g. two amounts
// sharing one document_id with no way to tell which purpose/target pairs
// with which), grouping is refused rather than guessed -- those Facts are
// returned in `ambiguousFactIds` so the caller can fall back to ordinary
// per-fact rendering and report a PLAN_AUTHORING_REVIEW_REQUIRED warning,
// never a silently-invented pairing.
//
// Turn M10.1: a bucket that has an INVESTMENT_AMOUNT but no
// INVESTMENT_PURPOSE and no INVESTMENT_TARGET_ASSET at all is not a real
// "disclosure item" to combine -- it is a single Fact, and combining it
// with nothing produces a group renderer output that is byte-different
// from (and no more informative than) the ordinary per-fact rendering
// that Fact would otherwise get. The group renderer is used ONLY when a
// bucket pairs exactly one amount with at least one purpose/target (each
// role still capped at one -- 2+ of the SAME role stays ambiguous/
// fail-closed exactly as before). A bucket that simply doesn't meet this
// (no amount, or an amount with no purpose/target companion) is neither a
// group nor "ambiguous" -- it is left out of both return lists entirely,
// so its Facts fall through to the caller's ordinary per-fact rendering
// path unchanged, with no PLAN_AUTHORING_REVIEW_REQUIRED warning (that
// warning is reserved for a genuine same-role conflict, not "not enough
// to group").
const INVESTMENT_DISCLOSURE_GROUP_METRIC_CODES = Object.freeze(["INVESTMENT_AMOUNT", "INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET"]);
function groupInvestmentDisclosureItems(facts) {
  const triadFacts = facts.filter((f) => INVESTMENT_DISCLOSURE_GROUP_METRIC_CODES.includes(f.metric_code));
  const buckets = new Map();
  for (const f of triadFacts) {
    const key = `${f.corp_code ?? ""}|${f.source_document_id ?? ""}`;
    const list = buckets.get(key) ?? [];
    list.push(f);
    buckets.set(key, list);
  }
  const groups = []; const ambiguousFactIds = [];
  // Deterministic, array-position-independent group ORDER: sorted by the
  // bucket key itself (corp_code|source_document_id), never by which
  // fact happened to appear first in the input array.
  for (const key of [...buckets.keys()].sort()) {
    const bucketFacts = buckets.get(key);
    const amounts = bucketFacts.filter((f) => f.metric_code === "INVESTMENT_AMOUNT");
    const purposes = bucketFacts.filter((f) => f.metric_code === "INVESTMENT_PURPOSE");
    const targets = bucketFacts.filter((f) => f.metric_code === "INVESTMENT_TARGET_ASSET");
    if (amounts.length > 1 || purposes.length > 1 || targets.length > 1) {
      ambiguousFactIds.push(...bucketFacts.map((f) => f.fact_id));
      continue;
    }
    if (amounts.length !== 1 || (purposes.length === 0 && targets.length === 0)) continue;
    groups.push({ key, amount: amounts[0], purpose: purposes[0] ?? null, target: targets[0] ?? null });
  }
  return { groups, ambiguousFactIds };
}

// Renders one combined line per successfully-formed group -- 대상 -> 금액
// -> 목적 order (Section 3's requested shape), never depending on which
// of the three facts happened to be visited first. Each present member
// still produces its own typed claim (VALUE for the amount, NARRATIVE for
// purpose/target -- the SAME claim shapes renderValueLines already uses
// for these Facts individually), so grounding/masking is unaffected by
// combining their display into one line.
function renderInvestmentDisclosureGroupLines(groups, companyLabels, eventsById) {
  const lines = []; const scanLines = []; const claims = []; const usedFactIds = [];
  for (const group of groups) {
    const memberFacts = [group.target, group.amount, group.purpose].filter(Boolean);
    if (memberFacts.length === 0) continue;
    const parts = []; const scanParts = [];
    let dateText = null; let dateRoleLabel = null;
    for (const f of memberFacts) usedFactIds.push(f.fact_id);
    const primaryFact = memberFacts[0];
    const linkedEvent = primaryFact.event_id ? eventsById.get(primaryFact.event_id) ?? null : null;
    const dateInfo = formatFactDateInfo(primaryFact, linkedEvent);
    if (dateInfo.text) { dateText = dateInfo.text; dateRoleLabel = dateInfo.roleLabel; }

    if (group.target) {
      const label = naturalizeFieldLabel(group.target.raw_label ?? group.target.metric_code);
      parts.push(`${label}: ${group.target.normalized_value}`);
      scanParts.push(`${label}: ${IDENTIFIER_PLACEHOLDER}`);
      claims.push({ type: "NARRATIVE", value: group.target.normalized_value, source: { kind: "fact", id: group.target.fact_id, field: "normalized_value", opaque_string: true } });
    }
    if (group.amount) {
      const label = naturalizeFieldLabel(group.amount.raw_label ?? group.amount.metric_code);
      const unit = unitLabel(group.amount.unit);
      const valueText = `${renderNumber(group.amount.normalized_value)}${unit ? ` ${unit}` : ""}`;
      parts.push(`${label}: ${valueText}`);
      scanParts.push(`${label}: ${valueText}`);
      claims.push({ type: claimTypeForUnit(group.amount.unit), value: group.amount.normalized_value, source: { kind: "fact", id: group.amount.fact_id, field: "normalized_value" } });
    }
    if (group.purpose) {
      const label = naturalizeFieldLabel(group.purpose.raw_label ?? group.purpose.metric_code);
      parts.push(`${label}: ${group.purpose.normalized_value}`);
      scanParts.push(`${label}: ${IDENTIFIER_PLACEHOLDER}`);
      claims.push({ type: "NARRATIVE", value: group.purpose.normalized_value, source: { kind: "fact", id: group.purpose.fact_id, field: "normalized_value", opaque_string: true } });
    }
    const entity = resolveCompanyLabel(primaryFact.corp_code, companyLabels);
    const entityBracket = entity ? `[${entity}${dateText ? ` / ${dateRoleLabel} ${dateText}]` : "]"} ` : "";
    const scanEntityBracket = entity ? `[${IDENTIFIER_PLACEHOLDER}${dateText ? ` / ${dateRoleLabel} ${dateText}]` : "]"} ` : "";
    lines.push(`- ${entityBracket}${parts.join(", ")}`);
    scanLines.push(`- ${scanEntityBracket}${scanParts.join(", ")}`);
    if (dateText) {
      claims.push({ type: "DATE", value: dateText, source: dateClaimSourceFor(primaryFact, linkedEvent) });
    }
  }
  return { lines, scanLines, claims, usedFactIds };
}

// Turn M10: the shared structured-query layer returns FACT records
// sorted by known_at DESCENDING (most recently known first) -- a
// deliberate, shared convention this module does not change. For a
// multi-step correction/lifecycle sequence sharing the SAME metric_code
// (2+ Facts), that order reads backwards. This is a STABLE, GROUP-SCOPED
// re-sort: Facts sharing a metric_code are reordered ascending by
// as_of_date; Facts with a DIFFERENT metric_code keep their original
// relative order untouched. Never a global chronological sort of the
// whole request (which would scramble unrelated same-period comparison
// pairs that are deliberately NOT a sequence).
//
// Turn M10.1: Owner review found the previous implementation mixed two
// incomparable orderings into a single Array.sort comparator (index
// difference when metric_code differs, date difference when it matches),
// which is not guaranteed transitive across 3+ interleaved metric_code
// families and can produce a comparator-dependent, engine-specific
// result. This replaces it with an explicit two-pass technique that
// cannot be non-transitive: (1) collect each metric_code's Facts AND the
// exact original array positions they occupy; (2) for any metric_code
// with 2+ Facts, stably sort ONLY that group's Facts by as_of_date
// ascending (equal/missing dates keep the group's own original relative
// order); (3) write the sorted Facts back into EXACTLY the positions
// that metric_code already occupied. A metric_code with only 1 Fact is
// left untouched. Positions belonging to other metric_code families are
// never read or written, so their relative order is unchanged by
// construction, not by comparator behavior.
export function sortFactFamiliesChronologically(facts) {
  const positionsByMetric = new Map();
  facts.forEach((f, i) => {
    const list = positionsByMetric.get(f.metric_code) ?? [];
    list.push(i);
    positionsByMetric.set(f.metric_code, list);
  });
  const result = [...facts];
  for (const positions of positionsByMetric.values()) {
    if (positions.length < 2) continue;
    // Missing dates carry no ordering evidence. Keep those Facts in their
    // exact original positions and sort only dated Facts into the positions
    // previously occupied by other dated Facts in the same metric family.
    // This avoids silently moving an undated disclosure across a dated one.
    const datedEntries = positions
      .map((originalIndex, groupOrder) => ({ f: facts[originalIndex], groupOrder }))
      .filter((entry) => typeof entry.f.as_of_date === "string" && entry.f.as_of_date !== "");
    if (datedEntries.length < 2) continue;
    const datedPositions = datedEntries.map((entry) => positions[entry.groupOrder]);
    const sortedDatedFacts = datedEntries
      .sort((a, b) => {
        const dateA = a.f.as_of_date;
        const dateB = b.f.as_of_date;
        if (dateA !== dateB) return dateA < dateB ? -1 : 1;
        return a.groupOrder - b.groupOrder;
      })
      .map((entry) => entry.f);
    datedPositions.forEach((originalIndex, k) => { result[originalIndex] = sortedDatedFacts[k]; });
  }
  return result;
}

function renderValueLines(facts, multiplicityRequiresLabels, companyLabels, eventsById = new Map()) {
  const lines = []; const scanLines = []; const claims = []; const usedFactIds = []; const warnings = [];
  const usedCompanyCodes = new Set(); const resolvedCompanyLabels = []; const unresolvedCompanyCodes = new Set();
  const narrativeSources = [];
  for (const fact of facts) {
    const linkedEvent = fact.event_id ? eventsById.get(fact.event_id) ?? null : null;
    const isNumeric = typeof fact.normalized_value === "number";
    const isNarrativeString = typeof fact.normalized_value === "string" && fact.normalized_value !== "";
    if (!isNumeric && !isNarrativeString) continue;
    const type = isNumeric ? claimTypeForUnit(fact.unit) : claimTypeForStringFact(fact);
    let displayValue = fact.normalized_value;
    if (isNarrativeString) {
      // Turn M capability B: a Fact-level enum token is NEVER shown to
      // the reader as the raw token -- translate via the generic
      // corpus-wide enum dictionary. naturalizeFactEnum's own dictionary
      // lookup covers single-word enums too (e.g. "TERMINATED", which has
      // no underscore and so is NOT "enum-shaped" by looksLikeInternalEnum's
      // multi-segment test -- calling naturalizeFactEnum unconditionally,
      // not gated on looksLikeInternalEnum, is what catches this; ordinary
      // free-text narrative strings pass through completely unchanged
      // because lookup() only transliterates when the text IS enum-shaped).
      // Falls back to a safe transliteration (never the raw token) for an
      // unseen enum-shaped token, recording an internal-only PARTIAL
      // reason when the translation wasn't confident.
      const naturalized = naturalizeFactEnum(fact.normalized_value);
      displayValue = naturalized.label;
      if (!naturalized.confident) warnings.push({ type: "unnaturalized_enum", fact_id: fact.fact_id, raw_token: fact.normalized_value });
      // Turn M3 item 8/COMPOSE_EXISTING_FACTS: a TEXT-type Fact's own
      // raw_value_text is frequently a real disclosure sentence (dates,
      // share counts, amounts) that the SHORT naturalized enum label alone
      // discards -- generically, ANY narrative Fact whose raw_value_text
      // genuinely differs from what's about to be displayed (true whenever
      // the enum WAS translated away from a richer original sentence;
      // trivially false -- so this never double-renders -- for plain non-
      // enum text Facts whose raw_value_text already equals their own
      // normalized_value) is preserved as its own, separately-attributed
      // narrative sentence. Never a whole-blob dump of a long multi-clause
      // disclosure (Turn M3 item 8's explicit "don't repeat a giant
      // Evidence quote in the body" rule): a raw_value_text longer than a
      // single real sentence is narrowed via the SAME generic per-sentence
      // splitter scanNarrativeSources already uses for qualifiers/
      // attribution, and only sentence-scale chunks are kept.
      if (typeof fact.raw_value_text === "string") {
        const rawText = fact.raw_value_text.trim();
        if (rawText !== "" && rawText !== displayValue.trim()) {
          const chunks = rawText.length > NARRATIVE_SOURCE_MAX_CHARS ? splitSentences(rawText) : [rawText];
          for (const chunk of chunks) {
            const trimmed = chunk.trim();
            if (trimmed.length < NARRATIVE_SOURCE_MIN_CHARS || trimmed.length > NARRATIVE_SOURCE_MAX_CHARS) continue;
            if (trimmed === displayValue.trim()) continue;
            narrativeSources.push({ text: trimmed, fact_id: fact.fact_id, source_document_id: fact.source_document_id, event_id: fact.event_id ?? null });
          }
        }
      }
    }
    // Turn M2 item 4: a signed numeric Fact that itself represents a
    // "vs. previous value" delta (generically detected -- never per-
    // question) renders as a natural-language direction sentence instead
    // of a bare signed number, while the CLAIM's `value` stays the exact
    // raw signed number unchanged (still exact-matched against
    // fact.normalized_value by the validator exactly as before). No
    // comparison basis, or no resolvable unit, means no direction
    // sentence -- the existing plain-number rendering is the safe
    // fallback, and the gap is recorded internally rather than guessed.
    let directionNarrative = null;
    if (isNumeric && hasComparisonBasis(fact)) {
      const resolvedUnit = unitLabel(fact.unit);
      directionNarrative = resolvedUnit ? formatDirectionNarrative(fact.normalized_value, resolvedUnit) : null;
      if (!directionNarrative) warnings.push({ type: "direction_narrative_unavailable", fact_id: fact.fact_id, reason: "no_unit" });
    }
    const valueText = isNumeric
      ? (directionNarrative ?? `${renderNumber(fact.normalized_value)}${unitLabel(fact.unit) ? ` ${unitLabel(fact.unit)}` : ""}`)
      : displayValue;
    const label = naturalizeFieldLabel(fact.raw_label ?? fact.metric_code);
    claims.push({
      type, value: fact.normalized_value,
      ...(directionNarrative ? { direction_narrative: directionNarrative } : {}),
      source: { kind: "fact", id: fact.fact_id, field: "normalized_value", ...(isNarrativeString ? { opaque_string: true } : {}) },
    });
    usedFactIds.push(fact.fact_id);
    // Period/as-of DATE claims are emitted for EVERY fact that carries
    // them, regardless of multiplicity -- a single-entity question asking
    // for "금액과 기간" must still get its period stated and claimed, not
    // only when a second entity/period forces the labeled-bracket format.
    const dateInfo = formatFactDateInfo(fact, linkedEvent);
    if (!dateInfo.confident) warnings.push({ type: "date_role_unconfident", fact_id: fact.fact_id, metric_code: fact.metric_code ?? null });
    if (fact.period_start) claims.push({ type: "DATE", value: fact.period_start, source: { kind: "fact", id: fact.fact_id, field: "period_start" } });
    if (fact.period_end) claims.push({ type: "DATE", value: fact.period_end, source: { kind: "fact", id: fact.fact_id, field: "period_end" } });
    if (!fact.period_start && !fact.period_end && dateInfo.text) {
      const dateSource = dateClaimSourceFor(fact, linkedEvent);
      claims.push({ type: "DATE", value: dateInfo.text, source: dateSource });
    }
    if (multiplicityRequiresLabels) {
      let entityLabel = fact.company_name ?? fact.attributes?.company_name ?? null;
      if (typeof fact.corp_code === "string" && fact.corp_code !== "") {
        usedCompanyCodes.add(fact.corp_code);
        const resolved = companyLabels?.[fact.corp_code];
        if (resolved?.corp_name) {
          entityLabel = resolved.corp_name;
          resolvedCompanyLabels.push({ corp_code: fact.corp_code, corp_name: resolved.corp_name });
        } else if (entityLabel === null) {
          // Never fall back to the bare corp_code as if it were a name --
          // whether companyLabels was entirely absent or just lacked this
          // code, both cases mean no VERIFIED human-readable label exists
          // yet, so this is tracked as unresolved either way (unlike the
          // pre-Turn version, which only tracked it when companyLabels was
          // provided but incomplete).
          unresolvedCompanyCodes.add(fact.corp_code);
          entityLabel = UNRESOLVED_ENTITY_LABEL;
        }
      }
      entityLabel = entityLabel ?? UNRESOLVED_ENTITY_LABEL;
      // Non-period dates get their inferred role word in the bracket too
      // (e.g. "공시일 2025-04-28") -- a real period keeps the pre-existing
      // bare tilde-range bracket format unchanged.
      const bracketDate = dateInfo.text ? (dateInfo.isPeriod ? ` / ${dateInfo.text}` : ` / ${dateInfo.roleLabel} ${dateInfo.text}`) : "";
      lines.push(`- [${entityLabel}${bracketDate}] ${label}: ${valueText}`);
      scanLines.push(`- ${IDENTIFIER_PLACEHOLDER} ${label}: ${isNarrativeString ? IDENTIFIER_PLACEHOLDER : valueText}`);
    } else {
      // The date suffix is left UNMASKED in scanLines (unlike the
      // identifier bracket elsewhere) -- it is backed by real DATE
      // claims above, so the residual scan double-checking it is
      // defense-in-depth, not something that needs hiding.
      const dateSuffix = dateInfo.text ? ` (${dateInfo.roleLabel}: ${dateInfo.text})` : "";
      lines.push(`- ${label}: ${valueText}${dateSuffix}`);
      scanLines.push(`- ${label}: ${isNarrativeString ? IDENTIFIER_PLACEHOLDER : valueText}${dateSuffix}`);
    }
  }
  return { lines, scanLines, claims, usedFactIds, warnings, narrativeSources, usedCompanyCodes: [...usedCompanyCodes], resolvedCompanyLabels, unresolvedCompanyCodes: [...unresolvedCompanyCodes] };
}

// Winner-only remainder of the old dimension-suffix comparison renderer.
// This is PRE-EXISTING known technical debt (a hardcoded company-name
// winner string, computed in thin-structured-flow.mjs -- see that file's
// own header note) that Turn I does not generalize; it is kept ENTIRELY
// SEPARATE from calculation-result rendering below specifically so it
// carries no snake_case base-name label (the old code's
// "${base} 비교: ..." wording, which leaked names like "termination_amount"
// into the answer, is retired -- every numeric diff/percent/sum/ratio
// sentence now comes exclusively from the calculationRegistry renderer).
// Turn M capability C/D: finds the REAL Korean metric label for a
// comparison base (e.g. "revenue") by looking at a calculationRegistry
// entry that already computed something for that same base -- never a
// translation of the English base name itself. Returns null (never a
// guess) when no registry entry exists for this base.
function metricLabelForBase(base, calculationRegistry) {
  const entry = (calculationRegistry ?? []).find((e) => typeof e.key === "string" && e.key.startsWith(`${base}_`) && Array.isArray(e.input_labels) && e.input_labels[0]);
  return entry ? naturalizeFieldLabel(entry.input_labels[0]) : null;
}

function renderWinnerSentences(dimensions, calculationValue, companyLabels, calculationRegistry) {
  const lines = []; const unresolvedCorpCodes = [];
  for (const base of comparisonBaseNames(dimensions)) {
    const corpCode = calculationValue[`${base}_winner_corp_code`];
    if (typeof corpCode !== "string" || corpCode === "") continue;
    const label = resolveCompanyLabel(corpCode, companyLabels);
    if (!label) { unresolvedCorpCodes.push(corpCode); continue; }
    // Turn M: names the METRIC too (never just "쪽 값") -- this is what
    // makes two winner sentences for two different metrics/bases
    // distinguishable instead of reading as a duplicated line, and is
    // itself sourced from real registry data, never invented.
    const metricLabel = metricLabelForBase(base, calculationRegistry);
    lines.push(metricLabel
      ? `${label}${topicParticle(label)} ${metricLabel}${subjectParticle(metricLabel)} 더 큽니다.`
      : `${label} 쪽 값이 더 큽니다.`);
  }
  return { lines, scanLines: [...lines], unresolvedCorpCodes };
}

// Renders every entry of the shared calculation-result REGISTRY (see
// thin-structured-flow.mjs's calculatePair -- every successful Calculator
// call is recorded there with explicit output_kind/formula/input_labels,
// never guessed from the key's own suffix or mapped by exact key). The
// sentence wording is chosen ONLY from the small, complete
// formula-x-output_kind matrix above (REGISTRY_SENTENCE_TEMPLATES) plus
// the two real VERIFIED Facts' own raw_label -- `entry.key` itself is
// NEVER interpolated into the answer. A combination this Flow has never
// exercised (not in the matrix) still renders through FALLBACK_SENTENCE,
// safely and without leaking the key, rather than being silently dropped
// or downgrading the whole response.
// Turn M capabilities C/D: two GENERIC shape-detections drive richer
// wording than the plain formula-x-output_kind matrix can express, using
// only real data already on the entry (never a per-question guess):
//   - "same metric, same/no entity" (input_labels[0] === input_labels[1],
//     e.g. a PERCENTAGE_CHANGE of one company's own metric across two
//     periods) -- rendered as "{entity 의 }{metric}{은/는} {periodA} 대비
//     {periodB}에 약 {magnitude}% {증가/감소}했습니다.", entity/period
//     omitted when not resolvable rather than guessed.
//   - "same metric, two DIFFERENT resolved entities" (e.g. an
//     ABSOLUTE_DIFFERENCE between two companies' same metric) -- rendered
//     naming BOTH companies, never the old "A와(과) A의 차이는..." shape
//     that results from labelA===labelB with no entity disambiguation.
// Anything that doesn't match either shape (a genuinely different-metric
// SUM/RATIO/DIFFERENCE, or a shape with no resolvable label at all) still
// falls through to the small complete REGISTRY_SENTENCE_TEMPLATES matrix
// exactly as before, so no combination this Flow has ever exercised loses
// coverage.
// Turn M2 item 5: a RATIO entry whose two inputs' real, corpus-wide
// metric_codes are exactly {OPERATING_PROFIT, REVENUE} (order-invariant --
// calculateFactPair's inputs are always [operating_profit, revenue], but
// this check does not assume that ordering) is generically recognized as
// an operating-margin computation, for ANY company/period, never keyed on
// outputKey/slot name/question_id. Distinguishes the two indicators this
// question family conflates: revenue (business SCALE) vs. operating
// margin (operating PROFITABILITY) -- both real, closed metric-ontology
// tokens, not an invented pattern.
function isOperatingMarginRatio(entry) {
  if (entry.formula !== "RATIO" || entry.output_kind !== "PERCENT") return false;
  const codes = Array.isArray(entry.input_metric_codes) ? [...entry.input_metric_codes].sort() : [];
  return codes.length === 2 && codes[0] === "OPERATING_PROFIT" && codes[1] === "REVENUE";
}

// Turn M2 item 6A: a DIFF entry whose two inputs' real metric_codes are
// exactly {TERMINATION_AMOUNT, one of CONTRACT_AMOUNT/LATEST_CONTRACT_AMOUNT}
// (order-invariant) is generically recognized as a termination-vs-
// effective-contract-amount match check, for ANY company/event chain --
// see contract-amount-role.mjs's registry, never a per-question key.
function isContractAmountMatchCheck(entry) {
  if (entry.formula !== "DIFF" || entry.output_kind !== "VALUE") return false;
  return isTerminationVsContractAmountPair(entry.input_metric_codes);
}

function buildRichRegistrySentence(entry, displayOperation, unit, companyLabels) {
  const [corpA] = Array.isArray(entry.input_corp_codes) ? entry.input_corp_codes : [null, null];
  if (isOperatingMarginRatio(entry)) {
    const magnitude = formatDisplayNumber(Math.abs(entry.result));
    const entity = resolveCompanyLabel(corpA, companyLabels);
    const subject = entity ? `${entity}의 영업이익률` : "영업이익률";
    return { line: `${subject}${topicParticle(subject)} 약 ${magnitude}%입니다 (매출액 대비 영업이익 비율).`, magnitude: Math.abs(entry.result) };
  }
  if (isContractAmountMatchCheck(entry)) {
    const entity = resolveCompanyLabel(corpA, companyLabels);
    const subject = entity ? `${entity}의 해지금액` : "해지금액";
    if (entry.result === 0) {
      return { line: `${subject}은 해지 시점 유효 계약금액과 일치합니다.`, magnitude: 0 };
    }
    const magnitude = formatDisplayNumber(Math.abs(entry.result));
    return { line: `${subject}은 해지 시점 유효 계약금액과 ${magnitude}${unit ?? ""} 차이가 있습니다.`, magnitude: Math.abs(entry.result) };
  }
  const [labelARaw, labelBRaw] = Array.isArray(entry.input_labels) ? entry.input_labels : [null, null];
  const labelA = labelARaw ? naturalizeFieldLabel(labelARaw) : null;
  const labelB = labelBRaw ? naturalizeFieldLabel(labelBRaw) : null;
  if (!labelA || !labelB) return null;
  // Turn M10: "same metric" is recognized via the SAME pre-existing
  // correction-side suffix convention stripCorrectionSideSuffix already
  // strips elsewhere ("...·정정전"/"...·정정후") -- a same-entity,
  // different-period pair (e.g. an amount before vs. after a correction)
  // otherwise carries two textually-different raw_labels and would never
  // reach the direction-wording branches below, even though it is
  // exactly the shape a direction conclusion is most useful for. The
  // STRIPPED label is what's actually rendered, so the correction-side
  // suffix never leaks into a comparison sentence.
  const strippedLabelA = stripCorrectionSideSuffix(labelA);
  const strippedLabelB = stripCorrectionSideSuffix(labelB);
  if (strippedLabelA !== strippedLabelB) return null;
  const sameMetricLabel = strippedLabelA;
  const [, corpB] = Array.isArray(entry.input_corp_codes) ? entry.input_corp_codes : [null, null];
  const entityA = resolveCompanyLabel(corpA, companyLabels);
  const entityB = resolveCompanyLabel(corpB, companyLabels);
  const [periodA, periodB] = Array.isArray(entry.input_periods) ? entry.input_periods : [null, null];

  if (displayOperation === "PERCENTAGE_CHANGE" && entry.output_kind === "PERCENT") {
    const magnitude = formatDisplayNumber(Math.abs(entry.result));
    const periodPhrase = periodA && periodB && periodA !== periodB ? `${periodA} 대비 ${periodB}에 ` : "";
    const subject = entityA ? `${entityA}의 ${sameMetricLabel}` : sameMetricLabel;
    if (entry.result === 0) return { line: `${subject}${topicParticle(subject)} ${periodPhrase}변화가 없습니다.`, magnitude: 0 };
    const direction = entry.result > 0 ? "증가" : "감소";
    return { line: `${subject}${topicParticle(subject)} ${periodPhrase}약 ${magnitude}% ${direction}했습니다.`, magnitude: Math.abs(entry.result) };
  }
  if (displayOperation === "ABSOLUTE_DIFFERENCE" && entityA && entityB && entityA !== entityB) {
    const magnitude = formatDisplayNumber(Math.abs(entry.result));
    const unitSuffix = entry.output_kind === "PERCENT" ? "%p" : unit;
    // Turn M10.1: a single directional sentence replaces the earlier
    // magnitude-sentence-plus-direction-sentence pair (Owner review found
    // the pair reads as the same number stated twice, e.g. Q13/Q15). At
    // exact equality there is no "bigger" side, so the sentence states
    // equality instead of a direction; otherwise the LARGER side's own
    // metric is the subject ("{bigger}의 {metric}는 {smaller}보다 N 큽니다."),
    // never both a magnitude-only and a direction sentence together.
    if (entry.result === 0) {
      return { line: `${withConjunction(entityA)} ${entityB}의 ${sameMetricLabel}${topicParticle(sameMetricLabel)} 동일합니다.`, magnitude: 0 };
    }
    const bigger = entry.result > 0 ? entityA : entityB;
    const smaller = entry.result > 0 ? entityB : entityA;
    const subject = `${bigger}의 ${sameMetricLabel}`;
    return { line: `${subject}${topicParticle(subject)} ${smaller}보다 ${magnitude}${unitSuffix ?? ""} 큽니다.`, magnitude: Math.abs(entry.result) };
  }
  // Turn M10: same entity (or entity unresolved on both sides), genuinely
  // different periods -- an amount-shaped (VALUE) or share-count-shaped
  // (SHARES) ABSOLUTE_DIFFERENCE gets the SAME "기간A 대비 기간B에 X
  // 증가/감소했습니다" direction wording the PERCENTAGE_CHANGE branch
  // above already uses, generalized to any output_kind rather than only
  // PERCENT. The phrase's "A 대비 B에" ordering must be the
  // chronologically EARLIER period first regardless of which side was
  // pair[0]/pair[1] in the underlying DIFF call (that ordering is chosen
  // by the caller purely to get a natural increase-is-positive sign, e.g.
  // calculatePair("DIFF", "latest_amount", "original_amount", ...) --
  // periodA there is the LATER date). Sorting periodA/periodB by their
  // own ISO string value (real VERIFIED Fact as_of_date/period fields,
  // which sort correctly as plain strings) keeps the sentence readable
  // independent of that arithmetic-sign choice.
  if (displayOperation === "ABSOLUTE_DIFFERENCE" && (!entityA || !entityB || entityA === entityB) && periodA && periodB && periodA !== periodB) {
    const [earlierPeriod, laterPeriod] = periodA < periodB ? [periodA, periodB] : [periodB, periodA];
    const magnitude = formatDisplayNumber(Math.abs(entry.result));
    const unitSuffix = entry.output_kind === "PERCENT" ? "%p" : unit;
    const subject = entityA ? `${entityA}의 ${sameMetricLabel}` : sameMetricLabel;
    if (entry.result === 0) return { line: `${subject}${topicParticle(subject)} ${earlierPeriod} 대비 ${laterPeriod}에 변화가 없습니다.`, magnitude: 0 };
    const direction = entry.result > 0 ? "증가" : "감소";
    return { line: `${subject}${topicParticle(subject)} ${earlierPeriod} 대비 ${laterPeriod}에 ${magnitude}${unitSuffix ?? ""} ${direction}했습니다.`, magnitude: Math.abs(entry.result) };
  }
  return null;
}

function renderCalculationRegistryEntries(registry, companyLabels, calculationValue) {
  const lines = []; const scanLines = []; const claims = [];
  // Turn M capability D: a calculation the Flow itself already marked as
  // supplementary/not-primary to this question (calculationValue.
  // non_scored_fields -- an existing generic signal, not new here) is not
  // rendered in the narrative at all. This is what removes an unrequested
  // relative-percentage side calculation from the answer without any
  // per-question key list.
  const nonScoredKeys = new Set(Object.keys(calculationValue?.non_scored_fields ?? {}));
  for (const entry of registry) {
    if (typeof entry.result !== "number" || !Number.isFinite(entry.result)) continue;
    if (nonScoredKeys.has(entry.key)) continue;
    const displayOperation = DISPLAY_OPERATION_BY_FORMULA[entry.formula] ?? null;
    const [labelA, labelB] = Array.isArray(entry.input_labels) ? entry.input_labels : [null, null];
    const unit = displayUnitFor(entry.output_kind, displayOperation, entry.input_units?.[0] ?? null);

    const rich = buildRichRegistrySentence(entry, displayOperation, unit, companyLabels);
    let line; let claimValue;
    if (rich) {
      line = rich.line; claimValue = rich.magnitude;
    } else {
      const displayValue = formatDisplayNumber(entry.result);
      const templateKey = `${displayOperation}:${entry.output_kind}`;
      const template = REGISTRY_SENTENCE_TEMPLATES[templateKey];
      line = template && labelA && labelB
        ? template(labelA, labelB, displayValue, unit)
        : `검증된 두 값의 계산 결과는 ${displayValue}${unit ? ` ${unit}` : ""}입니다.`;
      claimValue = entry.result;
    }
    lines.push(line);
    scanLines.push(line);
    claims.push({ type: entry.output_kind, value: claimValue, display_value: formatDisplayNumber(claimValue), source: { kind: "calculation", key: entry.key } });
  }
  return { lines, scanLines, claims };
}

// Turn M capability D ("두 회사의 성장 양상에 대한 종합 결론"): a GENERIC
// growth-pattern summary, activated only when the shape of the ALREADY-
// COMPUTED calculationRegistry itself matches "exactly two resolved
// entities, each with exactly two PERCENTAGE_CHANGE:PERCENT results" --
// never keyed on which two companies or which two metrics they happen to
// be. Combines two purely data-driven comparisons, neither of which
// requires knowing what the metrics MEAN:
//   (a) per matching metric label, which entity's rate is larger
//       (cross-entity) -- only when both entities share the same metric
//       label pairing, never a mismatched guess;
//   (b) within each entity, which of its own two metrics grew faster
//       (intra-entity) -- always computable once an entity has exactly 2
//       entries, independent of whether labels align across entities.
// Produces at most one summary sentence per entity (never per metric), so
// this cannot itself become a source of repetition.
function renderGrowthComparisonSummary(registry, companyLabels) {
  const pctEntries = (registry ?? []).filter((e) => e.formula === "PERCENTAGE_CHANGE" && e.output_kind === "PERCENT" && typeof e.result === "number" && Number.isFinite(e.result));
  const byEntity = new Map(); // corp_code -> entries[]
  for (const entry of pctEntries) {
    const corpCode = Array.isArray(entry.input_corp_codes) ? entry.input_corp_codes[0] : null;
    if (typeof corpCode !== "string" || corpCode === "") continue;
    const label = resolveCompanyLabel(corpCode, companyLabels);
    if (!label) continue;
    const list = byEntity.get(corpCode) ?? [];
    list.push(entry);
    byEntity.set(corpCode, list);
  }
  const entities = [...byEntity.entries()].filter(([, entries]) => entries.length === 2);
  if (entities.length !== 2) return { lines: [], scanLines: [] };

  const [[corpA, entriesA], [corpB, entriesB]] = entities;
  const labelA = resolveCompanyLabel(corpA, companyLabels);
  const labelB = resolveCompanyLabel(corpB, companyLabels);

  function fasterMetric(entries) {
    const [x, y] = entries;
    const bigger = Math.abs(x.result) >= Math.abs(y.result) ? x : y;
    const smaller = bigger === x ? y : x;
    return { biggerLabel: naturalizeFieldLabel(bigger.input_labels?.[0] ?? ""), smallerLabel: naturalizeFieldLabel(smaller.input_labels?.[0] ?? "") };
  }
  const patternA = fasterMetric(entriesA);
  const patternB = fasterMetric(entriesB);
  const lines = [];
  if (patternA.biggerLabel && patternA.smallerLabel && patternA.biggerLabel !== patternA.smallerLabel) {
    lines.push(`${labelA}${topicParticle(labelA)} ${withTopic(patternA.smallerLabel)} 완만하게, ${withTopic(patternA.biggerLabel)} 더 빠르게 증가했습니다.`);
  }
  if (patternB.biggerLabel && patternB.smallerLabel && patternB.biggerLabel !== patternB.smallerLabel) {
    lines.push(`${labelB}${topicParticle(labelB)} ${withTopic(patternB.smallerLabel)} 완만하게, ${withTopic(patternB.biggerLabel)} 더 빠르게 증가했습니다.`);
  }

  // Cross-entity: only when both entities report the SAME pair of metric
  // labels (e.g. both have "매출액"/"영업이익"), compare which entity's
  // growth was larger for each shared label.
  const labelsA = new Map(entriesA.map((e) => [naturalizeFieldLabel(e.input_labels?.[0] ?? ""), e]));
  const labelsB = new Map(entriesB.map((e) => [naturalizeFieldLabel(e.input_labels?.[0] ?? ""), e]));
  const sharedLabels = [...labelsA.keys()].filter((l) => labelsB.has(l));
  if (sharedLabels.length === entriesA.length && sharedLabels.length >= 1) {
    const allABigger = sharedLabels.every((l) => Math.abs(labelsA.get(l).result) >= Math.abs(labelsB.get(l).result));
    const allBBigger = sharedLabels.every((l) => Math.abs(labelsA.get(l).result) <= Math.abs(labelsB.get(l).result));
    if (allABigger && !allBBigger) lines.push(`${labelA}${topicParticle(labelA)} 두 지표 모두 ${labelB}보다 증가율이 큽니다.`);
    else if (allBBigger && !allABigger) lines.push(`${labelB}${topicParticle(labelB)} 두 지표 모두 ${labelA}보다 증가율이 큽니다.`);
  }
  return { lines, scanLines: [...lines] };
}

// Turn M2 item 5: when the calculationRegistry shape itself contains 2+
// operating-margin RATIO entries (see isOperatingMarginRatio above) for
// DIFFERENT resolved companies, synthesize which company's margin is
// higher plus the generic distinction "revenue measures business scale;
// operating margin measures operating profitability" -- purely data-
// driven (never a per-question guess at which two companies), and never
// fires with fewer than two distinct resolved entities (a single-company
// margin still renders fine via buildRichRegistrySentence above, just
// without a cross-company comparison sentence).
function renderOperatingMarginComparisonSummary(registry, companyLabels) {
  const marginEntries = (registry ?? []).filter((e) => isOperatingMarginRatio(e) && typeof e.result === "number" && Number.isFinite(e.result));
  const byEntity = new Map(); // corp_code -> best (first) entry
  for (const entry of marginEntries) {
    const corpCode = Array.isArray(entry.input_corp_codes) ? entry.input_corp_codes[0] : null;
    if (typeof corpCode !== "string" || corpCode === "") continue;
    const label = resolveCompanyLabel(corpCode, companyLabels);
    if (!label || byEntity.has(corpCode)) continue;
    byEntity.set(corpCode, { label, entry });
  }
  const entities = [...byEntity.values()];
  if (entities.length !== 2) return { lines: [], scanLines: [] };

  const [a, b] = entities;
  const [higher, lower] = a.entry.result >= b.entry.result ? [a, b] : [b, a];
  if (higher.entry.result === lower.entry.result) return { lines: [], scanLines: [] };
  const highMag = formatDisplayNumber(Math.abs(higher.entry.result));
  const lowMag = formatDisplayNumber(Math.abs(lower.entry.result));
  const lines = [
    `${higher.label}의 영업이익률(약 ${highMag}%)이 ${lower.label}(약 ${lowMag}%)보다 높습니다.`,
    "매출액은 사업 규모를, 영업이익률은 수익성을 나타내는 서로 다른 지표입니다.",
  ];
  return { lines, scanLines: [...lines] };
}

// Generic before/after state-change rendering. `changed`/`shares_before`/
// `shares_after`/`ratio_before_percent`/`ratio_after_percent` are the
// SAME shared reshape-key convention thin-structured-flow.mjs already
// produces for any holding-correction-shaped fact pair (not a
// per-question field name).
function renderChangeFlagSentences(calculationValue) {
  if (typeof calculationValue.changed !== "boolean") return { lines: [], scanLines: [], claims: [] };
  const lines = [`보유주식 수·지분율 변화 여부: ${calculationValue.changed ? "변화 있음" : "변화 없음"}.`];
  const claims = [];
  if (calculationValue.shares_before !== undefined && calculationValue.shares_after !== undefined) {
    lines.push(`주식 수: ${renderNumber(calculationValue.shares_before)}주 → ${renderNumber(calculationValue.shares_after)}주.`);
    claims.push({ type: "SHARES", value: calculationValue.shares_before, source: { kind: "calculation", key: "shares_before" } });
    claims.push({ type: "SHARES", value: calculationValue.shares_after, source: { kind: "calculation", key: "shares_after" } });
  }
  if (calculationValue.ratio_before_percent !== undefined && calculationValue.ratio_after_percent !== undefined) {
    lines.push(`지분율: ${renderNumber(calculationValue.ratio_before_percent)}% → ${renderNumber(calculationValue.ratio_after_percent)}%.`);
    claims.push({ type: "PERCENT", value: calculationValue.ratio_before_percent, source: { kind: "calculation", key: "ratio_before_percent" } });
    claims.push({ type: "PERCENT", value: calculationValue.ratio_after_percent, source: { kind: "calculation", key: "ratio_after_percent" } });
  }
  return { lines, scanLines: [...lines], claims };
}

// Turn M2 item 8: a REQUIRED (never a deferrable "style request") direct-
// conclusion sentence stating the overall A상태→B상태 transition across
// the earliest and latest VERIFIED Event of this request, explicitly
// framed as confirmed disclosure-event provenance ("공시 사건으로
// 확인됩니다" -- distinct from a narrative Fact's "...라고 기재되어
// 있습니다" framing or a company's own "...라고 밝혔습니다" judgment).
// Fires only when a genuine transition occurred (first/last event_type OR
// event_status differ); two Events that both report the SAME type+status
// have nothing to transition-summarize beyond the itemized list
// renderTemporalSentences already provides. Never invents an event_type/
// event_status combination -- only ever the two real endpoints' own
// fields, translated via the SAME natural-label dictionary.
// Turn M4 item 4B: an internal-representation-shaped "TYPE(STATUS)에서
// TYPE(STATUS)로 전환" sentence is itself still a form of enum exposure
// (the reader sees "결정(결정됨)"/"정정(정정됨)" -- an internal state
// machine translated word-for-word, not a natural conclusion) and, since
// the closing paren directly precedes a particle, it is also where the
// "정정됨)로" grammar defect came from. Replaced with a GENERIC "{first
// event's own type label} 후 {last event's status, as a natural
// completion adnominal} 사실이 확인됩니다" structure: every real
// event_status label (완료/확정/정정됨/결정됨/해지됨) already reduces to a
// natural adnominal via one mechanical suffix rule (see
// toCompletionAdnominal), so this generalizes to any event_type/status
// pair, never a per-question template. Raw enum tokens never appear in
// the sentence (only the SAME naturalized labels used everywhere else).
function toCompletionAdnominal(statusLabel) {
  const base = statusLabel.endsWith("됨") ? statusLabel.slice(0, -1) : statusLabel;
  return `${base}된`;
}
function renderEventStateTransitionConclusion(events) {
  if (!Array.isArray(events) || events.length < 2) return { lines: [], scanLines: [] };
  const sorted = [...events].sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first.event_type === last.event_type && first.event_status === last.event_status) return { lines: [], scanLines: [] };
  const firstTypeLabel = naturalizeEventType(first.event_type).label;
  const lastStatusLabel = naturalizeEventStatus(last.event_status).label;
  const line = `${firstTypeLabel} 후 ${toCompletionAdnominal(lastStatusLabel)} 사실이 ${first.event_date}부터 ${last.event_date}까지의 공시를 통해 확인됩니다.`;
  return { lines: [line], scanLines: [line] };
}

// Turn M3 item 7B: a REQUIRED direct-conclusion sentence for a single
// Fact whose metric_code follows the established "*_STATUS" suffix
// convention (TERMINATION_STATUS/ACQUISITION_RETIREMENT_STATUS/
// ISSUANCE_COMPLETION_STATUS/CONTRACT_STATUS/... -- all real, corpus-
// observed) AND whose OWN raw_label already encodes a "FROM -> TO"
// transition via a real, corpus-observed arrow shape (confirmed via the
// structured ontology audit: today only CONTRACT_STATUS's raw_label
// "LOI -> 본계약 전환" carries this shape, but the detector is keyed on
// the SHAPE itself, not this one metric_code, so it generalizes to any
// future Fact using the same raw_label convention). Never a per-question/
// company template -- the FROM state comes from the Fact's own raw_label
// text, the TO state from the SAME naturalized enum dictionary used
// everywhere else (never a raw token).
const STATUS_TRANSITION_LABEL_PATTERN = /^(.+?)\s*(?:->|→)\s*(.+)$/;
function renderFactLevelLifecycleTransition(facts) {
  const lines = []; const scanLines = [];
  for (const fact of facts) {
    if (typeof fact.metric_code !== "string" || !fact.metric_code.endsWith("_STATUS")) continue;
    if (typeof fact.raw_label !== "string" || typeof fact.normalized_value !== "string") continue;
    const match = fact.raw_label.match(STATUS_TRANSITION_LABEL_PATTERN);
    if (!match) continue;
    const fromLabel = match[1].trim();
    const toLabel = naturalizeFactEnum(fact.normalized_value).label;
    if (!fromLabel || !toLabel) continue;
    // Turn M3 fix: fromLabel/toLabel are free text derived from a
    // naturalized enum label (e.g. a launch-status label may embed a
    // year), which can carry an ungrounded-looking digit -- masked in
    // scan_text exactly like every other narrative/opaque-string sentence
    // in this Composer (the SAME Fact is already independently claimed as
    // a NARRATIVE value in renderValueLines, so grounding is unaffected).
    lines.push(`확인 결과 ${fromLabel}에서 ${withDirection(toLabel)} 전환됐습니다.`);
    scanLines.push(`확인 결과 ${IDENTIFIER_PLACEHOLDER}에서 ${IDENTIFIER_PLACEHOLDER} 전환됐습니다.`);
  }
  return { lines, scanLines };
}

// Turn M3 item 7A: when a request's facts include BOTH an authorization-
// shaped Fact (metric_code === "EVENT_STATUS", the real corpus-wide
// metric_code for regulatory approval/authorization disclosures) and a
// launch/commercialization-shaped Fact (metric_code === "LAUNCH_STATUS"),
// synthesize ONE short direct-conclusion sentence: authorization ->
// commercialization progress, plus a generic per-item information-limit
// clause whenever either Fact carries a real attributes.scope_note
// annotation (an established attributes-key convention, never invented).
// The note's own internal text is never quoted verbatim -- only its
// EXISTENCE is surfaced via generic wording, since the note itself is
// reviewer-authored audit commentary, not disclosure content. Never a
// specific product/company/year literal.
// Turn M10: a generic "N -> M 정정되었습니다" conclusion keyed ONLY on a
// closed structured attribute-key pair (attributes.initial_planned_shares
// / attributes.corrected_actual_shares -- real VERIFIED Fact attribute
// conventions, never a per-question literal) plus a real, already-loaded
// correction-shaped Event for the SAME corp_code (event_type ending in
// the closed, corpus-wide "_CORRECTION" suffix already used throughout
// the Event ontology -- see natural-label.mjs's EVENT_TYPE_LABELS
// entries). This is deliberately NOT a raw_value_text regex-extraction:
// both numbers come straight from their own explicit attribute fields,
// and the date comes from the Event's own event_date, never parsed out
// of free text. Fires nothing (never a guess) unless every one of these
// three real records is present and consistent.
function renderShareCorrectionConclusion(facts, events) {
  const initialFact = facts.find((f) => typeof f.attributes?.initial_planned_shares === "number");
  const correctedFact = facts.find((f) => typeof f.attributes?.corrected_actual_shares === "number");
  if (!initialFact || !correctedFact || initialFact.corp_code !== correctedFact.corp_code) return { lines: [], scanLines: [], claims: [] };
  const correctionEvent = (events ?? []).find((e) => e.corp_code === initialFact.corp_code && typeof e.event_type === "string" && e.event_type.endsWith("_CORRECTION"));
  if (!correctionEvent) return { lines: [], scanLines: [], claims: [] };
  const initialShares = initialFact.attributes.initial_planned_shares;
  const correctedShares = correctedFact.attributes.corrected_actual_shares;
  const line = `${correctionEvent.event_date}: ${renderNumber(initialShares)}주에서 ${renderNumber(correctedShares)}주로 정정되었습니다.`;
  const claims = [
    { type: "DATE", value: correctionEvent.event_date, source: { kind: "event", id: correctionEvent.event_id, field: "event_date" } },
    { type: "SHARES", value: initialShares, source: { kind: "fact", id: initialFact.fact_id, field: "attributes.initial_planned_shares" } },
    { type: "SHARES", value: correctedShares, source: { kind: "fact", id: correctedFact.fact_id, field: "attributes.corrected_actual_shares" } },
  ];
  return { lines: [line], scanLines: [line], claims };
}

function renderProductLifecycleConclusion(facts) {
  const authorizationFact = facts.find((f) => f.metric_code === "EVENT_STATUS" && typeof f.normalized_value === "string" && f.normalized_value !== "");
  const launchFact = facts.find((f) => f.metric_code === "LAUNCH_STATUS" && typeof f.normalized_value === "string" && f.normalized_value !== "");
  if (!authorizationFact || !launchFact) return { lines: [], scanLines: [] };
  const authLabel = naturalizeFactEnum(authorizationFact.normalized_value).label;
  const launchLabel = naturalizeFactEnum(launchFact.normalized_value).label;
  if (!authLabel || !launchLabel) return { lines: [], scanLines: [] };
  // Turn M3 fix: authLabel/launchLabel are free text derived from a
  // naturalized enum label (e.g. a launch-status label may embed a
  // year), which can carry an ungrounded-looking digit -- masked in
  // scan_text exactly like every other narrative/opaque-string sentence
  // in this Composer (the SAME Facts are already independently claimed
  // as NARRATIVE values in renderValueLines, so grounding is unaffected).
  const lines = [`${authLabel} 이후 ${launchLabel} 단계로 진행되었습니다.`];
  const scanLines = [`${IDENTIFIER_PLACEHOLDER} 이후 ${IDENTIFIER_PLACEHOLDER} 단계로 진행되었습니다.`];
  const hasScopeNote = [authorizationFact, launchFact].some((f) => typeof f.attributes?.scope_note === "string" && f.attributes.scope_note !== "");
  if (hasScopeNote) {
    const infoLimitLine = "다만 개별 항목별 세부 시점·실적은 구조화 자료에서 추가로 확인되지 않습니다.";
    lines.push(infoLimitLine);
    scanLines.push(infoLimitLine);
  }
  return { lines, scanLines };
}

// Turn M3 item 7C: a REAL VERIFIED Evidence quote that explicitly cites
// an EARLIER disclosure by date via the generic, corpus-wide DART cross-
// reference phrasing "YYYY년 MM월 DD일 공시한 '...'" (never invented,
// never a per-document/per-company pattern) indicates the CURRENT
// document indirectly confirms a fact from that earlier disclosure, even
// when the earlier disclosure itself has no separate Event/Fact of its
// own among this request's loaded records. Fires ONLY when all three of
// (a) the referenced date, (b) the referenced disclosure's own label
// text, and (c) the citing Evidence's own document_id/quoted_text are
// present in the SAME real quote -- if the pattern doesn't match, this
// simply does not fire (never a guessed/inferred confirmation).
const INDIRECT_CONFIRMATION_PATTERN = /(\d{4}년\s?\d{1,2}월\s?\d{1,2}일)에?\s?공시한\s?['"]?([^'"\n]{2,40})/;
// Turn M4 item 4F: a relevance gate -- fires ONLY when the referenced
// disclosure is NOT already independently represented by an Event this
// response already loaded (a plain cross-reference to the SAME already-
// known event, e.g. "see the 주요사항보고서 filed 3 days after this same
// decision", carries no new information and must not be surfaced as if
// it were). Detected generically via keyword overlap between the
// referenced label and each loaded Event's own naturalized type label --
// never a per-question date-window or document-id check.
function stripForOverlapCheck(text) {
  return typeof text === "string" ? text.replace(/[\s()[\]{}0-9.·'"“”]/g, "") : "";
}
function referencesAlreadyKnownEvent(referencedLabel, events) {
  const strippedRef = stripForOverlapCheck(referencedLabel);
  if (strippedRef.length < 3) return false;
  return (events ?? []).some((event) => {
    const strippedEventLabel = stripForOverlapCheck(naturalizeEventType(event.event_type).label);
    return strippedEventLabel.length >= 3 && (strippedRef.includes(strippedEventLabel) || strippedEventLabel.includes(strippedRef));
  });
}
// Turn M10: a STRONGER, more reliable relevance gate alongside the
// keyword-overlap check above -- the referenced disclosure's own date
// (already captured by INDIRECT_CONFIRMATION_PATTERN's own first group,
// in the corpus-wide "YYYY년 MM월 DD일" form every such cross-reference
// uses) is parsed to ISO form and compared against every already-loaded
// Fact's as_of_date and every already-loaded Event's event_date. Exact
// date equality is a precise, unambiguous signal that the referenced
// disclosure genuinely IS already directly available in this response --
// unlike keyword overlap, it does not depend on the cross-reference's own
// free-text label happening to lexically match a translated Event-type
// label (real DART cross-reference phrasing frequently paraphrases the
// referenced filing's own title, which keyword overlap alone can miss).
// Never a per-question date; this parses whatever date the SAME real
// Evidence quote's own cross-reference phrasing states.
const KOREAN_DATE_PATTERN = /^(\d{4})년\s?(\d{1,2})월\s?(\d{1,2})일$/;
function parseKoreanDateToIso(text) {
  const match = typeof text === "string" ? text.match(KOREAN_DATE_PATTERN) : null;
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
function referencesAlreadyAvailableDate(referencedDate, facts, events) {
  const isoDate = parseKoreanDateToIso(referencedDate);
  if (!isoDate) return false;
  return (facts ?? []).some((f) => f.as_of_date === isoDate) || (events ?? []).some((e) => e.event_date === isoDate);
}
function renderIndirectConfirmationSentences(evidenceItems, events, facts) {
  const lines = []; const scanLines = []; const usedEvidenceIds = [];
  for (const item of evidenceItems) {
    if (typeof item.quoted_text !== "string") continue;
    const match = item.quoted_text.match(INDIRECT_CONFIRMATION_PATTERN);
    if (!match) continue;
    const referencedDate = match[1];
    const referencedLabel = match[2].trim();
    if (referencesAlreadyKnownEvent(referencedLabel, events) || referencesAlreadyAvailableDate(referencedDate, facts, events)) continue;
    // Turn M4 item 4A: referencedLabel is free text with an unpredictable
    // ending (brackets/digits/Latin abbreviations) -- rather than attach
    // a particle directly to it (uncertain batchim resolution), it is
    // quoted as a parenthetical and the particle attaches to the FIXED,
    // known-correct word "내용" instead. Masked in scan_text exactly like
    // every other narrative/opaque-string sentence in this Composer.
    lines.push(`${referencedDate}에 공시된 내용("${referencedLabel}")은 후속 문서(${item.document_id})의 설명을 통해 간접적으로 확인됩니다.`);
    scanLines.push(`${IDENTIFIER_PLACEHOLDER}에 공시된 내용("${IDENTIFIER_PLACEHOLDER}")은 후속 문서(${IDENTIFIER_PLACEHOLDER})의 설명을 통해 간접적으로 확인됩니다.`);
    usedEvidenceIds.push(item.evidence_id);
  }
  return { lines, scanLines, usedEvidenceIds };
}

function renderTemporalSentences(events) {
  const sorted = [...events].sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const lines = []; const scanLines = []; const claims = []; const usedEventIds = []; const warnings = [];
  for (const event of sorted) {
    const changed = Array.isArray(event.attributes?.changed_fields) ? event.attributes.changed_fields.join(", ") : null;
    const reason = typeof event.attributes?.change_reason === "string" ? event.attributes.change_reason : null;
    // Turn M capability B/E: event_type/event_status are NEVER shown as
    // raw SCREAMING_SNAKE_CASE enums -- translated via the same generic,
    // corpus-wide Event-ontology dictionary natural-label.mjs uses for
    // Fact enums (never a per-question mapping).
    const typeNatural = naturalizeEventType(event.event_type);
    const statusNatural = naturalizeEventStatus(event.event_status);
    if (!typeNatural.confident) warnings.push({ type: "unnaturalized_enum", event_id: event.event_id, raw_token: event.event_type });
    if (!statusNatural.confident) warnings.push({ type: "unnaturalized_enum", event_id: event.event_id, raw_token: event.event_status });
    const parts = [`${event.event_date}: ${typeNatural.label}(${statusNatural.label})`];
    if (changed) parts.push(`변경 필드: ${changed}`);
    if (reason) parts.push(`사유: ${reason}`);
    lines.push(`${parts.join(" · ")} · [근거: ${event.anchor_document_id}]`);
    scanLines.push(`${parts.join(" · ")} · [근거: ${IDENTIFIER_PLACEHOLDER}]`);
    claims.push({ type: "DATE", value: event.event_date, source: { kind: "event", id: event.event_id, field: "event_date" } });
    usedEventIds.push(event.event_id);
  }
  return { lines, scanLines, claims, usedEventIds, warnings };
}

// Renders every `latest_effective_*` calculationValue key deterministically.
// Turn I: the label shown to the reader is NEVER derived from the
// calculationValue key itself (that key is an internal Flow-local
// projection name, e.g. "latest_effective_contract_amount_krw" -- not a
// VERIFIED Fact's own raw_label, and this function has no Fact object to
// resolve one from). `period_start`/`period_end` keep their own
// pre-existing, already-generic contract-period wording. Every OTHER key
// uses the single conservative generic label "최신 유효 값" (object leaves
// use ordinal "항목 N" instead of the leaf's own key) rather than
// translating/guessing a Korean name from the English key -- the precise
// identity of each value is already available from its own VERIFIED
// Fact's ordinary line elsewhere in the SAME answer (renderValueLines
// renders every queried Fact by its real raw_label unconditionally), so
// nothing is lost by declining to re-derive a second, less trustworthy
// label here.
function renderLatestStateSentences(calculationValue) {
  const lines = []; const scanLines = []; const claims = [];
  const stateKeys = Object.keys(calculationValue).filter((k) => k.startsWith("latest_effective_"));
  for (const key of stateKeys) {
    const value = calculationValue[key];
    const isPeriodField = key === "latest_effective_period_start" || key === "latest_effective_period_end";
    if (isPeriodField) {
      const line = `계약(기간) ${key === "latest_effective_period_start" ? "시작일" : "종료일"}: ${value}.`;
      lines.push(line); scanLines.push(line);
      claims.push({ type: "DATE", value, source: { kind: "calculation", key } });
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      const parts = entries.map(([subKey, subValue], index) => {
        const ordinal = `항목 ${index + 1}`;
        if (typeof subValue === "number") {
          const isPercent = subKey.includes("percent");
          claims.push({ type: isPercent ? "PERCENT" : "VALUE", value: subValue, source: { kind: "calculation", key: `${key}.${subKey}` } });
          return `${ordinal} ${renderNumber(subValue)}${isPercent ? "%" : ""}`;
        }
        return `${ordinal} ${subValue}`;
      });
      const line = `최신 유효 값: ${parts.join(", ")}.`;
      lines.push(line); scanLines.push(line);
      continue;
    }
    if (typeof value === "number") {
      claims.push({ type: (key.includes("percent") || key.includes("ratio")) ? "PERCENT" : "VALUE", value, source: { kind: "calculation", key } });
      const line = `최신 유효 값: ${renderNumber(value)}.`;
      lines.push(line); scanLines.push(line);
      continue;
    }
    if (typeof value === "string") {
      claims.push({ type: "VALUE", value, source: { kind: "calculation", key, opaque_string: true } });
      lines.push(`최신 유효 값: ${value}.`);
      scanLines.push(`최신 유효 값: ${IDENTIFIER_PLACEHOLDER}.`);
      continue;
    }
  }
  return { lines, scanLines, claims };
}

// Each information-limit line also becomes a STATUS claim (source: the
// calculationValue key the status came from) so a sub_request's
// required_output_bindings can verify a STATUS was actually rendered for
// a specific field, not merely that "some" information limit exists.
// Turn M2 item 2: when the SAME structurally-absent line item (identical
// metric_code + raw_label, both real VERIFIED Fact fields -- never a
// question-authored guess) is queried across 2+ slots (e.g. two different
// periods of a comparison request) and ALL of them report the SAME
// status, that shape itself is evidence the request was a COMPARISON that
// this line item cannot support -- not just "this one field is missing."
// A single dedicated sentence replaces the N otherwise-identical per-slot
// lines (which capability G's dedup pass would collapse to one anyway,
// but with strictly worse wording that never says WHY the comparison
// itself is impossible). Never keyed on which metric/company this
// happens to be -- purely on the shape (2+ identical metric_code+raw_label
// info-limit entries sharing one status).
function groupInformationLimitsByFamily(informationLimits) {
  const groups = new Map();
  for (const item of informationLimits) {
    const key = `${item.metric_code ?? ""}|${item.raw_label ?? ""}|${item.status}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()];
}

// Returns { lines, scanLines, claims, renderedInformationLimits }.
// renderedInformationLimits is a copy of the INPUT items with
// status_label_ko OVERRIDDEN to whatever text actually ended up in the
// narrative for that item (the group sentence, when grouped) -- this is
// what final-synthesis-validator.mjs's independent
// `narrative_text.includes(item.status_label_ko)` check verifies against,
// so the validator's own re-derivation logic stays completely unchanged
// and still fails closed if a field's disclosure genuinely disappears;
// only the TEXT it compares against reflects what this function actually
// rendered for a grouped comparison-impossibility sentence, never a
// unilateral relaxation of the check itself.
function renderInformationLimitSentences(informationLimits) {
  const lines = []; const claims = []; const renderedInformationLimits = [];
  const groups = groupInformationLimitsByFamily(informationLimits);
  for (const group of groups) {
    const [first] = group;
    const label = naturalizeFieldLabel(first.raw_label ?? first.metric_code ?? first.field);
    if (group.length >= 2 && first.status === "NOT_APPLICABLE" && label) {
      // Never assumes the label's own internal grammar (a real raw_label
      // like "(2) 요약 연결포괄손익계산서 — 매출액 항목 없음" already states
      // absence itself -- appending a second "...이 없어" would double
      // negate into nonsense). Always treat the label as a standalone
      // clause and state the comparison consequence separately.
      const line = `${label}: 동일 기준으로 비교할 수 없습니다.`;
      lines.push(line);
      for (const item of group) renderedInformationLimits.push({ ...item, status_label_ko: line });
    } else {
      for (const item of group) {
        const line = `${naturalizeFieldLabel(item.raw_label ?? item.metric_code ?? item.field)}: ${item.status_label_ko}.`;
        lines.push(line);
        renderedInformationLimits.push(item);
      }
    }
    for (const item of group) claims.push({ type: "STATUS", value: item.status, source: { kind: "calculation", key: item.field } });
  }
  return { lines, scanLines: [...lines], claims, renderedInformationLimits };
}

// Turn M8: renders a Plan's `information_limits` declarations (see
// domain/adapters/information-limit-vocabulary.mjs -- schema_version
// "0.4.0", NOT a Sub-request research revival). This is the GENERIC
// counterpart to renderInformationLimitSentences above: that function
// handles a Fact/slot that DOES exist but carries a special value_status
// (NOT_FOUND/NOT_APPLICABLE/OUTSIDE_CORPUS/WITHHELD); this one handles a
// requested, Owner-approved metric_code that has NO Fact/slot at all --
// the Plan honestly declares the gap instead of the Composer silently
// omitting it. Never keyed on metric_code/question_id -- the SAME
// rendering runs for every declaration, only the label/available facts
// differ. Never renders a numeric value for target_metric_code itself
// (that would defeat the whole point of an honest information-limit
// declaration); the "available_input_fact_ids" facts are ordinary
// VERIFIED Facts and render through the caller's own normal Fact
// rendering (renderValueLines) exactly like any other loaded Fact --
// this function only adds the ONE extra natural-language sentence
// stating the target metric's absence, order-independent over
// available_input_fact_ids (a Set, never an array-position dependency).
const INFORMATION_LIMIT_REASON_PHRASES_KO = Object.freeze({
  NOT_DIRECTLY_DISCLOSED: "원문에서 직접 공시된 항목으로 확인되지 않습니다",
});
const INFORMATION_LIMIT_CALCULATION_STATUS_PHRASES_KO = Object.freeze({
  DERIVED_CALCULATION_NOT_AVAILABLE: "두 값을 이용한 파생 계산은 이번 응답 범위에 포함하지 않았습니다",
});
// A metric_code that is the TARGET of an information_limit has no
// `raw_label` to naturalize (no Fact exists to carry one -- that is the
// whole point of the declaration). Falling back to the raw ALL_CAPS_
// SNAKE metric_code token would leak internal representation, exactly
// the class of bug this project has rejected since Turn M2. This is the
// SAME closed, question-agnostic label dictionary as domain/adapters/
// information-limit-vocabulary.mjs's APPROVED_ONTOLOGY_METRIC_CODE_LABELS_KO
// (duplicated as a literal, not imported -- domain/flows/ never
// statically imports domain/adapters/, matching sub-request-vocabulary.mjs's
// own "adapters must not depend on flows" one-directional layering
// comment; the SAME 6-token vocabulary is authoritative in both
// directions and any future 7th token needs a version bump in both).
const INFORMATION_LIMIT_TARGET_METRIC_LABELS_KO = Object.freeze({
  INVESTMENT_PURPOSE: "투자목적",
  INVESTMENT_TARGET_ASSET: "투자대상",
  ACQUISITION_PLANNED_SHARES: "취득예정주식수",
  TRUST_CONTRACT_INSTITUTION: "계약체결기관",
  CORRECTION_REASON: "정정사유",
  ISSUANCE_AMOUNT: "발행총액",
});
function renderInformationLimitDeclarations(informationLimits, factsById) {
  const lines = []; const scanLines = []; const declarations = [];
  for (const decl of informationLimits ?? []) {
    const reasonPhrase = INFORMATION_LIMIT_REASON_PHRASES_KO[decl.reason_code];
    const calcPhrase = INFORMATION_LIMIT_CALCULATION_STATUS_PHRASES_KO[decl.calculation_status];
    const label = INFORMATION_LIMIT_TARGET_METRIC_LABELS_KO[decl.target_metric_code];
    // Unknown enum/metric value -> never invent wording; the Plan-level
    // validator already rejects this before construction, so this is
    // defense-in-depth only, never reached on a legitimately-built Plan.
    if (!reasonPhrase || !calcPhrase || !label) continue;
    const line = `${withTopic(label)} ${reasonPhrase}. ${calcPhrase}.`;
    lines.push(line);
    scanLines.push(line);
    // supporting_fact_ids is order-independent by construction -- a Set-
    // shaped array (deduplicated, never relying on the Plan's own
    // available_input_fact_ids ordering to mean anything).
    declarations.push({
      target_metric_code: decl.target_metric_code,
      reason_code: decl.reason_code,
      supporting_fact_ids: [...new Set(decl.available_input_fact_ids)].filter((id) => factsById.has(id)),
      calculation_status: decl.calculation_status,
      // Exact rendered text, so final-synthesis-validator.mjs can verify
      // this declaration's sentence really is present in the final
      // narrative -- same "validator re-checks against the composer's own
      // recorded text" pattern as preserved_information_limits'
      // status_label_ko above; the validator never re-derives wording.
      rendered_sentence: line,
    });
  }
  return { lines, scanLines, declarations };
}

// Turn M2 item 6B: a real corpus-wide raw_label naming convention pair
// ("...·정정전"/"...·정정후" -- confirmed by direct inspection of the
// VERIFIED Fact artifact) is stripped so the field name reads standalone
// ("계약상대·정정후" -> "계약상대") rather than leaking the correction-
// side suffix into a sentence that already states this is a disclosure
// event, not a correction. Never touches naturalizeFieldLabel's own
// leading-numbering behavior (a separate, more broadly-used concern).
function stripCorrectionSideSuffix(label) {
  return typeof label === "string" ? label.replace(/·정정(전|후)$/, "") : label;
}

// Renders the WITHHELD -> DISCLOSED-only-change findings from
// withheld-disclosure-detection.mjs as a natural-language sentence per
// finding, distinguishing this from an actual contract-terms amendment.
// No numeric_claims needed: the sentence cites no digit, only the field
// name and (optionally) the resolved entity -- the two underlying Facts'
// provenance is still recorded via usedFactIds.
function renderWithheldToDisclosedOnlySentences(findings, companyLabels) {
  const lines = []; const usedFactIds = [];
  for (const finding of findings) {
    const label = stripCorrectionSideSuffix(naturalizeFieldLabel(finding.raw_label ?? finding.metric_code));
    const entity = resolveCompanyLabel(finding.corp_code, companyLabels);
    const prefix = entity ? `${entity}의 ` : "";
    lines.push(`${prefix}${label} 항목은 계약조건 변경이 아니라 기존에 유보했던 정보의 공개입니다.`);
    usedFactIds.push(finding.withheld_fact_id, finding.disclosed_fact_id);
  }
  return { lines, scanLines: [...lines], usedFactIds };
}

// Each attribution sentence also becomes a NARRATIVE claim so a
// sub_request's required_output_bindings can verify a company-attributed
// narrative was actually rendered for a specific Fact/Evidence, not
// merely that ATTRIBUTION_PRESERVATION applied somewhere.
// Turn M2 item 8: "회사는 …라고 밝혔습니다/판단했습니다." -- the verb is
// chosen from the SAME generic marker vocabulary that already flagged
// this sentence as attribution (synthesis-signal-planner.mjs's
// ATTRIBUTION_MARKERS), never a per-question choice: a "판단" marker
// picks "판단했습니다", every other marker (전망/예상/기대/계획/당사는/
// 회사는) keeps the neutral default "밝혔습니다".
function attributionVerb(markers) {
  return Array.isArray(markers) && markers.includes("판단") ? "판단했습니다" : "밝혔습니다";
}
function renderAttributionSentences(attributions) {
  const lines = []; const scanLines = []; const claims = [];
  for (const item of attributions) {
    const verb = attributionVerb(item.markers);
    lines.push(`회사는 "${item.text}"라고 ${verb}`);
    scanLines.push(`회사는 "${IDENTIFIER_PLACEHOLDER}"라고 ${verb}`);
    const source = item.fact_id ? { kind: "fact", id: item.fact_id, field: "attribution_text" } : { kind: "evidence", id: item.evidence_id, field: "quoted_text" };
    claims.push({ type: "NARRATIVE", value: item.text, source });
  }
  return { lines, scanLines, claims };
}

// Turn M3 item 8/COMPOSE_EXISTING_FACTS: a VERIFIED periodic/regulatory
// disclosure Fact's own raw_value_text -- distinct from a company's own
// judgment/forecast (attribution) or an indirect confirmation via a LATER
// document (Turn M3 item 7C) -- is what CLAUDE.md's provenance framings
// call "정기공시에는 …라고 기재되어 있습니다." Never the same verb as
// attribution ("밝혔습니다"/"판단했습니다" imply the company is being
// quoted expressing something); this is a plain, neutral statement of
// what the filing itself records.
// Turn M4 item 4C: source-type attribution derived from the REAL, closed
// document_id group prefix (periodic/major/exchange/holding -- the SAME
// 4-value DOCUMENT_GROUPS vocabulary every document_id in this corpus is
// already validated against elsewhere in this codebase), never a single
// fixed "정기공시에는" framing regardless of the actual source. Falls
// back to the generic "해당 공시" only when the prefix can't be resolved.
const SOURCE_TYPE_LABELS = Object.freeze({
  periodic: "정기공시", major: "주요사항보고서", exchange: "거래소 공시", holding: "대량보유 보고서",
});
function baseSourceTypeLabel(documentId) {
  if (typeof documentId !== "string") return "해당 공시";
  const match = documentId.match(/^([a-z]+)_/);
  const group = match ? match[1] : null;
  return (group && SOURCE_TYPE_LABELS[group]) || "해당 공시";
}
// Refines the generic group label to "후속 해지공시" when this SPECIFIC
// Fact's own linked Event (never a guess -- only via the Fact's own
// real event_id, resolved against the SAME events array already loaded
// for this response) is itself a termination-shaped event anchored at
// the SAME document. A real, corpus-wide event_type substring shape
// ("*_TERMINATION", already used elsewhere in this codebase), never a
// per-question document_id check.
function resolveSourceTypeLabel(item, eventsById) {
  const event = item.event_id ? eventsById.get(item.event_id) : null;
  if (event && event.anchor_document_id === item.source_document_id && /TERMINATION/i.test(event.event_type ?? "")) {
    return "후속 해지공시";
  }
  return baseSourceTypeLabel(item.source_document_id);
}
function renderNarrativeSourceSentences(narrativeSources, events) {
  const lines = []; const scanLines = []; const claims = [];
  const eventsById = new Map((events ?? []).map((e) => [e.event_id, e]));
  for (const item of narrativeSources) {
    const sourceLabel = resolveSourceTypeLabel(item, eventsById);
    lines.push(`${sourceLabel}에는 "${item.text}"라고 기재되어 있습니다.`);
    scanLines.push(`${sourceLabel}에는 "${IDENTIFIER_PLACEHOLDER}"라고 기재되어 있습니다.`);
    claims.push({ type: "NARRATIVE", value: item.text, source: { kind: "fact", id: item.fact_id, field: "raw_value_text" } });
  }
  return { lines, scanLines, claims };
}

function renderQualifierSentences(qualifiers, alreadyQuotedTexts) {
  const lines = []; const scanLines = [];
  for (const item of qualifiers) {
    if (alreadyQuotedTexts.has(item.text)) continue;
    lines.push(`공시 원문의 한정 표현을 그대로 유지합니다: "${item.text}"`);
    scanLines.push(`공시 원문의 한정 표현을 그대로 유지합니다: "${IDENTIFIER_PLACEHOLDER}"`);
  }
  return { lines, scanLines };
}

function renderComparabilityCaveat(signals, calculationValue) {
  const lines = []; const claims = [];
  if (signals.comparison_basis_mismatch) {
    lines.push("비교 대상의 기준 시점(연도)이 서로 다르므로, 명목상의 차이가 경제적 우열을 의미하지는 않습니다.");
  }
  // Turn M capability D: calculationValue.original_units_differ (the two
  // Facts' ORIGINAL DISCLOSED scale, e.g. 천원 vs 원) is deliberately no
  // longer rendered as a standalone caveat -- every value compared here
  // has ALREADY been normalized to the same canonical unit (KRW) before
  // any diff/percentage calculation runs (thin-structured-flow.mjs's
  // calculatePair itself refuses to compute across mismatched unit/scope/
  // scale), so a difference in the FILING's own original scale carries no
  // remaining comparability risk once normalized -- stating it as a
  // caveat was misleading noise about an already-resolved concern, not a
  // genuine warning. comparison_basis_mismatch above (a real unresolved
  // period/basis concern) is unaffected and still renders.
  if (typeof calculationValue.consolidation_scope_note === "string") {
    lines.push(`${calculationValue.consolidation_scope_note}.`);
    if (typeof calculationValue.consolidation_entity_count_2023 === "number") {
      claims.push({ type: "VALUE", value: calculationValue.consolidation_entity_count_2023, source: { kind: "calculation", key: "consolidation_entity_count_2023" } });
    }
    if (typeof calculationValue.consolidation_entity_count_2025 === "number") {
      claims.push({ type: "VALUE", value: calculationValue.consolidation_entity_count_2025, source: { kind: "calculation", key: "consolidation_entity_count_2025" } });
    }
  }
  return { lines, scanLines: [...lines], claims };
}

// Event-timeline completeness is NEVER asserted or assumed -- only the
// count of VERIFIED Events actually rendered is ever claimed. Legacy
// Plans (no Candidate sub_requests, no minimum_event_count authority)
// get ONLY the generic, always-true caveat: current structured Events are
// a "range confirmed so far", never "the complete history". A Candidate
// Plan's sub_requests (schema_version 0.3.0) additionally supply a real,
// checkable minimum_event_count per TRACE_TIMELINE ask -- when that
// authority reports the timeline is event-short (see
// sub-request-coverage-v2.mjs's INSUFFICIENT_VERIFIED_EVENTS /
// VERIFIED_EVENT_NOT_RENDERED reason codes), a second, more specific
// sentence names the exact confirmed/required counts already computed by
// that evaluator -- never a new guess from date gaps or question text.
function renderEventCompletenessLines({ temporalLines, subRequestAuthority, subRequestResults }) {
  if (temporalLines.length === 0) return { lines: [], scanLines: [] };
  const lines = ["아래 내용은 현재 구조화 Event에서 확인된 범위이며 전체 변경 이력의 완전성을 의미하지 않습니다."];
  if (subRequestAuthority === "STRUCTURED") {
    for (const result of subRequestResults) {
      const shortfall = (result.missing_reasons ?? []).find(
        (r) => r.reason_code === "INSUFFICIENT_VERIFIED_EVENTS" || r.reason_code === "VERIFIED_EVENT_NOT_RENDERED"
      );
      if (!shortfall) continue;
      const { required, available, rendered } = shortfall.target ?? {};
      const confirmed = typeof rendered === "number" ? rendered : available;
      if (typeof required === "number" && typeof confirmed === "number") {
        lines.push(`요청하신 시간순 정리에 필요한 사건 중 ${confirmed}/${required}건만 현재 구조화 자료에서 확인되었고, 나머지 구간은 확인되지 않았습니다.`);
      }
    }
  }
  return { lines, scanLines: [...lines] };
}

function chooseConclusion({ comparisonLines, temporalLines, latestStateLines, informationLimitLines, eventCountSignal }) {
  if (comparisonLines.length > 0) return "질문하신 비교 결과는 다음과 같습니다.";
  if (temporalLines.length > 0 && eventCountSignal >= 2) return "관련 사건을 시간 순서대로 정리하면 다음과 같습니다.";
  if (latestStateLines.length > 0) return "가장 최근 유효한 조건은 다음과 같습니다.";
  if (informationLimitLines.length > 0) return "확인된 내용과 확인되지 않은 항목을 함께 안내드립니다.";
  return "확인된 공시 내용은 다음과 같습니다.";
}

export function composeResponse({ facts = [], events = [], evidence = [], calculationValue = {}, signals, narrativeFields, slots = [], companyLabels = null, calculationRegistry = [], informationLimits = [] }) {
  if (!signals) throw new TypeError("composeResponse requires planner signals");
  if (!narrativeFields) throw new TypeError("composeResponse requires narrative field extraction output");

  const appliedCapabilities = [];
  const notImplementedCapabilities = [];
  const compositionWarnings = [...narrativeFields.blockers.map((b) => ({ type: "unresolved_provenance", ...b }))];
  const usedFactIds = new Set();
  const usedEventIds = new Set();
  const usedEvidenceIds = new Set();
  const claims = [];

  const multiplicityRequiresLabels = signals.entities.length >= 2 || signals.multi_period_metric_families.length > 0;
  const eventsById = new Map(events.map((event) => [event.event_id, event]));

  // Turn M10: form investment disclosure groups FIRST, then exclude their
  // member facts from the ordinary per-fact rendering path below (never
  // double-rendered as both a combined group line AND a separate bullet).
  // Ambiguous members (grouping refused) are deliberately left IN `facts`
  // so they still get the ordinary, safe per-fact fallback rendering.
  const investmentGrouping = groupInvestmentDisclosureItems(facts);
  const groupedFactIds = new Set(investmentGrouping.groups.flatMap((g) => [g.target, g.amount, g.purpose].filter(Boolean).map((f) => f.fact_id)));
  const factsForOrdinaryRendering = facts.filter((f) => !groupedFactIds.has(f.fact_id));
  if (investmentGrouping.ambiguousFactIds.length > 0) {
    compositionWarnings.push({ type: "PLAN_AUTHORING_REVIEW_REQUIRED", reason: "ambiguous investment disclosure group (multiple same-role Facts share one corp_code+source_document_id with no safe pairing)", fact_ids: investmentGrouping.ambiguousFactIds });
  }
  const investmentGroupLines = renderInvestmentDisclosureGroupLines(investmentGrouping.groups, companyLabels, eventsById);
  investmentGroupLines.usedFactIds.forEach((id) => usedFactIds.add(id));
  claims.push(...investmentGroupLines.claims);

  const valueLines = renderValueLines(sortFactFamiliesChronologically(factsForOrdinaryRendering), multiplicityRequiresLabels, companyLabels, eventsById);
  valueLines.usedFactIds.forEach((id) => usedFactIds.add(id));
  claims.push(...valueLines.claims);
  compositionWarnings.push(...valueLines.warnings);
  if (multiplicityRequiresLabels && valueLines.lines.length) appliedCapabilities.push("ENTITY_AND_PERIOD_LABELING");
  if (investmentGroupLines.lines.length) appliedCapabilities.push("DISCLOSURE_GROUP_ATTRIBUTION");

  const winnerSentences = renderWinnerSentences(signals.comparison_dimensions, calculationValue, companyLabels, calculationRegistry);
  const changeFlag = renderChangeFlagSentences(calculationValue);
  // Every successful Calculator result (recorded in calculationRegistry
  // with explicit output_kind/formula/input_labels -- see
  // thin-structured-flow.mjs) is rendered here through the small complete
  // formula-x-output_kind template matrix; no calculation result is
  // silently unrenderable just because its key doesn't match a known
  // suffix convention, and no per-key label map exists.
  const registryExtra = renderCalculationRegistryEntries(calculationRegistry, companyLabels, calculationValue);
  // Turn M capability D: an opportunistic, shape-detected summary of each
  // entity's own growth pattern plus a cross-entity comparison, only when
  // the registry itself has the "two resolved entities x two percentage-
  // change metrics" shape -- see renderGrowthComparisonSummary's header.
  const growthSummary = renderGrowthComparisonSummary(calculationRegistry, companyLabels);
  // Turn M2 item 5: same shape-detected-summary pattern as growthSummary
  // above, for the "2+ resolved companies each with an operating-margin
  // RATIO" shape -- see renderOperatingMarginComparisonSummary's header.
  const marginSummary = renderOperatingMarginComparisonSummary(calculationRegistry, companyLabels);
  const comparisonLines = [...winnerSentences.lines, ...changeFlag.lines, ...registryExtra.lines, ...growthSummary.lines, ...marginSummary.lines];
  const comparisonScanLines = [...winnerSentences.scanLines, ...changeFlag.scanLines, ...registryExtra.scanLines, ...growthSummary.scanLines, ...marginSummary.scanLines];
  claims.push(...changeFlag.claims, ...registryExtra.claims);
  if (comparisonLines.length) appliedCapabilities.push("COMPARATIVE_CONCLUSION");

  // ENTITY_LABEL_RESOLUTION: only applied when EVERY entity label this
  // request needed (per-entity bracket labels AND winner labels) resolved
  // to a real VERIFIED name -- never when any of them fell back to
  // UNRESOLVED_ENTITY_LABEL. A bare corp_code never counts as resolved,
  // and never appears in compositionWarnings either (only the corp_code
  // VALUE itself is logged internally for operator diagnosis, never
  // surfaced in narrative_text/answer).
  const allUnresolvedCorpCodes = unique([...valueLines.unresolvedCompanyCodes, ...winnerSentences.unresolvedCorpCodes]);
  if (signals.required_capabilities.includes("ENTITY_LABEL_RESOLUTION")) {
    if (allUnresolvedCorpCodes.length === 0) {
      appliedCapabilities.push("ENTITY_LABEL_RESOLUTION");
    } else {
      compositionWarnings.push({ type: "unresolved_entity_label", capability_id: "ENTITY_LABEL_RESOLUTION", corp_codes: allUnresolvedCorpCodes });
    }
  }

  const temporal = signals.event_count >= 2 ? renderTemporalSentences(events) : { lines: [], scanLines: [], claims: [], usedEventIds: [], warnings: [] };
  temporal.usedEventIds.forEach((id) => usedEventIds.add(id));
  claims.push(...temporal.claims);
  compositionWarnings.push(...temporal.warnings);
  if (temporal.lines.length) appliedCapabilities.push("TEMPORAL_EVENT_SYNTHESIS");

  // Turn M2 item 8: a direct-conclusion sentence stating the overall
  // state transition (A상태→B상태) across the FIRST and LAST VERIFIED
  // Event of this request, explicitly framed as a confirmed disclosure
  // event ("공시 사건으로 확인됩니다") -- required Response Composer output,
  // never a deferrable "style request" (see renderEventStateTransitionConclusion's header).
  const stateTransition = signals.event_count >= 2 ? renderEventStateTransitionConclusion(events) : { lines: [], scanLines: [] };
  if (stateTransition.lines.length) appliedCapabilities.push("STATE_TRANSITION_CONCLUSION");

  // Turn M3 item 7B: a Fact-level analog of the Event-based transition
  // above, for a single *_STATUS Fact whose own raw_label already encodes
  // a FROM->TO shape (see renderFactLevelLifecycleTransition's header).
  const factLifecycleTransition = renderFactLevelLifecycleTransition(facts);
  if (factLifecycleTransition.lines.length) appliedCapabilities.push("FACT_LEVEL_LIFECYCLE_TRANSITION");

  // Turn M3 item 7A: authorization -> commercialization progress + a
  // generic per-item information-limit clause (see
  // renderProductLifecycleConclusion's header).
  const productLifecycle = renderProductLifecycleConclusion(facts);
  if (productLifecycle.lines.length) appliedCapabilities.push("PRODUCT_LIFECYCLE_CONCLUSION");

  // Turn M10: see renderShareCorrectionConclusion's header.
  const shareCorrection = renderShareCorrectionConclusion(facts, events);
  claims.push(...shareCorrection.claims);
  if (shareCorrection.lines.length) appliedCapabilities.push("SHARE_CORRECTION_CONCLUSION");

  // Turn M3 item 7C: see renderIndirectConfirmationSentences' header.
  const indirectConfirmation = renderIndirectConfirmationSentences(evidence, events, facts);
  indirectConfirmation.usedEvidenceIds.forEach((id) => usedEvidenceIds.add(id));
  if (indirectConfirmation.lines.length) appliedCapabilities.push("INDIRECT_CONFIRMATION_ATTRIBUTION");

  const latestState = renderLatestStateSentences(calculationValue);
  claims.push(...latestState.claims);
  if (latestState.lines.length) appliedCapabilities.push("LATEST_EFFECTIVE_STATE");

  const infoLimits = renderInformationLimitSentences(narrativeFields.information_limits);
  claims.push(...infoLimits.claims);
  for (const item of narrativeFields.information_limits) if (item.fact_id) usedFactIds.add(item.fact_id);
  if (infoLimits.lines.length) appliedCapabilities.push("INFORMATION_LIMIT_DISCLOSURE");

  // Turn M8: see renderInformationLimitDeclarations' own header --
  // Plan-declared "no direct Fact for this requested metric" honesty,
  // distinct from infoLimits above (which handles a Fact that DOES
  // exist but carries a special value_status).
  const factsByIdForInformationLimits = new Map(facts.map((f) => [f.fact_id, f]));
  const informationLimitDeclarations = renderInformationLimitDeclarations(informationLimits, factsByIdForInformationLimits);
  for (const decl of informationLimitDeclarations.declarations) for (const id of decl.supporting_fact_ids) usedFactIds.add(id);
  if (informationLimitDeclarations.lines.length) appliedCapabilities.push("INFORMATION_LIMIT_DISCLOSURE");

  // Turn M2 item 6B: shape-detected over the SAME already-VERIFIED
  // facts/events this response already uses -- see
  // withheld-disclosure-detection.mjs's header for the exact 3-condition
  // shape (same chain, one WITHHELD->DISCLOSED metric_code pair, every
  // OTHER metric_code in the chain unchanged).
  const withheldToDisclosed = renderWithheldToDisclosedOnlySentences(detectWithheldToDisclosedOnlyChanges(facts, events), companyLabels);
  withheldToDisclosed.usedFactIds.forEach((id) => usedFactIds.add(id));
  if (withheldToDisclosed.lines.length) appliedCapabilities.push("WITHHELD_TO_DISCLOSED_ATTRIBUTION");

  // Turn M3 item 8/COMPOSE_EXISTING_FACTS: see renderValueLines' own
  // collection of these (a generic raw_value_text-vs-displayed-label
  // divergence detector, sentence-narrowed, never a per-question rule).
  const narrativeSourceSentences = renderNarrativeSourceSentences(valueLines.narrativeSources, events);
  claims.push(...narrativeSourceSentences.claims);
  if (narrativeSourceSentences.lines.length) appliedCapabilities.push("NARRATIVE_SOURCE_DISCLOSURE");

  const attribution = renderAttributionSentences(narrativeFields.attributions);
  claims.push(...attribution.claims);
  if (attribution.lines.length) appliedCapabilities.push("ATTRIBUTION_PRESERVATION");

  const alreadyQuotedTexts = new Set(narrativeFields.attributions.map((a) => a.text));
  const qualifier = renderQualifierSentences(narrativeFields.qualifiers, alreadyQuotedTexts);
  if (narrativeFields.qualifiers.length) appliedCapabilities.push("QUALIFIER_PRESERVATION");
  for (const item of [...narrativeFields.attributions, ...narrativeFields.qualifiers]) {
    if (item.fact_id) usedFactIds.add(item.fact_id);
    if (item.evidence_id) usedEvidenceIds.add(item.evidence_id);
  }

  const caveat = renderComparabilityCaveat(signals, calculationValue);
  claims.push(...caveat.claims);
  if (caveat.lines.length) appliedCapabilities.push("NEUTRAL_COMPARABILITY_CAVEAT");

  const citationLines = evidence.map((item) => `- [${item.document_id} | ${item.source_locator}] ${item.quoted_text}`);
  for (const item of evidence) usedEvidenceIds.add(item.evidence_id);
  if (evidence.length > 0 && citationLines.length > 0) appliedCapabilities.push("EVIDENCE_REFERENCED_NARRATIVE");

  // REQUEST_COMPLETENESS requires verifying that every sub-request in the
  // question was actually answered. When the Plan carries structured
  // sub_requests (signals.sub_request_authority === "STRUCTURED" --
  // CANDIDATE-only, see domain/adapters/sub-request-vocabulary.mjs),
  // that IS a real, precisely-checkable authority: each sub_request is
  // evaluated as COVERED / EXPLICIT_INFORMATION_LIMIT / MISSING against
  // what was actually rendered, and the capability is applied only if
  // NONE came back MISSING (never falsely marked covered). Without
  // structured sub_requests (the sentence-ending-verb heuristic count is
  // NOT a release-grade authority), this capability is reported as a
  // permanent NOT_IMPLEMENTED gap rather than silently skipped or falsely
  // marked applied.
  let subRequestResults = [];
  if (signals.sub_request_authority === "STRUCTURED" && Array.isArray(signals.sub_requests)) {
    subRequestResults = signals.sub_request_schema_version === "V2"
      ? evaluateSubRequestCoverageV2(signals.sub_requests, {
          slots, events, claims, informationLimits: narrativeFields.information_limits, appliedCapabilities, notImplementedCapabilities, calculationRegistry,
        })
      : evaluateSubRequestCoverage(signals.sub_requests, {
          slots, events, usedFactIdSet: usedFactIds, usedEventIdSet: usedEventIds,
          informationLimits: narrativeFields.information_limits, appliedCapabilities, notImplementedCapabilities,
        });
    const anyMissing = subRequestResults.some((r) => r.status === "MISSING");
    if (!anyMissing) {
      appliedCapabilities.push("REQUEST_COMPLETENESS");
    } else {
      compositionWarnings.push({
        type: "sub_request_missing",
        capability_id: "REQUEST_COMPLETENESS",
        missing_sub_request_ids: subRequestResults.filter((r) => r.status === "MISSING").map((r) => r.sub_request_id),
      });
    }
  } else if (signals.required_capabilities.includes("REQUEST_COMPLETENESS")) {
    notImplementedCapabilities.push("REQUEST_COMPLETENESS");
    compositionWarnings.push({
      type: "capability_not_implemented",
      capability_id: "REQUEST_COMPLETENESS",
      reason: "no structured sub-request decomposition exists yet; sub_request_count is a heuristic count only",
    });
  }

  const eventCompleteness = renderEventCompletenessLines({
    temporalLines: temporal.lines, subRequestAuthority: signals.sub_request_authority, subRequestResults,
  });

  const conclusion = chooseConclusion({
    comparisonLines, temporalLines: temporal.lines, latestStateLines: latestState.lines,
    informationLimitLines: infoLimits.lines, eventCountSignal: signals.event_count,
  });

  const missingRequired = signals.required_capabilities.filter(
    (c) => !appliedCapabilities.includes(c) && !notImplementedCapabilities.includes(c)
  );
  for (const capabilityId of missingRequired) {
    compositionWarnings.push({ type: "required_capability_not_rendered", capability_id: capabilityId });
  }

  const valueHeader = multiplicityRequiresLabels ? "기업·기간별 값:" : "확인된 값:";
  const combinedValueLines = [...investmentGroupLines.lines, ...valueLines.lines];
  const combinedValueScanLines = [...investmentGroupLines.scanLines, ...valueLines.scanLines];
  const rawNarrativeLines = [
    conclusion,
    ...(combinedValueLines.length ? [valueHeader, ...combinedValueLines] : []),
    ...comparisonLines,
    ...temporal.lines,
    ...stateTransition.lines,
    ...factLifecycleTransition.lines,
    ...productLifecycle.lines,
    ...shareCorrection.lines,
    ...indirectConfirmation.lines,
    ...eventCompleteness.lines,
    ...latestState.lines,
    ...infoLimits.lines,
    ...informationLimitDeclarations.lines,
    ...withheldToDisclosed.lines,
    ...narrativeSourceSentences.lines,
    ...attribution.lines,
    ...qualifier.lines,
    ...caveat.lines,
  ];
  const rawScanNarrativeLines = [
    conclusion,
    ...(combinedValueScanLines.length ? [valueHeader, ...combinedValueScanLines] : []),
    ...comparisonScanLines,
    ...temporal.scanLines,
    ...stateTransition.scanLines,
    ...factLifecycleTransition.scanLines,
    ...productLifecycle.scanLines,
    ...shareCorrection.scanLines,
    ...indirectConfirmation.scanLines,
    ...eventCompleteness.scanLines,
    ...latestState.scanLines,
    ...infoLimits.scanLines,
    ...informationLimitDeclarations.scanLines,
    ...withheldToDisclosed.scanLines,
    ...narrativeSourceSentences.scanLines,
    ...attribution.scanLines,
    ...qualifier.scanLines,
    ...caveat.lines,
  ];
  // Turn M capability G: a final, generic pass over the FULLY ASSEMBLED
  // line list collapses any exact-text repeat (the same conclusion, same
  // latest value, same information-limit sentence, same evidence quote --
  // whatever text happens to repeat) to a single occurrence, keeping the
  // display/scan pairing in sync by index. This is DELIBERATELY the last
  // step, after every render* function above has already run, so it
  // catches cross-section duplication (e.g. the same sentence produced by
  // two different renderers) that no single renderer's own local dedup
  // could see. Structural section headers never collide with real
  // content sentences in practice, so this never accidentally drops one.
  const { displayLines: narrativeLines, scanLines: scanNarrativeLines } = dedupExactLines(rawNarrativeLines, rawScanNarrativeLines);
  const dedupedCitationLines = [...new Set(citationLines)];

  const narrative_text = narrativeLines.join("\n");
  const scan_text = scanNarrativeLines.join("\n");
  const answer = [...narrativeLines, "근거 공시:", ...dedupedCitationLines].join("\n");

  return deepFreeze({
    answer,
    narrative_text,
    scan_text,
    numeric_claims: claims,
    applied_capabilities: unique(appliedCapabilities),
    // {sub_request_id, status} results ONLY -- never a capability ID.
    // Stays [] exactly as before when the Plan carries no structured
    // sub_requests (heuristic-authority / production-default path).
    covered_sub_requests: subRequestResults,
    not_implemented_capabilities: unique(notImplementedCapabilities),
    used_fact_ids: [...usedFactIds],
    used_event_ids: [...usedEventIds],
    used_evidence_ids: [...usedEvidenceIds],
    preserved_information_limits: infoLimits.renderedInformationLimits,
    information_limit_declarations: informationLimitDeclarations.declarations,
    preserved_attributions: narrativeFields.attributions,
    preserved_narrative_sources: valueLines.narrativeSources,
    preserved_qualifiers: narrativeFields.qualifiers,
    // Every qualifier this Composer can currently surface is detected by
    // scanning a WHOLE Fact.raw_value_text or Evidence.quoted_text
    // sentence (see synthesis-signal-planner.mjs's scanNarrativeSources) --
    // never attributed to one specific embedded number inside a
    // multi-value string. Turn I §4: this is honestly labeled
    // FACT_LEVEL_COARSE rather than implying per-value precision that
    // does not exist yet (that would require a Fact ontology migration
    // splitting compressed multi-value Facts into atomic ones -- out of
    // scope here, and never silently assumed).
    qualifier_scope: narrativeFields.qualifiers.length > 0 ? "FACT_LEVEL_COARSE" : null,
    composition_warnings: compositionWarnings,
    // Company-resolution metadata (CANDIDATE-only): populated only when a
    // caller passes companyLabels (a CompanyResolver-produced, request-
    // scoped map). used_company_codes/unresolved_company_codes let an
    // official-mode caller decide to degrade to PARTIAL/warn on an
    // unresolved code -- this composer never makes that policy decision
    // itself, and never fills an unresolved label from question text.
    used_company_codes: valueLines.usedCompanyCodes,
    resolved_company_labels: valueLines.resolvedCompanyLabels,
    unresolved_company_codes: valueLines.unresolvedCompanyCodes,
  });
}
