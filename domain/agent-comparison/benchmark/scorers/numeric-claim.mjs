// Turn P6 section C.2 (hardened Turn P6.1): Numeric Claim Scorer. Value AND
// unit must both match, AND must be BOUND TO THE SAME OCCURRENCE in the
// answer text -- a number appearing anywhere in the text and a unit label
// appearing anywhere else in the text are NEVER combined into a match
// (Turn P6.1's own fix: the pre-fix version checked value-presence and
// unit-presence independently across the WHOLE text, so "주식수는
// 4,250,000,000주이고 수수료는 1원입니다" would wrongly PASS an expected
// "4,250,000,000 KRW" claim just because "원" appears somewhere in the
// sentence, bound to an unrelated "1원").
//
// This module does its OWN position-aware number extraction (mirroring
// domain/agent-comparison/flows/hard-claim-grounding.mjs's regex/blanking
// order exactly, so "what counts as a number token" never drifts between
// the two modules) rather than reusing that module's set-only
// extractHardClaims -- a benchmark scorer needs each occurrence's TEXT
// POSITION for the unit-binding window check, which a membership-set
// extractor cannot expose. hard-claim-grounding.mjs itself is
// UNMODIFIED -- benchmark scoring accuracy fixes never touch
// production Agent grounding code.
//
// Math.trunc is NEVER used anywhere in this file (Turn P6.1 section B.1) --
// 5.5 and 5 are distinct values, decimals/negatives/zero are all preserved
// exactly via standard `Number(...)` parsing of a comma-stripped digit
// string (an explicit decimal normalization, not an arbitrary epsilon
// comparison -- two IEEE754 doubles produced by the SAME parse of
// equivalent decimal notation are bit-identical, so plain `===` is exact
// here, never "close enough").
import { pass, partial, notApplicable } from "./axis-result.mjs";

const UNIT_LABELS_KO = Object.freeze({
  KRW: ["원"],
  PERCENT: ["%", "퍼센트"],
  SHARES: ["주"],
  THOUSAND_KRW: ["천원"],
  MILLION_KRW: ["백만원"],
  HUNDRED_MILLION_KRW: ["억원"],
});

// How close (in characters) a unit label must be to a number's own span to
// count as "bound" to that specific occurrence -- mirrors date-claim.mjs's
// own ROLE_WINDOW convention/size exactly (same style, same precedent).
const UNIT_WINDOW = 15;

// Same regex set + blanking order as hard-claim-grounding.mjs's own
// extractHardClaims, duplicated here (not imported) so this module can
// additionally capture each match's text POSITION -- extractHardClaims is
// a membership-set extractor only and does not expose that. Unlike that
// module, each pattern here also accepts an OPTIONAL leading "-" (a real
// disclosure decrease/loss figure, e.g. "-12.5%") -- a negative-lookbehind
// guard (never preceded by a letter/digit/comma/dot/minus) preserves the
// original patterns' own "never glued to a preceding identifier" behavior
// (e.g. "v2.5" still never extracts "2.5").
const NOT_GLUED_TO_NUMBER_OR_LETTER = "(?<![A-Za-z0-9.,-])";
const COMMA_GROUPED_NUMBER_PATTERN = new RegExp(`${NOT_GLUED_TO_NUMBER_OR_LETTER}-?[0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?`, "g");
const DECIMAL_NUMBER_PATTERN = new RegExp(`${NOT_GLUED_TO_NUMBER_OR_LETTER}-?[0-9]+\\.[0-9]+\\b`, "g");
const LONG_DIGIT_RUN_PATTERN = new RegExp(`${NOT_GLUED_TO_NUMBER_OR_LETTER}-?[0-9]{4,}\\b`, "g");
const ISO_DATE_PATTERN = /[0-9]{4}[-.][0-9]{2}[-.][0-9]{2}/g;
const KOREAN_DATE_PATTERN = /[0-9]{4}\s*년(?:\s*[0-9]{1,2}\s*월(?:\s*[0-9]{1,2}\s*일)?)?/g;
// hard-claim-grounding.mjs deliberately never extracts a bare 1-3-digit
// integer at all (avoiding false hallucination flags on incidental small
// numbers like list markers). THIS scorer is not flagging hallucinations,
// it is checking presence against a small, KNOWN, finite expected-claim
// list -- so a short value like 0 (a real, required "0원" case) must still
// be checked. Run LAST (after the longer patterns' own blanking) so it
// only ever sees what the longer, more specific patterns did not already
// consume.
const SHORT_DIGIT_RUN_PATTERN = new RegExp(`${NOT_GLUED_TO_NUMBER_OR_LETTER}-?[0-9]{1,3}\\b`, "g");

function blankMatches(text, pattern) {
  return text.replace(pattern, (match) => " ".repeat(match.length));
}

// Explicit decimal normalization: strip comma grouping, then parse via the
// standard Number() decimal grammar -- never Math.trunc, never a rounding
// step, never an epsilon-based "close enough" comparison downstream.
function canonicalDecimal(value) {
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(number)) return null;
  return number;
}

// Position-aware number occurrences: [{ value, start, end }]. Dates are
// blanked out FIRST (same order hard-claim-grounding.mjs uses) so a date's
// own digits (e.g. "2025" in "2025-04-28") are never picked up as an
// unrelated bare number.
function extractNumberOccurrences(text) {
  let working = text;
  working = blankMatches(working, ISO_DATE_PATTERN);
  working = blankMatches(working, KOREAN_DATE_PATTERN);

  const occurrences = [];
  for (const match of working.matchAll(COMMA_GROUPED_NUMBER_PATTERN)) {
    occurrences.push({ value: canonicalDecimal(match[0]), start: match.index, end: match.index + match[0].length });
  }
  working = blankMatches(working, COMMA_GROUPED_NUMBER_PATTERN);
  for (const match of working.matchAll(DECIMAL_NUMBER_PATTERN)) {
    occurrences.push({ value: canonicalDecimal(match[0]), start: match.index, end: match.index + match[0].length });
  }
  working = blankMatches(working, DECIMAL_NUMBER_PATTERN);
  for (const match of working.matchAll(LONG_DIGIT_RUN_PATTERN)) {
    occurrences.push({ value: canonicalDecimal(match[0]), start: match.index, end: match.index + match[0].length });
  }
  working = blankMatches(working, LONG_DIGIT_RUN_PATTERN);
  for (const match of working.matchAll(SHORT_DIGIT_RUN_PATTERN)) {
    occurrences.push({ value: canonicalDecimal(match[0]), start: match.index, end: match.index + match[0].length });
  }
  return occurrences;
}

// Every occurrence of every unit LABEL in the text, with its own position
// (analogous to extractNumberOccurrences, but for unit labels).
function findUnitLabelOccurrences(text) {
  const occurrences = [];
  for (const [unit, labels] of Object.entries(UNIT_LABELS_KO)) {
    for (const label of labels) {
      let searchFrom = 0;
      for (;;) {
        const index = text.indexOf(label, searchFrom);
        if (index === -1) break;
        occurrences.push({ unit, start: index, end: index + label.length });
        searchFrom = index + label.length;
      }
    }
  }
  return occurrences;
}

// Character gap between two non-overlapping (or touching) spans -- 0 when
// adjacent or overlapping, otherwise the count of characters strictly
// between them.
function spanGap(a, b) {
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return 0;
}

// THE core binding rule (Turn P6.1 fix): a unit label binds to its
// NEAREST number occurrence within UNIT_WINDOW, never to "any number
// occurrence within reach." Without this nearest-neighbor rule, a fixed
// window alone is not enough -- "주식수는 4,250,000,000주이고 수수료는
// 1원입니다" has "원" only ~10 characters from the big number (within a
// 15-char window either way), but "원" is even closer to the SMALL "1" it
// actually belongs to; nearest-neighbor assignment correctly binds "원" to
// "1", never to the unrelated large number. Returns an array parallel to
// `numberOccurrences`, each entry the Set of units bound to that number.
function bindUnitsToNumbers(text, numberOccurrences) {
  const boundUnitsByIndex = numberOccurrences.map(() => new Set());
  for (const unitOccurrence of findUnitLabelOccurrences(text)) {
    let bestIndex = -1;
    let bestGap = Infinity;
    numberOccurrences.forEach((numberOccurrence, index) => {
      const gap = spanGap(unitOccurrence, numberOccurrence);
      if (gap <= UNIT_WINDOW && gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    });
    if (bestIndex !== -1) boundUnitsByIndex[bestIndex].add(unitOccurrence.unit);
  }
  return boundUnitsByIndex;
}

// Returns the set of (value, unit) pairs a claim may legitimately match:
// always its own (value, unit); plus, only when unit_conversion_allowed AND
// the policy lists a conversion whose to_unit equals this claim's unit, the
// equivalent (value / multiplier, from_unit) pair too.
function acceptableForms(claim, numericUnitConversions) {
  const forms = [{ value: claim.value, unit: claim.unit }];
  if (claim.unit_conversion_allowed) {
    for (const conversion of numericUnitConversions ?? []) {
      if (conversion.to_unit === claim.unit) {
        forms.push({ value: claim.value / conversion.multiplier, unit: conversion.from_unit });
      }
    }
  }
  return forms;
}

export function scoreNumericClaim({ expectedNumericClaims, answerText, numericUnitConversions = [] }) {
  if (!Array.isArray(expectedNumericClaims) || expectedNumericClaims.length === 0) return notApplicable();

  const text = typeof answerText === "string" ? answerText : "";
  const occurrences = extractNumberOccurrences(text);
  const boundUnitsByIndex = bindUnitsToNumbers(text, occurrences);

  let matched = 0;
  const errorCodes = [];
  const mismatches = [];
  for (const claim of expectedNumericClaims) {
    const forms = acceptableForms(claim, numericUnitConversions);
    const formValues = new Set(forms.map((form) => canonicalDecimal(form.value)));
    const formUnitByValue = new Map(forms.map((form) => [canonicalDecimal(form.value), form.unit]));

    const matchingIndices = occurrences
      .map((occurrence, index) => ({ occurrence, index }))
      .filter(({ occurrence }) => formValues.has(occurrence.value));
    if (matchingIndices.length === 0) {
      errorCodes.push("MISSING_NUMERIC_CLAIM");
      mismatches.push({ role: claim.role, expected_value: claim.value, expected_unit: claim.unit, reason: "MISSING_NUMERIC_CLAIM" });
      continue;
    }

    const boundCorrectly = matchingIndices.some(({ occurrence, index }) => {
      const expectedUnitHere = formUnitByValue.get(occurrence.value);
      return boundUnitsByIndex[index].has(expectedUnitHere);
    });
    if (boundCorrectly) {
      matched += 1;
      continue;
    }
    // The value is present, but no occurrence of it is bound to the
    // required unit -- whether a DIFFERENT unit is bound nearby, or no
    // unit at all is, this is a unit-binding failure, never a silent PASS.
    errorCodes.push("UNIT_MISMATCH");
    mismatches.push({ role: claim.role, expected_value: claim.value, expected_unit: claim.unit, reason: "UNIT_MISMATCH" });
  }

  const rawScore = matched / expectedNumericClaims.length;
  if (rawScore >= 1) return pass({ matched_count: matched, expected_count: expectedNumericClaims.length });
  return partial(rawScore, errorCodes, { matched_count: matched, expected_count: expectedNumericClaims.length, mismatches });
}
