// Turn P11-D: the ONE JSON Schema both structured-output candidates (Native
// v3 Function Calling and OpenAI-compatible response_format=json_schema)
// are validated against. This is NOT a new answer contract -- the three
// required fields (answer/used_fact_ids/used_evidence_ids) are exactly
// domain/agent-comparison/structured-answer-parsing.mjs's own real,
// already-enforced RESPONSE CONTRACT (the project's actual "structured-
// answer validator"), restated here as a formal JSON Schema so it can be
// handed to both a function-calling `parameters` field and an OpenAI-
// compatible `response_format.json_schema.schema` field verbatim. Nothing
// here changes what parseStructuredAnswer/parseHcxResponseBody already
// accept for the existing P11-A/B/C generation path -- this module is
// additive and lives entirely outside that path.
//
// The three optional fields (answerability/numeric_claims/date_claims)
// are NEVER required and never gate PASS/FAIL on their own presence this
// Turn (CLAUDE.md Turn P11-D: "Gold/RAG 품질 평가는 이번 Turn에서 하지
// 않는다"). `answerability`'s enum is copied verbatim from CLAUDE.md
// section 8's own already-frozen Answerability status list -- not invented
// here. numeric_claims/date_claims are NOT new model-output fields the
// candidates are asked to fill in; deriveHardClaims() below computes them
// from `answer` text using the EXISTING extractor
// (domain/agent-comparison/flows/hard-claim-grounding.mjs's
// extractHardClaims, Turn P1.1) so this module never asks HCX for
// information it does not already reliably produce as free text.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { extractHardClaims } from "../flows/hard-claim-grounding.mjs";

// Verbatim from CLAUDE.md section 8's Answerability list.
export const ANSWERABILITY_STATUSES = Object.freeze([
  "SUPPORTED",
  "NOT_FOUND",
  "ZERO_DOCUMENT_IN_CORPUS",
  "WITHHELD",
  "NOT_APPLICABLE",
  "UNANSWERABLE",
  "PARSE_FAILED",
  "OUT_OF_SCOPE",
  "AMBIGUOUS_QUERY",
  "CONFLICTING_EVIDENCE",
]);

export const COMMON_STRUCTURED_ANSWER_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://disclosure-analyst.local/schema/hcx-structured-protocol/common-structured-answer.v0.1.json",
  title: "Common Structured Answer (P11-D)",
  type: "object",
  additionalProperties: false,
  required: ["answer", "used_fact_ids", "used_evidence_ids"],
  properties: {
    answer: { type: "string", minLength: 1 },
    used_fact_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
    used_evidence_ids: { type: "array", items: { type: "string" }, uniqueItems: true },
    answerability: { type: "string", enum: [...ANSWERABILITY_STATUSES] },
    numeric_claims: { type: "array", items: { type: "string" } },
    date_claims: { type: "array", items: { type: "string" } },
  },
});

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validator = ajv.compile(COMMON_STRUCTURED_ANSWER_SCHEMA);

// Never throws. Returns { ok:true, value } or { ok:false, errors }.
// `errors` is a plain string array (schema-validation-message only -- never
// echoes back `candidate` itself, so a caller cannot accidentally log raw
// model output through an error message; see this file's header and
// CLAUDE.md Turn P11-D section G's non-exposure rule).
export function validateCommonStructuredAnswer(candidate) {
  const schemaOk = validator(candidate);
  const errors = schemaOk ? [] : (validator.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
  if (!schemaOk) return { ok: false, errors };
  if (candidate.answer.trim() === "") return { ok: false, errors: ["answer must not be empty/whitespace-only"] };
  return { ok: true, value: candidate };
}

// Pure, no I/O. Reuses the existing hard-claim extractor unchanged -- see
// this file's header. Returns counts only (never the extracted substrings
// themselves), matching CLAUDE.md Turn P11-D section G's allowed-field list
// (which has no room for logging claim text).
export function countHardClaims(answerText) {
  const claims = extractHardClaims(answerText);
  return {
    numeric_claim_count: claims.numbers.length,
    date_claim_count: claims.dates.length,
    document_id_claim_count: claims.documentIds.length,
  };
}
