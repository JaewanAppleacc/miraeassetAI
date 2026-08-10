import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCitationValidator, createDocumentStore, createEvidenceStore } from "../domain/runtime/citation-validator.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const CONTEXT = { corpus_snapshot_id: "corpus_04750795e1a2d5c3" };
const DOCUMENT_ID = "exchange_20250314800002";
const FILE_ID = "file_0123456789abcdef01234567";
const QUOTE = "1,000,000,000원";

// Auto-derives quote_sha256 = SHA256(quoted_text) unless the caller
// explicitly overrides it (including to null) — so every fixture is
// internally consistent by construction, and tests that want a genuinely
// WRONG hash still have to say so explicitly.
function withDerivedHash(fields) {
  if ("quote_sha256" in fields) return fields;
  return { ...fields, quote_sha256: typeof fields.quoted_text === "string" ? sha256Hex(fields.quoted_text) : undefined };
}

function documentIR(overrides = {}) {
  return {
    document_id: DOCUMENT_ID,
    corpus_snapshot_id: CONTEXT.corpus_snapshot_id,
    blocks: [
      { block_id: "block_1", file_id: FILE_ID, source_locator: "section.1.para.1", text: "본 계약의 목적은 공급계약이다." },
      { block_id: "block_2", file_id: FILE_ID, source_locator: "section.1.para.2", text: `계약금액은 ${QUOTE}이다.` },
      {
        block_id: "block_3",
        file_id: FILE_ID,
        source_locator: "section.2.table.1",
        text: null,
        table: { header_rows: [["항목", "금액"]], body_rows: [["계약금액", "1,000,000,000"], ["보증금", "100,000,000"]] },
      },
    ],
    ...overrides,
  };
}

function documentAdapterWith(...documents) {
  const byId = new Map(documents.map((doc) => [doc.document_id, doc]));
  return { getDocument: async (documentId) => byId.get(documentId) ?? null };
}

function evidenceRecord(overrides = {}) {
  return withDerivedHash({
    evidence_id: "evidence_0123456789abcdef01234567",
    document_id: DOCUMENT_ID,
    file_id: FILE_ID,
    source_locator: "section.1.para.2",
    quoted_text: QUOTE,
    verification_status: "VERIFIED",
    ...overrides,
  });
}

// Wraps each record in the snapshot envelope createEvidenceStore expects:
// { corpus_snapshot_id, record }. `snapshotId` lets a test simulate
// evidence reviewed against a different processing snapshot.
function evidenceAdapterWith(records, snapshotId = CONTEXT.corpus_snapshot_id) {
  const byId = new Map(records.map((record) => [record.evidence_id, { corpus_snapshot_id: snapshotId, record }]));
  return { getEvidence: async (evidenceId) => byId.get(evidenceId) ?? null };
}

function evidenceBundle(overrides = {}) {
  return withDerivedHash({
    evidence_id: "evidence_0123456789abcdef01234567",
    document_id: DOCUMENT_ID,
    file_id: FILE_ID,
    source_locator: "section.1.para.2",
    quoted_text: QUOTE,
    ...overrides,
  });
}

function newValidator({ documents = [documentIR()], evidenceRecords = [evidenceRecord()], evidenceSnapshotId } = {}) {
  const documentStore = createDocumentStore(documentAdapterWith(...documents), CONTEXT);
  const evidenceStore = createEvidenceStore(evidenceAdapterWith(evidenceRecords, evidenceSnapshotId), CONTEXT);
  return createCitationValidator(documentStore, evidenceStore);
}

// --- happy path ------------------------------------------------------------

test("a real quote with a genuinely VERIFIED stored evidence record resolves", async () => {
  const result = await newValidator().check(evidenceBundle());
  assert.deepEqual(result, { ok: true });
});

// --- 1. self-declared VERIFIED is never trusted -----------------------

test("a Flow claiming VERIFIED gets no say — verification_status is not even a request field, only the store's record counts", async () => {
  const bundle = { ...evidenceBundle(), verification_status: "VERIFIED" };
  const result = await newValidator({ evidenceRecords: [evidenceRecord({ verification_status: "CANDIDATE" })] }).check(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNVERIFIED_DATA_FORBIDDEN");
});

test("EvidenceStore not wired: the official VERIFIED path fails closed", async () => {
  const documentStore = createDocumentStore(documentAdapterWith(documentIR()), CONTEXT);
  const evidenceStore = createEvidenceStore(null, CONTEXT); // not wired
  const result = await createCitationValidator(documentStore, evidenceStore).check(evidenceBundle());
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_STORE_UNAVAILABLE" });
});

test("a CANDIDATE record in the EvidenceStore is rejected on the official path", async () => {
  const result = await newValidator({ evidenceRecords: [evidenceRecord({ verification_status: "CANDIDATE" })] }).check(
    evidenceBundle(),
  );
  assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
});

test("a REJECTED record in the EvidenceStore is rejected on the official path", async () => {
  const result = await newValidator({ evidenceRecords: [evidenceRecord({ verification_status: "REJECTED" })] }).check(
    evidenceBundle(),
  );
  assert.deepEqual(result, { ok: false, code: "UNVERIFIED_DATA_FORBIDDEN" });
});

test("a non-existent evidence_id is rejected as EVIDENCE_NOT_FOUND", async () => {
  const result = await newValidator().check(evidenceBundle({ evidence_id: "evidence_does_not_exist000000" }));
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_NOT_FOUND" });
});

// --- 2. EvidenceStore is bound to the corpus snapshot too -----------------

test("evidence reviewed against a different processing snapshot is rejected as EVIDENCE_SNAPSHOT_MISMATCH", async () => {
  const result = await newValidator({ evidenceSnapshotId: "corpus_some_older_snapshot" }).check(evidenceBundle());
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_SNAPSHOT_MISMATCH" });
});

// --- request bundle must match the stored record exactly ------------------

test("a request document_id different from the stored evidence's document_id is rejected", async () => {
  const result = await newValidator().check(evidenceBundle({ document_id: "exchange_99999999999999" }));
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_DOCUMENT_MISMATCH" });
});

test("a request source_locator different from the stored evidence's source_locator is rejected", async () => {
  const result = await newValidator().check(evidenceBundle({ source_locator: "section.9.para.9" }));
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_LOCATOR_MISMATCH" });
});

test("a request quoted_text different from the stored evidence's quoted_text is rejected", async () => {
  const result = await newValidator().check(evidenceBundle({ quoted_text: "다른 문장" }));
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_QUOTE_MISMATCH" });
});

// --- 3. quote_sha256 is a real SHA256 check, not a string compare ---------

test("a request quote_sha256 that is not the real SHA256 of quoted_text is rejected, even if it happens to equal the stored value", async () => {
  const fakeHash = "a".repeat(64);
  const result = await newValidator({ evidenceRecords: [evidenceRecord({ quote_sha256: fakeHash })] }).check(
    evidenceBundle({ quote_sha256: fakeHash }),
  );
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_HASH_MISMATCH" });
});

test("a request quote_sha256 different from the real SHA256 (and from the stored value) is rejected", async () => {
  const result = await newValidator().check(evidenceBundle({ quote_sha256: "b".repeat(64) }));
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_HASH_MISMATCH" });
});

test("a stored evidence record with no quote_sha256 cannot be used on the official path", async () => {
  const result = await newValidator({ evidenceRecords: [evidenceRecord({ quote_sha256: null })] }).check(evidenceBundle());
  assert.deepEqual(result, { ok: false, code: "EVIDENCE_HASH_MISMATCH" });
});

// --- raw citation check is independent and still enforced ------------------

test("even a fully VERIFIED, matching evidence record is rejected if the quote isn't actually in the corpus text", async () => {
  const tamperedDoc = documentIR();
  tamperedDoc.blocks[1].text = "이 문단에는 그 문장이 없다.";
  const result = await newValidator({ documents: [tamperedDoc] }).check(evidenceBundle());
  assert.deepEqual(result, { ok: false, code: "QUOTE_MISMATCH" });
});

test("DocumentStore not wired: even a VERIFIED evidence record is rejected (raw citation check still required)", async () => {
  const documentStore = createDocumentStore(null, CONTEXT);
  const evidenceStore = createEvidenceStore(evidenceAdapterWith([evidenceRecord()]), CONTEXT);
  const result = await createCitationValidator(documentStore, evidenceStore).check(evidenceBundle());
  assert.deepEqual(result, { ok: false, code: "DOCUMENT_STORE_UNAVAILABLE" });
});

test("a non-existent source_locator in the real DocumentIR is rejected as LOCATOR_NOT_FOUND", async () => {
  const evidenceRecords = [evidenceRecord({ source_locator: "section.9.para.9" })];
  const bundle = evidenceBundle({ source_locator: "section.9.para.9" });
  const result = await newValidator({ evidenceRecords }).check(bundle);
  assert.deepEqual(result, { ok: false, code: "LOCATOR_NOT_FOUND" });
});

test("evidence pointing at a document outside the pinned corpus snapshot is rejected as SNAPSHOT_MISMATCH", async () => {
  const result = await newValidator({ documents: [documentIR({ corpus_snapshot_id: "corpus_other_snapshot" })] }).check(
    evidenceBundle(),
  );
  assert.deepEqual(result, { ok: false, code: "SNAPSHOT_MISMATCH" });
});

// --- proof reuse across different evidence is a subject_hash concern, but
//     the CitationValidator itself must not treat two different evidence_ids as interchangeable

test("checking one evidence_id never accidentally confirms a different one — each check is independent", async () => {
  const recordA = evidenceRecord({ evidence_id: "evidence_aaaaaaaaaaaaaaaaaaaaaaaa" });
  const recordB = evidenceRecord({
    evidence_id: "evidence_bbbbbbbbbbbbbbbbbbbbbbbb",
    source_locator: "section.1.para.1",
    quoted_text: "공급계약",
  });
  const validator = newValidator({ evidenceRecords: [recordA, recordB] });
  const resultA = await validator.check(evidenceBundle({ evidence_id: recordA.evidence_id }));
  assert.equal(resultA.ok, true);
  const resultB = await validator.check(
    evidenceBundle({ evidence_id: recordB.evidence_id, source_locator: "section.1.para.1", quoted_text: "공급계약" }),
  );
  assert.equal(resultB.ok, true);
  const crossed = await validator.check(
    evidenceBundle({ evidence_id: recordA.evidence_id, source_locator: "section.1.para.1", quoted_text: "공급계약" }),
  );
  assert.equal(crossed.ok, false);
});

// --- table citations: per-cell only, never a cross-cell joined string -----

test("a quote entirely inside a single table cell passes", async () => {
  const evidenceRecords = [evidenceRecord({ source_locator: "section.2.table.1", quoted_text: "1,000,000,000" })];
  const bundle = evidenceBundle({ source_locator: "section.2.table.1", quoted_text: "1,000,000,000" });
  const result = await newValidator({ evidenceRecords }).check(bundle);
  assert.deepEqual(result, { ok: true });
});

test("a quote spanning across two different table cells is rejected, not accepted as a joined string", async () => {
  const evidenceRecords = [evidenceRecord({ source_locator: "section.2.table.1", quoted_text: "계약금액 1,000,000,000" })];
  const bundle = evidenceBundle({ source_locator: "section.2.table.1", quoted_text: "계약금액 1,000,000,000" });
  const result = await newValidator({ evidenceRecords }).check(bundle);
  assert.deepEqual(result, { ok: false, code: "QUOTE_MISMATCH" });
});

test("a quote spanning across two different table ROWS is rejected", async () => {
  const evidenceRecords = [evidenceRecord({ source_locator: "section.2.table.1", quoted_text: "1,000,000,000\" \"보증금" })];
  const bundle = evidenceBundle({ source_locator: "section.2.table.1", quoted_text: "1,000,000,000\" \"보증금" });
  const result = await newValidator({ evidenceRecords }).check(bundle);
  assert.deepEqual(result, { ok: false, code: "QUOTE_MISMATCH" });
});
