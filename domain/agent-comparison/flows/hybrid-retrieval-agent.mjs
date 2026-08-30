// HYBRID_RETRIEVAL Agent variant (Turn P2-H). An ordinary AgentFlow
// (CLAUDE.md sections 4-7): `{ id, async run(input, context, services) }`,
// executed through the existing, unmodified domain/runtime/agent-runtime.mjs
// runAgentFlow -- exactly the same SharedServices/StructuredQuery/
// StructuredResult contract flows/structured-first-agent.mjs already uses.
// This file adds no new frozen contract; it is one more Flow plugged into
// the existing one, built the same way IMPLEMENTATION_GUIDE.md documents.
//
// Design (the 9 steps this Turn's brief asks for):
//   1. analyzeQuestion() -- reused as-is from flows/question-analysis.mjs.
//   2. queries the VERIFIED/OFFICIAL Structured Store for Fact records
//      (execution_scope is ALWAYS "OFFICIAL", verification_statuses is
//      ALWAYS ["VERIFIED"] -- same as STRUCTURED_FIRST, never relaxed).
//   3. Evidence/Event/Relation enrichment identical to STRUCTURED_FIRST:
//      every Fact's own evidence_ids are queried from the Structured Store
//      and validated via services.validator.validateEvidence -- this is the
//      SAME "grounded" concept STRUCTURED_FIRST already uses.
//   4. SUFFICIENCY DECISION (deterministic, no model call): if every Fact
//      the Structured Store returned already has at least one validated
//      quote (ungroundedCount === 0), structured coverage is treated as
//      sufficient and the Retriever is never called at all -- this is the
//      one telemetry-visible way this variant differs from STRUCTURED_FIRST
//      (see IMPLEMENTATION_GUIDE.md's own "HYBRID_RETRIEVAL" note).
//   5. RETRIEVAL-BACKED EVIDENCE RECOVERY (only entered when step 4 finds a
//      gap): for each Fact whose OWN evidence_ids never actually validated
//      structurally (either the Structured Store's own EVIDENCE query never
//      returned that evidence_id's payload, or what it returned didn't
//      validate), exactly ONE services.retriever.retrieve() call is made,
//      scoped to those Facts' own source_document_id/corp_code -- never a
//      free-form open-ended document search. See "WHY RETRIEVAL NEVER
//      REPLACES STRUCTURED LOOKUP" below for why this is scoped to a Fact's
//      OWN already-declared evidence_id rather than inventing a new one.
//   6. every retrieved chunk that could plausibly back one of those
//      still-missing evidence_ids is itself run through
//      services.validator.validateEvidence -- EXACTLY the same Validator
//      boundary STRUCTURED_FIRST already uses for structured Evidence, not
//      a parallel or looser check. A chunk that fails (unverified, or its
//      text actively conflicts with what the trusted EvidenceStore holds
//      for that evidence_id) is discarded, never merged in -- see "FAIL-
//      CLOSED ON CONFLICT" below.
//   7. structured Facts and validated Retrieval-recovered Evidence are
//      combined into the SAME `groundedFacts` shape STRUCTURED_FIRST's own
//      hard-claim-grounding.mjs already consumes (`{ fact, quotes,
//      evidenceIds }`) -- no new shape, no new allowed-source-text builder
//      needed (see "WHY hard-claim-grounding.mjs NEEDS NO EXTENSION" below).
//   8. exactly like STRUCTURED_FIRST, an answer is composed via the
//      injected ModelAdapter, then the RAW model output is never trusted
//      as-is: flows/hard-claim-grounding.mjs's verifyGeneratedAnswer runs
//      unmodified over the combined grounded set.
//   9. if nothing could be grounded (from either source), or the model
//      call/grounding fails, the SAME deterministic, fully-grounded
//      fallback renderer STRUCTURED_FIRST uses is used here too.
//
// WHY RETRIEVAL NEVER REPLACES STRUCTURED LOOKUP: this Flow only ever asks
// the Retriever to recover text for an evidence_id a VERIFIED Fact already
// declares as its own (fact.evidence_ids) -- it never invents a new
// evidence_id, never treats a retrieved chunk as free-standing proof of a
// number/date/company on its own, and never runs a Retriever query when the
// Structured Store already fully grounds every returned Fact. This is the
// literal reading of this Turn's brief ("Retriever는 구조화 조회를 대체하지
// 않고 부족한 근거를 보강한다"): "insufficient" means an EVIDENCE gap on an
// already-authorized Fact, not a broader company/metric discovery gap. If
// the Structured Store returns NO Fact at all for a condition
// (factResult.status !== "OK"), there is no Fact-declared evidence_id to
// recover against, so the Retriever is not called for that case either --
// see the NOT_FOUND/QUERY_FAILED branches below, both handled the same way
// STRUCTURED_FIRST already handles them (never as a de-facto RETRIEVAL-only
// answer -- this Flow deliberately never builds an answer sourced from
// retrieval alone, matching this Turn's own execution_mode guidance).
//
// FAIL-CLOSED ON CONFLICT: a retrieved chunk is only ever adopted as
// Evidence for a Fact's own declared evidence_id via the SAME
// services.validator.validateEvidence boundary STRUCTURED_FIRST already
// uses -- it is never merged in on its own say-so. When the chunk's text
// genuinely disagrees with what the trusted EvidenceStore holds for that
// evidence_id (EVIDENCE_QUOTE_MISMATCH/EVIDENCE_HASH_MISMATCH/
// EVIDENCE_DOCUMENT_MISMATCH/EVIDENCE_LOCATOR_MISMATCH), this Flow records
// that as a CONFLICT operation (informational only, still never trusted)
// rather than silently discarding it as an ordinary "couldn't verify" case
// -- the Fact simply stays ungrounded either way, but the trace is honest
// about which failure it was.
//
// WHY hard-claim-grounding.mjs NEEDS NO EXTENSION: IMPLEMENTATION_GUIDE.md
// suggests extending its allowed-source-text builder to also cover raw
// retrieved snippets. This Flow does not need that: a retrieved chunk is
// only ever adopted once it has PASSED services.validator.validateEvidence
// for a Fact's own evidence_id, at which point it already has the exact
// same `{ fact, quotes, evidenceIds }` shape a structured-sourced grounded
// entry has -- flows/hard-claim-grounding.mjs's existing
// buildAllowedSourceText already walks every entry's `quotes`, regardless
// of which store the quote came from. A raw, UNVALIDATED retrieval snippet
// is never added to `groundedFacts` at all (see step 6 above), so it is
// correctly never part of the model's allowed source text either --
// exactly the "미검증 Evidence는 폐기" requirement, achieved by reusing the
// existing generic module completely unmodified.
//
// RETRIEVER FAILURE ACCOUNTING: a Retriever-boundary failure
// (RETRIEVER_UNAVAILABLE/RETRIEVER_ADAPTER_ERROR/RETRIEVER_INVALID_REQUEST/
// RETRIEVER_INVALID_RESULT/RETRIEVER_REQUEST_RESULT_MISMATCH/
// RETRIEVER_SNAPSHOT_MISMATCH -- see retriever-store.mjs's RETRIEVER_CODES)
// is caught explicitly and recorded as its own RETRIEVE operation with
// ok:false -- it is NEVER silently downgraded into the same "NOT_FOUND"
// reason a genuinely-empty Structured Store query gets (a Retriever that
// broke and a corpus that legitimately has nothing are different facts).
// If nothing else was grounded, this becomes its own
// answerability="UNANSWERABLE" reason ("RETRIEVAL_FAILED"), still with
// model_fallback_used=false/scoring_eligible=true -- the model is never
// even attempted, so this is an honest information-limit answer, not a
// fallback, exactly like STRUCTURED_FIRST's own NOT_FOUND/
// NO_GROUNDED_EVIDENCE cases. A BudgetExceededError/RequestAbortedError
// from the SAME retriever.retrieve() call is explicitly NOT caught here --
// it is rethrown untouched so runAgentFlow's own generic budget/abort
// handling applies exactly as it would for any other SharedServices call
// this Flow makes; this Flow must never turn a budget/abort condition into
// a disguised "model succeeded" or "information limit" answer either.
//
// EXECUTION_MODE (this Turn's own taxonomy, distinct from
// STRUCTURED_FIRST's always-"STRUCTURED" choice): "STRUCTURED" when the
// final grounded set is sourced entirely from the Structured Store (whether
// because it was already sufficient, or because a Retriever attempt was
// made but contributed nothing usable); "BOTH" when at least one grounded
// entry's evidence was actually recovered via a validated Retriever chunk;
// "EARLY_EXIT" whenever nothing at all could be grounded (a safe, honest
// information-limit exit) -- "RETRIEVAL" alone is deliberately never
// produced, matching this Turn's explicit "Retrieval만 사용하도록 만들지
// 않는 것이 기본" instruction (this Flow has no code path that grounds an
// answer from retrieval evidence without an already-authorized Fact).
import { createHash } from "node:crypto";
import { BudgetExceededError, RejectedInputError } from "../../runtime/agent-runtime.mjs";
import { RequestAbortedError } from "../../runtime/abortable.mjs";
import { analyzeQuestion } from "./question-analysis.mjs";
import { verifyGeneratedAnswer } from "./hard-claim-grounding.mjs";
import { computePromptTemplateSha256 } from "../reproducibility.mjs";

const OFFICIAL_VERIFIED = Object.freeze(["VERIFIED"]);

// Fixed instructional text only -- NEVER includes per-question variable
// data, exactly like structured-first-agent.mjs's own template. Deliberately
// its own distinct prompt id/text (not a re-export of STRUCTURED_FIRST's),
// since prompt_template_sha256 pinning (BenchmarkRunManifest) is per-variant.
export const ANSWER_PROMPT_TEMPLATE_ID = "hybrid-retrieval-answer-prompt-v1";
export const ANSWER_PROMPT_TEMPLATE = [
  "다음은 이미 검증(VERIFIED)된 공시 Fact와, 그 Fact 자신의 근거로 검증에 성공한 인용문입니다.",
  "일부 인용문은 구조화 조회로, 일부는 부족한 근거를 보강하기 위한 검색(Retrieval)으로 확보되었지만 모두 동일하게 검증을 통과했습니다.",
  "아래 목록에 없는 수치나 사실을 새로 만들어내지 말고, 질문에 대해 이 목록의 값만 사용해 한국어로 간결하게 답하세요.",
  "반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요:",
  '{"answer": "<한국어 답변>", "used_fact_ids": ["<실제 사용한 fact_id>", ...], "used_evidence_ids": ["<실제 사용한 evidence_id>", ...]}',
].join("\n");
export const ANSWER_PROMPT_TEMPLATE_SHA256 = computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE);

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function makeStructuredQuery({ queryIdSuffix, targets, corp_codes, predicates, period_filter, scope_filter, context, as_of_date, limit }) {
  return {
    schema_version: "0.2.0",
    query_id: `query_hybrid_retrieval_${queryIdSuffix}`,
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
    period_filter: period_filter ?? { start: null, end: null, period_types: [] },
    scope_filter: scope_filter ?? [],
    verification_statuses: OFFICIAL_VERIFIED,
    as_of_date,
    limit: limit ?? 50,
  };
}

const CORP_CODE_PATTERN = /^[0-9]{8}$/;

// One combined RetrieverRequest for every still-ungrounded Fact this
// request found, never one per Fact -- this is what keeps "insufficient ->
// exactly one Retriever call" true regardless of how many Facts have a gap.
function buildRetrievalRequest({ question, questionId, context, as_of_date, corpCodes, documentIds, periodFilter, topK, retrievalMethod }) {
  return {
    schema_version: "0.1.0",
    query_id: `query_hybrid_retrieval_recovery_${sanitizeQueryIdFragment(questionId)}`,
    question,
    corpus_snapshot_id: context.corpus_snapshot_id,
    chunking_config_id: context.chunking_config_id,
    index_snapshot_id: context.index_snapshot_id,
    metadata_filters: {
      corp_codes: unique(corpCodes.filter((code) => CORP_CODE_PATTERN.test(code))),
      document_ids: unique(documentIds),
      doc_groups: [],
      doc_subtypes: [],
      base_years: [],
      base_months: [],
      receipt_date_from: periodFilter?.start ?? null,
      receipt_date_to: periodFilter?.end ?? null,
      is_correction: null,
      retrieval_eligible: true,
    },
    top_k: topK,
    retrieval_method: retrievalMethod,
  };
}

// Only fields already present on a validated Fact/Evidence record are ever
// placed in the ModelAdapter prompt -- identical rule to
// structured-first-agent.mjs's own buildAnswerPrompt, applied to a
// groundedFacts list that may now include Retrieval-recovered entries, but
// which are structurally indistinguishable from structured-sourced ones by
// the time they reach this function (see the file header's "WHY
// hard-claim-grounding.mjs NEEDS NO EXTENSION").
function buildAnswerPrompt(question, groundedFacts, ungroundedCount) {
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
      `evidence_ids=${JSON.stringify(entry.evidenceIds)}`,
      `evidence_quote=${JSON.stringify(entry.quotes)}`,
    ].join(", ");
  });
  const limitNote = ungroundedCount > 0
    ? `\n참고: ${ungroundedCount}건은 구조화 조회와 검색 보강 모두로도 근거를 검증하지 못해 이 목록에서 제외했습니다.`
    : "";
  return [
    ANSWER_PROMPT_TEMPLATE,
    "",
    `질문: ${question}`,
    "",
    "검증된 Fact 목록:",
    ...factLines,
    limitNote,
  ].join("\n");
}

function renderFallbackAnswer(groundedFacts, ungroundedCount) {
  const lines = groundedFacts.map((entry) => {
    const fact = entry.fact;
    const value = fact.unit ? `${fact.normalized_value} ${fact.unit}` : String(fact.normalized_value);
    return `- ${fact.metric_code} (${fact.corp_code}, ${fact.period_type}): ${value} [${fact.value_status}]`;
  });
  const limitNote = ungroundedCount > 0 ? `\n${ungroundedCount}건은 근거를 검증하지 못해 제외했습니다.` : "";
  return [...lines, limitNote].join("\n").trim();
}

const INFORMATION_LIMIT_MESSAGES = Object.freeze({
  NO_CONDITIONS: "질문에서 회사·기간·지표를 특정할 수 없어 답변할 수 없습니다. 회사명(corp_code)이나 지표명을 포함해 다시 질문해 주세요.",
  NOT_FOUND: "질문 조건에 해당하는 검증된(VERIFIED) 공시 Fact가 현재 corpus/coverage 범위에 없습니다.",
  QUERY_FAILED: "구조화 데이터 조회 중 문제가 발생하여 답변할 수 없습니다.",
  NO_GROUNDED_EVIDENCE: "관련 Fact는 있으나 구조화 조회와 검색 보강 모두로도 근거(Evidence) 검증에 실패하여 답변할 수 없습니다.",
  RETRIEVAL_FAILED: "관련 Fact는 있으나 근거 보강을 위한 검색(Retrieval)이 실패하여 답변할 수 없습니다.",
});

// Used for every path where the model was never even attempted (nothing to
// ground it with) -- NOT the same as a model-call-failure fallback. See
// this file's own EXECUTION_MODE header note: every information-limit path
// here is EARLY_EXIT (an honest "no evidence" exit), not "STRUCTURED".
function informationLimitOutcome(question, reason, operations) {
  return {
    final_response: {
      question,
      retrieved_context: [],
      think_trace: {
        execution_mode: "EARLY_EXIT",
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
      answer: INFORMATION_LIMIT_MESSAGES[reason] ?? INFORMATION_LIMIT_MESSAGES.QUERY_FAILED,
    },
  };
}

// The RETRIEVER_* codes (retriever-store.mjs) that mean "what came back
// actively conflicts with, or cannot be matched against, this evidence_id's
// own already-authorized identity" -- reused here only as an operations-
// trace annotation (never a scoring field), so a Retrieval-recovery attempt
// that conflicts with the trusted EvidenceStore is distinguishable in the
// trace from one that simply couldn't be verified at all.
const CONFLICT_EVIDENCE_CODES = Object.freeze([
  "EVIDENCE_QUOTE_MISMATCH",
  "EVIDENCE_HASH_MISMATCH",
  "EVIDENCE_DOCUMENT_MISMATCH",
  "EVIDENCE_LOCATOR_MISMATCH",
]);

export function createHybridRetrievalFlow(modelAdapter, options = {}) {
  if (!modelAdapter || typeof modelAdapter.generate !== "function") {
    throw new TypeError("createHybridRetrievalFlow requires a ModelAdapter with a generate(request) method");
  }
  const retrievalTopK = Number.isInteger(options.retrievalTopK) ? options.retrievalTopK : 10;
  const retrievalMethod = typeof options.retrievalMethod === "string" ? options.retrievalMethod : "BM25";

  return Object.freeze({
    id: "HYBRID_RETRIEVAL",
    async run(input, context, services) {
      const question = typeof input?.question === "string" ? input.question : "";
      const as_of_date = input?.as_of_date ?? context?.as_of_date ?? todayIso();
      const operations = [];
      const conditions = analyzeQuestion(input, options);
      operations.push({ step: "ANALYZE_QUESTION", corp_codes: conditions.corp_codes, metric_codes: conditions.metric_codes });

      if (conditions.corp_codes.length === 0 && conditions.metric_codes.length === 0 && conditions.document_ids.length === 0) {
        return informationLimitOutcome(question, "NO_CONDITIONS", operations);
      }

      // --- Step 2-3: Structured Store Fact/Evidence pass (identical to
      // STRUCTURED_FIRST) -----------------------------------------------
      const factQuery = makeStructuredQuery({
        queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_facts`,
        targets: ["FACT"],
        corp_codes: conditions.corp_codes,
        predicates: { metric_codes: conditions.metric_codes, document_ids: conditions.document_ids },
        period_filter: conditions.period_filter,
        scope_filter: conditions.scope_filter,
        context, as_of_date,
      });
      const factResult = await services.structuredStore.query(factQuery);
      operations.push({ step: "QUERY_FACTS", status: factResult.status, record_count: factResult.records.length });

      if (factResult.status === "NOT_FOUND") return informationLimitOutcome(question, "NOT_FOUND", operations);
      if (factResult.status !== "OK") return informationLimitOutcome(question, "QUERY_FAILED", operations);

      const facts = factResult.records.map((record) => record.payload);
      const evidenceIds = unique(facts.flatMap((fact) => fact.evidence_ids ?? []));
      const eventIds = unique(facts.map((fact) => fact.event_id));
      const factDocumentIds = unique(facts.map((fact) => fact.source_document_id));

      const [evidenceResult, eventResult, relationResult] = await Promise.all([
        evidenceIds.length > 0
          ? services.structuredStore.query(makeStructuredQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_evidence`,
              targets: ["EVIDENCE"], predicates: { evidence_ids: evidenceIds }, context, as_of_date, limit: evidenceIds.length,
            }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
        eventIds.length > 0
          ? services.structuredStore.query(makeStructuredQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_events`,
              targets: ["EVENT"], predicates: { event_ids: eventIds }, context, as_of_date, limit: eventIds.length,
            }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
        // Best-effort/informational only, exactly like STRUCTURED_FIRST --
        // never gates whether a Fact counts as grounded.
        factDocumentIds.length > 0
          ? services.structuredStore.query(makeStructuredQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_relations`,
              targets: ["RELATION"], predicates: { document_ids: factDocumentIds }, context, as_of_date, limit: 50,
            })).catch(() => ({ status: "ERROR", records: [] }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
      ]);
      operations.push({ step: "QUERY_EVIDENCE", status: evidenceResult.status, record_count: evidenceResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_EVENTS", status: eventResult.status, record_count: eventResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_RELATIONS", status: relationResult.status, record_count: relationResult.records?.length ?? 0 });

      const evidenceById = new Map((evidenceResult.records ?? []).map((record) => [record.payload.evidence_id, record.payload]));

      const groundedFacts = [];
      const ungroundedFacts = [];
      for (const fact of facts) {
        const candidateEvidence = (fact.evidence_ids ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
        const validatedQuotes = [];
        const validatedEvidenceIds = [];
        for (const evidence of candidateEvidence) {
          if (typeof evidence.quoted_text !== "string" || typeof evidence.quote_sha256 !== "string") continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await services.validator.validateEvidence({
              evidence_id: evidence.evidence_id,
              document_id: evidence.document_id,
              file_id: evidence.file_id,
              source_locator: evidence.source_locator,
              quoted_text: evidence.quoted_text,
              quote_sha256: evidence.quote_sha256,
              fact_ids: [fact.fact_id],
              scope: fact.scope,
              period: fact.period_type,
              value_status: fact.value_status,
              known_at: fact.known_at,
              valid_from: fact.valid_from,
              valid_to: fact.valid_to,
            });
            validatedQuotes.push(evidence.quoted_text);
            validatedEvidenceIds.push(evidence.evidence_id);
          } catch {
            // Unvalidated structured evidence is not used to ground this
            // Fact yet -- it may still be recovered via Retrieval below.
          }
        }
        if (validatedQuotes.length > 0) groundedFacts.push({ fact, quotes: validatedQuotes, evidenceIds: validatedEvidenceIds });
        else ungroundedFacts.push(fact);
      }

      // --- Step 4: deterministic sufficiency decision --------------------
      let retrievalAttempted = false;
      let retrievalFailed = false;
      let retrievalRecoveredCount = 0;

      if (ungroundedFacts.length > 0) {
        // Only Facts that themselves declare at least one evidence_id are
        // even candidates for Retrieval-backed recovery -- a Fact with no
        // evidence_ids at all has no already-authorized citation identity
        // for the Retriever to recover text for (see the file header's "WHY
        // RETRIEVAL NEVER REPLACES STRUCTURED LOOKUP").
        const recoverableFacts = ungroundedFacts.filter((fact) => (fact.evidence_ids ?? []).length > 0);
        if (recoverableFacts.length > 0) {
          const retrievalRequest = buildRetrievalRequest({
            question,
            questionId: input?.question_id,
            context,
            as_of_date,
            corpCodes: unique(recoverableFacts.map((fact) => fact.corp_code)),
            documentIds: unique(recoverableFacts.map((fact) => fact.source_document_id)),
            periodFilter: conditions.period_filter,
            topK: retrievalTopK,
            retrievalMethod,
          });

          let retrievalResult = null;
          try {
            retrievalAttempted = true;
            retrievalResult = await services.retriever.retrieve(retrievalRequest);
            operations.push({ step: "RETRIEVE", ok: true, result_count: retrievalResult.results.length });
          } catch (error) {
            if (error instanceof BudgetExceededError || error instanceof RequestAbortedError) throw error;
            const errorCode = error instanceof RejectedInputError ? error.code : "RETRIEVER_ERROR";
            operations.push({ step: "RETRIEVE", ok: false, error_code: errorCode });
            retrievalFailed = true;
          }

          if (retrievalResult) {
            const itemsByDocument = new Map();
            for (const item of retrievalResult.results) {
              if (!itemsByDocument.has(item.document_id)) itemsByDocument.set(item.document_id, []);
              itemsByDocument.get(item.document_id).push(item);
            }

            for (const fact of recoverableFacts) {
              const candidateItems = itemsByDocument.get(fact.source_document_id) ?? [];
              let recovered = false;
              for (const evidenceId of fact.evidence_ids) {
                if (recovered) break;
                for (const item of candidateItems) {
                  const sourceSpan = item.source_spans?.[0];
                  if (!sourceSpan) continue;
                  const quotedText = item.raw_text;
                  const bundle = {
                    evidence_id: evidenceId,
                    document_id: item.document_id,
                    file_id: sourceSpan.file_id,
                    source_locator: item.source_locator,
                    quoted_text: quotedText,
                    quote_sha256: sha256Hex(quotedText),
                    fact_ids: [fact.fact_id],
                    scope: fact.scope,
                    period: fact.period_type,
                    value_status: fact.value_status,
                    known_at: fact.known_at,
                    valid_from: fact.valid_from,
                    valid_to: fact.valid_to,
                  };
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    await services.validator.validateEvidence(bundle);
                    groundedFacts.push({ fact, quotes: [quotedText], evidenceIds: [evidenceId] });
                    retrievalRecoveredCount += 1;
                    recovered = true;
                    operations.push({ step: "VALIDATE_RETRIEVED_EVIDENCE", ok: true, conflict: false });
                    break;
                  } catch (error) {
                    const code = error instanceof RejectedInputError ? error.code : null;
                    // Fail-closed either way: this candidate is simply never
                    // added to groundedFacts. The CONFLICT distinction is
                    // trace-only (never a scoring field) -- see this file's
                    // header note "FAIL-CLOSED ON CONFLICT".
                    operations.push({ step: "VALIDATE_RETRIEVED_EVIDENCE", ok: false, conflict: CONFLICT_EVIDENCE_CODES.includes(code), error_code: code });
                  }
                }
              }
            }
          }
        }
      }

      const ungroundedCount = facts.length - groundedFacts.length;

      if (groundedFacts.length === 0) {
        if (retrievalFailed) return informationLimitOutcome(question, "RETRIEVAL_FAILED", operations);
        return informationLimitOutcome(question, "NO_GROUNDED_EVIDENCE", operations);
      }

      const usedRetrieval = retrievalRecoveredCount > 0;
      const executionMode = usedRetrieval ? "BOTH" : "STRUCTURED";

      const authorizedFactIds = new Set(groundedFacts.map((entry) => entry.fact.fact_id));
      // Deduplicated by construction: each (fact, evidence_id) pair is only
      // ever pushed into groundedFacts once (structured pass) or once per
      // successfully-recovered evidence_id (retrieval pass, which stops at
      // the first validated candidate per evidence_id) -- see
      // "중복 Evidence 제거" in this variant's tests.
      const validatedEvidenceIds = new Set(groundedFacts.flatMap((entry) => entry.evidenceIds));

      // --- model call + post-generation grounding (same contract
      // STRUCTURED_FIRST uses, unmodified) --------------------------------
      let answer;
      let citationBindingStatus;
      let unsupportedClaimCount = 0;
      let modelFallbackUsed;
      let selectedEvidenceIds = groundedFacts.flatMap((entry) => entry.evidenceIds);

      try {
        const generated = await modelAdapter.generate({ prompt: buildAnswerPrompt(question, groundedFacts, ungroundedCount) });
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
          answer = generated.text;
          citationBindingStatus = "PASS";
          modelFallbackUsed = false;
          if (Array.isArray(generated.used_evidence_ids) && generated.used_evidence_ids.length > 0) {
            selectedEvidenceIds = generated.used_evidence_ids;
          }
        } else {
          answer = renderFallbackAnswer(groundedFacts, ungroundedCount);
          citationBindingStatus = "FAIL";
          unsupportedClaimCount = verdict.unsupportedClaimCount;
          modelFallbackUsed = true;
        }
      } catch (error) {
        const modelFailureCode = typeof error?.code === "string" ? error.code : "MODEL_CALL_UNKNOWN_ERROR";
        operations.push({ step: "MODEL_CALL", ok: false, error_code: modelFailureCode });
        answer = renderFallbackAnswer(groundedFacts, ungroundedCount);
        citationBindingStatus = "NOT_CHECKED";
        modelFallbackUsed = true;
      }

      const relationContext = (relationResult.records ?? []).map((record) => ({
        relation_id: record.record_id,
        relation_type: record.payload?.relation_type ?? null,
      }));
      const eventContext = (eventResult.records ?? []).map((record) => ({
        event_id: record.record_id,
        event_type: record.payload?.event_type ?? null,
      }));

      return {
        final_response: {
          question,
          retrieved_context: [
            ...groundedFacts.map((entry) => ({ fact_id: entry.fact.fact_id, quotes: entry.quotes })),
            ...eventContext,
            ...relationContext,
          ],
          think_trace: {
            execution_mode: executionMode,
            operations,
            calculation: {},
            validation: {
              answerability: "SUPPORTED",
              grounded_fact_count: groundedFacts.length,
              ungrounded_fact_count: ungroundedCount,
              retrieval_attempted: retrievalAttempted,
              retrieval_recovered_count: retrievalRecoveredCount,
              citation_binding_status: citationBindingStatus,
              unsupported_claim_count: unsupportedClaimCount,
              model_fallback_used: modelFallbackUsed,
              scoring_eligible: !modelFallbackUsed,
            },
          },
          answer,
        },
        execution_trace: {
          selected_evidence: selectedEvidenceIds,
        },
      };
    },
  });
}
