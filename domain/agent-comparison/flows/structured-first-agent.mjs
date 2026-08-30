// STRUCTURED_FIRST Agent variant (Turn P1; hardened Turn P1.1). An
// ordinary AgentFlow (CLAUDE.md sections 4-7): `{ id, async run(input,
// context, services) }`, executed through the existing, unmodified
// domain/runtime/agent-runtime.mjs's runAgentFlow -- it reuses AgentInput,
// FinalResponse, StructuredQuery/StructuredResult, and SharedServices
// exactly as they already exist. This file adds no new frozen contract; it
// is one more Flow plugged into the existing one.
//
// Design (the 8 steps CLAUDE.md's Turn P1 brief asks for):
//   1. analyzeQuestion() reads the raw question (+ optional hints).
//   2. builds corp_codes/metric_codes/period_filter/scope_filter conditions.
//   3. queries services.structuredStore (StructuredQuery -> StructuredResult).
//   4. execution_scope is ALWAYS "OFFICIAL" and verification_statuses is
//      ALWAYS ["VERIFIED"] -- this Flow never asks for CANDIDATE/REJECTED/
//      PARSE_BLOCKED data, so it can only ever see Coverage-authorized,
//      VERIFIED Fact records.
//   5. Evidence/Event/Relation enrichment: every cited Fact's evidence_ids
//      are queried and passed through services.validator.validateEvidence
//      before being trusted; the Fact's event_id (if any) and its source
//      document's Relations are queried for context.
//   6. if at least one Fact has validated evidence, an answer is composed
//      via the injected ModelAdapter -- but the RAW model output is never
//      trusted as-is (Turn P1.1): see the GROUNDING step below.
//   7. if nothing could be grounded, the answer states the information
//      limit in Korean instead of guessing.
//   8. no value is ever invented: the ModelAdapter's prompt contains only
//      already-validated fact/evidence payload fields, and both the
//      post-generation grounding check and the deterministic fallback
//      renderer only ever use fields taken verbatim from a validated Fact.
//
// GROUNDING (Turn P1.1, new): a model-generated answer is never returned
// as-is. The ModelAdapter returns { text, used_fact_ids, used_evidence_ids,
// ... } (see model-adapter.mjs's RESPONSE CONTRACT); this Flow verifies
// (flows/hard-claim-grounding.mjs) that (a) every used_fact_id/
// used_evidence_id was actually authorized+validated THIS request, and (b)
// every hard claim (number/date/document id) extracted from the answer
// text is present in this request's own grounded Fact/Evidence data. A
// failure of either check DISCARDS the generated answer entirely and
// substitutes the same deterministic, fully-grounded fallback renderer
// used when the model call itself fails -- see FAILURE/FALLBACK ACCOUNTING
// below. This never re-inserts a partially-fixed version of the model's
// answer; the whole generated answer is thrown away.
//
// FAILURE/FALLBACK ACCOUNTING (Turn P1.1, new): this Flow always records,
// in `final_response.think_trace.validation`, whether a fallback was used
// (`model_fallback_used`), why (`citation_binding_status`,
// `unsupported_claim_count`), and whether this run should count toward a
// model-quality comparison (`scoring_eligible`) -- see telemetry.mjs's
// buildTelemetryEvent, which reads these fields verbatim. A model CALL
// failure (network/timeout/malformed response -- caught from
// modelAdapter.generate() itself) is distinguished from a POST-GENERATION
// grounding failure (the call succeeded, but its answer was rejected) by
// citation_binding_status: NOT_CHECKED for the former (there was never any
// text to check), FAIL for the latter. Both count as
// model_fallback_used=true/scoring_eligible=false. A question this Flow
// never even attempts to call the model for (no grounded facts at all) is
// its own third case: model_fallback_used=false, scoring_eligible=true --
// an honest information-limit answer is not a "fallback".
import { analyzeQuestion } from "./question-analysis.mjs";
import { verifyGeneratedAnswer } from "./hard-claim-grounding.mjs";
import { computePromptTemplateSha256 } from "../reproducibility.mjs";

const OFFICIAL_VERIFIED = Object.freeze(["VERIFIED"]);

// Fixed instructional text only -- NEVER includes per-question variable
// data (the question itself, facts, quotes). This is what
// prompt_template_sha256 (BenchmarkRunManifest) pins; the per-question
// filled prompt built in buildAnswerPrompt() below is never stored
// anywhere as Gold/reference data.
export const ANSWER_PROMPT_TEMPLATE_ID = "structured-first-answer-prompt-v1";
export const ANSWER_PROMPT_TEMPLATE = [
  "다음은 이미 검증(VERIFIED)된 공시 Fact와 근거 인용문입니다.",
  "아래 목록에 없는 수치나 사실을 새로 만들어내지 말고, 질문에 대해 이 목록의 값만 사용해 한국어로 간결하게 답하세요.",
  "반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요:",
  '{"answer": "<한국어 답변>", "used_fact_ids": ["<실제 사용한 fact_id>", ...], "used_evidence_ids": ["<실제 사용한 evidence_id>", ...]}',
].join("\n");
export const ANSWER_PROMPT_TEMPLATE_SHA256 = computePromptTemplateSha256(ANSWER_PROMPT_TEMPLATE);

function sanitizeQueryIdFragment(value) {
  const lowered = typeof value === "string" ? value.toLowerCase() : "q";
  const cleaned = lowered.replace(/[^a-z0-9_.-]/g, "_");
  return cleaned === "" ? "q" : cleaned;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function makeQuery({ queryIdSuffix, targets, corp_codes, predicates, period_filter, scope_filter, context, as_of_date, limit }) {
  return {
    schema_version: "0.2.0",
    query_id: `query_structured_first_${queryIdSuffix}`,
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

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

// Only fields already present on a validated Fact/Evidence record are ever
// placed in the ModelAdapter prompt -- nothing derived from the question
// text itself is echoed back as if it were a fact.
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
    ? `\n참고: ${ungroundedCount}건은 근거를 검증하지 못해 이 목록에서 제외했습니다.`
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
  NO_GROUNDED_EVIDENCE: "관련 Fact는 있으나 근거(Evidence) 검증에 실패하여 답변할 수 없습니다.",
});

// Used for every path where the model was never even attempted (nothing to
// ground it with) -- NOT the same as a model-call-failure fallback. See
// this file's own FAILURE/FALLBACK ACCOUNTING header comment.
function informationLimitOutcome(question, reason, operations) {
  return {
    final_response: {
      question,
      retrieved_context: [],
      think_trace: {
        execution_mode: "STRUCTURED",
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

export function createStructuredFirstFlow(modelAdapter, options = {}) {
  if (!modelAdapter || typeof modelAdapter.generate !== "function") {
    throw new TypeError("createStructuredFirstFlow requires a ModelAdapter with a generate(request) method");
  }
  return Object.freeze({
    id: "STRUCTURED_FIRST",
    async run(input, context, services) {
      const question = typeof input?.question === "string" ? input.question : "";
      const as_of_date = input?.as_of_date ?? context?.as_of_date ?? todayIso();
      const operations = [];
      const conditions = analyzeQuestion(input, options);
      operations.push({ step: "ANALYZE_QUESTION", corp_codes: conditions.corp_codes, metric_codes: conditions.metric_codes });

      if (conditions.corp_codes.length === 0 && conditions.metric_codes.length === 0 && conditions.document_ids.length === 0) {
        return informationLimitOutcome(question, "NO_CONDITIONS", operations);
      }

      const factQuery = makeQuery({
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
          ? services.structuredStore.query(makeQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_evidence`,
              targets: ["EVIDENCE"], predicates: { evidence_ids: evidenceIds }, context, as_of_date, limit: evidenceIds.length,
            }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
        eventIds.length > 0
          ? services.structuredStore.query(makeQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_events`,
              targets: ["EVENT"], predicates: { event_ids: eventIds }, context, as_of_date, limit: eventIds.length,
            }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
        // Relation enrichment is best-effort/informational only (e.g.
        // surfacing that a source document was later AMENDS-corrected) --
        // it never gates whether a Fact counts as grounded, and a failure
        // here is swallowed rather than turned into an information-limit
        // answer for what is otherwise a fully supported Fact.
        factDocumentIds.length > 0
          ? services.structuredStore.query(makeQuery({
              queryIdSuffix: `${sanitizeQueryIdFragment(input?.question_id)}_relations`,
              targets: ["RELATION"], predicates: { document_ids: factDocumentIds }, context, as_of_date, limit: 50,
            })).catch(() => ({ status: "ERROR", records: [] }))
          : Promise.resolve({ status: "NOT_FOUND", records: [] }),
      ]);
      operations.push({ step: "QUERY_EVIDENCE", status: evidenceResult.status, record_count: evidenceResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_EVENTS", status: eventResult.status, record_count: eventResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_RELATIONS", status: relationResult.status, record_count: relationResult.records?.length ?? 0 });

      // The Fact's own evidence_ids is the only authoritative fact<->evidence
      // link (semantic-bundle.schema.json's Evidence $def carries no
      // fact_ids back-reference at all -- the real VERIFIED Evidence corpus
      // never populates one; only the Fact side does).
      const evidenceById = new Map((evidenceResult.records ?? []).map((record) => [record.payload.evidence_id, record.payload]));

      const groundedFacts = [];
      let ungroundedCount = 0;
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
            // Unvalidated evidence is simply not used to ground this Fact --
            // never surfaced as if it were confirmed.
          }
        }
        if (validatedQuotes.length > 0) groundedFacts.push({ fact, quotes: validatedQuotes, evidenceIds: validatedEvidenceIds });
        else ungroundedCount += 1;
      }

      if (groundedFacts.length === 0) return informationLimitOutcome(question, "NO_GROUNDED_EVIDENCE", operations);

      const authorizedFactIds = new Set(groundedFacts.map((entry) => entry.fact.fact_id));
      const validatedEvidenceIds = new Set(groundedFacts.flatMap((entry) => entry.evidenceIds));

      // --- model call + post-generation grounding (Turn P1.1) -----------
      let answer;
      let citationBindingStatus;
      let unsupportedClaimCount = 0;
      let modelFallbackUsed;
      // The all-grounded-evidence set is the safe default "what actually
      // grounds this answer" claim -- used whenever the returned answer is
      // the deterministic fallback (built from ALL groundedFacts). Only
      // narrowed to the model's own (already citation-bound-verified)
      // used_evidence_ids when its generated answer actually PASSED and was
      // kept, matching the same "Flow may narrow to what it actually used"
      // pattern agent-runtime.mjs's runAgentFlow itself documents.
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
          // Post-generation grounding rejected the model's own answer: the
          // WHOLE generated answer is discarded (never partially patched),
          // and a fully deterministic, already-grounded rendering is used
          // instead. The model call itself succeeded, so there is no
          // model_failure_code here -- only citation_binding_status=FAIL
          // distinguishes this from a genuine call failure below.
          answer = renderFallbackAnswer(groundedFacts, ungroundedCount);
          citationBindingStatus = "FAIL";
          unsupportedClaimCount = verdict.unsupportedClaimCount;
          modelFallbackUsed = true;
        }
      } catch (error) {
        // The model call itself failed (timeout/HTTP/malformed response/
        // unavailable -- see model-adapter.mjs's ModelCallError). There was
        // no generated text to check at all.
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
            execution_mode: "STRUCTURED",
            operations,
            calculation: {},
            validation: {
              answerability: "SUPPORTED",
              grounded_fact_count: groundedFacts.length,
              ungrounded_fact_count: ungroundedCount,
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
