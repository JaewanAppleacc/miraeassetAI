import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveWithinBase } from "../adapters/bundle-manifest-path-safety.mjs";

const JSONL_ROLE_KEYS = Object.freeze({
  CANONICAL_DOCUMENT_IR_BASE: "document_id",
  CANONICAL_DOCUMENT_IR_DELTA: "document_id",
  CHAIN_MANIFEST: "chain_id",
  COMPANY_DIRECTORY: "corp_code",
  VERIFIED_EVENT: "event_id",
  VERIFIED_EVIDENCE: "evidence_id",
  VERIFIED_FACT: "fact_id",
  SEED_GOLD: "question_id",
  VERIFIED_RELATION: "relation_id",
  OWNER_DECISION: "review_item_id",
  OWNER_BATCH_DECISION: "review_item_id",
  THIN_PLAN: "question_id",
});

const ARRAY_ROLE_CONFIG = Object.freeze({
  FACT_COVERAGE_SNAPSHOT: Object.freeze({ arrayField: "slots", keyField: "slot_key" }),
});

export const REFERENCE_DATA_ROLES = Object.freeze(Object.keys(JSONL_ROLE_KEYS));

// Turn N1.2: real PostgreSQL 16 execution reproduced a genuine defect --
// COMPANY_DIRECTORY_OWNER_DECISION's real bundle-manifest.json entry
// declares record_count: 70 (the Owner decision's OWN meaning: it
// approves 70 Company Directory records), but this role is a single
// control JSON object (not JSONL, not in ARRAY_ROLE_CONFIG), so
// collectReferenceReleaseRecords always emits exactly ONE record for it
// -- "70" here was never a row-count contract for THIS artifact's own DB
// representation. Every other control-shaped role's real record_count is
// null, so this went unnoticed until the Turn N1.1 SQL trigger started
// verifying declared_record_count against loaded_record_count for every
// non-null value. MULTI_RECORD_ROLES is the closed set of roles whose
// bundle-manifest record_count genuinely IS a row-count contract for the
// rows this loader creates (every JSONL_ROLE_KEYS / ARRAY_ROLE_CONFIG
// role); the loader uses this to decide whether an entry's record_count
// is even eligible to become artifacts.declared_record_count, never
// widening what gets written into the DB (frozen ARRAY, not
// Object.freeze(new Set(...)) -- see seed-release-bundle-unpack.mjs's
// KNOWN_BUNDLE_ROLES_BY_SCHEMA_VERSION for why a frozen Set is not
// actually immutable; callers build their own local Set from this array).
export const MULTI_RECORD_ROLES = Object.freeze([...Object.keys(JSONL_ROLE_KEYS), ...Object.keys(ARRAY_ROLE_CONFIG)]);

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label}: invalid UTF-8: ${error.message}`);
  }
}

function assertObject(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${label}: every reference record must be a JSON object`);
  }
  return record;
}

function recordMetadata(payload) {
  return Object.freeze({
    corpCode: typeof payload.corp_code === "string" ? payload.corp_code : null,
    documentId: typeof payload.document_id === "string"
      ? payload.document_id
      : (typeof payload.source_document_id === "string"
        ? payload.source_document_id
        : (typeof payload.anchor_document_id === "string" ? payload.anchor_document_id : null)),
    questionId: typeof payload.question_id === "string" ? payload.question_id : null,
    metricCode: typeof payload.metric_code === "string" ? payload.metric_code : null,
  });
}

async function* readJsonLines(filePath, label) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let lineNumber = 0;
  try {
    for await (const chunk of createReadStream(filePath)) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        lineNumber += 1;
        if (line === "") continue;
        let parsed;
        try { parsed = JSON.parse(line); }
        catch (error) { throw new Error(`${label}:${lineNumber}: invalid JSON: ${error.message}`); }
        yield assertObject(parsed, `${label}:${lineNumber}`);
      }
    }
    pending += decoder.decode();
  } catch (error) {
    if (error instanceof TypeError && /encoded data was not valid/i.test(error.message)) {
      throw new Error(`${label}: invalid UTF-8: ${error.message}`);
    }
    throw error;
  }
  if (pending !== "") {
    lineNumber += 1;
    let parsed;
    try { parsed = JSON.parse(pending); }
    catch (error) { throw new Error(`${label}:${lineNumber}: invalid JSON: ${error.message}`); }
    yield assertObject(parsed, `${label}:${lineNumber}`);
  }
}

async function readJsonObject(filePath, label) {
  const text = decodeUtf8(await readFile(filePath), label);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`${label}: invalid JSON: ${error.message}`); }
  return assertObject(parsed, label);
}

function keyForRecord(role, payload, ordinal) {
  const keyField = JSONL_ROLE_KEYS[role];
  if (keyField) {
    const value = payload[keyField];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${role}[${ordinal}]: required record key ${keyField} is missing`);
    }
    return value;
  }
  const arrayConfig = ARRAY_ROLE_CONFIG[role];
  if (arrayConfig) {
    const value = payload[arrayConfig.keyField];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${role}[${ordinal}]: required record key ${arrayConfig.keyField} is missing`);
    }
    return value;
  }
  return `${role}:control`;
}

export async function collectReferenceReleaseRecords({ materializedRoot, bundleManifest, onArtifact, onRecord }) {
  if (typeof materializedRoot !== "string" || materializedRoot === "") throw new TypeError("materializedRoot is required");
  if (!bundleManifest || !Array.isArray(bundleManifest.entries)) throw new TypeError("bundleManifest.entries is required");
  if (typeof onArtifact !== "function" || typeof onRecord !== "function") throw new TypeError("onArtifact and onRecord are required");

  const roleCounts = {};
  for (const entry of bundleManifest.entries) {
    const filePath = resolveWithinBase(materializedRoot, entry.source_path, `${entry.role}.source_path`);
    const seenKeys = new Set();
    let loadedCount = 0;

    const emit = async (payload) => {
      const recordKey = keyForRecord(entry.role, payload, loadedCount);
      if (seenKeys.has(recordKey)) throw new Error(`${entry.role}: duplicate record key ${recordKey}`);
      seenKeys.add(recordKey);
      await onRecord(Object.freeze({
        role: entry.role,
        ordinal: loadedCount,
        recordKey,
        payload,
        ...recordMetadata(payload),
      }));
      loadedCount += 1;
    };

    if (JSONL_ROLE_KEYS[entry.role]) {
      for await (const payload of readJsonLines(filePath, entry.role)) await emit(payload);
      if (typeof entry.record_count === "number" && loadedCount !== entry.record_count) {
        throw new Error(`${entry.role}: loaded ${loadedCount} records, expected ${entry.record_count}`);
      }
    } else if (ARRAY_ROLE_CONFIG[entry.role]) {
      const control = await readJsonObject(filePath, entry.role);
      const { arrayField } = ARRAY_ROLE_CONFIG[entry.role];
      if (!Array.isArray(control[arrayField])) throw new Error(`${entry.role}: ${arrayField}[] is required`);
      for (const payload of control[arrayField]) await emit(assertObject(payload, `${entry.role}.${arrayField}`));
      if (typeof entry.record_count === "number" && loadedCount !== entry.record_count) {
        throw new Error(`${entry.role}: loaded ${loadedCount} records, expected ${entry.record_count}`);
      }
    } else {
      await emit(await readJsonObject(filePath, entry.role));
    }

    roleCounts[entry.role] = loadedCount;
    await onArtifact(Object.freeze({ entry, loadedRecordCount: loadedCount }));
  }
  return Object.freeze({ roleCounts: Object.freeze(roleCounts) });
}
