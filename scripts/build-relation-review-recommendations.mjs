import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const DEFAULT_PATHS = {
  relations: "work/domain-seed/relation-review-queue.jsonl",
  correctionReferences: "work/domain-seed/exchange-correction-references.jsonl",
  documents: "work/domain-seed/documents.jsonl",
  coverage: "work/domain-seed/document-parse-coverage.jsonl",
  semanticBundles: "work/domain-seed/exchange-contract.semantic-bundles.candidate.jsonl",
  output: "work/relation-review/recommendations.jsonl",
  summary: "work/relation-review/summary.json",
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = { ...DEFAULT_PATHS };
  const keyByOption = {
    "--relations": "relations",
    "--correction-references": "correctionReferences",
    "--documents": "documents",
    "--coverage": "coverage",
    "--semantic-bundles": "semanticBundles",
    "--output": "output",
    "--summary": "summary",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = keyByOption[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    args[key] = argv[++index];
    if (!args[key]) throw new Error(`Missing value for ${argv[index - 1]}`);
  }
  return args;
}

async function readJsonl(path) {
  const records = [];
  const lines = createInterface({ input: createReadStream(resolve(path)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

function documentIdOf(bundle) {
  return bundle?.facts?.[0]?.source_document_id ?? bundle?.evidence?.[0]?.document_id ?? null;
}

function documentRef(document) {
  if (!document) return null;
  return {
    document_id: document.document_id,
    corp_code: document.corp_code,
    doc_group: document.doc_group,
    report_name: document.report_name,
    receipt_date: document.receipt_date,
    is_correction: document.is_correction,
  };
}

function reviewEvidence({ kind, documentId, sourceLocator, quotedText }) {
  return {
    evidence_id: `review_evidence_${digest(`${documentId}\0${sourceLocator}\0${quotedText}`).slice(0, 24)}`,
    kind,
    document_id: documentId,
    source_locator: sourceLocator,
    quoted_text: quotedText,
  };
}

function correctionEvidence(reference) {
  const evidence = (reference?.evidence ?? []).map((item) => reviewEvidence({
    kind: item.kind,
    documentId: reference.source_document_id,
    sourceLocator: item.source_locator,
    quotedText: item.quoted_text,
  }));
  if (reference?.correction_reason_text) {
    const anchor = reference.evidence?.[0]?.source_locator ?? `${reference.source_document_id}#correction_reason`;
    evidence.push(reviewEvidence({
      kind: "CORRECTION_REASON",
      documentId: reference.source_document_id,
      sourceLocator: `${anchor};field=correction_reason`,
      quotedText: reference.correction_reason_text,
    }));
  }
  return evidence;
}

function terminationEvidence(bundle) {
  return (bundle?.evidence ?? [])
    .filter((item) => /해지/.test(item.quoted_text ?? ""))
    .slice(0, 10)
    .map((item) => reviewEvidence({
      kind: "TERMINATION_TEXT",
      documentId: item.document_id,
      sourceLocator: item.source_locator,
      quotedText: item.quoted_text,
    }));
}

function candidateSummary(candidate, documentsById) {
  const target = documentsById.get(candidate.target_document_id);
  if (!target) throw new Error(`${candidate.target_document_id}: candidate document missing`);
  return {
    target_document: documentRef(target),
    candidate_score: candidate.score,
    identity_score: candidate.identity_score ?? null,
    matching_field_count: candidate.matching_field_count ?? null,
    contradiction_count: candidate.contradiction_count ?? null,
    reasons: [...new Set(candidate.reasons ?? [])],
    field_matches: candidate.field_matches ?? {},
  };
}

function classifyAmends(relation, reference, coverage) {
  if (!coverage || coverage.state !== "PRESENT") {
    return {
      machineStatus: "PARSE_BLOCKED",
      basis: ["PARSE_NOT_FULLY_USABLE"],
      targetId: null,
      action: "파싱 누락 영역을 원문으로 확인한 뒤 AMENDS 대상을 판정하세요.",
    };
  }
  if (reference?.reference_status === "MATCHED_IN_CORPUS") {
    return {
      machineStatus: "READY_FOR_HUMAN_REVIEW",
      basis: ["EXPLICIT_REFERENCE_UNIQUE_MATCH"],
      targetId: reference.recommended_target_document_id,
      action: "명시 공시명·공시일과 추천 대상 문서를 대조하고 ACCEPTED 여부를 기록하세요.",
    };
  }
  if (reference?.reference_status === "TARGET_NOT_IN_CORPUS") {
    return {
      machineStatus: "TARGET_OUTSIDE_CORPUS_REVIEW",
      basis: ["EXPLICIT_REFERENCE_TARGET_OUTSIDE_CORPUS"],
      targetId: null,
      action: "명시 참조일이 manifest에 없음을 확인하고 TARGET_OUTSIDE_CORPUS 여부를 기록하세요.",
    };
  }
  if (reference?.reference_status === "AMBIGUOUS") {
    return {
      machineStatus: "AMBIGUOUS_REVIEW",
      basis: ["EXPLICIT_REFERENCE_AMBIGUOUS"],
      targetId: null,
      action: "동일 날짜 후보의 보고서 family와 정정 대상 field를 비교해 하나를 선택하거나 PENDING을 유지하세요.",
    };
  }
  return {
    machineStatus: relation.candidates.length ? "AMBIGUOUS_REVIEW" : "NO_TARGET_CANDIDATE_REVIEW",
    basis: relation.candidates.length ? ["MANIFEST_CANDIDATES_ONLY"] : ["NO_PRIOR_MANIFEST_CANDIDATE"],
    targetId: null,
    action: relation.candidates.length
      ? "제목·날짜 후보만으로 승인하지 말고 원문 참조 또는 stable key·field delta를 확인하세요."
      : "원문에 명시된 선행 공시를 확인하고 코퍼스 밖 대상인지 판정하세요.",
  };
}

function classifyTerminates(relation, documentsById, amendsBySource, coverage) {
  if (!coverage || coverage.state !== "PRESENT") {
    return {
      machineStatus: "PARSE_BLOCKED",
      basis: ["PARSE_NOT_FULLY_USABLE"],
      targetId: null,
      action: "해지 원문의 필수 식별 필드를 직접 확인한 뒤 재검수하세요.",
    };
  }
  if (relation.recommendation_status === "HIGH_CONFIDENCE_REVIEW") {
    const targetId = relation.recommended_target_document_id;
    const target = documentsById.get(targetId);
    if (!target) throw new Error(`${targetId}: recommended target document missing`);
    const blocked = target.is_correction && amendsBySource.has(targetId);
    return {
      machineStatus: blocked ? "BLOCKED_UNTIL_TARGET_AMENDS_REVIEW" : "READY_FOR_HUMAN_REVIEW",
      basis: blocked
        ? ["FACT_IDENTITY_HIGH_CONFIDENCE", "EXPLICIT_TERMINATION_WORDING", "TARGET_AMENDS_REVIEW_PENDING"]
        : ["FACT_IDENTITY_HIGH_CONFIDENCE", "EXPLICIT_TERMINATION_WORDING"],
      targetId,
      action: blocked
        ? "추천 대상 정정공시의 AMENDS 판정을 먼저 완료한 뒤 latest-effective 계약과 해지 관계를 승인하세요."
        : "계약명·상대방·금액·기간 중 최소 2개와 명시적 해지 표현을 확인해 승인 여부를 기록하세요.",
    };
  }
  if (relation.recommendation_status === "NO_TARGET_IN_MANIFEST_CANDIDATES") {
    return {
      machineStatus: "NO_TARGET_CANDIDATE_REVIEW",
      basis: ["NO_PRIOR_MANIFEST_CANDIDATE", "EXPLICIT_TERMINATION_WORDING"],
      targetId: null,
      action: "해지 원문에서 원계약 공시일·접수번호를 찾아 TARGET_OUTSIDE_CORPUS인지 확인하세요.",
    };
  }
  return {
    machineStatus: "AMBIGUOUS_REVIEW",
    basis: ["FACT_IDENTITY_AMBIGUOUS", "EXPLICIT_TERMINATION_WORDING"],
    targetId: null,
    action: "상위 후보들의 계약명·상대방·금액·기간을 원문 Evidence로 비교해 대상을 선택하세요.",
  };
}

export function validateRecommendationInvariant(record) {
  const errors = [];
  const targetRequired = new Set(["READY_FOR_HUMAN_REVIEW", "BLOCKED_UNTIL_TARGET_AMENDS_REVIEW"]);
  const targetForbidden = new Set([
    "AMBIGUOUS_REVIEW", "TARGET_OUTSIDE_CORPUS_REVIEW",
    "NO_TARGET_CANDIDATE_REVIEW", "PARSE_BLOCKED",
  ]);
  if (targetRequired.has(record.machine_status) && !record.recommended_target_document) {
    errors.push(`${record.machine_status} requires recommended_target_document`);
  }
  if (targetForbidden.has(record.machine_status) && record.recommended_target_document !== null) {
    errors.push(`${record.machine_status} forbids recommended_target_document`);
  }
  if (record.machine_status === "PARSE_BLOCKED" && record.source_parse.state === "PRESENT") {
    errors.push("PARSE_BLOCKED requires a non-PRESENT source parse state");
  }
  if (record.machine_status !== "PARSE_BLOCKED" && record.source_parse.state !== "PRESENT") {
    errors.push("non-PRESENT source parse state must be PARSE_BLOCKED");
  }
  const evidenceRequired = targetRequired.has(record.machine_status) ||
    record.machine_status === "TARGET_OUTSIDE_CORPUS_REVIEW" ||
    record.relation_type === "TERMINATES" ||
    record.recommendation_basis.some((basis) => basis.startsWith("EXPLICIT_REFERENCE_"));
  if (evidenceRequired && record.evidence.length === 0) {
    errors.push(`${record.machine_status} requires source evidence`);
  }
  if (record.recommended_target_document) {
    const inCandidates = record.candidate_summaries.some((candidate) =>
      candidate.target_document.document_id === record.recommended_target_document.document_id
    );
    if (!inCandidates) errors.push("recommended target must be present in candidate_summaries");
  }
  if (record.review_status !== "PENDING_HUMAN_REVIEW" || Object.values(record.review).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null
  )) {
    errors.push("machine recommendation cannot contain a human decision");
  }
  return errors;
}

export async function buildRelationReviewRecommendations(options = {}) {
  const args = { ...DEFAULT_PATHS, ...options };
  const [relations, references, documents, coverages, bundles, schemaText] = await Promise.all([
    readJsonl(args.relations),
    readJsonl(args.correctionReferences),
    readJsonl(args.documents),
    readJsonl(args.coverage),
    readJsonl(args.semanticBundles),
    readFile(new URL("../domain/relations/relation-review-recommendation.schema.json", import.meta.url), "utf8"),
  ]);
  const documentsById = new Map(documents.map((item) => [item.document_id, item]));
  const coverageById = new Map(coverages.map((item) => [item.document_id, item]));
  const referenceById = new Map(references.map((item) => [item.source_document_id, item]));
  const bundleById = new Map(bundles.map((item) => [documentIdOf(item), item]));
  const amendsBySource = new Map(relations
    .filter((item) => item.relation_type === "AMENDS")
    .map((item) => [item.source_document_id, item]));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaText));
  const records = [];

  for (const relation of relations) {
    const source = documentsById.get(relation.source_document_id);
    const coverage = coverageById.get(relation.source_document_id);
    if (!source || !coverage) throw new Error(`${relation.source_document_id}: source document or coverage missing`);
    const reference = referenceById.get(relation.source_document_id);
    const classification = relation.relation_type === "AMENDS"
      ? classifyAmends(relation, reference, coverage)
      : classifyTerminates(relation, documentsById, amendsBySource, coverage);
    const target = classification.targetId ? documentsById.get(classification.targetId) : null;
    const evidence = relation.relation_type === "AMENDS"
      ? correctionEvidence(reference)
      : terminationEvidence(bundleById.get(relation.source_document_id));
    const record = {
      schema_version: "0.1.0",
      review_packet_id: `relation_review_${digest(relation.relation_candidate_id).slice(0, 24)}`,
      corpus_snapshot_id: source.corpus_snapshot_id,
      relation_candidate_id: relation.relation_candidate_id,
      relation_type: relation.relation_type,
      source_document: documentRef(source),
      source_parse: {
        state: coverage.state,
        reason_code: coverage.reason_code,
        warning_codes: [...new Set(coverage.details?.warning_codes ?? [])].sort(),
      },
      recommended_target_document: documentRef(target),
      candidate_count: relation.candidates.length,
      candidate_summaries: relation.candidates.slice(0, 5).map((item) => candidateSummary(item, documentsById)),
      evidence,
      recommendation_basis: classification.basis,
      machine_status: classification.machineStatus,
      human_action: classification.action,
      review_status: "PENDING_HUMAN_REVIEW",
      review: {
        reviewer_id: null,
        reviewed_at: null,
        outcome: null,
        target_document_id: null,
        evidence_ids: [],
        notes: null,
      },
    };
    if (!validate(record)) {
      throw new Error(`${record.review_packet_id}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    }
    const invariantErrors = validateRecommendationInvariant(record);
    if (invariantErrors.length > 0) {
      throw new Error(`${record.review_packet_id}: ${invariantErrors.join("; ")}`);
    }
    records.push(record);
  }

  const counts = {};
  const byTypeAndStatus = {};
  for (const record of records) {
    counts[record.machine_status] = (counts[record.machine_status] ?? 0) + 1;
    const key = `${record.relation_type}:${record.machine_status}`;
    byTypeAndStatus[key] = (byTypeAndStatus[key] ?? 0) + 1;
  }
  const summary = {
    schema_version: "0.1.0",
    corpus_snapshot_id: records[0]?.corpus_snapshot_id ?? null,
    relation_candidates: records.length,
    relation_types: {
      AMENDS: records.filter((item) => item.relation_type === "AMENDS").length,
      TERMINATES: records.filter((item) => item.relation_type === "TERMINATES").length,
    },
    machine_status_counts: counts,
    type_status_counts: byTypeAndStatus,
    pending_human_review: records.length,
    accepted_gold: 0,
    note: "Machine recommendations are review support only. No relation is Gold until a human review decision is recorded.",
  };
  await mkdir(dirname(resolve(args.output)), { recursive: true });
  await mkdir(dirname(resolve(args.summary)), { recursive: true });
  await writeFile(resolve(args.output), `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(resolve(args.summary), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { records, summary };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await buildRelationReviewRecommendations(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ status: "PASS", output: resolve(parseArgs(process.argv.slice(2)).output), ...result.summary }, null, 2)}\n`);
}
