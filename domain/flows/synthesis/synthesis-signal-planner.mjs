// Generic synthesis-signal planner: evaluates the 10 capability catalog's
// applies_when conditions (work/domain-seed/seed-response-synthesis-requirements.v0.1.json)
// against already-fetched, already-VERIFIED structured runtime data --
// facts/events/evidence/calculationValue -- and the plan's own question
// text (used only for a generic, language-structural sub-request count,
// never for Seed-specific substring matching).
//
// FORBIDDEN, by construction: no question_id comparison, no company/
// document-name branching, no reading of Gold/expected_answer, no
// `if (question.includes("특정 Seed 문구"))`. Every signal here is derived
// from the shape of the data (how many distinct corp_codes, how many
// events, which calculationValue keys carry a diff/change/latest/status
// pattern, which quoted texts contain a small set of GENERIC Korean
// epistemic/qualifier markers that apply to any company's disclosure
// writing). The planner's output is deep-frozen and built fresh per call
// -- no shared mutable state survives across requests.
import { deepFreeze } from "./deep-freeze.mjs";

// Generic value-status vocabulary for "this field's meaning is a
// disclosed information limit, not a system defect" -- these four literal
// tokens are the project's own official Value Status / Answerability
// vocabulary (CLAUDE.md section 4/8), not Seed-specific strings.
const INFORMATION_LIMIT_VALUES = new Set(["NOT_FOUND", "NOT_APPLICABLE", "OUTSIDE_CORPUS", "WITHHELD"]);

// Generic Korean epistemic markers indicating a company's own stated
// judgment/forecast/plan rather than a bare disclosed fact. These are
// ordinary Korean disclosure-writing conventions (판단/전망/예상/계획/기대
// + a first-person corporate subject marker), applicable to any issuer's
// filings -- not tied to any company name.
const ATTRIBUTION_MARKERS = ["전망", "예상", "기대", "계획", "당사는", "회사는"];

// Turn M3 item 8: "판단" is checked SEPARATELY, as a standalone verb form
// (판단하다/판단되다 and their conjugations), never a plain substring --
// a bare `sentence.includes("판단")` also matches "투자판단 관련
// 주요경영사항", a FIXED real DART disclosure section title (a compound
// noun, "investment-judgment-related material matter"), which is not the
// company expressing its own judgment at all. Confirmed as a real, corpus-
// wide false positive (not a single-question edge case) via direct
// inspection of the VERIFIED Evidence artifact.
const STANDALONE_JUDGMENT_PATTERN = /판단(?=하|되|됨)/;

// Qualifier markers that are safe to match as plain substrings: none of
// these collide with a common compound word the way "약" collides with
// "계약"/"해약"/"약정".
const SAFE_QUALIFIER_MARKERS = ["예정", "유보", "잠정", "가량", "내외"];

// "약" only counts as the hedge adverb ("approximately") when it stands on
// its own before a quantity -- preceded by start-of-string/whitespace/
// opening punctuation, and followed (optionally through a short currency/
// unit code, e.g. "약 USD 167백만" -- a common real disclosure pattern
// confirmed against the real corpus) by a digit. This deliberately does
// NOT match "계약", "해약", "약정" (그 안의 "약"은 앞 글자가 한글 음절이라 이
// 경계 조건에 걸리지 않는다).
export const STANDALONE_YAK_PATTERN = /(?:^|[\s([{"'“'·,])약\s?(?:[A-Za-z]{1,5}\s?)?[\d,]/;

// Generic imperative sentence-final markers used to approximate how many
// distinct sub-requests a Korean question is making (e.g. "정리해줘",
// "비교해줘", "구분해줘" each close one imperative clause). This is a
// language-structural heuristic, not a lookup against any specific
// question string.
const IMPERATIVE_ENDING_PATTERN = /(정리해줘|비교해줘|설명해줘|구분해줘|알려줘|해줘)/g;

function unique(values) { return [...new Set(values)]; }

// Turn M4 item 4E: splits VERIFIED narrative text into sentence-ish
// chunks on REAL Korean sentence-final periods only -- never a raw
// list-item marker ("2." / "4.") and never a period inside an unclosed
// quote/bracket span. A period only counts as a boundary when (a) the
// character immediately before it is NOT a digit (rules out list-item
// numbering AND decimal numbers like "12.5%" -- a genuine sentence never
// ends on a bare digit in this corpus's writing style), and (b) every
// quote/bracket character seen so far in the current chunk is balanced
// (never cuts a quote or a disclosure-form list marker like "'2. ...'"
// in half). disclosure text often omits the space after "다." (e.g.
// "...실시하는 건입니다.4. 당사는..."), which this still splits on
// correctly since "다" is not a digit -- the following list marker "4."
// simply stays attached to the front of the NEXT chunk instead of being
// its own orphan fragment, which is more accurate, not less.
export function splitSentences(text) {
  const chunks = [];
  let current = "";
  const openStack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;
    if (ch === "'" || ch === '"' || ch === "‘" || ch === "’" || ch === "“" || ch === "”") {
      // Straight/curly quotes have no distinct open/close glyph in this
      // corpus's own text -- track balance by toggling, not a stack.
      if (openStack.at(-1) === ch) openStack.pop(); else openStack.push(ch);
    } else if (ch === "(" || ch === "[" || ch === "【") {
      openStack.push(ch);
    } else if (ch === ")" || ch === "]" || ch === "】") {
      const matchesOpen = (ch === ")" && openStack.at(-1) === "(") || (ch === "]" && openStack.at(-1) === "[") || (ch === "】" && openStack.at(-1) === "【");
      if (matchesOpen) openStack.pop();
    }
    if (ch === "." ) {
      const prevChar = text[i - 1];
      const isDigitPreceded = prevChar !== undefined && /[0-9]/.test(prevChar);
      const isBalanced = openStack.length === 0;
      if (!isDigitPreceded && isBalanced) {
        chunks.push(current);
        current = "";
      }
    }
  }
  if (current.trim() !== "") chunks.push(current);
  return chunks.map((s) => s.trim()).filter(Boolean);
}

function collectEntities(facts) {
  return unique(facts.map((f) => f.corp_code).filter((v) => typeof v === "string" && v !== ""));
}

// Groups facts by a "metric family" (metric_code with any trailing
// _2023/_2024/_2025-style year suffix stripped) and reports which
// families have 2+ distinct period identities (period_start/period_end or
// as_of_date) -- this is how Q14-style "same metric, two years, no
// label" cases are detected without ever naming the metric_code.
function multiPeriodMetricFamilies(facts) {
  const byFamily = new Map();
  for (const fact of facts) {
    if (typeof fact.metric_code !== "string") continue;
    const family = fact.metric_code.replace(/_?(19|20)\d{2}$/, "");
    const periodKey = fact.period_start || fact.period_end ? `${fact.period_start ?? ""}:${fact.period_end ?? ""}` : (fact.as_of_date ?? "");
    if (!periodKey) continue;
    const set = byFamily.get(family) ?? new Set();
    set.add(periodKey);
    byFamily.set(family, set);
  }
  return [...byFamily.entries()].filter(([, periods]) => periods.size >= 2).map(([family]) => family);
}

function comparisonDimensions(calculationValue) {
  return Object.keys(calculationValue).filter((key) => /_(diff_krw|diff_percent|change_percent|diff_pp)$/.test(key) || /_winner$/.test(key));
}

function comparisonBaseNames(dimensionKeys) {
  return unique(dimensionKeys.map((k) => k.replace(/_(diff_krw|diff_percent|diff_pp|change_percent|winner)$/, "")));
}

function latestStateRequested(calculationValue) {
  return Object.keys(calculationValue).some((key) => key.startsWith("latest_") || key.includes("_effective_"));
}

function informationLimitFields(calculationValue) {
  return Object.entries(calculationValue)
    .filter(([, value]) => typeof value === "string" && INFORMATION_LIMIT_VALUES.has(value))
    .map(([key, value]) => ({ key, value }));
}

// Turn M2 item 7: a real, corpus-observed metric_code shape
// (CORRECTION_TIMELINE_SUMMARY) that compresses MANY point-in-time values
// across a correction history into ONE narrative string is structurally
// different from a "latest condition" Fact -- it is itself a historical
// summary, not a source of the current disclosed condition. Detected
// generically from the metric_code shape (SUMMARY/TIMELINE/HISTORY
// substring -- a real, closed vocabulary of "this field summarizes
// several points in time" naming, never a per-question/per-company
// pattern), never by parsing the compressed string's own content (no PKG-
// amount regex, no date-arrow parsing).
const TIMELINE_SUMMARY_METRIC_PATTERN = /SUMMARY|TIMELINE|HISTORY/i;
function isTimelineSummaryFact(fact) {
  return typeof fact.metric_code === "string" && TIMELINE_SUMMARY_METRIC_PATTERN.test(fact.metric_code);
}
function evidenceIdsReferencedByFacts(facts, predicate) {
  const set = new Set();
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    for (const id of fact.evidence_ids ?? []) set.add(id);
  }
  return set;
}

// Turn M3 item 8: a "single real sentence" length budget shared with
// response-composer.mjs's narrative-source rendering (same constant
// value, kept independent per-module since scan/render are genuinely
// different concerns -- this one gates DETECTION so an overlong quote
// never becomes a "preserved" item the Composer would otherwise be
// required to render verbatim in the body; the Evidence/Fact itself stays
// fully available via the ordinary citation list regardless). A quote
// this long is a multi-item procedural block (numbered lists, referral
// notices), not a genuine hedge/attribution SENTENCE.
const NARRATIVE_CANDIDATE_MAX_CHARS = 200;

// Scans VERIFIED narrative sources (facts with a non-numeric raw_value_text,
// and quoted Evidence text) for the generic marker vocabulary above, one
// SENTENCE at a time. Returns candidates with full provenance and a
// NARROWED text span (never a bare string, never the whole multi-sentence
// quote) so the extractor/composer never has to guess what was scanned or
// re-attribute an unrelated sentence to the marker.
function scanNarrativeSources({ facts, evidence }) {
  const attribution = [];
  const qualifiers = [];
  const scan = (source, id, text) => {
    if (typeof text !== "string" || text === "") return;
    for (const sentence of splitSentences(text)) {
      if (sentence.length > NARRATIVE_CANDIDATE_MAX_CHARS) continue;
      const foundAttribution = ATTRIBUTION_MARKERS.filter((marker) => sentence.includes(marker));
      if (STANDALONE_JUDGMENT_PATTERN.test(sentence)) foundAttribution.push("판단");
      if (foundAttribution.length > 0) attribution.push({ source, id, text: sentence, markers: foundAttribution });
      const foundSafeQualifiers = SAFE_QUALIFIER_MARKERS.filter((marker) => sentence.includes(marker));
      const hasStandaloneYak = STANDALONE_YAK_PATTERN.test(sentence);
      const foundQualifiers = hasStandaloneYak ? ["약", ...foundSafeQualifiers] : foundSafeQualifiers;
      if (foundQualifiers.length > 0) qualifiers.push({ source, id, text: sentence, markers: foundQualifiers });
    }
  };
  // Turn M2 item 7: Evidence reachable ONLY via a timeline-summary Fact's
  // own provenance (never via any OTHER, point-in-time Fact) is
  // historical context, not the current condition's own qualifier source
  // -- a purely metadata-driven exclusion (which Fact's evidence_ids
  // reference which evidence), never a parse of the summary text itself.
  const summaryEvidenceIds = evidenceIdsReferencedByFacts(facts, isTimelineSummaryFact);
  const nonSummaryEvidenceIds = evidenceIdsReferencedByFacts(facts, (f) => !isTimelineSummaryFact(f));
  const summaryOnlyEvidenceIds = new Set([...summaryEvidenceIds].filter((id) => !nonSummaryEvidenceIds.has(id)));
  for (const fact of facts) {
    if (isTimelineSummaryFact(fact)) continue;
    scan("fact", fact.fact_id, fact.raw_value_text ?? null);
  }
  for (const item of evidence) {
    if (summaryOnlyEvidenceIds.has(item.evidence_id)) continue;
    scan("evidence", item.evidence_id, item.quoted_text ?? null);
  }
  return { attribution, qualifiers };
}

// A comparison's basis is mismatched when the facts feeding a computed
// diff/change dimension come from different reporting periods (as_of_date)
// -- Calculator already refuses to compute across mismatched unit/scope/
// scale (thin-structured-flow.mjs's calculatePair), so the ONE mismatch
// dimension that can still silently slip through into a computed diff is
// "which year/period each side's underlying report is drawn from". Scoped
// to only the facts whose metric family actually feeds one of the
// computed comparison_dimensions -- an unrelated Fact for a different
// metric/period pulled into the same request must never flip this signal.
function comparisonBasisMismatch(facts, dimensionKeys) {
  const bases = comparisonBaseNames(dimensionKeys);
  if (bases.length === 0) return false;
  // Real Fact.metric_code is UPPER_SNAKE_CASE ("TERMINATION_AMOUNT") while
  // calculationValue-derived comparison keys/bases are lower_snake_case
  // ("termination_amount_diff_krw" -> base "termination_amount") --
  // case-insensitive comparison so this scoping match actually fires
  // instead of silently never matching any real Fact.
  const relevantFacts = facts.filter((fact) => {
    if (typeof fact.metric_code !== "string") return false;
    const metricCodeLower = fact.metric_code.toLowerCase();
    return bases.some((base) => metricCodeLower.startsWith(base.toLowerCase()) || base.toLowerCase().startsWith(metricCodeLower));
  });
  const asOfDates = unique(relevantFacts.map((f) => f.as_of_date).filter((v) => typeof v === "string" && v !== ""));
  const entities = collectEntities(relevantFacts);
  return entities.length >= 2 && asOfDates.length >= 2;
}

function estimateSubRequestCount(questionText) {
  if (typeof questionText !== "string") return 0;
  const matches = questionText.match(IMPERATIVE_ENDING_PATTERN);
  return matches ? matches.length : 0;
}

// `subRequests` (optional): the Plan's own structured, CANDIDATE-only
// sub_requests array (schema_version "0.2.0" -- see
// domain/adapters/sub-request-vocabulary.mjs), when the caller has one.
// This is NEVER read from Gold or reconstructed from question text --
// it is handed to the Flow already validated by the Plan store. When
// present it BECOMES the sub-request-completeness authority in place of
// the sentence-ending-verb heuristic (which is explicitly NOT a release-
// grade signal -- it can both over- and under-count real sub-questions).
// Production callers that don't pass a Plan with sub_requests get
// EXACTLY the previous heuristic-only behavior; this parameter changes
// nothing for them.
export function planSynthesisSignals({ question, facts = [], events = [], evidence = [], calculationValue = {}, subRequests = null }) {
  const entities = collectEntities(facts);
  const multiPeriodFamilies = multiPeriodMetricFamilies(facts);
  const dimensions = comparisonDimensions(calculationValue);
  const informationLimits = informationLimitFields(calculationValue);
  const { attribution, qualifiers } = scanNarrativeSources({ facts, evidence });
  const basisMismatch = comparisonBasisMismatch(facts, dimensions);
  const heuristicSubRequestCount = estimateSubRequestCount(question);
  const latestState = latestStateRequested(calculationValue);

  const hasStructuredSubRequests = Array.isArray(subRequests) && subRequests.length > 0;
  const subRequestAuthority = hasStructuredSubRequests ? "STRUCTURED" : "HEURISTIC";
  const subRequestCount = hasStructuredSubRequests ? subRequests.length : heuristicSubRequestCount;
  // Shape-detected, not schema_version-string-based (the planner never
  // reads plan.schema_version -- it only ever sees the sub_requests
  // array itself): a v2 (0.3.0) sub_request always carries
  // required_output_bindings; a v1 (0.2.0) one never does.
  const subRequestSchemaVersion = hasStructuredSubRequests && Object.hasOwn(subRequests[0], "required_output_bindings") ? "V2" : "V1";

  const signals = {
    entity_count: entities.length,
    entities,
    multi_period_metric_families: multiPeriodFamilies,
    event_count: events.length,
    comparison_dimensions: dimensions,
    latest_state_requested: latestState,
    information_limit_fields: informationLimits,
    attribution_candidates: attribution,
    qualifier_candidates: qualifiers,
    sub_request_schema_version: subRequestSchemaVersion,
    comparison_basis_mismatch: basisMismatch,
    sub_request_count: subRequestCount,
    sub_request_authority: subRequestAuthority,
    sub_requests: hasStructuredSubRequests ? subRequests : null,
  };

  // Capability activation: a direct, generic re-implementation of each
  // catalog entry's applies_when (work/domain-seed/seed-response-synthesis-requirements.v0.1.json),
  // never keyed on question_id/company name.
  const requiredCapabilities = [];
  if (entities.length >= 2 || multiPeriodFamilies.length >= 1) requiredCapabilities.push("ENTITY_AND_PERIOD_LABELING");
  // Turn: whenever this request needs a real human-readable entity name
  // (either because 2+ entities must be labeled, or because a computed
  // comparison needs a winner's name) this capability is REQUIRED and is
  // only ever marked applied if EVERY such corp_code genuinely resolved
  // via companyLabels -- see response-composer.mjs. This is a distinct
  // signal from ENTITY_AND_PERIOD_LABELING (which only checks that a
  // per-entity line was rendered AT ALL, not that its label was a real
  // verified name rather than a bare corp_code fallback).
  if (entities.length >= 2 || Object.keys(calculationValue).some((k) => k.endsWith("_winner_corp_code"))) {
    requiredCapabilities.push("ENTITY_LABEL_RESOLUTION");
  }
  if (dimensions.length >= 1) requiredCapabilities.push("COMPARATIVE_CONCLUSION");
  if (events.length >= 2) requiredCapabilities.push("TEMPORAL_EVENT_SYNTHESIS");
  if (latestState) requiredCapabilities.push("LATEST_EFFECTIVE_STATE");
  if (informationLimits.length >= 1) requiredCapabilities.push("INFORMATION_LIMIT_DISCLOSURE");
  if (attribution.length >= 1) requiredCapabilities.push("ATTRIBUTION_PRESERVATION");
  if (qualifiers.length >= 1) requiredCapabilities.push("QUALIFIER_PRESERVATION");
  // With structured authority we can always precisely verify completeness,
  // so REQUEST_COMPLETENESS is always in scope (not gated on the heuristic
  // count, which is exactly what structured authority replaces).
  if (hasStructuredSubRequests || heuristicSubRequestCount >= 2) requiredCapabilities.push("REQUEST_COMPLETENESS");
  if (basisMismatch) requiredCapabilities.push("NEUTRAL_COMPARABILITY_CAVEAT");
  requiredCapabilities.push("EVIDENCE_REFERENCED_NARRATIVE"); // universal: never just a bullet dump

  return deepFreeze({ ...signals, required_capabilities: unique(requiredCapabilities) });
}
