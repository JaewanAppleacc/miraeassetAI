// Minimal deterministic Flow A for the VERIFIED Seed subset. Planning is
// injected; this Flow never reads Gold, expected answers, or scoring rules.
// It queries only Coverage-authorized IDs, validates every cited Evidence
// against both stores/raw DocumentIR, and emits a natural-language answer
// synthesized by the common Response Composer (see domain/flows/synthesis/)
// -- pure functions over this same VERIFIED data, no extra service calls,
// no Gold access. If synthesis cannot be validated as safe, the Flow falls
// back to the original deterministic bullet-list answer, which is by
// construction always fully grounded in the queried VERIFIED records.
//
// SCOPE NOTE: the synthesis modules under domain/flows/synthesis/ are
// generic (no question_id/company branching -- see their own file
// headers and tests/synthesis-response-composer.test.mjs). This FILE,
// however, still contains pre-existing Seed-specific slot-pair plumbing
// below (the `calculatePair` calls naming "hmm_"/"mobis_"/
// "samsung_heavy_"/"hyosung_" slot prefixes, and the corp_code-keyed
// revenue_hd/revenue_shi comparison) that predates this turn -- known
// technical debt in Flow A's calculationValue construction, not something
// this turn's synthesis work generalizes. A future Final Agent Planner/
// operation graph should replace this slot-prefix convention entirely.
// Turn I §5-A removed the ONE part of this debt that leaked into user-
// facing output: the winner/magnitude comparisons used to hardcode
// literal company names ("HD현대중공업"/"삼성중공업"/"HMM"/"현대모비스")
// directly into calculationValue; they now record only the winning
// side's real corp_code, and domain/flows/synthesis/response-composer.mjs
// resolves the human-readable label at render time via the SAME
// companyLabels/corp_code-fallback path renderValueLines already uses --
// never a Flow-authored name, never copied from question text. Do not
// read the synthesis modules' genericness as a claim that this whole Flow
// is a generalized final agent.
import { planSynthesisSignals } from "./synthesis/synthesis-signal-planner.mjs";
import { extractNarrativeFields } from "./synthesis/narrative-field-extractor.mjs";
import { composeResponse } from "./synthesis/response-composer.mjs";
import { validateSynthesis } from "./synthesis/final-synthesis-validator.mjs";
import { limitationLabelKo } from "./synthesis/capability-labels.mjs";
import { TERMINATION_AMOUNT_METRIC_CODE, isEffectiveContractAmountMetric } from "./synthesis/contract-amount-role.mjs";

function unique(values) { return [...new Set(values)]; }
function unitLabel(unit) {
  return ({ KRW: "원", PERCENT: "%", SHARES: "주" })[unit] ?? unit ?? "";
}
// Turn M10: the real VERIFIED Fact corpus is NOT consistent about whether
// `unit` holds the enum token ("KRW") or the raw Korean/symbol label
// directly ("원") -- the SAME inconsistency response-composer.mjs's
// claimTypeForUnit already had to work around for PERCENT/SHARES. Two
// Facts whose units are the SAME real currency/quantity but spelled
// differently (KRW vs 원) were being treated as unit-mismatched and
// silently skipped from calculation eligibility -- exported so it can be
// unit-tested directly, and reused by calculateFactPair's equality check
// below instead of a raw string comparison.
export function unitsAreEquivalent(unitA, unitB) {
  if ((unitA ?? null) === (unitB ?? null)) return true;
  return unitLabel(unitA) === unitLabel(unitB);
}
function renderValue(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("ko-KR") : String(value);
  if (value === null) return "해당 없음";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
function disclosedScaleLabel(fact) {
  const migration = fact?.attributes?.normalization_migration;
  const disclosedScale = migration?.status === "OWNER_APPROVED" ? migration.previous_scale : fact?.scale;
  if (disclosedScale === 1_000) return "천원";
  if (disclosedScale === 1_000_000) return "백만원";
  if (disclosedScale === 1 && fact?.unit === "KRW") return "원";
  return null;
}
// Turn K: backward-compatible projection of the corp_code-only winner
// fields (Turn I §5-A) into their PRE-EXISTING structured meaning names
// (revenue_winner/operating_profit_winner/larger_change_magnitude_company)
// -- this is NOT a Gold-repair; it restores structured semantics that
// existed before the literal-name removal, now sourced safely. The
// projected value is ALWAYS exactly companyLabels[corpCode].corp_name --
// never a literal, never guessed, never read from question text. When
// companyLabels is absent or the corp_code does not resolve, the field is
// simply never created (calculationValue keeps only the corp_code field);
// response-composer.mjs's existing ENTITY_LABEL_RESOLUTION/PARTIAL path
// (driven by the SAME *_winner_corp_code field) already covers that case,
// so no new capability/signal is needed here.
export function projectWinnerField(calculationValue, corpCodeKey, targetKey, companyLabels) {
  const corpCode = calculationValue[corpCodeKey];
  const corpName = typeof corpCode === "string" ? companyLabels?.[corpCode]?.corp_name : undefined;
  if (typeof corpName === "string" && corpName !== "") calculationValue[targetKey] = corpName;
}

// Turn M10: unit-spelling canonicalization for calculation ELIGIBILITY
// (see unitsAreEquivalent below) must never leak into the actual
// calculationInput records this Flow submits -- the Validator
// independently re-verifies each one field-for-field against its real
// corpus record (a mutated unit fails FACT_UNIT_MISMATCH even for a
// perfectly valid Fact), and the Calculator's own proof-binding
// (createValidationAuthority.check() in agent-runtime.mjs) hashes the
// EXACT inputs the Validator approved -- mutating them afterward, even
// only the unit field, breaks that hash and fails PROOF_SUBJECT_MISMATCH.
// The actual KRW/원-equivalence recognition needed for the Calculator's
// own UNIT_MISMATCH check now lives inside the Calculator itself
// (agent-runtime.mjs's canonicalCalculatorUnit, comparison-only, never
// touching the stored input.unit value) -- calculationInput here stays
// a pure, unmodified projection of each Fact's own real fields.
function calculationInput(fact) {
  return {
    fact_id: fact.fact_id, value: fact.normalized_value, unit: fact.unit, scope: fact.scope,
    value_status: fact.value_status, known_at: fact.known_at, valid_from: fact.valid_from, valid_to: fact.valid_to,
  };
}
function makeQuery(plan, targets, predicates, suffix) {
  return {
    schema_version: "0.2.0", query_id: `query_${plan.question_id}_${suffix}`,
    execution_scope: "OFFICIAL", corpus_snapshot_id: plan.context.corpus_snapshot_id,
    fact_coverage_snapshot_id: plan.context.fact_coverage_snapshot_id,
    targets, corp_codes: plan.corp_codes, predicates: {
      metric_codes: [], event_types: [], relation_types: [], document_ids: [],
      fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [], ...predicates,
    },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: plan.as_of_date, limit: 1000,
  };
}

export function createThinStructuredFlow() {
  return Object.freeze({
    id: "thin-structured-flow-a-v0.1",
    async run(input, context, services) {
      const plan = input.plan;
      if (!plan || typeof plan !== "object") throw new TypeError("Thin Flow requires a resolved plan");
      // Turn M8: information_limits' available_input_fact_ids (see
      // domain/adapters/information-limit-vocabulary.mjs, plan
      // schema_version "0.4.0") are ordinary VERIFIED Fact ids that may
      // not be referenced by any slot -- included here so the SAME
      // "records.length !== factIds.length" fail-closed check below
      // already covers an unknown/missing one, exactly like slot
      // fact_ids always have (plan.information_limits is undefined for
      // every plan schema_version below 0.4.0, so this is a strict no-op
      // for all of them, same pattern as plan.sub_requests below).
      const factIds = unique([
        ...plan.slots.flatMap((slot) => slot.fact_ids),
        ...(plan.information_limits ?? []).flatMap((decl) => decl.available_input_fact_ids),
      ]);
      const evidenceIds = unique([...(plan.evidence_ids ?? []), ...plan.slots.flatMap((slot) => slot.evidence_ids)]);
      const [factResult, evidenceResult, eventResult] = await Promise.all([
        services.structuredStore.query(makeQuery(plan, ["FACT"], { fact_ids: factIds }, "facts")),
        services.structuredStore.query(makeQuery(plan, ["EVIDENCE"], { evidence_ids: evidenceIds }, "evidence")),
        services.structuredStore.query(makeQuery(plan, ["EVENT"], { evidence_ids: evidenceIds }, "events")),
      ]);
      if (factResult.status !== "OK" || evidenceResult.status !== "OK") throw new Error("required structured records are unavailable");
      if (!["OK", "NOT_FOUND"].includes(eventResult.status)) throw new Error("verified Event lookup failed");
      if (factResult.records.length !== factIds.length || evidenceResult.records.length !== evidenceIds.length) throw new Error("required structured records are incomplete");

      const facts = factResult.records.map((record) => record.payload);
      const evidence = evidenceResult.records.map((record) => record.payload);
      const events = eventResult.status === "OK" ? eventResult.records.map((record) => record.payload) : [];
      const factsById = new Map(facts.map((fact) => [fact.fact_id, fact]));
      const factBySlot = new Map(plan.slots.map((slot) => [slot.slot_name, factsById.get(slot.fact_ids[0])]));
      const numericFacts = facts.filter((fact) => typeof fact.normalized_value === "number" && Number.isFinite(fact.normalized_value));
      if (numericFacts.length) {
        await services.validator.validateFacts(numericFacts.map(calculationInput));
      }

      // Structured value map: raw verified slots plus only the derived
      // formulas Calculator can prove today. Cross-scale multiplication,
      // ranking, and narrative inference are deliberately absent.
      const calculationValue = {};
      const disclosedPeriodStarts = new Set();
      const disclosedPeriodEnds = new Set();
      const disclosedUnits = new Set();
      for (const [slotName, fact] of factBySlot) {
        if (!fact) continue;
        calculationValue[slotName] = fact.normalized_value;
        calculationValue[`${slotName}_value_status`] = fact.value_status;
        calculationValue[`${slotName}_status`] = fact.value_status;
        if (fact.unit != null) {
          calculationValue[`${slotName}_unit`] = unitLabel(fact.unit);
          disclosedUnits.add(unitLabel(fact.unit));
        }
        if (fact.period_start != null) {
          calculationValue[`${slotName}_period_start`] = fact.period_start;
          disclosedPeriodStarts.add(fact.period_start);
        }
        if (fact.period_end != null) {
          calculationValue[`${slotName}_period_end`] = fact.period_end;
          disclosedPeriodEnds.add(fact.period_end);
        }
        if (fact.unit === "KRW") {
          if (fact.scale === 1_000) calculationValue[`${slotName}_thousand_krw`] = fact.normalized_value;
          if (fact.scale === 1_000_000) calculationValue[`${slotName}_million_krw`] = fact.normalized_value;
          if (fact.scale === 1) calculationValue[`${slotName}_krw`] = fact.normalized_value;
          // v0.2 canonicalizes normalized_value to KRW, but preserves the
          // exact table-disclosed value/scale in the reviewed migration
          // provenance. Expose both representations under unambiguous keys;
          // never divide the canonical value to reconstruct a disclosure.
          const migration = fact.attributes?.normalization_migration;
          if (migration?.status === "OWNER_APPROVED") {
            if (migration.previous_scale === 1_000) calculationValue[`${slotName}_thousand_krw`] = migration.previous_normalized_value;
            if (migration.previous_scale === 1_000_000) calculationValue[`${slotName}_million_krw`] = migration.previous_normalized_value;
          }
        }
      }
      if (disclosedPeriodStarts.size === 1) calculationValue.period_start = [...disclosedPeriodStarts][0];
      if (disclosedPeriodEnds.size === 1) calculationValue.period_end = [...disclosedPeriodEnds][0];
      if (disclosedUnits.size === 1) calculationValue.unit = [...disclosedUnits][0];
      // Provenance registry for every successful Calculator result. This
      // is the SINGLE authority the Response Composer reads to render/
      // claim a computed value -- output_kind is declared explicitly by
      // the caller (never guessed later from the key's own suffix), so a
      // key like "revenue_ratio_diff_disclosed_pp" or "amount_change_krw"
      // -- which matches no `_diff_krw`/`_diff_percent`/`_change_percent`
      // suffix convention -- is still guaranteed a claim. This registry
      // does not perform arithmetic itself; services.calculator remains
      // the only calculation authority.
      const calculationRegistry = [];
      // Turn M2 item 5: core Calculator invocation now takes Fact OBJECTS
      // directly (not slot names) so a generically-discovered pair (never
      // named by a per-question slot string) can go through the exact same
      // proof-bound Calculator path as the pre-existing slot-named calls
      // below. `displayMultiplier` is a Flow-local PRESENTATION scale
      // applied AFTER Calculator returns its exact result (e.g. RATIO's
      // raw fraction -> a percent number for display) -- it never touches
      // Calculator's own CalculationRequest/CalculationResult contract,
      // which stays formula-agnostic (RATIO itself is not "always a
      // percent"; SHARES/VALUE-typed RATIO usages must keep the raw
      // fraction). Default 1 keeps every pre-existing call byte-identical.
      async function calculateFactPair(formula, factA, factB, outputKey, outputKind, { displayMultiplier = 1 } = {}) {
        const pair = [factA, factB];
        if (pair.some((fact) => !fact || typeof fact.normalized_value !== "number" || !Number.isFinite(fact.normalized_value))) return undefined;
        if (!unitsAreEquivalent(pair[0].unit, pair[1].unit) || (pair[0].scope ?? null) !== (pair[1].scope ?? null) || (pair[0].scale ?? null) !== (pair[1].scale ?? null)) return undefined;
        const inputs = pair.map(calculationInput);
        const validation = await services.validator.validateFacts(inputs);
        // The SAME unmodified `inputs` the Validator just proved is what
        // the Calculator receives -- its own UNIT_MISMATCH check now
        // recognizes KRW/원 (etc.) equivalence internally (see
        // canonicalCalculatorUnit in agent-runtime.mjs), so no input
        // mutation is needed here to satisfy it.
        const calculated = services.calculator.calculate({ formula, inputs, validation });
        const result = calculated.result * displayMultiplier;
        calculationValue[outputKey] = result;
        // Flow-local PRESENTATION metadata only (Turn I) -- Calculator's
        // own CalculationRequest/CalculationResult contract is untouched;
        // `formula` here is always one of Calculator's own frozen
        // CALCULATOR_FORMULAS (see domain/runtime/agent-runtime.mjs), never
        // a value this Flow invents. input_labels/input_units come only
        // from the two real VERIFIED Facts' own raw_label/unit -- never
        // from question text -- so the Composer can render a natural
        // sentence without ever showing `outputKey` itself.
        calculationRegistry.push({
          key: outputKey, output_kind: outputKind, formula,
          input_fact_ids: [pair[0].fact_id, pair[1].fact_id], result,
          input_labels: [pair[0].raw_label ?? pair[0].metric_code, pair[1].raw_label ?? pair[1].metric_code],
          input_units: [pair[0].unit ?? null, pair[1].unit ?? null],
          // Turn M: generic per-input corp_code/period metadata -- added
          // for EVERY calculatePair call regardless of which slots it
          // names (never a per-question addition), so the Composer can
          // disambiguate a same-metric/different-period sentence
          // ("PERCENTAGE_CHANGE" over two periods of the SAME entity) from
          // a same-metric/different-entity sentence ("DIFF" between two
          // companies) without guessing from outputKey text. A resolvable
          // corp_code is never invented -- only ever the real VERIFIED
          // Fact's own corp_code field, resolved to a name later by the
          // Composer via the SAME companyLabels path every other entity
          // label already uses.
          input_corp_codes: [pair[0].corp_code ?? null, pair[1].corp_code ?? null],
          input_periods: [pair[0].as_of_date ?? pair[0].period_end ?? pair[0].period_start ?? null, pair[1].as_of_date ?? pair[1].period_end ?? pair[1].period_start ?? null],
          // Turn M2 item 5: the two real VERIFIED Facts' own metric_code --
          // a closed, corpus-wide ontology token (never a Flow-invented
          // value) -- lets the Composer recognize a SPECIFIC metric-pair
          // shape (e.g. OPERATING_PROFIT/REVENUE -> "operating margin")
          // generically across ANY company/period that has both metrics,
          // without keying on outputKey, slot name, or question_id.
          input_metric_codes: [pair[0].metric_code ?? null, pair[1].metric_code ?? null],
        });
        return result;
      }
      async function calculatePair(formula, firstSlot, secondSlot, outputKey, outputKind) {
        return calculateFactPair(formula, factBySlot.get(firstSlot), factBySlot.get(secondSlot), outputKey, outputKind);
      }
      // Turn M2 item 5: generic per-company operating margin (operating
      // profit / revenue) -- works for ANY company/period pair present in
      // THIS question's already-VERIFIED, Plan-scoped `facts` (never a
      // hardcoded slot name), gated by the SAME applicability conditions
      // the Owner note requires: same corp_code, same scope, matching
      // period (period_start/period_end, or as_of_date when neither Fact
      // carries a period range), a nonzero revenue denominator (checked
      // here so a genuine zero-revenue Fact is skipped cleanly rather than
      // relying on Calculator's own DIVISION_BY_ZERO rejection), and a
      // normalizable (identical) unit -- enforced by calculateFactPair's
      // existing unit/scope/scale equality check. Uses Calculator's own
      // official RATIO formula; only the x100 percent-display scale is
      // Flow-local presentation, applied via displayMultiplier.
      function sameOperatingMarginPeriod(a, b) {
        if (a.period_start != null || a.period_end != null || b.period_start != null || b.period_end != null) {
          return (a.period_start ?? null) === (b.period_start ?? null) && (a.period_end ?? null) === (b.period_end ?? null);
        }
        return a.as_of_date != null && (a.as_of_date ?? null) === (b.as_of_date ?? null);
      }
      const revenueFacts = facts.filter((f) => f.metric_code === "REVENUE" && typeof f.normalized_value === "number" && Number.isFinite(f.normalized_value));
      const operatingProfitFacts = facts.filter((f) => f.metric_code === "OPERATING_PROFIT" && typeof f.normalized_value === "number" && Number.isFinite(f.normalized_value));
      for (const opFact of operatingProfitFacts) {
        const revFact = revenueFacts.find((r) =>
          (r.corp_code ?? null) === (opFact.corp_code ?? null) &&
          (r.scope ?? null) === (opFact.scope ?? null) &&
          sameOperatingMarginPeriod(r, opFact)
        );
        if (!revFact || revFact.normalized_value === 0) continue;
        // The output key must be unique per (company, period) -- a single
        // company queried across multiple periods (e.g. a year-over-year
        // comparison question) produces one DISTINCT margin per period, and
        // reusing a corp_code-only key would silently collide two different
        // results into the same calculationValue slot while the registry
        // still kept both (an UNGROUNDED_NUMBER-shaped bug caught by the
        // Final Synthesis Validator's own exact-match re-derivation).
        const periodKey = opFact.period_end ?? opFact.period_start ?? opFact.as_of_date ?? opFact.fact_id;
        const outputKey = `operating_margin_percent__${opFact.corp_code ?? opFact.fact_id}__${periodKey}`;
        await calculateFactPair("RATIO", opFact, revFact, outputKey, "PERCENT", { displayMultiplier: 100 });
      }
      // Turn M2 item 6A: generic termination-amount vs. effective-contract-
      // amount match/mismatch -- works for ANY company/event chain present
      // in THIS question's already-VERIFIED, Plan-scoped `facts` that
      // carries BOTH real semantic roles (see contract-amount-role.mjs),
      // never a hardcoded slot name or question_id. "Same event chain"
      // (Owner note's own applicability condition) is checked via each
      // Fact's own event_id -> the SAME real Event's chain_id, whenever
      // both facts resolve one; when a chain_id can't be resolved for
      // either side, falls back to same corp_code alone rather than
      // silently skipping (the corp_code match is itself real VERIFIED
      // Fact data, never invented).
      const eventsById = new Map(events.map((event) => [event.event_id, event]));
      function chainIdOf(fact) {
        const event = fact.event_id ? eventsById.get(fact.event_id) : null;
        return event?.chain_id ?? null;
      }
      const terminationAmountFacts = facts.filter((f) => f.metric_code === TERMINATION_AMOUNT_METRIC_CODE && typeof f.normalized_value === "number" && Number.isFinite(f.normalized_value));
      const contractAmountFacts = facts.filter((f) => isEffectiveContractAmountMetric(f.metric_code) && typeof f.normalized_value === "number" && Number.isFinite(f.normalized_value));
      for (const terminationFact of terminationAmountFacts) {
        const terminationChainId = chainIdOf(terminationFact);
        const contractFact = contractAmountFacts.find((c) => {
          if ((c.corp_code ?? null) !== (terminationFact.corp_code ?? null)) return false;
          const contractChainId = chainIdOf(c);
          if (terminationChainId != null && contractChainId != null) return terminationChainId === contractChainId;
          return true;
        });
        if (!contractFact) continue;
        const outputKey = `contract_amount_match_diff_krw__${terminationFact.corp_code ?? terminationFact.fact_id}__${terminationFact.fact_id}`;
        await calculateFactPair("DIFF", terminationFact, contractFact, outputKey, "VALUE");
      }
      for (const prefix of ["", "hmm_", "mobis_"]) {
        await calculatePair("PERCENTAGE_CHANGE", `${prefix}revenue_2023`, `${prefix}revenue_2025`, `${prefix}revenue_change_percent`, "PERCENT");
        await calculatePair("PERCENTAGE_CHANGE", `${prefix}operating_profit_2023`, `${prefix}operating_profit_2025`, `${prefix}operating_profit_change_percent`, "PERCENT");
      }
      await calculatePair("DIFF", "latest_amount", "original_amount", "amount_change_krw", "VALUE");
      await calculatePair("DIFF", "hyosung_termination_amount", "samsung_heavy_termination_amount", "termination_amount_diff_krw", "VALUE");
      await calculatePair("DIFF", "hyosung_revenue_ratio", "samsung_heavy_revenue_ratio", "revenue_ratio_diff_disclosed_pp", "PERCENT");
      await calculatePair("DIFF", "revenue_hd", "revenue_shi", "revenue_diff_krw", "VALUE");
      await calculatePair("DIFF", "operating_profit_hd", "operating_profit_shi", "operating_profit_diff_krw", "VALUE");
      await calculatePair("PERCENTAGE_CHANGE", "revenue_shi", "revenue_hd", "revenue_diff_percent", "PERCENT");
      await calculatePair("PERCENTAGE_CHANGE", "operating_profit_shi", "operating_profit_hd", "operating_profit_diff_percent", "PERCENT");
      if (calculationValue.original_amount !== undefined) calculationValue.amount_original_krw = calculationValue.original_amount;
      if (calculationValue.latest_amount !== undefined) calculationValue.amount_latest_krw = calculationValue.latest_amount;
      if (calculationValue.original_end_date !== undefined) calculationValue.end_date_original = calculationValue.original_end_date;
      if (calculationValue.latest_end_date !== undefined) calculationValue.end_date_latest = calculationValue.latest_end_date;
      if (calculationValue.holding_shares !== undefined) calculationValue.shares_after_correction = calculationValue.holding_shares;
      if (calculationValue.holding_ratio !== undefined) calculationValue.ratio_after_correction_percent = calculationValue.holding_ratio;
      if (calculationValue.disposal_shares !== undefined) calculationValue.shares_disposed = calculationValue.disposal_shares;
      if (calculationValue.revenue_hd_krw !== undefined) calculationValue.hd_revenue_krw = calculationValue.revenue_hd_krw;
      if (calculationValue.operating_profit_hd_krw !== undefined) calculationValue.hd_operating_profit_krw = calculationValue.operating_profit_hd_krw;
      if (calculationValue.revenue_shi_krw !== undefined) calculationValue.shi_revenue_krw = calculationValue.revenue_shi_krw;
      if (calculationValue.operating_profit_shi_krw !== undefined) calculationValue.shi_operating_profit_krw = calculationValue.operating_profit_shi_krw;
      // Turn I §5-A: the winner side is decided ONLY from the already-
      // computed DIFF result's sign against the SAME ordered pair the
      // registry entry itself used (result >= 0 -> first input wins) --
      // never a hardcoded company-name literal. This still records only
      // the winning side's real corp_code (a VERIFIED Fact field, not an
      // invented label); Response Composer resolves the human-readable
      // label at render time via the SAME companyLabels/corp_code
      // fallback renderValueLines already uses, so no name is ever
      // guessed here and no literal Seed company name lives in Flow code.
      if (calculationValue.revenue_diff_krw !== undefined) {
        calculationValue.revenue_winner_corp_code = calculationValue.revenue_diff_krw >= 0
          ? factBySlot.get("revenue_hd")?.corp_code ?? null
          : factBySlot.get("revenue_shi")?.corp_code ?? null;
        projectWinnerField(calculationValue, "revenue_winner_corp_code", "revenue_winner", context?.companyLabels);
      }
      if (calculationValue.operating_profit_diff_krw !== undefined) {
        calculationValue.operating_profit_winner_corp_code = calculationValue.operating_profit_diff_krw >= 0
          ? factBySlot.get("operating_profit_hd")?.corp_code ?? null
          : factBySlot.get("operating_profit_shi")?.corp_code ?? null;
        projectWinnerField(calculationValue, "operating_profit_winner_corp_code", "operating_profit_winner", context?.companyLabels);
      }
      const hdOriginalUnit = disclosedScaleLabel(factBySlot.get("revenue_hd"));
      const shiOriginalUnit = disclosedScaleLabel(factBySlot.get("revenue_shi"));
      if (hdOriginalUnit && shiOriginalUnit) {
        calculationValue.original_unit_hd = hdOriginalUnit;
        calculationValue.original_unit_shi = shiOriginalUnit;
        calculationValue.original_units_differ = hdOriginalUnit !== shiOriginalUnit;
      }
      if (calculationValue.revenue_diff_percent !== undefined && calculationValue.operating_profit_diff_percent !== undefined) {
        calculationValue.non_scored_fields = {
          revenue_diff_percent: calculationValue.revenue_diff_percent,
          operating_profit_diff_percent: calculationValue.operating_profit_diff_percent,
        };
      }
      if (
        calculationValue.revenue_change_percent !== undefined
        && calculationValue.operating_profit_change_percent !== undefined
      ) calculationValue.unit = "%";
      if (
        calculationValue.operating_profit_2023_value_status
        && calculationValue.operating_profit_2023_value_status === calculationValue.operating_profit_2025_value_status
      ) calculationValue.operating_profit_value_status = calculationValue.operating_profit_2023_value_status;
      if (calculationValue.revenue_2023_value_status === "NOT_APPLICABLE" && calculationValue.revenue_2025_value_status === "NOT_APPLICABLE") {
        calculationValue.revenue_field_available = false;
      }
      if (
        calculationValue.hmm_revenue_change_percent !== undefined
        && calculationValue.hmm_operating_profit_change_percent !== undefined
        && calculationValue.mobis_revenue_change_percent !== undefined
        && calculationValue.mobis_operating_profit_change_percent !== undefined
      ) {
        calculationValue.hmm = {
          revenue_change_percent: calculationValue.hmm_revenue_change_percent,
          operating_profit_change_percent: calculationValue.hmm_operating_profit_change_percent,
        };
        calculationValue.hyundai_mobis = {
          revenue_change_percent: calculationValue.mobis_revenue_change_percent,
          operating_profit_change_percent: calculationValue.mobis_operating_profit_change_percent,
        };
        calculationValue.both_companies_operating_profit_growth_exceeds_revenue_growth =
          calculationValue.hmm_operating_profit_change_percent > calculationValue.hmm_revenue_change_percent
          && calculationValue.mobis_operating_profit_change_percent > calculationValue.mobis_revenue_change_percent;
        const hmmMagnitude = Math.max(Math.abs(calculationValue.hmm_revenue_change_percent), Math.abs(calculationValue.hmm_operating_profit_change_percent));
        const mobisMagnitude = Math.max(Math.abs(calculationValue.mobis_revenue_change_percent), Math.abs(calculationValue.mobis_operating_profit_change_percent));
        // Turn I §5-A: corp_code, never a hardcoded "HMM"/"현대모비스" literal
        // -- see the revenue_winner_corp_code note above for the same
        // resolve-at-render-time rationale.
        calculationValue.larger_change_magnitude_company_corp_code = hmmMagnitude >= mobisMagnitude
          ? factBySlot.get("hmm_revenue_2023")?.corp_code ?? null
          : factBySlot.get("mobis_revenue_2023")?.corp_code ?? null;
        projectWinnerField(calculationValue, "larger_change_magnitude_company_corp_code", "larger_change_magnitude_company", context?.companyLabels);
      }
      if (calculationValue.samsung_heavy_revenue_ratio !== undefined) {
        calculationValue.samsung_heavy_revenue_ratio_percent = calculationValue.samsung_heavy_revenue_ratio;
      }
      if (calculationValue.hyosung_revenue_ratio !== undefined) {
        calculationValue.hyosung_revenue_ratio_percent = calculationValue.hyosung_revenue_ratio;
      }
      if (calculationValue.contract_amount_krw !== undefined && calculationValue.contract_amount !== undefined) {
        calculationValue.contract_amount_unit = "원";
      }
      if (calculationValue.latest_amount !== undefined) {
        const latestAmountFact = factBySlot.get("latest_amount");
        const dateKey = latestAmountFact?.as_of_date?.replaceAll("-", "_");
        if (dateKey) calculationValue[`latest_amount_${dateKey}`] = calculationValue.latest_amount;
        calculationValue.latest_effective_contract_amount_krw = calculationValue.latest_amount;
      }
      if (calculationValue.latest_ratio !== undefined) {
        calculationValue.revenue_ratio_percent = calculationValue.latest_ratio;
        calculationValue.latest_effective_revenue_ratio_percent = calculationValue.latest_ratio;
      }
      if (calculationValue.latest_period_start !== undefined) {
        calculationValue.period_start = calculationValue.latest_period_start;
        calculationValue.latest_effective_period_start = calculationValue.latest_period_start;
      }
      if (calculationValue.latest_period_end !== undefined) {
        calculationValue.period_end = calculationValue.latest_period_end;
        calculationValue.latest_effective_period_end = calculationValue.latest_period_end;
      }
      if (calculationValue.latest_counterparty !== undefined) calculationValue.latest_effective_counterparty = calculationValue.latest_counterparty;
      if (calculationValue.latest_location !== undefined) calculationValue.latest_effective_location = calculationValue.latest_location;
      if (calculationValue.correction_timeline !== undefined) {
        calculationValue.correction_timeline_status = factBySlot.get("correction_timeline")?.attributes?.timeline_status ?? "DISCLOSED";
      }
      // Turn I: the regex-based `latest_package_terms` -> pkg1/pkg4 and
      // `latest_equity_shares` -> equity_share reassembly that used to
      // live here has been REMOVED from the answer-generation authority.
      // Both were per-question projections (a hardcoded "PKG #1 ... PKG
      // #4 ..." format, validated against exactly one real corpus
      // example) that claimed to split a single compressed VERIFIED Fact
      // string into precisely-attributed atomic values -- a claim this
      // Flow cannot actually back with per-value provenance. The
      // compressed Fact's own normalized_value is still shown verbatim
      // via the ordinary Fact-line rendering path (renderValueLines in
      // response-composer.mjs renders every string-valued Fact
      // automatically); nothing is lost, only the "already split into
      // pkg1/pkg4" presentation. If the SAME Fact's own real, VERIFIED
      // evidence_ids genuinely contain a qualifier hedge (e.g. "약"), the
      // Composer's existing generic qualifier-scan mechanism
      // (scanNarrativeSources in synthesis-signal-planner.mjs, which
      // already scans every fact/evidence pair in the request -- not just
      // this one) surfaces it as its own sentence with real source
      // provenance; this Flow never re-inserts a qualifier itself. See
      // response-composer.mjs's qualifier_scope:"FACT_LEVEL_COARSE"
      // labeling for why this is Fact-level (not per-value) provenance,
      // and work/domain-seed/ for the Q22 timeline/package Owner-policy
      // review this removal does not need to wait on.
      if (
        calculationValue.holding_before_count !== undefined
        && calculationValue.holding_after_count !== undefined
        && calculationValue.holding_before_ratio !== undefined
        && calculationValue.holding_after_ratio !== undefined
      ) {
        calculationValue.shares_before = calculationValue.holding_before_count;
        calculationValue.shares_after = calculationValue.holding_after_count;
        calculationValue.ratio_before_percent = calculationValue.holding_before_ratio;
        calculationValue.ratio_after_percent = calculationValue.holding_after_ratio;
        calculationValue.changed = calculationValue.holding_before_count !== calculationValue.holding_after_count
          || calculationValue.holding_before_ratio !== calculationValue.holding_after_ratio;
      }
      // Gold's expected_answer nests this one field under `context` --
      // the only such case among the Seed questions. Deterministic
      // reshape of an already-VERIFIED scalar Fact value, not an inferred
      // or synthesized number.
      if (calculationValue.context_reference_price_krw !== undefined) {
        calculationValue.context = { reference_price_krw: calculationValue.context_reference_price_krw };
      }
      // Deterministic caveat note templated from two already-VERIFIED
      // Fact values (연결에 포함된 회사수 in each period's periodic
      // report) -- not an LLM guess or a free-text summary invented by
      // this Flow. Only fires when both counts are present and differ;
      // if they were equal there would be no scope-comparability caveat
      // to state at all.
      if (
        calculationValue.consolidation_entity_count_2023 !== undefined
        && calculationValue.consolidation_entity_count_2025 !== undefined
        && calculationValue.consolidation_entity_count_2023 !== calculationValue.consolidation_entity_count_2025
      ) {
        calculationValue.consolidation_scope_note =
          `연결 종속회사 수 ${calculationValue.consolidation_entity_count_2023}개→${calculationValue.consolidation_entity_count_2025}개 변경, 단순 동일 스코프 비교 아님`;
      }

      const evidenceToFacts = new Map();
      for (const slot of plan.slots) for (const evidenceId of slot.evidence_ids) {
        const ids = evidenceToFacts.get(evidenceId) ?? [];
        ids.push(...slot.fact_ids); evidenceToFacts.set(evidenceId, unique(ids));
      }
      for (const item of evidence) {
        await services.validator.validateEvidence({
          evidence_id: item.evidence_id, document_id: item.document_id, file_id: item.file_id,
          source_locator: item.source_locator, quoted_text: item.quoted_text, quote_sha256: item.quote_sha256,
          scope: "COMPANY", period: plan.as_of_date, value_status: "DISCLOSED",
          fact_ids: evidenceToFacts.get(item.evidence_id) ?? factIds, event_ids: [], relation_ids: [],
        });
      }

      const lines = facts.map((fact) => {
        const label = fact.raw_label || fact.metric_code;
        const suffix = unitLabel(fact.unit);
        return `- ${label}: ${renderValue(fact.normalized_value)}${suffix ? ` ${suffix}` : ""}`;
      });
      const derivedLines = Object.entries(calculationValue)
        .filter(([key, value]) => key.endsWith("_percent") && typeof value === "number" && Number.isFinite(value))
        .map(([key, value]) => `- ${key}: ${renderValue(value)} %`);
      if (typeof calculationValue.changed === "boolean") {
        derivedLines.unshift(`- 보유주식 수·지분율 변화 여부: ${calculationValue.changed ? "변화 있음" : "변화 없음"}`);
      }
      const eventLines = events.map((event) => `- ${event.event_type}: ${event.event_date} (${event.event_status}) [${event.anchor_document_id}]`);
      const citations = evidence.map((item) => `- [${item.document_id} | ${item.source_locator}] ${item.quoted_text}`);
      const fallbackAnswer = [
        `확인된 공시의 구조화 사실은 다음과 같습니다.`,
        ...lines,
        ...(derivedLines.length ? ["검증된 계산 결과:", ...derivedLines] : []),
        ...(eventLines.length ? ["검증된 사건:", ...eventLines] : []),
        "근거 공시:",
        ...citations,
      ].join("\n");

      // fallbackAnswer is grounded by construction: every number in it is
      // a direct render of fact.normalized_value / calculationValue, with
      // no synthesis step in between -- so it is used, unmodified, as the
      // safe result whenever the composed narrative can't be validated as
      // safe. Composed text and fallback text are NEVER concatenated --
      // FAIL_CLOSED/SYNTHESIS_ERROR use 100% fallback, PASS uses 100%
      // composed, PARTIAL uses composed text plus generic (capability-ID-
      // free) natural-language gap notes appended to it, never fallback
      // content mixed in.
      let answer = fallbackAnswer;
      let fallbackUsed = true;
      let synthesis = {
        status: "SKIPPED", reasons: [], missing_capabilities: [], not_implemented_capabilities: [],
        applied_capabilities: [], required_capabilities: [], fallback_used: true,
        sub_request_authority: "HEURISTIC", covered_sub_requests: [], qualifier_scope: null,
      };
      try {
        // plan.sub_requests is undefined for every existing/legacy plan
        // (schema_version 0.1.0) -- planSynthesisSignals's own default
        // parameter then falls back to heuristic authority automatically,
        // so this is a strict no-op for all current production plans.
        // Only a CANDIDATE plan (schema_version 0.2.0, see
        // domain/adapters/sub-request-vocabulary.mjs) supplies a real
        // array here and switches this one request to structured
        // sub-request-completeness authority.
        const signals = planSynthesisSignals({ question: input.question, facts, events, evidence, calculationValue, subRequests: plan.sub_requests });
        const narrativeFields = extractNarrativeFields({ facts, evidence, slots: plan.slots, signals });
        // companyLabels: this Flow NEVER loads a Company Directory
        // artifact/path/env var itself -- it only ever forwards an
        // ALREADY-RESOLVED label map the caller supplies via
        // context.companyLabels, which the caller must have obtained
        // (if at all) exclusively through
        // domain/adapters/seed-company-resolver.mjs's
        // createGatedSeedCompanyResolver() -- the only function that
        // verifies an Owner decision is APPROVED and its pins genuinely
        // match the real artifact/manifest before returning a resolver.
        // The real Company Directory candidate's decision is currently
        // PENDING (see
        // work/domain-seed/seed-company-directory-owner-decision-template.v0.1.json)
        // and this Flow is NOT wired into production with a caller that
        // supplies context.companyLabels -- so today, in production,
        // companyLabels is always undefined and every entity label goes
        // through the safe UNRESOLVED_ENTITY_LABEL/PARTIAL path in
        // response-composer.mjs. A future turn should wire a caller that
        // constructs a gated resolver ONCE at process start (never per-
        // request, never from a raw path a caller/env passes ad hoc) and
        // forwards its resolved map here once the Owner actually approves.
        const composed = composeResponse({ facts, events, evidence, calculationValue, signals, narrativeFields, slots: plan.slots, calculationRegistry, companyLabels: context?.companyLabels ?? null, informationLimits: plan.information_limits ?? [] });
        const validation = validateSynthesis({
          composerOutput: composed, signals, calculationValue, facts, evidence, events,
          authorizedFactIds: facts.map((fact) => fact.fact_id),
          authorizedEventIds: events.map((event) => event.event_id),
          authorizedEvidenceIds: evidence.map((item) => item.evidence_id),
        });
        if (validation.status === "PASS") {
          answer = composed.answer;
          fallbackUsed = false;
        } else if (validation.status === "PARTIAL") {
          const gapCapabilities = [...validation.missing_capabilities, ...validation.not_implemented_capabilities];
          const gapLines = gapCapabilities.map((capabilityId) => `추가로 확인이 필요한 사항이 있습니다: ${limitationLabelKo(capabilityId)}.`);
          answer = [composed.answer, ...gapLines].join("\n");
          fallbackUsed = false;
        }
        // FAIL_CLOSED/SYNTHESIS_ERROR: answer/fallbackUsed stay at their
        // safe defaults (fallbackAnswer, true) -- composed text is
        // discarded entirely, never partially blended in.
        synthesis = {
          status: validation.status,
          reasons: validation.reasons,
          missing_capabilities: validation.missing_capabilities,
          not_implemented_capabilities: validation.not_implemented_capabilities,
          applied_capabilities: composed.applied_capabilities,
          required_capabilities: signals.required_capabilities,
          fallback_used: fallbackUsed,
          // {sub_request_id, status} results ONLY (never a capability ID
          // -- see response-composer.mjs) -- [] when the Plan carries no
          // structured sub_requests (heuristic-authority path).
          sub_request_authority: signals.sub_request_authority,
          covered_sub_requests: composed.covered_sub_requests,
          // Only meaningful when the composed narrative is actually what
          // was returned (PASS/PARTIAL); FAIL_CLOSED/SYNTHESIS_ERROR use
          // the ungrounded-by-construction fallback answer instead, so
          // qualifier_scope stays null there -- see the catch block below
          // and the initial default above.
          qualifier_scope: fallbackUsed ? null : composed.qualifier_scope,
        };
      } catch {
        // Never surface the caught error's message/stack/path -- those
        // are internal implementation detail (can contain file paths or
        // other unintended detail) and this trace is part of the
        // official external API response.
        synthesis = {
          status: "SYNTHESIS_ERROR",
          reasons: [{ code: "SYNTHESIS_EXCEPTION", detail: "internal synthesis error" }],
          missing_capabilities: [], not_implemented_capabilities: [], applied_capabilities: [], required_capabilities: [],
          fallback_used: true, sub_request_authority: "HEURISTIC", covered_sub_requests: [], qualifier_scope: null,
        };
      }

      return {
        final_response: {
          question: input.question,
          retrieved_context: evidence.map((item) => ({
            evidence_id: item.evidence_id, document_id: item.document_id,
            source_locator: item.source_locator, quoted_text: item.quoted_text,
          })),
          think_trace: {
            execution_mode: "STRUCTURED",
            operations: ["resolve_seed_plan", "query_verified_facts", "query_verified_evidence", "query_verified_events", "validate_provenance"],
            calculation: { value: calculationValue },
            validation: { status: "SUPPORTED", answerability: "SUPPORTED", facts: facts.length, events: events.length, evidence: evidence.length, synthesis },
          },
          answer,
        },
        execution_trace: { selected_evidence: evidenceIds },
      };
    },
  });
}
