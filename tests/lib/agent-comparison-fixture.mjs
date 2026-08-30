// Synthetic (non-production) fixture for domain/agent-comparison/ contract
// tests. Every id/value here is made up for this fixture only -- it is not
// derived from, and never asserted to match, any real Seed/production
// record. This is deliberately generic (no real company names/question
// text/answers) so it can validate the SHAPE of the contract, independent
// of any real corpus data.
import { createHash } from "node:crypto";

export const CORPUS_SNAPSHOT_ID = "corpus_synthetic_fixture_0001";
export const FACT_COVERAGE_SNAPSHOT_ID = "fact_coverage_snapshot_synthetic_fixture_0001";

const CORP_CODE = "00000001";
const DOCUMENT_ID = "periodic_00000000000001";
const FILE_ID = "file_000000000000000000000001";
const SOURCE_LOCATOR = `${DOCUMENT_ID}/${FILE_ID}#node=1`;
const QUOTED_TEXT = "매출액은 1,000,000,000원입니다.";

// A second company's Fact/Evidence that this request never queries for and
// never authorizes -- used by citation-binding tests to simulate a model
// claiming an id that was never part of THIS request's grounded set (Turn
// P1.1). Per domain/README.md, corp_code (not a name string) is this
// system's own company identity/join key -- a different corp_code is what
// "a different company" means in this codebase's own terms.
const UNAUTHORIZED_CORP_CODE = "00000002";
const UNAUTHORIZED_DOCUMENT_ID = "periodic_00000000000002";
const UNAUTHORIZED_FILE_ID = "file_000000000000000000000002";
const UNAUTHORIZED_SOURCE_LOCATOR = `${UNAUTHORIZED_DOCUMENT_ID}/${UNAUTHORIZED_FILE_ID}#node=1`;
const UNAUTHORIZED_QUOTED_TEXT = "매출액은 2,000,000,000원입니다.";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const FIXTURE_FACT = Object.freeze({
  fact_id: "fact_000000000000000000000001",
  corp_code: CORP_CODE,
  event_id: null,
  source_document_id: DOCUMENT_ID,
  metric_code: "REVENUE",
  raw_label: "매출액",
  value_type: "NUMERIC",
  value_status: "DISCLOSED",
  value_certainty: "CONFIRMED",
  raw_value_text: "1,000,000,000",
  raw_unit_text: "원",
  normalized_value: 1_000_000_000,
  unit: "KRW",
  currency: "KRW",
  scale: 1,
  scope: "CONSOLIDATED",
  period_type: "ANNUAL",
  period_start: "2025-01-01",
  period_end: "2025-12-31",
  as_of_date: "2025-12-31",
  known_at: "2026-01-01T00:00:00.000Z",
  valid_from: "2025-01-01",
  valid_to: null,
  withheld_until: null,
  extraction_method: "RULE",
  confidence: 1,
  verification_status: "VERIFIED",
  evidence_ids: ["evidence_000000000000000000000001"],
  attributes: {},
});

// No fact_ids field: matches the REAL semantic-bundle.schema.json Evidence
// $def, which carries no such back-reference -- the Fact side
// (FIXTURE_FACT.evidence_ids) is the only authoritative link, same as real
// production Evidence records. An earlier version of this fixture added a
// non-standard fact_ids field here, which masked a real bug in
// flows/structured-first-agent.mjs (it built selected_evidence from an
// Evidence->Fact back-reference that only ever existed in this fixture) --
// see that file's git history / IMPLEMENTATION_GUIDE.md for the lesson.
export const FIXTURE_EVIDENCE = Object.freeze({
  evidence_id: "evidence_000000000000000000000001",
  document_id: DOCUMENT_ID,
  file_id: FILE_ID,
  chunk_id: null,
  source_locator: SOURCE_LOCATOR,
  quoted_text: QUOTED_TEXT,
  quote_sha256: sha256Hex(QUOTED_TEXT),
  extraction_method: "RULE",
  confidence: 1,
  verification_status: "VERIFIED",
  metadata: {},
});

// Turn P1.1: a real, VERIFIED Fact/Evidence pair that is nonetheless
// UNAUTHORIZED for any query that only asks about CORP_CODE -- exists in
// the same backing store, but citation-binding must still reject a model
// citing it for a request that never queried/grounded it.
export const FIXTURE_UNAUTHORIZED_FACT = Object.freeze({
  ...FIXTURE_FACT,
  fact_id: "fact_000000000000000000000002",
  corp_code: UNAUTHORIZED_CORP_CODE,
  source_document_id: UNAUTHORIZED_DOCUMENT_ID,
  raw_value_text: "2,000,000,000",
  normalized_value: 2_000_000_000,
  evidence_ids: ["evidence_000000000000000000000002"],
});

export const FIXTURE_UNAUTHORIZED_EVIDENCE = Object.freeze({
  evidence_id: "evidence_000000000000000000000002",
  document_id: UNAUTHORIZED_DOCUMENT_ID,
  file_id: UNAUTHORIZED_FILE_ID,
  chunk_id: null,
  source_locator: UNAUTHORIZED_SOURCE_LOCATOR,
  quoted_text: UNAUTHORIZED_QUOTED_TEXT,
  quote_sha256: sha256Hex(UNAUTHORIZED_QUOTED_TEXT),
  extraction_method: "RULE",
  confidence: 1,
  verification_status: "VERIFIED",
  metadata: {},
});

function structuredRecord(recordType, recordId, verificationStatus, knownAt, sourceDocumentIds, evidenceIds, payload) {
  return { record_type: recordType, record_id: recordId, verification_status: verificationStatus, known_at: knownAt, source_document_ids: sourceDocumentIds, evidence_ids: evidenceIds, payload };
}

function matchesFilters(query, record) {
  if (query.corp_codes?.length > 0 && record.payload.corp_code && !query.corp_codes.includes(record.payload.corp_code)) return false;
  if (query.predicates.metric_codes?.length > 0 && record.payload.metric_code && !query.predicates.metric_codes.includes(record.payload.metric_code)) return false;
  if (query.predicates.fact_ids?.length > 0 && record.record_type === "FACT" && !query.predicates.fact_ids.includes(record.record_id)) return false;
  if (query.predicates.evidence_ids?.length > 0 && record.record_type === "EVIDENCE" && !query.predicates.evidence_ids.includes(record.record_id)) return false;
  if (query.predicates.event_ids?.length > 0 && record.record_type === "EVENT" && !query.predicates.event_ids.includes(record.record_id)) return false;
  if (query.predicates.document_ids?.length > 0 && !record.source_document_ids.some((id) => query.predicates.document_ids.includes(id))) return false;
  if (!query.verification_statuses.includes(record.verification_status)) return false;
  return true;
}

const DEFAULT_RECORDS = Object.freeze([
  structuredRecord("FACT", FIXTURE_FACT.fact_id, "VERIFIED", FIXTURE_FACT.known_at, [DOCUMENT_ID], FIXTURE_FACT.evidence_ids, FIXTURE_FACT),
  structuredRecord("EVIDENCE", FIXTURE_EVIDENCE.evidence_id, "VERIFIED", FIXTURE_FACT.known_at, [DOCUMENT_ID], [FIXTURE_EVIDENCE.evidence_id], FIXTURE_EVIDENCE),
  // Present in the backing store but never matched by a query scoped to
  // CORP_CODE -- exists so a citation-binding test can prove the Flow
  // rejects a model citing an id this request never authorized, without
  // needing a second live query to "discover" it.
  structuredRecord("FACT", FIXTURE_UNAUTHORIZED_FACT.fact_id, "VERIFIED", FIXTURE_UNAUTHORIZED_FACT.known_at, [UNAUTHORIZED_DOCUMENT_ID], FIXTURE_UNAUTHORIZED_FACT.evidence_ids, FIXTURE_UNAUTHORIZED_FACT),
  structuredRecord("EVIDENCE", FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id, "VERIFIED", FIXTURE_UNAUTHORIZED_FACT.known_at, [UNAUTHORIZED_DOCUMENT_ID], [FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id], FIXTURE_UNAUTHORIZED_EVIDENCE),
]);

// A minimal in-memory StructuredStore adapter implementing the same
// query()->StructuredResult contract domain/runtime/structured-store.mjs
// expects from any adapter (see that file's own header comment): this
// fixture only supplies `records`, never invents error_codes/status --
// createStructuredStore (the real, unmodified boundary) still re-validates
// everything this adapter returns.
export function createSyntheticStructuredStoreAdapter({ records = DEFAULT_RECORDS } = {}) {
  return {
    async query(query) {
      const matching = records.filter((record) => query.targets.includes(record.record_type) && matchesFilters(query, record));
      return {
        corpus_snapshot_id: query.corpus_snapshot_id,
        fact_coverage_snapshot_id: query.fact_coverage_snapshot_id,
        status: matching.length > 0 ? "OK" : "NOT_FOUND",
        error_codes: [],
        records: matching.slice(0, query.limit),
      };
    },
  };
}

export function createSyntheticDocumentStoreAdapter() {
  return {
    async getDocument(documentId) {
      if (documentId === DOCUMENT_ID) {
        return { document_id: DOCUMENT_ID, corpus_snapshot_id: CORPUS_SNAPSHOT_ID, blocks: [{ file_id: FILE_ID, source_locator: `${DOCUMENT_ID}/${FILE_ID}#node=1`, text: QUOTED_TEXT }] };
      }
      if (documentId === UNAUTHORIZED_DOCUMENT_ID) {
        return { document_id: UNAUTHORIZED_DOCUMENT_ID, corpus_snapshot_id: CORPUS_SNAPSHOT_ID, blocks: [{ file_id: UNAUTHORIZED_FILE_ID, source_locator: `${UNAUTHORIZED_DOCUMENT_ID}/${UNAUTHORIZED_FILE_ID}#node=1`, text: UNAUTHORIZED_QUOTED_TEXT }] };
      }
      return null;
    },
  };
}

export function createSyntheticEvidenceStoreAdapter() {
  return {
    async getEvidence(evidenceId) {
      if (evidenceId === FIXTURE_EVIDENCE.evidence_id) return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, record: FIXTURE_EVIDENCE };
      if (evidenceId === FIXTURE_UNAUTHORIZED_EVIDENCE.evidence_id) return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, record: FIXTURE_UNAUTHORIZED_EVIDENCE };
      return null;
    },
  };
}

export function syntheticContext(overrides = {}) {
  return { corpus_snapshot_id: CORPUS_SNAPSHOT_ID, fact_coverage_snapshot_id: FACT_COVERAGE_SNAPSHOT_ID, as_of_date: "2026-01-15", ...overrides };
}

export function syntheticServiceAdapters(overrides = {}) {
  return {
    structuredStoreAdapter: createSyntheticStructuredStoreAdapter(),
    documentStoreAdapter: createSyntheticDocumentStoreAdapter(),
    evidenceStoreAdapter: createSyntheticEvidenceStoreAdapter(),
    ...overrides,
  };
}
