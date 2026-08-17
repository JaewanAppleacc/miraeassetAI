// Generic date-role labeling (Turn M capability A; Turn M10 replaced the
// broad "CONTRACT" substring rule with a closed, controlled registry --
// see the header note below the rule list).
//
// A Fact's own as_of_date is NOT always a "기간" (period) -- it can be a
// disclosure date, a report/comparison-basis date, a decision date, a
// contract execution/termination date, or an event-occurrence date,
// depending on what KIND of Fact it is. This module infers the role from
// Fact-level structural signals that already exist for the WHOLE VERIFIED
// Fact ontology (metric_code, period_type, value_type) -- never from
// question_id, company name, or any literal specific to the current 25
// Seed questions. A metric_code taxonomy token this module has never seen
// still degrades safely to the conservative default ("기준일") rather
// than guessing or throwing.
//
// Turn M10 root-cause fix: the OLD rule 5 ("metric_code contains
// CONTRACT -> 계약 체결일") was a substring match broad enough to also
// catch TRUST_CONTRACT_INSTITUTION, LATEST_CONTRACT_AMOUNT, and
// CONTRACT_RESERVATION_DEADLINE -- none of which name a contract
// EXECUTION date at all (a decision-disclosure date, a later
// confirmation-basis date, and a reservation-disclosure date,
// respectively). Owner review across several unrelated real questions
// traced every one of those mislabels back to this single overbroad rule.
// Rather than add
// more substring carve-outs (the same failure mode that produced the bug
// in the first place), Turn M10 replaces it with an EXACT, closed
// metric_code -> role registry (SEMANTIC_ROLE_REGISTRY below) for the
// specific tokens whose date role is NOT safely inferable from period_type/
// value_type shape alone, checked BEFORE any substring rule. A
// metric_code not in this registry and not matched by a remaining
// substring rule still falls through to the conservative default.
// CONTRACT_AMOUNT and CONTRACT_PERIOD_END are deliberately NOT added to
// the registry -- with the CONTRACT substring rule removed, they now fall
// through to the plain-NUMERIC-disclosure default (공시일) or the
// conservative default (기준일) for a string-valued period-end, both of
// which are honest and never claim a contract EXECUTION date that the
// underlying disclosure never actually states.
//
// Rule order (first match wins):
//   1. A real period (period_start AND period_end both present and
//      different) -- render as an actual period, not a single date role.
//   2. An EXACT metric_code hit in SEMANTIC_ROLE_REGISTRY.
//   3. metric_code contains "TERMINATION" -> 해지일 (termination date).
//   4. metric_code contains "DECISION" or "PLANNED" -> 결정일 (decision date).
//   5. metric_code starts with "HOLDING_" or contains "SHAREHOLDING" ->
//      기준일 (a large-holding-report comparison basis date).
//   6. metric_code contains "RETIREMENT" or "ACQUISITION" -> 사건 발생일
//      (event occurrence date).
//   7. A STATUS/NARRATIVE-typed Fact (string-valued, metric_code ends in
//      "STATUS" or "CONTENT") not already matched -> 사건 발생일.
//   8. A plain NUMERIC disclosure not already matched -> 공시일 (disclosure
//      date) -- the ordinary case for a disclosed amount.
//   9. Anything else (role cannot be confidently inferred) -> 기준일,
//      flagged as a PARTIAL reason internally (never silently guessed).
//
// Turn M10 date VALUE override (separate from role, see inferDateRole's
// second parameter): a "*_STATUS"-suffixed Fact (the SAME closed naming
// convention rule 7/claimTypeForStringFact already use -- a lifecycle-
// status Fact whose VALUE is itself the occurrence being dated) that
// carries a resolvable `event_id` linking to a loaded VERIFIED Event
// prefers that Event's own `event_date` over the Fact's own `as_of_date`
// for the DISPLAYED date value. This is deliberately NOT applied to every
// event_id-carrying Fact: a plain value-disclosure Fact (e.g.
// CONTRACT_RESERVATION_DEADLINE) can share an event_id with a nearby-but-
// temporally-DIFFERENT Event on the same chain (the chain's own initiating
// decision, which may predate this specific disclosure by days) without
// that Event's date being what THIS Fact's own as_of_date is supposed to
// name -- overriding indiscriminately would silently overwrite a correct,
// disclosure-specific date with an unrelated one. A "*_STATUS" Fact and
// its linked Event, by contrast, are two VERIFIED records of the SAME
// real-world occurrence (a periodic/regulatory summary snapshot vs. the
// formal Event record) -- Owner review confirmed this class of Fact's own
// as_of_date can be a REPORTING-PERIOD boundary rather than the actual
// occurrence date, while the linked Event's event_date is the occurrence
// itself.
const ROLE = Object.freeze({
  PERIOD: "기간",
  DISCLOSURE_DATE: "공시일",
  REPORT_DATE: "기준일",
  DECISION_DATE: "결정일",
  CONTRACT_EXECUTION_DATE: "계약 체결일",
  CONTRACT_START_DATE: "계약 시작일",
  CONTRACT_END_DATE: "계약 종료일",
  TERMINATION_DATE: "해지일",
  EVENT_OCCURRENCE_DATE: "사건 발생일",
  COMPARISON_PERIOD: "비교 기간",
  CORRECTION_DISCLOSURE_DATE: "정정 공시일",
  RESERVATION_DISCLOSURE_DATE: "유보기한 공시일",
  EFFECTIVE_AMOUNT_CONFIRMATION_DATE: "유효 계약금액 확인 기준일",
  DEFINITIVE_AGREEMENT_DATE: "본계약 공시일",
});
export { ROLE as DATE_ROLE };

// Closed, exact metric_code registry -- every entry here is a real,
// corpus-observed VERIFIED Fact metric_code (never invented), and this
// registry is checked by EXACT equality, never substring, so it can never
// silently widen to catch a metric_code it was not deliberately written
// for. Grows only via a new exact entry, never a new substring rule.
const SEMANTIC_ROLE_REGISTRY = Object.freeze({
  CORRECTION_REASON: { role: "CORRECTION_DISCLOSURE_DATE", roleLabel: ROLE.CORRECTION_DISCLOSURE_DATE },
  CONTRACT_RESERVATION_DEADLINE: { role: "RESERVATION_DISCLOSURE_DATE", roleLabel: ROLE.RESERVATION_DISCLOSURE_DATE },
  LATEST_CONTRACT_AMOUNT: { role: "EFFECTIVE_AMOUNT_CONFIRMATION_DATE", roleLabel: ROLE.EFFECTIVE_AMOUNT_CONFIRMATION_DATE },
  TRUST_CONTRACT_INSTITUTION: { role: "DECISION_DATE", roleLabel: ROLE.DECISION_DATE },
  ACQUISITION_PLANNED_SHARES: { role: "DECISION_DATE", roleLabel: ROLE.DECISION_DATE },
  CONTRACT_STATUS: { role: "DEFINITIVE_AGREEMENT_DATE", roleLabel: ROLE.DEFINITIVE_AGREEMENT_DATE },
});

// Event.event_status -> role label, for the *_STATUS date-VALUE override
// described above. A small, closed, corpus-wide vocabulary (the SAME
// event_status enum natural-label.mjs's EVENT_STATUS_LABELS already
// translates) -- an event_status this map has never seen falls back to
// the Fact's own role/value exactly as if no event were linked at all,
// never a guess.
const EVENT_STATUS_ROLE_LABEL = Object.freeze({
  DECIDED: ROLE.DECISION_DATE,
  CORRECTED: "정정일",
  TERMINATED: ROLE.TERMINATION_DATE,
  COMPLETED: "완료일",
  CONFIRMED: "확정일",
});

function isRealPeriod(fact) {
  return Boolean(fact.period_start) && Boolean(fact.period_end) && fact.period_start !== fact.period_end;
}

function isStatusShaped(fact) {
  return typeof fact.metric_code === "string" && fact.metric_code.toUpperCase().endsWith("STATUS");
}

// Returns { role, roleLabel, confident }. `confident: false` means the
// conservative fallback (기준일) was used and the caller should record an
// internal PARTIAL reason -- never silently presented as a confident
// inference. `linkedEvent` (optional): the real VERIFIED Event resolved
// from this Fact's own `event_id`, already loaded by the caller for this
// same request -- never fetched here.
export function inferDateRole(fact, linkedEvent = null) {
  if (!fact || typeof fact !== "object") return { role: "REPORT_DATE", roleLabel: ROLE.REPORT_DATE, confident: false };
  if (isRealPeriod(fact)) return { role: "PERIOD", roleLabel: ROLE.PERIOD, confident: true };

  const code = typeof fact.metric_code === "string" ? fact.metric_code.toUpperCase() : "";

  const registryHit = SEMANTIC_ROLE_REGISTRY[code];
  if (registryHit) return { ...registryHit, confident: true };

  if (isStatusShaped(fact) && linkedEvent && EVENT_STATUS_ROLE_LABEL[linkedEvent.event_status]) {
    return { role: "EVENT_OCCURRENCE_DATE", roleLabel: EVENT_STATUS_ROLE_LABEL[linkedEvent.event_status], confident: true };
  }

  if (code.includes("TERMINATION")) return { role: "TERMINATION_DATE", roleLabel: ROLE.TERMINATION_DATE, confident: true };
  if (code.includes("DECISION") || code.includes("PLANNED")) return { role: "DECISION_DATE", roleLabel: ROLE.DECISION_DATE, confident: true };
  if (code.startsWith("HOLDING_") || code.includes("SHAREHOLDING")) return { role: "REPORT_DATE", roleLabel: ROLE.REPORT_DATE, confident: true };
  if (code.includes("RETIREMENT") || code.includes("ACQUISITION")) return { role: "EVENT_OCCURRENCE_DATE", roleLabel: ROLE.EVENT_OCCURRENCE_DATE, confident: true };
  if ((code.endsWith("STATUS") || code.endsWith("CONTENT")) && typeof fact.normalized_value === "string") {
    return { role: "EVENT_OCCURRENCE_DATE", roleLabel: ROLE.EVENT_OCCURRENCE_DATE, confident: true };
  }
  if (typeof fact.normalized_value === "number") return { role: "DISCLOSURE_DATE", roleLabel: ROLE.DISCLOSURE_DATE, confident: true };

  return { role: "REPORT_DATE", roleLabel: ROLE.REPORT_DATE, confident: false };
}

// Turn M10: resolves the actual date VALUE to display for a Fact, applying
// the *_STATUS + linked-Event override described above. Returns null when
// the Fact carries no date at all. Never called for a real period (the
// caller checks isRealPeriod-shaped dates via inferDateRole's PERIOD role
// separately, unaffected by this function).
export function resolveDateValue(fact, linkedEvent = null) {
  if (isStatusShaped(fact) && linkedEvent && typeof linkedEvent.event_date === "string" && linkedEvent.event_date !== "") {
    return linkedEvent.event_date;
  }
  return fact.as_of_date || fact.period_start || fact.period_end || null;
}
