import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DOCUMENT_EVENT_RELATION_TYPES,
  FACT_COVERAGE_STATES,
  findExperimentRoundDrift,
  findEvaluationLeakage,
  ids,
  RELATION_TYPES,
  requiredFactSlotsSha256,
  VALUE_CERTAINTIES,
  validateEvaluationGoldV02,
  validateEvaluationRecord,
  validateEvaluationSplitLifecycle,
  validateExperimentRun,
  validateFactCoverageSnapshot,
  validateEvaluationUsageEvent,
  validateIndexSnapshotManifest,
  validateManifestRecord,
  validateRetrievalRequestResultPair,
  validateRetrievalResult,
} from "../domain/contracts.mjs";

test("document IDs preserve the manifest convention", () => {
  assert.equal(ids.document("periodic", "20230515002335"), "periodic_20230515002335");
  assert.throws(() => ids.document("other", "20230515002335"), /doc_group/);
  assert.throws(() => ids.document("periodic", "123"), /rcept_no/);
});

test("derived IDs are deterministic and namespace-separated", () => {
  const one = ids.file("periodic_20230515002335", "a/document.xml");
  const two = ids.file("periodic_20230515002335", "a/document.xml");
  const other = ids.section(one, "section.1");
  assert.equal(one, two);
  assert.match(one, /^file_[0-9a-f]{24}$/);
  assert.match(other, /^section_[0-9a-f]{24}$/);
  assert.notEqual(one.slice(one.indexOf("_") + 1), other.slice(other.indexOf("_") + 1));
});

test("events are stable on reviewed chains and document-event relations are separate", () => {
  const one = ids.event("00126380", "SUPPLY_CONTRACT", "chain_reviewed_001");
  const two = ids.event("00126380", "SUPPLY_CONTRACT", "chain_reviewed_001");
  assert.equal(one, two);
  assert.ok(!RELATION_TYPES.includes("DISCLOSES"));
  assert.deepEqual(DOCUMENT_EVENT_RELATION_TYPES, ["DISCLOSES"]);
  assert.ok(VALUE_CERTAINTIES.includes("NOT_RELEVANT"));
});

test("metric ontology has unique stable codes", () => {
  const ontology = JSON.parse(readFileSync(new URL("../domain/facts/metric-ontology.v0.1.json", import.meta.url), "utf8"));
  const codes = ontology.metrics.map((metric) => metric.metric_code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes("OPERATING_PROFIT"));
  assert.ok(codes.includes("CONTRACT_AMOUNT"));
  assert.ok(codes.includes("HOLDING_RATIO"));
});

test("team JSON schemas reject undeclared Gold, Event, and Relation fields", () => {
  const semantic = JSON.parse(readFileSync(new URL("../domain/interfaces/semantic-bundle.schema.json", import.meta.url), "utf8"));
  const gold = JSON.parse(readFileSync(new URL("../domain/evaluation/evaluation-gold.v0.2.schema.json", import.meta.url), "utf8"));
  assert.equal(semantic.properties.schema_version.const, "0.2.0");
  assert.equal(semantic.$defs.event.additionalProperties, false);
  assert.ok(semantic.$defs.event.required.includes("chain_id"));
  assert.equal(semantic.$defs.relation.additionalProperties, false);
  assert.ok(semantic.$defs.relation.properties.relation_type.enum.includes("TERMINATES"));
  assert.equal(gold.additionalProperties, false);
  assert.equal(gold.$defs.expectedExecution.additionalProperties, false);
});

test("manifest validation enforces leading-zero codes and canonical doc_id", () => {
  const valid = {
    doc_id: "periodic_20230515002335",
    corp_code: "00126380",
    corp_name: "삼성전자",
    stock_code: "005930",
    doc_group: "periodic",
    report_nm: "분기보고서 (2023.03)",
    rcept_no: "20230515002335",
    rcept_dt: "20230515",
    file_path: "raw/periodic/삼성전자/example",
    file_format: "xml",
    is_correction: false,
    n_files: 1,
  };
  assert.deepEqual(validateManifestRecord(valid), []);
  assert.ok(validateManifestRecord({ ...valid, corp_code: "126380" }).includes("corp_code must be 8 digits"));
  assert.ok(validateManifestRecord({ ...valid, doc_id: "wrong" }).some((error) => error.startsWith("doc_id must equal")));
});

function evaluation(overrides = {}) {
  return {
    question_id: "q_001",
    evaluation_group_id: "chain_001",
    split: "DEV_TUNE",
    question: "정정 후 계약금액은?",
    question_type: "EVENT_TRACE",
    difficulty: "HARD",
    answer_mode: "CLOSED",
    doc_groups: ["exchange"],
    corp_codes: ["00126362"],
    as_of_date: "2026-03-31",
    expected_answerability: "SUPPORTED",
    gold_document_ids: ["exchange_20250314800002"],
    expected_fact_ids: [],
    expected_event_ids: [],
    required_evidence_slots: [{
      slot_name: "latest_value",
      description: "질문을 직접 지지하는 최신 유효값",
      acceptable_sources: [{
        document_id: "exchange_20250314800002",
        source_locator: "body.contract.amount",
        evidence_span: "계약금액",
      }],
    }],
    expected_answer: {
      status: "SUPPORTED",
      value: null,
      unit: null,
      reason_code: null,
    },
    tags: ["correction"],
    ...overrides,
  };
}

test("evaluation Gold is chunking-strategy independent", () => {
  assert.deepEqual(validateEvaluationRecord(evaluation()), []);
  const errors = validateEvaluationRecord(evaluation({ gold_chunk_ids: ["chunk_123"] }));
  assert.ok(errors.some((error) => error.includes("gold_chunk_ids is forbidden")));
});

test("evaluation groups cannot leak across independent splits", () => {
  const errors = findEvaluationLeakage([
    evaluation(),
    evaluation({ question_id: "q_002", split: "HOLDOUT" }),
  ]);
  assert.ok(errors.some((error) => error.includes("evaluation_group_id")));
  assert.ok(errors.some((error) => error.includes("gold document")));
});

test("gold documents and chains cannot leak even when group IDs differ", () => {
  const errors = findEvaluationLeakage([
    evaluation({ evaluation_group_id: "group_a", gold_chain_ids: ["chain_shared"] }),
    evaluation({
      question_id: "q_002",
      evaluation_group_id: "group_b",
      split: "HOLDOUT",
      gold_chain_ids: ["chain_shared"],
    }),
  ]);
  assert.ok(errors.some((error) => error.includes("gold document")));
  assert.ok(errors.some((error) => error.includes("gold chain")));
});

const EVENT_HASH_EXAMPLE = "a".repeat(64);

test("provisional assignments are sandbox-only", () => {
  const base = {
    usage_kind: "TUNING",
    executed_split: "DEV_TUNE",
    run_purpose: "FLOW_SELECTION",
    run_outcome: "SUCCESS",
    assigned_split_at_use: "DEV_TUNE",
    split_lock_status_at_use: "PROVISIONAL_UNTIL_CHAIN_CLOSURE",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.ok(validateEvaluationUsageEvent(base).some((error) => error.includes("provisional")));
  assert.deepEqual(validateEvaluationUsageEvent({
    ...base,
    usage_kind: "SANDBOX",
    executed_split: "SANDBOX",
    run_purpose: "SANDBOX_EXPLORATION",
  }), []);
  assert.deepEqual(validateEvaluationUsageEvent({
    ...base,
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    chain_ids_at_use: ["chain_001"],
  }), []);
});

test("validateEvaluationUsageEvent rejects a run_purpose that does not match executed_split", () => {
  const base = {
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "FLOW_SELECTION", // belongs to DEV_TUNE, not DEV_CHECK
    run_outcome: "SUCCESS",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.ok(validateEvaluationUsageEvent(base).some((error) => error.includes("run_purpose")));
});

test("validateEvaluationUsageEvent rejects an invalid run_outcome and malformed hash fields", () => {
  const base = {
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "CRITICAL_REGRESSION_CHECK",
    run_outcome: "MAYBE",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    previous_log_hash: "not-a-hash",
    event_hash: "too-short",
  };
  const errors = validateEvaluationUsageEvent(base);
  assert.ok(errors.some((error) => error.includes("run_outcome")));
  assert.ok(errors.some((error) => error.includes("previous_log_hash")));
  assert.ok(errors.some((error) => error.includes("event_hash")));
});

test("validateEvaluationUsageEvent rejects invalid assigned_split_at_use and holdout_lifecycle_status_at_use", () => {
  const base = {
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "CRITICAL_REGRESSION_CHECK",
    run_outcome: "SUCCESS",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.deepEqual(validateEvaluationUsageEvent(base), []);
  assert.ok(validateEvaluationUsageEvent({ ...base, assigned_split_at_use: "SANDBOX" })
    .some((error) => error.includes("assigned_split_at_use")));
  assert.ok(validateEvaluationUsageEvent({ ...base, holdout_lifecycle_status_at_use: "NOT_A_STATUS" })
    .some((error) => error.includes("holdout_lifecycle_status_at_use")));
});

test("validateEvaluationUsageEvent rejects an official executed_split that disagrees with its own assigned_split_at_use audit field", () => {
  const base = {
    usage_kind: "CHECKPOINT",
    executed_split: "DEV_CHECK",
    run_purpose: "CRITICAL_REGRESSION_CHECK",
    run_outcome: "SUCCESS",
    assigned_split_at_use: "DEV_CHECK",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "SEALED",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.deepEqual(validateEvaluationUsageEvent(base), []);
  // executed_split says DEV_CHECK but the audit field claims HOLDOUT — an
  // internally contradictory event that never went through canUseSplit's
  // runtime gate (e.g. a hand-edited or externally merged record).
  const errors = validateEvaluationUsageEvent({ ...base, assigned_split_at_use: "HOLDOUT" });
  assert.ok(errors.some((error) => error.includes("assigned_split_at_use must equal executed_split")));
});

test("validateEvaluationUsageEvent rejects a FINAL_HOLDOUT_EVALUATION event whose holdout_lifecycle_status_at_use is not OPENED", () => {
  const base = {
    usage_kind: "FINAL_HOLDOUT",
    executed_split: "HOLDOUT",
    run_purpose: "FINAL_HOLDOUT_EVALUATION",
    run_outcome: "SUCCESS",
    assigned_split_at_use: "HOLDOUT",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "OPENED",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.deepEqual(validateEvaluationUsageEvent(base), []);
  for (const wrongStatus of ["SEALED", "CONSUMED", "DIAGNOSTIC_ONLY"]) {
    const errors = validateEvaluationUsageEvent({ ...base, holdout_lifecycle_status_at_use: wrongStatus });
    assert.ok(
      errors.some((error) => error.includes("FINAL_HOLDOUT_EVALUATION event requires holdout_lifecycle_status_at_use=OPENED")),
      wrongStatus,
    );
  }
});

test("validateEvaluationUsageEvent rejects a DIAGNOSTIC_ONLY event whose holdout_lifecycle_status_at_use is not DIAGNOSTIC_ONLY", () => {
  const base = {
    usage_kind: "FINAL_HOLDOUT",
    executed_split: "HOLDOUT",
    run_purpose: "DIAGNOSTIC_ONLY",
    run_outcome: "SUCCESS",
    assigned_split_at_use: "HOLDOUT",
    split_lock_status_at_use: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status_at_use: "DIAGNOSTIC_ONLY",
    chain_ids_at_use: [],
    previous_log_hash: null,
    event_hash: EVENT_HASH_EXAMPLE,
  };
  assert.deepEqual(validateEvaluationUsageEvent(base), []);
  for (const wrongStatus of ["SEALED", "OPENED", "CONSUMED"]) {
    const errors = validateEvaluationUsageEvent({ ...base, holdout_lifecycle_status_at_use: wrongStatus });
    assert.ok(
      errors.some((error) => error.includes("DIAGNOSTIC_ONLY event requires holdout_lifecycle_status_at_use=DIAGNOSTIC_ONLY")),
      wrongStatus,
    );
  }
});

test("validateEvaluationSplitLifecycle checks assigned_split, split_lock_status, and holdout_lifecycle_status as independent fields", () => {
  const valid = {
    schema_version: "0.1.0",
    assignment_id: "author_0123456789abcdef01234567",
    assigned_split: "DEV_CHECK",
    split_lock_status: "LOCKED_BY_CHAIN",
    holdout_lifecycle_status: "SEALED",
    updated_at: "2026-08-10T09:00:00Z",
  };
  assert.deepEqual(validateEvaluationSplitLifecycle(valid), []);
  assert.ok(validateEvaluationSplitLifecycle({ ...valid, assigned_split: "NOT_A_SPLIT" })
    .some((error) => error.includes("assigned_split")));
  assert.ok(validateEvaluationSplitLifecycle({ ...valid, split_lock_status: "NOT_A_STATUS" })
    .some((error) => error.includes("split_lock_status")));
  assert.ok(validateEvaluationSplitLifecycle({ ...valid, holdout_lifecycle_status: "NOT_A_STATUS" })
    .some((error) => error.includes("holdout_lifecycle_status")));
  // the two axes are independent — a locked assignment can still be SEALED, and
  // an OPENED holdout can still be PROVISIONAL (already covered above by not
  // rejecting `valid`, since LOCKED_BY_CHAIN + SEALED is a legitimate combination)
});

test("Gold v0.2 locks required fact slots and validates conditional routes", () => {
  const requiredFactSlots = [{
    slot_name: "contract_amount",
    metric_code: "CONTRACT_AMOUNT",
    period_key: "event:2025-03-14",
    scope: "COMPANY",
  }];
  const record = evaluation({
    schema_version: "0.2.0",
    authored_against: {
      corpus_snapshot_id: "snapshot_1",
      manifest_sha256: "0".repeat(64),
      parser_name: "canonical-parser",
      parser_version: "0.1.0",
      document_ir_schema_version: "0.1.0",
      semantic_bundle_schema_version: "0.2.0",
      gold_revision: "r1",
    },
    expected_execution: {
      applicable_fact_coverage_states: ["FACT_SLOT_VERIFIED_WITHHELD"],
      required_fact_slots: requiredFactSlots,
      required_fact_slots_sha256: requiredFactSlotsSha256(requiredFactSlots),
      required_fact_slots_lock_status: "GOLD_LOCKED",
      route_policy: [{
        when: "FACT_SLOT_VERIFIED_WITHHELD",
        preferred_route: "STRUCTURED",
        allowed_routes: ["STRUCTURED"],
        required_operations: ["lookup_fact", "confirm_withheld_status"],
        forbidden_operations: ["search_hidden_value"],
        expected_answerability: "WITHHELD",
      }],
    },
    scoring_spec: { comparator: "EXACT", tolerance: null, unit: null, rounding: null },
  });
  assert.deepEqual(validateEvaluationGoldV02(record), []);
  const tampered = structuredClone(record);
  tampered.expected_execution.required_fact_slots[0].metric_code = "OPERATING_PROFIT";
  assert.ok(validateEvaluationGoldV02(tampered).some((error) => error.includes("sha256")));
  assert.ok(validateEvaluationGoldV02({ ...record, unexpected_field: true }).some((error) => error.includes("not allowed")));
});

test("conflicting verified facts require multiple Fact IDs", () => {
  assert.ok(FACT_COVERAGE_STATES.includes("CONFLICTING_VERIFIED_FACTS"));
  const base = {
    schema_version: "0.1.0",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_0123456789abcdef01234567",
    corpus_snapshot_id: "snapshot_1",
    semantic_bundle_schema_version: "0.2.0",
    producer_version: "0.1.0",
    created_at: "2026-08-04T00:00:00Z",
    slots: [{
      slot_key: "00126362:REVENUE:2025:CONSOLIDATED",
      corp_code: "00126362",
      metric_code: "REVENUE",
      coverage_state: "CONFLICTING_VERIFIED_FACTS",
      verification_status: "VERIFIED",
      fact_ids: ["fact_one"],
      evidence_ids: ["evidence_one"],
    }],
  };
  assert.ok(validateFactCoverageSnapshot(base).some((error) => error.includes("at least two")));
  base.slots[0].fact_ids.push("fact_two");
  assert.deepEqual(validateFactCoverageSnapshot(base), []);
});

test("CONFLICTING_EVIDENCE is covered by an early-exit route fixture", () => {
  const requiredFactSlots = [{ slot_name: "revenue", metric_code: "REVENUE" }];
  const fixture = evaluation({
    schema_version: "0.2.0",
    expected_answerability: "CONFLICTING_EVIDENCE",
    expected_answer: {
      status: "CONFLICTING_EVIDENCE",
      value: null,
      unit: null,
      reason_code: "UNRESOLVED_VERIFIED_FACT_CONFLICT",
    },
    authored_against: {
      corpus_snapshot_id: "snapshot_1",
      manifest_sha256: "0".repeat(64),
      parser_name: "canonical-parser",
      parser_version: "0.1.0",
      document_ir_schema_version: "0.1.0",
      semantic_bundle_schema_version: "0.2.0",
      gold_revision: "r1",
    },
    expected_execution: {
      applicable_fact_coverage_states: ["CONFLICTING_VERIFIED_FACTS"],
      required_fact_slots: requiredFactSlots,
      required_fact_slots_sha256: requiredFactSlotsSha256(requiredFactSlots),
      required_fact_slots_lock_status: "GOLD_LOCKED",
      route_policy: [{
        when: "CONFLICTING_VERIFIED_FACTS",
        preferred_route: "EARLY_EXIT",
        allowed_routes: ["EARLY_EXIT"],
        required_operations: ["report_conflicting_evidence"],
        forbidden_operations: ["select_fact_without_resolution", "calculate"],
        expected_answerability: "CONFLICTING_EVIDENCE",
      }],
    },
    scoring_spec: { comparator: "EXACT", tolerance: null, unit: null, rounding: null },
    tags: ["conflicting_evidence", "validator_fixture"],
  });
  assert.deepEqual(validateEvaluationGoldV02(fixture), []);
});

test("every question-applicable Fact coverage state has exactly one route policy", () => {
  const requiredFactSlots = [{ slot_name: "revenue", metric_code: "REVENUE" }];
  const incomplete = evaluation({
    schema_version: "0.2.0",
    authored_against: {
      corpus_snapshot_id: "snapshot_1",
      manifest_sha256: "0".repeat(64),
      parser_name: "canonical-parser",
      parser_version: "0.1.0",
      document_ir_schema_version: "0.1.0",
      semantic_bundle_schema_version: "0.2.0",
      gold_revision: "r1",
    },
    expected_execution: {
      applicable_fact_coverage_states: [
        "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
        "PARSE_BLOCKED",
      ],
      required_fact_slots: requiredFactSlots,
      required_fact_slots_sha256: requiredFactSlotsSha256(requiredFactSlots),
      required_fact_slots_lock_status: "GOLD_LOCKED",
      route_policy: [{
        when: "ALL_REQUIRED_FACT_SLOTS_VERIFIED",
        preferred_route: "STRUCTURED",
        allowed_routes: ["STRUCTURED"],
        required_operations: ["lookup_fact"],
        forbidden_operations: [],
        expected_answerability: "SUPPORTED",
      }],
    },
    scoring_spec: { comparator: "EXACT", tolerance: null, unit: null, rounding: null },
  });
  assert.ok(validateEvaluationGoldV02(incomplete).some((error) => error.includes("PARSE_BLOCKED")));
});

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

test("retrieval result score_type and component_scores must match retrieval_method", () => {
  const result = loadFixture("domain/retrieval/examples/retrieval-result.example.json");
  assert.deepEqual(validateRetrievalResult(result), []);

  const wrongScoreType = structuredClone(result);
  wrongScoreType.results[0].score_type = "RRF";
  assert.ok(validateRetrievalResult(wrongScoreType).some((error) => error.includes("score_type must be BM25")));

  const missingComponent = structuredClone(result);
  missingComponent.results[0].component_scores.bm25 = null;
  assert.ok(validateRetrievalResult(missingComponent).some((error) => error.includes("component_scores.bm25")));
});

test("retrieval result ranks are contiguous, capped at top_k, and sorted by score", () => {
  const result = loadFixture("domain/retrieval/examples/retrieval-result.example.json");

  const gapRank = structuredClone(result);
  gapRank.results[0].rank = 2;
  assert.ok(validateRetrievalResult(gapRank).some((error) => error.includes("must be 1")));

  const overCap = structuredClone(result);
  overCap.top_k = 0;
  assert.ok(validateRetrievalResult(overCap).some((error) => error.includes("exceeds top_k")));

  const outOfOrder = structuredClone(result);
  outOfOrder.results.push({ ...result.results[0], rank: 2, score: 99 });
  assert.ok(validateRetrievalResult(outOfOrder).some((error) => error.includes("sorted non-increasing")));
});

test("retrieval result rejects a child chunk that is its own parent and pins citation authority to source_spans", () => {
  const result = loadFixture("domain/retrieval/examples/retrieval-result.example.json");

  const selfParent = structuredClone(result);
  selfParent.results[0].parent_chunk_id = selfParent.results[0].chunk_id;
  assert.ok(validateRetrievalResult(selfParent).some((error) => error.includes("must not equal its own chunk_id")));

  const badProvenance = structuredClone(result);
  badProvenance.results[0].text_provenance = "EMBED_TEXT";
  assert.ok(validateRetrievalResult(badProvenance).some((error) => error.includes("text_provenance")));

  // raw_text is never the citation itself, no matter how it was derived.
  const sourceVerbatim = structuredClone(result);
  sourceVerbatim.results[0].text_provenance = "SOURCE_VERBATIM";
  assert.deepEqual(validateRetrievalResult(sourceVerbatim), []);

  const wrongAuthority = structuredClone(result);
  wrongAuthority.results[0].citation_authority = "RAW_TEXT";
  assert.ok(validateRetrievalResult(wrongAuthority).some((error) => error.includes("citation_authority")));
});

test("retrieval request/result pairs must share one corpus/chunking/index snapshot and filter set", () => {
  const request = loadFixture("domain/retrieval/examples/retrieval-request.example.json");
  const result = loadFixture("domain/retrieval/examples/retrieval-result.example.json");
  assert.deepEqual(validateRetrievalRequestResultPair(request, result), []);

  const driftedSnapshot = structuredClone(result);
  driftedSnapshot.index_snapshot_id = "index_bm25_sample_v0_2";
  assert.ok(
    validateRetrievalRequestResultPair(request, driftedSnapshot).some((error) => error.includes("index_snapshot_id")),
  );

  const driftedFilters = structuredClone(result);
  driftedFilters.applied_filters.doc_subtypes = ["다른유형"];
  assert.ok(
    validateRetrievalRequestResultPair(request, driftedFilters).some((error) => error.includes("applied_filters")),
  );
});

test("index snapshot manifest rejects duplicate component roles and dense components without an embedding model", () => {
  const manifest = loadFixture("domain/retrieval/examples/index-snapshot-manifest.example.json");
  assert.deepEqual(validateIndexSnapshotManifest(manifest), []);

  const duplicateRole = structuredClone(manifest);
  duplicateRole.components.push({ ...duplicateRole.components[0] });
  assert.ok(validateIndexSnapshotManifest(duplicateRole).some((error) => error.includes("duplicate component_role")));

  const denseWithoutModel = structuredClone(manifest);
  denseWithoutModel.components.push({
    component_role: "DENSE",
    backend: "pgvector",
    backend_version: "0.7.0",
    index_hash: "1".repeat(64),
    embedding_model_id: null,
    embedding_dimension: 1024,
    normalization: "COSINE",
  });
  assert.ok(
    validateIndexSnapshotManifest(denseWithoutModel).some((error) => error.includes("requires embedding_model_id")),
  );

  const hybridMissingDense = structuredClone(manifest);
  hybridMissingDense.hybrid_combination = { method: "RRF", rrf_k: 60 };
  assert.ok(
    validateIndexSnapshotManifest(hybridMissingDense).some((error) => error.includes("requires both LEXICAL and DENSE")),
  );
});

test("experiment runs require a fixed Fact Coverage Snapshot identifier", () => {
  const run = {
    schema_version: "0.2.0",
    run_id: "run_a",
    experiment_round_id: "round_chunking_01",
    corpus_snapshot_id: "snapshot_1",
    parser_version: "0.1.0",
    chunking_config_id: "fixed_512",
    embedding_model_id: "kure-v1",
    index_snapshot_id: "index_1",
    gold_revision: "r1",
    fact_coverage_snapshot_id: "fact_coverage_snapshot_0123456789abcdef01234567",
    started_at: "2026-08-04T00:00:00Z",
  };
  assert.deepEqual(validateExperimentRun(run), []);
  assert.ok(validateExperimentRun({ ...run, fact_coverage_snapshot_id: "" }).length > 0);
  assert.deepEqual(findExperimentRoundDrift([
    run,
    { ...run, run_id: "run_b", chunking_config_id: "parent_child" },
  ]), []);
  assert.ok(findExperimentRoundDrift([
    run,
    { ...run, run_id: "run_c", fact_coverage_snapshot_id: "fact_coverage_snapshot_aaaaaaaaaaaaaaaaaaaaaaaa" },
  ]).some((error) => error.includes("fact_coverage_snapshot_id")));
});
