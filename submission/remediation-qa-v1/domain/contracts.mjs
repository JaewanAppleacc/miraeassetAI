import { createHash } from "node:crypto";

export const DOCUMENT_GROUPS = Object.freeze([
  "periodic",
  "major",
  "exchange",
  "holding",
]);

export const RELATION_TYPES = Object.freeze([
  "AMENDS",
  "TERMINATES",
  "CONFIRMS",
  "SAME_EVENT_AS",
]);

export const DOCUMENT_EVENT_RELATION_TYPES = Object.freeze(["DISCLOSES"]);

export const COVERAGE_STATES = Object.freeze([
  "PRESENT",
  "ZERO_DOCUMENT",
  "PARSE_FAILED",
  "PARTIAL_PARSE_FAILURE",
  "NOT_IN_CORPUS",
]);

export const VALUE_STATUSES = Object.freeze([
  "DISCLOSED",
  "WITHHELD",
  "NOT_APPLICABLE",
  "MISSING",
]);

export const VALUE_CERTAINTIES = Object.freeze([
  "CONFIRMED",
  "PLANNED",
  "PROVISIONAL",
  "NOT_RELEVANT",
]);

export const EVALUATION_SPLITS = Object.freeze([
  "DEV_TUNE",
  "DEV_CHECK",
  "HOLDOUT",
]);

// Assignment split placement lock — whether a Gold question's split
// membership is still provisional (pending chain closure review) or
// locked. See evaluation-split-lifecycle.schema.json: this is one of TWO
// independent axes, deliberately not merged with HOLDOUT_LIFECYCLE_STATUSES.
export const SPLIT_LOCK_STATUSES = Object.freeze([
  "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
  "LOCKED_BY_CHAIN",
  "LOCKED_BY_COVERAGE",
]);

// The OTHER independent axis: only meaningful once executed_split=HOLDOUT.
// A strictly linear forward lifecycle (see domain/runtime/
// evaluation-usage-ledger.mjs's transitionHoldoutLifecycle for the allowed
// transition graph and domain/evaluation/README.md's late-chain-discovery
// rules for why a HOLDOUT question can need a diagnostic re-run after its
// first real (CONSUMED) use).
export const HOLDOUT_LIFECYCLE_STATUSES = Object.freeze([
  "SEALED",
  "OPENED",
  "CONSUMED",
  "DIAGNOSTIC_ONLY",
]);

// A closed vocabulary (not free text) so "does this run have a documented
// purpose" is a structural, schema-enforceable fact — each value maps to a
// specific decision rule in the project design notes.
export const RUN_PURPOSES = Object.freeze([
  "SANDBOX_EXPLORATION",
  "FLOW_SELECTION",
  "CRITICAL_REGRESSION_CHECK",
  "FINAL_HOLDOUT_EVALUATION",
  "DIAGNOSTIC_ONLY",
]);

export const RUN_OUTCOMES = Object.freeze(["SUCCESS", "FAILURE"]);

export const ANSWERABILITY_STATES = Object.freeze([
  "SUPPORTED",
  "NOT_FOUND",
  "WITHHELD",
  "NOT_APPLICABLE",
  "UNANSWERABLE",
  "OUT_OF_SCOPE",
  "AMBIGUOUS_QUERY",
  "CONFLICTING_EVIDENCE",
]);

export const EXECUTION_ROUTES = Object.freeze([
  "STRUCTURED",
  "RETRIEVAL",
  "BOTH",
  "EARLY_EXIT",
]);

export const FACT_COVERAGE_STATES = Object.freeze([
  "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
  "FACT_SLOT_VERIFIED_WITHHELD",
  "FACT_SLOT_VERIFIED_NOT_APPLICABLE",
  "PARTIAL_STRUCTURED_FACT_COVERAGE",
  "NO_STRUCTURED_FACT_COVERAGE",
  "ZERO_DOCUMENT_IN_CORPUS",
  "PARSE_BLOCKED",
  "OUT_OF_SCOPE",
  "CONFLICTING_VERIFIED_FACTS",
]);

export const SCORING_COMPARATORS = Object.freeze([
  "EXACT",
  "ABSOLUTE",
  "RELATIVE",
  "PERCENTAGE_POINT",
  "RANGE",
]);

export const RETRIEVAL_METHODS = Object.freeze([
  "BM25",
  "DENSE",
  "HYBRID_RRF",
  "HYBRID_RRF_RERANKER",
  // vFINAL's official
  // candidate A fuses the UNION of BM25 and dense candidates (an absent
  // leg contributes 0 to RRF, never dropped from the result) -- distinct
  // from HYBRID_RRF above, whose contract (RETRIEVAL_METHOD_REQUIRED_COMPONENTS
  // below) requires BOTH legs non-null, i.e. INTERSECTION-only. HYBRID_RRF's
  // own existing behavior/consumers are unchanged; this is a new, additive
  // method value, used only by official candidate A.
  "HYBRID_UNION_RRF",
]);

export const SCORE_TYPES = Object.freeze(["BM25", "COSINE", "RRF", "RERANKER"]);

// Must mirror domain/chunking/chunk.schema.json's chunk_type enum: a
// retrieval result's chunk_type is copied from the Chunk it matched, not an
// independent vocabulary.
export const CHUNK_TYPES = Object.freeze([
  "FIXED_WINDOW",
  "SECTION_FLAT",
  "SECTION_PARENT",
  "EVENT_PARENT",
  "HOLDING_STATUS_PARENT",
  "PARAGRAPH_CHILD",
  "FIELD_GROUP_CHILD",
  "TABLE_WHOLE",
  "TABLE_ROW",
  "DOCUMENT_FALLBACK",
]);

export const INDEX_COMPONENT_ROLES = Object.freeze(["LEXICAL", "DENSE", "RERANKER"]);

// raw_text is always the Chunk's text verbatim (never embed_text), but that
// text may itself be a deterministic linearization or synthesized context
// rather than a literal quote of the source document. citation_authority is
// pinned to SOURCE_SPANS: consumers must never treat raw_text as the
// citation, only as retrieval/HCX context.
export const TEXT_PROVENANCE_VALUES = Object.freeze([
  "SOURCE_VERBATIM",
  "DETERMINISTIC_LINEARIZATION",
  "STRUCTURAL_CONTEXT",
]);

// A method's score_type and which component_scores entries it must populate.
// RRF and reranker stages still carry their upstream bm25/dense inputs so the
// blend is auditable, not just the final blended score.
const RETRIEVAL_METHOD_SCORE_TYPE = Object.freeze({
  BM25: "BM25",
  DENSE: "COSINE",
  HYBRID_RRF: "RRF",
  HYBRID_RRF_RERANKER: "RERANKER",
  HYBRID_UNION_RRF: "RRF",
});

const RETRIEVAL_METHOD_REQUIRED_COMPONENTS = Object.freeze({
  BM25: ["bm25"],
  DENSE: ["dense"],
  HYBRID_RRF: ["bm25", "dense", "rrf"],
  HYBRID_RRF_RERANKER: ["bm25", "dense", "rrf", "reranker"],
  // Only rrf is required non-null: a UNION result item may legitimately
  // come from only one leg (bm25 XOR dense), so requiring BOTH here (as
  // HYBRID_RRF does) would make honest single-leg-only union entries fail
  // validation. component_scores.{bm25,dense} are still carried through --
  // null exactly when that leg is genuinely absent, never a fabricated
  // value -- so the fusion stays fully auditable.
  HYBRID_UNION_RRF: ["rrf"],
});

export const QUESTION_TYPES = Object.freeze([
  "SIMPLE_LOOKUP",
  "NUMERIC_LOOKUP",
  "COMPARISON_CALC",
  "EVENT_TRACE",
  "NARRATIVE_MULTI_DOC",
  "ANSWERABILITY",
  "POLICY_SAFETY",
]);

const CORP_CODE = /^\d{8}$/;
const STOCK_CODE = /^\d{6}$/;
const RCEPT_NO = /^\d{14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(parts) {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

export function stableId(prefix, ...parts) {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`Invalid ID prefix: ${prefix}`);
  }
  if (parts.some((part) => part === null || part === undefined || part === "")) {
    throw new Error(`ID ${prefix} contains an empty component`);
  }
  return `${prefix}_${sha256(parts.map(String)).slice(0, 24)}`;
}

export const ids = Object.freeze({
  document(group, rceptNo) {
    assertEnum(group, DOCUMENT_GROUPS, "doc_group");
    assertPattern(rceptNo, RCEPT_NO, "rcept_no");
    return `${group}_${rceptNo}`;
  },
  file(documentId, relativePath) {
    return stableId("file", documentId, relativePath);
  },
  section(fileId, sourceLocator) {
    return stableId("section", fileId, sourceLocator);
  },
  chunk(strategyId, documentId, ordinal, contentFingerprint) {
    return stableId("chunk", strategyId, documentId, ordinal, contentFingerprint);
  },
  event(corpCode, eventType, chainId) {
    assertPattern(corpCode, CORP_CODE, "corp_code");
    return stableId("event", corpCode, eventType, chainId);
  },
  chain(docGroup, corpCode, stableAnchor) {
    assertEnum(docGroup, DOCUMENT_GROUPS, "doc_group");
    assertPattern(corpCode, CORP_CODE, "corp_code");
    return stableId("chain", docGroup, corpCode, stableAnchor);
  },
  fact(subjectId, metricCode, periodKey, scope, versionId) {
    return stableId("fact", subjectId, metricCode, periodKey, scope, versionId);
  },
  evidence(documentId, sourceLocator, quoteHash) {
    return stableId("evidence", documentId, sourceLocator, quoteHash);
  },
  evaluationUsage(assignmentId, runId, usedAt) {
    return stableId("eval_usage", assignmentId, runId, usedAt);
  },
  factCoverageSnapshot(corpusSnapshotId, semanticBundleVersion, createdAt) {
    return stableId("fact_coverage_snapshot", corpusSnapshotId, semanticBundleVersion, createdAt);
  },
  alias(corpCode, aliasType, normalizedAlias) {
    assertPattern(corpCode, CORP_CODE, "corp_code");
    return stableId("alias", corpCode, aliasType, normalizedAlias);
  },
  coverage(corpusSnapshotId, corpCode, docGroup, periodKey) {
    return stableId("coverage", corpusSnapshotId, corpCode, docGroup, periodKey);
  },
  relationCandidate(sourceDocumentId, relationType) {
    assertEnum(relationType, RELATION_TYPES, "relation_type");
    return stableId("relation_candidate", sourceDocumentId, relationType);
  },
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function requiredFactSlotsSha256(slots) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(slots)), "utf8")
    .digest("hex");
}

export function normalizeAlias(value) {
  return String(value)
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s._-]+/g, "")
    .replace(/[()\[\]{}'\"`]/g, "");
}

function assertPattern(value, pattern, field) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${field} has invalid format: ${JSON.stringify(value)}`);
  }
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}: ${value}`);
  }
}

function requireString(record, field, errors) {
  if (typeof record[field] !== "string" || record[field].trim() === "") {
    errors.push(`${field} must be a non-empty string`);
  }
}

function rejectUnknownFields(record, allowedFields, path, errors) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) errors.push(`${path}.${field} is not allowed`);
  }
}

export function validateManifestRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["record must be an object"];
  }

  for (const field of [
    "doc_id",
    "corp_code",
    "corp_name",
    "stock_code",
    "doc_group",
    "report_nm",
    "rcept_no",
    "rcept_dt",
    "file_path",
    "file_format",
  ]) {
    requireString(record, field, errors);
  }

  if (!CORP_CODE.test(record.corp_code ?? "")) errors.push("corp_code must be 8 digits");
  if (!STOCK_CODE.test(record.stock_code ?? "")) errors.push("stock_code must be 6 digits");
  if (!RCEPT_NO.test(record.rcept_no ?? "")) errors.push("rcept_no must be 14 digits");
  if (!/^\d{8}$/.test(record.rcept_dt ?? "")) errors.push("rcept_dt must be YYYYMMDD");
  if (!DOCUMENT_GROUPS.includes(record.doc_group)) errors.push("unknown doc_group");
  if (record.doc_group && record.rcept_no) {
    const expected = `${record.doc_group}_${record.rcept_no}`;
    if (record.doc_id !== expected) errors.push(`doc_id must equal ${expected}`);
  }
  if (typeof record.is_correction !== "boolean") errors.push("is_correction must be boolean");
  if (!Number.isInteger(record.n_files) || record.n_files < 1) errors.push("n_files must be a positive integer");
  return errors;
}

export function validateEvaluationRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["record must be an object"];
  }

  for (const field of [
    "question_id",
    "evaluation_group_id",
    "split",
    "question",
    "question_type",
    "difficulty",
    "answer_mode",
    "expected_answerability",
  ]) {
    requireString(record, field, errors);
  }

  if (!EVALUATION_SPLITS.includes(record.split)) errors.push("invalid split");
  if (!ANSWERABILITY_STATES.includes(record.expected_answerability)) {
    errors.push("invalid expected_answerability");
  }
  if (!Array.isArray(record.doc_groups) || record.doc_groups.length === 0) {
    errors.push("doc_groups must be a non-empty array");
  } else {
    for (const group of record.doc_groups) {
      if (!DOCUMENT_GROUPS.includes(group)) errors.push(`unknown doc_group: ${group}`);
    }
  }
  if (!Array.isArray(record.required_evidence_slots)) {
    errors.push("required_evidence_slots must be an array");
  } else {
    const names = new Set();
    for (const [index, slot] of record.required_evidence_slots.entries()) {
      if (!slot || typeof slot !== "object") {
        errors.push(`required_evidence_slots[${index}] must be an object`);
        continue;
      }
      if (typeof slot.slot_name !== "string" || slot.slot_name === "") {
        errors.push(`required_evidence_slots[${index}].slot_name is required`);
      } else if (names.has(slot.slot_name)) {
        errors.push(`duplicate evidence slot: ${slot.slot_name}`);
      } else {
        names.add(slot.slot_name);
      }
      if (!Array.isArray(slot.acceptable_sources)) {
        errors.push(`required_evidence_slots[${index}].acceptable_sources must be an array`);
      }
    }
  }

  if ("gold_chunk_ids" in record) {
    errors.push("gold_chunk_ids is forbidden; use document_id + source_locator/evidence_span");
  }
  if (!Array.isArray(record.gold_document_ids)) errors.push("gold_document_ids must be an array");
  if (!Array.isArray(record.tags)) errors.push("tags must be an array");
  if (record.as_of_date !== null && record.as_of_date !== undefined && !DATE.test(record.as_of_date)) {
    errors.push("as_of_date must be YYYY-MM-DD or null");
  }
  return errors;
}

export function validateEvaluationGoldV02(record) {
  const errors = validateEvaluationRecord(record);
  rejectUnknownFields(record, [
    "schema_version", "question_id", "evaluation_group_id", "split", "question",
    "question_type", "difficulty", "answer_mode", "doc_groups", "corp_codes",
    "as_of_date", "expected_answerability", "gold_document_ids", "gold_chain_ids",
    "expected_fact_ids", "expected_event_ids", "required_evidence_slots",
    "expected_answer", "authored_against", "expected_execution", "scoring_spec",
    "tags", "created_at", "extensions",
  ], "gold", errors);
  if (record?.schema_version !== "0.2.0") errors.push("schema_version must be 0.2.0");
  if (!QUESTION_TYPES.includes(record?.question_type)) errors.push("question_type is invalid");
  if (!Array.isArray(record?.expected_fact_ids)) errors.push("expected_fact_ids must be an array");
  if (!Array.isArray(record?.expected_event_ids)) errors.push("expected_event_ids must be an array");
  if (!record?.expected_answer || typeof record.expected_answer !== "object" || Array.isArray(record.expected_answer)) {
    errors.push("expected_answer must be an object");
  } else {
    rejectUnknownFields(record.expected_answer, ["status", "value", "unit", "reason_code"], "expected_answer", errors);
    if (!ANSWERABILITY_STATES.includes(record.expected_answer.status)) errors.push("expected_answer.status is invalid");
    if (record.expected_answer.status !== record.expected_answerability) {
      errors.push("expected_answer.status must match expected_answerability");
    }
    for (const field of ["value", "unit", "reason_code"]) {
      if (!(field in record.expected_answer)) errors.push(`expected_answer.${field} is required`);
    }
  }
  for (const [index, slot] of (record?.required_evidence_slots ?? []).entries()) {
    rejectUnknownFields(slot, [
      "slot_name", "description", "acceptable_sources", "expected_fact_ids", "expected_event_ids",
    ], `required_evidence_slots[${index}]`, errors);
    requireString(slot, "description", errors);
    for (const [sourceIndex, source] of (slot.acceptable_sources ?? []).entries()) {
      rejectUnknownFields(source, [
        "document_id", "source_locator", "evidence_span",
      ], `required_evidence_slots[${index}].acceptable_sources[${sourceIndex}]`, errors);
      for (const field of ["document_id", "source_locator", "evidence_span"]) requireString(source, field, errors);
    }
  }
  for (const field of ["authored_against", "expected_execution", "scoring_spec"]) {
    if (!record?.[field] || typeof record[field] !== "object" || Array.isArray(record[field])) {
      errors.push(`${field} must be an object`);
    }
  }
  const authored = record?.authored_against ?? {};
  rejectUnknownFields(authored, [
    "corpus_snapshot_id", "manifest_sha256", "parser_name", "parser_version",
    "document_ir_schema_version", "semantic_bundle_schema_version", "gold_revision",
  ], "authored_against", errors);
  for (const field of [
    "corpus_snapshot_id", "manifest_sha256", "parser_name", "parser_version",
    "document_ir_schema_version", "semantic_bundle_schema_version", "gold_revision",
  ]) requireString(authored, field, errors);
  if (authored.semantic_bundle_schema_version !== "0.2.0") {
    errors.push("authored_against.semantic_bundle_schema_version must be 0.2.0");
  }
  if (authored.manifest_sha256 && !/^[0-9a-f]{64}$/.test(authored.manifest_sha256)) {
    errors.push("authored_against.manifest_sha256 must be sha256");
  }

  const execution = record?.expected_execution ?? {};
  rejectUnknownFields(execution, [
    "applicable_fact_coverage_states", "required_fact_slots",
    "required_fact_slots_sha256", "required_fact_slots_lock_status", "route_policy",
  ], "expected_execution", errors);
  if (!Array.isArray(execution.applicable_fact_coverage_states) || execution.applicable_fact_coverage_states.length === 0) {
    errors.push("expected_execution.applicable_fact_coverage_states must be a non-empty array");
  } else {
    const applicable = new Set();
    for (const state of execution.applicable_fact_coverage_states) {
      if (!FACT_COVERAGE_STATES.includes(state)) errors.push(`invalid applicable fact coverage state: ${state}`);
      if (applicable.has(state)) errors.push(`duplicate applicable fact coverage state: ${state}`);
      applicable.add(state);
    }
  }
  if (!Array.isArray(execution.required_fact_slots)) {
    errors.push("expected_execution.required_fact_slots must be an array");
  } else {
    for (const [index, slot] of execution.required_fact_slots.entries()) {
      rejectUnknownFields(slot, ["slot_name", "metric_code", "period_key", "scope"], `required_fact_slots[${index}]`, errors);
      requireString(slot, "slot_name", errors);
      requireString(slot, "metric_code", errors);
    }
    const expectedHash = requiredFactSlotsSha256(execution.required_fact_slots);
    if (execution.required_fact_slots_sha256 !== expectedHash) {
      errors.push("expected_execution.required_fact_slots_sha256 does not match locked slots");
    }
  }
  if (execution.required_fact_slots_lock_status !== "GOLD_LOCKED") {
    errors.push("expected_execution.required_fact_slots_lock_status must be GOLD_LOCKED");
  }
  if (!Array.isArray(execution.route_policy) || execution.route_policy.length === 0) {
    errors.push("expected_execution.route_policy must be a non-empty array");
  } else {
    const seenConditions = new Set();
    for (const [index, rule] of execution.route_policy.entries()) {
      rejectUnknownFields(rule, [
        "when", "preferred_route", "allowed_routes", "required_operations",
        "forbidden_operations", "expected_answerability",
      ], `route_policy[${index}]`, errors);
      if (!FACT_COVERAGE_STATES.includes(rule.when)) errors.push(`route_policy[${index}].when is invalid`);
      if (seenConditions.has(rule.when)) errors.push(`duplicate route policy condition: ${rule.when}`);
      seenConditions.add(rule.when);
      if (!EXECUTION_ROUTES.includes(rule.preferred_route)) errors.push(`route_policy[${index}].preferred_route is invalid`);
      if (!Array.isArray(rule.allowed_routes) || !rule.allowed_routes.includes(rule.preferred_route)) {
        errors.push(`route_policy[${index}].allowed_routes must include preferred_route`);
      }
      for (const route of rule.allowed_routes ?? []) {
        if (!EXECUTION_ROUTES.includes(route)) errors.push(`route_policy[${index}] has invalid allowed route: ${route}`);
      }
      if (!Array.isArray(rule.required_operations) || !Array.isArray(rule.forbidden_operations)) {
        errors.push(`route_policy[${index}] operations must be arrays`);
      }
      if (!ANSWERABILITY_STATES.includes(rule.expected_answerability)) {
        errors.push(`route_policy[${index}].expected_answerability is invalid`);
      }
    }
    const applicable = new Set(execution.applicable_fact_coverage_states ?? []);
    const mapped = new Set(execution.route_policy.map((rule) => rule.when));
    for (const state of applicable) {
      if (!mapped.has(state)) errors.push(`applicable fact coverage state has no route policy: ${state}`);
    }
    for (const state of mapped) {
      if (!applicable.has(state)) errors.push(`route policy state is not declared applicable: ${state}`);
    }
  }

  const scoring = record?.scoring_spec ?? {};
  rejectUnknownFields(scoring, ["comparator", "tolerance", "unit", "rounding"], "scoring_spec", errors);
  if (!SCORING_COMPARATORS.includes(scoring.comparator)) errors.push("scoring_spec.comparator is invalid");
  if (scoring.comparator === "PERCENTAGE_POINT" && scoring.unit !== "%p") {
    errors.push("PERCENTAGE_POINT comparator requires %p unit");
  }
  return errors;
}

export function validateFactCoverageSnapshot(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  for (const field of [
    "schema_version", "fact_coverage_snapshot_id", "corpus_snapshot_id",
    "semantic_bundle_schema_version", "producer_version", "created_at",
  ]) requireString(record, field, errors);
  if (record.schema_version !== "0.1.0") errors.push("schema_version must be 0.1.0");
  if (!Array.isArray(record.slots)) errors.push("slots must be an array");
  const slotKeys = new Set();
  for (const [index, slot] of (record.slots ?? []).entries()) {
    for (const field of ["slot_key", "corp_code", "metric_code", "coverage_state", "verification_status"]) {
      requireString(slot, field, errors);
    }
    if (slotKeys.has(slot.slot_key)) errors.push(`duplicate slot_key: ${slot.slot_key}`);
    slotKeys.add(slot.slot_key);
    if (!FACT_COVERAGE_STATES.includes(slot.coverage_state)) errors.push(`slots[${index}].coverage_state is invalid`);
    if (slot.verification_status !== "VERIFIED") errors.push(`slots[${index}] must be VERIFIED`);
    if (!Array.isArray(slot.fact_ids)) errors.push(`slots[${index}].fact_ids must be an array`);
    if (slot.coverage_state === "CONFLICTING_VERIFIED_FACTS" && (slot.fact_ids?.length ?? 0) < 2) {
      errors.push(`slots[${index}] conflict requires at least two fact_ids`);
    }
  }
  return errors;
}

export function validateExperimentRun(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  for (const field of [
    "schema_version", "run_id", "experiment_round_id", "corpus_snapshot_id",
    "parser_version", "chunking_config_id", "embedding_model_id", "index_snapshot_id",
    "gold_revision", "fact_coverage_snapshot_id", "started_at",
  ]) requireString(record, field, errors);
  if (record.schema_version !== "0.2.0") errors.push("schema_version must be 0.2.0");
  return errors;
}

export function findExperimentRoundDrift(records) {
  const frozenFields = [
    "corpus_snapshot_id",
    "parser_version",
    "gold_revision",
    "fact_coverage_snapshot_id",
  ];
  const rounds = new Map();
  const errors = [];
  for (const record of records) {
    const baseline = rounds.get(record.experiment_round_id);
    if (!baseline) {
      rounds.set(record.experiment_round_id, record);
      continue;
    }
    for (const field of frozenFields) {
      if (baseline[field] !== record[field]) {
        errors.push(`experiment round ${record.experiment_round_id} drifts on ${field}`);
      }
    }
  }
  return errors;
}

export function findEvaluationLeakage(records) {
  const groupSplits = new Map();
  const documentSplits = new Map();
  const chainSplits = new Map();
  const questionIds = new Set();
  const errors = [];

  for (const record of records) {
    if (questionIds.has(record.question_id)) {
      errors.push(`duplicate question_id: ${record.question_id}`);
    }
    questionIds.add(record.question_id);
    const splits = groupSplits.get(record.evaluation_group_id) ?? new Set();
    splits.add(record.split);
    groupSplits.set(record.evaluation_group_id, splits);
    for (const documentId of record.gold_document_ids ?? []) {
      const documentSet = documentSplits.get(documentId) ?? new Set();
      documentSet.add(record.split);
      documentSplits.set(documentId, documentSet);
    }
    for (const chainId of record.gold_chain_ids ?? []) {
      const chainSet = chainSplits.get(chainId) ?? new Set();
      chainSet.add(record.split);
      chainSplits.set(chainId, chainSet);
    }
  }

  for (const [groupId, splits] of groupSplits.entries()) {
    if (splits.size > 1) {
      errors.push(`evaluation_group_id ${groupId} leaks across splits: ${[...splits].sort().join(", ")}`);
    }
  }
  for (const [documentId, splits] of documentSplits.entries()) {
    if (splits.size > 1) {
      errors.push(`gold document ${documentId} leaks across splits: ${[...splits].sort().join(", ")}`);
    }
  }
  for (const [chainId, splits] of chainSplits.entries()) {
    if (splits.size > 1) {
      errors.push(`gold chain ${chainId} leaks across splits: ${[...splits].sort().join(", ")}`);
    }
  }
  return errors;
}

export const USAGE_KIND_TO_SPLIT = Object.freeze({
  SANDBOX: "SANDBOX",
  TUNING: "DEV_TUNE",
  CHECKPOINT: "DEV_CHECK",
  FINAL_HOLDOUT: "HOLDOUT",
});

// Many-to-one on purpose: FINAL_HOLDOUT_EVALUATION (the one independent
// final run) and DIAGNOSTIC_ONLY (a post-CONSUMED bug-fix re-check) are
// both legitimate reasons to execute against HOLDOUT, gated differently by
// holdout_lifecycle_status — see domain/runtime/evaluation-usage-ledger.mjs.
// Exported so canUseSplit's PRE-execution check uses this exact same
// mapping — never a second, driftable copy of the same rule.
export const RUN_PURPOSE_TO_SPLITS = Object.freeze({
  SANDBOX_EXPLORATION: ["SANDBOX"],
  FLOW_SELECTION: ["DEV_TUNE"],
  CRITICAL_REGRESSION_CHECK: ["DEV_CHECK"],
  FINAL_HOLDOUT_EVALUATION: ["HOLDOUT"],
  DIAGNOSTIC_ONLY: ["HOLDOUT"],
});

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function validateEvaluationUsageEvent(record) {
  const errors = [];
  const allowedKinds = ["SANDBOX", "TUNING", "CHECKPOINT", "FINAL_HOLDOUT"];
  const allowedSplits = ["SANDBOX", "DEV_TUNE", "DEV_CHECK", "HOLDOUT"];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  if (!allowedKinds.includes(record.usage_kind)) errors.push("invalid usage_kind");
  if (!allowedSplits.includes(record.executed_split)) errors.push("invalid executed_split");
  if (!SPLIT_LOCK_STATUSES.includes(record.split_lock_status_at_use)) errors.push("invalid split_lock_status_at_use");
  if (!EVALUATION_SPLITS.includes(record.assigned_split_at_use)) errors.push("invalid assigned_split_at_use");
  if (!HOLDOUT_LIFECYCLE_STATUSES.includes(record.holdout_lifecycle_status_at_use)) {
    errors.push("invalid holdout_lifecycle_status_at_use");
  }
  if (USAGE_KIND_TO_SPLIT[record.usage_kind] && USAGE_KIND_TO_SPLIT[record.usage_kind] !== record.executed_split) {
    errors.push("usage_kind does not match executed_split");
  }
  if (
    record.executed_split !== "SANDBOX" &&
    !["LOCKED_BY_CHAIN", "LOCKED_BY_COVERAGE"].includes(record.split_lock_status_at_use)
  ) {
    errors.push("provisional assignments cannot be used in an official split");
  }
  if (!Array.isArray(record.chain_ids_at_use)) errors.push("chain_ids_at_use must be an array");

  // An OFFICIAL (non-SANDBOX) execution's own audit copy of its assigned
  // split must equal the split it actually ran under — a directly
  // constructed or externally merged event claiming executed_split=HOLDOUT
  // while assigned_split_at_use=DEV_CHECK (or vice versa) never went
  // through canUseSplit's runtime gate and must be rejected here too, not
  // only by that gate.
  if (record.executed_split !== "SANDBOX" && record.assigned_split_at_use !== record.executed_split) {
    errors.push("assigned_split_at_use must equal executed_split for an official (non-SANDBOX) execution");
  }

  if (!RUN_PURPOSES.includes(record.run_purpose)) {
    errors.push("invalid run_purpose");
  } else {
    if (!RUN_PURPOSE_TO_SPLITS[record.run_purpose].includes(record.executed_split)) {
      errors.push(`run_purpose ${record.run_purpose} cannot be used with executed_split ${record.executed_split}`);
    }
    // A FINAL_HOLDOUT_EVALUATION event whose own audit field disagrees
    // with "this ran while OPENED" (or a DIAGNOSTIC_ONLY event that
    // disagrees with "this ran while DIAGNOSTIC_ONLY") is internally
    // contradictory regardless of how it entered the ledger.
    if (record.run_purpose === "FINAL_HOLDOUT_EVALUATION" && record.holdout_lifecycle_status_at_use !== "OPENED") {
      errors.push("a FINAL_HOLDOUT_EVALUATION event requires holdout_lifecycle_status_at_use=OPENED");
    }
    if (record.run_purpose === "DIAGNOSTIC_ONLY" && record.holdout_lifecycle_status_at_use !== "DIAGNOSTIC_ONLY") {
      errors.push("a DIAGNOSTIC_ONLY event requires holdout_lifecycle_status_at_use=DIAGNOSTIC_ONLY");
    }
  }
  if (!RUN_OUTCOMES.includes(record.run_outcome)) errors.push("invalid run_outcome");
  if (record.previous_log_hash !== null && !SHA256_HEX.test(record.previous_log_hash ?? "")) {
    errors.push("previous_log_hash must be null or a sha256 hex string");
  }
  if (!SHA256_HEX.test(record.event_hash ?? "")) errors.push("event_hash must be a sha256 hex string");

  return errors;
}

// The current lifecycle state of one assignment along its two independent
// axes (see SPLIT_LOCK_STATUSES / HOLDOUT_LIFECYCLE_STATUSES) — shape and
// enum-membership only. Transition legality (which state a record may
// legally move FROM/TO) is domain/runtime/evaluation-usage-ledger.mjs's
// job, not this per-record shape check's.
export function validateEvaluationSplitLifecycle(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  if (record.schema_version !== "0.1.0") errors.push("schema_version must be 0.1.0");
  requireString(record, "assignment_id", errors);
  if (!EVALUATION_SPLITS.includes(record.assigned_split)) errors.push("invalid assigned_split");
  if (!SPLIT_LOCK_STATUSES.includes(record.split_lock_status)) errors.push("invalid split_lock_status");
  if (!HOLDOUT_LIFECYCLE_STATUSES.includes(record.holdout_lifecycle_status)) errors.push("invalid holdout_lifecycle_status");
  requireString(record, "updated_at", errors);
  return errors;
}

// JSON Schema checks field shape; these invariants span fields the schema
// alone can't express (score_type must match retrieval_method, ranks must be
// contiguous, request/result pairs must share one snapshot).
export function validateRetrievalResult(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  if (!RETRIEVAL_METHODS.includes(record.retrieval_method)) {
    errors.push(`invalid retrieval_method: ${record.retrieval_method}`);
  }
  if (!Array.isArray(record.results)) return [...errors, "results must be an array"];
  if (typeof record.top_k === "number" && record.results.length > record.top_k) {
    errors.push(`results.length (${record.results.length}) exceeds top_k (${record.top_k})`);
  }

  const expectedScoreType = RETRIEVAL_METHOD_SCORE_TYPE[record.retrieval_method];
  const requiredComponents = RETRIEVAL_METHOD_REQUIRED_COMPONENTS[record.retrieval_method] ?? [];
  const seenRanks = new Set();
  let previousScore = null;

  for (const [index, item] of record.results.entries()) {
    if (seenRanks.has(item.rank)) errors.push(`duplicate rank: ${item.rank}`);
    seenRanks.add(item.rank);
    if (item.rank !== index + 1) {
      errors.push(`results[${index}].rank must be ${index + 1} (ranks are contiguous and 1-based)`);
    }
    if (expectedScoreType && item.score_type !== expectedScoreType) {
      errors.push(`results[${index}].score_type must be ${expectedScoreType} for ${record.retrieval_method}`);
    }
    for (const component of requiredComponents) {
      if (item.component_scores?.[component] == null) {
        errors.push(`results[${index}].component_scores.${component} must not be null for ${record.retrieval_method}`);
      }
    }
    if (previousScore !== null && item.score > previousScore) {
      errors.push(`results[${index}].score must be sorted non-increasing by rank`);
    }
    previousScore = item.score;
    if (!CHUNK_TYPES.includes(item.chunk_type)) errors.push(`results[${index}].chunk_type is invalid`);
    if (item.parent_chunk_id != null && item.parent_chunk_id === item.chunk_id) {
      errors.push(`results[${index}].parent_chunk_id must not equal its own chunk_id`);
    }
    if (!TEXT_PROVENANCE_VALUES.includes(item.text_provenance)) {
      errors.push(`results[${index}].text_provenance is invalid`);
    }
    if (item.citation_authority !== "SOURCE_SPANS") {
      errors.push(`results[${index}].citation_authority must be SOURCE_SPANS`);
    }
  }
  return errors;
}

// A request/result pair must be pinned to the same corpus/chunking/index
// snapshot and the same filters, or comparisons across retrieval methods
// silently mix incompatible runs.
export function validateRetrievalRequestResultPair(request, result) {
  const errors = [];
  if (!request || typeof request !== "object") return ["request is required"];
  if (!result || typeof result !== "object") return ["result is required"];
  for (const field of [
    "query_id", "retrieval_method", "corpus_snapshot_id",
    "chunking_config_id", "index_snapshot_id", "top_k",
  ]) {
    if (request[field] !== result[field]) {
      errors.push(`${field} mismatch between request (${request[field]}) and result (${result[field]})`);
    }
  }
  const requestFilters = JSON.stringify(canonicalize(request.metadata_filters ?? {}));
  const resultFilters = JSON.stringify(canonicalize(result.applied_filters ?? {}));
  if (requestFilters !== resultFilters) {
    errors.push("result.applied_filters does not match request.metadata_filters");
  }
  return errors;
}

export function validateIndexSnapshotManifest(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  if (record.schema_version !== "0.1.0") errors.push("schema_version must be 0.1.0");
  for (const field of ["index_snapshot_id", "corpus_snapshot_id", "chunking_config_id", "created_at"]) {
    requireString(record, field, errors);
  }
  if (!Array.isArray(record.components) || record.components.length === 0) {
    errors.push("components must be a non-empty array");
  } else {
    const roles = new Set();
    for (const [index, component] of record.components.entries()) {
      if (!INDEX_COMPONENT_ROLES.includes(component.component_role)) {
        errors.push(`components[${index}].component_role is invalid`);
      }
      if (roles.has(component.component_role)) {
        errors.push(`duplicate component_role: ${component.component_role}`);
      }
      roles.add(component.component_role);
      if (component.component_role === "DENSE" && component.embedding_model_id == null) {
        errors.push(`components[${index}] DENSE component requires embedding_model_id`);
      }
    }
    if (record.hybrid_combination && (!roles.has("LEXICAL") || !roles.has("DENSE"))) {
      errors.push("hybrid_combination requires both LEXICAL and DENSE components");
    }
  }
  return errors;
}
