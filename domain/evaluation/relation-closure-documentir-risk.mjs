// Turn N4.5.1: pure logic for the REAL-DocumentIR-grounded multi-step
// correction risk re-detection that supersedes Turn N4.5's
// PARSER_UNCERTAIN-only heuristic (domain/evaluation/relation-closure-integration.mjs's
// detectMultiStepCorrectionRisk, left unmodified as audit history). No
// filesystem access here -- callers load and pre-extract DocumentIR fields
// via domain/adapters/document-ir-raw-source-loader.mjs and
// domain/evaluation/document-ir-field-extraction.mjs and pass the results
// in. No document id, company name, or specific value is hardcoded.
//
// A row's candidate qualifies as a risk candidate only when BOTH:
//   A. a corpus-internal connection signal -- the candidate's own receipt
//      date appears in the source's own "※ 관련공시" dates, OR the
//      candidate is itself already flagged as a correction document
//      (target_info.is_correction) in the existing candidate list
//   B. a real value-continuity or strong identity signal -- a
//      before(source)/after(candidate) field match, OR (name+counterparty
//      or name+amount both matching) together with the date link from A
// PARSER_UNCERTAIN, TARGET_NOT_IN_CORPUS alone, "a candidate exists",
// same company, same doc_subtype, or within-365-days are explicitly NEVER
// sufficient on their own -- see the counterexample tests.
import { findContinuitySignals, findIdentitySignals } from "./document-ir-field-extraction.mjs";

export const RISK_STRENGTHS = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM" });

function evaluateCandidate({ candidate, sourceRelatedDisclosureDates, sourceBeforeByCategory, sourceCurrentByCategory, candidateCurrentByCategory }) {
  const dateLinked = Boolean(candidate.target_receipt_date) && sourceRelatedDisclosureDates.some((d) => d.date === candidate.target_receipt_date);
  const intermediateCorrectionInList = candidate.target_info?.is_correction === true;
  const conditionA = dateLinked || intermediateCorrectionInList;
  if (!conditionA) return null;

  const continuitySignals = candidateCurrentByCategory
    ? findContinuitySignals({ sourceBeforeByCategory, candidateCurrentByCategory })
    : [];
  const identitySignals = dateLinked && candidateCurrentByCategory
    ? findIdentitySignals({ sourceCurrentByCategory, candidateCurrentByCategory })
    : [];

  const conditionB = continuitySignals.length > 0 || identitySignals.length > 0;
  if (!conditionB) return null;

  const strength = continuitySignals.length > 0 && identitySignals.length > 0 && dateLinked ? RISK_STRENGTHS.HIGH : RISK_STRENGTHS.MEDIUM;

  return {
    target_document_id: candidate.target_document_id,
    date_linked: dateLinked,
    intermediate_correction_in_candidate_list: intermediateCorrectionInList,
    continuity_signals: continuitySignals,
    identity_signals: identitySignals,
    risk_strength: strength,
  };
}

// Evaluates one unaudited-REJECT row's full candidate set against its own
// pre-extracted DocumentIR analysis. `candidateAnalysisById` maps each
// candidate's target_document_id to its pre-extracted
// { currentByCategory } (or null if that candidate's own DocumentIR could
// not be loaded -- handled explicitly, never silently skipped).
export function evaluateRowAgainstDocumentIr({
  row,
  sourceRelatedDisclosureDates,
  sourceBeforeByCategory,
  sourceCurrentByCategory,
  candidateAnalysisById,
}) {
  const candidateEvaluations = [];
  const candidatesUnavailable = [];
  for (const candidate of row.candidates ?? []) {
    const analysis = candidateAnalysisById.get(candidate.target_document_id);
    if (analysis === undefined) {
      candidatesUnavailable.push(candidate.target_document_id);
      continue;
    }
    const result = evaluateCandidate({
      candidate,
      sourceRelatedDisclosureDates,
      sourceBeforeByCategory,
      sourceCurrentByCategory,
      candidateCurrentByCategory: analysis ? analysis.currentByCategory : null,
    });
    if (result) candidateEvaluations.push(result);
  }

  if (candidateEvaluations.length === 0) {
    return { qualifies: false, risk_strength: null, candidate_evaluations: [], candidates_unavailable: candidatesUnavailable };
  }

  // A row can have more than one qualifying candidate; the row's overall
  // strength is the strongest of its candidates (HIGH beats MEDIUM), and
  // every qualifying candidate is preserved for the Owner/Reviewer packet
  // rather than collapsing to just one.
  const anyHigh = candidateEvaluations.some((c) => c.risk_strength === RISK_STRENGTHS.HIGH);
  return {
    qualifies: true,
    risk_strength: anyHigh ? RISK_STRENGTHS.HIGH : RISK_STRENGTHS.MEDIUM,
    candidate_evaluations: candidateEvaluations,
    candidates_unavailable: candidatesUnavailable,
  };
}
