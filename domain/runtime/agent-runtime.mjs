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
 * @property {string} [as_of_date]
 */

/**
 * @typedef {Object} SharedServices
 * @property {{validateEvidence: function(EvidenceBundle): Promise<ValidationResult>, validateFacts: function(CalculationInput[]): ValidationResult}} validator
 * @property {{calculate: function(CalculationRequest): CalculationResult}} calculator
 * @property {{explain: function(Object): Object}} hcxClient
 * @property {{serialize: function(Object): Object}} serializer
 * @property {ReturnType<typeof createExecutionBudget>} executionBudget
 * @property {{retrieve: function(Object): Object}} [retriever]
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
import { EXECUTION_ROUTES, VALUE_STATUSES } from "../contracts.mjs";
import { CITATION_CODES, createCitationValidator, createDocumentStore, createEvidenceStore } from "./citation-validator.mjs";
import { createFactProvenanceValidator, createFactStore, FACT_STORE_CODES } from "./fact-store.mjs";
import { createPolicyGuard, POLICY_GUARD_CODES, POLICY_GUARD_SAFE_ANSWERS } from "./policy-guard.mjs";
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
//      runtime module (CITATION_CODES, FACT_STORE_CODES, POLICY_GUARD_CODES).
//   2. ExecutionTrace.fallback_reason — runAgentFlow's own classification
//      of what it caught, not a RejectedInputError code by itself:
//      `REJECTED_INPUT:<service>:<code>` (code is always a member of
//      REJECTION_CODES), `BUDGET_EXCEEDED:<budgetName>`, the literal
//      string `INTERNAL_ERROR` for anything else, or `null` on success.
//      See classifyFailure.
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
]);

export const REJECTION_CODES = Object.freeze([
  ...new Set([...LOCAL_REJECTION_CODES, ...CITATION_CODES, ...FACT_STORE_CODES, ...POLICY_GUARD_CODES]),
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
  const units = new Set(request.inputs.map((input) => input.unit ?? null));
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
        return response;
      } catch {
        return structuredClone(SAFE_RESPONSE_FALLBACK);
      }
    },
  };
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
  const citationValidator = createCitationValidator(
    createDocumentStore(documentStoreAdapter ?? null, context),
    createEvidenceStore(evidenceStoreAdapter ?? null, context),
  );
  const factProvenanceValidator = createFactProvenanceValidator(createFactStore(factStoreAdapter ?? null, context));
  const services = {
    validator: createBudgetedValidator(createValidator(authority, citationValidator, factProvenanceValidator), budget),
    calculator: createBudgetedCalculator(createCalculator(authority), budget),
    hcxClient: createBudgetedHcxClient(createHcxClient(authority), budget),
    serializer: createSerializer(),
    executionBudget: budget,
    structuredStore: createBudgetedStructuredStore(createStructuredStore(structuredStoreAdapter ?? null, context), budget),
    // Deliberately NOT wrapped in createBudgetedXxx — see policy-guard.mjs's
    // header comment: a safety check must never become skippable just
    // because the execution budget ran out elsewhere.
    policyGuard: createPolicyGuard(),
  };
  if (retriever) services.retriever = createBudgetedRetriever(retriever, budget);
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
  return "INTERNAL_ERROR";
}

// The internal Policy Guard code is recorded ONLY via ExecutionTrace.fallback_reason
// (see classifyFailure) — this is the one place the user-facing `answer` text is
// derived from a policy code, and it always resolves to a fixed external template,
// never the raw code name or an internal message string.
function policySafeAnswer(code) {
  return POLICY_GUARD_SAFE_ANSWERS[code] ?? "요청을 처리할 수 없습니다.";
}

// `serviceAdapters` (structuredStoreAdapter/documentStoreAdapter/
// evidenceStoreAdapter/retriever) is optional and passes straight through
// to createSharedServices — omit it and every store fails closed, same as
// calling createSharedServices with no adapters at all.
export async function runAgentFlow(flow, input, context, budgetLimits, serviceAdapters = {}) {
  const budget = createExecutionBudget(budgetLimits);
  const services = createSharedServices(budgetLimits, { ...serviceAdapters, context, budget });

  let finalResponseCandidate = {};
  let traceExtras = {};
  let fallbackReason = null;

  try {
    if (typeof input?.question !== "string") {
      throw new RejectedInputError("AgentFlow", [fail("INVALID_SHAPE", "input.question must be a string")]);
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
      const outcome = await flow.run(input, context, services);
      const shapeErrors = validateAgentOutcomeShape(outcome);
      if (shapeErrors.length > 0) throw new RejectedInputError("AgentFlow", shapeErrors);

      traceExtras = outcome.execution_trace && typeof outcome.execution_trace === "object" ? outcome.execution_trace : {};

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
  }

  const finalResponse = services.serializer.serialize(finalResponseCandidate);
  return {
    final_response: finalResponse,
    execution_trace: {
      flow_id: typeof flow?.id === "string" ? flow.id : "unknown",
      execution_mode: finalResponse.think_trace.execution_mode,
      operations: safeArray(traceExtras.operations),
      tool_calls: safeArray(traceExtras.tool_calls),
      selected_evidence: safeArray(traceExtras.selected_evidence),
      hcx_calls: safeArray(traceExtras.hcx_calls),
      latency_ms: budget.elapsedMs(),
      fallback_reason: fallbackReason,
    },
  };
}
