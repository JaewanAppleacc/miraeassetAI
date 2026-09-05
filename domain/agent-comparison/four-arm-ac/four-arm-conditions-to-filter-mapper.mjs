// Turn FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE: real mapping
// from the official devtune101_conditions.v2.jsonl artifact's per-question
// `conditions` object (corps/doc_groups/exchange_subtypes/major_labels/
// periodic_subtypes/years/year_months/correction) into A/C's own
// METADATA_FILTER_KEYS shape (conditions-fixture.mjs), so a real per-
// question metadata filter can finally be built for an official run.
//
// This module previously did not exist because it needs a corp-NAME ->
// corp_code resolver, and this repo's CompanyResolver
// (domain/adapters/seed-company-resolver.mjs) is release-gated behind an
// Owner-approved decision. That decision turns out to already exist and
// is already APPROVED for exactly this corpus (corpus_04750795e1a2d5c3,
// 70 companies, reviewer 최재완, work/domain-seed/seed-company-directory-
// owner-decision.v0.1.approved.json) -- see tests/seed-company-resolver.
// test.mjs's own "REAL Company Directory candidate v0.1" test. Using it
// here is not new production wiring; it is using an already-authorized
// gate for its documented purpose.
//
// doc_subtype taxonomy: verified against the real reference_retrieval_
// chunks.metadata.doc_subtype values actually persisted for this corpus.
// exchange_subtypes and periodic_subtypes values match EXACTLY
// (예: "단일판매공급계약체결", "quarter"/"annual"/"half"). major_labels
// (e.g. "자기주식") has NO corresponding doc_subtype value in the DB for
// doc_group="major" (그 그룹은 doc_subtype이 비어 있음, chunker.mjs's
// document.doc_subtype passthrough was simply never populated for major
// disclosures) -- so major_labels is intentionally NOT mapped into
// doc_subtypes here; it is preserved, visible, in `unmapped` instead of
// being silently dropped or guessed into a made-up doc_subtype value.
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

// conditions: one row's `conditions` object from devtune101_conditions.v2
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

  const docSubtypes = [
    ...(Array.isArray(conditions.exchange_subtypes) ? conditions.exchange_subtypes : []),
    ...(Array.isArray(conditions.periodic_subtypes) ? conditions.periodic_subtypes : []),
  ];

  const baseMonths = [...new Set((Array.isArray(conditions.year_months) ? conditions.year_months : []).map(([, month]) => month))];

  const rawFilterInput = {
    corp_codes: corpCodes,
    doc_groups: Array.isArray(conditions.doc_groups) ? conditions.doc_groups : [],
    doc_subtypes: docSubtypes,
    base_years: Array.isArray(conditions.years) ? conditions.years : [],
    base_months: baseMonths,
    is_correction: typeof conditions.correction === "boolean" ? conditions.correction : null,
    retrieval_eligible: true,
  };

  return Object.freeze({
    filters: buildMetadataFiltersFromConditions(rawFilterInput),
    unmapped: Object.freeze({
      major_labels: Object.freeze(conditions.major_labels ?? []),
      candidate_terms: Object.freeze(conditions.candidate_terms ?? []),
      wants_latest: conditions.wants_latest ?? null,
    }),
    note: "base_years/base_months are independent constraints (matching passesMetadataFilters' own AND-of-independent-fields semantics), not (year,month) PAIRS -- a question with multiple distinct year_months entries gets a looser filter than the exact pair set would imply. major_labels is intentionally unmapped (no corresponding doc_subtype value exists in the DB for doc_group=major).",
  });
}
