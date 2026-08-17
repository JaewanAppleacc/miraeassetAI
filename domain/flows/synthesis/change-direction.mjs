// Turn M2 item 4: generic (never question-specific) natural-language
// direction-of-change rendering for a signed numeric Fact that itself
// represents a "value vs. previous value" delta -- e.g. the real VERIFIED
// corpus carries a Fact with metric_code "HOLDING_SHARES_CHANGE" and
// raw_label "증감 (주식등의 수)" whose normalized_value is a signed
// SHARES count (-38791). The raw claim value is NEVER mutated by this
// module -- callers keep exact-matching it against the source Fact field
// exactly as before; only the rendered STRING differs.
//
// Shared between response-composer.mjs (renders) and
// final-synthesis-validator.mjs (independently re-derives from the exact
// same raw value + unit and exact-matches the result), exactly like
// number-formatting.mjs's formatDisplayNumber -- a single source of truth
// so the two can never drift apart.
import { formatDisplayNumber } from "./number-formatting.mjs";

// A change/delta-shaped metric_code or raw_label, generically detected
// from REAL corpus shapes already observed directly in the VERIFIED Fact
// artifact (never invented, never a per-question guess): a metric_code
// containing the segment CHANGE (e.g. HOLDING_SHARES_CHANGE), or a
// raw_label containing the Korean term 증감 ("increase/decrease"), which
// is how the real corpus itself labels this kind of field. A Fact that
// matches neither shape has no established "vs. previous" comparison
// basis, so callers must not invent a direction sentence for it -- the
// existing plain-number rendering stays the safe, conservative default.
const CHANGE_METRIC_CODE_PATTERN = /(?:^|_)CHANGE(?:_|$)/;
const CHANGE_RAW_LABEL_PATTERN = /증감/;

export function hasComparisonBasis(fact) {
  const metricMatches = typeof fact?.metric_code === "string" && CHANGE_METRIC_CODE_PATTERN.test(fact.metric_code);
  const labelMatches = typeof fact?.raw_label === "string" && CHANGE_RAW_LABEL_PATTERN.test(fact.raw_label);
  return metricMatches || labelMatches;
}

// Exact, deterministic rendering -- positive -> 증가, negative -> 감소,
// zero -> 변화 없음 (magnitude/unit omitted for zero: there is no
// magnitude to report). `value` itself is never touched; this only
// produces the display STRING. Returns null when value/unitLabelText
// aren't usable so a caller never accidentally renders "직전보다
// undefined 증가했습니다." -- callers must fall back to the plain-number
// rendering in that case (Turn M2 item 4: "unit 없으면 만들지 않는다").
export function formatDirectionNarrative(value, unitLabelText) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value === 0) return "직전보다 변화가 없습니다.";
  if (typeof unitLabelText !== "string" || unitLabelText === "") return null;
  const magnitude = formatDisplayNumber(Math.abs(value));
  const direction = value > 0 ? "증가" : "감소";
  return `직전보다 ${magnitude}${unitLabelText} ${direction}했습니다.`;
}
