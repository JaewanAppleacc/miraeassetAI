// PLANNER Agent variant (Turn P2-P). An ordinary AgentFlow (CLAUDE.md
// sections 4-7): `{ id, async run(input, context, services) }`, executed
// through the SAME unmodified domain/runtime/agent-runtime.mjs's
// runAgentFlow every other variant uses. This file adds no new frozen
// contract and invents no new ontology, slot naming scheme, or
// "sub_request_authority" concept -- it decomposes a question into a
// small, bounded set of independent StructuredStore sub-requests, using
// only flows/question-analysis.mjs's existing condition-extraction (over
// the existing, frozen domain/facts/metric-ontology.v0.1.json) as its
// planning input. STRUCTURED_FIRST already answers a single condition set
// in one shot; PLANNER's whole difference is: when a question implies
// SEVERAL independent requirements (e.g. several metric_codes), each one
// becomes its own bounded, individually-gradeable sub-request, so a
// partial failure on one requirement is reported honestly instead of
// silently sinking (or silently padding) the whole answer.
//
// PLAN (the 9 steps this Turn's brief asks for):
//   1. analyzeQuestion() (reused, not duplicated) reads the raw question +
//      any hints -> corp_codes/metric_codes/document_ids/period_filter/
//      scope_filter.
//   2. buildPlanTargets() decides which of those conditions are concrete,
//      plannable data targets: a metric_code that exists in the existing
//      metric ontology, or an explicit document_id. A metric_code that
//      does NOT exist in the ontology is never planned -- see UNKNOWN
//      METRIC HANDLING below.
//   3. buildPlanSteps() turns the target set into a bounded, deterministic,
//      deduplicated plan -- see PLAN DETERMINISM below.
//   4. runStep() queries services.structuredStore for each step (FACT,
//      execution_scope OFFICIAL, verification_statuses VERIFIED only --
//      identical invariant to STRUCTURED_FIRST), and -- only when a step's
//      own target is a document_id, the step could not be satisfied via
//      StructuredStore, and the caller explicitly opted in via
//      input.hints.enable_retrieval_fallback -- also asks
//      services.retriever.retrieve() for that one document. See RETRIEVER
//      USE below for why this is opt-in and never grounding.
//   5. Every step's Fact is evidence-validated through
//      services.validator.validateEvidence() (same as STRUCTURED_FIRST)
//      before being trusted, and is re-checked against the step that asked
//      for it (factMatchesStep) -- see CROSS-ATTRIBUTION GUARD below.
//   6. groundedByStep combines every step's validated result.
//   7. if at least one step is grounded, an answer is composed via the
//      injected ModelAdapter -- the SAME post-generation grounding
//      (flows/hard-claim-grounding.mjs's verifyGeneratedAnswer, reused
//      unmodified) STRUCTURED_FIRST uses gates whether that generated text
//      is trusted.
//   8. every step's status (OK/NOT_FOUND/ERROR/UNGROUNDED) is recorded, and
//      any step that did not ground a Fact is named, with its own reason,
//      in both the prompt's limit note and the deterministic fallback
//      renderer -- never silently dropped. See PARTIAL SUCCESS below.
//   9. a failure (model call failure, or a generated answer that fails
//      post-generation grounding) always falls back to the same
//      deterministic, fully-grounded renderer STRUCTURED_FIRST uses this
//      pattern for -- see FAILURE/FALLBACK ACCOUNTING below, identical to
//      flows/structured-first-agent.mjs's own.
//
// PLAN DETERMINISM: a plan step's ordering never depends on the order
// hints/question text happened to list its targets in -- metric_code
// targets are deduplicated into a Set then SORTED, document_id targets the
// same, metric steps always precede document steps. Two requests that ask
// for the same target set in a different order therefore produce the
// EXACT SAME plan (same step order, same step_ids) and, because every
// step's StructuredStore query and prompt fact-line are built purely from
// the step's own target (never from "which step happened to run first"),
// the exact same final answer text -- see
// tests/agent-comparison-planner.test.mjs's own order-invariance test.
//
// UNKNOWN METRIC HANDLING: a metric_code that is not a member of the
// existing metric ontology (domain/facts/metric-ontology.v0.1.json) is
// never turned into a plan step, never queried, and never silently
// dropped either -- it is recorded in `rejected_targets` with reason
// UNKNOWN_METRIC, and (when it is the ONLY thing asked for) the whole
// request is answered as an honest information limit, the same as
// STRUCTURED_FIRST's NO_CONDITIONS case. This is the concrete meaning of
// "Planner reads the existing ontology, it does not extend it": an
// unrecognized metric name is a limitation to report, never a new slot to
// invent.
//
// MAX PLAN STEPS / FAIL-CLOSED: DEFAULT_MAX_PLAN_STEPS (below) bounds how
// many independent sub-requests a single call will ever plan. A question
// that resolves to MORE distinct valid targets than the bound is refused
// OUTRIGHT -- zero steps are executed, zero StructuredStore/Retriever
// calls are made, and the model is never called -- rather than silently
// truncating the plan to an arbitrary subset of what was asked. This is a
// deliberate fail-closed choice: a truncated plan could quietly answer
// only part of a multi-part question while looking like a complete
// answer; refusing outright cannot.
//
// CROSS-ATTRIBUTION GUARD: `factMatchesStep` re-checks, AFTER
// StructuredStore has already applied its own filters, that a candidate
// Fact's own metric_code/source_document_id and (when the question named
// one) corp_code actually match the ONE step that queried for it, before
// that Fact is allowed into that step's grounded set. This exists so a
// misbehaving or overly-permissive StructuredStore adapter can never let
// one step's result "leak" a different company's, period's, or metric's
// value into another step's answer -- each step's grounded Fact set is
// only ever built from records that independently satisfy that step's own
// target, never from "whatever the batched query happened to return".
//
// PARTIAL SUCCESS: `missing_targets` in
// `final_response.think_trace.validation` names every plan step that did
// not ground a Fact, with a real reason (NOT_FOUND / QUERY_FAILED /
// NO_GROUNDED_EVIDENCE) -- both the model prompt and the deterministic
// fallback renderer state this explicitly (as an information-limit note)
// rather than presenting a partial answer as if it were complete.
//
// RETRIEVER USE: services.retriever.retrieve() is called only when (a) a
// step's target is an explicit document_id, (b) that step could not be
// satisfied via StructuredStore, (c) the caller explicitly opted in via
// input.hints.enable_retrieval_fallback, and (d) `context` actually carries
// the chunking_config_id/index_snapshot_id triple a RetrieverRequest needs
// (see domain/runtime/retriever-store.mjs) -- otherwise it is skipped
// entirely (document_retrieval_count stays 0, exactly like
// STRUCTURED_FIRST). Its result is NEVER treated as grounding: it is
// recorded (hit count only) as informational context, never added to
// `groundedByStep`, never added to the ModelAdapter prompt's Fact list, and
// never widens what flows/hard-claim-grounding.mjs's verifyGeneratedAnswer
// will accept -- exactly the same "no new Fact is ever invented" rule
// STRUCTURED_FIRST already follows, just spelled out for the one boundary
// this variant additionally touches.
//
// CALCULATION (optional, hint-driven only -- never model-driven, never
// inferred from free text): when `input.hints.calculation` names a formula
// and two metric_code plan targets, attemptCalculation() looks up each
// target's OWN already-grounded Fact (only if that step grounded EXACTLY
// ONE Fact -- an ambiguous multi-Fact step is never guessed at), builds a
// CalculationInput pair from real, validated fields, gets a proof via
// services.validator.validateFacts(), and calls services.calculator.calculate()
// -- the SAME frozen Calculator contract every other variant uses. An
// unsupported formula is never implemented locally: it is passed straight
// to services.calculator.calculate(), which itself rejects anything
// outside its own frozen CALCULATOR_FORMULAS list (see
// domain/runtime/agent-runtime.mjs) with a RejectedInputError this module
// only catches and records (CALCULATION_REJECTED), never works around. A
// successful CalculationResult is placed in `think_trace.calculation` (the
// free-form field final-response.schema.json already reserves for this)
// and appended as its OWN clearly-labeled, deterministically-rendered
// line -- never inserted into the ModelAdapter prompt and never merged
// into `groundedByStep` -- so it can never be mistaken for a Fact, and the
// post-generation grounding check the model's own generated text goes
// through is completely unaffected by whether a calculation ran.
//
// FAILURE/FALLBACK ACCOUNTING: identical semantics to
// flows/structured-first-agent.mjs's own header comment -- citation_binding_status
// NOT_CHECKED for a model CALL failure (no text was ever produced),
// FAIL for a generated answer whose citations/hard-claims did not check
// out (whole answer discarded, deterministic fallback substituted), PASS
// for a kept, fully-verified generated answer. Both NOT_CHECKED-fallback
// and FAIL-fallback are model_fallback_used=true/scoring_eligible=false;
// an honest information-limit answer (the model was never even attempted)
// is its own third case: model_fallback_used=false/scoring_eligible=true.
import { analyzeQuestion, loadMetricOntology } from "./question-analysis.mjs";
import { verifyCitationBinding, verifyHardClaims } from "./hard-claim-grounding.mjs";
import { computePromptTemplateSha256 } from "../reproducibility.mjs";

export const DEFAULT_MAX_PLAN_STEPS = 8;

// Fixed instructional text only -- never per-question variable data (see
// flows/structured-first-agent.mjs's identical rule for
// ANSWER_PROMPT_TEMPLATE, which this mirrors).
export const PLANNER_PROMPT_TEMPLATE_ID = "planner-answer-prompt-v1";
export const PLANNER_PROMPT_TEMPLATE = [
  "다음은 이 질문을 여러 개의 독립적인 요구사항으로 나누어 각각 조회한, 이미 검증(VERIFIED)된 공시 Fact와 근거 인용문입니다.",
  "각 요구사항 아래에 나열된 값만 사용하고, 목록에 없는 수치나 사실을 새로 만들어내지 마세요. 한국어로 간결하게 답하세요.",
  "반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요:",
  '{"answer": "<한국어 답변>", "used_fact_ids": ["<실제 사용한 fact_id>", ...], "used_evidence_ids": ["<실제 사용한 evidence_id>", ...]}',
].join("\n");
export const PLANNER_PROMPT_TEMPLATE_SHA256 = computePromptTemplateSha256(PLANNER_PROMPT_TEMPLATE);

const INFORMATION_LIMIT_MESSAGES = Object.freeze({
  NO_CONDITIONS: "질문에서 회사·기간·지표를 특정할 수 없어 계획을 세울 수 없습니다. 회사명(corp_code)이나 지표명을 포함해 다시 질문해 주세요.",
  UNKNOWN_METRIC_ONLY: "질문에서 지목한 지표가 현재 metric ontology에 없어 계획을 세울 수 없습니다.",
  PLAN_STEP_LIMIT_EXCEEDED: "요구사항 수가 처리 가능한 최대 단계 수를 초과하여 계획을 세울 수 없습니다.",
  NOT_FOUND: "계획한 요구사항 모두에 대해 현재 corpus/coverage 범위에 검증된(VERIFIED) 공시 Fact가 없습니다.",
  QUERY_FAILED: "구조화 데이터 조회 중 문제가 발생하여 답변할 수 없습니다.",
  NO_GROUNDED_EVIDENCE: "관련 Fact는 있으나 근거(Evidence) 검증에 실패하여 답변할 수 없습니다.",
});

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

// --- step 1-2: question analysis -> plannable targets ---------------------

function buildPlanTargets(conditions, ontologyMetricCodes) {
  const metricCodes = unique(conditions.metric_codes).sort();
  const knownMetricCodes = metricCodes.filter((code) => ontologyMetricCodes.has(code));
  const unknownMetricCodes = metricCodes.filter((code) => !ontologyMetricCodes.has(code));
  const documentIds = unique(conditions.document_ids).sort();
  return Object.freeze({ knownMetricCodes, unknownMetricCodes, documentIds });
}

// --- step 3: deterministic, bounded, deduplicated plan ---------------------

function buildPlanSteps(knownMetricCodes, documentIds) {
  const targets = [
    ...knownMetricCodes.map((metric_code) => ({ kind: "METRIC", metric_code })),
    ...documentIds.map((document_id) => ({ kind: "DOCUMENT", document_id })),
  ];
  return targets.map((target, index) => Object.freeze({ step_id: `plan_step_${index + 1}`, ...target }));
}

function stepLabel(step) {
  return step.kind === "METRIC" ? `metric=${step.metric_code}` : `document=${step.document_id}`;
}

// --- step 4: per-step StructuredStore query ---------------------------------

function makeStepQuery({ step, queryIdSuffix, corp_codes, period_filter, scope_filter, context, as_of_date }) {
  const predicates = step.kind === "METRIC" ? { metric_codes: [step.metric_code] } : { document_ids: [step.document_id] };
  return {
    schema_version: "0.2.0",
    query_id: `query_planner_${queryIdSuffix}_${step.step_id}`,
    execution_scope: "OFFICIAL",
    corpus_snapshot_id: context.corpus_snapshot_id,
    fact_coverage_snapshot_id: context.fact_coverage_snapshot_id ?? null,
    targets: ["FACT"],
    corp_codes: corp_codes ?? [],
    predicates: {
      metric_codes: [], event_types: [], relation_types: [], document_ids: [],
      fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [],
      ...predicates,
    },
    period_filter: period_filter ?? { start: null, end: null, period_types: [] },
    scope_filter: scope_filter ?? [],
    verification_statuses: ["VERIFIED"],
    as_of_date,
    limit: 50,
  };
}

// step 5 (part 1): re-check a candidate Fact against the ONE step that
// queried for it -- see CROSS-ATTRIBUTION GUARD in this file's header.
function factMatchesStep(fact, step, corp_codes) {
  if (corp_codes.length > 0 && !corp_codes.includes(fact.corp_code)) return false;
  if (step.kind === "METRIC") return fact.metric_code === step.metric_code;
  return fact.source_document_id === step.document_id;
}

async function runStep(step, { services, corp_codes, period_filter, scope_filter, context, as_of_date, queryIdSuffix }) {
  let result;
  try {
    result = await services.structuredStore.query(
      makeStepQuery({ step, queryIdSuffix, corp_codes, period_filter, scope_filter, context, as_of_date }),
    );
  } catch (error) {
    return { step, status: "ERROR", facts: [], error_code: typeof error?.code === "string" ? error.code : "QUERY_FAILED" };
  }
  if (result.status === "OK") {
    const facts = result.records.map((record) => record.payload).filter((fact) => factMatchesStep(fact, step, corp_codes));
    return facts.length > 0 ? { step, status: "OK", facts } : { step, status: "NOT_FOUND", facts: [] };
  }
  if (result.status === "NOT_FOUND") return { step, status: "NOT_FOUND", facts: [] };
  return { step, status: "ERROR", facts: [], error_code: result.status };
}

// --- step 4 (optional) / RETRIEVER USE: opt-in, never grounding ------------

function buildRetrieverRequest({ step, context, question, corp_codes, queryIdSuffix }) {
  return {
    schema_version: "0.1.0",
    query_id: `query_planner_retrieval_${queryIdSuffix}_${step.step_id}`,
    question,
    corpus_snapshot_id: context.corpus_snapshot_id,
    chunking_config_id: context.chunking_config_id,
    index_snapshot_id: context.index_snapshot_id,
    metadata_filters: {
      corp_codes: corp_codes ?? [],
      document_ids: [step.document_id],
      doc_groups: [], doc_subtypes: [], base_years: [], base_months: [],
      receipt_date_from: null, receipt_date_to: null, is_correction: null, retrieval_eligible: true,
    },
    top_k: 5,
    retrieval_method: "BM25",
  };
}

async function attemptRetrievalFallback({ step, services, context, question, corp_codes, queryIdSuffix, enabled }) {
  if (!enabled || step.kind !== "DOCUMENT") return null;
  if (typeof context.chunking_config_id !== "string" || typeof context.index_snapshot_id !== "string") return null;
  try {
    const result = await services.retriever.retrieve(buildRetrieverRequest({ step, context, question, corp_codes, queryIdSuffix }));
    return { attempted: true, ok: true, hit_count: Array.isArray(result?.results) ? result.results.length : 0 };
  } catch (error) {
    return { attempted: true, ok: false, error_code: typeof error?.code === "string" ? error.code : "RETRIEVER_FAILED" };
  }
}

// --- step 5 (part 2) / 6: Evidence enrichment + validation -> groundedByStep

async function groundStepFacts(stepResults, { services, queryIdSuffix, context, as_of_date }) {
  const allFacts = stepResults.flatMap((entry) => entry.facts);
  const evidenceIds = unique(allFacts.flatMap((fact) => fact.evidence_ids ?? []));
  const eventIds = unique(allFacts.map((fact) => fact.event_id));
  const documentIds = unique(allFacts.map((fact) => fact.source_document_id));

  const [evidenceResult, eventResult, relationResult] = await Promise.all([
    evidenceIds.length > 0
      ? services.structuredStore.query({
          schema_version: "0.2.0", query_id: `query_planner_${queryIdSuffix}_evidence`, execution_scope: "OFFICIAL",
          corpus_snapshot_id: context.corpus_snapshot_id, fact_coverage_snapshot_id: context.fact_coverage_snapshot_id ?? null,
          targets: ["EVIDENCE"], corp_codes: [],
          predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: evidenceIds },
          period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
          verification_statuses: ["VERIFIED"], as_of_date, limit: evidenceIds.length,
        })
      : Promise.resolve({ status: "NOT_FOUND", records: [] }),
    eventIds.length > 0
      ? services.structuredStore.query({
          schema_version: "0.2.0", query_id: `query_planner_${queryIdSuffix}_events`, execution_scope: "OFFICIAL",
          corpus_snapshot_id: context.corpus_snapshot_id, fact_coverage_snapshot_id: context.fact_coverage_snapshot_id ?? null,
          targets: ["EVENT"], corp_codes: [],
          predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: eventIds, relation_ids: [], evidence_ids: [] },
          period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
          verification_statuses: ["VERIFIED"], as_of_date, limit: eventIds.length,
        })
      : Promise.resolve({ status: "NOT_FOUND", records: [] }),
    // Best-effort/informational only -- same rule as STRUCTURED_FIRST: a
    // Relation lookup failure never gates whether a Fact counts as grounded.
    documentIds.length > 0
      ? services.structuredStore.query({
          schema_version: "0.2.0", query_id: `query_planner_${queryIdSuffix}_relations`, execution_scope: "OFFICIAL",
          corpus_snapshot_id: context.corpus_snapshot_id, fact_coverage_snapshot_id: context.fact_coverage_snapshot_id ?? null,
          targets: ["RELATION"], corp_codes: [],
          predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: documentIds, fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
          period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
          verification_statuses: ["VERIFIED"], as_of_date, limit: 50,
        }).catch(() => ({ status: "ERROR", records: [] }))
      : Promise.resolve({ status: "NOT_FOUND", records: [] }),
  ]);

  const evidenceById = new Map((evidenceResult.records ?? []).map((record) => [record.payload.evidence_id, record.payload]));

  const groundedByStep = [];
  for (const entry of stepResults) {
    const groundedFacts = [];
    let ungroundedCount = 0;
    for (const fact of entry.facts) {
      const candidateEvidence = (fact.evidence_ids ?? []).map((id) => evidenceById.get(id)).filter(Boolean);
      const validatedQuotes = [];
      const validatedEvidenceIds = [];
      for (const evidence of candidateEvidence) {
        if (typeof evidence.quoted_text !== "string" || typeof evidence.quote_sha256 !== "string") continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await services.validator.validateEvidence({
            evidence_id: evidence.evidence_id, document_id: evidence.document_id, file_id: evidence.file_id,
            source_locator: evidence.source_locator, quoted_text: evidence.quoted_text, quote_sha256: evidence.quote_sha256,
            fact_ids: [fact.fact_id], scope: fact.scope, period: fact.period_type, value_status: fact.value_status,
            known_at: fact.known_at, valid_from: fact.valid_from, valid_to: fact.valid_to,
          });
          validatedQuotes.push(evidence.quoted_text);
          validatedEvidenceIds.push(evidence.evidence_id);
        } catch {
          // Unvalidated evidence is simply not used -- never surfaced as if confirmed.
        }
      }
      if (validatedQuotes.length > 0) groundedFacts.push({ fact, quotes: validatedQuotes, evidenceIds: validatedEvidenceIds });
      else ungroundedCount += 1;
    }
    groundedByStep.push({ step: entry.step, status: entry.status, error_code: entry.error_code ?? null, groundedFacts, ungroundedCount });
  }

  return { groundedByStep, eventResult, relationResult };
}

// --- step 7: ModelAdapter prompt (facts grouped by the step that grounded them)

function factLine(entry) {
  const fact = entry.fact;
  return [
    `fact_id=${fact.fact_id}`, `metric=${fact.metric_code}`, `corp_code=${fact.corp_code}`, `scope=${fact.scope}`,
    `period=${fact.period_type}${fact.period_start ? ` ${fact.period_start}~${fact.period_end ?? ""}` : ""}`,
    `value_status=${fact.value_status}`, `value=${JSON.stringify(fact.normalized_value)}${fact.unit ? ` ${fact.unit}` : ""}`,
    `evidence_ids=${JSON.stringify(entry.evidenceIds)}`, `evidence_quote=${JSON.stringify(entry.quotes)}`,
  ].join(", ");
}

function missingTargetReason(entry) {
  if (entry.status === "NOT_FOUND") return "NOT_FOUND";
  if (entry.status === "ERROR") return "QUERY_FAILED";
  return "NO_GROUNDED_EVIDENCE";
}

function computeMissingTargets(groundedByStep) {
  return groundedByStep
    .filter((entry) => entry.groundedFacts.length === 0)
    .map((entry) => ({ target: stepLabel(entry.step), reason: missingTargetReason(entry) }));
}

function buildAnswerPrompt(question, groundedByStep, missingTargets) {
  const sections = groundedByStep
    .filter((entry) => entry.groundedFacts.length > 0)
    .map((entry) => [`[요구사항: ${stepLabel(entry.step)}]`, ...entry.groundedFacts.map((e) => `- ${factLine(e)}`)].join("\n"));
  const limitNote = missingTargets.length > 0
    ? `\n참고: 다음 요구사항은 검증된 근거를 확보하지 못해 제외했습니다: ${missingTargets.map((m) => `${m.target}(${m.reason})`).join(", ")}`
    : "";
  return [PLANNER_PROMPT_TEMPLATE, "", `질문: ${question}`, "", "검증된 Fact 목록 (요구사항별):", ...sections, limitNote].join("\n");
}

function renderFallbackAnswer(groundedByStep, missingTargets) {
  const sections = groundedByStep
    .filter((entry) => entry.groundedFacts.length > 0)
    .map((entry) => {
      const lines = entry.groundedFacts.map((e) => {
        const fact = e.fact;
        const value = fact.unit ? `${fact.normalized_value} ${fact.unit}` : String(fact.normalized_value);
        return `- ${fact.metric_code} (${fact.corp_code}, ${fact.period_type}): ${value} [${fact.value_status}]`;
      });
      return [`[${stepLabel(entry.step)}]`, ...lines].join("\n");
    });
  const limitNote = missingTargets.length > 0
    ? `\n${missingTargets.map((m) => `${m.target}: 근거를 검증하지 못해 제외했습니다 (${m.reason}).`).join("\n")}`
    : "";
  return [...sections, limitNote].join("\n").trim();
}

// --- optional CALCULATION (hint-driven only) --------------------------------

function calculationInputFromFact(fact) {
  return {
    fact_id: fact.fact_id, value: fact.normalized_value, unit: fact.unit, scope: fact.scope, value_status: fact.value_status,
    known_at: fact.known_at, valid_from: fact.valid_from, valid_to: fact.valid_to,
  };
}

async function attemptCalculation(calculationHint, groundedByStep, services, operations) {
  if (!calculationHint || typeof calculationHint !== "object") return null;
  const { formula, metric_codes: metricCodes } = calculationHint;
  if (typeof formula !== "string" || !Array.isArray(metricCodes) || metricCodes.length !== 2) {
    operations.push({ step: "CALCULATION_REJECTED", formula: formula ?? null, reason: "INVALID_CALCULATION_HINT" });
    return null;
  }
  const singleGroundedFactFor = (metricCode) => {
    const entry = groundedByStep.find((e) => e.step.kind === "METRIC" && e.step.metric_code === metricCode);
    return entry && entry.groundedFacts.length === 1 ? entry.groundedFacts[0].fact : null;
  };
  const [factA, factB] = metricCodes.map(singleGroundedFactFor);
  if (!factA || !factB) {
    operations.push({ step: "CALCULATION_REJECTED", formula, reason: "CALCULATION_INPUT_NOT_GROUNDED" });
    return null;
  }
  const inputs = [calculationInputFromFact(factA), calculationInputFromFact(factB)];
  try {
    const validation = await services.validator.validateFacts(inputs);
    const result = services.calculator.calculate({ formula, inputs, validation });
    operations.push({ step: "CALCULATION", formula, input_fact_ids: [factA.fact_id, factB.fact_id], result: result.result });
    return { formula, result: result.result, unit: result.unit_normalization?.unit ?? null, input_fact_ids: [factA.fact_id, factB.fact_id] };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "CALCULATION_FAILED";
    operations.push({ step: "CALCULATION_REJECTED", formula, reason: code });
    return null;
  }
}

function renderCalculationLine(calc) {
  const value = calc.unit ? `${calc.result} ${calc.unit}` : String(calc.result);
  return `계산 결과 (파생값, ${calc.formula}): ${value}`;
}

// --- information limit outcome (no plan could be executed at all) ---------

function informationLimitOutcome(question, reason, operations, extraValidation = {}) {
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
          plan_step_count: 0,
          ...extraValidation,
        },
      },
      answer: INFORMATION_LIMIT_MESSAGES[reason] ?? INFORMATION_LIMIT_MESSAGES.QUERY_FAILED,
    },
  };
}

export function createPlannerFlow(modelAdapter, options = {}) {
  if (!modelAdapter || typeof modelAdapter.generate !== "function") {
    throw new TypeError("createPlannerFlow requires a ModelAdapter with a generate(request) method");
  }
  const maxPlanSteps = Number.isInteger(options.maxPlanSteps) && options.maxPlanSteps > 0
    ? options.maxPlanSteps
    : DEFAULT_MAX_PLAN_STEPS;
  const ontology = options.ontology ?? loadMetricOntology();
  const ontologyMetricCodes = new Set(ontology.map((metric) => metric.metric_code));

  return Object.freeze({
    id: "PLANNER",
    async run(input, context, services) {
      const question = typeof input?.question === "string" ? input.question : "";
      const as_of_date = input?.as_of_date ?? context?.as_of_date ?? todayIso();
      const queryIdSuffix = sanitizeQueryIdFragment(input?.question_id);
      const operations = [];

      // --- steps 1-2: analyze + plan targets ---------------------------
      const conditions = analyzeQuestion(input, { ontology });
      operations.push({ step: "ANALYZE_QUESTION", corp_codes: conditions.corp_codes, metric_codes: conditions.metric_codes, document_ids: conditions.document_ids });

      const { knownMetricCodes, unknownMetricCodes, documentIds } = buildPlanTargets(conditions, ontologyMetricCodes);
      const rejectedTargets = unknownMetricCodes.map((code) => ({ target: `metric=${code}`, reason: "UNKNOWN_METRIC" }));
      if (rejectedTargets.length > 0) {
        // NOTE: only the (fresh, primitive-string) target labels are logged
        // here, never the `rejectedTargets` array/object references
        // themselves -- agent-runtime.mjs's Serializer.toJsonSafe uses a
        // single WeakSet across the WHOLE final_response tree to detect
        // cycles, so the SAME object instance appearing twice (once here,
        // once in `validation.rejected_targets` below) would be flagged as
        // "[Circular]" even though it is really just a shared reference,
        // not an actual cycle.
        operations.push({ step: "REJECT_UNKNOWN_TARGETS", rejected_targets: rejectedTargets.map((entry) => entry.target) });
      }

      const totalValidTargets = knownMetricCodes.length + documentIds.length;
      if (totalValidTargets === 0) {
        const reason = unknownMetricCodes.length > 0 ? "UNKNOWN_METRIC_ONLY" : "NO_CONDITIONS";
        return informationLimitOutcome(question, reason, operations, { rejected_targets: rejectedTargets });
      }

      // --- step 3: bounded, deterministic, deduplicated plan -----------
      if (totalValidTargets > maxPlanSteps) {
        operations.push({ step: "PLAN_STEP_LIMIT_EXCEEDED", requested: totalValidTargets, max_plan_steps: maxPlanSteps });
        return informationLimitOutcome(question, "PLAN_STEP_LIMIT_EXCEEDED", operations, {
          plan_requested_target_count: totalValidTargets,
          max_plan_steps: maxPlanSteps,
          rejected_targets: rejectedTargets,
        });
      }
      const steps = buildPlanSteps(knownMetricCodes, documentIds);
      operations.push({ step: "PLAN", plan_step_count: steps.length, targets: steps.map(stepLabel) });

      // --- step 4: execute every step's StructuredStore query in parallel;
      //     composition below always iterates `steps` (fixed, canonical
      //     order), never resolution order -- see PLAN DETERMINISM.
      const stepResults = await Promise.all(
        steps.map((step) => runStep(step, {
          services, corp_codes: conditions.corp_codes, period_filter: conditions.period_filter,
          scope_filter: conditions.scope_filter, context, as_of_date, queryIdSuffix,
        })),
      );
      for (const entry of stepResults) {
        operations.push({ step: "QUERY_STEP", step_id: entry.step.step_id, target: stepLabel(entry.step), status: entry.status, record_count: entry.facts.length });
      }

      // Optional, opt-in retriever fallback for a DOCUMENT step that
      // StructuredStore could not satisfy -- see RETRIEVER USE. Never
      // affects grounding; recorded purely as informational context.
      const enableRetrievalFallback = input?.hints?.enable_retrieval_fallback === true;
      const retrievalNotes = [];
      for (const entry of stepResults) {
        if (entry.status === "OK" || entry.step.kind !== "DOCUMENT") continue;
        // eslint-disable-next-line no-await-in-loop
        const retrieval = await attemptRetrievalFallback({
          step: entry.step, services, context, question, corp_codes: conditions.corp_codes, queryIdSuffix, enabled: enableRetrievalFallback,
        });
        if (retrieval) {
          operations.push({ step: "RETRIEVE_STEP", step_id: entry.step.step_id, target: stepLabel(entry.step), ...retrieval });
          retrievalNotes.push({ step_id: entry.step.step_id, target: stepLabel(entry.step), ...retrieval });
        }
      }

      // --- steps 5-6: evidence-validate every step's Facts --------------
      const { groundedByStep, eventResult, relationResult } = await groundStepFacts(stepResults, { services, queryIdSuffix, context, as_of_date });
      operations.push({ step: "QUERY_EVENTS", status: eventResult.status, record_count: eventResult.records?.length ?? 0 });
      operations.push({ step: "QUERY_RELATIONS", status: relationResult.status, record_count: relationResult.records?.length ?? 0 });

      const missingTargets = computeMissingTargets(groundedByStep);
      const groundedFactsFlat = groundedByStep.flatMap((entry) => entry.groundedFacts);

      if (groundedFactsFlat.length === 0) {
        const anyOk = groundedByStep.some((entry) => entry.status === "OK");
        const anyError = groundedByStep.some((entry) => entry.status === "ERROR");
        const reason = anyOk ? "NO_GROUNDED_EVIDENCE" : anyError ? "QUERY_FAILED" : "NOT_FOUND";
        return informationLimitOutcome(question, reason, operations, {
          plan_step_count: steps.length, missing_targets: missingTargets, rejected_targets: rejectedTargets,
        });
      }

      // --- optional calculation (hint-driven, executed BEFORE the model
      //     call -- the model has no say in whether/how it runs) ---------
      const calculation = await attemptCalculation(input?.hints?.calculation, groundedByStep, services, operations);

      const authorizedFactIds = new Set(groundedFactsFlat.map((entry) => entry.fact.fact_id));
      const validatedEvidenceIds = new Set(groundedFactsFlat.flatMap((entry) => entry.evidenceIds));

      // --- step 7: model call + step 9's post-generation grounding ------
      let answer;
      let citationBindingStatus;
      let unsupportedClaimCount = 0;
      let modelFallbackUsed;
      let selectedEvidenceIds = groundedFactsFlat.flatMap((entry) => entry.evidenceIds);

      try {
        const generated = await modelAdapter.generate({ prompt: buildAnswerPrompt(question, groundedByStep, missingTargets) });
        operations.push({ step: "MODEL_CALL", ok: true });
        const binding = verifyCitationBinding({
          usedFactIds: generated.used_fact_ids ?? [], usedEvidenceIds: generated.used_evidence_ids ?? [],
          authorizedFactIds, validatedEvidenceIds,
        });
        const claims = binding.ok ? verifyHardClaims(generated.text, groundedFactsFlat) : { ok: false, unsupportedClaims: [] };
        const verdictStatus = binding.ok && claims.ok ? "PASS" : "FAIL";
        operations.push({ step: "VERIFY_GENERATED_ANSWER", status: verdictStatus, unsupported_claim_count: claims.unsupportedClaims.length });
        if (verdictStatus === "PASS") {
          answer = generated.text;
          citationBindingStatus = "PASS";
          modelFallbackUsed = false;
          if (Array.isArray(generated.used_evidence_ids) && generated.used_evidence_ids.length > 0) {
            selectedEvidenceIds = generated.used_evidence_ids;
          }
        } else {
          answer = renderFallbackAnswer(groundedByStep, missingTargets);
          citationBindingStatus = "FAIL";
          unsupportedClaimCount = claims.unsupportedClaims.length;
          modelFallbackUsed = true;
        }
      } catch (error) {
        const modelFailureCode = typeof error?.code === "string" ? error.code : "MODEL_CALL_UNKNOWN_ERROR";
        operations.push({ step: "MODEL_CALL", ok: false, error_code: modelFailureCode });
        answer = renderFallbackAnswer(groundedByStep, missingTargets);
        citationBindingStatus = "NOT_CHECKED";
        modelFallbackUsed = true;
      }

      // The calculated value is appended deterministically by this Flow's
      // own code AFTER grounding is decided -- it is never part of the
      // model's own generated text, so it can never be rejected/accepted
      // by post-generation grounding, and it is never a value the model
      // could have invented itself (see CALCULATION header comment).
      if (calculation) answer = [answer, renderCalculationLine(calculation)].filter((part) => part !== "").join("\n\n");

      const relationContext = (relationResult.records ?? []).map((record) => ({ relation_id: record.record_id, relation_type: record.payload?.relation_type ?? null }));
      const eventContext = (eventResult.records ?? []).map((record) => ({ event_id: record.record_id, event_type: record.payload?.event_type ?? null }));

      return {
        final_response: {
          question,
          retrieved_context: [
            ...groundedFactsFlat.map((entry) => ({ fact_id: entry.fact.fact_id, quotes: entry.quotes })),
            ...eventContext,
            ...relationContext,
            ...retrievalNotes,
          ],
          think_trace: {
            execution_mode: retrievalNotes.some((note) => note.ok) ? "BOTH" : "STRUCTURED",
            operations,
            calculation: calculation ?? {},
            validation: {
              answerability: "SUPPORTED",
              grounded_fact_count: groundedFactsFlat.length,
              plan_step_count: steps.length,
              missing_targets: missingTargets,
              rejected_targets: rejectedTargets,
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
