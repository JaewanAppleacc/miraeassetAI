// DOCUMENT_FIRST_RAG Agent variant (Turn P2-D). An ordinary AgentFlow
// (CLAUDE.md sections 4-7): `{ id, async run(input, context, services) }`,
// executed through the existing, unmodified domain/runtime/agent-runtime.mjs's
// runAgentFlow -- it reuses AgentInput, FinalResponse, StructuredQuery/
// StructuredResult, RetrieverRequest/RetrieverResult, and SharedServices
// exactly as they already exist (domain/agent-comparison/
// IMPLEMENTATION_GUIDE.md). This file adds no new frozen contract; it is
// one more Flow plugged into the existing one.
//
// What makes this variant "document-first" (as opposed to
// flows/structured-first-agent.mjs's STRUCTURED_FIRST, which starts from
// corp_code/metric_code conditions and queries Facts directly): the search
// STARTS from services.retriever.retrieve() over DocumentIR/chunk text, and
// only AFTER that does it consult the Structured Store -- but a retrieval
// hit is a CANDIDATE only, never a fact by itself (see the module-level
// hard rules below). "Document-first" changes what is searched first, not
// whether a claim needs a validated proof and a post-generation grounding
// check before it is stated as fact -- this Flow still routes every
// Fact-grounded claim through services.validator.validateEvidence AND
// through hard-claim-grounding.mjs's verifyGeneratedAnswer the same way
// STRUCTURED_FIRST does.
//
// Design (the 9 steps this Turn's brief asks for):
//   1. analyzeQuestion() reads the raw question (+ optional hints) --
//      reused as-is from flows/question-analysis.mjs.
//   2. services.retriever.retrieve() searches DocumentIR/chunk text for
//      candidate documents. A candidate's document_id is the ONLY thing
//      trusted out of this step -- its raw_text/score is retrieval/HCX
//      context only, never citable, never a claim by itself (retrieval-
//      result.schema.json's own citation_authority=SOURCE_SPANS +
//      text_provenance fields already say this; this Flow does not repeat
//      that check, it just never treats a retrieval hit as more than a
//      pointer to a document_id).
//   3-4. Evidence Validator + candidate extraction: candidate document_ids
//      are used to query the Structured Store's own EVIDENCE/FACT/EVENT/
//      RELATION records scoped to EXACTLY those document_ids (never a
//      fuzzy/name/date match -- see "no arbitrary chain" below). Every
//      Evidence record found this way is only ever used after
//      services.validator.validateEvidence succeeds for it -- exactly the
//      same Validator boundary STRUCTURED_FIRST uses, just reached by
//      document_id instead of by corp_code/metric_code.
//   5-6. Structured cross-validation: a validated Evidence record only
//      becomes a GROUNDED claim if (a) it is referenced by some Fact's
//      evidence_ids (the only authoritative Fact<->Evidence link this
//      codebase's real corpus provides -- see
//      flows/structured-first-agent.mjs's own header comment), (b) that
//      Fact's corp_code is one of THIS request's requested corp_codes
//      (when any were requested -- corp_code, not a company-name string,
//      is this codebase's own identity/join key, domain/README.md), and
//      (c) the Evidence's own quoted_text does not numerically conflict
//      with the Fact's normalized_value (see verifyValueConsistency
//      below). Any Evidence that fails (a)/(b)/(c) -- or that failed
//      validateEvidence itself -- is NEVER promoted to a grounded claim;
//      its document_id is only ever surfaced as an attributed,
//      explicitly-unconfirmed reference (see EVIDENCE_ONLY handling
//      below), never its content.
//   7. ModelAdapter generates an answer from ONLY the grounded claims
//      (never from evidence-only/conflicting candidates) -- but the raw
//      model output is never trusted as-is: see GROUNDING below.
//   8. hard-claim-grounding.mjs's verifyGeneratedAnswer (id-level citation
//      binding + text-level hard-claim check) runs on every model-
//      generated answer, unmodified, the same way STRUCTURED_FIRST uses
//      it.
//   9. On any failure (nothing grounded, model call failure, or
//      post-generation grounding rejection) a deterministic, fully-
//      grounded fallback answer is rendered instead -- no value is ever
//      invented at any step: every number/date/document_id this Flow (not
//      the model) ever prints comes verbatim from a validated Fact/
//      Evidence record or from the Retriever/StructuredStore's own
//      returned document_id.
//
// HARD RULES this file enforces (Turn P2-D brief):
//   - A retrieval hit is a candidate, never a fact -- see step 2 above.
//   - Nothing from a retrieval hit is used before
//     services.validator.validateEvidence actually succeeds for it.
//   - Even validated Evidence that conflicts with the Structured Store
//     (different corp_code than requested, or a quoted number that
//     disagrees with the linked Fact's normalized_value) is never
//     promoted to a confirmed fact -- see verifyValueConsistency/the
//     corp_code check in run() below.
//   - Evidence that is validated but never linked to any Fact (no
//     structured corroboration for a specific value) is only ever
//     surfaced by its document_id, with an explicit "not cross-validated"
//     caveat in the final answer text -- never its quoted content, which
//     was never checked against a structured value at all.
//   - A retrieval score is NEVER used to decide which document/company/
//     event a claim belongs to -- only Structured Store cross-validation
//     (scoped by exact document_id/corp_code/provenance) decides that;
//     see candidateDocumentIds below, which is score-ordered for
//     determinism only, never score-filtered.
//   - corp_code (never a company-name string) is this codebase's own
//     company identity/join key (domain/README.md) -- see the
//     requestedCorpCodes check below.
//   - A document correction/Relation chain is only ever surfaced from an
//     actual RELATION record returned for these exact document_ids -- see
//     relationContext below, which is never built by matching similar
//     receipt dates or contract-name substrings.
//   - This Flow's own rendered text (buildAnswerPrompt/renderFallbackAnswer)
//     never prints a raw metric_code/scope/period_type enum token -- see
//     metricLabelKo/scopeLabelKo/unitLabelKo below, which translate the
//     already-validated Fact's own fields into plain Korean (or, for an
//     unmapped metric_code, a generic phrase) instead.
//   - A citation is never accepted outside the document_id set the
//     Retriever itself actually returned this request -- authorizedFactIds/
//     validatedEvidenceIds below are built ONLY from this request's own
//     grounded set, exactly like STRUCTURED_FIRST's own citation-binding
//     scope.
//
// GROUNDING / FAILURE-FALLBACK ACCOUNTING: identical contract to
// flows/structured-first-agent.mjs's own header comment (this file does
// not repeat that text) -- citation_binding_status/unsupported_claim_count/
// model_fallback_used/scoring_eligible are set the same way, for the same
// reasons, and read verbatim by telemetry.mjs's buildTelemetryEvent.
import { RETRIEVAL_METHODS } from "../../contracts.mjs";
import { analyzeQuestion, loadMetricOntology } from "./question-analysis.mjs";
import { extractHardClaims, verifyGeneratedAnswer } from "./hard-claim-grounding.mjs";
import { computePromptTemplateSha256 } from "../reproducibility.mjs";

const OFFICIAL_VERIFIED = Object.freeze(["VERIFIED"]);
const DEFAULT_TOP_K = 10;
const DEFAULT_RETRIEVAL_METHOD = "BM25";

// Fixed instructional text only -- NEVER includes per-question variable
// data. Mirrors structured-first-agent.mjs's own
// ANSWER_PROMPT_TEMPLATE/ANSWER_PROMPT_TEMPLATE_SHA256 pattern (pinned by
// BenchmarkRunManifest.prompt_template_sha256).
export const ANSWER_PROMPT_TEMPLATE_ID = "document-first-rag-answer-prompt-v1";
export const ANSWER_PROMPT_TEMPLATE = [
  "다음은 문서 검색으로 찾은 후보 중, 구조화 저장소(Structured Store)의 검증(VERIFIED) 사실과 실제로 교차검증에 성공한 항목만 남긴 목록입니다.",
  "아래 목록에 없는 수치나 사실을 새로 만들어내지 말고, 질문에 대해 이 목록의 값만 사용해 한국어로 간결하게 답하세요.",
  "목록에 없는 문서나 값은 절대 언급하지 마세요.",
  "반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요:",
  '{"answer": "<한국어 답변>", "used_fact_ids": ["<실제 사용한 fact_id>", ...], "used_evidence_ids": ["<실제 사용한 evidence_id>", ...]}',
].join("\n");
export const ANSWER_PROMPT_TEMPLATE_SHA256 = computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE);

const SCOPE_LABELS_KO = Object.freeze({ CONSOLIDATED: "연결", SEPARATE: "별도" });
const UNIT_LABELS_KO = Object.freeze({ KRW: "원", PERCENT: "%", SHARES: "주" });

function scopeLabelKo(scope) {
  return SCOPE_LABELS_KO[scope] ?? "";
}

// Prefers the Fact's own raw_unit_text (the literal source label, not
// invented) -- only falls back to translating the normalized enum when
// raw_unit_text is absent, and only ever to a fixed, already-known mapping
// (never the raw enum token itself).
function unitLabelKo(fact) {
  if (typeof fact.raw_unit_text === "string" && fact.raw_unit_text !== "") return fact.raw_unit_text;
  return UNIT_LABELS_KO[fact.unit] ?? "";
}

function metricLabelKo(metricCode, ontology) {
  const entry = ontology.find((metric) => metric.metric_code === metricCode);
  return entry?.metric_name_ko ?? "해당 지표";
}

function sanitizeQueryIdFragment(value) {
  const lowered = typeof value === "string" ? value.toLowerCase() : "q";
  const cleaned = lowered.replace(/[^a-z0-9_.-]/g, "_");
  return cleaned === "" ? "q" : cleaned;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

function makeStructuredQuery({ queryIdSuffix, targets, corp_codes, predicates, context, as_of_date, limit }) {
  return {
    schema_version: "0.2.0",
    query_id: `query_document_first_${queryIdSuffix}`,
    execution_scope: "OFFICIAL",
    corpus_snapshot_id: context.corpus_snapshot_id,
    fact_coverage_snapshot_id: context.fact_coverage_snapshot_id ?? null,
    targets,
    corp_codes: corp_codes ?? [],
    predicates: {
      metric_codes: [], event_types: [], relation_types: [], document_ids: [],
      fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [],
      ...predicates,
    },
    period_filter: { start: null, end: null, period_types: [] },
    scope_filter: [],
    verification_statuses: OFFICIAL_VERIFIED,
    as_of_date,
    limit: limit ?? 50,
  };
}

function buildRetrievalRequest({ question, questionId, conditions, context, topK, retrievalMethod }) {
  return {
    schema_version: "0.1.0",
    query_id: `query_document_first_${sanitizeQueryIdFragment(questionId)}_retrieve`,
    question,
    corpus_snapshot_id: context?.corpus_snapshot_id,
    chunking_config_id: context?.chunking_config_id,
    index_snapshot_id: context?.index_snapshot_id,
    metadata_filters: {
      corp_codes: conditions.corp_codes,
      document_ids: conditions.document_ids,
      doc_groups: [],
      doc_subtypes: [],
      base_years: [],
      base_months: [],
      receipt_date_from: conditions.period_filter.start ?? null,
      receipt_date_to: conditions.period_filter.end ?? null,
      is_correction: null,
      retrieval_eligible: true,
    },
    top_k: topK,
    retrieval_method: retrievalMethod,
  };
}

// A validated Evidence quote "conflicts" with its linked Fact when the
// quote actually contains number tokens (so it is making a numeric claim
// at all) and NONE of them match the Fact's own value. Checked against
// BOTH raw_value_text (the source-extracted text an Evidence quote is
// actually expected to agree with) AND normalized_value (a Fact's
// normalized_value legitimately differs from its own raw_value_text by a
// disclosed scale/unit conversion -- e.g. "천원" source text normalized to
// KRW -- so checking normalized_value alone would flag a real, correctly
// scaled Fact as a false conflict). Reuses hard-claim-grounding.mjs's own
// number-extraction regexes (not a second, divergent number parser) so
// "what counts as the same number" never drifts between this check and
// the post-generation grounding check.
function verifyValueConsistency(quotedText, fact) {
  const quoteNumbers = extractHardClaims(quotedText).numbers;
  if (quoteNumbers.length === 0) return true;
  const candidateNumbers = [];
  if (typeof fact.raw_value_text === "string" && fact.raw_value_text !== "") {
    candidateNumbers.push(...extractHardClaims(fact.raw_value_text).numbers);
  }
  if (fact.normalized_value !== undefined && fact.normalized_value !== null) {
    candidateNumbers.push(String(fact.normalized_value));
  }
  if (candidateNumbers.length === 0) return true;
  return quoteNumbers.some((value) => candidateNumbers.includes(value));
}

function buildAnswerPrompt(question, groundedFacts, evidenceOnlyDocumentIds) {
  const factLines = groundedFacts.map((entry) => {
    const fact = entry.fact;
    return [
      `- fact_id=${fact.fact_id}`,
      `metric=${fact.metric_code}`,
      `corp_code=${fact.corp_code}`,
      `scope=${fact.scope}`,
      `period=${fact.period_type}${fact.period_start ? ` ${fact.period_start}~${fact.period_end ?? ""}` : ""}`,
      `value_status=${fact.value_status}`,
      `value=${JSON.stringify(fact.normalized_value)}${fact.unit ? ` ${fact.unit}` : ""}`,
      `source_document_id=${fact.source_document_id}`,
      `evidence_ids=${JSON.stringify(entry.evidenceIds)}`,
      `evidence_quote=${JSON.stringify(entry.quotes)}`,
    ].join(", ");
  });
  const evidenceOnlyNote = evidenceOnlyDocumentIds.length > 0
    ? `\n참고: 문서 ${evidenceOnlyDocumentIds.join(", ")}도 검색되었으나 구조화 데이터로 교차검증되지 않아 이 목록에서 제외했습니다. 이 문서들의 내용은 절대 언급하지 마세요.`
    : "";
  return [
    ANSWER_PROMPT_TEMPLATE,
    "",
    `질문: ${question}`,
    "",
    "교차검증된 Fact 목록:",
    ...factLines,
    evidenceOnlyNote,
  ].join("\n");
}

function renderFallbackAnswer(groundedFacts, ontology, evidenceOnlyDocumentIds) {
  const lines = groundedFacts.map((entry) => {
    const fact = entry.fact;
    const label = metricLabelKo(fact.metric_code, ontology);
    const scope = scopeLabelKo(fact.scope);
    const period = fact.period_start && fact.period_end ? `${fact.period_start}~${fact.period_end}` : (fact.period_start ?? fact.as_of_date ?? "");
    const unit = unitLabelKo(fact);
    const value = unit ? `${fact.normalized_value}${unit}` : String(fact.normalized_value);
    const scopePrefix = scope ? `${scope} 기준 ` : "";
    return `- ${scopePrefix}${label} (${period}, 문서 ${fact.source_document_id}): ${value} [${fact.value_status}]`;
  });
  const evidenceOnlyNote = evidenceOnlyDocumentIds.length > 0
    ? `\n참고: 문서 ${evidenceOnlyDocumentIds.join(", ")}에서 관련 내용이 검색되었으나 구조화 데이터로 교차검증되지 않아 사실로 확정할 수 없어 이 답변에는 포함하지 않았습니다.`
    : "";
  return [...lines, evidenceOnlyNote].join("\n").trim();
}

const INFORMATION_LIMIT_MESSAGES = Object.freeze({
  NO_CONDITIONS: "질문이 비어 있어 문서를 검색할 수 없습니다. 질문 내용을 입력해 다시 시도해 주세요.",
  RETRIEVAL_UNAVAILABLE: "문서 검색 기능을 사용할 수 없어 답변할 수 없습니다.",
  NO_RETRIEVAL_RESULTS: "질문과 관련된 문서 후보를 찾지 못해 답변할 수 없습니다.",
  NOT_FOUND: "검색된 문서 후보에 대해 구조화 저장소(Structured Store)에 검증된(VERIFIED) 데이터가 없어 답변할 수 없습니다.",
  STRUCTURED_CONFLICT: "검색된 문서 후보가 요청 조건(회사 등) 또는 구조화 데이터와 일치하지 않아 사실로 확정할 수 없습니다.",
  EVIDENCE_ONLY_UNCONFIRMED: "관련 문서는 검색되었으나 구조화 데이터(Fact)로 교차검증되지 않아 사실로 확정하여 답변할 수 없습니다.",
});

function informationLimitOutcome(question, reason, operations, extra = {}) {
  const documentIds = Array.isArray(extra.documentIds) ? extra.documentIds : [];
  const baseMessage = INFORMATION_LIMIT_MESSAGES[reason] ?? INFORMATION_LIMIT_MESSAGES.NOT_FOUND;
  const answer = documentIds.length > 0
    ? `${baseMessage} (검색된 문서: ${documentIds.join(", ")})`
    : baseMessage;
  return {
    final_response: {
      question,
      retrieved_context: documentIds.map((documentId) => ({ document_id: documentId, structured_confirmation: "NONE" })),
      think_trace: {
        execution_mode: "BOTH",
        operations,
        calculation: {},
        validation: {
          answerability: "UNANSWERABLE",
          reason,
          citation_binding_status: "NOT_CHECKED",
          unsupported_claim_count: 0,
          model_fallback_used: false,
          scoring_eligible: true,
        },
      },
      answer,
    },
  };
}

export function createDocumentFirstRagFlow(modelAdapter, options = {}) {
  if (!modelAdapter || typeof modelAdapter.generate !== "function") {
    throw new TypeError("createDocumentFirstRagFlow requires a ModelAdapter with a generate(request) method");
  }
  const topK = Number.isInteger(options.topK) && options.topK >= 1 && options.topK <= 100 ? options.topK : DEFAULT_TOP_K;
  const retrievalMethod = RETRIEVAL_METHODS.includes(options.retrievalMethod) ? options.retrievalMethod : DEFAULT_RETRIEVAL_METHOD;
  const ontology = options.ontology ?? loadMetricOntology();

  return Object.freeze({
    id: "DOCUMENT_FIRST_RAG",
    async run(input, context, services) {
      const question = typeof input?.question === "string" ? input.question : "";
      const operations = [];
      const conditions = analyzeQuestion(input, options);
      operations.push({ step: "ANALYZE_QUESTION", corp_codes: conditions.corp_codes, metric_codes: conditions.metric_codes, document_ids: conditions.document_ids });

      if (question.trim() === "") {
        return informationLimitOutcome(question, "NO_CONDITIONS", operations);
      }

      // --- step 2: Retriever candidate search (document-first) ----------
      const retrievalRequest = buildRetrievalRequest({
        question, questionId: input?.question_id, conditions, context, topK, retrievalMethod,
      });
      let retrieval;
      try {
        retrieval = await services.retriever.retrieve(retrievalRequest);
      } catch (error) {
        operations.push({ step: "RETRIEVE_CANDIDATES", ok: false, error_code: typeof error?.code === "string" ? error.code : "RETRIEVER_ERROR" });
        return informationLimitOutcome(question, "RETRIEVAL_UNAVAILABLE", operations);
      }
      operations.push({ step: "RETRIEVE_CANDIDATES", ok: true, result_count: retrieval.results.length });

      if (retrieval.results.length === 0) {
        return informationLimitOutcome(question, "NO_RETRIEVAL_RESULTS", operations);
      }

      // Candidate pool only -- a retrieval hit is NEVER itself a fact.
      // Order preserved (rank-ascending, i.e. best-scored first) for
      // deterministic tie-breaking only; membership in this set, not
      // score/rank, is what the cross-validation below actually uses to
      // decide which documents matter.
      const candidateDocumentIds = unique(retrieval.results.map((result) => result.document_id));
      operations.push({ step: "CANDIDATE_DOCUMENTS", document_ids: candidateDocumentIds, count: candidateDocumentIds.length });

      // --- steps 3-5: Evidence Validator + Structured cross-validation --
      const as_of_date = input?.as_of_date ?? context?.as_of_date ?? todayIso();
      const querySuffix = sanitizeQueryIdFragment(input?.question_id);
      const [evidenceResult, factResult, eventResult, relationResult] = await Promise.all([
        services.structuredStore.query(makeStructuredQuery({
          queryIdSuffix: `${querySuffix}_evidence_by_doc`, targets: ["EVIDENCE"],
          predicates: { document_ids: candidateDocumentIds }, context, as_of_date, limit: candidateDocumentIds.length * 10,
        })),
        services.structuredStore.query(makeStructuredQuery({
          queryIdSuffix: `${querySuffix}_facts_by_doc`, targets: ["FACT"],
          predicates: { document_ids: candidateDocumentIds }, context, as_of_date, limit: candidateDocumentIds.length * 10,
        })),
        services.structuredStore.query(makeStructuredQuery({
          queryIdSuffix: `${querySuffix}_events_by_doc`, targets: ["EVENT"],
          predicates: { document_ids: candidateDocumentIds }, context, as_of_date, limit: candidateDocumentIds.length * 10,
        })),
        // Relation enrichment is best-effort/informational only, scoped
        // strictly to these exact document_ids -- never inferred from a
        // shared receipt date or a similar contract name (see this file's
        // own header comment). A failure here never turns an otherwise
        // grounded answer into an information-limit answer.
        services.structuredStore.query(makeStructuredQuery({
          queryIdSuffix: `${querySuffix}_relations_by_doc`, targets: ["RELATION"],
          predicates: { document_ids: candidateDocumentIds }, context, as_of_date, limit: 50,
        })).catch(() => ({ status: "ERROR", records: [] })),
      ]);
      operations.push({ step: "QUERY_EVIDENCE_BY_DOCUMENT", status: evidenceResult.status, record_count: evidenceResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_FACTS_BY_DOCUMENT", status: factResult.status, record_count: factResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_EVENTS_BY_DOCUMENT", status: eventResult.status, record_count: eventResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_RELATIONS_BY_DOCUMENT", status: relationResult.status, record_count: relationResult.records?.length ?? 0 });

      if (evidenceResult.status !== "OK" && factResult.status !== "OK") {
        return informationLimitOutcome(question, "NOT_FOUND", operations, { documentIds: candidateDocumentIds });
      }

      const facts = (factResult.records ?? []).map((record) => record.payload);
      const evidenceRecords = (evidenceResult.records ?? []).map((record) => record.payload);

      // The Fact's own evidence_ids is the only authoritative Fact<->Evidence
      // link (same rule flows/structured-first-agent.mjs's header comment
      // documents) -- deduped so the same evidence_id referenced by two
      // Facts, or the same Fact reachable via two candidate documents,
      // never double-counts a grounded claim.
      const factByEvidenceId = new Map();
      for (const fact of facts) {
        for (const evidenceId of fact.evidence_ids ?? []) {
          if (!factByEvidenceId.has(evidenceId)) factByEvidenceId.set(evidenceId, fact);
        }
      }
      const requestedCorpCodes = new Set(conditions.corp_codes);

      const seenEvidenceIds = new Set();
      const groundedFacts = [];
      const groundedDocumentIds = new Set();
      let conflictCount = 0;

      for (const evidence of evidenceRecords) {
        if (seenEvidenceIds.has(evidence.evidence_id)) continue; // duplicate Evidence record, already handled
        seenEvidenceIds.add(evidence.evidence_id);

        const fact = factByEvidenceId.get(evidence.evidence_id);
        if (!fact) continue; // evidence-only: no structured Fact corroborates a specific value; see evidenceOnlyDocumentIds below

        if (requestedCorpCodes.size > 0 && !requestedCorpCodes.has(fact.corp_code)) {
          conflictCount += 1;
          operations.push({ step: "STRUCTURED_CONFLICT", reason: "CORP_CODE_MISMATCH", document_id: evidence.document_id });
          continue;
        }
        if (typeof evidence.quoted_text !== "string" || typeof evidence.quote_sha256 !== "string") continue;

        let validated = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          await services.validator.validateEvidence({
            evidence_id: evidence.evidence_id, document_id: evidence.document_id, file_id: evidence.file_id,
            source_locator: evidence.source_locator, quoted_text: evidence.quoted_text, quote_sha256: evidence.quote_sha256,
            fact_ids: [fact.fact_id], scope: fact.scope, period: fact.period_type, value_status: fact.value_status,
            known_at: fact.known_at, valid_from: fact.valid_from, valid_to: fact.valid_to,
          });
          validated = true;
        } catch {
          // Evidence Validator rejected this candidate -- never used, per
          // this Flow's own hard rule ("Evidence Validator 통과 전 사용 금지").
        }
        if (!validated) continue;

        if (!verifyValueConsistency(evidence.quoted_text, fact)) {
          conflictCount += 1;
          operations.push({ step: "STRUCTURED_CONFLICT", reason: "VALUE_MISMATCH", document_id: evidence.document_id, fact_id: fact.fact_id });
          continue;
        }

        groundedFacts.push({ fact, quotes: [evidence.quoted_text], evidenceIds: [evidence.evidence_id] });
        groundedDocumentIds.add(fact.source_document_id);
      }

      // Every candidate document that never produced a grounded claim --
      // whether because Structured Store had nothing for it, its Evidence
      // was never linked to a Fact, its Evidence failed validation, or it
      // conflicted (different corp_code / value mismatch). Attribution
      // (document_id) is safe to surface -- it is exactly what the
      // Retriever/Structured Store themselves returned; the document's
      // CONTENT is never surfaced this way, since it was never
      // cross-validated.
      const evidenceOnlyDocumentIds = candidateDocumentIds.filter((documentId) => !groundedDocumentIds.has(documentId));

      if (groundedFacts.length === 0) {
        const reason = conflictCount > 0 ? "STRUCTURED_CONFLICT" : "EVIDENCE_ONLY_UNCONFIRMED";
        return informationLimitOutcome(question, reason, operations, { documentIds: evidenceOnlyDocumentIds });
      }

      const authorizedFactIds = new Set(groundedFacts.map((entry) => entry.fact.fact_id));
      const validatedEvidenceIds = new Set(groundedFacts.flatMap((entry) => entry.evidenceIds));

      // --- step 7-9: model call + post-generation grounding -------------
      let answerBody;
      let citationBindingStatus;
      let unsupportedClaimCount = 0;
      let modelFallbackUsed;
      let selectedEvidenceIds = groundedFacts.flatMap((entry) => entry.evidenceIds);

      try {
        const generated = await modelAdapter.generate({ prompt: buildAnswerPrompt(question, groundedFacts, evidenceOnlyDocumentIds) });
        operations.push({ step: "MODEL_CALL", ok: true });
        const verdict = verifyGeneratedAnswer({
          text: generated.text,
          usedFactIds: generated.used_fact_ids ?? [],
          usedEvidenceIds: generated.used_evidence_ids ?? [],
          authorizedFactIds,
          validatedEvidenceIds,
          groundedFacts,
        });
        operations.push({ step: "VERIFY_GENERATED_ANSWER", status: verdict.status, unsupported_claim_count: verdict.unsupportedClaimCount });
        if (verdict.status === "PASS") {
          answerBody = generated.text;
          citationBindingStatus = "PASS";
          modelFallbackUsed = false;
          if (Array.isArray(generated.used_evidence_ids) && generated.used_evidence_ids.length > 0) {
            selectedEvidenceIds = generated.used_evidence_ids;
          }
        } else {
          // The WHOLE generated answer is discarded (never partially
          // patched) -- see flows/structured-first-agent.mjs's own
          // GROUNDING header comment for why.
          answerBody = renderFallbackAnswer(groundedFacts, ontology, evidenceOnlyDocumentIds);
          citationBindingStatus = "FAIL";
          unsupportedClaimCount = verdict.unsupportedClaimCount;
          modelFallbackUsed = true;
        }
      } catch (error) {
        const modelFailureCode = typeof error?.code === "string" ? error.code : "MODEL_CALL_UNKNOWN_ERROR";
        operations.push({ step: "MODEL_CALL", ok: false, error_code: modelFailureCode });
        answerBody = renderFallbackAnswer(groundedFacts, ontology, evidenceOnlyDocumentIds);
        citationBindingStatus = "NOT_CHECKED";
        modelFallbackUsed = true;
      }

      const relationContext = (relationResult.records ?? []).map((record) => ({
        relation_id: record.record_id,
        relation_type: record.payload?.relation_type ?? null,
      }));
      // Informational only, scoped strictly to these exact candidate
      // document_ids (never used to decide grounding) -- the same
      // best-effort role flows/structured-first-agent.mjs's own
      // eventContext plays.
      const eventContext = (eventResult.records ?? []).map((record) => ({
        event_id: record.record_id,
        event_type: record.payload?.event_type ?? null,
      }));

      return {
        final_response: {
          question,
          retrieved_context: [
            ...groundedFacts.map((entry) => ({ fact_id: entry.fact.fact_id, document_id: entry.fact.source_document_id, quotes: entry.quotes })),
            ...evidenceOnlyDocumentIds.map((documentId) => ({ document_id: documentId, structured_confirmation: "NONE" })),
            ...eventContext,
            ...relationContext,
          ],
          think_trace: {
            execution_mode: "BOTH",
            operations,
            calculation: {},
            validation: {
              answerability: "SUPPORTED",
              grounded_fact_count: groundedFacts.length,
              evidence_only_document_count: evidenceOnlyDocumentIds.length,
              conflict_count: conflictCount,
              citation_binding_status: citationBindingStatus,
              unsupported_claim_count: unsupportedClaimCount,
              model_fallback_used: modelFallbackUsed,
              scoring_eligible: !modelFallbackUsed,
            },
          },
          answer: answerBody,
        },
        execution_trace: {
          selected_evidence: selectedEvidenceIds,
        },
      };
    },
  });
}
