// Open-answer scoring. The delivered version scored every OPEN answer via
// `gold.open_scoring_metadata`, a field that does not exist anywhere in
// evaluation-gold.v0.2.schema.json or in any Gold record in this repo — it
// silently returned all-NOT_SCORED for every real OPEN question. This
// rewrite scores only from fields that actually exist in the frozen Gold
// contract (required_evidence_slots, expected_answer.value,
// extensions.evidence_verification, gold_document_ids), and never treats
// answer.includes(claim) as a final accuracy number: free-text claims that
// need paraphrase judgment are surfaced as REVIEW_REQUIRED, not silently
// scored PASS/FAIL by substring match.
import { slotIsGrounded } from "./evidence-match.mjs";

function notScored(detail) {
  return { status: "NOT_SCORED", detail };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function normalizedDates(text) {
  const dates = new Set();
  const pattern = /(\d{4})(?:-|\.|\/|년\s*)(\d{1,2})(?:-|\.|\/|월\s*)(\d{1,2})(?:일)?/g;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) dates.add(value);
  }
  return dates;
}
function structuredValueMatches(actual, expected, spec) {
  if (typeof expected === "number") {
    if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
    const tolerance = Number(spec.tolerance ?? 0);
    return spec.comparator === "RELATIVE"
      ? Math.abs(actual - expected) <= Math.abs(expected) * tolerance
      : Math.abs(actual - expected) <= tolerance;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => structuredValueMatches(actual[index], value, spec));
  }
  if (expected && typeof expected === "object") {
    return actual && typeof actual === "object" && !Array.isArray(actual)
      && Object.keys(expected).every((key) => Object.hasOwn(actual, key) && structuredValueMatches(actual[key], expected[key], spec));
  }
  return actual === expected;
}

// Deterministic: reuses the exact same evidence-identity rule as Closed
// scoring (evidence_id first, else document_id+source_locator+quoted_text).
function requiredEvidenceCoverage(gold, response) {
  const slots = gold.required_evidence_slots ?? [];
  if (!slots.length) return notScored("no required_evidence_slots in Gold");
  const contexts = response?.retrieved_context;
  const perSlot = {};
  let anyFail = false;
  for (const slot of slots) {
    const pass = slotIsGrounded(slot, contexts, gold.extensions);
    perSlot[slot.slot_name] = pass ? "PASS" : "FAIL";
    if (!pass) anyFail = true;
  }
  return { status: anyFail ? "FAIL" : "PASS", detail: perSlot };
}

// Deterministic: expected_answer.value's explicit scalar fields are exact
// facts (dates, names, statuses), not paraphrasable claims — a substring
// check against the answer text is a legitimate deterministic signal here,
// unlike open-ended claim text. Numbers/booleans/nested values are left
// NOT_SCORED (see closed-metric.mjs's reasoning for why a bare number
// cannot be safely regex-matched out of prose).
function explicitFactValueSlots(gold, response) {
  const value = gold.expected_answer?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notScored("expected_answer.value has no explicit fact/value slots to check");
  }
  const answer = typeof response?.answer === "string" ? response.answer : "";
  const calculation = response?.think_trace?.calculation?.value;
  const structured = calculation && typeof calculation === "object" && !Array.isArray(calculation) ? calculation : {};
  const spec = gold.scoring_spec ?? {};
  const fields = {};
  let anyScored = false;
  let anyFail = false;
  let anyReview = false;
  for (const [key, fieldValue] of Object.entries(value)) {
    if (Object.hasOwn(structured, key)) {
      const actual = structured[key];
      const pass = structuredValueMatches(actual, fieldValue, spec);
      fields[key] = pass ? "PASS" : "FAIL";
      anyScored = true;
      if (!pass) anyFail = true;
      continue;
    }
    if (typeof fieldValue === "string" && fieldValue.length >= 2 && !DATE_PATTERN.test(fieldValue)) {
      const paraphraseSensitive = fieldValue.length >= 80 || /(?:note|summary|reason|impact|attribution|caveat)$/i.test(key);
      if (paraphraseSensitive) {
        fields[key] = "REVIEW_REQUIRED";
        anyReview = true;
        continue;
      }
      const pass = answer.includes(fieldValue);
      fields[key] = pass ? "PASS" : "FAIL";
      anyScored = true;
      if (!pass) anyFail = true;
    } else {
      fields[key] = "NOT_SCORED";
    }
  }
  if (!anyScored && !anyReview) return notScored("no string-shaped explicit fact/value fields");
  return { status: anyFail ? "FAIL" : anyReview ? "REVIEW_REQUIRED" : "PASS", detail: fields };
}

// Deterministic: date-shaped fields are unambiguous, unlike free prose —
// checked separately from explicitFactValueSlots so a temporal miss is
// distinguishable from a general fact miss.
function temporalRequirements(gold, response) {
  const value = gold.expected_answer?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notScored("expected_answer.value has no date-shaped fields to check");
  }
  const answer = typeof response?.answer === "string" ? response.answer : "";
  const answerDates = normalizedDates(answer);
  const dateFields = Object.entries(value).filter(([, v]) => typeof v === "string" && DATE_PATTERN.test(v));
  if (!dateFields.length) return notScored("no explicit date-shaped fields in expected_answer.value");
  const fields = {};
  let anyFail = false;
  for (const [key, dateValue] of dateFields) {
    const pass = answerDates.has(dateValue);
    fields[key] = pass ? "PASS" : "FAIL";
    if (!pass) anyFail = true;
  }
  return { status: anyFail ? "FAIL" : "PASS", detail: fields };
}

// No field in the current frozen Gold schema encodes a requested output
// format (table/bullet list/etc). Rather than guess from question text,
// this is honestly NOT_SCORED until Gold gains an explicit, additive
// signal for it.
function requestedFormat() {
  return notScored("no explicit requested-format field exists in the current Gold schema");
}

// Free-text claim coverage cannot be judged by substring match without
// false negatives on any paraphrase (this was the delivered code's
// `answer.includes(claim)` bug). There is no deterministic way to judge
// this from a blackbox HTTP response, so it is always surfaced for human
// or LLM-judge review rather than silently scored.
function claimCoverageReviewRequired() {
  return { status: "REVIEW_REQUIRED", detail: "free-text claim coverage requires paraphrase-aware review; not auto-scored" };
}

// Deterministic and stronger than "does this look like a citation shape":
// every cited document must be one of this question's gold_document_ids,
// and if a context entry carries an evidence_id, that id must be a real,
// Gold-recognized evidence_id for this question (not just any string).
function groundedness(gold, response) {
  const contexts = Array.isArray(response?.retrieved_context) ? response.retrieved_context : [];
  const goldDocs = new Set(gold.gold_document_ids ?? []);
  const evidenceIds = new Set((gold.extensions?.evidence_verification ?? []).map((entry) => entry.evidence_id));
  const perContext = [];
  let checked = 0;
  let anyUngrounded = false;
  for (const ctx of contexts) {
    if (!ctx || typeof ctx !== "object" || typeof ctx.document_id !== "string") {
      perContext.push("SKIPPED_NO_DOCUMENT_ID");
      continue;
    }
    checked++;
    const inGoldDocs = goldDocs.has(ctx.document_id);
    const evidenceOk = typeof ctx.evidence_id !== "string" || evidenceIds.has(ctx.evidence_id);
    const ok = inGoldDocs && evidenceOk;
    perContext.push(ok ? "GROUNDED" : "UNGROUNDED");
    if (!ok) anyUngrounded = true;
  }
  if (checked === 0) return notScored("no retrieved_context entries carried a document_id to check");
  return { status: anyUngrounded ? "FAIL" : "PASS", detail: perContext };
}

export function scoreOpen(gold, response) {
  return {
    required_evidence_coverage: requiredEvidenceCoverage(gold, response),
    explicit_fact_value_slots: explicitFactValueSlots(gold, response),
    temporal_requirements: temporalRequirements(gold, response),
    requested_format: requestedFormat(gold, response),
    claim_coverage: claimCoverageReviewRequired(gold, response),
    groundedness: groundedness(gold, response),
  };
}
