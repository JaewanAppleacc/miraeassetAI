// Read-only StructuredStore adapter over one pinned Seed structured-artifact
// manifest. Construction verifies raw-byte hashes, sizes, record counts,
// official Fact/Event/Evidence/Coverage schemas, and cross-artifact IDs before
// exposing query(). Request-time work is in-memory filtering only.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RequestAbortedError, abortReason } from "../runtime/abortable.mjs";
import {
  validateEventRecord,
  validateEvidenceRecord,
  validateFactCoverageSnapshot,
  validateFactRecord,
} from "./seed-artifact-schema-validators.mjs";

const REQUIRED_ROLES = Object.freeze([
  "VERIFIED_EVIDENCE", "VERIFIED_EVIDENCE_MANIFEST", "VERIFIED_FACT", "VERIFIED_EVENT",
  "VERIFIED_RELATION", "FACT_COVERAGE_SNAPSHOT", "OWNER_DECISION",
]);
const RELATION_TYPES = new Set(["AMENDS", "TERMINATES", "CONFIRMS", "SAME_EVENT_AS"]);
const TARGET_ORDER = Object.freeze({ FACT: 0, EVENT: 1, RELATION: 2, EVIDENCE: 3 });

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
function strictUtf8(buffer, source) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`${source}: invalid UTF-8: ${error.message}`); }
}
function jsonl(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`${source}:${index + 1}: ${error.message}`); }
  });
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function schemaCheck(records, validator, label) {
  records.forEach((record, index) => {
    const errors = validator(record);
    if (errors.length) throw new Error(`${label}:${index + 1}: ${errors.join("; ")}`);
  });
}
function documentDate(documentId) {
  const match = /_(\d{4})(\d{2})(\d{2})\d{6}$/.exec(documentId ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
function atStartOfDay(date) { return date ? `${date}T00:00:00Z` : null; }
function dateValue(value) { const time = Date.parse(value ?? ""); return Number.isFinite(time) ? time : null; }
function intersects(recordStart, recordEnd, filterStart, filterEnd) {
  const rs = dateValue(recordStart) ?? Number.NEGATIVE_INFINITY;
  const re = dateValue(recordEnd) ?? rs;
  const fs = dateValue(filterStart) ?? Number.NEGATIVE_INFINITY;
  const fe = dateValue(filterEnd) ?? Number.POSITIVE_INFINITY;
  return rs <= fe && re >= fs;
}
function includesOrEmpty(values, candidate) { return values.length === 0 || values.includes(candidate); }

function relationShape(record, index) {
  const requiredStrings = ["relation_id", "relation_type", "source_document_id", "target_document_id", "chain_id"];
  if (requiredStrings.some((field) => typeof record?.[field] !== "string" || record[field] === "")) throw new Error(`Relation:${index + 1}: missing required identity`);
  if (!RELATION_TYPES.has(record.relation_type) || record.verification_status !== "VERIFIED") throw new Error(`Relation:${index + 1}: invalid type/status`);
}

function descriptor(type, raw, documentCorp) {
  if (type === "FACT") return {
    record_type: type, record_id: raw.fact_id, verification_status: raw.verification_status, known_at: raw.known_at,
    source_document_ids: [raw.source_document_id], evidence_ids: raw.evidence_ids, payload: raw,
    corp_code: raw.corp_code, metric_code: raw.metric_code, scope: raw.scope ?? "UNKNOWN", period_type: raw.period_type,
    period_start: raw.period_start ?? raw.as_of_date, period_end: raw.period_end ?? raw.as_of_date,
    valid_from: raw.valid_from, valid_to: raw.valid_to,
  };
  if (type === "EVENT") return {
    record_type: type, record_id: raw.event_id, verification_status: raw.verification_status, known_at: raw.known_at,
    source_document_ids: [raw.anchor_document_id], evidence_ids: raw.evidence_ids, payload: raw,
    corp_code: raw.corp_code, event_type: raw.event_type, scope: "COMPANY", period_type: "EVENT_PERIOD",
    period_start: raw.event_date, period_end: raw.event_date, valid_from: raw.valid_from, valid_to: raw.valid_to,
  };
  if (type === "RELATION") {
    const date = documentDate(raw.source_document_id);
    return {
      record_type: type, record_id: raw.relation_id, verification_status: raw.verification_status,
      known_at: atStartOfDay(date), source_document_ids: [raw.source_document_id, raw.target_document_id],
      evidence_ids: raw.evidence_id ? [raw.evidence_id] : [], payload: raw,
      corp_code: raw.attributes?.corp_code ?? documentCorp.get(raw.source_document_id), relation_type: raw.relation_type,
      scope: "COMPANY", period_type: "EVENT_PERIOD", period_start: date, period_end: date,
    };
  }
  const date = documentDate(raw.document_id);
  return {
    record_type: type, record_id: raw.evidence_id, verification_status: raw.verification_status,
    known_at: atStartOfDay(date), source_document_ids: [raw.document_id], evidence_ids: [raw.evidence_id], payload: raw,
    corp_code: raw.metadata?.corp_code ?? documentCorp.get(raw.document_id), scope: "COMPANY", period_type: "UNKNOWN",
    period_start: date, period_end: date,
  };
}

function matches(record, query) {
  if (!query.targets.includes(record.record_type)) return false;
  if (!query.verification_statuses.includes(record.verification_status)) return false;
  if (!includesOrEmpty(query.corp_codes, record.corp_code)) return false;
  if (!includesOrEmpty(query.scope_filter, record.scope)) return false;
  if (dateValue(record.known_at) > dateValue(`${query.as_of_date}T23:59:59.999Z`)) return false;
  if (record.valid_from && dateValue(record.valid_from) > dateValue(`${query.as_of_date}T23:59:59.999Z`)) return false;
  if (record.valid_to && dateValue(record.valid_to) < dateValue(`${query.as_of_date}T00:00:00Z`)) return false;
  if (!includesOrEmpty(query.period_filter.period_types, record.period_type)) return false;
  if (!intersects(record.period_start, record.period_end, query.period_filter.start, query.period_filter.end)) return false;

  const predicates = query.predicates;
  if (record.record_type === "FACT") {
    if (!includesOrEmpty(predicates.metric_codes, record.metric_code) || !includesOrEmpty(predicates.fact_ids, record.record_id)) return false;
  } else if (record.record_type === "EVENT") {
    if (!includesOrEmpty(predicates.event_types, record.event_type) || !includesOrEmpty(predicates.event_ids, record.record_id)) return false;
  } else if (record.record_type === "RELATION") {
    if (!includesOrEmpty(predicates.relation_types, record.relation_type) || !includesOrEmpty(predicates.relation_ids, record.record_id)) return false;
  } else if (!includesOrEmpty(predicates.evidence_ids, record.record_id)) return false;
  if (predicates.document_ids.length && !record.source_document_ids.some((id) => predicates.document_ids.includes(id))) return false;
  if (predicates.evidence_ids.length && !record.evidence_ids.some((id) => predicates.evidence_ids.includes(id))) return false;
  return true;
}

export async function createSeedStructuredQueryAdapter({ manifestPath, root = process.cwd() } = {}) {
  if (typeof manifestPath !== "string" || manifestPath === "") throw new Error("manifestPath is required");
  const manifestBuffer = await readFile(manifestPath);
  const manifest = JSON.parse(strictUtf8(manifestBuffer, manifestPath));
  if (manifest.status !== "VERIFIED_SEED_SUBSET" || typeof manifest.corpus_snapshot_id !== "string" || typeof manifest.fact_coverage_snapshot_id !== "string") {
    throw new Error(`${manifestPath}: not a pinned VERIFIED Seed subset manifest`);
  }
  const roleMap = new Map();
  for (const artifact of manifest.artifacts ?? []) {
    if (roleMap.has(artifact.role)) throw new Error(`${manifestPath}: duplicate role ${artifact.role}`);
    roleMap.set(artifact.role, structuredClone(artifact));
  }
  for (const role of REQUIRED_ROLES) if (!roleMap.has(role)) throw new Error(`${manifestPath}: missing role ${role}`);

  const loaded = new Map();
  await Promise.all(REQUIRED_ROLES.map(async (role) => {
    const pin = roleMap.get(role);
    if (!/^[0-9a-f]{64}$/.test(pin.sha256) || !Number.isInteger(pin.bytes) || (pin.record_count !== null && !Number.isInteger(pin.record_count))) throw new Error(`${manifestPath}: invalid pin for ${role}`);
    const artifactPath = path.resolve(root, pin.path);
    const buffer = await readFile(artifactPath);
    if (buffer.length !== pin.bytes || sha256(buffer) !== pin.sha256) throw new Error(`${artifactPath}: pin mismatch`);
    loaded.set(role, { pin, text: strictUtf8(buffer, artifactPath), artifactPath });
  }));

  const evidence = jsonl(loaded.get("VERIFIED_EVIDENCE").text, loaded.get("VERIFIED_EVIDENCE").artifactPath);
  const facts = jsonl(loaded.get("VERIFIED_FACT").text, loaded.get("VERIFIED_FACT").artifactPath);
  const events = jsonl(loaded.get("VERIFIED_EVENT").text, loaded.get("VERIFIED_EVENT").artifactPath);
  const relations = jsonl(loaded.get("VERIFIED_RELATION").text, loaded.get("VERIFIED_RELATION").artifactPath);
  const coverage = JSON.parse(loaded.get("FACT_COVERAGE_SNAPSHOT").text);
  for (const [role, records] of [["VERIFIED_EVIDENCE", evidence], ["VERIFIED_FACT", facts], ["VERIFIED_EVENT", events], ["VERIFIED_RELATION", relations]]) {
    if (records.length !== roleMap.get(role).record_count) throw new Error(`${role}: record count mismatch`);
  }
  schemaCheck(evidence, validateEvidenceRecord, "Evidence");
  schemaCheck(facts, validateFactRecord, "Fact");
  schemaCheck(events, validateEventRecord, "Event");
  relations.forEach(relationShape);
  const coverageErrors = validateFactCoverageSnapshot(coverage);
  if (coverageErrors.length) throw new Error(`Coverage: ${coverageErrors.join("; ")}`);
  if (coverage.corpus_snapshot_id !== manifest.corpus_snapshot_id || coverage.fact_coverage_snapshot_id !== manifest.fact_coverage_snapshot_id) throw new Error("manifest/Coverage snapshot mismatch");

  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const factIds = new Set(facts.map((item) => item.fact_id));
  const eventIds = new Set(events.map((item) => item.event_id));
  const relationIds = new Set(relations.map((item) => item.relation_id));
  if (evidenceIds.size !== evidence.length || factIds.size !== facts.length || eventIds.size !== events.length || relationIds.size !== relations.length) throw new Error("duplicate structured record ID");
  for (const fact of facts) if (fact.evidence_ids.some((id) => !evidenceIds.has(id)) || (fact.event_id && !eventIds.has(fact.event_id))) throw new Error(`${fact.fact_id}: unresolved cross-reference`);
  for (const event of events) if (event.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${event.event_id}: unresolved Evidence`);
  for (const relation of relations) if ((relation.evidence_id && !evidenceIds.has(relation.evidence_id)) || (relation.event_id && !eventIds.has(relation.event_id))) throw new Error(`${relation.relation_id}: unresolved cross-reference`);
  for (const slot of coverage.slots) if (slot.fact_ids.some((id) => !factIds.has(id)) || slot.evidence_ids.some((id) => !evidenceIds.has(id))) throw new Error(`${slot.slot_key}: unresolved cross-reference`);

  const documentCorp = new Map();
  function register(documentId, corpCode) {
    if (!documentId || !corpCode) return;
    const prior = documentCorp.get(documentId);
    if (prior && prior !== corpCode) throw new Error(`${documentId}: conflicting corp_code`);
    documentCorp.set(documentId, corpCode);
  }
  facts.forEach((item) => register(item.source_document_id, item.corp_code));
  events.forEach((item) => register(item.anchor_document_id, item.corp_code));
  relations.forEach((item) => { register(item.source_document_id, item.attributes?.corp_code); register(item.target_document_id, item.attributes?.corp_code); });

  const records = deepFreeze([
    ...facts.map((item) => descriptor("FACT", item, documentCorp)),
    ...events.map((item) => descriptor("EVENT", item, documentCorp)),
    ...relations.map((item) => descriptor("RELATION", item, documentCorp)),
    ...evidence.map((item) => descriptor("EVIDENCE", item, documentCorp)),
  ]);
  const corpusSnapshotId = manifest.corpus_snapshot_id;
  const coverageSnapshotId = manifest.fact_coverage_snapshot_id;

  return Object.freeze({
    async query(query, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      const selected = records.filter((record) => matches(record, query)).sort((a, b) => {
        const time = dateValue(b.known_at) - dateValue(a.known_at);
        return time || TARGET_ORDER[a.record_type] - TARGET_ORDER[b.record_type] || a.record_id.localeCompare(b.record_id);
      }).slice(0, query.limit).map((record) => deepFreeze(structuredClone({
        record_type: record.record_type, record_id: record.record_id, verification_status: record.verification_status,
        known_at: record.known_at, source_document_ids: record.source_document_ids,
        evidence_ids: record.evidence_ids, payload: record.payload,
      })));
      return deepFreeze({
        corpus_snapshot_id: corpusSnapshotId, fact_coverage_snapshot_id: coverageSnapshotId,
        status: selected.length ? "OK" : "NOT_FOUND", error_codes: [], records: selected,
      });
    },
    recordCounts() { return Object.freeze({ FACT: facts.length, EVENT: events.length, RELATION: relations.length, EVIDENCE: evidence.length }); },
  });
}
