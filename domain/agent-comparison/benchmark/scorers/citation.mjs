// Turn P6 section C.6: Citation/Evidence Scorer. Checks that the evidence
// this run actually used/kept (execution_trace.selected_evidence -- the
// VERIFIED intersection of what the Flow claimed and what
// services.validator.validateEvidence actually confirmed THIS request, per
// domain/runtime/agent-runtime.mjs's own runAgentFlow) is a SUBSET of
// DatasetRecord.allowed_evidence_ids, that no hard claim went unsupported
// (unsupported_claim_count), and re-surfaces citation_binding_status /
// evidence_validation_success_rate as first-class axis inputs rather than
// silently trusting them. `retrieval_score_hint`, if present, is NEVER
// consulted here -- there is no code path in this scorer that reads a
// vector-similarity score as evidence of a correct citation (Turn P6's own
// "vector similarity 자체는 citation 정답으로 인정하지 않음" rule); the axis
// only ever reads validated evidence_ids and the Runtime Host's own
// citation_binding_status.
import { pass, fail, partial } from "./axis-result.mjs";

export function scoreCitation({ allowedEvidenceIds, selectedEvidenceIds, citationBindingStatus, unsupportedClaimCount, evidenceValidationSuccessRate }) {
  const allowedSet = new Set(allowedEvidenceIds ?? []);
  const selected = selectedEvidenceIds ?? [];
  const unauthorized = selected.filter((id) => !allowedSet.has(id));

  const errorCodes = [];
  if (unauthorized.length > 0) errorCodes.push("UNAUTHORIZED_EVIDENCE_ID");
  if (citationBindingStatus === "FAIL") errorCodes.push("UNSUPPORTED_HARD_CLAIM");
  if ((unsupportedClaimCount ?? 0) > 0) errorCodes.push("UNSUPPORTED_CLAIM_PRESENT");

  const details = {
    selected_evidence_ids: selected,
    unauthorized_evidence_ids: unauthorized,
    citation_binding_status: citationBindingStatus,
    unsupported_claim_count: unsupportedClaimCount ?? 0,
    evidence_validation_success_rate: evidenceValidationSuccessRate ?? null,
  };

  if (errorCodes.length === 0) return pass(details);
  if (unauthorized.length > 0 || citationBindingStatus === "FAIL") return fail([...new Set(errorCodes)], details);
  // unsupported_claim_count>0 with citation_binding_status not FAIL is not
  // expected to occur (verifyGeneratedAnswer sets both together), but is
  // still reported as a partial rather than assumed impossible.
  return partial(0.5, [...new Set(errorCodes)], details);
}
