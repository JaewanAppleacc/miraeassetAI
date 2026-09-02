// Turn P11-E: the official HCX_NATIVE_V3_FUNCTION_CALLING ModelAdapter.
// This is the GREEN candidate P11-D's bounded real-API comparison already
// selected (NATIVE_V3_FUNCTION_CALLING, 15/15, zero violations -- see
// domain/agent-comparison/hcx-structured-protocol/reports/
// hcx-structured-protocol-comparison-report.v0.1.json) promoted to a real,
// registered adapter kind alongside FAKE_DETERMINISTIC/
// HTTP_CHAT_COMPLETIONS/HCX_CHAT_COMPLETIONS (model-adapter.mjs).
//
// SINGLE SOURCE OF TRUTH (CLAUDE.md Turn P11-E section B.1/B.2): the
// request builder and BOTH structural classifiers below are imported
// UNCHANGED from hcx-structured-protocol/envelope-native-v3.mjs -- the
// exact module P11-D's own real run exercised. This file adds no second
// parser; it only adds the ModelAdapter-shaped construction/generate()
// wrapper, config validation, and a bounded retry loop around that same
// parsing logic. Likewise `validateCommonStructuredAnswer` (section B.3/
// B.4: "기존 structured-answer validator를 그대로 사용... 새로운 임의 답변
// schema를 만들지 않는다") is COMMON_STRUCTURED_ANSWER_SCHEMA verbatim --
// itself, per its own header, exactly structured-answer-parsing.mjs's
// already-frozen {answer, used_fact_ids, used_evidence_ids} RESPONSE
// CONTRACT restated as JSON Schema, not a new contract.
//
// EVIDENCE-ID AUTHORIZATION (deliberately NOT re-implemented here): the
// established mechanism is flows/hard-claim-grounding.mjs's own
// verifyCitationBinding, called by each AgentFlow AFTER generate() returns,
// against that Flow's own authorizedFactIds/validatedEvidenceIds context
// (model-adapter.mjs's own header: "a Flow must still verify that claim
// against the ids it actually authorized/validated this request"). This
// adapter returns used_fact_ids/used_evidence_ids in the exact same shape
// every other adapter kind already does specifically so verifyCitationBinding
// keeps working unchanged -- adding a second, adapter-internal id-allowlist
// check here would duplicate that Flow-level check with a DIFFERENT id
// universe (this Turn does no real Fact/Evidence store access) and risks
// the two disagreeing. See tests/agent-comparison-hcx-native-function-
// calling-adapter.test.mjs's own citation-binding regression test.
//
// SECURITY (CLAUDE.md Turn P11-E section C): endpoint_url must be
// https://clovastudio.stream.ntruss.com/... with config.model as the exact
// last path segment (Native v3's own /v3/chat-completions/{modelName}
// shape) -- no other hostname is ever accepted, with NO loopback-mock
// exception (stricter than HCX_CHAT_COMPLETIONS's own
// allowLoopbackMockCalls option; every test in this Turn instead injects
// fetchImpl against the real hostname, exactly like P11-D's own tests did).
// actual_external_call_authorized must be true and the API key env var
// must be set, both checked at CONSTRUCTION time -- a config that fails any
// of these checks makes ZERO fetch calls, ever, because construction itself
// throws before generate() exists to call.
import { ModelAdapterUnavailableError } from "./model-adapter-unavailable-error.mjs";
import { ModelCallError } from "./model-call-error.mjs";
import {
  FUNCTION_CALLING_TOOL_NAME,
  buildFunctionCallingRequestBody,
  classifyNativeV3Envelope,
  classifyNativeV3ToolCallShape,
  toolParametersSchema,
} from "./hcx-structured-protocol/envelope-native-v3.mjs";
import { validateCommonStructuredAnswer, COMMON_STRUCTURED_ANSWER_SCHEMA } from "./hcx-structured-protocol/common-schema.mjs";

export const HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME = "clovastudio.stream.ntruss.com";

// Fixed, non-configurable retry ceiling (CLAUDE.md Turn P11-E section C:
// "retry policy" is validated as a property of THIS adapter's own code, not
// a caller-adjustable ModelConfig field -- same "single source of truth,
// code-enforced ceiling" discipline as hcx-structured-protocol/hard-limits.mjs).
// 1 initial attempt + 1 retry, 429/5xx only; a 4xx or any structural
// (schema/tool/envelope) failure is NEVER retried.
export const RETRY_MAX_ATTEMPTS = 2;

function isRetryableHttpStatus(httpStatus) {
  return httpStatus === 429 || (Number.isFinite(httpStatus) && httpStatus >= 500 && httpStatus < 600);
}

function extractContentTypeMime(response) {
  try {
    const raw = typeof response?.headers?.get === "function" ? response.headers.get("content-type") : null;
    return typeof raw === "string" && raw !== "" ? raw.split(";")[0].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function costFor(tokens, costPer1k) {
  if (typeof costPer1k !== "number" || !Number.isFinite(costPer1k)) return 0;
  return (tokens / 1000) * costPer1k;
}

// Construction-time only (never re-run per generate() call, matching every
// other adapter kind's own construction-time-only checks). Never includes
// the endpoint_url itself, an API key, or an Authorization header value in
// a thrown message -- see this file's header, security rules 1-3.
function assertEndpointAndAuthorization(config) {
  let parsed;
  try {
    parsed = new URL(config.endpoint_url);
  } catch {
    throw new ModelAdapterUnavailableError("endpoint_url is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ModelAdapterUnavailableError("endpoint_url must use https");
  }
  if (parsed.hostname !== HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME) {
    throw new ModelAdapterUnavailableError(`endpoint_url hostname must be ${HCX_NATIVE_FUNCTION_CALLING_ALLOWED_HOSTNAME}`);
  }
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const lastSegment = pathSegments[pathSegments.length - 1];
  if (lastSegment !== config.model) {
    throw new ModelAdapterUnavailableError("endpoint_url path model identifier does not match config.model");
  }
  if (config.actual_external_call_authorized !== true) {
    throw new ModelAdapterUnavailableError(
      "actual_external_call_authorized is not true; refusing to construct an adapter that could ever call a real HCX endpoint",
    );
  }
  const apiKey = process.env[config.api_key_env_var];
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new ModelAdapterUnavailableError(
      `environment variable ${config.api_key_env_var} is not set; refusing to call ${config.provider}/${config.model} without an API key`,
    );
  }
  return { hostname: parsed.hostname, apiKey };
}

const parametersSchema = toolParametersSchema(COMMON_STRUCTURED_ANSWER_SCHEMA);

// One HTTP attempt: request -> outer-envelope classification -> tool-call
// shape classification -> structured-answer schema validation. Every
// rejection throws ModelCallError with non-sensitive `diagnostics` only
// (http_status, content_type_mime, envelope_class, tool_call_shape_class,
// finish_reason) -- never the raw response body, assistant content, or
// tool-call arguments (security rule 4).
async function performOneAttempt({ request, config, apiKey, fetchImpl, timeoutMs }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(config.endpoint_url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildFunctionCallingRequestBody({
          prompt: request.prompt,
          system: request.system,
          maxOutputTokens: request.max_output_tokens ?? config.max_output_tokens,
          parametersSchema,
          topP: config.top_p,
          temperature: request.temperature ?? config.temperature,
        })),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ModelCallError("MODEL_CALL_TIMEOUT", "model call timed out or was aborted", { cause: error });
      }
      throw new ModelCallError("MODEL_CALL_UNKNOWN_ERROR", "model call failed before a response was received", { cause: error });
    }

    const httpStatus = Number.isFinite(response.status) ? response.status : null;
    const contentTypeMime = extractContentTypeMime(response);
    if (!response.ok) {
      throw new ModelCallError("MODEL_CALL_HTTP_ERROR", `model endpoint returned a non-OK HTTP status (${response.status})`, {
        diagnostics: { http_status: httpStatus, content_type_mime: contentTypeMime, envelope_class: null, tool_call_shape_class: null, finish_reason: null },
      });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response body was not valid JSON", {
        cause: error,
        diagnostics: { http_status: httpStatus, content_type_mime: contentTypeMime, envelope_class: "NOT_JSON", tool_call_shape_class: null, finish_reason: null },
      });
    }

    const envelopeClass = classifyNativeV3Envelope(body);
    const finishReason = typeof body?.result?.finishReason === "string" ? body.result.finishReason : null;
    if (envelopeClass !== "VALID") {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response did not have a valid Native v3 envelope", {
        diagnostics: { http_status: httpStatus, content_type_mime: contentTypeMime, envelope_class: envelopeClass, tool_call_shape_class: null, finish_reason: finishReason },
      });
    }

    const { shape_class: toolCallShapeClass, toolCallArguments } = classifyNativeV3ToolCallShape(body.result.message);
    const diagnostics = { http_status: httpStatus, content_type_mime: contentTypeMime, envelope_class: envelopeClass, tool_call_shape_class: toolCallShapeClass, finish_reason: finishReason };
    if (toolCallShapeClass !== "EXACTLY_ONE_MATCHING_TOOL_CALL") {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", `model response tool call shape was ${toolCallShapeClass}, expected exactly one ${FUNCTION_CALLING_TOOL_NAME} call`, { diagnostics });
    }

    const validated = validateCommonStructuredAnswer(toolCallArguments);
    if (!validated.ok) {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model tool-call arguments did not pass the structured-answer schema", { diagnostics });
    }
    if (validated.value.answer.trim() === "") {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response answer was empty", { diagnostics });
    }
    for (const [label, ids] of [["used_fact_ids", validated.value.used_fact_ids], ["used_evidence_ids", validated.value.used_evidence_ids]]) {
      if (new Set(ids).size !== ids.length) {
        throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", `model response ${label} contained a duplicate id`, { diagnostics });
      }
    }

    const usage = body.result.usage ?? null;
    const inputTokens = Number.isFinite(usage?.promptTokens) ? usage.promptTokens : 0;
    const outputTokens = Number.isFinite(usage?.completionTokens) ? usage.completionTokens : 0;
    return {
      text: validated.value.answer,
      used_fact_ids: validated.value.used_fact_ids,
      used_evidence_ids: validated.value.used_evidence_ids,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost: costFor(inputTokens, config.input_cost_per_1k_tokens) + costFor(outputTokens, config.output_cost_per_1k_tokens),
      finish_reason: finishReason,
      latency_ms: Date.now() - startedAt,
      diagnostics,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createHcxNativeFunctionCallingModelAdapter(config, { fetchImpl = fetch } = {}) {
  const { apiKey } = assertEndpointAndAuthorization(config);

  return Object.freeze({
    modelConfigId: config.model_config_id,
    provider: config.provider,
    model: config.model,
    async generate(request) {
      if (!request || typeof request.prompt !== "string" || request.prompt === "") {
        throw new TypeError("ModelAdapter.generate requires request.prompt (non-empty string)");
      }
      const timeoutMs = config.timeout_ms ?? 30000;
      let lastError;
      for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          return await performOneAttempt({ request, config, apiKey, fetchImpl, timeoutMs });
        } catch (error) {
          lastError = error;
          const httpStatus = error?.diagnostics?.http_status ?? null;
          const retryable = error?.code === "MODEL_CALL_HTTP_ERROR" && isRetryableHttpStatus(httpStatus);
          if (!retryable || attempt >= RETRY_MAX_ATTEMPTS) throw error;
        }
      }
      // Unreachable (the loop always either returns or throws), kept only
      // so this function has an explicit exhaustive control-flow ending.
      throw lastError;
    },
  });
}
