// A2 Scope Validator (results/A2_SCOPE_VALIDATOR_V1_AMENDMENT.md).
//
// Pure function: given a question's frozen dimension requirements and the
// actual node/table context a retrieved item points to, decide whether that
// evidence's consolidated/separate scope, period, unit/sign, and row/column
// meaning are compatible with what the question requires -- without ever
// reading Gold, without branching on packet/question/company identity, and
// without re-running retrieval/embedding/ranking. See the amendment for the
// full freeze; this file must not diverge from it.
//
// Fail-closed: any dimension the question requires but this function cannot
// confirm from the given evidence context returns UNRESOLVED, never PASS.
// UNRESOLVED evidence is not eligible for A2's final top-k (enforced by the
// caller, not this module).

export const SCOPE_VALIDATOR_VERSION = "fourarm.a2-evidence-scope-validator.v1";

export const VALIDATION_STATUS = Object.freeze({
  PASS: "PASS",
  REJECT: "REJECT",
  UNRESOLVED: "UNRESOLVED",
});

export const REJECT_REASONS = Object.freeze([
  "SCOPE_CONFLICT",
  "PERIOD_CONFLICT",
  "UNIT_CONFLICT",
  "ROW_COLUMN_CONFLICT",
  "ENTITY_CONFLICT",
  "INSUFFICIENT_CONTEXT",
]);

// ---------------------------------------------------------------------------
// Text normalization -- whitespace/punctuation-insensitive comparison only.
// Never used to compare numeric VALUES; only labels (row/column/table/entity).
// ---------------------------------------------------------------------------

function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  return value
    .normalize("NFKC")
    .replace(/[\s ]+/g, "")
    .replace(/[,.\-–—_/()[\]{}·:;'"‘’“”]/g, "")
    .toLowerCase();
}

function labelsMatch(required, observed) {
  const a = normalizeLabel(required);
  const b = normalizeLabel(observed);
  if (a === null || b === null) return false;
  return a === b;
}

// ---------------------------------------------------------------------------
// Scope (consolidated/separate)
// ---------------------------------------------------------------------------

const CONSOLIDATED_MARKERS = ["연결"]; // 연결
const SEPARATE_MARKERS = ["별도", "개별"]; // 별도, 개별

// Returns "CONSOLIDATED" | "SEPARATE" | "AMBIGUOUS" | null. Never infers a
// scope from the ABSENCE of a marker -- absence means null (undetermined),
// not the opposite scope.
function detectScopeLabel(hint) {
  if (typeof hint !== "string" || hint.trim() === "") return null;
  const text = hint.normalize("NFKC");
  const hasConsolidated = CONSOLIDATED_MARKERS.some((m) => text.includes(m));
  const hasSeparate = SEPARATE_MARKERS.some((m) => text.includes(m));
  if (hasConsolidated && hasSeparate) return "AMBIGUOUS";
  if (hasConsolidated) return "CONSOLIDATED";
  if (hasSeparate) return "SEPARATE";
  return null;
}

function checkScope(requiredScope, evidence) {
  if (requiredScope !== "CONSOLIDATED" && requiredScope !== "SEPARATE") {
    return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: null, observed: null });
  }
  const observed = detectScopeLabel(evidence.scope_hint);
  if (observed === null || observed === "AMBIGUOUS") {
    return Object.freeze({
      status: VALIDATION_STATUS.UNRESOLVED,
      expected: requiredScope,
      observed,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (observed !== requiredScope) {
    return Object.freeze({
      status: VALIDATION_STATUS.REJECT,
      expected: requiredScope,
      observed,
      reason: "SCOPE_CONFLICT",
    });
  }
  return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: requiredScope, observed });
}

// ---------------------------------------------------------------------------
// Period (fiscal year / quarter / half / full-year, cumulative vs 3-month)
// ---------------------------------------------------------------------------

// Calendar-quarter month ranges are a fixed, universal accounting fact, not a
// per-question or per-packet parameter -- applying it uniformly to every
// question/evidence pair is not the "특정 수치 하드코딩" the amendment
// forbids (that prohibition is about Gold values and packet-specific
// exceptions, not the definition of what a quarter is).
const QUARTER_END_MONTH = Object.freeze({ 1: 3, 2: 6, 3: 9, 4: 12 });

// label: a raw Korean period phrase, e.g. "2024년 1분기 누적"
// ("2024년 1분기 누적"). Returns { fiscal_year, start_month, end_month } or
// null when the phrase does not resolve to a single unambiguous range.
export function normalizePeriodLabel(label) {
  if (typeof label !== "string") return null;
  const text = label.normalize("NFKC");
  const yearMatch = text.match(/(\d{4})\s*년/); // \d{4}년
  if (!yearMatch) return null;
  const fiscalYear = Number(yearMatch[1]);

  const isFullYear = /(사업연도|연간|연차)/.test(text); // 사업연도|연간|연차
  const isH2 = /하반기/.test(text); // 하반기
  const isH1 = !isH2 && /(상반기|반기)/.test(text); // 상반기|반기
  if (isFullYear) return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: 12 });
  if (isH1) return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: 6 });
  if (isH2) return Object.freeze({ fiscal_year: fiscalYear, start_month: 7, end_month: 12 });

  const quarterMatch = text.match(/([1-4])\s*분기/); // [1-4]분기
  if (!quarterMatch) return null;
  const quarter = Number(quarterMatch[1]);
  const quarterEnd = QUARTER_END_MONTH[quarter];

  // Q1's own 3-month range and its year-to-date cumulative range are
  // structurally identical (there is nothing before Q1 in the fiscal year),
  // so Q1 resolves the same way regardless of a "누적"/"3개월" qualifier.
  if (quarter === 1) return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: 3 });

  const isCumulative = /누적/.test(text); // 누적
  const isThreeMonth = /3\s*개월/.test(text); // 3개월
  if (isCumulative) return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: quarterEnd });
  if (isThreeMonth) return Object.freeze({ fiscal_year: fiscalYear, start_month: quarterEnd - 2, end_month: quarterEnd });
  // Q2-Q4 named without an explicit cumulative/3-month qualifier is
  // genuinely ambiguous (disclosures routinely show both columns) --
  // fail-closed rather than guessing one.
  return null;
}

function resolvePeriodRange(period) {
  if (!period || typeof period !== "object") return null;
  const { fiscal_year, start_month, end_month, label } = period;
  if (Number.isInteger(fiscal_year) && Number.isInteger(start_month) && Number.isInteger(end_month)) {
    return Object.freeze({ fiscal_year, start_month, end_month });
  }
  if (typeof label === "string" && label.trim() !== "") return normalizePeriodLabel(label);
  return null;
}

function resolveObservedPeriod(evidence) {
  const structured = resolvePeriodRange(evidence.period);
  if (structured) return structured;
  if (typeof evidence.period_hint === "string") return normalizePeriodLabel(evidence.period_hint);
  return null;
}

function periodsEqual(a, b) {
  return a.fiscal_year === b.fiscal_year && a.start_month === b.start_month && a.end_month === b.end_month;
}

function checkPeriod(period, evidence) {
  const required = resolvePeriodRange(period);
  if (!required) return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: null, observed: null });
  const observed = resolveObservedPeriod(evidence);
  if (!observed) {
    return Object.freeze({
      status: VALIDATION_STATUS.UNRESOLVED,
      expected: required,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (!periodsEqual(required, observed)) {
    return Object.freeze({
      status: VALIDATION_STATUS.REJECT,
      expected: required,
      observed,
      reason: "PERIOD_CONFLICT",
    });
  }
  return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// Unit / sign
// ---------------------------------------------------------------------------

// Fixed KRW-denomination multipliers -- a definitional fact (1 백만원 =
// 1,000,000 원), not a per-question tuned constant. Deterministic conversion
// between any two of these is always well-defined and safe to PASS.
const WON_FACTOR = Object.freeze({ KRW: 1, THOUSAND_KRW: 1e3, MILLION_KRW: 1e6, BILLION_KRW: 1e9 });

function detectUnitLabel(hint) {
  if (typeof hint !== "string") return null;
  const text = hint.normalize("NFKC");
  if (/십억\s*원/.test(text)) return "BILLION_KRW"; // 십억원
  if (/백만\s*원/.test(text)) return "MILLION_KRW"; // 백만원
  if (/천\s*원/.test(text)) return "THOUSAND_KRW"; // 천원
  if (/원/.test(text)) return "KRW"; // 원
  return null;
}

function resolveObservedUnit(evidence) {
  if (typeof evidence.unit === "string" && WON_FACTOR[evidence.unit] !== undefined) return evidence.unit;
  return detectUnitLabel(evidence.unit_hint);
}

function isNonCurrencyHint(hint) {
  return typeof hint === "string" && /%/.test(hint);
}

function checkUnit(unit, evidence) {
  const requiredUnit = unit && WON_FACTOR[unit.required_unit] !== undefined ? unit.required_unit : null;
  const requiredSign = unit && (unit.required_sign === "POSITIVE" || unit.required_sign === "NEGATIVE") ? unit.required_sign : null;

  if (!requiredUnit && !requiredSign) {
    return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: null, observed: null });
  }

  const observedSign = evidence.sign === "POSITIVE" || evidence.sign === "NEGATIVE" ? evidence.sign : null;
  if (requiredSign && observedSign && requiredSign !== observedSign) {
    return Object.freeze({
      status: VALIDATION_STATUS.REJECT,
      expected: Object.freeze({ unit: requiredUnit, sign: requiredSign }),
      observed: Object.freeze({ unit: resolveObservedUnit(evidence), sign: observedSign }),
      reason: "UNIT_CONFLICT",
    });
  }

  if (!requiredUnit) {
    if (requiredSign && !observedSign) {
      return Object.freeze({
        status: VALIDATION_STATUS.UNRESOLVED,
        expected: Object.freeze({ sign: requiredSign }),
        observed: Object.freeze({ sign: null }),
        reason: "INSUFFICIENT_CONTEXT",
      });
    }
    return Object.freeze({
      status: VALIDATION_STATUS.PASS,
      expected: Object.freeze({ sign: requiredSign }),
      observed: Object.freeze({ sign: observedSign }),
    });
  }

  if (requiredUnit && isNonCurrencyHint(evidence.unit_hint) && !resolveObservedUnit(evidence)) {
    return Object.freeze({
      status: VALIDATION_STATUS.REJECT,
      expected: Object.freeze({ unit: requiredUnit }),
      observed: Object.freeze({ unit: null, raw_hint: evidence.unit_hint }),
      reason: "UNIT_CONFLICT",
    });
  }

  const observedUnit = resolveObservedUnit(evidence);
  if (!observedUnit) {
    return Object.freeze({
      status: VALIDATION_STATUS.UNRESOLVED,
      expected: Object.freeze({ unit: requiredUnit }),
      observed: Object.freeze({ unit: null }),
      reason: "INSUFFICIENT_CONTEXT",
    });
  }

  const conversion = observedUnit === requiredUnit
    ? null
    : Object.freeze({
      from_unit: observedUnit,
      to_unit: requiredUnit,
      // Multiply an observed-unit value by this factor to express it in
      // required_unit terms. Deterministic power-of-ten ratio only.
      multiply_observed_value_by: WON_FACTOR[observedUnit] / WON_FACTOR[requiredUnit],
    });

  return Object.freeze({
    status: VALIDATION_STATUS.PASS,
    expected: Object.freeze({ unit: requiredUnit, sign: requiredSign }),
    observed: Object.freeze({ unit: observedUnit, sign: observedSign }),
    conversion,
  });
}

// ---------------------------------------------------------------------------
// Row / column / table-title meaning
// ---------------------------------------------------------------------------

function resolveRowColumn(rowColumn) {
  if (!rowColumn || typeof rowColumn !== "object") return null;
  const requiredTableTitle = typeof rowColumn.required_table_title === "string" ? rowColumn.required_table_title : null;
  const requiredRowLabel = typeof rowColumn.required_row_label === "string" ? rowColumn.required_row_label : null;
  const requiredColumnLabel = typeof rowColumn.required_column_label === "string" ? rowColumn.required_column_label : null;
  if (requiredTableTitle === null && requiredRowLabel === null && requiredColumnLabel === null) return null;
  return Object.freeze({
    required_table_title: requiredTableTitle,
    required_row_label: requiredRowLabel,
    required_column_label: requiredColumnLabel,
  });
}

function checkRowColumn(rowColumn, evidence) {
  const required = resolveRowColumn(rowColumn);
  if (!required) return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: null, observed: null });

  const fields = [
    ["table_title", required.required_table_title, evidence.table_title],
    ["row_label", required.required_row_label, evidence.row_label],
    ["column_label", required.required_column_label, evidence.column_label],
  ];

  const observed = Object.freeze({
    table_title: evidence.table_title ?? null,
    row_label: evidence.row_label ?? null,
    column_label: evidence.column_label ?? null,
  });

  let unresolvedField = null;
  for (const [field, requiredValue, observedValue] of fields) {
    if (requiredValue === null) continue;
    if (typeof observedValue !== "string") {
      unresolvedField = unresolvedField ?? field;
      continue;
    }
    if (!labelsMatch(requiredValue, observedValue)) {
      return Object.freeze({
        status: VALIDATION_STATUS.REJECT,
        expected: required,
        observed,
        reason: "ROW_COLUMN_CONFLICT",
        conflicting_field: field,
      });
    }
  }

  if (unresolvedField) {
    return Object.freeze({
      status: VALIDATION_STATUS.UNRESOLVED,
      expected: required,
      observed,
      reason: "INSUFFICIENT_CONTEXT",
      unresolved_field: unresolvedField,
    });
  }

  return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

function checkEntity(entity, evidence) {
  if (typeof entity !== "string" || entity.trim() === "") {
    return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: null, observed: null });
  }
  const observed = typeof evidence.entity === "string" ? evidence.entity : null;
  if (observed === null) {
    return Object.freeze({
      status: VALIDATION_STATUS.UNRESOLVED,
      expected: entity,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (!labelsMatch(entity, observed)) {
    return Object.freeze({ status: VALIDATION_STATUS.REJECT, expected: entity, observed, reason: "ENTITY_CONFLICT" });
  }
  return Object.freeze({ status: VALIDATION_STATUS.PASS, expected: entity, observed });
}

// ---------------------------------------------------------------------------
// Evidence context merge -- read-only, never mutates either input.
// expandedEvidence (the fetched/late-expanded node) wins over retrievalItem
// (the raw retrieval-time hit) field by field when it has a real value.
// ---------------------------------------------------------------------------

const CONTEXT_FIELDS = Object.freeze([
  "entity", "scope_hint", "period", "period_hint", "unit", "unit_hint", "sign",
  "row_label", "column_label", "table_title",
]);

function mergeEvidenceContext(retrievalItem, expandedEvidence) {
  const a = (retrievalItem && typeof retrievalItem === "object") ? retrievalItem : {};
  const b = (expandedEvidence && typeof expandedEvidence === "object") ? expandedEvidence : {};
  const merged = {};
  for (const field of CONTEXT_FIELDS) {
    const bValue = b[field];
    merged[field] = (bValue !== undefined && bValue !== null) ? bValue : (a[field] !== undefined ? a[field] : null);
  }
  return Object.freeze(merged);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export class ScopeValidatorInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ScopeValidatorInputError";
  }
}

function assertPlainObjectOrNil(value, name) {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ScopeValidatorInputError(`${name} must be a plain object when provided`);
  }
}

// questionConditions: { scope, entity, period, unit, row_column } -- every
// field optional; an absent/null field means the question does not require
// that dimension, and its check trivially PASSes.
//
// retrievalItem / expandedEvidence: the actual node/table context the
// retrieved evidence points to (scope_hint, period/period_hint, unit/
// unit_hint, sign, row_label, column_label, table_title, entity). Neither is
// ever read as Gold, and this function never writes to either.
export function validateEvidenceDimensions({ questionConditions, retrievalItem, expandedEvidence } = {}) {
  assertPlainObjectOrNil(questionConditions, "questionConditions");
  assertPlainObjectOrNil(retrievalItem, "retrievalItem");
  assertPlainObjectOrNil(expandedEvidence, "expandedEvidence");

  const conditions = questionConditions ?? {};
  const evidence = mergeEvidenceContext(retrievalItem, expandedEvidence);

  const checks = Object.freeze({
    scope: checkScope(conditions.scope ?? null, evidence),
    period: checkPeriod(conditions.period ?? null, evidence),
    unit: checkUnit(conditions.unit ?? null, evidence),
    row_column: checkRowColumn(conditions.row_column ?? null, evidence),
    entity: checkEntity(conditions.entity ?? null, evidence),
  });

  // Every non-PASS dimension contributes its reason regardless of the
  // others -- REJECT wins the overall `status` (fail-closed on conflict),
  // but a REJECT elsewhere must not hide an UNRESOLVED dimension's reason.
  const reasons = [];
  let hasReject = false;
  let hasUnresolved = false;
  for (const check of Object.values(checks)) {
    if (check.status === VALIDATION_STATUS.REJECT) {
      hasReject = true;
      reasons.push(check.reason);
    } else if (check.status === VALIDATION_STATUS.UNRESOLVED) {
      hasUnresolved = true;
      reasons.push("INSUFFICIENT_CONTEXT");
    }
  }
  const status = hasReject
    ? VALIDATION_STATUS.REJECT
    : hasUnresolved
      ? VALIDATION_STATUS.UNRESOLVED
      : VALIDATION_STATUS.PASS;

  return Object.freeze({
    status,
    reasons: Object.freeze([...new Set(reasons)]),
    expected: Object.freeze({
      scope: checks.scope.expected,
      period: checks.period.expected,
      unit: checks.unit.expected,
      row_column: checks.row_column.expected,
      entity: checks.entity.expected,
    }),
    observed: Object.freeze({
      scope: checks.scope.observed,
      period: checks.period.observed,
      unit: checks.unit.observed,
      row_column: checks.row_column.observed,
      entity: checks.entity.observed,
    }),
    checks,
  });
}
