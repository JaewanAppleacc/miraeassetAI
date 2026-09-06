// 공식 조건 산출물의 문항별 `conditions` 객체(corps/doc_groups/exchange_subtypes/
// major_labels/periodic_subtypes/years/year_months/correction)를 A/C의
// METADATA_FILTER_KEYS 모양으로 사상해, 문항별 실제 메타데이터 필터를 만들 수 있게 한다.
// 회사명 -> corp_code 해석은 이 코퍼스(70개 기업)에 대해 승인된 회사 디렉터리를 쓴다.
//
// doc_subtype 분류는 이 코퍼스에 실제 영속된 metadata.doc_subtype 값과 대조해 검증했다.
// exchange_subtypes·periodic_subtypes 값은 정확히 일치한다(예: "단일판매공급계약체결",
// "quarter"/"annual"/"half"). major_labels(예: "자기주식")는 doc_group="major"에 대응하는
// doc_subtype 값이 DB에 없으므로(그 그룹은 doc_subtype이 비어 있음) doc_subtypes로 사상하지
// 않고, 지어낸 값으로 추측하는 대신 `unmapped`에 보존해 노출한다.
import { buildMetadataFiltersFromConditions } from "./conditions-fixture.mjs";

export class UnresolvedCompanyNameError extends Error {
  constructor(name) {
    super(`no corp_code found for company name ${JSON.stringify(name)} -- refusing to silently widen the metadata filter by dropping it`);
    this.name = "UnresolvedCompanyNameError";
    this.code = "UNRESOLVED_COMPANY_NAME";
    this.company_name = name;
  }
}

export class CompanyNameCollisionError extends Error {
  constructor(name, codeA, codeB) {
    super(`company name ${JSON.stringify(name)} maps to two different corp_codes (${codeA}, ${codeB}) -- refusing an ambiguous reverse index`);
    this.name = "CompanyNameCollisionError";
    this.code = "COMPANY_NAME_COLLISION";
  }
}

// resolver: a CompanyResolver from createGatedSeedCompanyResolver (never
// the ungated createSeedCompanyResolver -- an official caller must go
// through the Owner-approval gate). Builds both corp_name and listed_name
// -> corp_code, since the official conditions artifact's `corps` field is
// not documented as using one or the other exclusively.
export function buildNameToCorpCodeIndex(resolver) {
  const index = new Map();
  for (const corpCode of resolver.corpCodes()) {
    const record = resolver.resolve(corpCode);
    for (const name of [record.corp_name, record.listed_name]) {
      const existing = index.get(name);
      if (existing !== undefined && existing !== corpCode) {
        throw new CompanyNameCollisionError(name, existing, corpCode);
      }
      index.set(name, corpCode);
    }
  }
  return Object.freeze(index);
}

// Routes years/year_months to the ONE temporal field that is actually
// populated AND semantically reliable for the relevant doc_group(s) in
// the real corpus. Two real, DB-verified facts drive this:
//
// 1. base_year/base_month exist ONLY on doc_group=periodic chunks; every
//    other doc_group (holding/exchange/major) has them permanently null.
//    Applying base_years/base_months to a non-periodic condition is a
//    GUARANTEED zero-match hard filter (discovered the hard way: an
//    earlier version of this mapper did exactly that and produced empty
//    results for 81/101 official questions).
//
// 2. For non-periodic doc_groups, the condition's own years/year_months
//    record the disclosure's REFERENCED/기준일 period (an event or
//    as-of date mentioned in the question text), not its filing/접수일
//    (receipt_date) -- and the gap between the two is not a fixed,
//    predictable offset (same-day for some exchange filings, ~1-2 weeks
//    for a 대량보유상황보고서, observed directly: a real holding
//    disclosure referenced "2024-03-22" was actually received/filed
//    "2024-04-03"). A second, independent bug was found the same way: for
//    PERIODIC conditions, an annual-report "X년 1월~12월" RANGE phrase
//    extracts year_months month=1, while the DB's own annual-report
//    convention is base_month=12 -- applying that month as a hard filter
//    also guaranteed zero matches (verified: every pure-periodic
//    condition in the official 101 always also carries periodic_subtypes,
//    so doc_subtype alone already disambiguates annual/half/quarter
//    precisely; base_month's own reliability cannot be assumed once a
//    subtype is already given).
//
// Given both failure modes are "a plausible-looking date filter silently
// guarantees zero recall", the conservative, DB-verified-safe policy is:
// only ever apply a hard temporal filter where it is BOTH populated and
// unambiguous -- base_year alone for pure periodic conditions (a literal
// calendar year, always reliable), base_month only when no periodic
// subtype already disambiguates the report, and no hard temporal filter
// at all otherwise. `years` is always redundant with `year_months` when
// both are present (verified against all 101 real conditions), so this
// never loses information relative to using year_months directly.
function deriveTemporalFilter(conditions) {
  const docGroups = Array.isArray(conditions.doc_groups) ? conditions.doc_groups : [];
  const years = Array.isArray(conditions.years) ? conditions.years : [];
  const yearMonths = Array.isArray(conditions.year_months) ? conditions.year_months : [];
  const periodicSubtypes = Array.isArray(conditions.periodic_subtypes) ? conditions.periodic_subtypes : [];
  const hasTemporalCondition = years.length > 0 || yearMonths.length > 0;
  const isPeriodicOnly = docGroups.length === 1 && docGroups[0] === "periodic";

  if (!hasTemporalCondition) {
    return { base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, temporal_filter_applied: "NONE_NO_TEMPORAL_CONDITION" };
  }
  if (!isPeriodicOnly) {
    // Non-periodic (pure holding/exchange/major, or any mix involving
    // periodic): no field exists that is both populated and reliably
    // derivable from this condition -- see policy note above.
    return { base_years: [], base_months: [], receipt_date_from: null, receipt_date_to: null, temporal_filter_applied: "NONE_NON_PERIODIC_OR_MIXED_DOC_GROUPS" };
  }
  const baseMonths = periodicSubtypes.length === 0 ? [...new Set(yearMonths.map(([, month]) => month))] : [];
  return {
    base_years: years, base_months: baseMonths, receipt_date_from: null, receipt_date_to: null,
    temporal_filter_applied: baseMonths.length > 0 ? "BASE_YEAR_AND_MONTH_PERIODIC_NO_SUBTYPE" : "BASE_YEAR_ONLY_PERIODIC_SUBTYPE_DISAMBIGUATES",
  };
}

// doc_subtype has the SAME single-global-doc_group-value hazard as
// base_year/base_month: exchange_subtypes' real values (e.g.
// "단일판매공급계약체결") only ever appear on doc_group=exchange rows,
// periodic_subtypes' values (annual/half/quarter) only on doc_group=
// periodic rows, holding always carries ONE constant doc_subtype value
// (no per-condition subtype concept), and major NEVER populates
// doc_subtype at all. Applying either subtype array as a hard filter
// across a MIXED doc_groups condition guarantees zero matches on every
// doc_group that isn't the one the subtype actually belongs to --
// discovered the hard way on a real question (doc_groups=['exchange',
// 'major'], exchange_subtypes=['단일판매공급계약체결']): the exchange
// rows for that company were a DIFFERENT real subtype
// ("투자판단관련주요경영사항"), and every major row has no doc_subtype at
// all, so the combined filter matched nothing. Only apply a subtype
// filter when doc_groups is a single, pure group that unambiguously owns
// that subtype vocabulary.
function deriveDocSubtypeFilter(conditions) {
  const docGroups = Array.isArray(conditions.doc_groups) ? conditions.doc_groups : [];
  const exchangeSubtypes = Array.isArray(conditions.exchange_subtypes) ? conditions.exchange_subtypes : [];
  const periodicSubtypes = Array.isArray(conditions.periodic_subtypes) ? conditions.periodic_subtypes : [];
  if (docGroups.length === 1 && docGroups[0] === "exchange") return exchangeSubtypes;
  if (docGroups.length === 1 && docGroups[0] === "periodic") return periodicSubtypes;
  return [];
}

// conditions: one row's `conditions` object from the official conditions artifact
// (the REAL, verified shape -- corps/doc_groups/exchange_subtypes/
// major_labels/periodic_subtypes/years/year_months/correction/
// candidate_terms/wants_latest). nameToCorpCodeIndex: from
// buildNameToCorpCodeIndex. Returns a METADATA_FILTER_KEYS-shaped object
// ready for buildMetadataFiltersFromConditions, plus `unmapped` for
// transparency (never silently discarded from the caller's view, even
// though it does not participate in the actual filter).
export function mapOfficialConditionToFilterInput(conditions, nameToCorpCodeIndex) {
  const corps = Array.isArray(conditions.corps) ? conditions.corps : [];
  const corpCodes = corps.map((name) => {
    const code = nameToCorpCodeIndex.get(name);
    if (code === undefined) throw new UnresolvedCompanyNameError(name);
    return code;
  });

  const docSubtypes = deriveDocSubtypeFilter(conditions);
  const temporal = deriveTemporalFilter(conditions);

  const rawFilterInput = {
    corp_codes: corpCodes,
    doc_groups: Array.isArray(conditions.doc_groups) ? conditions.doc_groups : [],
    doc_subtypes: docSubtypes,
    base_years: temporal.base_years,
    base_months: temporal.base_months,
    receipt_date_from: temporal.receipt_date_from,
    receipt_date_to: temporal.receipt_date_to,
    is_correction: typeof conditions.correction === "boolean" ? conditions.correction : null,
    retrieval_eligible: true,
  };

  const docGroupsArr = rawFilterInput.doc_groups;
  const subtypeApplied = docSubtypes.length > 0;
  return Object.freeze({
    filters: buildMetadataFiltersFromConditions(rawFilterInput),
    temporal_filter_applied: temporal.temporal_filter_applied,
    doc_subtype_filter_applied: subtypeApplied,
    unmapped: Object.freeze({
      major_labels: Object.freeze(conditions.major_labels ?? []),
      // Visible even when NOT applied to the filter (docGroups mixed or
      // not a pure exchange/periodic group) -- transparency, not a
      // silent drop.
      exchange_subtypes: !subtypeApplied ? Object.freeze(conditions.exchange_subtypes ?? []) : Object.freeze([]),
      periodic_subtypes: (!subtypeApplied && docGroupsArr[0] !== "periodic") ? Object.freeze(conditions.periodic_subtypes ?? []) : Object.freeze([]),
      candidate_terms: Object.freeze(conditions.candidate_terms ?? []),
      wants_latest: conditions.wants_latest ?? null,
    }),
    note: "Both temporal and doc_subtype hard filters are applied only where a field is both populated and reliable for the doc_group(s) actually in play -- never uniformly across a MIXED doc_groups condition, since base_year/base_month/doc_subtype are each meaningful for only ONE doc_group in this corpus and a global AND-filter guarantees zero matches on every other group in the mix. Temporal: base_years for doc_groups===['periodic'] always; base_months added only when periodic_subtypes is empty (a subtype already disambiguates annual/half/quarter, and the extractor's own month value is not reliably the DB's period-end convention). doc_subtypes: exchange_subtypes only for doc_groups===['exchange'], periodic_subtypes only for doc_groups===['periodic'], nothing for holding (one constant subtype, no per-condition concept) or major (doc_subtype never populated) or any mixed combination. major_labels is always unmapped (no corresponding doc_subtype value exists in the DB for doc_group=major). See temporal_filter_applied/doc_subtype_filter_applied for exactly what was applied to this condition.",
  });
}
