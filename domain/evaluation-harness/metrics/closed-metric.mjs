// Closed-answer scoring. Every result field is one of PASS/FAIL/NOT_SCORED
// (REVIEW_REQUIRED is reserved for open-metric.mjs's paraphrase-dependent
// claims — a Closed answer's expected_answer.value is exact, so there is
// nothing here that legitimately needs human paraphrase judgment).
//
// Deliberately does NOT regex-scrape response.answer for "the first number
// in the string" when no structured value is present: an answer like
// "2025년 매출은 100억원" has "2025" as its first number, which is a year,
// not the metric value. The only trustworthy numeric source is
// think_trace.calculation.result/value, which the answering Flow populates
// deliberately. evaluation-gold.v0.2.schema.json's scoring_spec is frozen
// ({comparator, tolerance, unit, rounding}, additionalProperties:false) and
// currently has no field naming which number in the prose is the answer, so
// there is no safe string fallback today — this returns NOT_SCORED instead
// of guessing. If a future (additive, versioned) Gold extension adds an
// explicit metric selector, that is the only condition under which a string
// fallback should be added here.
import { slotIsGrounded } from "./evidence-match.mjs";

function outcome(status, detail = null) {
  return { status, detail };
}

// The only numeric source this trusts: an explicit, deliberately-populated
// structured value. Coerces a plain numeric string ("4250000000") since
// that is still a deliberate structured value, not prose to scrape — but
// never touches response.answer.
function structuredNumber(response) {
  const calc = response?.think_trace?.calculation ?? {};
  const candidate = calc.result !== undefined ? calc.result : calc.value !== undefined ? calc.value : undefined;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && /^-?\d+(?:\.\d+)?$/.test(candidate.trim())) return Number(candidate);
  return undefined;
}

function structuredRaw(response) {
  const calc = response?.think_trace?.calculation ?? {};
  return calc.result !== undefined ? calc.result : calc.value !== undefined ? calc.value : undefined;
}

function compareScalarNumber(actual, expected, spec) {
  const tolerance = Number(spec.tolerance ?? 0);
  if (spec.comparator === "RELATIVE") return Math.abs(actual - expected) <= Math.abs(expected) * tolerance;
  // EXACT / ABSOLUTE / PERCENTAGE_POINT all reduce to "within tolerance of
  // the target" once tolerance defaults to 0 for EXACT.
  return Math.abs(actual - expected) <= tolerance;
}

// Fixed the RANGE defect: the delivered code nested the RANGE branch inside
// `if (typeof expected.value === "number")`, where Array.isArray(expected.value)
// can never be true — dead code. RANGE is its own top-level branch here,
// checked BEFORE the scalar-number branch, keyed off expected.value being a
// [min, max] array (which is how RANGE-scored Gold records actually encode
// their expected value; scoring_spec.comparator === "RANGE" is the
// corroborating signal, not the sole gate, since a malformed record could
// set the comparator without the matching value shape).
function scoreScalarOrRange(expected, response, spec) {
  if (Array.isArray(expected.value)) {
    if (expected.value.length !== 2 || expected.value.some((n) => typeof n !== "number")) {
      return outcome("NOT_SCORED", "RANGE expected.value must be [min, max] numbers");
    }
    const actual = structuredNumber(response);
    if (actual === undefined) {
      return outcome("NOT_SCORED", "no structured numeric think_trace.calculation.result/value for RANGE comparison");
    }
    const [min, max] = expected.value;
    return outcome(actual >= min && actual <= max ? "PASS" : "FAIL", { actual, range: [min, max] });
  }
  if (typeof expected.value === "number") {
    const actual = structuredNumber(response);
    if (actual === undefined) {
      return outcome(
        "NOT_SCORED",
        "no structured numeric think_trace.calculation.result/value; string fallback needs an explicit Gold metric selector, which the frozen scoring_spec schema does not provide"
      );
    }
    return outcome(compareScalarNumber(actual, expected.value, spec) ? "PASS" : "FAIL", { actual, expected: expected.value });
  }
  if (typeof expected.value === "boolean") {
    const raw = structuredRaw(response);
    if (typeof raw !== "boolean") return outcome("NOT_SCORED", "no structured boolean think_trace.calculation.result/value");
    return outcome(raw === expected.value ? "PASS" : "FAIL");
  }
  if (typeof expected.value === "string") {
    const raw = structuredRaw(response);
    if (typeof raw === "string") return outcome(raw === expected.value ? "PASS" : "FAIL", "compared against structured value");
    if (typeof response?.answer === "string") {
      return outcome(response.answer.includes(expected.value) ? "PASS" : "FAIL", "no structured string value; matched against answer text");
    }
    return outcome("NOT_SCORED", "no comparable value");
  }
  return outcome("NOT_SCORED", `unsupported expected.value type: ${typeof expected.value}`);
}

function compareField(expectedField, actualField, spec) {
  if (typeof expectedField === "number") {
    if (typeof actualField !== "number" || !Number.isFinite(actualField)) {
      return outcome("NOT_SCORED", "expected numeric field is not a structured number in the response");
    }
    return outcome(compareScalarNumber(actualField, expectedField, spec) ? "PASS" : "FAIL");
  }
  if (typeof expectedField === "boolean") {
    return outcome(actualField === expectedField ? "PASS" : "FAIL");
  }
  if (expectedField === null) {
    return outcome(actualField === null ? "PASS" : "FAIL");
  }
  if (typeof expectedField === "string") {
    return outcome(actualField === expectedField ? "PASS" : "FAIL");
  }
  // nested array/object expected field: structural equality, not a guess.
  return outcome(JSON.stringify(actualField) === JSON.stringify(expectedField) ? "PASS" : "FAIL");
}

// Object-shaped expected_answer.value (most of this Seed's Closed
// multi-field answers, e.g. Q8/Q9/Q20) previously fell through to
// `actual === expected.value`, a reference-equality check on two distinct
// object literals that can never pass even for a byte-identical answer.
// Per-field comparison against think_trace.calculation's structured object
// is the only correct approach, and each field gets its own PASS/FAIL/
// NOT_SCORED rather than one blind aggregate.
function scoreObject(expected, response, spec) {
  const raw = structuredRaw(response);
  const structured = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  const fields = {};
  let anyScored = false;
  let anyFail = false;
  let anyUnscored = false;
  for (const [key, expectedField] of Object.entries(expected.value)) {
    // Gold may carry explicitly informational projections under this
    // reserved key. They are useful for diagnostics but, by definition,
    // must not turn an otherwise exact answer into FAIL. Keep their detail
    // visible while excluding them from the aggregate scored status.
    if (key === "non_scored_fields") {
      fields[key] = outcome("NOT_SCORED", "explicitly excluded from scoring by Gold");
      continue;
    }
    if (structured === undefined || !(key in structured)) {
      fields[key] = outcome("NOT_SCORED", "no structured field in think_trace.calculation");
      anyUnscored = true;
      continue;
    }
    const fieldOutcome = compareField(expectedField, structured[key], spec);
    fields[key] = fieldOutcome;
    if (fieldOutcome.status === "PASS") anyScored = true;
    else if (fieldOutcome.status === "FAIL") {
      anyScored = true;
      anyFail = true;
    } else {
      anyUnscored = true;
    }
  }
  const status = !anyScored ? "NOT_SCORED" : anyFail || anyUnscored ? "FAIL" : "PASS";
  return { status, fields };
}

export function scoreClosed(gold, response) {
  const actualAnswerability = response?.think_trace?.validation?.answerability;
  const expected = gold.expected_answer ?? {};
  const spec = gold.scoring_spec ?? {};
  const results = { answerability: outcome("PASS", null) };
  results.answerability =
    actualAnswerability === gold.expected_answerability
      ? outcome("PASS")
      : outcome("FAIL", { expected: gold.expected_answerability, actual: actualAnswerability ?? null });

  if (expected.value === undefined || expected.value === null) {
    results.value = outcome("NOT_SCORED", "no expected value");
  } else if (typeof expected.value === "object" && !Array.isArray(expected.value)) {
    results.value = scoreObject(expected, response, spec);
  } else {
    results.value = scoreScalarOrRange(expected, response, spec);
  }

  results.unit =
    expected.unit == null
      ? outcome("NOT_SCORED", "no expected unit")
      : typeof response?.answer === "string"
        ? outcome(response.answer.includes(expected.unit) ? "PASS" : "FAIL")
        : outcome("NOT_SCORED", "response.answer is not a string");

  for (const slot of gold.required_evidence_slots ?? []) {
    const hasSources = Array.isArray(slot.acceptable_sources) && slot.acceptable_sources.length > 0;
    results[`evidence:${slot.slot_name}`] = hasSources
      ? outcome(slotIsGrounded(slot, response?.retrieved_context, gold.extensions) ? "PASS" : "FAIL")
      : outcome("NOT_SCORED", "no acceptable sources");
  }

  const operations = Array.isArray(response?.think_trace?.operations) ? response.think_trace.operations : [];
  const policy = gold.expected_execution?.route_policy?.find((p) => p.preferred_route === response?.think_trace?.execution_mode);
  results.execution = policy
    ? outcome(
        policy.required_operations.every((op) => operations.includes(op)) &&
          policy.forbidden_operations.every((op) => !operations.includes(op))
          ? "PASS"
          : "FAIL"
      )
    : outcome("NOT_SCORED", "no matching route_policy for the actual execution_mode");

  return results;
}
