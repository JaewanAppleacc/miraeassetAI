// Shared response-body parsing for any ModelAdapter kind whose provider
// returns free text that is itself expected to be a JSON STRING encoding
// {answer, used_fact_ids, used_evidence_ids} (model-adapter.mjs's own
// RESPONSE CONTRACT). Extracted out of model-adapter.mjs (Turn P11-A) so
// hcx-model-adapter.mjs can reuse the exact same parsing/validation without
// a circular import between the two adapter-kind modules -- neither
// generic-HTTP nor HCX-specific parsing behavior changed by this
// extraction, only its location.
import { ModelCallError } from "./model-call-error.mjs";

export function isPlainArrayOfStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// The ONE response shape every Chat-Completions-family adapter parses:
// content is a JSON STRING (providers return free text, not a native
// object, in their message-content field) encoding
// {answer, used_fact_ids, used_evidence_ids}. Any deviation -- non-JSON
// content, missing/wrong-typed fields -- is MODEL_CALL_MALFORMED_RESPONSE,
// never silently coerced.
export function parseStructuredAnswer(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response content was not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.answer !== "string") {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response JSON is missing a string 'answer' field");
  }
  const usedFactIds = parsed.used_fact_ids ?? [];
  const usedEvidenceIds = parsed.used_evidence_ids ?? [];
  if (!isPlainArrayOfStrings(usedFactIds) || !isPlainArrayOfStrings(usedEvidenceIds)) {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response used_fact_ids/used_evidence_ids must be arrays of strings");
  }
  return { text: parsed.answer, used_fact_ids: usedFactIds, used_evidence_ids: usedEvidenceIds };
}
