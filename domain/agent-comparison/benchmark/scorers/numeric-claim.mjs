// Turn P6 section C.2: Numeric Claim Scorer. Value AND unit must both
// match -- a correct number with the wrong unit is a distinct FAIL
// (UNIT_MISMATCH), never silently accepted as if it were the same claim.
// Reuses hard-claim-grounding.mjs's own extractHardClaims for number
// extraction (never a second, divergent number parser -- the same
// "what counts as the same number" rule this codebase already committed to
// for post-generation grounding applies here too). Scale conversion
// (천원/백만원/억원) is accepted ONLY when BOTH the DatasetRecord's own
// expectedNumericClaim.unit_conversion_allowed is true AND the active
// ScoringPolicy explicitly lists that exact (from_unit, to_unit) pair --
// an unlisted, ad-hoc derived calculation is never accepted as a match,
// even when unit_conversion_allowed is true.
import { extractHardClaims } from "../../flows/hard-claim-grounding.mjs";
import { pass, partial, notApplicable } from "./axis-result.mjs";

const UNIT_LABELS_KO = Object.freeze({
  KRW: ["원"],
  PERCENT: ["%", "퍼센트"],
  SHARES: ["주"],
  THOUSAND_KRW: ["천원"],
  MILLION_KRW: ["백만원"],
  HUNDRED_MILLION_KRW: ["억원"],
});

function unitLabelsFor(unit) {
  return UNIT_LABELS_KO[unit] ?? [unit];
}

function formatCommaGrouped(value) {
  return Math.trunc(value).toLocaleString("en-US");
}

// A claim's value is "present" in the text if either its comma-grouped or
// its bare digit-string form appears among the text's own extracted
// numbers (extractHardClaims already normalizes both to the same
// comma-stripped form, so a single membership check covers both).
function valuePresent(text, value) {
  const numbers = new Set(extractHardClaims(text).numbers);
  return numbers.has(String(Math.trunc(value))) || numbers.has(formatCommaGrouped(value).replaceAll(",", ""));
}

function unitPresent(text, unit) {
  return unitLabelsFor(unit).some((label) => text.includes(label));
}

// Returns the set of (value, unit) pairs a claim may legitimately match:
// always its own (value, unit); plus, only when unit_conversion_allowed
// AND the policy lists a conversion whose to_unit equals this claim's unit,
// the equivalent (value / multiplier, from_unit) pair too.
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

  let matched = 0;
  const errorCodes = [];
  const mismatches = [];
  for (const claim of expectedNumericClaims) {
    const forms = acceptableForms(claim, numericUnitConversions);
    const exactMatch = forms.some((form) => valuePresent(answerText, form.value) && unitPresent(answerText, form.unit));
    if (exactMatch) {
      matched += 1;
      continue;
    }
    const valueOnlyMatch = forms.some((form) => valuePresent(answerText, form.value));
    if (valueOnlyMatch) {
      errorCodes.push("UNIT_MISMATCH");
      mismatches.push({ role: claim.role, expected_value: claim.value, expected_unit: claim.unit, reason: "UNIT_MISMATCH" });
    } else {
      errorCodes.push("MISSING_NUMERIC_CLAIM");
      mismatches.push({ role: claim.role, expected_value: claim.value, expected_unit: claim.unit, reason: "MISSING_NUMERIC_CLAIM" });
    }
  }

  const rawScore = matched / expectedNumericClaims.length;
  if (rawScore >= 1) return pass({ matched_count: matched, expected_count: expectedNumericClaims.length });
  return partial(rawScore, errorCodes, { matched_count: matched, expected_count: expectedNumericClaims.length, mismatches });
}
