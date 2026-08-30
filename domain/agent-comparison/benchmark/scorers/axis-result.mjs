// Turn P6 section C: the one shared shape every scorer returns --
// { status, raw_score, error_codes, details } (benchmark-item-result.schema.json's
// $defs.axisResult). No scorer computes a single combined quality number;
// this is deliberately the smallest common helper, not a scoring framework.
export function pass(details = {}) {
  return Object.freeze({ status: "PASS", raw_score: 1, error_codes: [], details: Object.freeze(details) });
}

export function fail(errorCodes, details = {}) {
  const codes = Array.isArray(errorCodes) ? errorCodes : [errorCodes];
  return Object.freeze({ status: "FAIL", raw_score: 0, error_codes: Object.freeze([...codes]), details: Object.freeze(details) });
}

// Partial credit (e.g. 3 of 4 required Facts covered) -- still FAIL if
// raw_score < 1 (this Turn's contract: coverage is binary PASS only at
// raw_score===1; anything less is a real gap, reported with its own
// error_codes), but the fractional raw_score is preserved for the
// axis_summary mean/median rather than collapsing every partial result to 0.
export function partial(rawScore, errorCodes, details = {}) {
  const codes = Array.isArray(errorCodes) ? errorCodes : [errorCodes];
  const clamped = Math.max(0, Math.min(1, rawScore));
  return Object.freeze({ status: clamped >= 1 ? "PASS" : "FAIL", raw_score: clamped, error_codes: Object.freeze([...codes]), details: Object.freeze(details) });
}

export function notApplicable(details = {}) {
  return Object.freeze({ status: "NOT_APPLICABLE", raw_score: null, error_codes: [], details: Object.freeze(details) });
}

export function skipped(details = {}) {
  return Object.freeze({ status: "SKIPPED", raw_score: null, error_codes: [], details: Object.freeze(details) });
}
