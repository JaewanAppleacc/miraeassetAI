import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  createCitationValidator,
  createDocumentStore,
  createEvidenceStore,
} from "../domain/runtime/citation-validator.mjs";
import { createHcxClient, createValidationAuthority, createValidator, runAgentFlow } from "../domain/runtime/agent-runtime.mjs";
import { createCanonicalJsonlDocumentAdapter } from "../domain/adapters/a-document-ir-reader.mjs";

// End-to-end proof that DocumentStore/EvidenceStore/CitationValidator work
// against real corpus bytes, not just mocks — using the one real document
// A's adapter has actually materialized locally
// (work/a-document-ir/canonical.sample.jsonl, gitignored, machine-local).
// Skips cleanly when that data isn't present (see
// tests/a-document-ir-reader.test.mjs for why).
const SAMPLE_PATH = resolve("work/a-document-ir/canonical.sample.jsonl");
const HAS_SAMPLE = existsSync(SAMPLE_PATH);

const CONTEXT = { as_of_date: "2026-08-10", corpus_snapshot_id: "corpus_04750795e1a2d5c3", fact_coverage_snapshot_id: null };

// The real document, block, and cell this whole suite is grounded in —
// see the full record inspected from work/a-document-ir/canonical.sample.jsonl.
const REAL_DOCUMENT_ID = "exchange_20250728800035";
const REAL_FILE_ID = "file_8d20f187d7280deb3118bd23";
const REAL_LOCATOR = "exchange_20250728800035/20250728800035.xml#node=0";
const REAL_QUOTE = "22,764,764,160,000"; // 계약금액(원), a single real table cell

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// NOTE: this is a hand-built test double standing in for what a real
// B-reviewed VERIFIED Evidence record would look like — it is NOT actual
// human-reviewed Gold data (no such pipeline exists yet, see
// domain/HANDOFF.md: BLOCKED_BY_HUMAN_REVIEW). Its purpose here is only to
// prove the CitationValidator machinery genuinely works against a real
// quote/hash extracted from a real corpus document.
function realEvidenceBundle(overrides = {}) {
  return {
    evidence_id: "evidence_real_sample_0000000001",
    document_id: REAL_DOCUMENT_ID,
    file_id: REAL_FILE_ID,
    source_locator: REAL_LOCATOR,
    quoted_text: REAL_QUOTE,
    quote_sha256: sha256Hex(REAL_QUOTE),
    fact_ids: ["fact_real_sample_contract_amount"],
    scope: "COMPANY",
    period: "EVENT",
    value_status: "DISCLOSED",
    ...overrides,
  };
}

// Registers each given bundle as a VERIFIED EvidenceStore record whose own
// fields exactly mirror the bundle's claims — i.e. the human-review check
// always agrees with whatever bundle is being tested, so a check() result
// actually exercises the raw citation check against real DocumentIR bytes
// instead of stopping early at EVIDENCE_NOT_FOUND/EVIDENCE_QUOTE_MISMATCH.
function realEvidenceStore(...bundles) {
  const registered = bundles.length > 0 ? bundles : [realEvidenceBundle()];
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
  const adapter = {
    getEvidence: async (evidenceId) => {
      const record = records.get(evidenceId);
      return record ? { corpus_snapshot_id: CONTEXT.corpus_snapshot_id, record } : null;
    },
  };
  return createEvidenceStore(adapter, CONTEXT);
}

function realDocumentStore() {
  return createDocumentStore(createCanonicalJsonlDocumentAdapter(SAMPLE_PATH), CONTEXT);
}

test("CitationValidator confirms a real quote against real DocumentIR bytes end to end", { skip: !HAS_SAMPLE }, async () => {
  const validator = createCitationValidator(realDocumentStore(), realEvidenceStore());
  const result = await validator.check(realEvidenceBundle());
  assert.deepEqual(result, { ok: true });
});

test("CitationValidator rejects a fabricated quote that is not actually in the real document text", { skip: !HAS_SAMPLE }, async () => {
  const fabricated = realEvidenceBundle({
    evidence_id: "evidence_real_sample_fabricated_01",
    quoted_text: "이 금액은 실제 문서에 없다",
    quote_sha256: sha256Hex("이 금액은 실제 문서에 없다"),
  });
  // The EvidenceStore honestly agrees this is a VERIFIED record matching
  // the fabricated bundle's own claims — the human-review check alone
  // would pass. Only the raw citation check against the real DocumentIR
  // text can catch that this quote was never actually in the document.
  const validator = createCitationValidator(realDocumentStore(), realEvidenceStore(fabricated));
  const result = await validator.check(fabricated);
  assert.deepEqual(result, { ok: false, code: "QUOTE_MISMATCH" });
});

test("Validator.validateEvidence issues a real proof and HcxClient accepts it, grounded in real corpus bytes", { skip: !HAS_SAMPLE }, async () => {
  const authority = createValidationAuthority(CONTEXT);
  const citationValidator = createCitationValidator(realDocumentStore(), realEvidenceStore());
  const validator = createValidator(authority, citationValidator);
  const bundle = realEvidenceBundle();
  const proof = await validator.validateEvidence(bundle);
  assert.equal(proof.answerability, "SUPPORTED");
  const response = createHcxClient(authority).explain({ type: "EXPLAIN", evidenceBundle: bundle, validation: proof });
  assert.equal(response.accepted, true);
});

test("runAgentFlow end to end: a Flow citing the real document's real quote gets SUPPORTED evidence through SharedServices", { skip: !HAS_SAMPLE }, async () => {
  const documentAdapter = createCanonicalJsonlDocumentAdapter(SAMPLE_PATH);
  const evidenceAdapter = {
    getEvidence: async (evidenceId) => {
      const bundle = realEvidenceBundle();
      if (evidenceId !== bundle.evidence_id) return null;
      return {
        corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
        record: {
          evidence_id: bundle.evidence_id,
          document_id: bundle.document_id,
          file_id: bundle.file_id,
          source_locator: bundle.source_locator,
          quoted_text: bundle.quoted_text,
          quote_sha256: bundle.quote_sha256,
          verification_status: "VERIFIED",
        },
      };
    },
  };

  const flow = {
    id: "flow_real_data_demo",
    async run(input, context, services) {
      const bundle = realEvidenceBundle();
      const proof = await services.validator.validateEvidence(bundle);
      services.hcxClient.explain({ type: "EXPLAIN", evidenceBundle: bundle, validation: proof });
      return {
        final_response: {
          question: input.question,
          retrieved_context: [{ document_id: bundle.document_id, source_locator: bundle.source_locator }],
          think_trace: {
            execution_mode: "STRUCTURED",
            operations: ["VALIDATE_EVIDENCE", "EXPLAIN"],
            calculation: {},
            validation: { evidence_supported: proof.evidence_supported, answerability: proof.answerability },
          },
          answer: `계약금액은 ${bundle.quoted_text}원입니다.`,
        },
      };
    },
  };

  const outcome = await runAgentFlow(
    flow,
    { question: "이 계약의 금액은 얼마입니까?" },
    CONTEXT,
    { maxHcxCalls: 5, maxRetrievals: 5, maxToolCalls: 5, timeoutMs: 10_000 },
    { documentStoreAdapter: documentAdapter, evidenceStoreAdapter: evidenceAdapter },
  );

  assert.equal(outcome.execution_trace.fallback_reason, null);
  assert.equal(outcome.final_response.think_trace.execution_mode, "STRUCTURED");
  assert.match(outcome.final_response.answer, /22,764,764,160,000/);
  assert.doesNotThrow(() => JSON.stringify(outcome.final_response));
});
