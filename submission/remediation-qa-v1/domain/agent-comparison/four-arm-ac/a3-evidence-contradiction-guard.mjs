// A3 모순 가드.
//
// 순수 함수: 질문의 명시적 차원 요구와 후보 근거에서 실제 관측된 사실을 비교해, 둘 사이에
// 명백하고 판정 가능한 모순이 있는지 분류한다. 검색/DB/임베딩/LLM 호출이 없고, 문항·회사
// 식별자로 분기하지 않는다. 분류만 하며 후보를 직접 제거하지 않는다.
//
// 모호하면 fail-closed하되, 모호함은 REJECT가 아니라 별도 결과(KEEP_UNKNOWN)다. 이 함수가
// 판정할 수 없는 차원은 REJECT에 기여하지 않으며, 호출자는 KEEP_UNKNOWN을 후보 제거 사유로
// 써서는 안 된다.

export const CONTRADICTION_GUARD_VERSION = "fourarm.a3-evidence-contradiction-guard.v1";

export const CONTRADICTION_STATUS = Object.freeze({
  PASS: "PASS",
  REJECT: "REJECT",
  KEEP_UNKNOWN: "KEEP_UNKNOWN",
});

export const CONTRADICTION_REASONS = Object.freeze([
  "SCOPE_CONTRADICTION",
  "PERIOD_CONTRADICTION",
  "UNIT_CONTRADICTION",
  "REVISION_CONTRADICTION",
  "ENTITY_CONTRADICTION",
  "ROW_COLUMN_CONTRADICTION",
  "INSUFFICIENT_CONTEXT",
]);

export class ContradictionGuardInputError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ContradictionGuardInputError";
  }
}

function assertPlainObjectOrNil(value, name) {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ContradictionGuardInputError(`${name} must be a plain object when provided`);
  }
}

// ---------------------------------------------------------------------------
// Label normalization -- whitespace/punctuation-insensitive text comparison
// only. Never used to compare numeric values.
// ---------------------------------------------------------------------------

function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value
    .normalize("NFKC")
    .replace(/[\s ]+/g, "")
    .replace(/[,.\-–—_/()[\]{}·:;'"‘’“”]/g, "")
    .toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function labelsMatch(required, observed) {
  const a = normalizeLabel(required);
  const b = normalizeLabel(observed);
  if (a === null || b === null) return false;
  return a === b;
}

// ---------------------------------------------------------------------------
// scope: 연결(CONSOLIDATED) / 별도·개별(SEPARATE)
// ---------------------------------------------------------------------------

const CONSOLIDATED_MARKERS = ["연결"];
const SEPARATE_MARKERS = ["별도", "개별"];

function detectScope(hint) {
  if (typeof hint !== "string" || hint.trim() === "") return null;
  const text = hint.normalize("NFKC");
  const hasConsolidated = CONSOLIDATED_MARKERS.some((m) => text.includes(m));
  const hasSeparate = SEPARATE_MARKERS.some((m) => text.includes(m));
  if (hasConsolidated && hasSeparate) return null; // ambiguous -> undetermined
  if (hasConsolidated) return "CONSOLIDATED";
  if (hasSeparate) return "SEPARATE";
  return null;
}

function resolveObservedScope(evidenceFacts) {
  if (evidenceFacts.scope === "CONSOLIDATED" || evidenceFacts.scope === "SEPARATE") return evidenceFacts.scope;
  return detectScope(evidenceFacts.scope_hint);
}

function checkScope(questionConditions, evidenceFacts) {
  const required = questionConditions.scope;
  if (required !== "CONSOLIDATED" && required !== "SEPARATE") {
    return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });
  }
  const observed = resolveObservedScope(evidenceFacts);
  if (observed === null) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (observed !== required) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.REJECT,
      expected: required,
      observed,
      reason: "SCOPE_CONTRADICTION",
    });
  }
  return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// period: 연도 / 분기 / 반기 / 누적(YTD) vs 3개월(단일 분기)
// ---------------------------------------------------------------------------

const QUARTER_END_MONTH = Object.freeze({ 1: 3, 2: 6, 3: 9, 4: 12 });

// A raw Korean period phrase, e.g. "2024년 3분기 누적", resolves to a
// canonical { fiscal_year, start_month, end_month } range, or null when the
// phrase does not resolve to one unambiguous range. Calendar-quarter/half
// month boundaries are a fixed, universal accounting fact applied the same
// way to every input -- not a per-question or per-packet parameter.
export function normalizePeriodLabel(label) {
  if (typeof label !== "string") return null;
  const text = label.normalize("NFKC");
  const yearMatch = text.match(/(\d{4})\s*년/);
  if (!yearMatch) return null;
  const fiscalYear = Number(yearMatch[1]);

  const hasHalf = /(상반기|하반기|반기)/.test(text);
  const hasQuarter = /([1-4])\s*분기/.test(text);
  const hasFullYearMarker = /(사업연도|연간|연차)/.test(text);

  if (hasHalf) {
    const isH2 = /하반기/.test(text);
    return isH2
      ? Object.freeze({ fiscal_year: fiscalYear, start_month: 7, end_month: 12 })
      : Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: 6 });
  }

  if (hasQuarter) {
    const quarterMatch = text.match(/([1-4])\s*분기/);
    const quarter = Number(quarterMatch[1]);
    const quarterEnd = QUARTER_END_MONTH[quarter];
    const isCumulative = /누적/.test(text);
    const isThreeMonth = /3\s*개월/.test(text);
    if (isCumulative) return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: quarterEnd });
    if (isThreeMonth) return Object.freeze({ fiscal_year: fiscalYear, start_month: quarterEnd - 2, end_month: quarterEnd });
    // Named without an explicit cumulative/3-month qualifier: disclosures
    // routinely carry both a 3-month and a year-to-date column for the same
    // quarter label, so this is genuinely ambiguous -- fail-closed to null
    // (KEEP_UNKNOWN at the caller), never guessed.
    return null;
  }

  // Bare "YYYY년" with no quarter/half marker: treated as the full fiscal
  // year, matching how such a phrase is ordinarily meant in a disclosure
  // question ("2024년 매출액은?"). The optional 사업연도/연간/연차 marker is
  // accepted but not required for this case.
  void hasFullYearMarker;
  return Object.freeze({ fiscal_year: fiscalYear, start_month: 1, end_month: 12 });
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

function resolveObservedPeriod(evidenceFacts) {
  const structured = resolvePeriodRange(evidenceFacts.period);
  if (structured) return structured;
  if (typeof evidenceFacts.period_hint === "string") return normalizePeriodLabel(evidenceFacts.period_hint);
  return null;
}

function periodsEqual(a, b) {
  return a.fiscal_year === b.fiscal_year && a.start_month === b.start_month && a.end_month === b.end_month;
}

function checkPeriod(questionConditions, evidenceFacts) {
  const required = resolvePeriodRange(questionConditions.period);
  if (!required) return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });
  const observed = resolveObservedPeriod(evidenceFacts);
  if (!observed) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (!periodsEqual(required, observed)) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.REJECT,
      expected: required,
      observed,
      reason: "PERIOD_CONTRADICTION",
    });
  }
  return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// unit: 원 / 천원 / 백만원 / 억원 (currency family, exact power-of-ten
// conversion) vs 주(SHARE) / %(PERCENT) (non-currency families, not
// convertible to currency or to each other).
// ---------------------------------------------------------------------------

const CURRENCY_UNIT_FACTOR = Object.freeze({
  KRW: 1,
  THOUSAND_KRW: 1e3,
  MILLION_KRW: 1e6,
  HUNDRED_MILLION_KRW: 1e8,
});

const UNIT_FAMILY = Object.freeze({
  KRW: "CURRENCY",
  THOUSAND_KRW: "CURRENCY",
  MILLION_KRW: "CURRENCY",
  HUNDRED_MILLION_KRW: "CURRENCY",
  PERCENT: "PERCENT",
  SHARE: "SHARE",
});

const KNOWN_UNIT_TOKENS = new Set(Object.keys(UNIT_FAMILY));

function detectUnitToken(hint) {
  if (typeof hint !== "string") return null;
  const text = hint.normalize("NFKC");
  if (/%/.test(text)) return "PERCENT";
  if (/억\s*원/.test(text)) return "HUNDRED_MILLION_KRW";
  if (/백만\s*원/.test(text)) return "MILLION_KRW";
  if (/천\s*원/.test(text)) return "THOUSAND_KRW";
  if (/원/.test(text)) return "KRW";
  if (/주/.test(text)) return "SHARE";
  return null;
}

function resolveObservedUnit(evidenceFacts) {
  if (typeof evidenceFacts.unit === "string" && KNOWN_UNIT_TOKENS.has(evidenceFacts.unit)) return evidenceFacts.unit;
  return detectUnitToken(evidenceFacts.unit_hint);
}

function resolveRequiredUnit(questionConditions) {
  const unit = questionConditions.unit;
  if (typeof unit === "string" && KNOWN_UNIT_TOKENS.has(unit)) return unit;
  if (unit && typeof unit === "object" && KNOWN_UNIT_TOKENS.has(unit.required_unit)) return unit.required_unit;
  return null;
}

function checkUnit(questionConditions, evidenceFacts) {
  const required = resolveRequiredUnit(questionConditions);
  if (!required) return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });

  const observed = resolveObservedUnit(evidenceFacts);
  if (!observed) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }

  if (observed === required) {
    return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed });
  }

  const requiredFamily = UNIT_FAMILY[required];
  const observedFamily = UNIT_FAMILY[observed];

  if (requiredFamily !== observedFamily) {
    // Different unit families (e.g. currency vs. %, currency vs. 주) have no
    // deterministic conversion -- the underlying values are not comparable.
    return Object.freeze({
      status: CONTRADICTION_STATUS.REJECT,
      expected: required,
      observed,
      reason: "UNIT_CONTRADICTION",
    });
  }

  // Same family, different denomination (only possible for CURRENCY): a
  // fixed power-of-ten ratio always converts exactly, so this is compatible,
  // never a contradiction.
  const conversion = Object.freeze({
    from_unit: observed,
    to_unit: required,
    multiply_observed_value_by: CURRENCY_UNIT_FACTOR[observed] / CURRENCY_UNIT_FACTOR[required],
  });
  return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed, conversion });
}

// ---------------------------------------------------------------------------
// revision: 정정 전(PRE_REVISION) / 정정 후(POST_REVISION)
// ---------------------------------------------------------------------------

function detectRevision(hint) {
  if (typeof hint !== "string" || hint.trim() === "") return null;
  const text = hint.normalize("NFKC");
  const hasPre = /정정\s*전/.test(text);
  const hasPost = /정정\s*후/.test(text);
  if (hasPre && hasPost) return null; // ambiguous -> undetermined
  if (hasPre) return "PRE_REVISION";
  if (hasPost) return "POST_REVISION";
  return null;
}

function resolveObservedRevision(evidenceFacts) {
  if (evidenceFacts.revision === "PRE_REVISION" || evidenceFacts.revision === "POST_REVISION") return evidenceFacts.revision;
  return detectRevision(evidenceFacts.revision_hint);
}

function checkRevision(questionConditions, evidenceFacts) {
  const required = questionConditions.revision;
  if (required !== "PRE_REVISION" && required !== "POST_REVISION") {
    return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });
  }
  const observed = resolveObservedRevision(evidenceFacts);
  if (observed === null) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }
  if (observed !== required) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.REJECT,
      expected: required,
      observed,
      reason: "REVISION_CONTRADICTION",
    });
  }
  return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// entity: 대상 기업. Aliases are treated as identical only when the caller
// supplies an explicit, approved resolver input (questionConditions.entity.
// approved_aliases) -- this module never guesses that two different strings
// name the same company.
// ---------------------------------------------------------------------------

function resolveRequiredEntity(questionConditions) {
  const entity = questionConditions.entity;
  if (typeof entity === "string" && entity.trim() !== "") {
    return Object.freeze({ required_name: entity, approved_aliases: Object.freeze([]) });
  }
  if (entity && typeof entity === "object" && typeof entity.required_name === "string" && entity.required_name.trim() !== "") {
    const aliases = Array.isArray(entity.approved_aliases)
      ? Object.freeze(entity.approved_aliases.filter((a) => typeof a === "string"))
      : Object.freeze([]);
    return Object.freeze({ required_name: entity.required_name, approved_aliases: aliases });
  }
  return null;
}

function checkEntity(questionConditions, evidenceFacts) {
  const required = resolveRequiredEntity(questionConditions);
  if (!required) return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });

  const observed = typeof evidenceFacts.entity === "string" && evidenceFacts.entity.trim() !== "" ? evidenceFacts.entity : null;
  if (observed === null) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required.required_name,
      observed: null,
      reason: "INSUFFICIENT_CONTEXT",
    });
  }

  if (labelsMatch(required.required_name, observed)) {
    return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required.required_name, observed });
  }

  const aliasApproved = required.approved_aliases.some((alias) => labelsMatch(alias, observed));
  if (aliasApproved) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.PASS,
      expected: required.required_name,
      observed,
      alias_resolved: true,
    });
  }

  return Object.freeze({
    status: CONTRADICTION_STATUS.REJECT,
    expected: required.required_name,
    observed,
    reason: "ENTITY_CONTRADICTION",
  });
}

// ---------------------------------------------------------------------------
// row/column: 지표명(표 제목/행)·당기·전기 등 열 구분
// ---------------------------------------------------------------------------

function resolveRequiredRowColumn(rowColumn) {
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

function checkRowColumn(questionConditions, evidenceFacts) {
  const required = resolveRequiredRowColumn(questionConditions.row_column);
  if (!required) return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: null, observed: null });

  const fields = [
    ["table_title", required.required_table_title, evidenceFacts.table_title],
    ["row_label", required.required_row_label, evidenceFacts.row_label],
    ["column_label", required.required_column_label, evidenceFacts.column_label],
  ];

  const observed = Object.freeze({
    table_title: evidenceFacts.table_title ?? null,
    row_label: evidenceFacts.row_label ?? null,
    column_label: evidenceFacts.column_label ?? null,
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
        status: CONTRADICTION_STATUS.REJECT,
        expected: required,
        observed,
        reason: "ROW_COLUMN_CONTRADICTION",
        conflicting_field: field,
      });
    }
  }

  if (unresolvedField) {
    return Object.freeze({
      status: CONTRADICTION_STATUS.KEEP_UNKNOWN,
      expected: required,
      observed,
      reason: "INSUFFICIENT_CONTEXT",
      unresolved_field: unresolvedField,
    });
  }

  return Object.freeze({ status: CONTRADICTION_STATUS.PASS, expected: required, observed });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// questionConditions: { scope?, period?, unit?, revision?, entity?,
// row_column? } -- every field optional; an absent/null field means the
// question does not state that dimension, and its check trivially PASSes.
//
// evidenceFacts: the facts actually observed on the candidate evidence item
// (scope/scope_hint, period/period_hint, unit/unit_hint, revision/
// revision_hint, entity, table_title, row_label, column_label). Never read
// as Gold; never mutated.
//
// Returns { status: PASS|REJECT|KEEP_UNKNOWN, reasons, expected, observed,
// checks }. status priority: any dimension REJECT => REJECT; else any
// dimension KEEP_UNKNOWN => KEEP_UNKNOWN; else PASS. KEEP_UNKNOWN is a
// classification only -- it is not, by itself, a reason for any caller to
// remove a search candidate (see the contract doc).
export function detectEvidenceContradictions({ questionConditions, evidenceFacts } = {}) {
  assertPlainObjectOrNil(questionConditions, "questionConditions");
  assertPlainObjectOrNil(evidenceFacts, "evidenceFacts");

  const conditions = questionConditions ?? {};
  const facts = evidenceFacts ?? {};

  const checks = Object.freeze({
    scope: checkScope(conditions, facts),
    period: checkPeriod(conditions, facts),
    unit: checkUnit(conditions, facts),
    revision: checkRevision(conditions, facts),
    entity: checkEntity(conditions, facts),
    row_column: checkRowColumn(conditions, facts),
  });

  const reasons = [];
  let hasReject = false;
  let hasKeepUnknown = false;
  for (const check of Object.values(checks)) {
    if (check.status === CONTRADICTION_STATUS.REJECT) {
      hasReject = true;
      reasons.push(check.reason);
    } else if (check.status === CONTRADICTION_STATUS.KEEP_UNKNOWN) {
      hasKeepUnknown = true;
      reasons.push("INSUFFICIENT_CONTEXT");
    }
  }

  const status = hasReject
    ? CONTRADICTION_STATUS.REJECT
    : hasKeepUnknown
      ? CONTRADICTION_STATUS.KEEP_UNKNOWN
      : CONTRADICTION_STATUS.PASS;

  return Object.freeze({
    status,
    reasons: Object.freeze([...new Set(reasons)]),
    expected: Object.freeze({
      scope: checks.scope.expected,
      period: checks.period.expected,
      unit: checks.unit.expected,
      revision: checks.revision.expected,
      entity: checks.entity.expected,
      row_column: checks.row_column.expected,
    }),
    observed: Object.freeze({
      scope: checks.scope.observed,
      period: checks.period.observed,
      unit: checks.unit.observed,
      revision: checks.revision.observed,
      entity: checks.entity.observed,
      row_column: checks.row_column.observed,
    }),
    checks,
  });
}
