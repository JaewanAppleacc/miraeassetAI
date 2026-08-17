// Shared, deterministic number-display policy used by BOTH the Response
// Composer (to render text) and the Final Synthesis Validator (to
// independently re-derive the same string and exact-match it against the
// answer) -- see thin-structured-flow.mjs's calculationRegistry and
// Turn I's `display_value` claim contract. This module never performs
// business rounding; it only collapses binary floating-point
// representation noise (e.g. 4.869999999999999 -> 4.87) in the FRACTIONAL
// part of a non-integer number. Integers are never touched.
//
// trimIeeeNoise is the single source of truth for what counts as "noise":
// both the renderer (building display strings) and the validator
// (independently recomputing display_value from a claim's raw value) call
// it, so there is never a second, drifting definition of "close enough".

export function trimIeeeNoise(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) return value;
  // Fixed to 10 decimal places -- generous enough to preserve any
  // genuinely meaningful decimal this domain produces (percentages/ratios
  // with at most a handful of real decimal digits) while still zeroing
  // out noise that typically appears around the 15th-17th significant
  // digit of a double-precision float.
  return Number(value.toFixed(10));
}

// Turn M capability D ("과도한 소수점은 display에만 합리적으로 반올림하되
// raw claim 값은 유지"): rounds a non-integer to 2 decimal places for
// DISPLAY only. This never touches the claim's own `value` (the raw,
// full-precision Calculator result stays exactly what Calculator
// returned -- only formatDisplayNumber's rendered STRING is rounded), and
// it does not weaken the exact-match grounding boundary: the Final
// Synthesis Validator (final-synthesis-validator.mjs) independently
// recomputes this SAME function from claim.value and requires an exact
// string match against claim.display_value, so the validator's notion of
// "correct" display always tracks whatever this function currently
// produces -- there is no second, drifting rounding rule anywhere else.
export function roundForDisplay(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value)) return value;
  return Number(trimIeeeNoise(value).toFixed(2));
}

// Renders a NUMBER (never a unit suffix -- callers own units/operation
// wording so `display_value` stays a pure digit string the validator can
// exact-match against a token extracted from the answer text) using the
// existing ko-KR integer grouping convention, with noise trimmed for
// non-integers. This does not decide %,%p,원 etc; that is a presentation
// decision made from output_kind/display_operation, not from the number
// itself.
export function formatDisplayNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString("ko-KR");
  return String(roundForDisplay(value));
}

// Turn M2 item 4: moved here (from response-composer.mjs, where it was
// previously private) so change-direction.mjs and
// final-synthesis-validator.mjs can resolve the SAME unit word the
// Composer renders, rather than each carrying its own copy that could
// silently drift. Fact.unit is inconsistent in the real VERIFIED corpus
// between the enum token (PERCENT/SHARES) and the raw Korean/symbol label
// directly (%/주) -- both are recognized; an unrecognized token passes
// through unchanged (still a valid literal unit word), and only a falsy
// unit (missing/empty) resolves to "" (no unit to append).
export function unitLabel(unit) { return ({ KRW: "원", PERCENT: "%", SHARES: "주" })[unit] ?? unit ?? ""; }
