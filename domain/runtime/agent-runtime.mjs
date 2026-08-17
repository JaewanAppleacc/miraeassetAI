// Runtime Host / SharedServices contracts (CLAUDE.md sections 4-7).
//
// AgentFlow is a plugin: `run(input, context, services) -> AgentOutcome`.
// A Flow never talks to a real HCX/Retriever/Calculator directly — it only
// gets the budgeted, proof-checking wrappers below via SharedServices, and
// every boundary rejects input that was not produced by *this request's*
// ValidationAuthority. A Flow cannot self-issue an approval:
// `validateEvidence`/`validateFacts` derive every ValidationResult field
// from the data itself (structural completeness + as-of-date effectivity),
// and the returned proof is bound to a hash of the subject PLUS the
// request's as_of_date, corpus_snapshot_id, fact_coverage_snapshot_id and a
// per-authority random validation_scope_id. Each `runAgentFlow` call gets
// its own ValidationAuthority (its own WeakSet, its own scope id) — a proof
// issued in one call is not even hash-comparable against another call's
// authority, let alone WeakSet-approved by it. Identical context across two
// calls does not make their proofs interchangeable.
//
// KNOWN LIMITATION — read before calling this a "grounded" Validator:
// validateEvidence/validateFacts only check the SHAPE and AS-OF-DATE
// EFFECTIVITY of whatever record a Flow hands them. They do not confirm
// that a fact_id exists in the shared Fact/Event/Relation Store, that a
// document_id/source_locator resolves to real corpus text, or that a quote
// matches the source. That requires FactStore, DocumentStore and a
// CitationValidator (CLAUDE.md section 5 lists these as separate
// SharedServices components) wired to real data — and per
// domain/HANDOFF.md, VERIFIED Fact/Evidence artifacts don't exist yet
// (BLOCKED_BY_HUMAN_REVIEW), so a real implementation cannot be built
// today without either serving an empty store or leaking CANDIDATE data
// into the official path, which domain/interfaces/b-to-c-mvp-contract
// v0.1's runtime_rule forbids. StructuredQuery -> StructuredResult (CLAUDE.md
// section 4) also has no schema yet in domain/interfaces/. This is a
// tracked P0 blocker for CLAUDE.md section 19 milestone 3 ("Seed Gold +
// 최소 VERIFIED Evidence"), owned jointly by B (Fact/Evidence data) and C
// (Store adapters) with an A/B/C-agreed contract — not something this
// module should invent unilaterally.

/**
 * @typedef {Object} ValidationResult
 * @property {("EVIDENCE"|"FACTS")} proof_type
 * @property {string} subject_hash          sha256 of {validation_scope_id, as_of_date, corpus_snapshot_id, fact_coverage_snapshot_id, subject}
 * @property {string} validation_scope_id   random id unique to the issuing ValidationAuthority
 * @property {boolean} evidence_supported
 * @property {boolean} version_valid
 * @property {string} dimension_comparison
 * @property {string} conflict_status       "NONE" or "RESOLVED" clears calculation/HCX use
 * @property {string} answerability
 */

/**
 * @typedef {Object} CalculationInput
 * @property {string} fact_id
 * @property {number} value
 * @property {string} [unit]
 * @property {string} [scope]
 * @property {string} value_status          one of contracts.mjs VALUE_STATUSES
 * @property {string} [known_at]
 * @property {string} [valid_from]
 * @property {string} [valid_to]
 */

/**
 * @typedef {Object} CalculationRequest
 * @property {string} formula               one of CALCULATOR_FORMULAS
 * @property {CalculationInput[]} inputs
 * @property {ValidationResult} validation   from validator.validateFacts(inputs), same request scope
 */

/**
 * @typedef {Object} CalculationResult
 * @property {CalculationInput[]} inputs
 * @property {{unit: (string|null)}} unit_normalization
 * @property {string} formula
 * @property {number} result
 */

/**
 * EvidenceBundle field names mirror domain/interfaces/semantic-bundle.schema.json's
 * Evidence $def (evidence_id/document_id/file_id/source_locator/quoted_text/
 * quote_sha256) rather than a separate runtime-only shape. Deliberately absent:
 * verification_status. A Flow cannot declare it — CitationValidator looks it up
 * from the trusted EvidenceStore by evidence_id and rejects anything not VERIFIED
 * (see createValidator/citation-validator.mjs).
 * @typedef {Object} EvidenceBundle
 * @property {string} evidence_id       pattern ^evidence_[0-9a-f]{24}$, looked up in EvidenceStore
 * @property {string} document_id
 * @property {string} file_id
 * @property {string} source_locator
 * @property {string} quoted_text       must match the EvidenceStore record and resolve in the real corpus text
 * @property {string} quote_sha256      must match the EvidenceStore record's quote_sha256
 * @property {string[]} [fact_ids]
 * @property {string[]} [event_ids]
 * @property {string[]} [relation_ids]
 * @property {string} scope
 * @property {string} period
 * @property {string} value_status
 * @property {string} [known_at]
 * @property {string} [valid_from]
 * @property {string} [valid_to]
 */

/**
 * @typedef {Object} AgentInput
 * @property {string} question
 * @property {string} [as_of_date]
 */

/**
 * @typedef {Object} SharedContext
 * @property {string} [corpus_snapshot_id]
 * @property {string} [fact_coverage_snapshot_id]
 * @property {string} [chunking_config_id]   pinned for Retriever request/context snapshot-triple checks; see retriever-store.mjs
 * @property {string} [index_snapshot_id]    pinned for Retriever request/context snapshot-triple checks; see retriever-store.mjs
 * @property {string} [as_of_date]
 * @property {AbortSignal} [signal]   request-scoped deadline/client-disconnect signal (see abortable.mjs); Flow execution and every async SharedServices call race against it
 */

/**
 * @typedef {Object} SharedServices
 * @property {{validateEvidence: function(EvidenceBundle): Promise<ValidationResult>, validateFacts: function(CalculationInput[]): ValidationResult}} validator
 * @property {{calculate: function(CalculationRequest): CalculationResult}} calculator
 * @property {{explain: function(Object): Object}} hcxClient
 * @property {{serialize: function(Object): Object}} serializer
 * @property {ReturnType<typeof createExecutionBudget>} executionBudget
 * @property {{retrieve: function(Object): Promise<Object>}} retriever   fail-closed by default; see retriever-store.mjs
 * @property {{query: function(Object): Promise<Object>}} structuredStore   fail-closed by default; see structured-store.mjs
 */

/**
 * @typedef {Object} ExecutionTrace
 * @property {string} flow_id
 * @property {string} execution_mode
 * @property {Array} operations
 * @property {Array} tool_calls
 * @property {Array} selected_evidence
 * @property {Array} hcx_calls
 * @property {number} latency_ms
 * @property {?string} fallback_reason
 */

/**
 * @typedef {Object} AgentOutcome
 * @property {Object} final_response        candidate for Serializer; the API JSON shape once serialized
 * @property {Partial<ExecutionTrace>} [execution_trace]
 */

/**
 * @typedef {Object} AgentFlow
 * @property {string} [id]
 * @property {function(AgentInput, SharedContext, SharedServices): Promise<AgentOutcome>} run
 */

import { createHash, randomUUID } from "node:crypto";
import { abortReason, raceAgainstAbort, RequestAbortedError } from "./abortable.mjs";
import { EXECUTION_ROUTES, VALUE_STATUSES } from "../contracts.mjs";
import { CITATION_CODES, createCitationValidator, createDocumentStore, createEvidenceStore } from "./citation-validator.mjs";
import { createFactProvenanceValidator, createFactStore, FACT_STORE_CODES } from "./fact-store.mjs";
import { isValidFinalResponse } from "./final-response-validator.mjs";
import { createPolicyGuard, POLICY_GUARD_CODES, POLICY_GUARD_SAFE_ANSWERS } from "./policy-guard.mjs";
import { createRetrieverStore, RETRIEVER_CODES } from "./retriever-store.mjs";
import { createBudgetedStructuredStore, createStructuredStore } from "./structured-store.mjs";

export class RejectedInputError extends Error {
  constructor(service, failures) {
    const list = failures.map((failure) =>
      typeof failure === "string" ? { code: "REJECTED", message: failure } : failure,
    );
    super(`${service} rejected input: ${list.map((f) => `${f.code}: ${f.message}`).join("; ")}`);
    this.name = "RejectedInputError";
    this.service = service;
    this.errors = list.map((f) => f.message);
    this.codes = list.map((f) => f.code);
    this.code = this.codes[0];
  }
}

export class BudgetExceededError extends Error {
  constructor(budgetName) {
    super(`execution budget exceeded: ${budgetName}`);
    this.name = "BudgetExceededError";
    this.budgetName = budgetName;
  }
}

function fail(code, message) {
  return { code, message };
}

// --- Failure code registry and response policy -----------------------
//
// Three intentionally separate registries exist, at three different
// layers. A code name (e.g. SNAPSHOT_MISMATCH, UNVERIFIED_DATA_FORBIDDEN)
// may legitimately appear in more than one when it denotes the same
// concept in a different subsystem — that is reuse, not collision, and
// this file is the one place that assembles (1) below so a new local code
// array added anywhere can never silently fail to join it (see
// tests/failure-registry.test.mjs).
//
//   1. RejectedInputError.code — thrown by every SharedServices boundary
//      (Validator, Calculator, HcxClient, PolicyGuard, and the AgentFlow
//      shape check). This is REJECTION_CODES: the union of this module's
//      own local codes plus every *_CODES array imported from a sibling
//      runtime module (CITATION_CODES, FACT_STORE_CODES, POLICY_GUARD_CODES,
//      RETRIEVER_CODES).
//   2. ExecutionTrace.fallback_reason — runAgentFlow's own classification
//      of what it caught, not a RejectedInputError code by itself:
//      `REJECTED_INPUT:<service>:<code>` (code is always a member of
//      REJECTION_CODES), `BUDGET_EXCEEDED:<budgetName>`,
//      `ABORTED:<TIMEOUT|CLIENT_DISCONNECT|ABORTED>` (the request-scoped
//      AbortSignal from SharedContext.signal fired — see abortable.mjs;
//      the reason distinguishes an internal deadline from an external
//      caller-supplied signal aborting, e.g. a client disconnect), the
//      literal string `INTERNAL_ERROR` for anything else, or `null` on
//      success. See classifyFailure. Like BUDGET_EXCEEDED, ABORTED is a
//      Runtime Host-level classification, not a RejectedInputError code —
//      it is never a member of REJECTION_CODES itself. This
//      fallback_reason value is Runtime Host-internal bookkeeping only;
//      it is never read by domain/runtime/answer-handler.mjs when
//      building the external API response body.
//   3. StructuredResult.error_codes — a separate JSON-Schema-enforced
//      enum for the OFFICIAL StructuredQuery/StructuredResult API
//      response (domain/interfaces/structured-result.schema.json), not a
//      thrown exception at all. It deliberately reuses some of the same
//      names (SNAPSHOT_MISMATCH, UNVERIFIED_DATA_FORBIDDEN,
//      INTERNAL_ERROR) for the same meaning, scoped to that response.
//
// Every rejection in (1), however it started, is caught exactly once — by
// runAgentFlow's own try/catch — and turned into (2) plus a Serializer-
// produced, schema-valid FinalResponse. No SharedServices boundary ever
// assembles its own safe-JSON fallback; there is one such place.
//
// tests/failure-registry.test.mjs enforces this by actually scanning
// domain/runtime/*.mjs for every exported `*_CODES` array (this module's
// own LOCAL_REJECTION_CODES included) rather than re-importing a
// hand-picked list — a new sibling module's *_CODES export is found by
// that directory scan whether or not anyone remembers to merge it in
// below, so a forgotten `...NEW_CODES` here shows up as a real test
// failure instead of silently missing REJECTION_CODES.
export const LOCAL_REJECTION_CODES = Object.freeze([
  "INVALID_SHAPE",
  "INVALID_ARITY",
  "DIVISION_BY_ZERO",
  "NON_FINITE_INPUT",
  "UNIT_MISMATCH",
  "SCOPE_MISMATCH",
  "UNTRUSTED_VALIDATION",
  "PROOF_SUBJECT_MISMATCH",
  "UNSUPPORTED_ANSWERABILITY",
  "UNAWAITED_SERVICE_CALL",
  "RUNTIME_CONTEXT_CLOSED",
]);

export const REJECTION_CODES = Object.freeze([
  ...new Set([...LOCAL_REJECTION_CODES, ...CITATION_CODES, ...FACT_STORE_CODES, ...POLICY_GUARD_CODES, ...RETRIEVER_CODES]),
]);

function toMessage(f) {
  return `${f.code}: ${f.message}`;
}

function messagesToFailures(messages) {
  return messages.map((message) => {
    const [code, ...rest] = message.split(": ");
    return fail(code, rest.join(": "));
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// --- ValidationAuthority: one per request, never global -------------------
//
// A proof is trusted only if:
//   (a) it is a member of THIS authority's private WeakSet — a hand-built
//       lookalike, or a proof minted by a different authority, is never a
//       member, full stop; and
//   (b) its subject_hash matches a fresh hash of {this authority's scope id,
//       as_of_date, corpus_snapshot_id, fact_coverage_snapshot_id, subject}
//       computed right now.
//
// (a) alone already makes cross-request replay impossible (each
// runAgentFlow call gets a fresh WeakSet), independent of whether the two
// requests share an identical context. (b) additionally makes the binding
// auditable/content-addressed and stops same-request replay against
// swapped data. Both are enforced together.

export function createValidationAuthority(context = {}, { now = todayIso } = {}) {
  const approved = new WeakSet();
  const bindings = Object.freeze({
    validation_scope_id: randomUUID(),
    as_of_date: typeof context?.as_of_date === "string" ? context.as_of_date : now(),
    corpus_snapshot_id: typeof context?.corpus_snapshot_id === "string" ? context.corpus_snapshot_id : null,
    fact_coverage_snapshot_id:
      typeof context?.fact_coverage_snapshot_id === "string" ? context.fact_coverage_snapshot_id : null,
  });

  function subjectHash(subject) {
    return createHash("sha256").update(JSON.stringify(canonicalize({ ...bindings, subject }))).digest("hex");
  }

  return {
    validationScopeId: bindings.validation_scope_id,
    referenceDate: bindings.as_of_date,

    issue(proofType, subject, derived) {
      const proof = Object.freeze({
        proof_type: proofType,
        subject_hash: subjectHash(subject),
        validation_scope_id: bindings.validation_scope_id,
        ...derived,
      });
      approved.add(proof);
      return proof;
    },

    isApproved(proof) {
      return typeof proof === "object" && proof !== null && approved.has(proof);
    },

    check(proof, expectedType, subject) {
      if (!(typeof proof === "object" && proof !== null && approved.has(proof))) {
        return [fail("UNTRUSTED_VALIDATION", "validation proof was not issued by this request's Validator")];
      }
      const errors = [];
      if (proof.proof_type !== expectedType) {
        errors.push(fail("UNTRUSTED_VALIDATION", `expected a ${expectedType} proof, got ${proof.proof_type}`));
      }
      if (proof.validation_scope_id !== bindings.validation_scope_id) {
        errors.push(fail("UNTRUSTED_VALIDATION", "validation proof belongs to a different request scope"));
      }
      if (proof.subject_hash !== subjectHash(subject)) {
        errors.push(fail("PROOF_SUBJECT_MISMATCH", "validation proof does not match the current input data"));
      }
      if (proof.answerability !== "SUPPORTED") {
        errors.push(fail("UNSUPPORTED_ANSWERABILITY", `answerability must be SUPPORTED, got ${proof.answerability}`));
      }
      if (!["NONE", "RESOLVED"].includes(proof.conflict_status)) {
        errors.push(fail("UNTRUSTED_VALIDATION", "unresolved conflict_status"));
      }
      return errors;
    },
  };
}

// --- shared temporal / answerability derivation ----------------------------

function isCurrentlyEffective(record, referenceDate) {
  if (!referenceDate) return true;
  if (record.known_at && record.known_at > referenceDate) return false;
  if (record.valid_from && record.valid_from > referenceDate) return false;
  if (record.valid_to && record.valid_to < referenceDate) return false;
  return true;
}

// derived purely from value_status/evidence/version — never accepted as a
// caller-supplied field, so a Flow cannot just assert "SUPPORTED".
function deriveAnswerability(records, evidenceSupported, versionValid) {
  if (records.some((record) => record.value_status === "WITHHELD")) return "WITHHELD";
  if (records.some((record) => record.value_status === "NOT_APPLICABLE")) return "NOT_APPLICABLE";
  if (!evidenceSupported || !versionValid || records.some((record) => record.value_status === "MISSING")) {
    return "UNANSWERABLE";
  }
  return "SUPPORTED";
}

// --- Validator: the only source of a trusted ValidationResult -------------
//
// There is no public "assert true" entry point. `validateEvidence` and
// `validateFacts` take the actual data (EvidenceBundle / calculation
// inputs) and compute every ValidationResult field themselves, then ask the
// bound ValidationAuthority to issue and register the proof.

function validateFactSetShape(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return [fail("INVALID_SHAPE", "inputs must be a non-empty array")];
  }
  return inputs.flatMap((input, index) => {
    const label = typeof input?.fact_id === "string" && input.fact_id !== "" ? input.fact_id : `inputs[${index}]`;
    if (!input || typeof input !== "object") return [fail("INVALID_SHAPE", `${label} must be an object`)];
    const errors = [];
    if (typeof input.fact_id !== "string" || input.fact_id === "") {
      errors.push(fail("INVALID_SHAPE", `${label}: fact_id is required`));
    }
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      errors.push(fail("NON_FINITE_INPUT", `${label}: value must be a finite number`));
    }
    if (!VALUE_STATUSES.includes(input.value_status)) {
      errors.push(fail("INVALID_SHAPE", `${label}: value_status must be one of ${VALUE_STATUSES.join(", ")}`));
    }
    // A Flow does not get to declare verification_status — it comes only
    // from the trusted FactStore, looked up by fact_id. Same rule as
    // EvidenceBundle: silently ignoring the field would let a confused or
    // malicious caller believe it did something.
    if ("verification_status" in input) {
      errors.push(fail("INVALID_SHAPE", `${label}: verification_status must not be supplied by the caller`));
    }
    return errors;
  });
}

function deriveFactsValidation(inputs, referenceDate) {
  const evidenceSupported = inputs.every((input) => input.value_status === "DISCLOSED");
  const versionValid = inputs.every((input) => isCurrentlyEffective(input, referenceDate));
  const units = new Set(inputs.map((input) => input.unit ?? null));
  const scopes = new Set(inputs.map((input) => input.scope ?? null));
  return {
    evidence_supported: evidenceSupported,
    version_valid: versionValid,
    dimension_comparison: units.size <= 1 && scopes.size <= 1 ? "CONSISTENT" : "MIXED_DIMENSIONS",
    // cross-fact conflict detection needs the shared Fact Store (a
    // different SharedServices component); not available in this module.
    conflict_status: "NONE",
    answerability: deriveAnswerability(inputs, evidenceSupported, versionValid),
  };
}

function validateEvidenceBundleShape(bundle) {
  if (!bundle || typeof bundle !== "object") return [fail("INVALID_SHAPE", "EvidenceBundle must be an object")];
  const errors = [];
  for (const field of ["evidence_id", "document_id", "file_id", "source_locator", "quoted_text", "quote_sha256", "scope", "period"]) {
    if (typeof bundle[field] !== "string" || bundle[field] === "") {
      errors.push(fail("INVALID_SHAPE", `${field} is required`));
    }
  }
  const hasIds = ["fact_ids", "event_ids", "relation_ids"].some(
    (key) => Array.isArray(bundle[key]) && bundle[key].length > 0,
  );
  if (!hasIds) errors.push(fail("INVALID_SHAPE", "at least one of fact_ids/event_ids/relation_ids is required"));
  if (!VALUE_STATUSES.includes(bundle.value_status)) {
    errors.push(fail("INVALID_SHAPE", `value_status must be one of ${VALUE_STATUSES.join(", ")}`));
  }
  // A Flow does not get to declare verification_status — it comes only
  // from the trusted EvidenceStore, looked up by evidence_id. Silently
  // ignoring the field would let a confused/malicious caller believe it
  // did something; reject the request outright instead.
  if ("verification_status" in bundle) {
    errors.push(fail("INVALID_SHAPE", "verification_status must not be supplied by the caller"));
  }
  return errors;
}

function deriveEvidenceValidation(bundle, referenceDate) {
  const versionValid = isCurrentlyEffective(bundle, referenceDate);
  return {
    evidence_supported: true, // reached only once the citation has been confirmed against the real corpus
    version_valid: versionValid,
    dimension_comparison: "CONSISTENT",
    // cross-document conflict detection needs the shared Fact Store; not
    // available in this module.
    conflict_status: "NONE",
    answerability: deriveAnswerability([bundle], true, versionValid),
  };
}

// `citationValidator`/`factProvenanceValidator` are optional so a caller
// that only ever uses one of validateEvidence/validateFacts doesn't need
// to construct both. When omitted, a fully fail-closed one (no
// DocumentStore/EvidenceStore/FactStore adapter) is used instead — neither
// method ever falls back to trusting the request's own claims, and
// neither EvidenceBundle nor CalculationInput even has a
// verification_status field a Flow could self-declare. Only the trusted
// EvidenceStore (by evidence_id) or FactStore (by fact_id) decides
// VERIFIED/CANDIDATE/REJECTED/PARSE_BLOCKED.
export function createValidator(
  authority,
  citationValidator = createCitationValidator(createDocumentStore(null), createEvidenceStore(null)),
  factProvenanceValidator = createFactProvenanceValidator(createFactStore(null)),
) {
  if (!authority) throw new TypeError("createValidator requires a ValidationAuthority");
  return {
    async validateEvidence(evidenceBundle) {
      const errors = validateEvidenceBundleShape(evidenceBundle);
      if (errors.length > 0) throw new RejectedInputError("Validator", errors);
      const citation = await citationValidator.check(evidenceBundle);
      if (!citation.ok) {
        throw new RejectedInputError("Validator", [fail(citation.code, "citation could not be verified against the corpus")]);
      }
      return authority.issue("EVIDENCE", evidenceBundle, deriveEvidenceValidation(evidenceBundle, authority.referenceDate));
    },
    async validateFacts(inputs) {
      const errors = validateFactSetShape(inputs);
      if (errors.length > 0) throw new RejectedInputError("Validator", errors);
      const provenance = await factProvenanceValidator.check(inputs);
      if (!provenance.ok) {
        throw new RejectedInputError("Validator", [fail(provenance.code, "fact could not be verified against the corpus")]);
      }
      return authority.issue("FACTS", inputs, deriveFactsValidation(inputs, authority.referenceDate));
    },
  };
}

// --- Calculator: only a proof-bound, arity-correct CalculationRequest -----

export const CALCULATOR_FORMULAS = Object.freeze(["SUM", "DIFF", "RATIO", "PERCENTAGE_CHANGE"]);

// Turn M10: the real VERIFIED Fact corpus is not consistent about
// whether a Fact's `unit` field holds the enum token ("KRW") or the raw
// Korean/symbol label ("원") for the SAME real unit -- domain/flows/
// synthesis/response-composer.mjs's claimTypeForUnit already had to work
// around the identical inconsistency for PERCENT/SHARES presentation.
// This is a COMPARISON-ONLY canonicalization used solely to decide
// whether two calculation inputs share a unit: it is never applied to
// `request.inputs` itself (each input keeps its own real, unmodified
// unit value throughout -- the proof-binding hash in
// createValidationAuthority.check() is computed over the untouched
// inputs the Validator actually approved, and must stay that way).
const CALCULATOR_UNIT_CANONICAL_TOKEN = Object.freeze({ 원: "KRW", "%": "PERCENT", 주: "SHARES" });
function canonicalCalculatorUnit(unit) {
  return CALCULATOR_UNIT_CANONICAL_TOKEN[unit] ?? unit ?? null;
}

const FORMULA_ARITY = Object.freeze({
  SUM: { min: 1 },
  DIFF: { exact: 2 },
  RATIO: { exact: 2 },
  PERCENTAGE_CHANGE: { exact: 2 },
});

function validateCalculationInputShape(input, index) {
  const label = typeof input?.fact_id === "string" && input.fact_id !== "" ? input.fact_id : `inputs[${index}]`;
  if (!input || typeof input !== "object") return [fail("INVALID_SHAPE", `${label} must be an object`)];
  const errors = [];
  if (typeof input.fact_id !== "string" || input.fact_id === "") {
    errors.push(fail("INVALID_SHAPE", `${label}: fact_id is required`));
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    errors.push(fail("NON_FINITE_INPUT", `${label}: value must be a finite number`));
  }
  return errors;
}

export function validateCalculationRequest(request, authority) {
  if (!authority) throw new TypeError("validateCalculationRequest requires a ValidationAuthority");
  if (!request || typeof request !== "object") {
    return [toMessage(fail("INVALID_SHAPE", "request must be an object"))];
  }
  if (!CALCULATOR_FORMULAS.includes(request.formula)) {
    return [toMessage(fail("INVALID_SHAPE", `formula must be one of ${CALCULATOR_FORMULAS.join(", ")}`))];
  }
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    return [toMessage(fail("INVALID_ARITY", "inputs must be a non-empty array"))];
  }

  const arity = FORMULA_ARITY[request.formula];
  const arityErrors = [];
  if (arity.exact !== undefined && request.inputs.length !== arity.exact) {
    arityErrors.push(fail("INVALID_ARITY", `${request.formula} requires exactly ${arity.exact} inputs`));
  }
  if (arity.min !== undefined && request.inputs.length < arity.min) {
    arityErrors.push(fail("INVALID_ARITY", `${request.formula} requires at least ${arity.min} inputs`));
  }
  if (arityErrors.length > 0) return arityErrors.map(toMessage);

  const perInputErrors = request.inputs.flatMap((input, index) => validateCalculationInputShape(input, index));
  if (perInputErrors.length > 0) return perInputErrors.map(toMessage);

  const proofErrors = authority.check(request.validation, "FACTS", request.inputs);
  if (proofErrors.length > 0) return proofErrors.map(toMessage);

  const errors = [];
  const units = new Set(request.inputs.map((input) => canonicalCalculatorUnit(input.unit)));
  if (units.size > 1) errors.push(fail("UNIT_MISMATCH", "inputs do not all share the same unit"));

  const scopes = new Set(request.inputs.map((input) => input.scope ?? null));
  if (scopes.size > 1) errors.push(fail("SCOPE_MISMATCH", "inputs do not all share the same scope"));

  if (request.formula === "RATIO" && request.inputs[1].value === 0) {
    errors.push(fail("DIVISION_BY_ZERO", "RATIO denominator must not be zero"));
  }
  if (request.formula === "PERCENTAGE_CHANGE" && request.inputs[0].value === 0) {
    errors.push(fail("DIVISION_BY_ZERO", "PERCENTAGE_CHANGE base value must not be zero"));
  }

  return errors.map(toMessage);
}

function applyFormula(formula, values) {
  switch (formula) {
    case "SUM":
      return values.reduce((total, value) => total + value, 0);
    case "DIFF":
      return values[0] - values[1];
    case "RATIO":
      return values[0] / values[1];
    case "PERCENTAGE_CHANGE":
      return ((values[1] - values[0]) / values[0]) * 100;
    default:
      return NaN;
  }
}

export function createCalculator(authority) {
  if (!authority) throw new TypeError("createCalculator requires a ValidationAuthority");
  return {
    calculate(request) {
      const errorMessages = validateCalculationRequest(request, authority);
      if (errorMessages.length > 0) throw new RejectedInputError("Calculator", messagesToFailures(errorMessages));
      const values = request.inputs.map((input) => input.value);
      const result = applyFormula(request.formula, values);
      if (!Number.isFinite(result)) {
        throw new RejectedInputError("Calculator", [fail("NON_FINITE_INPUT", "calculation result is not finite")]);
      }
      return {
        inputs: request.inputs,
        unit_normalization: { unit: request.inputs[0]?.unit ?? null },
        formula: request.formula,
        result,
      };
    },
  };
}

// --- HCX Client: only a proof-bound explanation or a safe early exit ------

function validateHcxRequest(request, authority) {
  if (!request || typeof request !== "object") return [fail("INVALID_SHAPE", "request must be an object")];
  if (request.type === "EARLY_EXIT") {
    if (typeof request.reason !== "string" || request.reason === "") {
      return [fail("INVALID_SHAPE", "EARLY_EXIT requires a reason")];
    }
    return [];
  }
  if (request.type === "EXPLAIN") {
    if (!request.evidenceBundle || typeof request.evidenceBundle !== "object") {
      return [fail("INVALID_SHAPE", "EXPLAIN requires an evidenceBundle")];
    }
    return authority.check(request.validation, "EVIDENCE", request.evidenceBundle);
  }
  return [fail("INVALID_SHAPE", `unknown request type: ${request.type}`)];
}

export function createHcxClient(authority) {
  if (!authority) throw new TypeError("createHcxClient requires a ValidationAuthority");
  return {
    explain(request) {
      const errors = validateHcxRequest(request, authority);
      if (errors.length > 0) throw new RejectedInputError("HcxClient", errors);
      return { accepted: true, type: request.type };
    },
  };
}

// --- Serializer: recursively JSON-safe, then re-checked with a real
//     JSON.stringify, falling back to a fixed minimal safe response ---------

const MAX_SERIALIZE_DEPTH = 20;
const SAFE_RESPONSE_FALLBACK = Object.freeze({
  question: "",
  retrieved_context: [],
  think_trace: Object.freeze({
    execution_mode: "EARLY_EXIT",
    operations: [],
    calculation: {},
    validation: {},
  }),
  answer: "요청을 안전하게 처리하지 못했습니다.",
});

// domain/interfaces/final-response.schema.json is the single source of
// truth for this shape (CLAUDE.md section 2) — this is a load-time
// assertion, not a runtime branch: if SAFE_RESPONSE_FALLBACK is ever edited
// to no longer satisfy the schema, importing this module fails loudly
// immediately, instead of that drift only surfacing the next time a request
// happens to hit the fallback path.
if (!isValidFinalResponse(SAFE_RESPONSE_FALLBACK)) {
  throw new Error("agent-runtime.mjs: SAFE_RESPONSE_FALLBACK does not satisfy domain/interfaces/final-response.schema.json");
}

function toJsonSafe(value, seen, depth) {
  if (depth > MAX_SERIALIZE_DEPTH) return "[Truncated]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => toJsonSafe(item, seen, depth + 1) ?? null);
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = toJsonSafe(item, seen, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return value;
}

function safeString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function createSerializer() {
  return {
    serialize(candidate) {
      try {
        const source = safePlainObject(toJsonSafe(candidate, new WeakSet(), 0));
        const thinkTraceSource = safePlainObject(source.think_trace);
        const executionMode = EXECUTION_ROUTES.includes(thinkTraceSource.execution_mode)
          ? thinkTraceSource.execution_mode
          : "EARLY_EXIT";

        const response = {
          question: safeString(source.question, ""),
          retrieved_context: safeArray(source.retrieved_context),
          think_trace: {
            execution_mode: executionMode,
            operations: safeArray(thinkTraceSource.operations),
            calculation: safePlainObject(thinkTraceSource.calculation),
            validation: safePlainObject(thinkTraceSource.validation),
          },
          answer: safeString(source.answer, "정보 한계로 답변할 수 없습니다."),
        };

        JSON.stringify(response);
        // The coercion above (safeString/safeArray/safePlainObject/the
        // executionMode allow-list) exists because a JSON Schema cannot by
        // itself repair malformed input — only reject it. This is the
        // opposite half of the same contract: a coerced-but-still-invalid
        // shape is never returned as if it were a valid FinalResponse. Both
        // halves point at the one schema file, so they cannot drift apart
        // the way two independently hand-maintained field lists could.
        if (!isValidFinalResponse(response)) return structuredClone(SAFE_RESPONSE_FALLBACK);
        return response;
      } catch {
        return structuredClone(SAFE_RESPONSE_FALLBACK);
      }
    },
  };
}

// --- ExecutionTrace auto-instrumentation: the Runtime Host records every
//     real SharedServices boundary call itself. A Flow's own
//     execution_trace.operations/tool_calls/hcx_calls are never read —
//     runAgentFlow sources these three fields exclusively from the
//     recorder built here, so a Flow cannot fabricate, hide, or edit a
//     call it did or didn't make. Only service/method/order/timing/
//     success/error-code are recorded — never a call's arguments, a
//     quoted/raw text span, an HCX prompt, or any other payload. ----------

function instrumentationErrorCode(error) {
  if (error instanceof RejectedInputError) return error.code;
  if (error instanceof BudgetExceededError) return `BUDGET_EXCEEDED:${error.budgetName}`;
  if (error instanceof RequestAbortedError) return `ABORTED:${error.reason}`;
  return "INTERNAL_ERROR";
}

// TraceRecorder is intentionally never attached to the `services` object a
// Flow receives (see TRACE_RECORDERS/getTraceRecorder/inspectServiceTrace
// below) — only this closure and code inside this module ever get a
// reference with a working record-capable API.
//
// A call is tracked in two phases, not one: registerPending() pushes a
// placeholder into the arrays the instant a call STARTS (so it can never
// go missing even if the Flow never awaits it — see runAgentFlow's
// UNAWAITED_SERVICE_CALL check), and settle() mutates that SAME object in
// place once the call actually resolves or rejects. Because it's the same
// object reference in the array the whole time, nothing needs to search
// for it later, and array push order already matches call-start order —
// snapshot() sorting by sequence is a defensive no-op in the normal case,
// not the only thing keeping order correct.
function createTraceRecorder() {
  const operations = [];
  const toolCalls = [];
  const hcxCalls = [];
  const pendingBySequence = new Map();
  let sequenceCounter = 0;
  let finalized = false;

  // Sequence is allocated at CALL START (see callers: always the first
  // thing a wrapper does, before invoking the underlying method), not at
  // completion — two calls started A-then-B keep sequence A<B even if B
  // settles first, so snapshot()'s sequence-sorted order reflects when a
  // call was actually initiated, not the (nondeterministic, race-prone)
  // order in which async calls happen to resolve or reject.
  function nextSequence() {
    sequenceCounter += 1;
    return sequenceCounter;
  }

  function registerPending({ sequence, category, service, method, started_at }) {
    if (finalized) return;
    const placeholder = { sequence, category, service, method, started_at, latency_ms: null, ok: null, error_code: null, pending: true };
    pendingBySequence.set(sequence, placeholder);
    operations.push(placeholder);
    if (category === "tool") toolCalls.push(placeholder);
    if (category === "hcx") hcxCalls.push(placeholder);
  }

  // Mutates the already-pushed placeholder in place — a no-op once
  // finalize() has run, so a promise that abandons and settles LATE (after
  // runAgentFlow already returned its response) can never mutate data the
  // caller already has a reference to.
  function settle(sequence, fields) {
    if (finalized) return;
    const placeholder = pendingBySequence.get(sequence);
    if (!placeholder) return;
    pendingBySequence.delete(sequence);
    Object.assign(placeholder, fields, { pending: false });
    Object.freeze(placeholder);
  }

  // Synchronous, exact "is anything still in flight right now" check — the
  // caller (runAgentFlow) uses this the instant flow.run() resolves. It
  // never waits: whatever hasn't settled by that exact moment is treated
  // as abandoned.
  function pendingCalls() {
    return [...pendingBySequence.values()];
  }

  function bySequence(a, b) {
    return a.sequence - b.sequence;
  }

  // Locks the recorder: no further registerPending/settle has any effect.
  // Called once, unconditionally, right before runAgentFlow returns, so a
  // stray late .then()/.catch() from an abandoned call can never mutate an
  // execution_trace object the caller already holds a reference to.
  function finalize() {
    finalized = true;
    for (const placeholder of pendingBySequence.values()) Object.freeze(placeholder);
  }

  // A pending entry is NOT frozen yet (settle() still needs to mutate it in
  // place), so returning the live placeholder object itself — even inside
  // a freshly-copied array — would let a caller holding a snapshot mutate
  // that shared object and corrupt the recorder's real internal state
  // (e.g. `snapshot.tool_calls[0].service = "FORGED"` while that call is
  // still pending). snapshot() therefore copies every ENTRY into a new
  // frozen plain object, not just the arrays that hold them — for both
  // pending and already-settled entries, so nothing returned from here is
  // ever a live reference into recorder-owned state.
  function copyEntry(entry) {
    return Object.freeze({ ...entry });
  }

  return {
    nextSequence,
    registerPending,
    settle,
    pendingCalls,
    finalize,
    isFinalized: () => finalized,
    snapshot() {
      return {
        operations: [...operations].sort(bySequence).map(copyEntry),
        tool_calls: [...toolCalls].sort(bySequence).map(copyEntry),
        hcx_calls: [...hcxCalls].sort(bySequence).map(copyEntry),
      };
    },
  };
}

function isThenable(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

// A Flow that stashes its `services` argument in an outer variable can
// still hold a live reference to it after runAgentFlow has returned — the
// object itself isn't destroyed. Without this check, calling a stashed
// method post-finalize would run the REAL underlying service (Retriever,
// HcxClient, ...) completely untracked, since registerPending() silently
// no-ops once finalized. This is the actual guard: called as the very
// first thing inside every wrapper, before fn is ever invoked, so the
// underlying call never happens at all once the request has closed.
function rejectIfRuntimeClosed(recorder, service, method) {
  if (recorder.isFinalized()) {
    throw new RejectedInputError(service, [
      fail("RUNTIME_CONTEXT_CLOSED", `${service}.${method} was called after its SharedServices instance's request already completed`),
    ]);
  }
}

// A SECOND, independent gate from rejectIfRuntimeClosed above — deliberately
// not folded into it. rejectIfRuntimeClosed only catches an already-closed
// request when something (today: runAgentFlow's closeRuntimeContextOnAbort
// listener) has actually finalized the recorder; createSharedServices can be
// used standalone, with no runAgentFlow wrapping it and no such listener
// ever wired up, in which case recorder.isFinalized() would never become
// true from an abort alone. Checking `signal.aborted` directly here means
// every SharedServices call this module wraps is blocked before its real
// `fn` is ever invoked — Calculator/HcxClient/Retriever/Validator/
// StructuredStore alike — whether or not the caller happens to be
// runAgentFlow. Called as the very first thing inside every wrapper
// (alongside rejectIfRuntimeClosed), before fn is ever invoked, so the real
// underlying call never happens at all once the signal has aborted.
function rejectIfAborted(signal) {
  if (signal?.aborted) {
    throw new RequestAbortedError(abortReason(signal));
  }
}

// `fn` may be a plain synchronous method OR one that happens to return a
// Promise (e.g. Retriever/HcxClient are not declared `async` in this
// module, so their return type isn't statically known — and a future real
// async HCX Client would be exactly this shape too). This wrapper handles
// both without changing fn's own calling convention: a synchronous throw
// (e.g. budget exceeded, thrown before any real call happens) is still
// caught and rethrown synchronously, so `assert.throws(() => wrapped())`
// keeps working; a returned Promise is NOT recorded as settled until it
// actually resolves or rejects (registerPending marks it pending the
// instant it's fired, so it can never just vanish from the trace either
// way — see runAgentFlow's UNAWAITED_SERVICE_CALL check).
//
// A Flow that fires this call without awaiting it (which is itself an
// UNAWAITED_SERVICE_CALL contract violation, but the underlying Promise
// still exists and can still reject later, independent of runAgentFlow
// having already rejected the request) must not ALSO trigger a Node
// `unhandledRejection` on top of that — see the `observed`/`.then(f, g)`
// dance below.
function wrapMaybeAsync(recorder, service, method, category, fn, { onSuccess, signal } = {}) {
  return (...args) => {
    rejectIfRuntimeClosed(recorder, service, method);
    rejectIfAborted(signal);
    const sequence = recorder.nextSequence();
    const startedAtMs = Date.now();
    recorder.registerPending({ sequence, category, service, method, started_at: new Date(startedAtMs).toISOString() });
    const finish = (ok, error, extra) => {
      recorder.settle(sequence, {
        latency_ms: Date.now() - startedAtMs,
        ok,
        error_code: ok ? null : instrumentationErrorCode(error),
        ...(extra ?? {}),
      });
    };
    try {
      const result = fn(...args);
      if (isThenable(result)) {
        const observed = Promise.resolve(result);
        // Attaching a rejection reaction here — synchronously, in the same
        // tick `observed` is created — is what makes Node consider
        // `observed` "handled", regardless of whether the CALLER ever
        // awaits/`.then()`s the value returned below. This reaction must
        // never rethrow: if it did, IT would become a new unhandled
        // promise instead (that was the original bug). This bookkeeping
        // always tracks the REAL eventual outcome — recorder.settle() is
        // already a safe no-op once the recorder has been finalized (e.g.
        // by an abort — see closeRuntimeContextOnAbort), so a call that
        // wins this bookkeeping race late, after the request has already
        // moved on, can never retroactively mutate an already-returned
        // ExecutionTrace.
        observed.then(
          (value) => finish(true, null, onSuccess ? onSuccess(args, value) : undefined),
          (error) => finish(false, error),
        );
        // What the CALLER actually awaits is raced against `signal`
        // separately from the bookkeeping above: if `signal` aborts before
        // `observed` settles, the caller gets a prompt rejection instead of
        // hanging until the real call finishes (or never finishes) — see
        // abortable.mjs. `observed` itself is fully observed by the
        // bookkeeping `.then()` above either way.
        //
        // BUT raceAgainstAbort(observed, signal) is NOT `observed` itself
        // once `signal` is present — it constructs and returns a brand
        // new, distinct Promise (`raced`), which starts out completely
        // unobserved. A Flow that fires this call without awaiting it
        // (UNAWAITED_SERVICE_CALL) leaves `raced` with no handler at all;
        // if `raced` later rejects — the real call failing, OR losing the
        // race to an abort — Node sees an unhandled rejection on `raced`
        // itself, independent of `observed` already being handled. The
        // fix is the same pattern as `observed`/`settled` above, applied
        // one layer further out: attach a synchronous, non-rethrowing
        // catch to `raced` itself (marks it "handled" without consuming
        // its value), then return `raced` — not some other promise
        // derived from that catch — so an awaiting caller still receives
        // the real rejection/RequestAbortedError exactly as before.
        const raced = raceAgainstAbort(observed, signal);
        raced.then(
          () => {},
          () => {},
        );
        return raced;
      }
      finish(true, null, onSuccess ? onSuccess(args, result) : undefined);
      return result;
    } catch (error) {
      finish(false, error);
      throw error;
    }
  };
}

// `fn` is a method genuinely declared `async` in this module (Validator,
// StructuredStore) — it always returns a real Promise. The wrapper itself
// is deliberately NOT declared `async` (a plain function returning a
// Promise built via an inner async IIFE instead): that IIFE's promise
// (`settled`) is what actually rejects with the real error, and a
// SEPARATE no-op `.catch(() => {})` attached to that same `settled`
// promise (not to some other derived promise) marks it "handled" for
// Node's unhandledRejection tracking without changing what `settled`
// itself settles to. `settled` — not the no-op catch's own derived
// promise — is what's returned, so an awaiting caller still gets the real
// rejection. RUNTIME_CONTEXT_CLOSED is thrown from inside the IIFE (not
// before it), so it still REJECTS `settled` rather than throwing
// synchronously out of the outer function — Validator/StructuredStore stay
// "async services reject", not "throw", once closed.
function wrapAsync(recorder, service, method, category, fn, { onSuccess, signal } = {}) {
  return (...args) => {
    const settled = (async () => {
      rejectIfRuntimeClosed(recorder, service, method);
      rejectIfAborted(signal);
      const sequence = recorder.nextSequence();
      const startedAtMs = Date.now();
      recorder.registerPending({ sequence, category, service, method, started_at: new Date(startedAtMs).toISOString() });
      try {
        const result = await fn(...args);
        recorder.settle(sequence, {
          latency_ms: Date.now() - startedAtMs,
          ok: true,
          error_code: null,
          ...(onSuccess ? onSuccess(args, result) : {}),
        });
        return result;
      } catch (error) {
        recorder.settle(sequence, {
          latency_ms: Date.now() - startedAtMs,
          ok: false,
          error_code: instrumentationErrorCode(error),
        });
        throw error;
      }
    })();

    // Always observed, independent of the abort race below — see the
    // matching comment in wrapMaybeAsync. recorder.settle() inside the IIFE
    // above is already a no-op once finalized, so a late settlement here
    // can never mutate an already-returned ExecutionTrace either.
    settled.catch(() => {});

    // What the CALLER actually awaits races against `signal` — see
    // abortable.mjs and the matching comment in wrapMaybeAsync. `raced` is
    // a NEW, distinct Promise once `signal` is present (not `settled`
    // itself), so `settled.catch()` above does not make Node treat `raced`
    // as handled — it needs its own synchronous, non-rethrowing catch, or
    // an unawaited fire-and-forget call whose `raced` later rejects (the
    // real failure, or losing the race to an abort) surfaces as an
    // unhandledRejection. `raced` itself — not a promise derived from that
    // catch — is what's returned, so an awaiting caller still gets the
    // real rejection/RequestAbortedError.
    const raced = raceAgainstAbort(settled, signal);
    raced.then(
      () => {},
      () => {},
    );
    return raced;
  };
}

// Policy Guard never throws (policy-guard.mjs) — its return value IS the
// input/output check result, so this records that result directly instead
// of exception-based ok/error_code. The checked text itself is the one
// argument this module handles that is never passed to the recorder. Fully
// synchronous, so registerPending+settle happen back to back — there is no
// meaningful "pending" window, but going through the same two-phase API
// keeps every entry's shape identical.
function wrapPolicyGuardCheck(recorder, method, fn) {
  return (text) => {
    rejectIfRuntimeClosed(recorder, "PolicyGuard", method);
    const sequence = recorder.nextSequence();
    const startedAtMs = Date.now();
    recorder.registerPending({
      sequence,
      category: "operation",
      service: "PolicyGuard",
      method,
      started_at: new Date(startedAtMs).toISOString(),
    });
    const result = fn(text);
    recorder.settle(sequence, {
      latency_ms: Date.now() - startedAtMs,
      ok: result?.ok !== false,
      error_code: result?.ok === false ? result.code : null,
    });
    return result;
  };
}

// Records a Runtime Host-level rejection (not a SharedServices call) —
// used for runAgentFlow's own input/outcome/pending-call checks.
function recordAgentFlowRejection(recorder, method, error) {
  const sequence = recorder.nextSequence();
  recorder.registerPending({ sequence, category: "operation", service: "AgentFlow", method, started_at: new Date().toISOString() });
  recorder.settle(sequence, { latency_ms: 0, ok: false, error_code: instrumentationErrorCode(error) });
}

// services -> TraceRecorder. Module-private: only createSharedServices
// (setter) and getTraceRecorder (getter, used by runAgentFlow in this same
// module) ever see a recorder with a working record-capable API. The only
// exported accessor, inspectServiceTrace below, hands back a read-only
// snapshot — never the recorder itself — so nothing that can mutate the
// trace is reachable through the `services` object a Flow receives, or by
// calling an exported function with that object either.
const TRACE_RECORDERS = new WeakMap();

function getTraceRecorder(services) {
  return TRACE_RECORDERS.get(services);
}

// Harness/test introspection only: a read-only snapshot of the calls
// recorded so far for this SharedServices instance, or null if `services`
// isn't one this module created.
export function inspectServiceTrace(services) {
  const recorder = TRACE_RECORDERS.get(services);
  return recorder ? recorder.snapshot() : null;
}

// --- Execution Budget: owns its own clock, caps calls and wall-clock time -

export function createExecutionBudget({ maxHcxCalls, maxRetrievals, maxToolCalls, timeoutMs, now = Date.now }) {
  const startedAt = now();
  let hcxCalls = 0;
  let retrievals = 0;
  let toolCalls = 0;

  function bump(name, current, max) {
    if (current >= max) throw new BudgetExceededError(name);
    return current + 1;
  }

  return {
    recordHcxCall() {
      hcxCalls = bump("maxHcxCalls", hcxCalls, maxHcxCalls);
    },
    recordRetrieval() {
      retrievals = bump("maxRetrievals", retrievals, maxRetrievals);
    },
    recordToolCall() {
      toolCalls = bump("maxToolCalls", toolCalls, maxToolCalls);
    },
    checkTimeout() {
      if (now() - startedAt > timeoutMs) throw new BudgetExceededError("timeoutMs");
    },
    elapsedMs() {
      return now() - startedAt;
    },
    remaining() {
      return {
        hcxCalls: maxHcxCalls - hcxCalls,
        retrievals: maxRetrievals - retrievals,
        toolCalls: maxToolCalls - toolCalls,
      };
    },
  };
}

// --- Budgeted wrappers: budget consumption lives inside the service, so an
//     Agent cannot call the real client without paying for it -------------

export function createBudgetedHcxClient(hcxClient, budget) {
  return {
    explain(request) {
      budget.recordHcxCall();
      budget.checkTimeout();
      return hcxClient.explain(request);
    },
  };
}

export function createBudgetedCalculator(calculator, budget) {
  return {
    calculate(request) {
      budget.recordToolCall();
      budget.checkTimeout();
      return calculator.calculate(request);
    },
  };
}

export function createBudgetedValidator(validator, budget) {
  return {
    async validateEvidence(evidenceBundle) {
      budget.recordToolCall();
      budget.checkTimeout();
      return validator.validateEvidence(evidenceBundle);
    },
    async validateFacts(inputs) {
      budget.recordToolCall();
      budget.checkTimeout();
      return validator.validateFacts(inputs);
    },
  };
}

export function createBudgetedRetriever(retriever, budget) {
  return {
    retrieve(request) {
      budget.recordRetrieval();
      budget.checkTimeout();
      return retriever.retrieve(request);
    },
  };
}

// Turns retriever-store.mjs's { ok, result } / { ok: false, code, message }
// into the same thrown-RejectedInputError convention every other
// SharedServices boundary uses — the same relationship createValidator has
// to citation-validator.mjs/fact-store.mjs's own {ok,code} results.
// retriever-store.mjs does not import RejectedInputError itself, to avoid
// a circular import with this module.
//
// `signal` (the request-scoped AbortSignal, if any) is bound here via
// closure — a Flow's own `services.retriever.retrieve(request)` call stays
// single-argument, exactly as documented in the SharedServices typedef; it
// never has to know about or thread abort plumbing itself. It is passed to
// retrieverStore.resolve() as a separate `{ signal }` options argument, NOT
// mixed into `request` — `request` stays exactly what retrieval-
// request.schema.json validates, so a real Retriever adapter can opt into
// honoring `signal` (e.g. to cancel a real search backend call) without
// that ever becoming part of the schema-validated request shape.
function createRetrieverService(retrieverStore, signal) {
  return {
    async retrieve(request) {
      const resolution = await retrieverStore.resolve(request, { signal });
      if (!resolution.ok) {
        throw new RejectedInputError("Retriever", [fail(resolution.code, resolution.message)]);
      }
      return resolution.result;
    },
  };
}

export function createSharedServices(
  budgetLimits,
  {
    context = {},
    retriever,
    structuredStoreAdapter,
    documentStoreAdapter,
    evidenceStoreAdapter,
    factStoreAdapter,
    budget: providedBudget,
    now,
  } = {},
) {
  const budget = providedBudget ?? createExecutionBudget({ ...budgetLimits, now });
  const authority = createValidationAuthority(context, now ? { now } : {});
  // The request-scoped AbortSignal, if any (see SharedContext's typedef
  // above and abortable.mjs). Bound once here and threaded through every
  // wrapper below, AND into DocumentStore/EvidenceStore/FactStore/
  // StructuredStore/Retriever's own constructors — a Flow's own
  // SharedServices call signatures never change because of it.
  const signal = context?.signal;
  const citationValidator = createCitationValidator(
    createDocumentStore(documentStoreAdapter ?? null, context, signal),
    createEvidenceStore(evidenceStoreAdapter ?? null, context, signal),
  );
  const factProvenanceValidator = createFactProvenanceValidator(
    createFactStore(factStoreAdapter ?? null, context, signal),
  );
  const services = {
    validator: createBudgetedValidator(createValidator(authority, citationValidator, factProvenanceValidator), budget),
    calculator: createBudgetedCalculator(createCalculator(authority), budget),
    hcxClient: createBudgetedHcxClient(createHcxClient(authority), budget),
    serializer: createSerializer(),
    executionBudget: budget,
    structuredStore: createBudgetedStructuredStore(
      createStructuredStore(structuredStoreAdapter ?? null, context, signal),
      budget,
    ),
    // Deliberately NOT wrapped in createBudgetedXxx — see policy-guard.mjs's
    // header comment: a safety check must never become skippable just
    // because the execution budget ran out elsewhere. For the same reason
    // it is never raced against `signal` either — a synchronous safety
    // check must never become skippable just because the request's
    // deadline happened to already pass.
    policyGuard: createPolicyGuard(),
    // Always present, fail-closed via RETRIEVER_UNAVAILABLE with no
    // adapter wired — same as validator/calculator/structuredStore, and
    // unlike the previous `if (retriever) ...` shape where a Flow calling
    // services.retriever with no adapter supplied got a raw TypeError
    // instead of a recorded, safe rejection. There is no way to reach a
    // Retriever adapter through createSharedServices without going through
    // retriever-store.mjs's request/result boundary first.
    retriever: createBudgetedRetriever(createRetrieverService(createRetrieverStore(retriever ?? null, context), signal), budget),
  };

  // Instrument every SharedServices boundary method AFTER budgeting is
  // applied, so a budget-exceeded attempt (thrown before the raw client is
  // ever reached) is recorded too, not just calls that made it through.
  //
  // Calculator/HcxClient/Retriever are wrapped with wrapMaybeAsync, not
  // wrapAsync: none of them is declared `async` in this module (Retriever
  // is caller-supplied and HcxClient may become a real async network call
  // later), so their return type isn't guaranteed to be a Promise — only
  // wrapMaybeAsync records the REAL settle outcome for either shape without
  // assuming one. Validator/StructuredStore ARE declared `async` here, so
  // there's no such ambiguity and wrapAsync is sufficient (and simpler).
  const recorder = createTraceRecorder();
  services.validator = {
    validateEvidence: wrapAsync(recorder, "Validator", "validateEvidence", "tool", services.validator.validateEvidence, {
      // The one piece of domain data this module captures for
      // ExecutionTrace: the bare evidence_id of a bundle that was
      // ACTUALLY verified (this callback only runs on success) — never
      // quoted_text, source content, or any other field of the bundle.
      onSuccess: (args) => {
        const evidenceId = args[0]?.evidence_id;
        return typeof evidenceId === "string" ? { evidence_id: evidenceId } : {};
      },
      signal,
    }),
    validateFacts: wrapAsync(recorder, "Validator", "validateFacts", "tool", services.validator.validateFacts, { signal }),
  };
  services.calculator = {
    calculate: wrapMaybeAsync(recorder, "Calculator", "calculate", "tool", services.calculator.calculate, { signal }),
  };
  services.hcxClient = {
    // No real HCX network client exists yet (CLAUDE.md's KNOWN LIMITATION
    // notes apply the same way here as elsewhere in this file) — `explain`
    // is still fully synchronous today, so this `signal` wiring has
    // nothing to actually race against yet. It is threaded through anyway
    // so a future real (async) HcxClient inherits the same abort boundary
    // automatically, with no change required here.
    explain: wrapMaybeAsync(recorder, "HcxClient", "explain", "hcx", services.hcxClient.explain, { signal }),
  };
  services.structuredStore = {
    query: wrapAsync(recorder, "StructuredStore", "query", "tool", services.structuredStore.query, { signal }),
  };
  services.policyGuard = {
    checkQuestion: wrapPolicyGuardCheck(recorder, "checkQuestion", services.policyGuard.checkQuestion),
    checkAnswer: wrapPolicyGuardCheck(recorder, "checkAnswer", services.policyGuard.checkAnswer),
  };
  services.retriever = {
    retrieve: wrapMaybeAsync(recorder, "Retriever", "retrieve", "tool", services.retriever.retrieve, { signal }),
  };

  // Deliberately NOT attached as services.trace — see TRACE_RECORDERS above.
  TRACE_RECORDERS.set(services, recorder);

  return services;
}

// --- Runtime Host: the one place a Flow's failure is caught and turned
//     into a safe FinalResponse instead of an escaping exception ----------

export function validateAgentOutcomeShape(outcome) {
  if (!outcome || typeof outcome !== "object") return [fail("INVALID_SHAPE", "AgentOutcome must be an object")];
  if (!outcome.final_response || typeof outcome.final_response !== "object") {
    return [fail("INVALID_SHAPE", "AgentOutcome.final_response must be an object")];
  }
  return [];
}

function classifyFailure(error) {
  if (error instanceof RejectedInputError) return `REJECTED_INPUT:${error.service}:${error.code}`;
  if (error instanceof BudgetExceededError) return `BUDGET_EXCEEDED:${error.budgetName}`;
  if (error instanceof RequestAbortedError) return `ABORTED:${error.reason}`;
  return "INTERNAL_ERROR";
}

// The internal Policy Guard code is recorded ONLY via ExecutionTrace.fallback_reason
// (see classifyFailure) — this is the one place the user-facing `answer` text is
// derived from a policy code, and it always resolves to a fixed external template,
// never the raw code name or an internal message string.
function policySafeAnswer(code) {
  return POLICY_GUARD_SAFE_ANSWERS[code] ?? "요청을 처리할 수 없습니다.";
}

// Closes the request scope (recorder.finalize()) the INSTANT `signal`
// aborts — synchronously, in the same tick as whatever called
// `controller.abort()`, not merely once the abandoned flow.run() promise
// eventually unwinds back to runAgentFlow's own catch block a microtask or
// more later. This is what makes "any SharedServices call attempted after
// abort is rejected before it reaches a real adapter" hold even for calls a
// still-running (but already-abandoned) Flow makes in the brief window
// after abort — reusing the exact same RUNTIME_CONTEXT_CLOSED mechanism
// that already closes the request scope on normal completion (see
// rejectIfRuntimeClosed), not a second, parallel closing concept.
// recorder.finalize() is idempotent, so this composes safely with the
// unconditional recorder.finalize() call later in this function.
function closeRuntimeContextOnAbort(signal, recorder) {
  if (!signal) return () => {};
  if (signal.aborted) {
    recorder.finalize();
    return () => {};
  }
  const onAbort = () => recorder.finalize();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// `serviceAdapters` (structuredStoreAdapter/documentStoreAdapter/
// evidenceStoreAdapter/retriever) is optional and passes straight through
// to createSharedServices — omit it and every store fails closed, same as
// calling createSharedServices with no adapters at all. `context.signal`
// (see SharedContext's typedef above), if provided, is the request-scoped
// deadline/client-disconnect AbortSignal: both Flow execution (the
// `flow.run()` race below) and every async SharedServices call (see
// createSharedServices' wrapAsync/wrapMaybeAsync wiring) race against the
// SAME signal, so aborting it closes the whole request from every angle at
// once, not just the one this function happens to be waiting on.
export async function runAgentFlow(flow, input, context, budgetLimits, serviceAdapters = {}) {
  const budget = createExecutionBudget(budgetLimits);
  const services = createSharedServices(budgetLimits, { ...serviceAdapters, context, budget });
  const recorder = getTraceRecorder(services);
  const signal = context?.signal;

  let finalResponseCandidate = {};
  let claimedSelectedEvidence = [];
  let fallbackReason = null;

  const detachAbortClose = closeRuntimeContextOnAbort(signal, recorder);

  try {
    // Checked explicitly, BEFORE anything else — including PolicyGuard's
    // own checkQuestion. Without this, an already-aborted signal would
    // still reach PolicyGuard's wrapper, which (via closeRuntimeContextOnAbort
    // having already finalized the recorder above) would itself reject as
    // RUNTIME_CONTEXT_CLOSED — a confusing, indirect way to learn the real
    // cause was an abort. This makes "the request was already aborted
    // before it started" its own clean, direct ABORTED:<reason>
    // classification instead of an accidental side effect of a DIFFERENT
    // boundary's own closed-context check.
    if (signal?.aborted) {
      throw new RequestAbortedError(abortReason(signal));
    }

    if (typeof input?.question !== "string") {
      const error = new RejectedInputError("AgentFlow", [fail("INVALID_SHAPE", "input.question must be a string")]);
      recordAgentFlowRejection(recorder, "validateInputShape", error);
      throw error;
    }

    const questionCheck = services.policyGuard.checkQuestion(input.question);
    if (!questionCheck.ok) {
      // Policy Guard rejected the question itself — the Flow never runs.
      // This is a code-driven safe rewrite, not the generic catch-all
      // fallback: the internal code goes only into fallback_reason below,
      // the user sees a fixed, code-specific template.
      fallbackReason = `REJECTED_INPUT:PolicyGuard:${questionCheck.code}`;
      finalResponseCandidate = { question: input.question, answer: policySafeAnswer(questionCheck.code) };
    } else {
      // Raced against `signal`, not just plainly awaited: a Flow that
      // hangs (whether inside an abandoned SharedServices call or in its
      // own code that never touches SharedServices at all) can never keep
      // this function waiting past abort. flow.run()'s own promise is
      // still fully observed by raceAgainstAbort even when it loses this
      // race, so an abandoned Flow that eventually settles late can never
      // produce an unhandledRejection or mutate anything this function
      // already returned.
      const outcome = await raceAgainstAbort(flow.run(input, context, services), signal);

      // The instant the Flow's own async function resolves, check for any
      // SharedServices call it fired but never awaited. This is a
      // synchronous check against whatever registerPending() left behind —
      // it does NOT wait for a pending call to settle (that call may never
      // settle at all), so a genuinely abandoned Promise can't hang the
      // request.
      const stillPending = recorder.pendingCalls();
      if (stillPending.length > 0) {
        const error = new RejectedInputError("AgentFlow", [
          fail(
            "UNAWAITED_SERVICE_CALL",
            `Flow returned with ${stillPending.length} SharedServices call(s) still pending: ${stillPending.map((p) => `${p.service}.${p.method}`).join(", ")}`,
          ),
        ]);
        recordAgentFlowRejection(recorder, "checkPendingServiceCalls", error);
        throw error;
      }

      const shapeErrors = validateAgentOutcomeShape(outcome);
      if (shapeErrors.length > 0) {
        const error = new RejectedInputError("AgentFlow", shapeErrors);
        recordAgentFlowRejection(recorder, "validateOutcomeShape", error);
        throw error;
      }

      // The Flow may narrow which already-verified evidence it actually
      // used (see the intersection computed below), but this claim is
      // never trusted on its own — see selectedEvidence.
      const outcomeTrace =
        outcome.execution_trace && typeof outcome.execution_trace === "object" ? outcome.execution_trace : {};
      claimedSelectedEvidence = safeArray(outcomeTrace.selected_evidence).filter((id) => typeof id === "string");

      const answerCheck = services.policyGuard.checkAnswer(outcome.final_response.answer);
      if (!answerCheck.ok) {
        // The Flow itself succeeded — evidence/facts may well be SUPPORTED.
        // Only the wording is unsafe, so this rewrites just `answer` and
        // keeps everything else the Flow produced (execution_mode,
        // retrieved_context, think_trace.validation, ...) instead of
        // collapsing the whole response into the generic EARLY_EXIT
        // fallback used for real failures.
        fallbackReason = `REJECTED_INPUT:PolicyGuard:${answerCheck.code}`;
        finalResponseCandidate = { ...outcome.final_response, answer: policySafeAnswer(answerCheck.code) };
      } else {
        finalResponseCandidate = outcome.final_response;
      }
    }
  } catch (error) {
    fallbackReason = classifyFailure(error);
    finalResponseCandidate = { question: typeof input?.question === "string" ? input.question : "" };
  } finally {
    detachAbortClose();
  }

  const finalResponse = services.serializer.serialize(finalResponseCandidate);
  const trace = recorder.snapshot();
  // selected_evidence is the INTERSECTION of what the Flow claims (above)
  // and the bare evidence_id of every validateEvidence call that actually
  // succeeded this request (captured via the onSuccess hook in
  // createSharedServices — never quoted_text or any other bundle field).
  // Verified is not the same as selected: the Flow may narrow a verified
  // set down to what it actually used, but claiming an evidence_id that
  // was never verified (or whose verification failed) can never add it —
  // and claiming operations/tool_calls/hcx_calls is not read at all, ever.
  // Order follows the Flow's claimed order; duplicates are collapsed.
  const verifiedEvidenceIds = new Set(
    trace.tool_calls
      .filter((entry) => entry.service === "Validator" && entry.method === "validateEvidence" && entry.ok === true)
      .map((entry) => entry.evidence_id)
      .filter((evidenceId) => typeof evidenceId === "string"),
  );
  const selectedEvidence = [...new Set(claimedSelectedEvidence.filter((id) => verifiedEvidenceIds.has(id)))];

  // Lock the recorder before returning: nothing after this point (in
  // particular, a stray late settlement of an abandoned call) may mutate
  // the trace object the caller is about to receive.
  recorder.finalize();

  return {
    final_response: finalResponse,
    execution_trace: {
      flow_id: typeof flow?.id === "string" ? flow.id : "unknown",
      execution_mode: finalResponse.think_trace.execution_mode,
      operations: trace.operations,
      tool_calls: trace.tool_calls,
      selected_evidence: selectedEvidence,
      hcx_calls: trace.hcx_calls,
      latency_ms: budget.elapsedMs(),
      fallback_reason: fallbackReason,
    },
  };
}
