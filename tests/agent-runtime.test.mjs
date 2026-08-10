import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BudgetExceededError,
  createBudgetedCalculator,
  createBudgetedHcxClient,
  createBudgetedRetriever,
  createBudgetedValidator,
  createCalculator,
  createExecutionBudget,
  createHcxClient,
  createSerializer,
  createSharedServices,
  createValidationAuthority,
  createValidator,
  RejectedInputError,
  runAgentFlow,
  validateCalculationRequest,
} from "../domain/runtime/agent-runtime.mjs";
import { createCitationValidator, createDocumentStore, createEvidenceStore } from "../domain/runtime/citation-validator.mjs";

const AS_OF = "2026-08-10";
const CONTEXT = { as_of_date: AS_OF, corpus_snapshot_id: "snap_1", fact_coverage_snapshot_id: "cov_1" };

function fact(overrides = {}) {
  return {
    fact_id: "fact_1",
    value: 10,
    unit: "KRW",
    scope: "CONSOLIDATED",
    value_status: "DISCLOSED",
    ...overrides,
  };
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Field names mirror semantic-bundle.schema.json's Evidence $def. There is
// deliberately no verification_status field — a Flow cannot declare it; it
// is looked up from the (stubbed) EvidenceStore by evidence_id instead. See
// newCitationValidator below. quote_sha256 auto-derives to the real
// SHA256(quoted_text) unless explicitly overridden (including to a
// deliberately wrong value), so fixtures stay internally consistent.
function evidenceBundle(overrides = {}) {
  const fields = {
    evidence_id: "evidence_000000000000000000000001",
    document_id: "doc_1",
    file_id: "file_000000000000000000000001",
    source_locator: "section.1.para.2",
    quoted_text: "근거 문장",
    fact_ids: ["fact_1"],
    scope: "CONSOLIDATED",
    period: "2025Q4",
    value_status: "DISCLOSED",
    ...overrides,
  };
  if (!("quote_sha256" in overrides)) fields.quote_sha256 = sha256Hex(fields.quoted_text);
  return fields;
}

function newAuthority(context = CONTEXT) {
  return createValidationAuthority(context);
}

// A CitationValidator whose DocumentStore and EvidenceStore are both
// stubbed to genuinely confirm exactly the given bundle(s) — each bundle's
// own claimed document_id/file_id/source_locator/quoted_text/quote_sha256
// is registered as a real VERIFIED EvidenceStore record, and the
// DocumentStore is given a matching block so the raw citation check also
// passes. Tests in this file exercise proof mechanics (forgery, replay,
// budgets), not citation-matching precision — that's
// tests/citation-validator.test.mjs's job — so this stub trusts whatever
// bundle(s) it's told to register; it does not independently invent data.
function newCitationValidator(...bundles) {
  const registered = bundles.length > 0 ? bundles : [evidenceBundle()];
  const records = new Map(
    registered.map((bundle) => [
      bundle.evidence_id,
      {
        evidence_id: bundle.evidence_id,
        document_id: bundle.document_id,
        file_id: bundle.file_id,
        source_locator: bundle.source_locator,
        quoted_text: bundle.quoted_text,
        quote_sha256: bundle.quote_sha256,
        verification_status: "VERIFIED",
      },
    ]),
  );
  const documentAdapter = {
    getDocument: async (documentId) => ({
      document_id: documentId,
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      blocks: registered
        .filter((bundle) => bundle.document_id === documentId)
        .map((bundle, index) => ({
          block_id: `block_${index}`,
          file_id: bundle.file_id,
          source_locator: bundle.source_locator,
          text: `여기에 ${bundle.quoted_text}이 있다.`,
        })),
    }),
  };
  const evidenceAdapter = {
    getEvidence: async (evidenceId) => {
      const record = records.get(evidenceId);
      return record ? { corpus_snapshot_id: CONTEXT.corpus_snapshot_id, record } : null;
    },
  };
  return createCitationValidator(createDocumentStore(documentAdapter, CONTEXT), createEvidenceStore(evidenceAdapter, CONTEXT));
}

function validatedInputs(overrides = {}, authority = newAuthority()) {
  const inputs = [fact(overrides)];
  const validation = createValidator(authority).validateFacts(inputs);
  return { inputs, validation, authority };
}

// --- Validator only ever derives ValidationResult from real data ----------

test("Validator has no raw issuance entry point on its public API", () => {
  const validator = createValidator(newAuthority());
  assert.equal(typeof validator.issueValidationResult, "undefined");
  assert.equal(typeof validator.validateEvidence, "function");
  assert.equal(typeof validator.validateFacts, "function");
});

test("validateFacts issues a frozen, approved, content-bound proof carrying the authority's scope id", () => {
  const authority = newAuthority();
  const inputs = [fact()];
  const proof = createValidator(authority).validateFacts(inputs);
  assert.ok(authority.isApproved(proof));
  assert.ok(Object.isFrozen(proof));
  assert.equal(proof.proof_type, "FACTS");
  assert.equal(proof.answerability, "SUPPORTED");
  assert.equal(proof.validation_scope_id, authority.validationScopeId);
  assert.equal(typeof proof.subject_hash, "string");
});

test("validateFacts rejects a malformed fact set instead of trusting caller flags", () => {
  const validator = createValidator(newAuthority());
  assert.throws(
    () => validator.validateFacts([{ fact_id: "f", value: 1 }]), // missing value_status
    (error) => error instanceof RejectedInputError && error.code === "INVALID_SHAPE",
  );
});

test("validateFacts derives WITHHELD answerability from value_status, it cannot be asserted", () => {
  const proof = createValidator(newAuthority()).validateFacts([fact({ value_status: "WITHHELD" })]);
  assert.equal(proof.answerability, "WITHHELD");
});

test("validateFacts derives version_valid from as_of_date vs valid_from/valid_to", () => {
  const validator = createValidator(newAuthority());
  const expired = validator.validateFacts([fact({ valid_to: "2020-01-01" })]);
  assert.equal(expired.version_valid, false);
  assert.equal(expired.answerability, "UNANSWERABLE");

  const current = validator.validateFacts([fact({ fact_id: "fact_2", valid_from: "2020-01-01", valid_to: "2030-01-01" })]);
  assert.equal(current.version_valid, true);
});

test("validateEvidence issues a frozen, approved, content-bound EVIDENCE proof once citation is confirmed", async () => {
  const authority = newAuthority();
  const bundle = evidenceBundle();
  const proof = await createValidator(authority, newCitationValidator()).validateEvidence(bundle);
  assert.ok(authority.isApproved(proof));
  assert.equal(proof.proof_type, "EVIDENCE");
  assert.equal(proof.answerability, "SUPPORTED");
});

test("validateEvidence rejects a bundle missing required fields", async () => {
  const validator = createValidator(newAuthority(), newCitationValidator());
  await assert.rejects(
    () => validator.validateEvidence({ document_id: "doc_1" }),
    (error) => error instanceof RejectedInputError && error.code === "INVALID_SHAPE",
  );
});

test("validateEvidence rejects outright a bundle that supplies verification_status at all — it is not a silently-ignored field", async () => {
  const validator = createValidator(newAuthority(), newCitationValidator());
  await assert.rejects(
    () => validator.validateEvidence({ ...evidenceBundle(), verification_status: "VERIFIED" }),
    (error) => error instanceof RejectedInputError && error.code === "INVALID_SHAPE",
  );
});

test("validateEvidence rejects a Flow's evidence when the EvidenceStore's real record is CANDIDATE — only the store's own record counts", async () => {
  // The bundle itself makes no verification_status claim at all (it
  // can't). Prove the store's honest CANDIDATE record still blocks it,
  // even though the citation itself resolves perfectly.
  const bundle = evidenceBundle();
  const documentAdapter = {
    getDocument: async (documentId) => ({
      document_id: documentId,
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      blocks: [{ block_id: "b1", file_id: bundle.file_id, source_locator: bundle.source_locator, text: `여기에 ${bundle.quoted_text}이 있다.` }],
    }),
  };
  const evidenceAdapter = {
    getEvidence: async () => ({
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      record: {
        evidence_id: bundle.evidence_id,
        document_id: bundle.document_id,
        file_id: bundle.file_id,
        source_locator: bundle.source_locator,
        quoted_text: bundle.quoted_text,
        quote_sha256: bundle.quote_sha256,
        verification_status: "CANDIDATE", // the real, honest state of this record
      },
    }),
  };
  const citationValidator = createCitationValidator(
    createDocumentStore(documentAdapter, CONTEXT),
    createEvidenceStore(evidenceAdapter, CONTEXT),
  );
  const validator = createValidator(newAuthority(), citationValidator);
  await assert.rejects(
    () => validator.validateEvidence(bundle),
    (error) => error instanceof RejectedInputError && error.code === "UNVERIFIED_DATA_FORBIDDEN",
  );
});

test("validateEvidence fails closed with EVIDENCE_STORE_UNAVAILABLE when no CitationValidator is wired", async () => {
  const validator = createValidator(newAuthority()); // no citationValidator argument -> fully fail-closed default
  await assert.rejects(
    () => validator.validateEvidence(evidenceBundle()),
    (error) => error instanceof RejectedInputError && error.code === "EVIDENCE_STORE_UNAVAILABLE",
  );
});

test("validateEvidence rejects a citation that does not resolve in the real corpus text, it cannot bypass the raw citation check", async () => {
  const bundle = evidenceBundle({ quoted_text: "이 문장은 원문에 없다" });
  // EvidenceStore honestly agrees with the request (so the human-review
  // check alone would pass) — but the underlying DocumentIR text doesn't
  // actually contain it.
  const documentAdapter = {
    getDocument: async (documentId) => ({
      document_id: documentId,
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      blocks: [{ block_id: "b1", file_id: bundle.file_id, source_locator: bundle.source_locator, text: "이 문단은 전혀 다른 내용이다." }],
    }),
  };
  const evidenceAdapter = {
    getEvidence: async () => ({ corpus_snapshot_id: CONTEXT.corpus_snapshot_id, record: { ...bundle, verification_status: "VERIFIED" } }),
  };
  const citationValidator = createCitationValidator(
    createDocumentStore(documentAdapter, CONTEXT),
    createEvidenceStore(evidenceAdapter, CONTEXT),
  );
  const validator = createValidator(newAuthority(), citationValidator);
  await assert.rejects(
    () => validator.validateEvidence(bundle),
    (error) => error instanceof RejectedInputError && error.code === "QUOTE_MISMATCH",
  );
});

// --- Calculator: proof must be bound to this request's authority AND data -

test("Calculator rejects a hand-built object impersonating a ValidationResult", () => {
  const { inputs, authority } = validatedInputs();
  const calculator = createCalculator(authority);
  assert.throws(
    () =>
      calculator.calculate({
        formula: "SUM",
        inputs,
        validation: {
          proof_type: "FACTS",
          subject_hash: "x",
          validation_scope_id: authority.validationScopeId,
          answerability: "SUPPORTED",
          conflict_status: "NONE",
        },
      }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("Calculator accepts a proof-bound CalculationRequest from the same authority", () => {
  const { inputs, validation, authority } = validatedInputs({ value: 4 });
  const result = createCalculator(authority).calculate({ formula: "SUM", inputs, validation });
  assert.equal(result.result, 4);
});

test("Calculator rejects a proof issued for different fact data (no replay across a swapped value)", () => {
  const { inputs, validation, authority } = validatedInputs({ fact_id: "fact_1", value: 10 });
  const tampered = [{ ...inputs[0], value: 999999 }];
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "SUM", inputs: tampered, validation }),
    (error) => error instanceof RejectedInputError && error.code === "PROOF_SUBJECT_MISMATCH",
  );
});

test("Calculator rejects a proof issued for a different fact_id entirely", () => {
  const { validation, authority } = validatedInputs({ fact_id: "fact_real" });
  const otherInputs = [fact({ fact_id: "fact_fabricated" })];
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "SUM", inputs: otherInputs, validation }),
    (error) => error instanceof RejectedInputError && error.code === "PROOF_SUBJECT_MISMATCH",
  );
});

test("Calculator rejects a proof from a DIFFERENT ValidationAuthority, even with identical context and identical subject", () => {
  const authorityA = newAuthority(CONTEXT);
  const authorityB = newAuthority(CONTEXT); // same as_of_date, same snapshot ids
  const inputs = [fact()];
  const proofFromA = createValidator(authorityA).validateFacts(inputs);
  assert.throws(
    () => createCalculator(authorityB).calculate({ formula: "SUM", inputs, validation: proofFromA }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("Calculator rejects a proof whose answerability is not SUPPORTED", () => {
  const authority = newAuthority();
  const inputs = [fact({ value_status: "NOT_APPLICABLE" })];
  const validation = createValidator(authority).validateFacts(inputs);
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "SUM", inputs, validation }),
    (error) => error instanceof RejectedInputError && error.code === "UNSUPPORTED_ANSWERABILITY",
  );
});

test("Calculator rejects DIFF with the wrong arity", () => {
  const { inputs, validation, authority } = validatedInputs();
  const errors = validateCalculationRequest({ formula: "DIFF", inputs, validation }, authority);
  assert.ok(errors.some((message) => message.startsWith("INVALID_ARITY")));
});

test("Calculator computes DIFF for exactly two proof-bound inputs", () => {
  const authority = newAuthority();
  const inputs = [fact({ fact_id: "a", value: 10 }), fact({ fact_id: "b", value: 4 })];
  const validation = createValidator(authority).validateFacts(inputs);
  const result = createCalculator(authority).calculate({ formula: "DIFF", inputs, validation });
  assert.equal(result.result, 6);
});

test("Calculator rejects RATIO division by zero", () => {
  const authority = newAuthority();
  const inputs = [fact({ fact_id: "a", value: 10 }), fact({ fact_id: "b", value: 0 })];
  const validation = createValidator(authority).validateFacts(inputs);
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "RATIO", inputs, validation }),
    (error) => error instanceof RejectedInputError && error.code === "DIVISION_BY_ZERO",
  );
});

test("Calculator rejects mismatched units even when only one input carries a unit", () => {
  const authority = newAuthority();
  const inputs = [fact({ fact_id: "a", unit: "KRW" }), fact({ fact_id: "b", unit: undefined })];
  const validation = createValidator(authority).validateFacts(inputs);
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "SUM", inputs, validation }),
    (error) => error instanceof RejectedInputError && error.code === "UNIT_MISMATCH",
  );
});

test("Calculator rejects mismatched scope even when only one input carries a scope", () => {
  const authority = newAuthority();
  const inputs = [fact({ fact_id: "a", scope: "CONSOLIDATED" }), fact({ fact_id: "b", scope: undefined })];
  const validation = createValidator(authority).validateFacts(inputs);
  assert.throws(
    () => createCalculator(authority).calculate({ formula: "SUM", inputs, validation }),
    (error) => error instanceof RejectedInputError && error.code === "SCOPE_MISMATCH",
  );
});

// --- HCX Client: only a proof-bound explanation or a safe early exit ------

test("HcxClient rejects a hand-built object impersonating a ValidationResult", () => {
  const authority = newAuthority();
  const bundle = evidenceBundle();
  assert.throws(
    () =>
      createHcxClient(authority).explain({
        type: "EXPLAIN",
        evidenceBundle: bundle,
        validation: { proof_type: "EVIDENCE", subject_hash: "x", answerability: "SUPPORTED", conflict_status: "NONE" },
      }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("HcxClient accepts a proof-bound EXPLAIN request once the evidence's citation is confirmed", async () => {
  const authority = newAuthority();
  const bundle = evidenceBundle();
  const validation = await createValidator(authority, newCitationValidator()).validateEvidence(bundle);
  const response = createHcxClient(authority).explain({ type: "EXPLAIN", evidenceBundle: bundle, validation });
  assert.equal(response.accepted, true);
});

test("HcxClient rejects a proof issued for a different EvidenceBundle (no replay)", async () => {
  const authority = newAuthority();
  const realBundle = evidenceBundle({ document_id: "doc_real" });
  const validation = await createValidator(authority, newCitationValidator(realBundle)).validateEvidence(realBundle);
  const fabricated = evidenceBundle({ document_id: "doc_fabricated" });
  assert.throws(
    () => createHcxClient(authority).explain({ type: "EXPLAIN", evidenceBundle: fabricated, validation }),
    (error) => error instanceof RejectedInputError && error.code === "PROOF_SUBJECT_MISMATCH",
  );
});

test("HcxClient rejects a proof issued for one locator of a document reused against a different locator of the SAME document (different Evidence, no reuse)", async () => {
  const authority = newAuthority();
  const bundleA = evidenceBundle({
    evidence_id: "evidence_00000000000000000000000a",
    source_locator: "section.1.para.1",
    quoted_text: "첫 번째 문단",
  });
  const bundleB = evidenceBundle({
    evidence_id: "evidence_00000000000000000000000b",
    source_locator: "section.1.para.2",
    quoted_text: "두 번째 문단",
  });
  const validator = createValidator(authority, newCitationValidator(bundleA, bundleB));
  const proofForA = await validator.validateEvidence(bundleA);
  assert.throws(
    () => createHcxClient(authority).explain({ type: "EXPLAIN", evidenceBundle: bundleB, validation: proofForA }),
    (error) => error instanceof RejectedInputError && error.code === "PROOF_SUBJECT_MISMATCH",
  );
});

test("HcxClient rejects a proof from a different ValidationAuthority sharing identical context", async () => {
  const authorityA = newAuthority(CONTEXT);
  const authorityB = newAuthority(CONTEXT);
  const bundle = evidenceBundle();
  const proofFromA = await createValidator(authorityA, newCitationValidator()).validateEvidence(bundle);
  assert.throws(
    () => createHcxClient(authorityB).explain({ type: "EXPLAIN", evidenceBundle: bundle, validation: proofFromA }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("HcxClient still rejects a Flow's self-built 'confirmed' proof even with a real CitationValidator wired (Validator cannot be bypassed)", () => {
  const authority = newAuthority();
  createValidator(authority, newCitationValidator()); // a real, working Validator exists in this scope
  const bundle = evidenceBundle();
  const selfIssued = {
    proof_type: "EVIDENCE",
    subject_hash: "whatever-the-flow-computes",
    validation_scope_id: authority.validationScopeId,
    evidence_supported: true,
    version_valid: true,
    dimension_comparison: "CONSISTENT",
    conflict_status: "NONE",
    answerability: "SUPPORTED",
  };
  assert.throws(
    () => createHcxClient(authority).explain({ type: "EXPLAIN", evidenceBundle: bundle, validation: selfIssued }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("HcxClient accepts a safe EARLY_EXIT request without evidence", () => {
  const response = createHcxClient(newAuthority()).explain({ type: "EARLY_EXIT", reason: "NOT_FOUND" });
  assert.equal(response.accepted, true);
});

test("HcxClient rejects an unknown request type", () => {
  assert.throws(() => createHcxClient(newAuthority()).explain({ type: "FREEFORM" }), RejectedInputError);
});

// --- Budget consumption is baked into the service, not left to the caller -

test("a budgeted HCX client throws before delegating once its cap is spent, and never calls the raw client again", () => {
  let calls = 0;
  const rawClient = { explain: () => (calls += 1) && { accepted: true } };
  const budget = createExecutionBudget({ maxHcxCalls: 1, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 });
  const budgeted = createBudgetedHcxClient(rawClient, budget);

  budgeted.explain({ type: "EARLY_EXIT", reason: "x" });
  assert.equal(calls, 1);
  assert.throws(() => budgeted.explain({ type: "EARLY_EXIT", reason: "x" }), BudgetExceededError);
  assert.equal(calls, 1, "raw client must not be called once the budget is spent");
});

test("a budgeted calculator consumes a tool call before delegating", () => {
  const budget = createExecutionBudget({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 1, timeoutMs: 10_000 });
  const { inputs, validation, authority } = validatedInputs();
  const budgeted = createBudgetedCalculator(createCalculator(authority), budget);
  budgeted.calculate({ formula: "SUM", inputs, validation });
  assert.throws(() => budgeted.calculate({ formula: "SUM", inputs, validation }), BudgetExceededError);
});

test("a budgeted retriever consumes a retrieval before delegating", () => {
  let calls = 0;
  const rawRetriever = { retrieve: () => (calls += 1) && { results: [] } };
  const budget = createExecutionBudget({ maxHcxCalls: 5, maxRetrievals: 1, maxToolCalls: 5, timeoutMs: 10_000 });
  const budgeted = createBudgetedRetriever(rawRetriever, budget);
  budgeted.retrieve({ query: "q" });
  assert.throws(() => budgeted.retrieve({ query: "q" }), BudgetExceededError);
  assert.equal(calls, 1);
});

test("a budgeted validator consumes a tool call before delegating", () => {
  const budget = createExecutionBudget({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 1, timeoutMs: 10_000 });
  const budgeted = createBudgetedValidator(createValidator(newAuthority()), budget);
  budgeted.validateFacts([fact()]);
  assert.throws(() => budgeted.validateFacts([fact()]), BudgetExceededError);
});

test("ExecutionBudget.checkTimeout uses its own clock, not the caller's", () => {
  let now = 0;
  const budget = createExecutionBudget({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 5, now: () => now });
  assert.doesNotThrow(() => budget.checkTimeout());
  now = 100;
  assert.throws(() => budget.checkTimeout(), BudgetExceededError);
  assert.equal(budget.elapsedMs(), 100);
});

test("createSharedServices wires a fresh ValidationAuthority and only budgeted clients", () => {
  const services = createSharedServices(
    { maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 },
    { context: CONTEXT },
  );
  const inputs = [fact()];
  const validation = services.validator.validateFacts(inputs);
  const result = services.calculator.calculate({ formula: "SUM", inputs, validation });
  assert.equal(result.result, 10);

  const limited = createSharedServices({ maxHcxCalls: 1, maxRetrievals: 1, maxToolCalls: 1, timeoutMs: 10_000 });
  limited.hcxClient.explain({ type: "EARLY_EXIT", reason: "x" });
  assert.throws(() => limited.hcxClient.explain({ type: "EARLY_EXIT", reason: "x" }), BudgetExceededError);
});

test("two createSharedServices calls with identical context mint unusable-across-each-other proofs", () => {
  const services1 = createSharedServices({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 }, { context: CONTEXT });
  const services2 = createSharedServices({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 }, { context: CONTEXT });
  const inputs = [fact()];
  const proofFrom1 = services1.validator.validateFacts(inputs);
  assert.throws(
    () => services2.calculator.calculate({ formula: "SUM", inputs, validation: proofFrom1 }),
    (error) => error instanceof RejectedInputError && error.code === "UNTRUSTED_VALIDATION",
  );
});

test("createSharedServices wires a fail-closed structuredStore by default", async () => {
  const services = createSharedServices({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 }, { context: CONTEXT });
  const result = await services.structuredStore.query({
    schema_version: "0.2.0",
    query_id: "query_x",
    execution_scope: "OFFICIAL",
    corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
    fact_coverage_snapshot_id: CONTEXT.fact_coverage_snapshot_id,
    targets: ["FACT"],
    corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [],
    verification_statuses: ["VERIFIED"],
    as_of_date: AS_OF,
    limit: 10,
  });
  assert.equal(result.status, "ERROR");
  assert.deepEqual(result.error_codes, ["STORE_UNAVAILABLE"]);
});

test("createSharedServices wires a fail-closed validator.validateEvidence by default (no store adapters)", async () => {
  const services = createSharedServices({ maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 }, { context: CONTEXT });
  await assert.rejects(
    () => services.validator.validateEvidence(evidenceBundle()),
    (error) => error instanceof RejectedInputError && error.code === "EVIDENCE_STORE_UNAVAILABLE",
  );
});

test("createSharedServices still fails closed with only a documentStoreAdapter (no evidenceStoreAdapter — human review still required)", async () => {
  const documentAdapter = {
    getDocument: async (documentId) => ({
      document_id: documentId,
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      blocks: [{ block_id: "b1", file_id: "file_000000000000000000000001", source_locator: "section.1.para.2", text: "여기에 근거 문장이 있다." }],
    }),
  };
  const services = createSharedServices(
    { maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 },
    { context: CONTEXT, documentStoreAdapter: documentAdapter },
  );
  await assert.rejects(
    () => services.validator.validateEvidence(evidenceBundle()),
    (error) => error instanceof RejectedInputError && error.code === "EVIDENCE_STORE_UNAVAILABLE",
  );
});

test("createSharedServices wires a working validator.validateEvidence once BOTH documentStoreAdapter and evidenceStoreAdapter are supplied", async () => {
  const bundle = evidenceBundle();
  const documentAdapter = {
    getDocument: async (documentId) => ({
      document_id: documentId,
      corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
      blocks: [{ block_id: "b1", file_id: bundle.file_id, source_locator: bundle.source_locator, text: `여기에 ${bundle.quoted_text}이 있다.` }],
    }),
  };
  const evidenceAdapter = {
    getEvidence: async () => ({ corpus_snapshot_id: CONTEXT.corpus_snapshot_id, record: { ...bundle, verification_status: "VERIFIED" } }),
  };
  const services = createSharedServices(
    { maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 },
    { context: CONTEXT, documentStoreAdapter: documentAdapter, evidenceStoreAdapter: evidenceAdapter },
  );
  const proof = await services.validator.validateEvidence(bundle);
  assert.equal(proof.answerability, "SUPPORTED");
});

// --- Serializer is actually JSON-safe, not just shape-shaped --------------

test("Serializer breaks circular references instead of throwing", () => {
  const serializer = createSerializer();
  const cycle = {};
  cycle.self = cycle;
  const response = serializer.serialize({ question: "q", answer: "a", think_trace: { calculation: cycle } });
  assert.doesNotThrow(() => JSON.stringify(response));
  assert.equal(response.think_trace.calculation.self, "[Circular]");
});

test("Serializer converts BigInt to a string instead of throwing", () => {
  const serializer = createSerializer();
  const response = serializer.serialize({
    question: "q",
    answer: "a",
    think_trace: { calculation: { value: 10n } },
  });
  assert.doesNotThrow(() => JSON.stringify(response));
  assert.equal(response.think_trace.calculation.value, "10");
});

test("Serializer drops functions and symbols and turns NaN/Infinity into null", () => {
  const serializer = createSerializer();
  const response = serializer.serialize({
    question: "q",
    answer: "a",
    think_trace: { calculation: { fn: () => 1, sym: Symbol("x"), bad: NaN, worse: Infinity, ok: 1 } },
  });
  assert.equal(response.think_trace.calculation.fn, undefined);
  assert.equal(response.think_trace.calculation.sym, undefined);
  assert.equal(response.think_trace.calculation.bad, null);
  assert.equal(response.think_trace.calculation.worse, null);
  assert.equal(response.think_trace.calculation.ok, 1);
});

test("Serializer turns Error objects into plain data", () => {
  const serializer = createSerializer();
  const response = serializer.serialize({
    question: "q",
    answer: "a",
    think_trace: { validation: { cause: new Error("boom") } },
  });
  assert.equal(response.think_trace.validation.cause.message, "boom");
  assert.doesNotThrow(() => JSON.stringify(response));
});

test("Serializer never throws and always returns the required top-level shape for malformed input", () => {
  const serializer = createSerializer();
  for (const candidate of [null, undefined, {}, "not an object", 42, { question: 5 }]) {
    const response = serializer.serialize(candidate);
    assert.equal(typeof response.question, "string");
    assert.ok(Array.isArray(response.retrieved_context));
    assert.equal(typeof response.answer, "string");
    assert.ok(Array.isArray(response.think_trace.operations));
    assert.equal(response.think_trace.execution_mode, "EARLY_EXIT");
    assert.doesNotThrow(() => JSON.stringify(response));
  }
});

test("Serializer forces EARLY_EXIT when execution_mode is not a recognized route", () => {
  const serializer = createSerializer();
  const response = serializer.serialize({ question: "q", answer: "a", think_trace: { execution_mode: "MADE_UP_MODE" } });
  assert.equal(response.think_trace.execution_mode, "EARLY_EXIT");
});

// --- Runtime Host: no failure inside a Flow may escape as a thrown exception

const BUDGET_LIMITS = { maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 };

test("runAgentFlow passes through a well-formed AgentOutcome", async () => {
  const flow = {
    id: "flow_a",
    async run() {
      return {
        final_response: {
          question: "q",
          retrieved_context: [],
          think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
          answer: "a",
        },
      };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.equal(outcome.final_response.answer, "a");
  assert.equal(outcome.execution_trace.execution_mode, "STRUCTURED");
  assert.equal(outcome.execution_trace.fallback_reason, null);
});

test("runAgentFlow rejects a Flow that tries to smuggle a forged proof into the Calculator", async () => {
  const flow = {
    id: "flow_evil",
    async run(input, context, services) {
      services.calculator.calculate({
        formula: "SUM",
        inputs: [fact()],
        validation: {
          proof_type: "FACTS",
          subject_hash: "not-real",
          evidence_supported: true,
          conflict_status: "NONE",
          answerability: "SUPPORTED",
        },
      });
      return { final_response: {} };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.match(outcome.execution_trace.fallback_reason, /^REJECTED_INPUT:Calculator/);
});

test("runAgentFlow safely rejects a Flow that tries to explain unverified evidence (no EvidenceStore/DocumentStore wired) and still returns valid JSON", async () => {
  const flow = {
    id: "flow_ungrounded",
    async run(input, context, services) {
      const proof = await services.validator.validateEvidence(evidenceBundle());
      services.hcxClient.explain({ type: "EXPLAIN", evidenceBundle: evidenceBundle(), validation: proof });
      return { final_response: {} };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.equal(outcome.final_response.think_trace.execution_mode, "EARLY_EXIT");
  assert.match(outcome.execution_trace.fallback_reason, /^REJECTED_INPUT:Validator:EVIDENCE_STORE_UNAVAILABLE/);
  assert.doesNotThrow(() => JSON.stringify(outcome.final_response));
});

test("runAgentFlow rejects a Flow that reuses a real proof against a different fact_id (proof theft)", async () => {
  const flow = {
    id: "flow_thief",
    async run(input, context, services) {
      const realInputs = [fact({ fact_id: "fact_real" })];
      const realProof = services.validator.validateFacts(realInputs);
      services.calculator.calculate({
        formula: "SUM",
        inputs: [fact({ fact_id: "fact_fabricated", value: 999999 })],
        validation: realProof,
      });
      return { final_response: {} };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, { as_of_date: AS_OF }, BUDGET_LIMITS);
  assert.match(outcome.execution_trace.fallback_reason, /^REJECTED_INPUT:Calculator/);
});

test("runAgentFlow: a proof issued in one call cannot be reused in a later call, even with identical context", async () => {
  let stolenProof = null;
  const flowA = {
    id: "flow_a",
    async run(input, context, services) {
      stolenProof = services.validator.validateFacts([fact()]);
      return { final_response: { question: "q", answer: "ok" } };
    },
  };
  const outcomeA = await runAgentFlow(flowA, { question: "q" }, CONTEXT, BUDGET_LIMITS);
  assert.equal(outcomeA.execution_trace.fallback_reason, null);
  assert.ok(stolenProof);

  const flowB = {
    id: "flow_b",
    async run(input, ctx, services) {
      services.calculator.calculate({ formula: "SUM", inputs: [fact()], validation: stolenProof });
      return { final_response: {} };
    },
  };
  const outcomeB = await runAgentFlow(flowB, { question: "q" }, CONTEXT, BUDGET_LIMITS);
  assert.match(outcomeB.execution_trace.fallback_reason, /^REJECTED_INPUT:Calculator/);
});

test("runAgentFlow catches budget exhaustion from inside the flow", async () => {
  const flow = {
    id: "flow_greedy",
    async run(input, context, services) {
      for (let i = 0; i < 10; i += 1) services.hcxClient.explain({ type: "EARLY_EXIT", reason: "x" });
      return { final_response: {} };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, { ...BUDGET_LIMITS, maxHcxCalls: 2 });
  assert.match(outcome.execution_trace.fallback_reason, /^BUDGET_EXCEEDED/);
});

test("runAgentFlow catches an arbitrary thrown error without leaking it to the caller", async () => {
  const flow = { id: "flow_broken", async run() { throw new Error("boom"); } };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.equal(outcome.execution_trace.fallback_reason, "INTERNAL_ERROR");
  assert.doesNotThrow(() => JSON.stringify(outcome.final_response));
});

test("runAgentFlow rejects a malformed AgentOutcome instead of trusting it blindly", async () => {
  const flow = { id: "flow_lying", async run() { return "not an outcome"; } };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.match(outcome.execution_trace.fallback_reason, /^REJECTED_INPUT:AgentFlow/);
});

test("runAgentFlow always reports non-negative latency", async () => {
  const flow = { id: "flow_a", async run() { return { final_response: { question: "q", answer: "a" } }; } };
  const outcome = await runAgentFlow(flow, { question: "q" }, {}, BUDGET_LIMITS);
  assert.ok(outcome.execution_trace.latency_ms >= 0);
});

test("runAgentFlow threads context.as_of_date into the Validator so a Flow cannot pick a favorable date", async () => {
  const flow = {
    id: "flow_dater",
    async run(input, context, services) {
      const inputs = [fact({ valid_to: "2020-01-01" })];
      const proof = services.validator.validateFacts(inputs);
      const result = services.calculator.calculate({ formula: "SUM", inputs, validation: proof });
      return { final_response: { question: "q", answer: String(result.result) } };
    },
  };
  const outcome = await runAgentFlow(flow, { question: "q" }, { as_of_date: "2026-08-10" }, BUDGET_LIMITS);
  assert.match(outcome.execution_trace.fallback_reason, /^REJECTED_INPUT:Calculator/);
});
