// Turn P6 section D: the ONE place that turns an (AgentOutcome,
// TelemetryEvent, thrown-error-or-not) triple into exactly one of the 10
// mutually exclusive outcome_category buckets contracts.mjs's
// OUTCOME_CATEGORIES enumerates. Every other module in this Turn (runner,
// scorers, report) reads outcome_category, never re-derives it -- this is
// the single source of truth so the classification can never drift between
// two call sites.
//
// WHY THIS EXISTS SEPARATELY FROM TelemetryEvent/ComparisonRecord: neither
// of those distinguishes a genuine TIMEOUT/ABORTED/BUDGET_EXCEEDED
// (runAgentFlow's own ExecutionTrace.fallback_reason -- see
// domain/runtime/agent-runtime.mjs's classifyFailure) from an ordinary
// zero-model-call information limit or a model-call-failure fallback; both
// collapse to model_fallback_used=false/scoring_eligible=true (a genuinely
// answered-or-honestly-declined request that runAgentFlow itself never
// even had to intervene on) or get folded into the SAME generic
// EARLY_EXIT/"정보 한계로 답변할 수 없습니다." shape. This module reads
// execution_trace.fallback_reason (already returned by runAgentFlow,
// unmodified) to recover that distinction without touching
// agent-runtime.mjs at all.
import { OUTCOME_CATEGORIES } from "./contracts.mjs";

export { OUTCOME_CATEGORIES };

// A harness-level failure (unregistered variant_id, factory construction
// threw, or anything else outside runAgentFlow's own always-succeeds
// contract) -- runAgentFlow was never even reached, or never returned.
export function classifyHarnessFailure() {
  return "AGENT_VARIANT_EXECUTION_FAILURE";
}

// `outcome`: the raw return of runAgentFlow (never discarded before this
// call -- see runner.mjs, which classifies BEFORE stripping raw text).
export function classifyOutcome(outcome) {
  const executionTrace = outcome?.execution_trace ?? {};
  const validation = outcome?.final_response?.think_trace?.validation ?? {};
  const fallbackReason = typeof executionTrace.fallback_reason === "string" ? executionTrace.fallback_reason : null;

  if (fallbackReason) {
    if (fallbackReason.startsWith("BUDGET_EXCEEDED:")) return "BUDGET_EXCEEDED";
    if (fallbackReason.startsWith("ABORTED:TIMEOUT")) return "TIMEOUT";
    if (fallbackReason.startsWith("ABORTED:")) return "ABORTED";
    if (fallbackReason.startsWith("REJECTED_INPUT:")) return "DATASET_CONTRACT_FAILURE";
    // INTERNAL_ERROR or any other Runtime Host-level classification this
    // module does not have a more specific bucket for.
    return "AGENT_VARIANT_EXECUTION_FAILURE";
  }

  const modelFallbackUsed = validation.model_fallback_used === true;
  const citationBindingStatus = validation.citation_binding_status;

  if (!modelFallbackUsed) {
    // Either a genuine model-generated answer that PASSED grounding
    // (NORMAL_ANSWER), or an honest zero-model-call information limit the
    // Flow itself decided on (NORMAL_INFORMATION_LIMIT) -- both are
    // "the Flow behaved exactly as designed", distinguished by whether any
    // text was ever produced/checked at all.
    if (citationBindingStatus === "PASS") return "NORMAL_ANSWER";
    return "NORMAL_INFORMATION_LIMIT";
  }

  // model_fallback_used=true: a deterministic fallback answer was
  // substituted. citation_binding_status distinguishes WHY (see every
  // variant flow's own FAILURE/FALLBACK ACCOUNTING header comment):
  //   NOT_CHECKED -- the model call itself never produced text to check.
  //     This is EITHER a genuine model-call failure (an error caught from
  //     modelAdapter.generate()) OR the Flow never even attempted a call
  //     because nothing was grounded to try (STRUCTURED_FIRST/HYBRID_RETRIEVAL/
  //     DOCUMENT_FIRST_RAG's own NOT_FOUND/NO_GROUNDED_EVIDENCE/RETRIEVAL_FAILED
  //     information-limit paths never call the model, but STILL set
  //     model_fallback_used=false in that case -- see each Flow's own
  //     informationLimitOutcome). So model_fallback_used=true AND
  //     citation_binding_status=NOT_CHECKED, together, only ever means a
  //     real attempted-and-failed model call.
  //   FAIL -- the call succeeded, but its generated answer was rejected by
  //     post-generation grounding (unauthorized citation or unsupported
  //     hard claim).
  if (citationBindingStatus === "NOT_CHECKED") return "MODEL_CALL_FAILURE_FALLBACK";
  if (citationBindingStatus === "FAIL") return "POST_HOC_CLAIM_VALIDATION_FAILURE_FALLBACK";
  return "MODEL_NOT_ATTEMPTED_INFORMATION_LIMIT";
}

// A DatasetRecord that fails its own schema/leakage contract never reaches
// runAgentFlow at all -- the runner classifies it this way BEFORE
// attempting any variant.
export function classifyDatasetContractFailure() {
  return "DATASET_CONTRACT_FAILURE";
}

// Whether a row counts toward a "success rate" mean/median. Only these
// three categories can be scoring_eligible=true at all, and even then only
// when the Flow's own scoring_eligible value (already on the outcome) says
// so -- this function does not override that, it only says which
// categories are ELIGIBLE to be true. Every other category is always
// scoring_eligible=false, enforced by runner.mjs.
export const SCORING_ELIGIBLE_CATEGORIES = Object.freeze([
  "NORMAL_ANSWER",
  "NORMAL_INFORMATION_LIMIT",
  "MODEL_NOT_ATTEMPTED_INFORMATION_LIMIT",
]);

export function isEligibleCategory(category) {
  return SCORING_ELIGIBLE_CATEGORIES.includes(category);
}
