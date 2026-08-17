// Shared vocabulary + validators for a Plan's `information_limits` array
// (CANDIDATE contract, plan schema_version "0.4.0" -- see
// seed-question-plan-store.mjs). This is NOT a Sub-request research
// revival: it is the minimal common declaration that a requested output
// (a real, Owner-approved ontology metric_code) is honestly known to
// have no direct-disclosure Fact, so the Composer can render that
// absence truthfully instead of silently omitting it or fabricating a
// value. Mirrors sub-request-vocabulary.mjs's split: a pure STRUCTURAL
// validator (shape/enum only, usable with no live Fact access, safe for
// the Plan store) plus a semantic validator that needs a live Fact
// universe (used at Plan-authoring time and available for tests).
export const INFORMATION_LIMIT_REASON_CODES = Object.freeze(["NOT_DIRECTLY_DISCLOSED"]);
export const INFORMATION_LIMIT_CALCULATION_STATUSES = Object.freeze(["DERIVED_CALCULATION_NOT_AVAILABLE"]);

// The exact 6 ontology tokens the Owner APPROVED in
// seed-response-ontology-proposal-owner-decision.v0.2.jsonl (Turn M6/M7).
// A hardcoded closed literal here matches this project's own established
// convention (SUB_REQUEST_INTENTS/SUB_REQUEST_CAPABILITIES in sub-
// request-vocabulary.mjs are likewise plain literals, extended only by a
// deliberate future edit, never derived at runtime from a file read).
// `validateInformationLimits` itself stays generic (callers/tests supply
// their own approvedMetricCodes Set) -- this constant is only the real
// production value.
export const APPROVED_ONTOLOGY_METRIC_CODES = Object.freeze(new Set([
  "INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET", "ACQUISITION_PLANNED_SHARES",
  "TRUST_CONTRACT_INSTITUTION", "CORRECTION_REASON", "ISSUANCE_AMOUNT",
]));

// A metric_code has no `raw_label` to naturalize when it is the TARGET of
// an information_limit (that is the whole point -- no Fact exists to
// carry one). Composer code must never fall back to printing the raw
// ALL_CAPS_SNAKE token verbatim (the same internal-representation-leak
// class this project has rejected since Turn M2). This dictionary is the
// metric_code-keyed, question-agnostic label every one of the 6 approved
// tokens already carries on its OWN real VERIFIED Fact's raw_label
// elsewhere in the corpus (numbering-prefix stripped, matching
// natural-label.mjs's own convention) -- applying it here is not a
// per-question special case, it is the SAME label used for every
// question that happens to reference that token.
export const APPROVED_ONTOLOGY_METRIC_CODE_LABELS_KO = Object.freeze({
  INVESTMENT_PURPOSE: "투자목적",
  INVESTMENT_TARGET_ASSET: "투자대상",
  ACQUISITION_PLANNED_SHARES: "취득예정주식수",
  TRUST_CONTRACT_INSTITUTION: "계약체결기관",
  CORRECTION_REASON: "정정사유",
  ISSUANCE_AMOUNT: "발행총액",
});

const INFORMATION_LIMIT_FIELDS = Object.freeze(["target_metric_code", "reason_code", "available_input_fact_ids", "calculation_status"]);
const INFORMATION_LIMIT_FIELD_SET = new Set(INFORMATION_LIMIT_FIELDS);
const METRIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FACT_ID_PATTERN = /^fact_[0-9a-f]{24}$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Pure structural validation -- field shape, enum membership, id
// pattern, non-empty arrays, no duplicate target_metric_code. Never
// touches a live Fact store (the Plan store itself has none at load
// time -- same layering constraint as slots[].fact_ids, whose existence
// is likewise deferred to Flow run-time). Throws a plain Error (matching
// seed-question-plan-store.mjs's existing convention) on the first
// violation.
export function validateInformationLimits(informationLimits, { approvedMetricCodes, questionId }) {
  if (!(approvedMetricCodes instanceof Set)) throw new TypeError("approvedMetricCodes must be a Set");
  if (!Array.isArray(informationLimits) || informationLimits.length === 0) {
    throw new Error(`${questionId}: information_limits must be a non-empty array`);
  }
  const seenTargets = new Set();
  for (const item of informationLimits) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${questionId}: invalid information_limit entry`);
    for (const key of Object.keys(item)) {
      if (!INFORMATION_LIMIT_FIELD_SET.has(key)) throw new Error(`${questionId}: unexpected information_limit field "${key}"`);
    }
    for (const field of INFORMATION_LIMIT_FIELDS) {
      if (!Object.hasOwn(item, field)) throw new Error(`${questionId}: information_limit missing required field "${field}"`);
    }
    if (typeof item.target_metric_code !== "string" || !METRIC_CODE_PATTERN.test(item.target_metric_code)) {
      throw new Error(`${questionId}: invalid information_limit target_metric_code`);
    }
    if (!approvedMetricCodes.has(item.target_metric_code)) {
      throw new Error(`${questionId}: information_limit target_metric_code "${item.target_metric_code}" is not an Owner-approved ontology token`);
    }
    if (seenTargets.has(item.target_metric_code)) {
      throw new Error(`${questionId}: duplicate information_limit target_metric_code "${item.target_metric_code}"`);
    }
    seenTargets.add(item.target_metric_code);
    if (!INFORMATION_LIMIT_REASON_CODES.includes(item.reason_code)) {
      throw new Error(`${questionId}: invalid information_limit reason_code "${item.reason_code}"`);
    }
    if (!INFORMATION_LIMIT_CALCULATION_STATUSES.includes(item.calculation_status)) {
      throw new Error(`${questionId}: invalid information_limit calculation_status "${item.calculation_status}"`);
    }
    if (!Array.isArray(item.available_input_fact_ids) || item.available_input_fact_ids.length === 0) {
      throw new Error(`${questionId}: information_limit available_input_fact_ids must be a non-empty array`);
    }
    for (const factId of item.available_input_fact_ids) {
      if (typeof factId !== "string" || !FACT_ID_PATTERN.test(factId)) {
        throw new Error(`${questionId}: information_limit available_input_fact_ids contains an invalid fact_id "${factId}"`);
      }
    }
  }
  return deepFreeze(informationLimits.map((item) => ({ ...item, available_input_fact_ids: [...item.available_input_fact_ids] })));
}

// Semantic validation against a live Fact universe -- run at Plan-
// AUTHORING time (this repo's build scripts always have the real
// VERIFIED Fact store in hand) and reusable directly in tests with a
// synthetic Fact map. Two checks the structural validator above cannot
// perform (it never sees Fact content, only id shape):
//   - every available_input_fact_ids entry must resolve to a real,
//     VERIFIED Fact (never an unknown/CANDIDATE fact_id)
//   - target_metric_code must not already be directly resolvable from
//     this SAME question's own slots (a slot fact whose own metric_code
//     equals the declared target is a genuine conflict -- the value IS
//     directly disclosed, so declaring it "not directly disclosed" would
//     be a lie)
export function validateInformationLimitsAgainstFacts(informationLimits, { factsById, slotMetricCodes, questionId }) {
  if (!(factsById instanceof Map)) throw new TypeError("factsById must be a Map");
  if (!(slotMetricCodes instanceof Set)) throw new TypeError("slotMetricCodes must be a Set");
  for (const item of informationLimits) {
    if (slotMetricCodes.has(item.target_metric_code)) {
      throw new Error(`${questionId}: information_limit target_metric_code "${item.target_metric_code}" conflicts with a Fact already directly resolved by this question's own slots`);
    }
    for (const factId of item.available_input_fact_ids) {
      const fact = factsById.get(factId);
      if (!fact) throw new Error(`${questionId}: information_limit available_input_fact_ids references unknown fact_id "${factId}"`);
      if (fact.verification_status !== "VERIFIED") {
        throw new Error(`${questionId}: information_limit available_input_fact_ids references fact_id "${factId}" whose verification_status is "${fact.verification_status}", not VERIFIED`);
      }
    }
  }
}
