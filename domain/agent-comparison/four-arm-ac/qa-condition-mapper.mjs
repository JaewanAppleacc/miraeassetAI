// Turn A-PLUS-QA-CONDITION-MAPPING-V1: bridges the shape mismatch between what QA actually
// sends over the wire to the A worker(s) and what those workers' own condition-to-filter
// mapping expected.
//
// The bug this fixes: QA's own condition object is `QueryConditions.as_dict()`
// (src/dart_corpus/retrieval/conditions.py) -- `{corps, doc_groups, year_months, years,
// periodic_subtypes, exchange_subtypes, major_labels, correction, wants_latest,
// candidate_terms}`, the SAME shape as the official devtune101_conditions.v2.jsonl artifact's
// own `conditions` field (data/eval/devtune101_conditions.v2.jsonl). Both scripts/arm_a_live_
// worker.mjs's own toArmAConditions() and scripts/arm_a4_a3_live_worker.mjs's own
// toFourArmConditions() instead only ever read a DIFFERENT, minimal wire shape --
// `{corp_code, document_group, document_subtype, period}` (singular, at most one value each)
// -- so every field QA actually sends goes unrecognized, every worker-side mapping produces an
// EMPTY filter object, and metadata filtering silently no-ops into an unconstrained full-corpus
// search. This module is the fix: a single, pure, format-detecting reshaper used by both
// workers, so QA's real shape (and the old minimal wire shape, for backward compatibility) both
// resolve into a real, non-empty metadata filter.
//
// Purity contract (see qa-condition-mapper.test.mjs): every exported function here is
// synchronous, allocates no new state beyond its return value, performs no I/O (the one
// filesystem read a caller needs -- data/corpus/universe.csv -- is the CALLER's job;
// buildNameToCorpCodeIndexFromUniverseCsv only ever receives the already-read text), never
// mutates its input, and is deterministic (same input -> same output, always). No DB, no Gold,
// no LLM call, no network call happens anywhere in this file.
//
// This file deliberately does NOT reimplement corp-name resolution, doc-group-aware temporal
// derivation, or doc_subtype derivation -- domain/agent-comparison/four-arm-ac/four-arm-
// conditions-to-filter-mapper.mjs's own mapOfficialConditionToFilterInput() already does all of
// that (correctly, with extensive DB-verified rationale in its own comments) for the "official
// conditions" shape. The only genuinely new logic added here is: (1) detecting/normalizing BOTH
// the QA shape and the old minimal wire shape into that one official-conditions shape, without
// losing multi-value company/doc-group/period lists the old minimal shape could never carry in
// the first place, (2) distinguishing "field absent" from "field present but empty" so a
// caller's silence is never confused with an explicit empty answer, (3) validating doc_groups
// against this corpus's actual 4-group taxonomy (periodic/exchange/holding/major -- verified
// against data/corpus/manifest.jsonl's own doc_group values) and refusing (never silently
// widening to an unconstrained search) when a value falls outside it, and (4) a from-CSV
// corp-name index built from this repository's own already-verified data/corpus/universe.csv
// (the same 70-company, SHA-checked-against-corpus_snapshot.json universe
// src/dart_corpus/retrieval/corp_dictionary.py already trusts for the reverse direction --
// question text -> corp_name).
import {
  mapOfficialConditionToFilterInput,
  UnresolvedCompanyNameError,
  CompanyNameCollisionError,
} from "./four-arm-conditions-to-filter-mapper.mjs";

// data/corpus/manifest.jsonl's own doc_group values, exhaustively enumerated (verified
// 2026-09-06: every one of 4,204 manifest rows has doc_group in exactly this set). This is A's
// internal document-group taxonomy that QA's `doc_groups` condition values (and the legacy wire
// shape's `document_group`/`document_groups`) must already speak -- there is no separate QA
// vocabulary to translate from, only a closed set to validate against.
export const KNOWN_DOC_GROUPS = Object.freeze(["periodic", "exchange", "holding", "major"]);

export class UnknownDocGroupError extends Error {
  constructor(values) {
    super(
      `doc_groups contains value(s) outside A's known taxonomy (${KNOWN_DOC_GROUPS.join("/")}): `
      + `${JSON.stringify(values)} -- refusing to silently drop them or widen the search to all groups`,
    );
    this.name = "UnknownDocGroupError";
    this.code = "UNKNOWN_DOC_GROUP";
    this.doc_groups = Object.freeze([...values]);
  }
}

export { UnresolvedCompanyNameError, CompanyNameCollisionError };

function hasOwn(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function asArray(value) {
  if (Array.isArray(value)) return [...value];
  if (value === undefined || value === null) return [];
  return [value];
}

function dedupe(values) {
  return [...new Set(values)];
}

// Same YYYY / YYYY-MM discipline the two workers' own (now-removed) minimal-shape mappers
// already used: a period value is only ever mapped when it unambiguously parses; anything else
// is left out of years/year_months and reported in diagnostics.unparsed_periods (never guessed).
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_ONLY_RE = /^(\d{4})$/;

function parsePeriodString(period) {
  const yearMonth = YEAR_MONTH_RE.exec(period);
  if (yearMonth) return { year: Number(yearMonth[1]), month: Number(yearMonth[2]) };
  const yearOnly = YEAR_ONLY_RE.exec(period);
  if (yearOnly) return { year: Number(yearOnly[1]), month: null };
  return null;
}

const QA_SHAPE_FIELDS = Object.freeze([
  "corps", "doc_groups", "exchange_subtypes", "periodic_subtypes", "major_labels",
  "years", "year_months", "correction", "wants_latest", "candidate_terms",
]);
const LEGACY_SHAPE_FIELDS = Object.freeze([
  "corp_code", "corp_codes", "document_group", "document_groups",
  "document_subtype", "document_subtypes", "period", "is_correction",
]);

// Pure reshaper: accepts EITHER the QA/official-conditions shape, the old minimal legacy wire
// shape, both at once, or nothing at all (null/undefined/{}), and returns one canonical
// official-conditions-shaped object plus a `diagnostics` record of what was actually present on
// the input, what was unresolved, and what shape was detected. Never throws -- the shape of the
// input, however malformed, is always representable; only the *use* of certain values (in
// mapQaOrLegacyConditionsToFilterInput/mapQaOrLegacyConditionsToFourArmConditions below) can be
// refused.
export function normalizeConditionsInput(rawConditions) {
  const raw = rawConditions !== null && typeof rawConditions === "object" ? rawConditions : {};

  const usesQaShape = QA_SHAPE_FIELDS.some((k) => hasOwn(raw, k));
  const usesLegacyShape = LEGACY_SHAPE_FIELDS.some((k) => hasOwn(raw, k));
  const fieldsPresent = Object.freeze(
    [...QA_SHAPE_FIELDS, ...LEGACY_SHAPE_FIELDS].filter((k) => hasOwn(raw, k)),
  );

  const corps = asArray(raw.corps);
  const docGroups = asArray(raw.doc_groups);
  const exchangeSubtypes = asArray(raw.exchange_subtypes);
  const periodicSubtypes = asArray(raw.periodic_subtypes);
  const majorLabels = asArray(raw.major_labels);
  const years = asArray(raw.years);
  const yearMonths = asArray(raw.year_months).map((pair) => (Array.isArray(pair) ? [...pair] : pair));
  // candidate_terms keeps null when genuinely absent (rather than defaulting to []) because
  // a4-a3-retrieval-pipeline.mjs's runQuestionPipeline() distinguishes
  // Array.isArray(conditions.candidate_terms) from an absent field for required_metric_labels
  // (feeds a4-reranker-features.mjs's term_coverage feature) -- a caller that never mentioned
  // candidate_terms at all must not be treated the same as one that explicitly said "none".
  const candidateTerms = hasOwn(raw, "candidate_terms") ? asArray(raw.candidate_terms) : null;
  let correction = hasOwn(raw, "correction") ? raw.correction : null;
  const wantsLatest = hasOwn(raw, "wants_latest") ? raw.wants_latest : null;

  const unparsedPeriods = [];
  const legacyFieldsUsed = LEGACY_SHAPE_FIELDS.filter((k) => hasOwn(raw, k));

  // Legacy corp_code(s) are already corp_codes (never names) -- folded into the same `corps`
  // list QA's own name-shaped `corps` uses. Resolution (below, in the *ToFilterInput functions)
  // treats any 8-digit-numeric `corps` entry as already-resolved via an identity overlay, so a
  // request mixing a legacy corp_code and a QA-shaped company name resolves both correctly.
  if (hasOwn(raw, "corp_code") && raw.corp_code) corps.push(raw.corp_code);
  for (const code of asArray(raw.corp_codes)) corps.push(code);

  if (hasOwn(raw, "document_group") && raw.document_group) docGroups.push(raw.document_group);
  for (const group of asArray(raw.document_groups)) docGroups.push(group);

  // Legacy document_subtype(s) route to exchange_subtypes/periodic_subtypes by the doc_group(s)
  // already collected above -- same discipline arm_a4_a3_live_worker.mjs's own (now-removed)
  // toFourArmConditions used: holding/major have no per-condition doc_subtype concept in this
  // corpus (four-arm-conditions-to-filter-mapper.mjs's own deriveDocSubtypeFilter docstring), so
  // a legacy document_subtype paired with those groups (or a mixed doc_groups list) is left
  // unmapped rather than guessed onto the wrong vocabulary.
  const legacySubtypes = [
    ...(hasOwn(raw, "document_subtype") && raw.document_subtype ? [raw.document_subtype] : []),
    ...asArray(raw.document_subtypes),
  ];
  if (legacySubtypes.length > 0) {
    const uniqueGroups = dedupe([...docGroups]);
    if (uniqueGroups.length === 1 && uniqueGroups[0] === "exchange") exchangeSubtypes.push(...legacySubtypes);
    else if (uniqueGroups.length === 1 && uniqueGroups[0] === "periodic") periodicSubtypes.push(...legacySubtypes);
  }

  if (hasOwn(raw, "period") && raw.period !== undefined && raw.period !== null) {
    const parsed = parsePeriodString(raw.period);
    if (parsed) {
      years.push(parsed.year);
      if (parsed.month !== null) yearMonths.push([parsed.year, parsed.month]);
    } else {
      unparsedPeriods.push(raw.period);
    }
  }

  if (hasOwn(raw, "is_correction") && raw.is_correction !== undefined && raw.is_correction !== null) {
    correction = raw.is_correction;
  }

  const dedupedDocGroups = dedupe(docGroups);
  const unknownDocGroups = dedupedDocGroups.filter((g) => !KNOWN_DOC_GROUPS.includes(g));

  const diagnostics = Object.freeze({
    shape: usesQaShape && usesLegacyShape ? "MIXED" : usesQaShape ? "QA" : usesLegacyShape ? "LEGACY" : "EMPTY",
    fields_present: fieldsPresent,
    legacy_fields_used: Object.freeze(legacyFieldsUsed),
    unknown_doc_groups: Object.freeze(unknownDocGroups),
    unparsed_periods: Object.freeze(unparsedPeriods),
  });

  return Object.freeze({
    corps: Object.freeze(dedupe(corps)),
    doc_groups: Object.freeze(dedupedDocGroups),
    exchange_subtypes: Object.freeze(dedupe(exchangeSubtypes)),
    periodic_subtypes: Object.freeze(dedupe(periodicSubtypes)),
    major_labels: Object.freeze(dedupe(majorLabels)),
    years: Object.freeze(dedupe(years)),
    year_months: Object.freeze(yearMonths.map((pair) => Object.freeze(pair))),
    correction,
    wants_latest: wantsLatest,
    candidate_terms: candidateTerms === null ? null : Object.freeze(candidateTerms),
    diagnostics,
  });
}

function officialConditionsOf(normalized) {
  return {
    corps: normalized.corps,
    doc_groups: normalized.doc_groups,
    exchange_subtypes: normalized.exchange_subtypes,
    periodic_subtypes: normalized.periodic_subtypes,
    major_labels: normalized.major_labels,
    years: normalized.years,
    year_months: normalized.year_months,
    correction: normalized.correction,
    wants_latest: normalized.wants_latest,
    // runQuestionPipeline reads this with Array.isArray(); null (genuinely absent) must stay
    // null, never silently become [] (see normalizeConditionsInput's own note above).
    candidate_terms: normalized.candidate_terms,
  };
}

const CORP_CODE_RE = /^\d{8}$/;

// A `corps` entry that is already an 8-digit corp_code (the legacy wire shape's corp_code/
// corp_codes always are) resolves to itself, on top of whatever real name->corp_code entries
// `nameToCorpCodeIndex` already has -- so the SAME resolution call handles QA's company NAMES
// and the legacy shape's already-resolved corp_codes without the caller needing to know which
// shape produced a given `corps` value.
function withIdentityOverlayForCodes(nameToCorpCodeIndex, corps) {
  const combined = new Map(nameToCorpCodeIndex);
  for (const value of corps) {
    if (typeof value === "string" && CORP_CODE_RE.test(value)) combined.set(value, value);
  }
  return Object.freeze(combined);
}

function assertKnownDocGroups(normalized) {
  if (normalized.diagnostics.unknown_doc_groups.length > 0) {
    throw new UnknownDocGroupError(normalized.diagnostics.unknown_doc_groups);
  }
}

// Main entry point for scripts/arm_a_live_worker.mjs: normalizes `rawConditions` (QA shape,
// legacy shape, or empty), resolves companies/derives temporal+doc_subtype filters via the
// existing, unmodified mapOfficialConditionToFilterInput, and returns everything a caller could
// want -- `.filters` is the METADATA_FILTER_KEYS-shaped object ready to pass straight to an
// arm-retriever-adapter.mjs `search()` call (which runs it through buildMetadataFiltersFromConditions
// again itself -- a safe no-op, since `.filters` already only has METADATA_FILTER_KEYS keys).
export function mapQaOrLegacyConditionsToFilterInput(rawConditions, { nameToCorpCodeIndex }) {
  const normalized = normalizeConditionsInput(rawConditions);
  assertKnownDocGroups(normalized);
  const officialConditions = officialConditionsOf(normalized);
  const combinedIndex = withIdentityOverlayForCodes(nameToCorpCodeIndex, normalized.corps);
  const mapped = mapOfficialConditionToFilterInput(officialConditions, combinedIndex);
  return Object.freeze({
    ...mapped,
    official_conditions: Object.freeze(officialConditions),
    diagnostics: normalized.diagnostics,
  });
}

// Thin convenience wrapper: scripts/arm_a_live_worker.mjs only ever needs the final filter
// object (it passes it straight into adapter.search(), which does its own
// buildMetadataFiltersFromConditions()).
export function mapQaOrLegacyConditionsToArmAConditions(rawConditions, { nameToCorpCodeIndex }) {
  return mapQaOrLegacyConditionsToFilterInput(rawConditions, { nameToCorpCodeIndex }).filters;
}

// Main entry point for scripts/arm_a4_a3_live_worker.mjs: that worker needs the *normalized
// official-conditions object itself* (as `question.conditions` for runQuestionPipeline, which
// re-derives the metadata filter internally) AND the corp-code-resolution index it was built
// against (so its own later mapOfficialConditionToFilterInput(mappedConditions,
// nameToCorpCodeIndex) call for the A3 guard resolves the exact same way) -- returned together so
// neither can drift out of sync.
export function mapQaOrLegacyConditionsToFourArmConditions(rawConditions, { nameToCorpCodeIndex }) {
  const normalized = normalizeConditionsInput(rawConditions);
  assertKnownDocGroups(normalized);
  const officialConditions = officialConditionsOf(normalized);
  const combinedIndex = withIdentityOverlayForCodes(nameToCorpCodeIndex, normalized.corps);
  return Object.freeze({
    conditions: officialConditions,
    nameToCorpCodeIndex: combinedIndex,
    diagnostics: normalized.diagnostics,
  });
}

// ---------- CompanyResolver (from this repo's own already-verified data/corpus/universe.csv) ----------
//
// This repo has no gated CompanyResolver artifact/manifest/owner-decision bundle of its own (the
// one four-arm-conditions-to-filter-mapper.mjs's own comments describe belongs to a *different*
// sibling repository's release pipeline and is not vendored here -- see
// config/a4-a3-runtime-source-manifest.v1.json's own file list). What this repo DOES already
// have, already verified (CLAUDE.md: "SHA가 corpus_snapshot.json 기록값과 일치 검증됨"), and
// already trusted for the reverse direction (src/dart_corpus/retrieval/corp_dictionary.py's own
// CorpDictionary, built from this same file, is what produces QA's `corps` NAME values in the
// first place) is data/corpus/universe.csv -- the 70-company universe for this exact corpus. A
// name->corp_code index built from it is the natural, already-approved CompanyResolver for this
// specific mapping: resolving a name CorpDictionary itself produced, back to the corp_code the
// same universe row already carries.
//
// Pure parser: takes already-read CSV text, never touches the filesystem itself (the two workers
// each do their own single `readFileSync` at startup and pass the text in here).
function parseCsv(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function buildNameToCorpCodeIndexFromUniverseCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return Object.freeze(new Map());
  const [header, ...records] = rows;
  const corpCodeIdx = header.indexOf("corp_code");
  const corpNameIdx = header.indexOf("corp_name");
  const listedNameIdx = header.indexOf("listed_name");
  if (corpCodeIdx === -1 || corpNameIdx === -1 || listedNameIdx === -1) {
    throw new Error("universe.csv is missing one of corp_code/corp_name/listed_name columns");
  }
  const index = new Map();
  for (const record of records) {
    const corpCode = record[corpCodeIdx];
    for (const name of [record[corpNameIdx], record[listedNameIdx]]) {
      if (!name) continue;
      const existing = index.get(name);
      if (existing !== undefined && existing !== corpCode) {
        throw new CompanyNameCollisionError(name, existing, corpCode);
      }
      index.set(name, corpCode);
    }
  }
  return Object.freeze(index);
}
